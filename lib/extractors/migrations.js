"use strict";

// Laravel migrations, read statically. For each migration a PR adds, it lists the schema
// operations in up(): tables created or dropped, columns added, dropped, renamed or
// retyped, indexes and foreign keys. Editing or deleting a migration that already
// existed is its own signal: on any database where it already ran, the edit does nothing.
// Raw SQL can't be read as schema, so it is UNKNOWN; data updates are reported as such.

const { show } = require("../git");
const { result, STATES } = require("../evidence");
const { stripComments, matching, splitArgs, literal, chainCalls, endOfString } = require("./php");

const COLUMN_TYPES = new Set([
  "bigIncrements", "bigInteger", "binary", "boolean", "char", "date", "dateTime", "dateTimeTz", "decimal", "double",
  "enum", "float", "foreignId", "foreignIdFor", "foreignUlid", "foreignUuid", "geometry", "id", "increments", "integer",
  "ipAddress", "json", "jsonb", "longText", "macAddress", "mediumIncrements", "mediumInteger", "mediumText", "morphs",
  "nullableMorphs", "nullableUuidMorphs", "nullableUlidMorphs", "rememberToken", "set", "smallIncrements", "smallInteger",
  "softDeletes", "softDeletesTz", "string", "text", "time", "timeTz", "timestamp", "timestampTz", "timestamps",
  "timestampsTz", "nullableTimestamps", "tinyIncrements", "tinyInteger", "tinyText", "unsignedBigInteger",
  "unsignedInteger", "unsignedMediumInteger", "unsignedSmallInteger", "unsignedTinyInteger", "ulid", "ulidMorphs",
  "uuid", "uuidMorphs", "year", "vector",
]);
// Types that are nullable or defaulted by construction, so adding them to a populated table is safe.
const SAFE_BY_TYPE = new Set(["timestamps", "timestampsTz", "nullableTimestamps", "softDeletes", "softDeletesTz", "rememberToken", "nullableMorphs", "nullableUuidMorphs", "nullableUlidMorphs", "id", "increments", "bigIncrements"]);
const DROPS = new Set(["dropColumn", "dropColumns", "dropTimestamps", "dropTimestampsTz", "dropSoftDeletes", "dropSoftDeletesTz", "dropRememberToken", "dropMorphs", "dropConstrainedForeignId", "dropConstrainedForeignIdFor"]);
const INDEX_DROPS = new Set(["dropIndex", "dropUnique", "dropPrimary", "dropForeign", "dropFullText", "dropSpatialIndex"]);
const INDEX_ADDS = new Set(["index", "unique", "primary", "foreign", "fullText", "spatialIndex"]);

// PHP method names are case-insensitive: $table->datetime() is $table->dateTime().
const CANON = new Map(
  [...COLUMN_TYPES, ...DROPS, ...INDEX_DROPS, ...INDEX_ADDS, "change", "nullable", "default", "renameColumn", "rename", "unique", "index", "constrained", "useCurrent", "useCurrentOnUpdate", "storedAs", "virtualAs", "generatedAs", "autoIncrement", "engine", "charset", "collation", "comment", "temporary"].map((n) => [n.toLowerCase(), n]),
);
const canon = (n) => CANON.get(n.toLowerCase()) || n;

function isMigration(path) {
  return /^(?:(?:app\/)?Modules\/[^/]+\/)?[Dd]atabase\/[Mm]igrations\/.+\.php$/.test(path);
}

// Split a block into top-level statements on `;`.
function statements(code) {
  const out = [];
  let cur = "";
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "'" || c === '"') {
      const j = endOfString(code, i);
      cur += code.slice(i, j);
      i = j - 1;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      const j = matching(code, i);
      if (j === -1) break;
      cur += code.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push({ text: cur.trim(), at: start });
      cur = "";
      start = i + 1;
    } else cur += c;
  }
  if (cur.trim()) out.push({ text: cur.trim(), at: start });
  return out;
}

// Body of `function up(...)` (or the whole file if there's no up()).
function upBody(code) {
  const m = /function\s+up\s*\([^)]*\)\s*(?::\s*\??\w+\s*)?\{/.exec(code);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  const close = matching(code, open);
  return close === -1 ? null : code.slice(open + 1, close);
}

// Closure body inside the last argument of Schema::create/table.
function closureBody(argText) {
  const brace = argText.indexOf("{");
  if (brace === -1) return null;
  const close = matching(argText, brace);
  return close === -1 ? null : argText.slice(brace + 1, close);
}

// Analyse one migration file's source. Returns { ops: [], unknown: [] }.
function parseMigration(source, file) {
  const code = stripComments(source);
  const ops = [];
  const unknown = [];
  const body = upBody(code);
  if (body === null) {
    unknown.push(`${file}: no readable up() method`);
    return { ops, unknown };
  }

  function blueprint(table, existing, text, conditional) {
    for (const st of statements(text)) {
      const m = /^\$\w+\s*->\s*/.exec(st.text);
      if (!m) {
        if (/^(if|foreach|for|while)\b/.test(st.text)) {
          const inner = closureBody(st.text);
          if (inner !== null) blueprint(table, existing, inner, true);
          else unknown.push(`${file}: conditional block on ${table} not readable`);
        } else if (/\bDB::/.test(st.text)) unknown.push(`${file}: raw SQL inside the ${table} blueprint`);
        continue;
      }
      const calls = chainCalls(st.text.slice(m[0].length)).map((c) => ({ ...c, name: canon(c.name) }));
      if (!calls.length) continue;
      const [first, ...mods] = calls;
      const names = mods.map((c) => c.name);
      const col = literal(first.args[0]);
      const cond = conditional ? { conditional: true } : {};
      if (COLUMN_TYPES.has(first.name)) {
        const key = `${table}.${col ?? first.name}`;
        if (names.includes("change")) {
          ops.push({ op: "column_changed", key, detail: `${first.name}${names.includes("nullable") ? ", nullable" : ""}`, risk: "column_type_change", ...cond });
        } else {
          const nullable = names.includes("nullable") || names.some((n) => /^(default|useCurrent|useCurrentOnUpdate|storedAs|virtualAs|generatedAs|autoIncrement)$/.test(n)) || SAFE_BY_TYPE.has(first.name);
          ops.push({
            op: existing ? "column_added" : "column_defined",
            key,
            detail: first.name + (nullable ? "" : " NOT NULL"),
            ...(existing && !nullable ? { risk: "not_null_without_default" } : {}),
            ...cond,
          });
          if (names.some((n) => n === "unique" || n === "index" || n === "constrained")) ops.push({ op: "index_added", key, ...(existing ? { risk: "index_change_existing_table" } : {}), ...cond });
        }
      } else if (DROPS.has(first.name)) {
        const cols = first.name === "dropColumn" || first.name === "dropColumns" ? listCols(first.args) : [first.name.replace(/^drop/, "")];
        for (const c of cols) ops.push({ op: "column_dropped", key: `${table}.${c}`, risk: "destructive", ...cond });
      } else if (first.name === "renameColumn") {
        ops.push({ op: "column_renamed", key: `${table}.${col}`, detail: `→ ${literal(first.args[1])}`, risk: "rename", ...cond });
      } else if (INDEX_DROPS.has(first.name)) {
        ops.push({ op: "index_dropped", key: `${table}.${first.argsText.trim().slice(0, 60)}`, ...(existing ? { risk: "index_change_existing_table" } : {}), ...cond });
      } else if (INDEX_ADDS.has(first.name)) {
        ops.push({ op: "index_added", key: `${table}.${first.argsText.trim().slice(0, 60)}`, ...(existing ? { risk: "index_change_existing_table" } : {}), ...cond });
      } else if (first.name === "rename") {
        ops.push({ op: "table_renamed", key: table, detail: `→ ${literal(first.args[0])}`, risk: "rename", ...cond });
      } else if (!["engine", "charset", "collation", "comment", "temporary"].includes(first.name)) {
        unknown.push(`${file}: $table->${first.name}() on ${table} not understood`);
      }
    }
  }

  function listCols(args) {
    const out = [];
    for (const a of args) {
      const t = a.trim();
      if (t.startsWith("[")) out.push(...splitArgs(t.slice(1, -1)).map((x) => literal(x) ?? "?"));
      else out.push(literal(t) ?? "?");
    }
    return out;
  }

  function walk(text, conditional) {
    for (const st of statements(text)) {
      const t = st.text;
      const schema = /^Schema\s*::\s*(?:connection\s*\([^)]*\)\s*->\s*)?(\w+)\s*\(/.exec(t);
      if (schema) {
        const open = schema.index + schema[0].length - 1;
        const close = matching(t, open);
        const args = splitArgs(t.slice(open + 1, close));
        const table = literal(args[0]);
        const cond = conditional ? { conditional: true } : {};
        const verb = { create: "create", table: "table", drop: "drop", dropifexists: "dropIfExists", rename: "rename" }[schema[1].toLowerCase()] || schema[1];
        if (table === null && !["disableForeignKeyConstraints", "enableForeignKeyConstraints", "withoutForeignKeyConstraints"].includes(verb)) {
          unknown.push(`${file}: Schema::${verb}() on a non-literal table`);
          continue;
        }
        if (verb === "create") {
          ops.push({ op: "table_created", key: table, ...cond });
          blueprint(table, false, closureBody(args[1] || "") || "", conditional);
        } else if (verb === "table") {
          blueprint(table, true, closureBody(args[1] || "") || "", conditional);
        } else if (verb === "drop" || verb === "dropIfExists") {
          ops.push({ op: "table_dropped", key: table, risk: "destructive", ...cond });
        } else if (verb === "rename") {
          ops.push({ op: "table_renamed", key: table, detail: `→ ${literal(args[1])}`, risk: "rename", ...cond });
        } else if (/^(has|get)/.test(verb)) {
          // a read, usually inside an if condition
        } else if (verb === "withoutForeignKeyConstraints") {
          walk(closureBody(args[0] || "") || "", conditional);
        } else if (!/ForeignKeyConstraints$/.test(verb)) {
          unknown.push(`${file}: Schema::${verb}() not understood`);
        }
        continue;
      }
      if (/^(if|foreach|for|while)\b/.test(t) || /^else\b/.test(t)) {
        const inner = closureBody(t);
        if (inner !== null) walk(inner, true);
        continue;
      }
      if (/^DB\s*::\s*table\b|^[A-Z]\w*\s*::\s*(all|query|where|each|chunk\w*|update|insert|create|findOrCreate|firstOrCreate|updateOrCreate)\b/.test(t)) {
        ops.push({ op: "data_migration", key: (/(?:table\s*\(\s*)(['"][^'"]+['"])/.exec(t) || [, "?"])[1].replace(/['"]/g, ""), risk: "data_migration", ...(conditional ? { conditional: true } : {}) });
        continue;
      }
      if (/\bDB\s*::\s*(statement|unprepared|raw|select)\b/.test(t)) {
        unknown.push(`${file}: raw SQL (${t.replace(/\s+/g, " ").slice(0, 60)})`);
        continue;
      }
      if (/^(return|continue|break)\b|^\$\w+\s*=/.test(t)) continue;
      unknown.push(`${file}: statement not understood (${t.replace(/\s+/g, " ").slice(0, 60)})`);
    }
  }

  walk(body, false);
  return { ops, unknown };
}

function extractMigrations(ctx) {
  const { cwd, base, head, changed } = ctx;
  const touched = changed.filter((f) => isMigration(f.path) || (f.from && isMigration(f.from)));
  if (!touched.length) return result("migrations", { state: STATES.PASS, note: "no migrations changed" });
  const observed = [];
  const unknown = [];
  let inspected = 0;
  for (const f of touched) {
    if (f.status === "A" || (f.status === "R" && !isMigration(f.from))) {
      const src = show(cwd, head, f.path);
      if (src === null) continue;
      inspected++;
      const r = parseMigration(src, f.path);
      for (const op of r.ops) observed.push({ ...op, file: f.path });
      unknown.push(...r.unknown);
    } else if (f.status === "D") {
      observed.push({ op: "migration_deleted", key: f.path, risk: "migration_edited" });
    } else if (f.status === "R") {
      observed.push({ op: "migration_renamed", key: f.path, detail: `from ${f.from}`, risk: "migration_edited" });
    } else {
      // Modified: compare up() operations; any change to an already-shipped migration is a signal.
      inspected++;
      const before = show(cwd, base, f.path);
      const after = show(cwd, head, f.path);
      const a = before === null ? { ops: [] } : parseMigration(before, f.path);
      const b = after === null ? { ops: [], unknown: [] } : parseMigration(after, f.path);
      const sig = (o) => `${o.op} ${o.key} ${o.detail || ""}`;
      const sameUp = JSON.stringify(a.ops.map(sig)) === JSON.stringify(b.ops.map(sig));
      observed.push({ op: "migration_edited", key: f.path, detail: sameUp ? "up() operations unchanged" : "up() operations changed", risk: sameUp ? undefined : "migration_edited" });
      unknown.push(...(b.unknown || []));
    }
  }
  return result("migrations", { observed, unknown, inspected });
}

module.exports = { extractMigrations, parseMigration, isMigration };
