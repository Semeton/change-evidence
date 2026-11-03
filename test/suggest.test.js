"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { suggest, nice } = require("../lib/suggest");
const { policyFor } = require("../lib/policy");
const { repo } = require("./helpers");

test("nice rounds up to two significant figures", () => {
  assert.equal(nice(1317), 1400);
  assert.equal(nice(812), 820);
  assert.equal(nice(37), 40);
});

test("suggest proposes size, uncovered folders, tenant scopes and payment code", () => {
  const t = repo();
  t.commit("init", {
    "app/Models/Scopes/TenantScope.php": "<?php\nclass TenantScope implements Scope {}\n",
    "app/Concerns/BelongsToTenant.php": "<?php\ntrait BelongsToTenant { static function boot() { static::addGlobalScope(new TenantScope); } }\n",
    "src/Billing/Policies/InvoicePolicy.php": "<?php\n",
    "app/Modules/Clients/Policies/ClientPolicy.php": "<?php\n",
    "app/Modules/Payments/Services/Charge.php": "<?php\n",
  });
  // 30 PRs of 1,000-ish lines: the default 800 would flag nearly all of them.
  for (let i = 1; i <= 30; i++) t.commit(`feat: change ${i} (#${i})`, { [`app/F${i}.php`]: "x\n".repeat(900 + i * 10) });
  const { policy } = policyFor(t.dir, "HEAD");
  const s = suggest(t.dir, policy, { budget: 0.2 });
  assert.ok(s.overlay.size.max_changed_lines > 1000);
  assert.ok(s.size.flagged_by_default > 0.9);
  const rules = Object.fromEntries(s.overlay.path_rules.map((r) => [r.id, r]));
  assert.ok(rules.policies.paths.includes("src/Billing/Policies/**"), "src/ layout isn't in the defaults");
  assert.ok(!rules.policies.paths.includes("app/Modules/Clients/Policies/**"), "app/Modules is covered by the defaults now");
  assert.equal(rules["global-scopes"].level, "high");
  assert.deepEqual(rules["global-scopes"].paths, ["app/Concerns/BelongsToTenant.php", "app/Models/Scopes/TenantScope.php"]);
  assert.equal(s.overlay.pattern_rules[0].id, "without-global-scope");
  assert.equal(s.overlay.pattern_rules[0].level, "high");
  assert.deepEqual(rules.money.paths, ["app/Modules/Payments/**", "src/Billing/**"]);
});

test("suggest has nothing to add for a small standard repository", () => {
  const t = repo();
  t.commit("init", { "app/Http/Middleware/A.php": "<?php\n", "app/Policies/P.php": "<?php\n" });
  const { policy } = policyFor(t.dir, "HEAD");
  const s = suggest(t.dir, policy);
  assert.equal(s.overlay, null);
  assert.match(s.notes.join("\n"), /only 0 merged PRs/);
});

test("size is tightened only when --budget is given", () => {
  const t = repo();
  t.commit("init", { "app/A.php": "<?php\n" });
  for (let i = 1; i <= 30; i++) t.commit(`fix: small ${i} (#${i})`, { [`app/F${i}.php`]: "x\n".repeat(i * 5) });
  const { policy } = policyFor(t.dir, "HEAD");
  const quiet = suggest(t.dir, policy, { budget: 0.2 });
  assert.equal(quiet.overlay, null);
  assert.match(quiet.notes.join("\n"), /within a 20% budget; no change suggested/);
  const asked = suggest(t.dir, policy, { budget: 0.2, budgetGiven: true });
  assert.ok(asked.overlay.size.max_changed_lines < 800);
});
