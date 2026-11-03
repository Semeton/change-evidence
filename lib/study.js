"use strict";

// Phase 1 study: replay merged PRs, extract evidence, assess risk, then join each PR to
// what happened to it afterwards. The outcome labels are proxies, and named as such:
//   reverted      a later commit on the main line reverts it (by sha, by "#N", or by title)
//   fix_followup  a later `fix` PR within N days touches at least one of the same source files
// The question the study answers: do the tiers concentrate the changes that later needed
// undoing or fixing, and how much review load would they create?

const { git, changedFiles, numstat, diffLines } = require("./git");
const { mergedPRs, parseSubject, revertedSha } = require("./history");
const { extractRoutes } = require("./extractors/routes");
const { extractMigrations } = require("./extractors/migrations");
const { extractDependencies } = require("./extractors/dependencies");
const { extractWorkflows } = require("./extractors/workflows");
const { assess, compile, DIMENSIONS } = require("./risk");

const EXTRACTORS = [extractRoutes, extractMigrations, extractDependencies, extractWorkflows];
// Files too common to link a fix to a change.
const NOISE = /(^|\/)(composer\.(json|lock)|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG[^/]*|README[^/]*|\.version)$|\.(md|snap|svg|png|jpg|lock)$/i;

function diffScope(policy, files) {
  // Only fetch diff lines for files a pattern rule could match: keeps replay fast.
  return files.filter((f) => f.status !== "D" && policy.pattern_rules.some((r) => r.re.some((re) => re.test(f.path)))).map((f) => f.path);
}

function analyseChange(cwd, base, head, policy) {
  const files = changedFiles(cwd, base, head);
  const lines = numstat(cwd, base, head);
  const scoped = diffScope(policy, files);
  const diff = scoped.length ? diffLines(cwd, base, head, scoped.slice(0, 400)) : new Map();
  const ctx = { cwd, base, head, changed: files };
  const evidence = EXTRACTORS.map((ex) => {
    try {
      return ex(ctx);
    } catch (e) {
      return { extractor: ex.name.replace(/^extract/, "").toLowerCase(), class: "structural", producer: "trusted", state: "UNKNOWN", observed: [], unknown: [`extractor failed: ${e.message}`], coverage: { inspected: 0, skipped: 1 } };
    }
  });
  const risk = assess(policy, { files, lines, diff }, evidence);
  return { files, lines, evidence, risk };
}

// Every revert on the main line (PR or direct push) → the PR it undoes.
function findReverts(cwd, prs, ref) {
  const bySha = prs.map((p) => p.sha);
  const byNum = new Map(prs.map((p) => [p.pr, p]));
  const byTitle = new Map();
  for (const p of prs) {
    byTitle.set(p.title.trim(), p);
    byTitle.set(`${p.title.trim()} (#${p.pr})`, p);
  }
  const out = new Map(); // pr number -> { by, date, how }
  const log = git(cwd, ["log", "--first-parent", "--format=%H%x1f%aI%x1f%s%x1f%b%x1e", ref]);
  for (const rec of log.split("\x1e")) {
    const [sha, date, subject, body] = rec.replace(/^\n/, "").split("\x1f");
    if (!sha) continue;
    const info = parseSubject(subject || "");
    if (info.type !== "revert") continue;
    let target = null;
    let how = null;
    const rs = revertedSha(body);
    if (rs) {
      const full = bySha.find((s) => s.startsWith(rs) || rs.startsWith(s));
      if (full) {
        target = prs.find((p) => p.sha === full);
        how = "sha";
      }
    }
    if (!target) {
      const q = /^Revert\s+"(.+)"\s*$/.exec(info.title);
      if (q && byTitle.has(q[1].trim())) {
        target = byTitle.get(q[1].trim());
        how = "title";
      }
    }
    if (!target) {
      const nums = [...(info.title.matchAll(/#(\d+)/g))].map((m) => Number(m[1])).filter((n) => n !== info.pr && byNum.has(n));
      if (nums.length) {
        target = byNum.get(nums[0]);
        how = "pr-ref";
      }
    }
    if (target && target.sha !== sha && !out.has(target.pr)) out.set(target.pr, { by: sha.slice(0, 10), date, how });
  }
  return out;
}

// Commits that last touched the lines a fix deletes or modifies (SZZ). Test files and
// noise files are skipped: a fix that edits a test doesn't implicate the test's author.
// Pure additions implicate nothing; that's a known limit of SZZ.
function fixInducing(cwd, fix) {
  const shas = new Set();
  const files = fix.files.filter((x) => x.status === "M" && !NOISE.test(x.path) && !/^tests?\//.test(x.path)).map((x) => x.path).slice(0, 30);
  if (!files.length) return shas;
  const diff = git(cwd, ["diff", "-U0", "--no-color", fix.base, fix.sha, "--", ...files], { allowFail: true }) || "";
  const ranges = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) file = line.startsWith("--- a/") ? line.slice(6) : null;
    const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) {
        if (!ranges.has(file)) ranges.set(file, []);
        ranges.get(file).push([start, start + count - 1]);
      }
    }
  }
  for (const [path, rs] of ranges) {
    const args = ["blame", "--porcelain", "-w", ...rs.slice(0, 50).flatMap(([a, b]) => ["-L", `${a},${b}`]), fix.base, "--", path];
    const out = git(cwd, args, { allowFail: true }) || "";
    for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) shas.add(m[1]);
  }
  return shas;
}

function days(a, b) {
  return (new Date(b) - new Date(a)) / 86400000;
}

function runStudy(cwd, { ref = "HEAD", since, limit, policy: policyIn, followupDays = 14, onProgress } = {}) {
  const policy = compile(policyIn);
  const prs = mergedPRs(cwd, { ref, since, limit });
  const reverts = findReverts(cwd, mergedPRs(cwd, { ref }), ref);
  const rows = [];
  prs.forEach((p, i) => {
    const a = analyseChange(cwd, p.base, p.sha, policy);
    rows.push({ ...p, ...a });
    if (onProgress) onProgress(i + 1, prs.length, p);
  });
  // Fix follow-ups (SZZ): for each later `fix` PR, blame the lines it deletes or modifies
  // at its base; a PR that introduced any of those lines, within the window, is labelled.
  const prBySha = new Map(rows.map((r) => [r.sha, r]));
  for (const r of rows) r.fix_followups = [];
  for (const f of rows) {
    if (f.type !== "fix") continue;
    for (const sha of fixInducing(cwd, f)) {
      const origin = prBySha.get(sha);
      if (!origin || origin === f || days(origin.date, f.date) > followupDays || days(origin.date, f.date) < 0) continue;
      if (!origin.fix_followups.includes(f.pr)) origin.fix_followups.push(f.pr);
    }
  }
  for (const r of rows) r.reverted = reverts.get(r.pr) || null;
  return { rows, policy: { name: policyIn.name, version: policyIn.version }, followupDays, ref, generated: new Date().toISOString() };
}

// ---------- reporting ----------

function rowSummary(r) {
  const ev = Object.fromEntries(r.evidence.map((e) => [e.extractor, e]));
  const count = (ex, pred) => (ev[ex] ? ev[ex].observed.filter(pred).length : 0);
  return {
    pr: r.pr,
    sha: r.sha.slice(0, 10),
    date: r.date.slice(0, 10),
    type: r.type || "",
    title: r.title,
    files: r.files.length,
    lines: r.lines.added + r.lines.removed,
    tier: r.risk.tier,
    ...Object.fromEntries(DIMENSIONS.map((d) => [`dim_${d}`, r.risk.dimensions[d]])),
    rules: [...new Set(r.risk.hits.filter((h) => h.level !== "low").map((h) => h.rule))].join(" "),
    routes_added: count("routes", (o) => o.op === "route_added"),
    routes_removed: count("routes", (o) => o.op === "route_removed"),
    routes_changed: count("routes", (o) => o.op === "route_changed"),
    schema_ops: ev.migrations ? ev.migrations.observed.length : 0,
    schema_risky: count("migrations", (o) => !!o.risk),
    deps_direct: count("dependencies", (o) => /^dependency_/.test(o.op)),
    actions_changed: count("workflows", (o) => /^action_/.test(o.op)),
    workflow_only_action_bumps: ev.workflows && ev.workflows.observed.length && !ev.workflows.observed.some((o) => o.op === "workflow_changed") ? "yes" : "",
    unknown: r.evidence.filter((e) => e.state === "UNKNOWN").map((e) => e.extractor).join(" "),
    reverted: r.reverted ? r.reverted.by : "",
    fix_followups: r.fix_followups.join(" "),
  };
}

function toCsv(rows) {
  const s = rows.map(rowSummary);
  if (!s.length) return "";
  const cols = Object.keys(s[0]);
  const esc = (v) => {
    const t = String(v ?? "");
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return [cols.join(","), ...s.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : "–";
}

function summarize(study) {
  const { rows } = study;
  const tiers = ["low", "medium", "high"];
  const by = (pred) => rows.filter(pred);
  const bad = (r) => !!r.reverted || r.fix_followups.length > 0;
  const lines = [];
  const n = rows.length;
  lines.push(`# Change evidence study`);
  lines.push("");
  lines.push(`${n} merged PRs, ${rows[0]?.date.slice(0, 10)} to ${rows[n - 1]?.date.slice(0, 10)}. Policy ${study.policy.name} v${study.policy.version}. Fix follow-up window: ${study.followupDays} days.`);
  lines.push("");
  lines.push(`Outcome labels are proxies. "Reverted" means a later commit on the main line reverts the PR. "Fix follow-up" means a later \`fix\` PR within the window deleted or modified lines this PR introduced (SZZ, via git blame on the fix's base). It misses fixes that only add lines and fixes not labelled \`fix\`, and can blame a PR that only reformatted the line (whitespace is ignored, other refactors are not).`);
  lines.push("");
  lines.push(`## Tiers and outcomes`);
  lines.push("");
  lines.push(`| Tier | PRs | Share | Reverted | Fix follow-up | Either |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const t of tiers) {
    const g = by((r) => r.risk.tier === t);
    lines.push(`| ${t} | ${g.length} | ${pct(g.length, n)} | ${g.filter((r) => r.reverted).length} (${pct(g.filter((r) => r.reverted).length, g.length)}) | ${g.filter((r) => r.fix_followups.length).length} (${pct(g.filter((r) => r.fix_followups.length).length, g.length)}) | ${pct(g.filter(bad).length, g.length)} |`);
  }
  const all = rows.filter(bad).length;
  lines.push(`| all | ${n} | 100% | ${rows.filter((r) => r.reverted).length} | ${rows.filter((r) => r.fix_followups.length).length} | ${pct(all, n)} |`);
  lines.push("");
  const hiMed = by((r) => r.risk.tier !== "low");
  lines.push(`Review load: ${pct(hiMed.length, n)} of PRs would go to a human (medium or high). Those PRs hold ${pct(hiMed.filter(bad).length, all)} of all PRs with a bad-outcome proxy, and ${pct(hiMed.filter((r) => r.reverted).length, rows.filter((r) => r.reverted).length)} of the reverted ones.`);
  lines.push("");
  // Same thing by size alone, as the baseline the rules must beat.
  const sorted = [...rows].sort((a, b) => b.lines.added + b.lines.removed - (a.lines.added + a.lines.removed));
  const topBySize = new Set(sorted.slice(0, hiMed.length).map((r) => r.pr));
  const sizeCatch = rows.filter((r) => topBySize.has(r.pr) && bad(r)).length;
  lines.push(`Baseline: flagging the same number of PRs by size alone (largest first) would catch ${pct(sizeCatch, all)} of the bad-outcome PRs.`);
  lines.push("");
  // Size is the obvious confounder: big PRs trip more rules and give SZZ more lines to blame.
  // Within each size band, compare PRs flagged by a non-size rule against the rest.
  const L = (r) => r.lines.added + r.lines.removed;
  const nonSize = (r) => r.risk.hits.some((h) => h.level !== "low" && !h.rule.startsWith("size:"));
  lines.push(`### Controlling for size`);
  lines.push("");
  lines.push(`Bad-outcome rate within each size band, for PRs flagged by a rule other than size versus the rest. If the rules add information beyond size, the flagged column should be higher in every band.`);
  lines.push("");
  lines.push(`| Changed lines | PRs | Flagged by a non-size rule | Not flagged |`);
  lines.push(`|---|---:|---:|---:|`);
  const rate = (g) => (g.length ? `${pct(g.filter(bad).length, g.length)} (${g.filter(bad).length}/${g.length})` : "–");
  for (const [a, b] of [[0, 20], [21, 80], [81, 250], [251, 800], [801, Infinity]]) {
    const g = rows.filter((r) => L(r) >= a && L(r) <= b);
    lines.push(`| ${a}–${b === Infinity ? "" : b} | ${g.length} | ${rate(g.filter(nonSize))} | ${rate(g.filter((r) => !nonSize(r)))} |`);
  }
  lines.push("");
  lines.push(`### Size threshold`);
  lines.push("");
  lines.push(`Review load and capture if the size rule fired above each threshold, with every other rule unchanged. If precision stays flat across rows, the threshold is a budget choice, not an accuracy one.`);
  lines.push("");
  lines.push(`| Size rule fires above | Review load | Captures | Precision |`);
  lines.push(`|---|---:|---:|---:|`);
  for (const t of [250, 400, 600, 800, 1200, 2000, Infinity]) {
    const g = rows.filter((r) => nonSize(r) || L(r) > t || (t !== Infinity && r.files.length > Math.round(t / 20)));
    lines.push(`| ${t === Infinity ? "never" : `${t} lines / ${Math.round(t / 20)} files`} | ${pct(g.length, n)} | ${pct(g.filter(bad).length, all)} | ${pct(g.filter(bad).length, g.length)} |`);
  }
  lines.push("");
  lines.push(`Security, data and trust-root rules exist to route changes by consequence, not by likelihood of a bug, so a defect proxy is only one yardstick for them: a CI workflow change needs a human whether or not it later gets fixed.`);
  lines.push("");
  lines.push(`## Rules`);
  lines.push("");
  lines.push(`How often each rule fired at medium or high, and the bad-outcome rate of the PRs it fired on (base rate ${pct(all, n)}).`);
  lines.push("");
  lines.push(`| Rule | Dimension | PRs | Bad-outcome rate | Reverted |`);
  lines.push(`|---|---|---:|---:|---:|`);
  const ruleMap = new Map();
  for (const r of rows) {
    for (const h of r.risk.hits) {
      if (h.level === "low") continue;
      const k = h.rule;
      if (!ruleMap.has(k)) ruleMap.set(k, { dimension: h.dimension, prs: new Set() });
      ruleMap.get(k).prs.add(r);
    }
  }
  for (const [rule, v] of [...ruleMap].sort((a, b) => b[1].prs.size - a[1].prs.size)) {
    const g = [...v.prs];
    lines.push(`| ${rule} | ${v.dimension} | ${g.length} | ${pct(g.filter(bad).length, g.length)} | ${g.filter((r) => r.reverted).length} |`);
  }
  lines.push("");
  lines.push(`## Extractor coverage`);
  lines.push("");
  lines.push(`| Extractor | PRs in scope | Changes observed | UNKNOWN | UNKNOWN rate |`);
  lines.push(`|---|---:|---:|---:|---:|`);
  for (const ex of ["routes", "migrations", "dependencies", "workflows"]) {
    const scoped = rows.filter((r) => {
      const e = r.evidence.find((x) => x.extractor === ex);
      return e && !/^no .* changed/.test(e.note || "");
    });
    const unk = scoped.filter((r) => r.evidence.find((x) => x.extractor === ex).state === "UNKNOWN");
    const obs = scoped.filter((r) => r.evidence.find((x) => x.extractor === ex).observed.length);
    lines.push(`| ${ex} | ${scoped.length} | ${obs.length} | ${unk.length} | ${pct(unk.length, scoped.length)} |`);
  }
  lines.push("");
  const unkReasons = new Map();
  for (const r of rows) for (const e of r.evidence) for (const u of e.unknown) {
    const k = `${e.extractor}: ${u.replace(/^[^:]+:(\d+:)?\s*/, "").replace(/\(.*\)$/, "").replace(/route \S+ /, "route ").trim()}`;
    unkReasons.set(k, (unkReasons.get(k) || 0) + 1);
  }
  if (unkReasons.size) {
    lines.push(`Most common reasons for UNKNOWN:`);
    lines.push("");
    for (const [k, c] of [...unkReasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`- ${k} (${c})`);
    lines.push("");
  }
  lines.push(`## Misses: low tier, later reverted`);
  lines.push("");
  const misses = rows.filter((r) => r.risk.tier === "low" && r.reverted);
  if (!misses.length) lines.push("None.");
  for (const r of misses) lines.push(`- #${r.pr} ${r.title} (${r.files.length} files, ${r.lines.added + r.lines.removed} lines; reverted by ${r.reverted.by}, matched by ${r.reverted.how})`);
  lines.push("");
  lines.push(`## Reverted PRs`);
  lines.push("");
  for (const r of rows.filter((x) => x.reverted)) lines.push(`- #${r.pr} [${r.risk.tier}] ${r.title}: ${[...new Set(r.risk.hits.filter((h) => h.level !== "low").map((h) => h.rule))].join(", ") || "no rules fired"}`);
  lines.push("");
  lines.push(`## High tier, by rule`);
  lines.push("");
  for (const r of by((x) => x.risk.tier === "high").slice(-40)) {
    lines.push(`- #${r.pr} ${r.title}: ${[...new Set(r.risk.hits.filter((h) => h.level === "high").map((h) => h.rule))].join(", ")}${r.reverted ? " — reverted" : ""}${r.fix_followups.length ? ` — fixed by #${r.fix_followups.join(", #")}` : ""}`);
  }
  if (by((x) => x.risk.tier === "high").length > 40) lines.push(`- … (most recent 40 shown; see study.csv)`);
  lines.push("");
  return lines.join("\n");
}

module.exports = { runStudy, analyseChange, findReverts, toCsv, summarize, rowSummary };
