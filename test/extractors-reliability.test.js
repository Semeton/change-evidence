"use strict";
// Extractor reliability: the new workflow, dependency, migration and route evidence,
// plus malformed and adversarial input for every extractor. Each extractor must either
// establish a fact, or say it couldn't (UNKNOWN); never throw, never invent.
const test = require("node:test");
const assert = require("node:assert");
const { changedFiles } = require("../lib/git");
const { extractWorkflows, permissionsIn, triggersIn } = require("../lib/extractors/workflows");
const { extractDependencies } = require("../lib/extractors/dependencies");
const { extractMigrations, parseMigration } = require("../lib/extractors/migrations");
const { extractRoutes, parseRoutes } = require("../lib/extractors/routes");
const { analyseChange } = require("../lib/study");
const { compile } = require("../lib/risk");
const { builtin } = require("../lib/policy");
const { repo } = require("./helpers");

const ctxOf = (t, base, head) => ({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
const byOp = (r) => {
  const out = {};
  for (const o of r.observed) (out[o.op] = out[o.op] || []).push(o);
  return out;
};
const SHA = "a".repeat(40);

// --- workflows ---------------------------------------------------------------------------

test("workflows: a permissions or trigger change reads differently from an Action bump", () => {
  const t = repo();
  const base = t.commit("init", { ".github/workflows/ci.yml": `on: [push]\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA}\n      - run: npm test\n` });
  const head = t.commit("x", {
    ".github/workflows/ci.yml": `on:\n  push:\n  pull_request_target:\npermissions:\n  contents: write\n  pull-requests: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${SHA}\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n      - run: echo "\${{ github.event.pull_request.title }}" && npm test\n        env:\n          TOKEN: \${{ secrets.NPM_TOKEN }}\n          GH: \${{ secrets.GITHUB_TOKEN }}\n      - uses: acme/shared/.github/workflows/release.yml@v2\n      - uses: ./.github/actions/setup\n      - run: npm publish\n`,
  });
  const r = extractWorkflows(ctxOf(t, base, head));
  const o = byOp(r);
  assert.equal(o.trigger_added[0].key, ".github/workflows/ci.yml: on pull_request_target");
  assert.equal(o.trigger_added[0].risk, "privileged_trigger_added");
  assert.equal(o.permissions_changed[0].risk, "permissions_widened");
  assert.match(o.permissions_changed[0].detail, /workflow contents=write/);
  assert.deepEqual(o.secrets_referenced.map((x) => x.detail), ["NPM_TOKEN"], "GITHUB_TOKEN isn't a new secret");
  assert.equal(o.untrusted_expression_in_shell[0].line, 14);
  assert.equal(o.privileged_pr_checkout[0].risk, "privileged_pr_checkout");
  assert.match(o.action_added.find((x) => /shared/.test(x.key)).detail, /reusable workflow, v2/);
  assert.equal(o.local_action_referenced.length, 1);
  assert.equal(o.workflow_changed[0].risk, "release_workflow_changed");

  // A SHA-pinned bump on its own: no permissions, trigger, secret or shell evidence.
  const t2 = repo();
  const b2 = t2.commit("init", { ".github/workflows/ci.yml": `on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${SHA}\n` });
  const h2 = t2.commit("bump", { ".github/workflows/ci.yml": `on: push\njobs:\n  t:\n    runs-on: x\n    steps:\n      - uses: actions/checkout@${"b".repeat(40)}\n` });
  assert.deepEqual(extractWorkflows(ctxOf(t2, b2, h2)).observed.map((x) => [x.op, x.risk]), [["action_ref_changed", undefined]]);
});

test("workflows: fact readers handle inline, block and job-level forms", () => {
  assert.deepEqual([...triggersIn("on: push\n")], ["push"]);
  assert.deepEqual([...triggersIn("on: [push, 'pull_request']\n")].sort(), ["pull_request", "push"]);
  assert.deepEqual([...triggersIn("on:\n  workflow_run:\n    workflows: [x]\n  schedule:\n    - cron: '0 0 * * *'\n")].sort(), ["schedule", "workflow_run"]);
  assert.deepEqual([...permissionsIn("permissions: write-all\njobs:\n  a:\n    permissions:\n      id-token: write\n  b:\n    permissions: {}\n")].sort(), ["a id-token=write", "b none", "workflow write-all"]);
  // Removing explicit permissions falls back to the repository default: flagged.
  const t = repo();
  const base = t.commit("init", { ".github/workflows/a.yml": "on: push\npermissions:\n  contents: read\njobs: {}\n" });
  const head = t.commit("x", { ".github/workflows/a.yml": "on: push\njobs: {}\n" });
  assert.equal(byOp(extractWorkflows(ctxOf(t, base, head))).permissions_changed.some((x) => x.risk === "permissions_widened"), true);
});

// --- dependencies ------------------------------------------------------------------------

const clock = (pkgs) => JSON.stringify({ packages: pkgs.map(([name, version, extra]) => ({ name, version, ...(extra || {}) })) });

test("dependencies: vendored code edited without a lockfile change is flagged; an upgrade isn't", () => {
  const t = repo();
  const base = t.commit("init", { "composer.json": JSON.stringify({ require: { "acme/auth": "^1" } }), "composer.lock": clock([["acme/auth", "1.0.0"]]), "vendor/acme/auth/src/Guard.php": "<?php // v1\n", "vendor/composer/installed.json": "{}", "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.0.0" } } }), "node_modules/left-pad/index.js": "1\n" });
  const tampered = t.commit("patch vendor", { "vendor/acme/auth/src/Guard.php": "<?php return true;\n", "vendor/composer/installed.json": "{\"x\":1}", "node_modules/left-pad/index.js": "2\n" });
  const o = byOp(extractDependencies(ctxOf(t, base, tampered)));
  assert.deepEqual(o.vendored_code_changed.map((x) => x.key).sort(), ["composer:acme/auth", "npm:left-pad"]);
  assert.equal(o.vendored_code_changed[0].risk, "vendored_code_changed");
  const upgraded = t.commit("upgrade", { "composer.lock": clock([["acme/auth", "1.1.0"]]), "vendor/acme/auth/src/Guard.php": "<?php // v1.1\n" });
  assert.ok(!byOp(extractDependencies(ctxOf(t, tampered, upgraded))).vendored_code_changed, "a real upgrade is accounted for by the lockfile");
});

test("dependencies: source moves, overrides, replacements and manifest/lock gaps", () => {
  const t = repo();
  const base = t.commit("init", {
    "composer.json": JSON.stringify({ require: { php: "^8.3", "acme/a": "^1", "old/impl": "^1" } }),
    "composer.lock": clock([["acme/a", "1.0.0", { dist: { url: "https://repo.packagist.org/acme/a.zip", type: "zip" } }], ["old/impl", "1.0.0"]]),
    "package.json": JSON.stringify({ dependencies: { vite: "catalog:" }, overrides: {} }),
  });
  const head = t.commit("x", {
    "composer.json": JSON.stringify({ require: { php: "^8.3", "acme/a": "^1", "new/impl": "^1", "ghost/pkg": "^2" } }),
    "composer.lock": clock([["acme/a", "1.0.0", { source: { url: "git@evil.example:acme/a.git", type: "git" } }], ["new/impl", "1.0.0", { replace: { "old/impl": "self.version" } }]]),
    "package.json": JSON.stringify({ dependencies: { vite: "catalog:" }, overrides: { semver: "7.5.2" } }),
  });
  const r = extractDependencies(ctxOf(t, base, head));
  const o = byOp(r);
  assert.match(o.dependency_source_changed.find((x) => x.key === "composer:acme/a").detail, /registry:repo\.packagist\.org → git:evil\.example/);
  assert.match(o.package_replaced[0].detail, /now provided by new\/impl/);
  assert.equal(o.dependency_overrides_changed[0].risk, "dependency_overrides_changed");
  assert.equal(r.state, "UNKNOWN");
  assert.match(r.unknown.join("\n"), /composer\.json requires ghost\/pkg, not in composer\.lock/);
  assert.doesNotMatch(r.unknown.join("\n"), /php|vite/, "platform and catalog requirements aren't gaps");
});

test("dependencies: malformed lockfiles are UNKNOWN, never a crash", () => {
  const t = repo();
  const base = t.commit("init", { "composer.lock": clock([["a/b", "1.0.0"]]) });
  const head = t.commit("x", { "composer.lock": "{ this is not json" });
  const r = extractDependencies(ctxOf(t, base, head));
  assert.equal(r.state, "UNKNOWN");
  assert.match(r.unknown[0], /could not be read/);
});

// --- migrations --------------------------------------------------------------------------

const M = (up) => `<?php\nreturn new class extends Migration {\n  public function up(): void\n  {\n${up}\n  }\n};\n`;

test("migrations: cascades, dropped foreign keys, tightened nullability and categories", () => {
  const r = parseMigration(M(`
    Schema::table('invoices', function (Blueprint $table) {
      $table->foreignId('client_id')->constrained()->cascadeOnDelete();
      $table->foreign('matter_id')->references('id')->on('matters')->onDelete('cascade');
      $table->dropForeign(['owner_id']);
      $table->string('status')->change();
      $table->string('note')->nullable()->change();
      $table->dropColumn('legacy');
    });
  `), "m.php");
  const ops = r.ops.map((o) => `${o.op} ${o.key} ${o.risk || "-"} ${o.category}`);
  assert.ok(ops.includes("foreign_key_added invoices.client_id cascade_delete destructive"), ops.join("\n"));
  assert.ok(ops.some((o) => /^foreign_key_added invoices\.'matter_id' cascade_delete destructive$/.test(o)), ops.join("\n"));
  assert.ok(ops.some((o) => /^foreign_key_dropped .* foreign_key_dropped structural$/.test(o)));
  assert.ok(ops.includes("column_changed invoices.status nullability_tightened structural"));
  assert.ok(ops.includes("column_changed invoices.note column_type_change structural"));
  assert.ok(ops.includes("column_dropped invoices.legacy destructive destructive"));
});

test("migrations: malformed and hostile sources are UNKNOWN, never a crash", () => {
  for (const src of ["<?php\nreturn new class { public function up(): void { Schema::table('x', function ($t) { $t->string(", "not php at all", "<?php\n" + "{".repeat(5000), ""]) {
    const r = parseMigration(src, "m.php");
    assert.ok(Array.isArray(r.ops));
    assert.ok(r.unknown.length >= 1 || r.ops.length === 0);
  }
});

// --- routes ------------------------------------------------------------------------------

test("routes: remapping a middleware alias is reported, even with no route file changed", () => {
  const t = repo();
  const base = t.commit("init", { "bootstrap/app.php": "<?php\nreturn Application::configure()->withMiddleware(function (Middleware $middleware) {\n  $middleware->alias([\n    'auth' => Authenticate::class,\n    'tenant' => SetTenant::class,\n  ]);\n})->create();\n" });
  const head = t.commit("x", { "bootstrap/app.php": "<?php\nreturn Application::configure()->withMiddleware(function (Middleware $middleware) {\n  $middleware->alias([\n    'auth' => AllowEveryone::class,\n  ]);\n})->create();\n" });
  const o = byOp(extractRoutes(ctxOf(t, base, head)));
  assert.equal(o.middleware_alias_changed[0].key, "auth");
  assert.match(o.middleware_alias_changed[0].detail, /Authenticate → AllowEveryone: every route using 'auth'/);
  assert.equal(o.middleware_alias_removed[0].key, "tenant");
  assert.equal(o.middleware_alias_removed[0].risk, "middleware_alias_changed");
});

test("routes: registration outside routes/ is UNKNOWN with file and line", () => {
  const t = repo();
  const base = t.commit("init", { "app/Providers/AppServiceProvider.php": "<?php\nclass AppServiceProvider {\n  public function boot() {}\n}\n" });
  const head = t.commit("x", { "app/Providers/AppServiceProvider.php": "<?php\nclass AppServiceProvider {\n  public function boot() {\n    Route::get('backdoor', fn () => 'ok');\n  }\n}\n" });
  const r = extractRoutes(ctxOf(t, base, head));
  assert.equal(r.state, "UNKNOWN");
  assert.match(r.unknown[0], /^app\/Providers\/AppServiceProvider\.php:4: registers routes outside routes\//);
});

test("routes: malformed route files don't throw", () => {
  for (const src of ["<?php\nRoute::get('a', function () {", "<?php\nRoute::middleware(", "<?php\n" + ")".repeat(3000), "<?php\nRoute::group(['prefix' => $x], function () { Route::get('a', A::class); });\n"]) {
    const r = parseRoutes(src, "routes/web.php");
    assert.ok(r.routes instanceof Map);
  }
});

// --- adversarial performance -------------------------------------------------------------

test("pathological long lines don't stall any extractor or rule (regex blow-up guard)", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  const nasty = [
    "(".repeat(100000),
    `'${"\\\\'".repeat(50000)}`,
    `Route::get('${"a".repeat(100000)}`,
    `$table->string(${"'x',".repeat(30000)})`,
    `\${{ github.event.${"a.".repeat(40000)} }}`,
    "->whereRaw(" + " ".repeat(100000),
  ].join("\n");
  const head = t.commit("x", {
    "routes/web.php": `<?php\n${nasty}\n`,
    "database/migrations/1_x.php": M(nasty),
    ".github/workflows/x.yml": `on: push\njobs:\n  a:\n    steps:\n      - run: ${nasty.split("\n")[4]}\n`,
    "app/X.php": `<?php\n${nasty}\n`,
    "composer.lock": `{"packages":[${'{"name":"a/b","version":"1"},'.repeat(20000)}{"name":"c/d","version":"1"}]}`,
  });
  const started = Date.now();
  const r = analyseChange(t.dir, base, head, compile(builtin()));
  const ms = Date.now() - started;
  assert.ok(r.risk.tier);
  assert.ok(ms < 15000, `took ${ms} ms`);
});
