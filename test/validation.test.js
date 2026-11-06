"use strict";
// The study as a validation instrument: outcome provenance, strict vs inclusive labels,
// merge-commit and direct-push SZZ, metrics with intervals, blind labelling, holdout,
// calibration status, and byte-for-byte reproducibility.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { runStudy, summarize, calibrationStatus } = require("../lib/study");
const { labelFor } = require("../lib/outcomes");
const { wilson, confusion, captureAtBudget } = require("../lib/metrics");
const labels = require("../lib/labels");
const { builtin } = require("../lib/policy");
const { repo } = require("./helpers");

const BIN = path.join(__dirname, "..", "bin", "change-evidence.js");
const policy = builtin();
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" } });

test("wilson intervals match reference values", () => {
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-4, `${a} vs ${b}`);
  const [lo0, hi0] = wilson(0, 10);
  close(lo0, 0);
  close(hi0, 0.27753);
  const [lo5, hi5] = wilson(5, 10);
  close(lo5, 0.23659);
  close(hi5, 0.76341);
  assert.equal(wilson(0, 0), null);
});

test("confusion excludes ambiguous labels and flags small samples as exploratory", () => {
  const rows = [
    { f: true, y: true },
    { f: true, y: false },
    { f: false, y: true },
    { f: false, y: false },
    { f: true, y: null },
  ];
  const c = confusion(rows, (r) => r.f, (r) => r.y);
  assert.deepEqual([c.tp, c.fp, c.fn, c.tn, c.excluded], [1, 1, 1, 1, 1]);
  assert.equal(c.precision.value, 0.5);
  assert.equal(c.exploratory, true);
  const cap = captureAtBudget([{ s: 1, y: true, id: 2 }, { s: 1, y: false, id: 1 }, { s: 0, y: true, id: 3 }], { score: (r) => r.s, tie: (r) => r.id, label: (r) => r.y, budget: 0.34 });
  assert.equal(cap.reviewed, 2);
  assert.equal(cap.capture.k, 1, "ties broken deterministically by id, not by luck");
});

// A history with each kind of outcome.
function history() {
  const t = repo();
  t.commit("init", { "app/A.php": "<?php\none\ntwo\nthree\n", "app/B.php": "<?php\nb\n", "app/C.php": "<?php\nc\n", "app/D.php": "<?php\nd\n" });
  const one = t.commit("feat: change A (#1)", { "app/A.php": "<?php\none\nTWO bug\nthree\n" });
  t.commit("feat: touch B (#2)", { "app/B.php": "<?php\nb2\n" });
  // A direct push (not a PR) that fixes #1's line.
  t.commit("Fixed the A bug", { "app/A.php": "<?php\none\nTWO fixed\nthree\n" });
  const four = t.commit("feat: risky (#4)", { "app/C.php": "<?php\nc2\n" });
  t.g("revert", "--no-edit", four); // reverted by sha
  const five = t.commit("feat: undone then restored (#5)", { "app/D.php": "<?php\nd2\n" });
  t.g("revert", "--no-edit", five);
  const revertSha = t.g("rev-parse", "HEAD");
  t.g("revert", "--no-edit", revertSha); // revert of the revert: #5 is restored
  t.commit("chore: unrelated (#6)", { "README.md": "x\n" });
  t.commit("revert: undo the README change from #6", { "README.md": "y\n" }); // a #N mention only: low confidence
  // A merge-commit PR whose line is later fixed through a PR.
  t.g("checkout", "-q", "-b", "feature");
  t.commit("work on B", { "app/B.php": "<?php\nb3 broken\n" });
  t.g("checkout", "-q", "main");
  require("child_process").execFileSync("git", ["-C", t.dir, "merge", "-q", "--no-ff", "feature", "-m", "Merge pull request #7 from me/feature\n\nImprove B"], { env: { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2026-01-09T18:00:00Z", GIT_COMMITTER_DATE: "2026-01-09T18:00:00Z" } });
  t.commit("fix: B (#8)", { "app/B.php": "<?php\nb3 fixed\n" });
  return { t, one };
}

test("outcomes carry provenance; strict excludes the ambiguous, inclusive takes everything", () => {
  const { t } = history();
  const s = runStudy(t.dir, { policy, followupDays: 14 });
  const by = Object.fromEntries(s.rows.map((r) => [r.pr, r]));
  assert.deepEqual(by[4].outcomes.reverts.map((e) => [e.how, e.confidence, !!e.restored]), [["sha", "high", false]]);
  assert.deepEqual(by[5].outcomes.reverts.map((e) => [e.how, !!e.restored]), [["sha", true]]);
  assert.deepEqual(by[6].outcomes.reverts.map((e) => [e.how, e.confidence]), [["pr-ref", "low"]]);
  // #1 was fixed by a direct push; #7 (a merge commit) by PR #8, via its branch commit.
  assert.equal(by[1].outcomes.fixes.length, 1);
  assert.ok(by[1].outcomes.fixes[0].commit, "a direct-push fix is recorded by commit");
  assert.deepEqual(by[7].outcomes.fixes.map((x) => x.pr), [8]);
  assert.equal(labelFor(by[4], "strict"), true);
  assert.equal(labelFor(by[5], "strict"), null, "a restored revert is ambiguous, not a failure");
  assert.equal(labelFor(by[6], "strict"), null, "a #N mention is ambiguous");
  assert.equal(labelFor(by[1], "strict"), null, "an SZZ candidate is ambiguous under strict");
  assert.equal(labelFor(by[2], "strict"), false);
  for (const n of [1, 4, 5, 6, 7]) assert.equal(labelFor(by[n], "inclusive"), true, `#${n}`);
  assert.equal(labelFor(by[2], "inclusive"), false);
});

test("holdout is chronological, and calibration status is stated", () => {
  const { t } = history();
  const s = runStudy(t.dir, { policy, holdout: 0.3, repository: "koel/koel" });
  const splits = s.rows.map((r) => r.split);
  assert.ok(splits.indexOf("holdout") > splits.lastIndexOf("development"), "holdout comes after development");
  assert.equal(s.calibration.calibrated, true);
  const md = summarize(s);
  assert.match(md, /\*\*In-sample\.\*\*/);
  assert.match(md, /not\* an independent test/);
  assert.equal(calibrationStatus(policy, "someone/else").calibrated, false);
  assert.match(summarize(runStudy(t.dir, { policy, repository: "someone/else" })), /\*\*Out-of-sample\.\*\*/);
  assert.match(md, /† rest on fewer than 20 positive labels/);
  assert.match(md, /Lift over size/);
  assert.match(md, /### Controlling for size/);
  assert.match(md, /### Size threshold/);
});

test("study output is byte-for-byte reproducible", () => {
  const { t } = history();
  const outs = [0, 1].map(() => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "ce-study-"));
    const r = run(["study", t.dir, "--out", out, "--repository", "acme/app", "--export-sample", path.join(out, "sample.csv"), "--sample", "6", "--seed", "7"]);
    assert.equal(r.status, 0, r.stderr);
    return out;
  });
  for (const f of ["study.json", "study.csv", "summary.md", "sample.csv", "sample.csv.key.json"]) {
    assert.equal(fs.readFileSync(path.join(outs[0], f), "utf8"), fs.readFileSync(path.join(outs[1], f), "utf8"), `${f} differs between runs`);
  }
});

test("the blind sample hides the tool's view, and labels come back with per-tier rates", () => {
  const { t } = history();
  const s = runStudy(t.dir, { policy });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-label-"));
  const file = path.join(dir, "sample.csv");
  labels.exportSample(s.rows, file, { size: 6, seed: 3, repository: "acme/app", policy: s.policy, url: "https://github.com/acme/app" });
  const sheet = fs.readFileSync(file, "utf8");
  const header = sheet.split("\n")[0];
  assert.equal(header, "sample_id,pr,merged,title,link,files,changed_lines,judgement,notes");
  assert.doesNotMatch(sheet, /\b(low|medium|high)\b|revert|tier|rule/i, "the sheet leaks the tool's view or the outcome");
  const key = JSON.parse(fs.readFileSync(`${file}.key.json`, "utf8"));
  assert.equal(Object.keys(key.items).length, 6);
  // Fill it in: every sampled PR judged risky except one unsure and one invalid answer.
  const rows = labels.parseCsv(sheet);
  rows.forEach((r, i) => (r.judgement = i === 0 ? "unsure" : i === 1 ? "maybe" : i % 2 ? "risky" : "fine"));
  fs.writeFileSync(file, labels.toCsvRows(rows));
  const back = labels.readLabels(file, s.rows);
  assert.equal(back.labelled.length, 5);
  assert.match(back.problems.join(" "), /isn't risky, fine or unsure/);
  const a = labels.assessLabels(back);
  assert.equal(a.unsure, 1);
  assert.ok(["low", "medium", "high"].every((tier) => a.perTier[tier]));
  assert.equal(a.exploratory, true);
  // CLI: --labels adds the section to the summary.
  const out = path.join(dir, "out");
  const r = run(["study", t.dir, "--out", out, "--labels", file]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(out, "summary.md"), "utf8"), /## Independent human assessment/);
});

test("sampling is seeded and stratified; CSV escapes spreadsheet formulas", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ pr: i + 1, sha: String(i), risk: { tier: i < 20 ? "low" : i < 27 ? "medium" : "high" } }));
  const a = labels.sample(rows, { size: 9, seed: 5 }).map((x) => x.row.pr);
  const b = labels.sample(rows, { size: 9, seed: 5 }).map((x) => x.row.pr);
  assert.deepEqual(a, b);
  const strata = labels.sample(rows, { size: 9, seed: 5 }).map((x) => x.stratum);
  for (const t of ["low", "medium", "high"]) assert.equal(strata.filter((s) => s === t).length, 3);
  assert.match(labels.toCsvRows([{ title: "=HYPERLINK(\"x\")" }]), /"'=HYPERLINK\(""x""\)"/);
  assert.deepEqual(labels.parseCsv('a,b\n"x, y","he said ""hi"""\r\n'), [{ a: "x, y", b: 'he said "hi"' }]);
});
