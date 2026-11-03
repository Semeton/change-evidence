"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseRoutes, extractRoutes } = require("../lib/extractors/routes");
const { changedFiles } = require("../lib/git");
const { repo } = require("./helpers");

const SRC = `<?php
use Illuminate\\Support\\Facades\\Route;
Route::prefix('api')->middleware('api')->group(static function (): void {
    Route::get('ping', static fn () => null);
    Route::middleware(['auth', AdminOnly::class])->group(function () {
        Route::post('users', [UserController::class, 'store'])->name('users.store');
        Route::apiResource('songs', SongController::class);
        Route::group(['prefix' => 'radio', 'middleware' => 'radio.enabled'], static function () {
            Route::get('stations', StationController::class);
        });
        if (config('x.enabled')) {
            Route::delete('cache', ClearCache::class);
        }
    });
    Route::post('ai', AiController::class)->middleware('throttle:10,1');
    Route::get($dynamic, Foo::class);
    Route::group([], base_path('routes/other.php'));
});
`;

test("parses nested groups, array groups, conditionals and trailing middleware", () => {
  const r = parseRoutes(SRC, "routes/api.php");
  const get = (k) => {
    const v = r.routes.get(k);
    if (!v) return v;
    const { file, ...rest } = v;
    assert.equal(file, "routes/api.php");
    return rest;
  };
  assert.deepEqual(get("GET /api/ping"), { action: "closure", middleware: ["api"] });
  assert.deepEqual(get("POST /api/users"), { action: "UserController@store", middleware: ["AdminOnly", "api", "auth"], name: "users.store" });
  assert.ok(get("APIRESOURCE /api/songs"));
  assert.deepEqual(get("GET /api/radio/stations").middleware, ["AdminOnly", "api", "auth", "radio.enabled"]);
  assert.equal(get("DELETE /api/cache").conditional, true);
  assert.deepEqual(get("POST /api/ai").middleware, ["api", "throttle:10,1"]);
  assert.equal(r.unknown.length, 2);
  assert.match(r.unknown.join("\n"), /non-literal URI/);
  assert.match(r.unknown.join("\n"), /routes loaded from routes\/other\.php, which could not be read/);
});

test("extractRoutes diffs routes and flags removed auth middleware", () => {
  const t = repo();
  const v1 = `<?php\nRoute::middleware('auth')->group(function () {\n  Route::get('a', A::class);\n  Route::get('b', B::class);\n});\n`;
  const base = t.commit("init", { "routes/web.php": v1, "app/x.php": "x" });
  const v2 = `<?php\nRoute::get('a', A::class);\nRoute::middleware('auth')->group(function () {\n  Route::get('c', C::class);\n});\n`;
  const head = t.commit("change", { "routes/web.php": v2 });
  const r = extractRoutes({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
  const by = Object.fromEntries(r.observed.map((o) => [o.op + " " + o.key, o]));
  assert.equal(r.state, "PASS");
  assert.equal(by["route_changed GET /a"].risk, "security_middleware_removed");
  assert.ok(by["route_added GET /c"]);
  assert.ok(by["route_removed GET /b"]);
  const none = extractRoutes({ cwd: t.dir, base, head: base, changed: [] });
  assert.match(none.note, /no route files changed/);
});

test("an unreadable middleware is recorded as <dynamic>, not UNKNOWN", () => {
  const r = parseRoutes(`<?php\nRoute::middleware(['auth', config('x')])->group(function () { Route::GET('a', A::class); });\n`, "routes/web.php");
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.routes.get("GET /a").middleware, ["<dynamic>", "auth"]);
});

test("a new route behind throttle alone is unauthenticated", () => {
  const t = repo();
  const base = t.commit("init", { "routes/web.php": "<?php\n" });
  const head = t.commit("x", { "routes/web.php": "<?php\nRoute::get('i/{token}', Show::class)->middleware('throttle:60,1');\nRoute::get('me', Me::class)->middleware('auth');\n" });
  const r = extractRoutes({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
  const risk = Object.fromEntries(r.observed.map((o) => [o.key, o.risk]));
  assert.equal(risk["GET /i/{token}"], "unauthenticated_route");
  assert.equal(risk["GET /me"], undefined);
});

test("included route files inherit the including group's middleware", () => {
  const files = {
    "routes/web.php": `<?php
Route::middleware('auth')->prefix('app')->group(function () {
    require __DIR__.'/modules/billing.php';
});
Route::middleware('api')->group(base_path('routes/hooks.php'));
require __DIR__.'/public.php';
`,
    "routes/modules/billing.php": "<?php\nRoute::get('invoices', Invoices::class);\n",
    "routes/hooks.php": "<?php\nRoute::post('stripe', Stripe::class);\n",
    "routes/public.php": "<?php\nRoute::get('i/{token}', Show::class);\n",
  };
  const included = new Set();
  const r = parseRoutes(files["routes/web.php"], "routes/web.php", { resolve: (f) => files[f] ?? null, included });
  assert.deepEqual(r.unknown, []);
  assert.deepEqual(r.routes.get("GET /app/invoices").middleware, ["auth"]);
  assert.equal(r.routes.get("GET /app/invoices").file, "routes/modules/billing.php");
  assert.deepEqual(r.routes.get("POST /stripe").middleware, ["api"]);
  assert.deepEqual(r.routes.get("GET /i/{token}").middleware, []);
  assert.deepEqual([...included].sort(), ["routes/hooks.php", "routes/modules/billing.php", "routes/public.php"]);
});

test("extractRoutes: an included file is judged in its including group, and module routes aren't called unauthenticated", () => {
  const t = repo();
  const web = "<?php\nRoute::middleware('auth')->group(function () {\n  require __DIR__.'/modules/billing.php';\n});\n";
  const base = t.commit("init", { "routes/web.php": web, "routes/modules/billing.php": "<?php\nRoute::get('a', A::class);\n" });
  const head = t.commit("x", {
    "routes/modules/billing.php": "<?php\nRoute::get('a', A::class);\nRoute::post('b', B::class);\n",
    "Modules/Blog/routes/web.php": "<?php\nRoute::get('posts', Posts::class);\n",
  });
  const r = extractRoutes({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
  const by = Object.fromEntries(r.observed.map((o) => [o.key, o]));
  assert.equal(by["POST /b"].risk, undefined, "inherits auth from web.php");
  assert.ok(!by["GET /a"], "unchanged route isn't reported");
  assert.equal(by["GET /posts"].risk, undefined);
  assert.match(by["GET /posts"].detail, /module provider/);
});
