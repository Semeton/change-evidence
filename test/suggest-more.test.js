"use strict";
// suggest: web-server and deploy config, gates outside policy folders, aliases, and the
// existing-bypass note. Everything stays a proposal: suggest never writes without --write.
const test = require("node:test");
const assert = require("node:assert");
const { suggest } = require("../lib/suggest");
const { policyFor } = require("../lib/policy");
const { repo } = require("./helpers");

test("suggest proposes web-server, deploy and gate locations, and notes aliases and bypasses", () => {
  const t = repo();
  t.commit("init", {
    "public/.htaccess": "RewriteEngine On\n",
    "web.config": "<configuration/>\n",
    "Procfile": "web: php artisan serve\n",
    "k8s/deploy.yaml": "kind: Deployment\n",
    "app/Providers/TelescopeServiceProvider.php": "<?php\nGate::define('viewTelescope', fn () => true);\n",
    "app/Models/Scopes/TenantScope.php": "<?php\nclass TenantScope implements Scope {}\n",
    "app/Concerns/BelongsToTenant.php": "<?php\nstatic::addGlobalScope(new TenantScope);\n",
    "app/Http/Controllers/Portal.php": "<?php\nM::withoutGlobalScopes()->where('tenant_id', $t)->get();\nM::withoutGlobalScopes()->get();\n",
    "bootstrap/app.php": "<?php\n$middleware->alias([\n  'tenant' => \\App\\Http\\Middleware\\ResolveTenant::class,\n]);\n",
  });
  const { policy } = policyFor(t.dir, "HEAD");
  const s = suggest(t.dir, policy);
  const rules = Object.fromEntries(s.overlay.path_rules.map((r) => [r.id, r]));
  assert.deepEqual(rules["web-server-config"].paths, ["public/.htaccess", "web.config"]);
  assert.equal(rules["web-server-config"].dimension, "security");
  assert.deepEqual(rules["deploy-config"].paths, ["Procfile", "k8s/**"]);
  assert.ok(rules.policies.paths.includes("app/Providers/TelescopeServiceProvider.php"));
  const notes = s.notes.join("\n");
  assert.match(notes, /middleware aliases: tenant → ResolveTenant/);
  assert.match(notes, /bypasses global scopes on 2 lines, 1 of them re-applying tenant_id/);
  assert.match(notes, /none is proposed here/);
  assert.ok(!s.overlay.pattern_rules.some((r) => r.unless), "suggest never proposes an exception to the tenant boundary");
  // Deterministic: the same repository gives the same proposal.
  assert.deepEqual(suggest(t.dir, policy).overlay, s.overlay);
});
