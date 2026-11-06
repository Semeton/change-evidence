"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { assess, globRe } = require("../lib/risk");
const policy = require("../policies/laravel.json");

const change = (files, diff = {}, lines = { added: 10, removed: 0 }) => ({
  files: files.map((f) => (typeof f === "string" ? { status: "M", path: f } : f)),
  lines,
  // Diff lines as the engine receives them: { n, text }, numbered from 1.
  diff: new Map(Object.entries(diff).map(([f, d]) => [f, { added: (d.added || []).map((text, i) => ({ n: i + 1, text })), removed: (d.removed || []).map((text, i) => ({ n: i + 1, text })) }])),
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
  const r = assess(bad, c, []);
  assert.equal(r.dimensions.security, "medium");
  assert.match(r.hits[0].unknown, /rule failed/);
});

test("bootstrap/app.php escalates only on middleware lines", () => {
  const edit = (added) => change(["bootstrap/app.php"], { "bootstrap/app.php": { added, removed: [] } });
  assert.equal(assess(policy, edit(["    ->withExceptions(function (Exceptions $e) {"]), []).tier, "low");
  assert.equal(assess(policy, edit(["        $middleware->validateCsrfTokens(except: ['hook/*']);"]), []).dimensions.security, "high");
});

test("path rules can be limited by file status: an edited shipped file, whatever its language (#7)", () => {
  const p = { ...policy, path_rules: [...policy.path_rules, { id: "sql-migration-edited", dimension: "data", level: "high", paths: ["prisma/migrations/**/migration.sql"], status: ["M", "R", "D"] }] };
  const added = assess(p, change([{ status: "A", path: "prisma/migrations/2_x/migration.sql" }]), []);
  assert.ok(!added.hits.some((h) => h.rule === "sql-migration-edited"), "a new migration isn't an edit");
  const edited = assess(p, change([{ status: "M", path: "prisma/migrations/1_init/migration.sql" }]), []);
  assert.equal(edited.dimensions.data, "high");
  const renamed = assess(p, change([{ status: "R", path: "prisma/migrations/1b/migration.sql", from: "prisma/migrations/1_init/migration.sql" }]), []);
  assert.ok(renamed.hits.some((h) => h.rule === "sql-migration-edited"));
  // A malformed status makes the rule fail loudly (escalates as unknown), never silently pass.
  const bad = { ...p, path_rules: [{ id: "bad", dimension: "data", level: "high", paths: ["x"], status: ["modified"] }] };
  const r = assess(bad, change(["x"]), []);
  assert.equal(r.hits[0].kind, "unknown");
  assert.match(r.hits[0].unknown, /status must be a list/);
});

test("a spread copy of an assessed policy is evaluated with its own rules, not a stale cache", () => {
  const base = JSON.parse(JSON.stringify(policy));
  assess(base, change(["x.txt"]), []);
  const extended = { ...base, path_rules: [...base.path_rules, { id: "x-rule", dimension: "security", level: "high", paths: ["x.txt"] }] };
  assert.equal(assess(extended, change(["x.txt"]), []).dimensions.security, "high");
});
