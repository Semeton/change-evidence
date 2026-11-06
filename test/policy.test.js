"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { policyFor } = require("../lib/policy");
const { analyseChange } = require("../lib/study");
const { compile } = require("../lib/risk");
const { renderPr } = require("../lib/report");
const { repo } = require("./helpers");

const overlay = {
  name: "acme",
  size: { max_changed_lines: 5000 },
  path_rules: [{ id: "policies", dimension: "security", level: "high", paths: ["app/Modules/*/Policies/**"] }],
  disable: ["raw-sql"],
};

test("the overlay comes from the base commit, merges by id, and is itself trust root", () => {
  const t = repo();
  const base = t.commit("init", { ".change-evidence.json": JSON.stringify(overlay), "app/x.php": "<?php\n" });
  // The PR tries to loosen its own policy and touches a module policy.
  const head = t.commit("pr", {
    ".change-evidence.json": JSON.stringify({ ...overlay, path_rules: [], disable: ["policies", "ci"] }),
    "app/Modules/Billing/Policies/InvoicePolicy.php": "<?php\n",
    "app/x.php": "<?php\nDB::raw('1');\n",
  });
  const { policy, error } = policyFor(t.dir, base);
  assert.equal(error, undefined);
  assert.equal(policy.name, "laravel-default+acme");
  assert.equal(policy.size.max_changed_lines, 5000);
  assert.ok(!policy.pattern_rules.some((r) => r.id === "raw-sql"));
  const r = analyseChange(t.dir, base, head, compile(policy));
  const rules = new Set(r.risk.hits.map((h) => h.rule));
  assert.ok(rules.has("policies"), "base overlay's module-policy rule applies, not the PR's");
  assert.ok(rules.has("policy-overlay"), "editing the overlay is trust root");
  assert.equal(r.risk.dimensions.trust_root, "high");
  assert.ok(!rules.has("raw-sql"));
});

test("an invalid overlay falls back to the built-in policy and says so", () => {
  const t = repo();
  const base = t.commit("init", { ".change-evidence.json": "{ nope" });
  const { policy, error } = policyFor(t.dir, base);
  assert.match(error, /not valid JSON/);
  assert.equal(policy.name, "laravel-default");
});

test("the PR report leads with rules and lists structural changes", () => {
  const t = repo();
  const base = t.commit("init", { "routes/web.php": "<?php\nRoute::middleware('auth')->group(function () { Route::get('a', A::class); });\n" });
  const head = t.commit("pr", { "routes/web.php": "<?php\nRoute::get('a', A::class);\n" });
  const { policy } = policyFor(t.dir, base);
  const result = analyseChange(t.dir, base, head, compile(policy));
  const md = renderPr({ result, base, head, policy, version: "0.0.0" });
  assert.match(md, /^### 🔴 Change evidence · review priority: high/);
  assert.match(md, /because of Security \(`evidence:security_middleware_removed`\)/);
  assert.match(md, /#### Where to look/);
  assert.match(md, /#### Observed impact/);
  assert.match(md, /\*\*Routes:\*\* 1 changed \(1 lost security middleware\)/);
  assert.match(md, /#### Uncertainty and coverage/);
  assert.match(md, /How the priority was decided/);
  assert.match(md, /security_middleware_removed/);
  assert.match(md, /✏️ `GET \/a` — middleware removed: auth/);
  assert.match(md, /shadow mode: reports only, never blocks/);
});
