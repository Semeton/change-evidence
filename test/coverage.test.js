"use strict";
// #4: a report must say what wasn't checked because the repository has nothing to read,
// so a low result on a non-Laravel repository doesn't read as an all-clear.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { repo } = require("./helpers");

const BIN = path.join(__dirname, "..", "bin", "change-evidence.js");

test("extractors with nothing to read are NOT_APPLICABLE, named in the report and the JSON", () => {
  const t = repo();
  const base = t.commit("init", { "src/index.ts": "export const a = 1;\n" });
  const head = t.commit("x", { "src/index.ts": "export const a = 2;\n" });
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ce-cov-"));
  const r = spawnSync(process.execPath, [BIN, "pr", t.dir, "--base", base, "--head", head, "--out", out, "--policy", path.join(__dirname, "..", "policies", "laravel.json")], { encoding: "utf8", env: { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" } });
  assert.equal(r.status, 0, r.stderr);
  const md = fs.readFileSync(path.join(out, "report.md"), "utf8");
  const json = JSON.parse(fs.readFileSync(path.join(out, "evidence.json"), "utf8"));
  assert.match(md, /review priority: low/);
  assert.match(md, /\*\*Not checked here:\*\* routes, migrations, dependencies, workflows/);
  assert.match(md, /\*\*routes: not checked\*\*: this repository has no Laravel route files/);
  assert.equal(json.coverage.routes, "not checked: this repository has no Laravel route files (routes/**/*.php)");
  assert.equal(json.evidence.find((e) => e.extractor === "migrations").state, "NOT_APPLICABLE");
});

test("an extractor whose inputs exist but didn't change is checked, not NOT_APPLICABLE", () => {
  const t = repo();
  const base = t.commit("init", { "routes/web.php": "<?php\nRoute::get('a', A::class);\n", "app/A.php": "<?php\n" });
  const head = t.commit("x", { "app/A.php": "<?php\n$a = 1;\n" });
  const { analyseChange } = require("../lib/study");
  const { compile } = require("../lib/risk");
  const r = analyseChange(t.dir, base, head, compile(require("../policies/laravel.json")));
  assert.equal(r.coverage.routes, "checked");
  assert.match(r.coverage.migrations, /^not checked/);
});
