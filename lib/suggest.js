"use strict";

// `suggest`: read a repository and propose an overlay for what only that repository knows.
//   size     a threshold from the repo's own merged-PR sizes, for a chosen review budget
//   layout   policy and middleware directories the default globs don't reach
//   scopes   global scopes (often tenant isolation): the scope classes, and bypassing them
//   money    payment and billing areas, by directory name
// Everything it proposes is a suggestion for a human to read and commit. The overlay is
// trust root: the PR that adds it is reviewed like any other change to the rules.

const { git, numstat } = require("./git");
const { mergedPRs } = require("./history");
const { compile } = require("./risk");

const TENANCY = /(tenant|team|organi[sz]ation|account|company|firm|workspace|school|clinic|store|merchant)/i;
const MONEY = /^(payments?|billing|invoices?|invoicing|subscriptions?|checkout|wallets?|payouts?|ledgers?|transactions?|finance|accounting)$/i;

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

// Round up to two significant figures: 1,317 → 1,400.
function nice(n) {
  if (n < 100) return Math.max(10, Math.ceil(n / 10) * 10);
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.ceil(n / p) * p;
}

function files(cwd, ref) {
  return git(cwd, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean);
}

// budgetGiven: the caller chose --budget. Without it, a threshold is only loosened when the
// default flags more PRs than the budget; tightening (more reviews) has to be asked for.
function suggest(cwd, policyIn, { ref = "HEAD", budget = 0.2, budgetGiven = false, sample = 300 } = {}) {
  const policy = compile(policyIn);
  const notes = [];
  const overlay = { name: "repo", path_rules: [], pattern_rules: [] };

  // --- size -------------------------------------------------------------------------
  const prs = mergedPRs(cwd, { ref, limit: sample });
  let size = null;
  if (prs.length < 20) {
    notes.push(`size: only ${prs.length} merged PRs found in history; keeping the default thresholds (${policy.size.max_changed_lines} lines / ${policy.size.max_files} files).`);
  } else {
    const lines = [];
    const counts = [];
    for (const p of prs) {
      const s = numstat(cwd, p.base, p.sha);
      lines.push(s.added + s.removed);
      counts.push(git(cwd, ["diff", "--name-only", p.base, p.sha]).split("\n").filter(Boolean).length);
    }
    lines.sort((a, b) => a - b);
    counts.sort((a, b) => a - b);
    const maxLines = nice(quantile(lines, 1 - budget));
    const maxFiles = nice(quantile(counts, 1 - budget));
    const flaggedNow = lines.filter((l) => l > policy.size.max_changed_lines).length / lines.length;
    size = { prs: prs.length, median_lines: quantile(lines, 0.5), p75_lines: quantile(lines, 0.75), p90_lines: quantile(lines, 0.9), flagged_by_default: flaggedNow, max_changed_lines: maxLines, max_files: maxFiles };
    const close = Math.abs(maxLines - policy.size.max_changed_lines) / policy.size.max_changed_lines < 0.25;
    const tighter = maxLines < policy.size.max_changed_lines;
    if (close) {
      notes.push(`size: the default (${policy.size.max_changed_lines} lines) already flags about ${Math.round(100 * flaggedNow)}% of your last ${prs.length} PRs by size; no change suggested.`);
    } else if (tighter && !budgetGiven) {
      notes.push(`size: the default (${policy.size.max_changed_lines} lines) flags ${Math.round(100 * flaggedNow)}% of your last ${prs.length} PRs by size, within a ${Math.round(100 * budget)}% budget; no change suggested. Pass --budget to tighten it (about ${maxLines} lines for ${Math.round(100 * budget)}%).`);
    } else {
      overlay.size = { max_changed_lines: maxLines, max_files: maxFiles, level: policy.size.level };
      notes.push(`size: median PR is ${size.median_lines} changed lines; the default of ${policy.size.max_changed_lines} would flag ${Math.round(100 * flaggedNow)}% of your last ${prs.length} PRs by size alone. ${maxLines} lines / ${maxFiles} files flags about ${Math.round(100 * budget)}% (--budget).`);
    }
  }

  // --- layout -------------------------------------------------------------------------
  const all = files(cwd, ref);
  const dirsOf = (name) => [...new Set(all.filter((f) => new RegExp(`(^|/)${name}/[^/]+\\.php$`).test(f) && /^(app|Modules|src)\//.test(f)).map((f) => f.slice(0, f.lastIndexOf("/"))))].sort();
  const covered = (ruleId, dir) => {
    const r = policy.path_rules.find((x) => x.id === ruleId);
    return !!r && r.re.some((re) => re.test(`${dir}/X.php`));
  };
  const layout = {};
  for (const [name, ruleId] of [["Policies", "policies"], ["Middleware", "middleware"]]) {
    const dirs = dirsOf(name);
    const missing = dirs.filter((d) => !covered(ruleId, d));
    layout[ruleId] = { dirs, missing };
    if (missing.length) {
      const base = policy.path_rules.find((x) => x.id === ruleId);
      overlay.path_rules.push({ id: ruleId, dimension: base.dimension, level: base.level, paths: [...base.paths, ...missing.map((d) => `${d}/**`)] });
      notes.push(`${ruleId}: ${missing.length} director${missing.length === 1 ? "y isn't" : "ies aren't"} covered by the defaults: ${missing.join(", ")}.`);
    } else if (dirs.length) notes.push(`${ruleId}: all ${dirs.length} director${dirs.length === 1 ? "y is" : "ies are"} covered by the defaults.`);
  }

  // --- global scopes ------------------------------------------------------------------
  // git grep narrows to candidate files with fixed strings; the real match runs in JS,
  // because git's -E regex dialect differs by platform (macOS has no \b).
  const candidates = (git(cwd, ["grep", "-l", "-F", "-e", "Scope", ref, "--", "app", "Modules", "src"], { allowFail: true }) || "").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf(":") + 1));
  const scopeClasses = [];
  const registrars = [];
  for (const f of candidates) {
    const src = git(cwd, ["show", `${ref}:${f}`], { allowFail: true }) || "";
    if (/implements\s+(?:[A-Za-z\\]*\\)?Scope\b/.test(src)) scopeClasses.push(f);
    if (/addGlobalScope\s*\(|#\[ScopedBy/.test(src)) registrars.push(f);
  }
  const scopeFiles = [...new Set([...scopeClasses, ...registrars])].sort();
  const tenancy = scopeFiles.filter((f) => TENANCY.test(f));
  if (scopeFiles.length) {
    overlay.path_rules.push({ id: "global-scopes", dimension: "security", level: tenancy.length ? "high" : "medium", paths: scopeFiles });
    notes.push(`scopes: ${scopeFiles.length} file${scopeFiles.length === 1 ? "" : "s"} define or register a global scope (${scopeFiles.join(", ")}); changing them is ${tenancy.length ? "high" : "medium"}.`);
    if (tenancy.length) {
      const base = policy.pattern_rules.find((r) => r.id === "without-global-scope");
      overlay.pattern_rules.push({ ...(base ? { id: base.id, dimension: base.dimension, paths: base.paths, added: base.added } : { id: "without-global-scope", dimension: "security", paths: ["app/**"], added: "withoutGlobalScopes?\\s*\\(" }), level: "high" });
      notes.push(`scopes: ${tenancy.map((f) => f.split("/").pop()).join(", ")} look like tenant isolation, so bypassing a global scope (withoutGlobalScope) is raised to high.`);
    }
  }

  // --- money --------------------------------------------------------------------------
  const moneyDirs = [...new Set(all.map((f) => f.split("/")).flatMap((parts) => parts.slice(0, -1).map((p, i) => (MONEY.test(p) && /^(app|Modules|src)$/.test(parts[0]) ? parts.slice(0, i + 1).join("/") : null))).filter(Boolean))].sort();
  const topMoney = moneyDirs.filter((d) => !moneyDirs.some((o) => o !== d && d.startsWith(`${o}/`)));
  if (topMoney.length) {
    overlay.path_rules.push({ id: "money", dimension: "data", level: "medium", paths: topMoney.map((d) => `${d}/**`) });
    notes.push(`money: ${topMoney.join(", ")} look like payment or billing code; changes there are medium. Remove this rule if the name misleads.`);
  }

  if (!overlay.path_rules.length) delete overlay.path_rules;
  if (!overlay.pattern_rules.length) delete overlay.pattern_rules;
  const empty = Object.keys(overlay).length === 1;
  return { overlay: empty ? null : overlay, notes, size, layout, scopes: scopeFiles, money: topMoney };
}

module.exports = { suggest, nice, quantile };
