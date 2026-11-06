"use strict";
// #3: Next.js / Prisma repositories get their own policy (detected, or chosen with
// "extends"), and Prisma migrations are read as SQL.
const test = require("node:test");
const assert = require("node:assert");
const { parseSql, statements, extractPrisma } = require("../lib/extractors/prisma");
const { detectEcosystem, policyFor } = require("../lib/policy");
const { analyseChange } = require("../lib/study");
const { compile } = require("../lib/risk");
const { renderPr } = require("../lib/report");
const { changedFiles } = require("../lib/git");
const { repo } = require("./helpers");

const ops = (sql) => parseSql(sql, "m.sql").ops.map((o) => `${o.op} ${o.key}${o.risk ? ` !${o.risk}` : ""}`);

test("prisma: Prisma-generated PostgreSQL is classified with Laravel's operation names", () => {
  const r = parseSql(`-- AlterTable
ALTER TABLE "User" ADD COLUMN "plan" TEXT NOT NULL,
ADD COLUMN "nickname" TEXT,
ADD COLUMN "credits" INTEGER NOT NULL DEFAULT 0;
-- AlterTable
ALTER TABLE "Scan" ALTER COLUMN "score" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "target" SET NOT NULL,
DROP COLUMN "legacy";
-- CreateTable
CREATE TABLE "ApiKey" ("id" TEXT NOT NULL, "userId" TEXT NOT NULL, CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id"));
-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_userId_key" ON "ApiKey"("userId");
CREATE INDEX "Scan_target_idx" ON "Scan"("target");
-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Scan" DROP CONSTRAINT "Scan_ownerId_fkey";
-- RenameColumn
ALTER TABLE "User" RENAME COLUMN "name" TO "fullName";
UPDATE "User" SET "plan" = 'free';
DROP TABLE "OldThing";
CREATE TYPE "Role" AS ENUM ('ADMIN', 'USER');
ALTER TYPE "Role" ADD VALUE 'OWNER';
`, "m.sql");
  const o = r.ops.map((x) => `${x.op} ${x.key}${x.risk ? ` !${x.risk}` : ""} ${x.category}`);
  for (const want of [
    "column_added User.plan !not_null_without_default structural",
    "column_added User.nickname structural",
    "column_added User.credits structural",
    "column_changed Scan.score !column_type_change structural",
    "column_changed Scan.target !nullability_tightened structural",
    "column_dropped Scan.legacy !destructive destructive",
    "table_created ApiKey structural",
    "index_added ApiKey structural",
    "index_added Scan !index_change_existing_table structural",
    "foreign_key_added ApiKey !cascade_delete destructive",
    "foreign_key_dropped Scan.Scan_ownerId_fkey !foreign_key_dropped structural",
    "column_renamed User.name !rename structural",
    "data_migration User !data_migration data",
    "table_dropped OldThing !destructive destructive",
    "type_created Role structural",
    "type_changed Role structural",
  ]) assert.ok(o.includes(want), `missing: ${want}\n${o.join("\n")}`);
  assert.deepEqual(r.unknown, []);
});

test("prisma: SQLite's table rebuild is one table_rebuilt, not a drop", () => {
  const o = ops(`PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Scan" ("id" TEXT NOT NULL PRIMARY KEY, "score" REAL);
INSERT INTO "new_Scan" ("id", "score") SELECT "id", "score" FROM "Scan";
DROP TABLE "Scan";
ALTER TABLE "new_Scan" RENAME TO "Scan";
CREATE INDEX "Scan_score_idx" ON "Scan"("score");
PRAGMA foreign_keys=ON;`);
  assert.deepEqual(o, ["table_rebuilt Scan !data_migration", "index_added Scan"]);
});

test("prisma: statements split correctly around strings, comments and dollar quoting; unknown SQL is named", () => {
  assert.deepEqual(statements("SELECT ';' -- a;b\n; CREATE FUNCTION f() RETURNS void AS $$ BEGIN PERFORM 1; END; $$ LANGUAGE plpgsql; /* x; */ SELECT 2;").map((s) => s.slice(0, 15)), ["SELECT ';'", "CREATE FUNCTION", "SELECT 2"]);
  const r = parseSql('CREATE EXTENSION IF NOT EXISTS "pgcrypto"; DO $$ BEGIN RAISE NOTICE \'x;y\'; END $$;', "m.sql");
  assert.equal(r.unknown.length, 2);
  assert.match(r.unknown[0], /statement not understood \(CREATE EXTENSION/);
  for (const bad of ["", ";;;", "ALTER TABLE", "(((((", "'unterminated", "$$ never closed"]) assert.ok(Array.isArray(parseSql(bad, "m.sql").ops));
});

test("prisma: edited shipped migrations and schema changes without a migration", () => {
  const t = repo();
  const base = t.commit("init", { "prisma/schema.prisma": "model User {\n  id String @id\n}\n", "prisma/migrations/0_init/migration.sql": 'CREATE TABLE "User" ("id" TEXT NOT NULL);\n' });
  const edited = t.commit("edit", { "prisma/migrations/0_init/migration.sql": 'CREATE TABLE "User" ("id" TEXT NOT NULL, "x" TEXT);\n' });
  let r = extractPrisma({ cwd: t.dir, base, head: edited, changed: changedFiles(t.dir, base, edited) });
  assert.deepEqual(r.observed.map((o) => [o.op, o.risk]), [["migration_edited", "migration_edited"]]);
  const pushed = t.commit("schema only", { "prisma/schema.prisma": "model User {\n  id String @id\n  email String\n}\n" });
  r = extractPrisma({ cwd: t.dir, base: edited, head: pushed, changed: changedFiles(t.dir, edited, pushed) });
  assert.equal(r.state, "UNKNOWN");
  assert.match(r.unknown[0], /schema\.prisma changed but no migration was added/);
  const comment = t.commit("comment only", { "prisma/schema.prisma": "// a note\nmodel User {\n  id String @id\n  email String\n}\n" });
  assert.equal(extractPrisma({ cwd: t.dir, base: pushed, head: comment, changed: changedFiles(t.dir, pushed, comment) }).state, "PASS", "comments alone aren't a schema change");
});

test("policy selection: detected, overridden by extends, and reported", () => {
  const laravel = repo();
  laravel.commit("init", { artisan: "#!/usr/bin/env php\n", "composer.json": "{}" });
  assert.equal(detectEcosystem(laravel.dir, "HEAD").name, "laravel");
  const next = repo();
  next.commit("init", { "apps/web/next.config.mjs": "export default {}\n", "packages/db/prisma/schema.prisma": "model A { id Int @id }\n", "package.json": "{}" });
  const d = detectEcosystem(next.dir, "HEAD");
  assert.equal(d.name, "node-next");
  assert.match(d.how, /apps\/web\/next\.config\.mjs/);
  const both = repo();
  both.commit("init", { artisan: "x", "composer.json": "{}", "package.json": JSON.stringify({ dependencies: { next: "15" } }) });
  assert.match(detectEcosystem(both.dir, "HEAD").how, /set "extends"/);
  const none = repo();
  none.commit("init", { "main.go": "package main\n" });
  assert.match(detectEcosystem(none.dir, "HEAD").how, /no supported ecosystem detected/);
  // extends wins over detection; an unknown name falls back to detection and says why.
  laravel.commit("extends", { ".change-evidence.json": JSON.stringify({ extends: "node-next" }) });
  let p = policyFor(laravel.dir, "HEAD");
  assert.equal(p.policy.name, "node-next-default+repo");
  assert.match(p.policy.selected.how, /extends/);
  laravel.commit("bad extends", { ".change-evidence.json": JSON.stringify({ extends: "rails" }) });
  p = policyFor(laravel.dir, "HEAD");
  assert.match(p.error, /no built-in policy "rails"/);
  assert.equal(p.policy.selected.name, "laravel");
});

test("node-next: the issue #3 cases are no longer low, and the report says why", () => {
  const t = repo();
  const base = t.commit("init", { "next.config.js": "module.exports = {}\n", "package.json": JSON.stringify({ dependencies: { next: "15" } }), "src/middleware.ts": "export function middleware() {}\n", "src/pages/api/auth/me.ts": "export default function h() {}\n", "src/utils/crypto.ts": "export const a = 1;\n", "prisma/schema.prisma": "model User { id String @id }\n", "prisma/seed.ts": "await create({ password: 'x' })\n", "src/app/page.tsx": "export default function P() { return null }\n" });
  const cases = {
    middleware: [{ "src/middleware.ts": "import { jwtVerify } from 'jose';\nexport function middleware() { return jwtVerify(t, k); }\n" }, "next-middleware"],
    authApi: [{ "src/pages/api/auth/me.ts": "export default function h() { return 1 }\n" }, "auth-config"],
    crypto: [{ "src/utils/crypto.ts": "export const a = 2;\n" }, "auth-sensitive-names"],
    schema: [{ "prisma/schema.prisma": "model User { id String @id\n email String }\n" }, "prisma-schema"],
    seed: [{ "prisma/seed.ts": "await create({ password: process.env.SEED_PASSWORD })\n" }, "seed-data"],
    rawSql: [{ "src/app/page.tsx": "await prisma.$queryRawUnsafe(`SELECT * FROM x WHERE id = ${id}`)\n" }, "raw-sql-unsafe"],
    publicSecret: [{ "src/app/page.tsx": "const k = process.env.NEXT_PUBLIC_STRIPE_SECRET_KEY\n" }, "public-secret"],
  };
  for (const [name, [files, rule]] of Object.entries(cases)) {
    t.g("checkout", "-q", "-B", name, base);
    const head = t.commit(name, files);
    const { policy } = policyFor(t.dir, base);
    const result = analyseChange(t.dir, base, head, compile(policy), { policyBase: base });
    assert.notEqual(result.risk.tier, "low", `${name} scored low`);
    assert.ok(result.risk.hits.some((h) => h.rule === rule), `${name}: ${rule} didn't fire`);
    const md = renderPr({ result, base, head, policy, version: "0" });
    assert.match(md, /node-next-default v1 \(detected \(next\.config\.js/);
  }
});
