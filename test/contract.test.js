"use strict";
// Every extractor's output meets the evidence contract (lib/evidence.js validateResult),
// across ordinary, empty, malformed and hostile changes.
const test = require("node:test");
const assert = require("node:assert");
const { analyseChange } = require("../lib/study");
const { compile } = require("../lib/risk");
const { builtin } = require("../lib/policy");
const { validateResult, result, STATES } = require("../lib/evidence");
const { repo } = require("./helpers");

const policy = compile(builtin());
const M = (up) => `<?php\nreturn new class { public function up(): void {\n${up}\n} };\n`;

test("the validator rejects output that breaks the contract", () => {
  assert.deepEqual(validateResult(result("routes", { observed: [{ op: "route_added", key: "GET /a" }] })), []);
  assert.match(validateResult({ ...result("routes", {}), state: STATES.PASS, unknown: ["x"] }).join(), /uncertainty must not be reported as a pass/);
  assert.match(validateResult(result("routes", { observed: [{ op: "", key: 1, line: 0 }] })).join(), /op: missing.*key: missing.*line/);
  assert.equal(result("dependencies", {}).ecosystem, "composer+npm");
  assert.equal(result("custom", { ecosystem: "django" }).ecosystem, "django");
});

test("every extractor's output meets the contract on ordinary, empty, malformed and hostile changes", () => {
  const t = repo();
  const base = t.commit("init", {
    "routes/web.php": "<?php\nRoute::middleware('auth')->group(function () { Route::get('a', A::class); });\n",
    "composer.json": JSON.stringify({ require: { "a/b": "^1" } }),
    "composer.lock": JSON.stringify({ packages: [{ name: "a/b", version: "1.0.0" }] }),
    ".github/workflows/ci.yml": "on: push\njobs: {}\n",
  });
  const changes = {
    ordinary: { "routes/web.php": "<?php\nRoute::get('a', A::class);\nRoute::get($x, B::class);\n", "database/migrations/1_a.php": M("Schema::create('t', function ($t) { $t->id(); });\nDB::statement('x');"), "composer.lock": JSON.stringify({ packages: [{ name: "a/b", version: "2.0.0" }] }), ".github/workflows/ci.yml": "on: [push, pull_request_target]\npermissions: write-all\njobs: {}\n" },
    empty: { "README.md": "x\n" },
    malformed: { "routes/web.php": "<?php\nRoute::get('a', function () {", "composer.lock": "{nope", ".github/workflows/ci.yml": "\ton: [\n---\n---\n", "database/migrations/2_b.php": "<?php {{{{" },
  };
  for (const [name, files] of Object.entries(changes)) {
    t.g("checkout", "-q", "-B", name, base);
    const head = t.commit(name, files);
    const r = analyseChange(t.dir, base, head, policy);
    assert.equal(r.evidence.length, require("../lib/study").EXTRACTORS.length, name);
    for (const e of r.evidence) assert.deepEqual(validateResult(e), [], `${name}/${e.extractor}`);
  }
});

test("an extractor that throws becomes UNKNOWN for that change, and escalates", () => {
  const { withExtractors, EXTRACTORS } = require("../lib/study");
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  const head = t.commit("x", { "a.txt": "b\n" });
  function extractBroken() {
    throw new Error("parser exploded\nwith a stack");
  }
  const r = withExtractors([...EXTRACTORS, extractBroken], () => analyseChange(t.dir, base, head, policy));
  const broken = r.evidence.find((e) => e.extractor === "broken");
  assert.deepEqual(validateResult(broken), []);
  assert.equal(broken.state, "UNKNOWN");
  assert.deepEqual(broken.unknown, ["extractor failed: parser exploded"]);
  assert.ok(r.risk.hits.some((h) => h.rule === "unknown:broken" && h.level !== "low"), "a failure must raise the priority");
});
