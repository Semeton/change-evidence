"use strict";

// `suggest`: read a repository and propose an overlay for what only that repository knows.
//   size     a threshold from the repo's own merged-PR sizes, for a chosen review budget
//   layout   policy and middleware directories the default globs don't reach
//   scopes   global scopes (often tenant isolation): the scope classes, and bypassing them
//   money    payment and billing areas, by directory name
// Everything it proposes is a suggestion for a human to read and commit. The overlay is
// trust root: the PR that adds it is reviewed like any other change to the rules.

const { git, numstatByFile } = require("./git");
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
    // Measure what the size rule measures: reviewable lines and files, generated and
    // vendored ones excluded.
    const isGenerated = require("./generated").classifier(cwd, ref, policy);
    const lines = [];
    const counts = [];
    for (const p of prs) {
      const per = numstatByFile(cwd, p.base, p.sha);
      let l = 0;
      let c = 0;
      for (const [f, n] of per) {
        if (isGenerated(f)) continue;
        l += n.added + n.removed;
        c++;
      }
      lines.push(l);
      counts.push(c);
    }
    lines.sort((a, b) => a - b);
    counts.sort((a, b) => a - b);
    // Each threshold is decided on its own. Loosening one that flags more than the budget
    // is suggested; tightening one (more reviews) only when --budget was given.
    const decide = (label, current, values, unit) => {
      const proposed = nice(quantile(values, 1 - budget));
      const flagged = values.filter((v) => v > current).length / values.length;
      const close = Math.abs(proposed - current) / current < 0.25;
      const tighter = proposed < current;
      const pctNow = Math.round(100 * flagged);
      if (close) return { change: false, note: `${label}: the current threshold (${current} ${unit}) flags about ${pctNow}% of your last ${values.length} PRs; no change suggested.` };
      if (tighter && !budgetGiven) return { change: false, note: `${label}: the current threshold (${current} ${unit}) flags ${pctNow}% of your last ${values.length} PRs, within a ${Math.round(100 * budget)}% budget; no change suggested. Pass --budget to tighten it (about ${proposed} ${unit} for ${Math.round(100 * budget)}%).` };
      return { change: true, value: proposed, note: `${label}: the current threshold of ${current} ${unit} flags ${pctNow}% of your last ${values.length} PRs; ${proposed} ${unit} flags about ${Math.round(100 * budget)}%.` };
    };
    const l = decide("size (lines)", policy.size.max_changed_lines, lines, "changed lines");
    const f = decide("size (files)", policy.size.max_files, counts, "files");
    size = { prs: prs.length, median_lines: quantile(lines, 0.5), p75_lines: quantile(lines, 0.75), p90_lines: quantile(lines, 0.9), median_files: quantile(counts, 0.5), flagged_by_default: lines.filter((v) => v > policy.size.max_changed_lines).length / lines.length };
    notes.push(l.note, f.note);
    if (l.change || f.change) {
      overlay.size = { ...(l.change ? { max_changed_lines: l.value } : {}), ...(f.change ? { max_files: f.value } : {}), level: policy.size.level };
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

  // --- web server and deployment ----------------------------------------------------
  // Web-server config decides what is exposed and how requests are rewritten; deployment
  // config decides what runs where. Only files the defaults don't already cover.
  const coveredByAny = (f) => policy.path_rules.some((r) => r.re.some((re) => re.test(f)));
  const WEB = /(^|\/)(\.htaccess|web\.config|nginx[^/]*\.conf|Caddyfile|httpd[^/]*\.conf)$/;
  const DEPLOY = /(^|\/)(Procfile|fly\.toml|render\.yaml|railway\.json|app\.yaml|ecosystem\.config\.(js|cjs)|supervisord?[^/]*\.conf|serverless\.ya?ml|Vagrantfile|Envoy\.blade\.php|deploy[^/]*\.(sh|php|ya?ml)|[^/]+\.tf)$|^(\.do|k8s|helm|kubernetes|terraform|\.platform|\.ebextensions)\//;
  const web = all.filter((f) => WEB.test(f) && !coveredByAny(f) && !/^(vendor|node_modules)\//.test(f)).sort();
  const deploy = all.filter((f) => DEPLOY.test(f) && !coveredByAny(f) && !/^(vendor|node_modules)\//.test(f)).sort();
  if (web.length) {
    overlay.path_rules.push({ id: "web-server-config", dimension: "security", level: "medium", paths: web });
    notes.push(`web server: ${web.join(", ")} control what the server exposes and rewrites; changes there are medium.`);
  }
  if (deploy.length) {
    overlay.path_rules.push({ id: "deploy-config", dimension: "operational", level: "medium", paths: [...new Set(deploy.map((f) => (/^(\.do|k8s|helm|kubernetes|terraform|\.platform|\.ebextensions)\//.test(f) ? `${f.split("/")[0]}/**` : f)))] });
    notes.push(`deployment: ${deploy.slice(0, 6).join(", ")}${deploy.length > 6 ? ` and ${deploy.length - 6} more` : ""} aren't covered by the defaults; changes there are medium.`);
  }

  // --- authorization registered outside policy folders ------------------------------
  const gateFiles = (git(cwd, ["grep", "-l", "-F", "-e", "Gate::", ref, "--", "app", "Modules", "src"], { allowFail: true }) || "").split("\n").filter(Boolean).map((l) => l.slice(l.indexOf(":") + 1));
  const gates = gateFiles.filter((f) => /Gate::(define|policy|before|after|resource)\s*\(/.test(git(cwd, ["show", `${ref}:${f}`], { allowFail: true }) || "")).filter((f) => !covered("policies", f.slice(0, f.lastIndexOf("/"))) && !(policy.path_rules.find((r) => r.id === "policies") || { re: [] }).re.some((re) => re.test(f))).sort();
  if (gates.length) {
    const prior = overlay.path_rules.find((r) => r.id === "policies");
    const base = prior || policy.path_rules.find((r) => r.id === "policies");
    if (prior) prior.paths = [...new Set([...prior.paths, ...gates])];
    else overlay.path_rules.push({ id: "policies", dimension: base.dimension, level: base.level, paths: [...base.paths, ...gates] });
    notes.push(`authorization: ${gates.join(", ")} ${gates.length === 1 ? "registers" : "register"} gates (Gate::define/policy/before) outside the policy folders; added to the policies rule.`);
  }

  // --- custom middleware aliases (informational) --------------------------------------
  const { aliasesFor } = require("./extractors/routes");
  const aliases = aliasesFor ? aliasesFor(cwd, ref) : null;
  const custom = aliases ? [...aliases].filter(([, v]) => /^App\\|^[A-Z]\w+$/.test(String(v)) && !/^Illuminate\\/.test(String(v))) : [];
  if (custom.length) notes.push(`middleware aliases: ${custom.slice(0, 8).map(([k, v]) => `${k} → ${String(v).split("\\").pop()}`).join(", ")}${custom.length > 8 ? ` and ${custom.length - 8} more` : ""}. Remapping or removing any of them is reported as middleware_alias_changed.`);

  // --- existing tenant-scope bypasses (informational) -------------------------------
  if (tenancy.length) {
    const lines = (git(cwd, ["grep", "-h", "-E", "withoutGlobalScopes?[[:space:]]*\\(", ref, "--", "app", "Modules", "src"], { allowFail: true }) || "").split("\n").filter(Boolean);
    if (lines.length) {
      const rescoped = lines.filter((l) => /tenant_id/.test(l)).length;
      notes.push(`scopes: the codebase already bypasses global scopes on ${lines.length} lines, ${rescoped} of them re-applying tenant_id on the same line. Every new bypass will be reported at high with its line. If some bypass pattern is reviewed and expected, a rule \`unless\` can excuse it visibly; none is proposed here, because that's a judgement about your tenant boundary.`);
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
