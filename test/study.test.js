"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseSubject } = require("../lib/history");
const { runStudy, toCsv, summarize } = require("../lib/study");
const policy = require("../policies/laravel.json");
const { repo } = require("./helpers");

test("parseSubject", () => {
  assert.deepEqual(
    (({ pr, kind, title, type, scope, breaking }) => ({ pr, kind, title, type, scope, breaking }))(parseSubject("feat(api)!: drop v1 (#42)")),
    { pr: 42, kind: "squash", title: "feat(api)!: drop v1", type: "feat", scope: "api", breaking: true },
  );
  assert.equal(parseSubject("Merge pull request #7 from a/b").pr, 7);
  assert.equal(parseSubject('Revert "feat: x (#3)"').type, "revert");
  assert.equal(parseSubject("wip").pr, null);
});

test("end to end: reverts and SZZ fix follow-ups are linked", () => {
  const t = repo();
  t.commit("init", { "app/A.php": "<?php\none\ntwo\nthree\n", "app/B.php": "<?php\nb\n" });
  t.commit("feat: change A (#1)", { "app/A.php": "<?php\none\nTWO bug\nthree\n" });
  t.commit("feat: touch B (#2)", { "app/B.php": "<?php\nb2\n" });
  const fix = t.commit("fix: repair A (#3)", { "app/A.php": "<?php\none\nTWO fixed\nthree\n" });
  const four = t.commit("feat: risky ci (#4)", { ".github/workflows/ci.yml": "on: push\n" });
  t.g("revert", "--no-edit", four);
  const s = runStudy(t.dir, { policy, followupDays: 14 });
  const by = Object.fromEntries(s.rows.map((r) => [r.pr, r]));
  assert.deepEqual(Object.keys(by).map(Number), [1, 2, 3, 4]);
  assert.deepEqual(by[1].fix_followups, [3]);
  assert.deepEqual(by[2].fix_followups, []);
  assert.ok(by[4].reverted);
  assert.equal(by[4].reverted.how, "sha");
  assert.equal(by[4].risk.tier, "high");
  assert.ok(fix);
  const csv = toCsv(s.rows);
  assert.match(csv.split("\n")[0], /^pr,sha,date,type,title,files,lines,tier/);
  const md = summarize(s);
  assert.match(md, /## Tiers and outcomes/);
  assert.match(md, /### Controlling for size/);
  assert.match(md, /### Size threshold/);
});

test("cli: pr writes report.md and evidence.json and exits 0 in shadow mode", () => {
  const { execFileSync } = require("child_process");
  const fs = require("fs");
  const path = require("path");
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  t.g("checkout", "-q", "-b", "feature");
  const head = t.commit("change", { ".github/workflows/ci.yml": "on: push\n" });
  const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "ce-out-"));
  const bin = path.join(__dirname, "..", "bin", "change-evidence.js");
  execFileSync(process.execPath, [bin, "pr", t.dir, "--base", base, "--head", head, "--out", out], { encoding: "utf8" });
  const j = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
  assert.equal(j.risk.tier, "high");
  assert.equal(j.mode, "shadow");
  assert.match(fs.readFileSync(path.join(out, "report.md"), "utf8"), /Trust root \(high\)/);
  let code = 0;
  try {
    execFileSync(process.execPath, [bin, "pr", t.dir, "--base", base, "--head", head, "--out", out, "--fail-on", "high"], { stdio: "ignore" });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 1);
  assert.match(execFileSync(process.execPath, [bin, "init", "--integrity", `sha512-${"A".repeat(86)}==`], { encoding: "utf8", env: { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" } }), /workflow_run/);
});
