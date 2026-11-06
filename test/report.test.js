"use strict";
// Report semantics: observed impact vs review priority, low is never "safe", every
// finding traces to a file (and a line where there is one), generated files don't count
// toward size, `unless` is visible, and large PRs are scanned in full.
const test = require("node:test");
const assert = require("node:assert");
const { analyseChange } = require("../lib/study");
const { compile } = require("../lib/risk");
const { builtin, applyOverlay } = require("../lib/policy");
const { renderPr } = require("../lib/report");
const { attributeGlobs } = require("../lib/generated");
const { repo } = require("./helpers");

const render = (t, base, head, policy = builtin()) => {
  const p = compile(policy);
  const result = analyseChange(t.dir, base, head, p, { policyBase: base });
  return { result, md: renderPr({ result, base, head, policy, version: "0.0.0" }) };
};

test("low says plainly that it is not a finding of safety", () => {
  const t = repo();
  const base = t.commit("init", { "app/A.php": "<?php\n" });
  const head = t.commit("x", { "app/A.php": "<?php\n$a = 1;\n" });
  const { result, md } = render(t, base, head);
  assert.equal(result.risk.tier, "low");
  assert.match(md, /review priority: low/);
  assert.match(md, /Low is not a finding that the change is safe/);
  assert.equal(md.match(/\bsafe\b/g).length, 1, "the only mention of safety is the disclaimer");
  assert.match(md, /#### Uncertainty and coverage/);
  assert.match(md, /Not covered: routes registered by service providers/);
});

test("pattern hits trace to file:line and the matched text, labelled heuristic", () => {
  const t = repo();
  const base = t.commit("init", { "app/Models/M.php": "<?php\nclass M {\n}\n" });
  const head = t.commit("x", { "app/Models/M.php": "<?php\nclass M {\n  protected $guarded = [];\n}\n" });
  const { result, md } = render(t, base, head);
  const hit = result.risk.hits.find((h) => h.rule === "mass-assignment-open");
  assert.equal(hit.kind, "heuristic");
  assert.deepEqual(hit.locations, [{ file: "app/Models/M.php", line: 3, side: "+", text: "protected $guarded = [];" }]);
  assert.match(md, /`app\/Models\/M\.php:3` adds `protected \$guarded = \[\];`/);
  assert.match(md, /mass-assignment-open \*\(heuristic\)\*/);
  assert.deepEqual(result.risk.decided_by, ["security"]);
  assert.deepEqual(result.risk.contributors.security, ["mass-assignment-open"]);
  assert.match(md, /The priority is high because of Security \(`mass-assignment-open`\)/);
  assert.doesNotMatch(md, /vulnerab/i, "a heuristic is never called a vulnerability");
});

test("observed facts are labelled observed and summarised without inference", () => {
  const t = repo();
  const base = t.commit("init", { "routes/web.php": "<?php\nRoute::middleware('auth')->group(function () { Route::get('a', A::class); });\n" });
  const head = t.commit("x", { "routes/web.php": "<?php\nRoute::get('a', A::class);\nRoute::get('b', B::class);\n" });
  const { result, md } = render(t, base, head);
  const lost = result.risk.hits.find((h) => h.rule === "evidence:security_middleware_removed");
  assert.equal(lost.kind, "observed");
  const unauth = result.risk.hits.find((h) => h.rule === "evidence:unauthenticated_route");
  assert.equal(unauth.kind, "heuristic", "absence of auth middleware is an inference");
  assert.match(md, /\*\*Routes:\*\* 1 added \(1 with no auth middleware found\), 1 changed \(1 lost security middleware\)\./);
});

test("generated files don't count toward size; the base's .gitattributes decides, never the PR's", () => {
  const t = repo();
  const base = t.commit("init", { ".gitattributes": "resources/generated/** linguist-generated\n", "app/A.php": "<?php\n" });
  const big = "x\n".repeat(1000);
  const head = t.commit("x", {
    "public/build/assets/app.js": big, // default generated glob
    "resources/generated/api.ts": big, // the base's .gitattributes
    "app/Real.php": big, // the PR marks this generated in its own .gitattributes: ignored
    ".gitattributes": "resources/generated/** linguist-generated\napp/** linguist-generated\n",
  });
  const { result, md } = render(t, base, head);
  const gen = Object.fromEntries(result.files.map((f) => [f.path, f.generated || null]));
  assert.match(gen["public/build/assets/app.js"], /policy: public\/build/);
  assert.match(gen["resources/generated/api.ts"], /\.gitattributes/);
  assert.equal(gen["app/Real.php"], null, "the PR's own .gitattributes must not exempt its code");
  assert.equal(result.counted.added, 1000 + 1, "only app/Real.php and the .gitattributes line count");
  assert.ok(result.risk.hits.some((h) => h.rule === "size:lines"));
  assert.match(md, /2 generated or vendored files not counted toward size/);
  assert.deepEqual(attributeGlobs("*.min.js linguist-generated\n/dist/ linguist-vendored=true\nfoo -linguist-generated\n# c\n"), ["**/*.min.js", "dist", "dist/**"]);
});

test("generated files are still subject to path rules", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  const head = t.commit("x", { "vendor/acme/pkg/src/Auth.php": "<?php\n" });
  const policy = applyOverlay(builtin(), { path_rules: [{ id: "vendored-code", dimension: "security", level: "high", paths: ["vendor/**"] }] }, "test");
  const { result } = render(t, base, head, policy);
  assert.ok(result.files[0].generated);
  assert.equal(result.risk.dimensions.security, "high");
});

test("`unless` excuses matches visibly; it never hides them", () => {
  const t = repo();
  const base = t.commit("init", { "app/A.php": "<?php\n" });
  const head = t.commit("x", { "app/A.php": "<?php\n$a = M::withoutGlobalScopes()->where('tenant_id', $t)->get();\n$b = M::withoutGlobalScopes()->get();\n" });
  const policy = applyOverlay(builtin(), { pattern_rules: [{ id: "without-global-scope", dimension: "security", level: "high", paths: ["app/**"], added: "withoutGlobalScopes?\\s*\\(", unless: "tenant_id" }] }, "test");
  const { result, md } = render(t, base, head, policy);
  const hit = result.risk.hits.find((h) => h.rule === "without-global-scope");
  assert.equal(hit.count, 1);
  assert.equal(hit.excused, 1);
  assert.equal(hit.locations[0].line, 3);
  assert.match(md, /without-global-scope: 1 match excused by the rule's `unless`/);
  // All excused: the rule stays at low, but the excusal is still reported.
  const t2 = repo();
  const b2 = t2.commit("init", { "app/A.php": "<?php\n" });
  const h2 = t2.commit("x", { "app/A.php": "<?php\n$a = M::withoutGlobalScopes()->where('tenant_id', $t)->get();\n" });
  const r2 = render(t2, b2, h2, policy);
  assert.equal(r2.result.risk.tier, "low");
  assert.match(r2.md, /1 match excused by the rule's `unless`/);
});

test("a PR with more than 400 scoped files is scanned in full", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  const files = {};
  for (let i = 0; i < 450; i++) files[`app/F${String(i).padStart(3, "0")}.php`] = "<?php\n";
  files["app/zzz.php"] = "<?php\n$q->whereRaw('1');\n";
  const head = t.commit("x", files);
  const { result } = render(t, base, head);
  const hit = result.risk.hits.find((h) => h.rule === "raw-sql");
  assert.ok(hit, "the 451st file was not scanned");
  assert.equal(hit.locations[0].file, "app/zzz.php");
});

test("new tables are collapsed into one line", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  const head = t.commit("x", { "database/migrations/1_t.php": "<?php\nreturn new class { public function up(): void { Schema::create('t', function ($table) { $table->id(); $table->string('a'); $table->foreignId('b')->constrained(); $table->index('a'); }); } };\n" });
  const { md } = render(t, base, head);
  assert.match(md, /`table_created` `t` — 3 columns, 2 indexes/);
  assert.doesNotMatch(md, /column_defined/);
});
