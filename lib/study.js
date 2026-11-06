"use strict";

// Phase 1 study: replay merged PRs, extract evidence, assess risk, then join each PR to
// what happened to it afterwards. The outcome labels are proxies, and named as such:
//   reverted      a later commit on the main line reverts it (by sha, by "#N", or by title)
//   fix_followup  a later `fix` PR within N days touches at least one of the same source files
// The question the study answers: do the tiers concentrate the changes that later needed
// undoing or fixing, and how much review load would they create?

const { git, changedFiles, numstat, numstatByFile, diffLines } = require("./git");
const { classifier } = require("./generated");
const { mergedPRs } = require("./history");
const { attachOutcomes, labelFor, findReverts } = require("./outcomes");
const { confusion, captureAtBudget, prop, fmt, MIN_POSITIVES } = require("./metrics");
const { extractRoutes } = require("./extractors/routes");
const { extractMigrations } = require("./extractors/migrations");
const { extractDependencies } = require("./extractors/dependencies");
const { extractWorkflows } = require("./extractors/workflows");
const { extractPrisma, isPrismaMigration, isSchema } = require("./extractors/prisma");
const { assess, compile, DIMENSIONS } = require("./risk");
const { result, notApplicable } = require("./evidence");
const { isRouteFile } = require("./extractors/routes");
const { isMigration } = require("./extractors/migrations");

// What each extractor reads, to tell "nothing changed" from "nothing here to check".
const LOCKS = /^(composer\.(json|lock)|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const COVERAGE = {
  routes: { test: (f) => isRouteFile(f), none: "no Laravel route files (routes/**/*.php)" },
  migrations: { test: (f) => isMigration(f), none: "no Laravel migrations (database/migrations)" },
  dependencies: { test: (f) => LOCKS.test(f), none: "no composer or npm manifest or lockfile at the root" },
  workflows: { test: (f) => /^\.github\/(workflows|actions)\//.test(f), none: "no GitHub Actions workflows" },
  prisma: { test: (f) => isPrismaMigration(f) || isSchema(f), none: "no Prisma schema or migrations" },
};

// File list at a commit, cached: a study asks for many heads, some more than once.
const TREES = new Map();
function treeAt(cwd, commit) {
  const k = `${cwd}\u0000${commit}`;
  if (!TREES.has(k)) {
    if (TREES.size > 64) TREES.clear();
    TREES.set(k, (git(cwd, ["ls-tree", "-r", "--name-only", commit], { allowFail: true }) || "").split("\n").filter(Boolean));
  }
  return TREES.get(k);
}

const EXTRACTORS = [extractRoutes, extractMigrations, extractDependencies, extractWorkflows, extractPrisma];
// For tests and future ecosystems: run with a different extractor list.
function withExtractors(list, fn) {
  const saved = EXTRACTORS.splice(0, EXTRACTORS.length, ...list);
  try {
    return fn();
  } finally {
    EXTRACTORS.splice(0, EXTRACTORS.length, ...saved);
  }
}

function diffScope(policy, files) {
  // Only fetch diff lines for files a pattern rule could match: keeps replay fast.
  // Generated and vendored files aren't scanned: nobody reviews a bundle line by line, and
  // a committed node_modules would make every pattern rule read megabytes. Path rules
  // still see them.
  return files.filter((f) => f.status !== "D" && !f.generated && policy.pattern_rules.some((r) => r.re.some((re) => re.test(f.path)))).map((f) => f.path);
}

function analyseChange(cwd, base, head, policy, { policyBase = base } = {}) {
  const isGenerated = classifier(cwd, policyBase, policy);
  const files = changedFiles(cwd, base, head).map((f) => {
    const why = isGenerated(f.path);
    return why ? { ...f, generated: why } : f;
  });
  const perFile = numstatByFile(cwd, base, head);
  const lines = { added: 0, removed: 0 };
  const counted = { added: 0, removed: 0, files: 0 };
  for (const f of files) {
    const n = perFile.get(f.path) || { added: 0, removed: 0 };
    lines.added += n.added;
    lines.removed += n.removed;
    if (f.generated) continue;
    counted.added += n.added;
    counted.removed += n.removed;
    counted.files++;
  }
  const scoped = diffScope(policy, files);
  const diff = scoped.length ? diffLines(cwd, base, head, scoped) : new Map();
  const ctx = { cwd, base, head, changed: files };
  const evidence = EXTRACTORS.map((ex) => {
    try {
      return ex(ctx);
    } catch (e) {
      // A failing extractor is UNKNOWN for this change, never a silent pass.
      return result(ex.name.replace(/^extract/, "").toLowerCase(), { unknown: [`extractor failed: ${String(e.message || e).split("\n")[0].slice(0, 200)}`] });
    }
  });
  // Coverage (#4): an extractor whose inputs don't exist anywhere in the repository at
  // head didn't check anything. Say so (NOT_APPLICABLE, with why), rather than return a
  // PASS that reads as an all-clear.
  const tree = treeAt(cwd, head);
  for (let i = 0; i < evidence.length; i++) {
    const e = evidence[i];
    const spec = COVERAGE[e.extractor];
    if (!spec || e.observed.length || e.unknown.length) continue;
    if (!tree.some(spec.test)) evidence[i] = notApplicable(e.extractor, `this repository has ${spec.none}`);
  }
  const coverage = Object.fromEntries(evidence.map((e) => [e.extractor, e.state === "NOT_APPLICABLE" ? `not checked: ${e.note}` : "checked"]));
  const risk = assess(policy, { files, lines, counted, diff }, evidence);
  return { files, lines, counted, evidence, risk, coverage };
}

// owner/repo from the origin remote, for matching the policy's calibration register.
function repositoryOf(cwd) {
  const url = git(cwd, ["remote", "get-url", "origin"], { allowFail: true }) || "";
  const m = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/i.exec(url.trim());
  return m ? m[1].toLowerCase() : null;
}

// Was this repository's history used to calibrate the policy, and through when?
function calibrationStatus(policy, repository) {
  const entry = (policy.calibration || []).find((c) => String(c.repository).toLowerCase() === repository);
  return entry ? { calibrated: true, through: entry.through, note: entry.note || "" } : { calibrated: false };
}

// Deterministic: the same repository, ref and options give byte-identical output.
// (No wall-clock time is recorded; the head commit identifies the input.)
function runStudy(cwd, { ref = "HEAD", since, limit, policy: policyIn, followupDays = 14, holdout = 0.3, repository, onProgress } = {}) {
  const policy = compile(policyIn);
  const prs = mergedPRs(cwd, { ref, since, limit });
  const rows = [];
  prs.forEach((p, i) => {
    const a = analyseChange(cwd, p.base, p.sha, policy);
    rows.push({ ...p, ...a });
    if (onProgress) onProgress(i + 1, prs.length, p);
  });
  attachOutcomes(cwd, rows, { ref, allPrs: mergedPRs(cwd, { ref }), followupDays });
  // Chronological split: the earliest (1 - holdout) for development, the rest held out.
  const cut = Math.floor(rows.length * (1 - holdout));
  rows.forEach((r, i) => (r.split = i < cut ? "development" : "holdout"));
  const repo = repository || repositoryOf(cwd);
  const head = git(cwd, ["rev-parse", ref]).trim();
  return {
    rows,
    repository: repo,
    head,
    ref,
    policy: { name: policyIn.name, version: policyIn.version, overlay: policyIn.overlay || null },
    cut: cut > 0 && cut < rows.length ? { pr: rows[cut - 1].pr, sha: rows[cut - 1].sha } : null,
    calibration: calibrationStatus(policyIn, repo),
    followupDays,
    holdout,
    recovery: { squash: rows.filter((r) => r.kind === "squash").length, merge: rows.filter((r) => r.kind === "merge").length },
  };
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
    revert_how: (r.outcomes ? r.outcomes.reverts : []).map((e) => e.how).join(" "),
    revert_confidence: (r.outcomes ? r.outcomes.reverts : []).map((e) => e.confidence).join(" "),
    revert_restored: (r.outcomes ? r.outcomes.reverts : []).some((e) => e.restored) ? "yes" : "",
    fix_followups: r.fix_followups.join(" "),
    szz_blamed_lines: (r.outcomes ? r.outcomes.fixes : []).map((x) => x.blamed_lines).join(" "),
    label_strict: labelFor(r, "strict") === null ? "ambiguous" : labelFor(r, "strict") ? "1" : "0",
    label_inclusive: labelFor(r, "inclusive") ? "1" : "0",
    // Appended, never inserted: existing consumers read columns by position.
    counted_lines: r.counted ? r.counted.added + r.counted.removed : r.lines.added + r.lines.removed,
    split: r.split || "",
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

const counted = (r) => (r.counted ? r.counted.added + r.counted.removed : r.lines.added + r.lines.removed);
const flagged = (r) => r.risk.tier !== "low";
const TIER_RANK = { low: 0, medium: 1, high: 2 };
const strict = (r) => labelFor(r, "strict");
const inclusive = (r) => labelFor(r, "inclusive");
const dagger = (x) => (x.exploratory ? " †" : "");

function summarize(study, { human } = {}) {
  const { rows } = study;
  const n = rows.length;
  const out = [];
  const L = (...x) => out.push(...x);
  const nonSize = (r) => r.risk.hits.some((h) => h.level !== "low" && h.kind !== "size" && !String(h.rule).startsWith("size:"));
  const dev = rows.filter((r) => r.split === "development");
  const hold = rows.filter((r) => r.split === "holdout");

  L("# Change evidence study", "");
  L(`**${study.repository || "repository"}** at \`${String(study.head || "").slice(0, 12)}\`: ${n} merged PRs, ${rows[0] ? rows[0].date.slice(0, 10) : "–"} to ${rows[n - 1] ? rows[n - 1].date.slice(0, 10) : "–"} (${study.recovery.squash} squash merges, ${study.recovery.merge} merge commits). Policy ${study.policy.name} v${study.policy.version}${study.policy.overlay ? ` with the repository overlay \`${study.policy.overlay}\`` : ", built-in only (no repository overlay)"}. A PR is *flagged* when its review priority is medium or high.`, "");

  // --- Validity first -------------------------------------------------------------------
  L("## How far these numbers can be trusted", "");
  const cal = study.calibration || { calibrated: false };
  if (cal.calibrated) {
    const after = rows.filter((r) => r.date.slice(0, 10) > cal.through);
    L(`**In-sample.** The policy's rules and thresholds were adjusted after studying this repository's history through ${cal.through}${cal.note ? ` (${cal.note})` : ""}. ${after.length ? `Only ${after.length} PRs merged after that date are out of sample.` : "No PR here is out of sample."} The chronological holdout below is therefore *not* an independent test for this repository. It only shows whether results drift over time. Independent validation needs a repository the policy wasn't calibrated on.`, "");
  } else {
    L(`**Out-of-sample.** This repository isn't in the policy's calibration register, so the built-in rules weren't tuned on it. The earliest ${Math.round((1 - study.holdout) * 100)}% of PRs form a development split, and the latest ${Math.round(study.holdout * 100)}% are held out. If you tune an overlay on this repository, tune it on the development split only and judge it on the holdout.`, "");
  }
  if (study.policy.overlay) {
    L(`**The overlay is repository-specific.** If it was derived from this repository's history, for example by \`suggest\`, every PR it saw is in-sample for it. Derive it from the development split only${study.cut ? ` (\`change-evidence suggest --ref ${study.cut.sha.slice(0, 12)}\`, the last development PR, #${study.cut.pr})` : ""} and judge it on the holdout.`, "");
  }
  L(`Results marked † rest on fewer than ${MIN_POSITIVES} positive labels: treat them as exploratory, not as findings. Intervals are Wilson 95% intervals.`, "");

  // --- Labels ---------------------------------------------------------------------------
  const rev = rows.flatMap((r) => (r.outcomes ? r.outcomes.reverts : []));
  const szz = rows.filter((r) => r.outcomes && r.outcomes.fixes.length);
  const st = { pos: rows.filter((r) => strict(r) === true).length, neg: rows.filter((r) => strict(r) === false).length, amb: rows.filter((r) => strict(r) === null).length };
  L("## Outcome labels", "");
  L("Two proxy labels, neither of them ground truth:", "");
  L(`- **strict**: positive is a revert matched by commit SHA or exact title that stayed reverted. Negative is no outcome of any kind. Everything else is *excluded as ambiguous*, never counted as a failure. Here: ${st.pos} positive, ${st.neg} negative, ${st.amb} excluded.`);
  L(`- **inclusive**: positive is any revert, or an SZZ candidate (a later fix within ${study.followupDays} days changed lines this PR introduced). Here: ${rows.filter(inclusive).length} positive of ${n}.`, "");
  L(`Reverts found: ${rev.length} (by SHA ${rev.filter((e) => e.how === "sha").length}, by title ${rev.filter((e) => e.how === "title").length}, by a #N mention ${rev.filter((e) => e.how === "pr-ref").length}; ${rev.filter((e) => e.restored).length} later restored). SZZ candidates: ${szz.length} PRs, blamed by ${new Set(szz.flatMap((r) => r.outcomes.fixes.map((x) => x.pr || x.commit))).size} fixes (${new Set(szz.flatMap((r) => r.outcomes.fixes.filter((x) => !x.pr).map((x) => x.commit))).size} of them pushed directly, not through a PR).`, "");
  L("Known limits:", "");
  L("- **Revert detection** sees reverts on the main line only, and only when the revert says what it reverts. A change undone by hand, by a later refactor, or in another branch isn't seen. A revert can be for timing or a dependency rather than a defect; restored reverts are excluded from *strict* for that reason.");
  L("- **SZZ** blames the lines a fix deletes or modifies, so fixes that only add lines implicate nothing. It can blame a PR that merely moved or reformatted a line (whitespace is ignored, refactors aren't). Bigger PRs own more lines and so collect more blame, which biases SZZ toward size.");
  L(`- **The follow-up window** (${study.followupDays} days) misses later fixes and can catch unrelated ones.`);
  L("- **PR recovery** relies on squash titles ending `(#N)` or `Merge pull request #N`. Direct pushes, rebased merges and renamed titles are invisible, and the PRs that are found are a non-random subset.");
  L("- **Fixes** are main-line commits, PR or direct push, typed `fix` or titled Fix…, Fixed…, Hotfix… or Bugfix…. Unlabelled fixes are missed. For merge-commit PRs, blame is mapped from the branch's commits back to the PR.", "");

  // --- Tiers and outcomes ---------------------------------------------------------------
  L("## Tiers and outcomes", "");
  L("| Tier | PRs | Share | Inclusive positive rate | Strict positive rate (excluded) |", "|---|---:|---:|---:|---:|");
  for (const t of ["low", "medium", "high"]) {
    const g = rows.filter((r) => r.risk.tier === t);
    const gs = g.filter((r) => strict(r) !== null);
    L(`| ${t} | ${g.length} | ${pct(g.length, n)} | ${fmt(prop(g.filter(inclusive).length, g.length))} | ${fmt(prop(gs.filter((r) => strict(r)).length, gs.length))} (${g.length - gs.length}) |`);
  }
  L("");

  // --- Classification -------------------------------------------------------------------
  L("## Flagged (medium or high) against the labels", "");
  L("| Split | Label | PRs | Positives | Flagged share | Precision | Recall | False-positive rate | False-negative rate |", "|---|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [name, set] of [["all", rows], ["development", dev], ["holdout", hold]]) {
    for (const [lname, lab] of [["inclusive", inclusive], ["strict", strict]]) {
      const c = confusion(set, flagged, lab);
      L(`| ${name} | ${lname}${dagger(c)} | ${c.n}${c.excluded ? ` (+${c.excluded} excl.)` : ""} | ${c.positives} | ${fmt(c.flagged_share)} | ${fmt(c.precision)} | ${fmt(c.recall)} | ${fmt(c.false_positive_rate)} | ${fmt(c.false_negative_rate)} |`);
    }
  }
  L("");

  // --- Capture at a fixed budget --------------------------------------------------------
  L("## Capture at a fixed review budget", "");
  L("If reviewers can only look closely at a fixed share of PRs, what share of the positives fall in that share? *Tool* ranks by review priority, with ties in PR order, so size doesn't break ties. *Size only* ranks by reviewable changed lines. *Random* captures, in expectation, the budget itself.", "");
  L("| Label | Budget | Tool | Size only | Random |", "|---|---:|---:|---:|---:|");
  for (const [lname, lab] of [["inclusive", inclusive], ["strict", strict]]) {
    for (const budget of [0.1, 0.2, 0.3]) {
      const tool = captureAtBudget(rows, { score: (r) => TIER_RANK[r.risk.tier], tie: (r) => r.pr, label: lab, budget });
      const size = captureAtBudget(rows, { score: counted, tie: (r) => r.pr, label: lab, budget });
      L(`| ${lname}${dagger(tool)} | ${budget * 100}% | ${fmt(tool.capture)} | ${fmt(size.capture)} | ${budget * 100}% |`);
    }
  }
  L("");

  // --- Size controls (kept from earlier versions) ---------------------------------------
  const bad = inclusive;
  const all = rows.filter(bad).length;
  L("### Controlling for size", "");
  L("Inclusive positive rate within each band of reviewable changed lines, for PRs flagged by a rule other than size versus the rest. If the rules add information beyond size, the flagged column should be higher in every band.", "");
  L("| Changed lines | PRs | Flagged by a non-size rule | Not flagged |", "|---|---:|---:|---:|");
  const bands = [[0, 20], [21, 80], [81, 250], [251, 800], [801, Infinity]];
  const bandOf = (r) => bands.findIndex(([a, b]) => counted(r) >= a && counted(r) <= b);
  const bandRate = bands.map((_, i) => {
    const g = rows.filter((r) => bandOf(r) === i);
    return g.length ? g.filter(bad).length / g.length : 0;
  });
  for (const [i, [a, b]] of bands.entries()) {
    const g = rows.filter((r) => bandOf(r) === i);
    L(`| ${a}–${b === Infinity ? "" : b} | ${g.length} | ${fmt(prop(g.filter(nonSize).filter(bad).length, g.filter(nonSize).length))} | ${fmt(prop(g.filter((r) => !nonSize(r)).filter(bad).length, g.filter((r) => !nonSize(r)).length))} |`);
  }
  L("");
  L("### Size threshold", "");
  L("Review load and inclusive capture if the size rule fired above each threshold, with every other rule unchanged. If precision stays flat across rows, the threshold is a budget choice, not an accuracy one.", "");
  L("| Size rule fires above | Review load | Captures | Precision |", "|---|---:|---:|---:|");
  for (const t of [250, 400, 600, 800, 1200, 2000, Infinity]) {
    const g = rows.filter((r) => nonSize(r) || counted(r) > t || (t !== Infinity && (r.counted ? r.counted.files : r.files.length) > Math.round(t / 20)));
    L(`| ${t === Infinity ? "never" : `${t} lines / ${Math.round(t / 20)} files`} | ${pct(g.length, n)} | ${pct(g.filter(bad).length, all)} | ${pct(g.filter(bad).length, g.length)} |`);
  }
  L("");
  L("Security, data and trust-root rules route changes by consequence, not by the likelihood of a bug. A defect proxy is only one yardstick for them: a CI workflow change needs a human whether or not it later gets fixed.", "");

  // --- Rules ----------------------------------------------------------------------------
  L("## Rules", "");
  L(`Each rule that fired at medium or high: how often, the review load it adds on its own (PRs it alone escalated), the inclusive positive rate where it fired, and the *lift over size*. Lift is observed positives divided by the number expected from the size bands of those same PRs. Above 1 means the rule finds more than PR size alone predicts. A rule that rarely fires can still guard against a rare, serious change, so none is ever disabled for being quiet or noisy.`, "");
  L("| Rule | Dimension | Kind | PRs | Sole escalation | Positive rate | Lift over size |", "|---|---|---|---:|---:|---:|---:|");
  const ruleMap = new Map();
  for (const r of rows) {
    const elevated = r.risk.hits.filter((h) => h.level !== "low");
    for (const h of elevated) {
      if (!ruleMap.has(h.rule)) ruleMap.set(h.rule, { dimension: h.dimension, kind: h.kind || "", prs: new Set(), sole: 0 });
      ruleMap.get(h.rule).prs.add(r);
    }
    const distinct = [...new Set(elevated.map((h) => h.rule))];
    if (distinct.length === 1) ruleMap.get(distinct[0]).sole++;
  }
  for (const [rule, v] of [...ruleMap].sort((a, b) => b[1].prs.size - a[1].prs.size)) {
    const g = [...v.prs];
    const observed = g.filter(bad).length;
    const expected = g.reduce((acc, r) => acc + bandRate[bandOf(r)], 0);
    const exploratory = observed < MIN_POSITIVES ? " †" : "";
    L(`| ${rule} | ${v.dimension} | ${v.kind} | ${g.length} | ${v.sole} | ${fmt(prop(observed, g.length))} | ${expected ? (observed / expected).toFixed(2) : "–"}${exploratory} |`);
  }
  const fired = new Set(ruleMap.keys());
  const declared = (study.policyRules || []).filter((id) => !fired.has(id));
  if (declared.length) L("", `Never fired at medium or high in this history: ${declared.join(", ")}.`);
  L("");

  // --- Policy health --------------------------------------------------------------------
  // A maintenance view, not a pruning list. Nothing here is grounds to disable a rule on
  // its own: a rule that rarely fires can still be the one that catches a rare, serious
  // change, and a defect proxy can't judge consequence-based rules.
  L("## Policy health", "");
  const evaluated = (study.policyRules || []).length;
  const highDecided = new Map();
  for (const r of rows) {
    if (r.risk.tier !== "high") continue;
    for (const d of r.risk.decided_by || []) for (const rule of (r.risk.contributors || {})[d] || []) highDecided.set(rule, (highDecided.get(rule) || 0) + 1);
  }
  const baseRate = n ? all / n : 0;
  const quietRules = [...ruleMap].filter(([, v]) => v.prs.size > 0 && v.prs.size < Math.max(2, n * 0.01)).map(([k]) => k);
  const noisy = [...ruleMap].filter(([, v]) => {
    if (v.prs.size < 20) return false;
    const p = prop([...v.prs].filter(bad).length, v.prs.size);
    return p.ci && p.ci[1] < baseRate;
  }).map(([k, v]) => `${k} (${v.prs.size} PRs, ${fmt(prop([...v.prs].filter(bad).length, v.prs.size))})`);
  L(`- **Rules:** ${evaluated} in the policy; ${ruleMap.size} fired at medium or high; ${declared.length} never did.`);
  L(`- **Most often decided a high priority:** ${[...highDecided].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([k, c]) => `${k} (${c})`).join(", ") || "none"}.`);
  L(`- **Fired on under 1% of PRs:** ${quietRules.join(", ") || "none"}. Rare isn't useless.`);
  L(`- **Positive rate significantly below the base rate** (at least 20 PRs; the interval's upper bound is under ${(100 * baseRate).toFixed(1)}%): ${noisy.join(", ") || "none"}. These cost review time without matching the defect proxy. Review what they're for before changing them: a consequence rule may be right regardless.`);
  const unkBy = [...new Set(rows.flatMap((r) => r.evidence.map((e) => e.extractor)))].map((ex) => [ex, rows.filter((r) => (r.evidence.find((x) => x.extractor === ex) || {}).state === "UNKNOWN").length]);
  L(`- **UNKNOWN by extractor:** ${unkBy.map(([ex, c]) => `${ex} ${c}`).join(", ")} PRs. Each one raised a priority; the reasons are listed under *Extractor coverage*.`, "");

  // --- Extractor coverage (kept) --------------------------------------------------------
  L("## Extractor coverage", "");
  L("| Extractor | PRs in scope | Changes observed | UNKNOWN | UNKNOWN rate |", "|---|---:|---:|---:|---:|");
  for (const ex of [...new Set(rows.flatMap((r) => r.evidence.map((e) => e.extractor)))]) {
    const scoped = rows.filter((r) => {
      const e = r.evidence.find((x) => x.extractor === ex);
      return e && e.state !== "NOT_APPLICABLE" && !/^no .* changed/.test(e.note || "");
    });
    const notApplicable = rows.filter((r) => (r.evidence.find((x) => x.extractor === ex) || {}).state === "NOT_APPLICABLE").length;
    if (!scoped.length && notApplicable === rows.length) {
      L(`| ${ex} | not applicable: ${rows[0].evidence.find((x) => x.extractor === ex).note.replace(/^this repository has /, "")} | | | |`);
      continue;
    }
    const unk = scoped.filter((r) => r.evidence.find((x) => x.extractor === ex).state === "UNKNOWN");
    const obs = scoped.filter((r) => r.evidence.find((x) => x.extractor === ex).observed.length);
    L(`| ${ex} | ${scoped.length} | ${obs.length} | ${unk.length} | ${pct(unk.length, scoped.length)} |`);
  }
  L("");
  const unkReasons = new Map();
  for (const r of rows) for (const e of r.evidence) for (const u of e.unknown) {
    const k = `${e.extractor}: ${u.replace(/^[^:]+:(\d+:)?\s*/, "").replace(/\(.*\)$/, "").replace(/route \S+ /, "route ").trim()}`;
    unkReasons.set(k, (unkReasons.get(k) || 0) + 1);
  }
  if (unkReasons.size) {
    L("Most common reasons for UNKNOWN:", "");
    for (const [k, c] of [...unkReasons].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10)) L(`- ${k} (${c})`);
    L("");
  }

  // --- Human labels ---------------------------------------------------------------------
  if (human) {
    L("## Independent human assessment", "");
    L(`${human.labelled} sampled PRs were labelled blind (no tier, rules or outcomes shown); ${human.unsure} answered *unsure* and are excluded. The question was: *${human.question}*`, "");
    L("| Tier | PRs in tier | Labelled | Judged risky |", "|---|---:|---:|---:|");
    for (const t of ["low", "medium", "high"]) {
      const s = human.perTier[t];
      L(`| ${t} | ${s.population} | ${s.labelled} | ${fmt(s.risky)} |`);
    }
    L("", `Weighted estimate of the share of risky PRs the tool flags (medium or high): ${human.weighted_recall === null ? "–" : `${(100 * human.weighted_recall).toFixed(1)}%`}${human.exploratory ? " †" : ""}. Each tier is weighted by its size, because tiers were sampled at different rates. No interval is given: this needs a stratified estimator, and the sample is small.`, "");
    if (human.agreement) {
      L("Agreement on the labelled sample (risky vs fine):", "");
      L("| | Human: risky | Human: fine |", "|---|---:|---:|");
      for (const [name, row] of Object.entries(human.agreement)) L(`| ${name} | ${row.risky} | ${row.fine} |`);
      L("");
    }
    if (human.problems && human.problems.length) L(`Skipped rows: ${human.problems.slice(0, 10).join("; ")}.`, "");
  }

  // --- Cases ----------------------------------------------------------------------------
  L("## Misses: low tier, confirmed revert", "");
  const misses = rows.filter((r) => r.risk.tier === "low" && strict(r) === true);
  if (!misses.length) L("None.");
  for (const r of misses) {
    const e = r.outcomes.reverts.find((x) => !x.restored);
    L(`- #${r.pr} ${r.title} (${r.files.length} files, ${counted(r)} reviewable lines; reverted by ${e.by}, matched by ${e.how})`);
  }
  L("");
  L("## Reverted PRs", "");
  for (const r of rows.filter((x) => x.outcomes && x.outcomes.reverts.length)) {
    const e = r.outcomes.reverts[0];
    L(`- #${r.pr} [${r.risk.tier}] ${r.title}: matched by ${e.how} (${e.confidence} confidence)${e.restored ? `, later restored by ${e.restored.by}` : ""}; rules: ${[...new Set(r.risk.hits.filter((h) => h.level !== "low").map((h) => h.rule))].join(", ") || "none"}`);
  }
  L("");
  return out.join("\n");
}

module.exports = { COVERAGE, withExtractors, EXTRACTORS, runStudy, analyseChange, findReverts, toCsv, summarize, rowSummary, repositoryOf, calibrationStatus };
