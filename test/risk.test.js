"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { assess, globRe } = require("../lib/risk");
const policy = require("../policies/laravel.json");

const change = (files, diff = {}, lines = { added: 10, removed: 0 }) => ({
  files: files.map((f) => (typeof f === "string" ? { status: "M", path: f } : f)),
  lines,
  diff: new Map(Object.entries(diff)),
});

test("globs", () => {
  assert.ok(globRe("app/Http/Middleware/**").test("app/Http/Middleware/Auth.php"));
  assert.ok(globRe("Dockerfile*").test("Dockerfile.prod"));
  assert.ok(!globRe("Dockerfile*").test("docker/Dockerfile"));
  assert.ok(globRe("vite.config.*").test("vite.config.ts"));
});

test("low by default; path, pattern, evidence, unknown and size rules escalate", () => {
  assert.equal(assess(policy, change(["app/Models/Song.php"]), []).tier, "low");
  assert.equal(assess(policy, change([".github/workflows/ci.yml"]), []).dimensions.trust_root, "high");
  const pat = assess(policy, change(["app/Models/Song.php"], { "app/Models/Song.php": { added: ["protected $guarded = [];"], removed: [] } }), []);
  assert.equal(pat.dimensions.security, "high");
  assert.ok(pat.hits.find((h) => h.rule === "mass-assignment-open").heuristic);
  const moved = assess(policy, change(["app/X.php"], { "app/X.php": { added: ["->whereRaw('a')"], removed: ["->whereRaw('a')"] } }), []);
  assert.equal(moved.tier, "low", "a pattern moved within a file is not new");
  const ev = [{ extractor: "migrations", state: "PASS", observed: [{ op: "column_dropped", key: "u.x", risk: "destructive" }], unknown: [] }];
  assert.equal(assess(policy, change(["database/migrations/x.php"]), ev).dimensions.data, "high");
  const unk = [{ extractor: "routes", state: "UNKNOWN", observed: [], unknown: ["?"] }];
  assert.equal(assess(policy, change(["routes/web.php"]), unk).tier, "medium");
  assert.equal(assess(policy, change(["a.php"], {}, { added: 900, removed: 0 }), []).tier, "medium");
  assert.equal(assess(policy, change([{ status: "D", path: "tests/Feature/AuthTest.php" }]), []).dimensions.trust_root, "medium");
});

test("a broken rule escalates instead of passing", () => {
  const bad = { ...policy, path_rules: [{ id: "boom", dimension: "security", level: "high", paths: ["x"] }] };
  const c = change(["x"]);
  Object.defineProperty(c.files, "filter", { value: () => { throw new Error("boom"); } });
  const r = assess({ ...bad, __compiled: undefined }, c, []);
  assert.equal(r.dimensions.security, "medium");
  assert.match(r.hits[0].unknown, /rule failed/);
});

test("bootstrap/app.php escalates only on middleware lines", () => {
  const edit = (added) => change(["bootstrap/app.php"], { "bootstrap/app.php": { added, removed: [] } });
  assert.equal(assess(policy, edit(["    ->withExceptions(function (Exceptions $e) {"]), []).tier, "low");
  assert.equal(assess(policy, edit(["        $middleware->validateCsrfTokens(except: ['hook/*']);"]), []).dimensions.security, "high");
});
