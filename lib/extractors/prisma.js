"use strict";

// Prisma migrations (prisma/migrations/<name>/migration.sql), read as SQL text.
//
// For each added migration, every statement is classified with the same operation names
// and risks as the Laravel extractor, so policies treat both alike:
//   CREATE/DROP TABLE, ADD/DROP COLUMN (NOT NULL without DEFAULT on an existing table),
//   ALTER COLUMN TYPE (column_type_change), SET NOT NULL (nullability_tightened),
//   RENAME, indexes (on existing tables), foreign keys (ON DELETE CASCADE, dropped),
//   enum types, INSERT/UPDATE/DELETE (data_migration), TRUNCATE (destructive).
// SQLite's table rebuild (PRAGMA foreign_keys=OFF; CREATE new_X; INSERT…SELECT;
// DROP X; ALTER new_X RENAME TO X) is reported as one `table_rebuilt`, not as a drop.
// Editing, renaming or deleting a migration that already existed is `migration_edited`:
// on any database where it already ran, the edit does nothing.
// `schema.prisma` changing with no new migration is UNKNOWN: the database change isn't
// recorded (db push, or a migration still to come).
//
// Statements it can't classify (functions, DO blocks, triggers, extensions, grants) are
// UNKNOWN, named. It doesn't establish whether a migration is safe, how long it locks,
// or anything database-specific beyond the statement's text.

const { show } = require("../git");
const { result, STATES } = require("../evidence");

const isPrismaMigration = (p) => /(^|\/)prisma\/migrations\/[^/]+\/[^/]+\.sql$/.test(p);
const isSchema = (p) => /(^|\/)schema\.prisma$/.test(p) || /(^|\/)prisma\/schema\/[^/]+\.prisma$/.test(p);

// Remove comments, keeping string literals and dollar-quoted bodies intact.
function stripSqlComments(sql) {
  let out = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? sql.length : end + tag[0].length;
        out += sql.slice(i, stop);
        i = stop;
      } else {
        out += c;
        i++;
      }
    } else if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Split on top-level semicolons (outside quotes, dollar-quoted bodies and parentheses).
function statements(sql) {
  const s = stripSqlComments(sql);
  const out = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < s.length && !(s[j] === c && s[j + 1] !== c)) j += s[j] === c ? 2 : 1;
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "$") {
      const tag = /^\$[A-Za-z_]*\$/.exec(s.slice(i, i + 64));
      if (tag) {
        const end = s.indexOf(tag[0], i + tag[0].length);
        const stop = end === -1 ? s.length : end + tag[0].length;
        cur += s.slice(i, stop);
        i = stop - 1;
        continue;
      }
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (c === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// "public"."User" / `User` / [User] / User → User
function ident(raw) {
  const parts = String(raw || "").trim().split(".");
  return parts[parts.length - 1].replace(/^["`[]|["`\]]$/g, "");
}
const IDENT = `(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)(?:\\.(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*))?`;

// Split ALTER TABLE actions on top-level commas.
function actions(text) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const c of text) {
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function cascade(text) {
  if (/ON\s+DELETE\s+CASCADE/i.test(text)) return "ON DELETE CASCADE";
  if (/ON\s+DELETE\s+SET\s+NULL/i.test(text)) return "ON DELETE SET NULL";
  return null;
}

// Classify one migration's SQL. Returns { ops, unknown }.
function parseSql(sql, file) {
  const ops = [];
  const unknown = [];
  const stmts = statements(sql);
  const created = new Set();
  const renamedTo = new Map(); // final name -> temporary name
  const dropped = new Set();
  for (const st of stmts) {
    let m;
    if ((m = new RegExp(`^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(st))) created.add(ident(m[1]));
    if ((m = new RegExp(`^ALTER\\s+TABLE\\s+(${IDENT})\\s+RENAME\\s+TO\\s+(${IDENT})`, "i").exec(st))) renamedTo.set(ident(m[2]), ident(m[1]));
    if ((m = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(st))) dropped.add(ident(m[1]));
  }
  const rebuilt = new Set([...dropped].filter((t) => renamedTo.has(t) && created.has(renamedTo.get(t))));
  const temps = new Set([...rebuilt].map((t) => renamedTo.get(t)));
  const push = (o) => ops.push({ file, ...o });

  for (const st of stmts) {
    const one = st.replace(/\s+/g, " ");
    let m;
    if (/^(PRAGMA|BEGIN|COMMIT|SET\s|START TRANSACTION)/i.test(one)) continue;
    if ((m = new RegExp(`^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(one))) {
      const t = ident(m[1]);
      if (temps.has(t)) continue;
      push({ op: "table_created", key: t, category: "structural" });
      for (const fk of one.matchAll(/FOREIGN\s+KEY[^,]*?REFERENCES[^,]*/gi)) if (cascade(fk[0])) push({ op: "foreign_key_added", key: t, detail: cascade(fk[0]), risk: "cascade_delete", category: "destructive" });
      continue;
    }
    if ((m = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(one))) {
      const t = ident(m[1]);
      if (rebuilt.has(t)) push({ op: "table_rebuilt", key: t, detail: "copied into a new table, then swapped in (SQLite)", risk: "data_migration", category: "data" });
      else push({ op: "table_dropped", key: t, risk: "destructive", category: "destructive" });
      continue;
    }
    if ((m = new RegExp(`^ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})\\s+([\\s\\S]+)$`, "i").exec(one))) {
      const t = ident(m[1]);
      if (temps.has(t)) continue;
      const existing = !created.has(t);
      for (const a of actions(m[2])) {
        let x;
        if ((x = new RegExp(`^ADD\\s+(?:COLUMN\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(${IDENT})\\s+(.+)$`, "i").exec(a)) && !/^ADD\s+(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK|INDEX|KEY)\b/i.test(a)) {
          const notNull = /\bNOT\s+NULL\b/i.test(x[2]) && !/\bDEFAULT\b/i.test(x[2]) && !/\bGENERATED\b/i.test(x[2]);
          push({ op: existing ? "column_added" : "column_defined", key: `${t}.${ident(x[1])}`, detail: x[2].slice(0, 60), ...(existing && notNull ? { risk: "not_null_without_default" } : {}), category: "structural" });
          if (/REFERENCES/i.test(x[2]) && cascade(x[2])) push({ op: "foreign_key_added", key: `${t}.${ident(x[1])}`, detail: cascade(x[2]), risk: "cascade_delete", category: "destructive" });
        } else if ((x = new RegExp(`^DROP\\s+(?:COLUMN\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(a)) && !/^DROP\s+(CONSTRAINT|INDEX|PRIMARY|FOREIGN|KEY|CHECK|DEFAULT)\b/i.test(a)) {
          push({ op: "column_dropped", key: `${t}.${ident(x[1])}`, risk: "destructive", category: "destructive" });
        } else if ((x = new RegExp(`^(?:ALTER|MODIFY)\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(?:SET\\s+DATA\\s+)?TYPE\\s+(.+)$`, "i").exec(a)) || (x = new RegExp(`^MODIFY\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(.+)$`, "i").exec(a))) {
          push({ op: "column_changed", key: `${t}.${ident(x[1])}`, detail: `type → ${x[2].slice(0, 40)}`, risk: "column_type_change", category: "structural" });
        } else if ((x = new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+SET\\s+NOT\\s+NULL`, "i").exec(a))) {
          push({ op: "column_changed", key: `${t}.${ident(x[1])}`, detail: "SET NOT NULL", risk: "nullability_tightened", category: "structural" });
        } else if ((x = new RegExp(`^ALTER\\s+(?:COLUMN\\s+)?(${IDENT})\\s+(DROP\\s+NOT\\s+NULL|SET\\s+DEFAULT.*|DROP\\s+DEFAULT)`, "i").exec(a))) {
          push({ op: "column_changed", key: `${t}.${ident(x[1])}`, detail: x[2].slice(0, 40), category: "structural" });
        } else if ((x = new RegExp(`^RENAME\\s+(?:COLUMN\\s+)?(${IDENT})\\s+TO\\s+(${IDENT})`, "i").exec(a))) {
          push({ op: "column_renamed", key: `${t}.${ident(x[1])}`, detail: `→ ${ident(x[2])}`, risk: "rename", category: "structural" });
        } else if ((x = new RegExp(`^RENAME\\s+TO\\s+(${IDENT})`, "i").exec(a))) {
          push({ op: "table_renamed", key: t, detail: `→ ${ident(x[1])}`, risk: "rename", category: "structural" });
        } else if (/^ADD\s+(?:CONSTRAINT\s+\S+\s+)?FOREIGN\s+KEY/i.test(a)) {
          const c = cascade(a);
          push({ op: "foreign_key_added", key: t, detail: c || a.slice(0, 60), ...(c ? { risk: "cascade_delete", category: "destructive" } : { ...(existing ? { risk: "index_change_existing_table" } : {}), category: "structural" }) });
        } else if ((x = /^DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?(\S+)/i.exec(a))) {
          const name = ident(x[1]);
          push(/fkey$|_fk$|^fk_/i.test(name) ? { op: "foreign_key_dropped", key: `${t}.${name}`, risk: "foreign_key_dropped", category: "structural" } : { op: "index_dropped", key: `${t}.${name}`, ...(existing ? { risk: "index_change_existing_table" } : {}), category: "structural" });
        } else if (/^ADD\s+(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK)/i.test(a)) {
          push({ op: "index_added", key: t, detail: a.slice(0, 60), ...(existing ? { risk: "index_change_existing_table" } : {}), category: "structural" });
        } else {
          unknown.push(`${file}: ALTER TABLE ${t} action not understood (${a.slice(0, 60)})`);
        }
      }
      continue;
    }
    if ((m = new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${IDENT}\\s+)?ON\\s+(${IDENT})`, "i").exec(one))) {
      const t = ident(m[1]);
      if (temps.has(t)) continue;
      push({ op: "index_added", key: t, detail: one.slice(0, 60), ...(!created.has(t) && !rebuilt.has(t) ? { risk: "index_change_existing_table" } : {}), category: "structural" });
      continue;
    }
    if ((m = new RegExp(`^DROP\\s+INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(one))) {
      push({ op: "index_dropped", key: ident(m[1]), risk: "index_change_existing_table", category: "structural" });
      continue;
    }
    if ((m = new RegExp(`^CREATE\\s+TYPE\\s+(${IDENT})`, "i").exec(one))) {
      push({ op: "type_created", key: ident(m[1]), category: "structural" });
      continue;
    }
    if ((m = new RegExp(`^ALTER\\s+TYPE\\s+(${IDENT})\\s+(ADD\\s+VALUE|RENAME\\s+(?:VALUE|TO))`, "i").exec(one))) {
      push({ op: "type_changed", key: ident(m[1]), detail: m[2].toUpperCase(), ...(/RENAME/i.test(m[2]) ? { risk: "rename" } : {}), category: "structural" });
      continue;
    }
    if ((m = new RegExp(`^DROP\\s+TYPE\\s+(?:IF\\s+EXISTS\\s+)?(${IDENT})`, "i").exec(one))) {
      push({ op: "type_dropped", key: ident(m[1]), risk: "destructive", category: "destructive" });
      continue;
    }
    if ((m = new RegExp(`^TRUNCATE\\s+(?:TABLE\\s+)?(${IDENT})`, "i").exec(one))) {
      push({ op: "table_truncated", key: ident(m[1]), risk: "destructive", category: "destructive" });
      continue;
    }
    if ((m = new RegExp(`^(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(${IDENT})`, "i").exec(one))) {
      const t = ident(m[2]);
      if (temps.has(t)) continue; // the copy step of a SQLite rebuild
      push({ op: "data_migration", key: t, detail: m[1].toUpperCase(), risk: "data_migration", category: "data" });
      continue;
    }
    unknown.push(`${file}: statement not understood (${one.slice(0, 60)})`);
  }
  return { ops, unknown };
}

// Model/field lines of a schema, ignoring comments and blank lines.
const schemaBody = (t) => String(t || "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean).join("\n");

function extractPrisma(ctx) {
  const { cwd, base, head, changed } = ctx;
  const migrations = changed.filter((f) => isPrismaMigration(f.path) || (f.from && isPrismaMigration(f.from)));
  const schemas = changed.filter((f) => isSchema(f.path));
  if (!migrations.length && !schemas.length) return result("prisma", { state: STATES.PASS, note: "no Prisma migrations or schema changed" });
  const observed = [];
  const unknown = [];
  let inspected = 0;
  for (const f of migrations) {
    if (f.status === "A" || (f.status === "R" && !isPrismaMigration(f.from || ""))) {
      const sql = show(cwd, head, f.path);
      if (sql === null) continue;
      inspected++;
      const r = parseSql(sql, f.path);
      observed.push(...r.ops);
      unknown.push(...r.unknown);
    } else {
      observed.push({ op: f.status === "D" ? "migration_deleted" : f.status === "R" ? "migration_renamed" : "migration_edited", key: f.path, file: f.path, ...(f.from && f.from !== f.path ? { detail: `from ${f.from}` } : {}), risk: "migration_edited", category: f.status === "D" ? "destructive" : "structural" });
    }
  }
  const addedMigration = migrations.some((f) => f.status === "A");
  for (const f of schemas) {
    const before = schemaBody(show(cwd, base, f.path));
    const after = schemaBody(show(cwd, head, f.path));
    if (before !== after && !addedMigration && /^\s*(model|enum|type|view)\b/m.test(after + before)) {
      const hasMigrationsDir = changed.length >= 0 && (require("../git").git(cwd, ["ls-tree", "-d", "--name-only", head, "--", f.path.replace(/schema\.prisma$|schema\/[^/]+\.prisma$/, "") + "migrations"], { allowFail: true }) || "").trim();
      if (hasMigrationsDir) unknown.push(`${f.path} changed but no migration was added: the database change isn't recorded here (db push, or a migration still to come)`);
    }
  }
  return result("prisma", { observed, unknown, inspected, ecosystem: "prisma" });
}

module.exports = { extractPrisma, parseSql, statements, isPrismaMigration, isSchema };
