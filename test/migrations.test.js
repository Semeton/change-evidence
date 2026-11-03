"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { parseMigration, extractMigrations } = require("../lib/extractors/migrations");
const { changedFiles } = require("../lib/git");
const { repo } = require("./helpers");

const M = (up) => `<?php\nreturn new class extends Migration {\n  public function up(): void\n  {\n${up}\n  }\n  public function down(): void { Schema::dropIfExists('ignored'); }\n};\n`;

test("classifies schema operations in up() only", () => {
  const r = parseMigration(M(`
    Schema::create('posts', function (Blueprint $table) { $table->id(); $table->string('title'); $table->timestamps(); });
    Schema::table('users', function (Blueprint $table) {
      $table->string('nick')->nullable();
      $table->integer('score');
      $table->string('bio')->nullable()->change();
      $table->dropColumn(['old', 'older']);
      $table->renameColumn('a', 'b');
      $table->index('nick');
    });
    Schema::dropIfExists('legacy');
    DB::table('users')->update(['score' => 0]);
    DB::statement('ALTER TABLE x');
  `), "m.php");
  const ops = r.ops.map((o) => `${o.op} ${o.key}${o.risk ? " !" + o.risk : ""}`);
  assert.ok(ops.includes("table_created posts"));
  assert.ok(ops.includes("column_defined posts.title"));
  assert.ok(ops.includes("column_added users.nick"));
  assert.ok(ops.includes("column_added users.score !not_null_without_default"));
  assert.ok(ops.includes("column_changed users.bio !column_type_change"));
  assert.ok(ops.includes("column_dropped users.old !destructive"));
  assert.ok(ops.includes("column_dropped users.older !destructive"));
  assert.ok(ops.includes("column_renamed users.a !rename"));
  assert.ok(ops.includes("table_dropped legacy !destructive"));
  assert.ok(ops.includes("data_migration users !data_migration"));
  assert.ok(!ops.some((o) => o.includes("ignored")), "down() is not analysed");
  assert.deepEqual(r.unknown.length, 1);
  assert.match(r.unknown[0], /raw SQL/);
});

test("editing a shipped migration is a signal", () => {
  const t = repo();
  const base = t.commit("init", { "database/migrations/1_a.php": M("Schema::create('a', function ($t) { $t->id(); });") });
  const head = t.commit("edit", {
    "database/migrations/1_a.php": M("Schema::create('a', function ($t) { $t->id(); $t->string('x'); });"),
    "database/migrations/2_b.php": M("Schema::table('a', function ($t) { $t->dropColumn('x'); });"),
  });
  const r = extractMigrations({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
  const risks = r.observed.map((o) => o.risk).filter(Boolean).sort();
  assert.deepEqual(risks, ["destructive", "migration_edited"]);
});
