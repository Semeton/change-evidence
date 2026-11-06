"use strict";
// Edge cases at the git and rendering boundaries: binary and large diffs, renames and
// deletions, unrelated histories, and the escaping limits of lib/markdown.js.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { analyseChange } = require("../lib/study");
const { compile } = require("../lib/risk");
const { builtin } = require("../lib/policy");
const md = require("../lib/markdown");
const { repo } = require("./helpers");

const BIN = path.join(__dirname, "..", "bin", "change-evidence.js");
const policy = compile(builtin());

test("binary files, renames and deletions are counted without breaking extraction", () => {
  const t = repo();
  const base = t.commit("init", { "routes/web.php": "<?php\nRoute::get('a', A::class);\n", "database/migrations/1_a.php": "<?php\nreturn new class { public function up(): void { Schema::create('a', function ($t) { $t->id(); }); } };\n", "old/name.php": "<?php\n" });
  t.write({ "public/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255, 0, 7]) });
  t.write({ "old/name.php": null, "new/name.php": "<?php\n", "routes/web.php": null, "database/migrations/1_a.php": null });
  const head = t.commit("change");
  const r = analyseChange(t.dir, base, head, policy);
  const byStatus = Object.fromEntries(r.files.map((f) => [f.path, f.status]));
  assert.equal(byStatus["public/logo.png"], "A");
  assert.equal(byStatus["new/name.php"], "R");
  assert.equal(byStatus["routes/web.php"], "D");
  const ev = Object.fromEntries(r.evidence.map((e) => [e.extractor, e]));
  assert.deepEqual(ev.routes.observed.map((o) => o.op + " " + o.key), ["route_removed GET /a"]);
  assert.equal(ev.migrations.observed[0].op, "migration_deleted");
  assert.equal(ev.migrations.observed[0].risk, "migration_edited");
  assert.equal(r.risk.dimensions.data, "high");
});

test("a large diff is analysed and the size rule escalates", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  const files = {};
  for (let i = 0; i < 120; i++) files[`app/F${i}.php`] = `<?php\n${"$x = 1;\n".repeat(200)}`;
  const head = t.commit("big", files);
  const r = analyseChange(t.dir, base, head, policy);
  assert.equal(r.files.length, 120);
  assert.ok(r.lines.added > 24000);
  assert.ok(r.risk.hits.some((h) => h.rule === "size:lines"));
  assert.ok(r.risk.hits.some((h) => h.rule === "size:files"));
});

test("pr refuses unrelated histories (no merge base) with exit 2", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  t.g("checkout", "-q", "--orphan", "other");
  t.g("rm", "-rqf", ".");
  const head = t.commit("unrelated", { "b.txt": "b\n" });
  const r = spawnSync(process.execPath, [BIN, "pr", t.dir, "--base", base, "--head", head, "--out", t.dir], { encoding: "utf8", env: { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no merge base/);
});

test("pr rejects a base or head that isn't a commit", () => {
  const t = repo();
  const base = t.commit("init", { "a.txt": "a\n" });
  for (const bad of ["--upload-pack=touch PWNED", "nope", "HEAD~99"]) {
    const r = spawnSync(process.execPath, [BIN, "pr", t.dir, "--base", base, "--head", bad, "--out", t.dir], { encoding: "utf8", env: { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" } });
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /not a commit/, bad);
  }
});

test("markdown: control characters, bidi overrides, fences and limits", () => {
  assert.equal(md.clean("a\nb\r\tc‮d"), "a�b��c�d");
  assert.equal(md.code("a`b"), "``a`b``");
  assert.equal(md.code("``x``"), "``` ``x`` ```");
  assert.equal(md.code("a|b", { table: true }), "`a\\|b`");
  assert.equal(md.code(""), "``");
  assert.equal(md.text("@user see https://x [y](z) *b* <i>"), `@${md.ZWSP}user see https:${md.ZWSP}//x \\[y\\](z) \\*b\\* &lt;i>`);
  assert.equal(md.clean("x".repeat(500)).length, 200);
  const body = md.finalizeComment(`a ${md.MARKER} b`);
  assert.equal(body.split(md.MARKER).length - 1, 1);
  assert.ok(body.trimEnd().endsWith(md.MARKER));
  const big = md.finalizeComment("x".repeat(100000));
  assert.ok(big.length < 61000);
  assert.match(big, /report truncated/);
});
