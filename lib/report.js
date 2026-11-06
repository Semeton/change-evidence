"use strict";

// The PR report. It keeps two things apart:
//
//   Observed impact   what the evaluator read from the diff: routes added, middleware
//                     removed, a column retyped, an Action re-pinned. Facts, with where.
//   Review priority   the policy's recommendation (low / medium / high), derived from
//                     the observed impact, rule severity, size and uncertainty.
//
// Low means no rule raised the change above low. It is not evidence that the change is
// safe, and the report says so. Heuristic findings are labelled as such and never
// described as confirmed problems. Every PR-controlled string goes through lib/markdown.

const { code, text } = require("./markdown");

const ICON = { low: "🟢", medium: "🟡", high: "🔴" };
const DIM = { security: "Security", data: "Data integrity", structural: "Structure and dependencies", operational: "Operations", trust_root: "CI and supply chain" };
const KIND = { observed: "observed", heuristic: "heuristic", unknown: "unknown", size: "size" };
const ORDER = { high: 0, medium: 1, low: 2 };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function details(lines, title, items, { open = items.length <= 12, max = 60 } = {}) {
  if (!items.length) return;
  lines.push(`<details${open ? " open" : ""}><summary><b>${title}</b> (${items.length})</summary>`, "");
  for (const i of items.slice(0, max)) lines.push(`- ${i}`);
  if (items.length > max) lines.push(`- … ${items.length - max} more in the JSON artifact`);
  lines.push("", "</details>", "");
}

// file:line for a location, or the file alone. `table`: the string goes in a table cell,
// so pipes are escaped once, here, and nowhere else.
const at = (file, line, table) => code(line ? `${file}:${line}` : file, { table });

// One line per place a hit points at, for "Where to look" and the rule tables.
function hitPlaces(h, { table = false } = {}) {
  const c = (s) => code(s, { table });
  if (h.locations && h.locations.length) return h.locations.map((l) => `${at(l.file, l.line, table)} ${l.side === "-" ? "removes" : "adds"} ${c(l.text)}`);
  if (h.key) return [c(h.key)];
  if (h.files && h.files.length) return h.files.map((f) => c(f));
  if (h.unknown) return (Array.isArray(h.unknown) ? h.unknown : [h.unknown]).map((u) => text(u, { max: 240, table }));
  if (h.detail) return [text(h.detail, { table })];
  return [];
}

// Collapse a new table's column and index definitions into one line.
function schemaItems(ops) {
  const created = new Map();
  for (const o of ops) if (o.op === "table_created") created.set(`${o.file}\u0000${o.key}`, { o, columns: 0, indexes: 0 });
  const items = [];
  for (const o of ops) {
    const table = String(o.key).split(".")[0];
    const c = created.get(`${o.file}\u0000${table}`);
    if (c && (o.op === "column_defined" || (o.op === "index_added" && !o.risk))) {
      if (o.op === "column_defined") c.columns++;
      else c.indexes++;
      continue;
    }
    if (o.op === "table_created") continue;
    items.push(`\`${o.op}\` ${code(o.key)}${o.detail ? ` — ${text(o.detail)}` : ""}${o.conditional ? " (conditional)" : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`);
  }
  const tables = [...created.values()].map(({ o, columns, indexes }) => `\`table_created\` ${code(o.key)} — ${plural(columns, "column")}, ${plural(indexes, "index", "indexes")}${o.conditional ? " (conditional)" : ""}`);
  return [...tables, ...items];
}

// The executive summary: counts of what was observed, nothing inferred.
function observedSummary(ev, files, counted) {
  const out = [];
  const obs = (x) => (ev[x] ? ev[x].observed : []);
  const n = (list, pred) => list.filter(pred).length;
  const r = obs("routes");
  if (r.length) {
    const parts = [];
    const added = n(r, (o) => o.op === "route_added");
    if (added) parts.push(`${added} added${n(r, (o) => o.risk === "unauthenticated_route") ? ` (${n(r, (o) => o.risk === "unauthenticated_route")} with no auth middleware found)` : ""}`);
    if (n(r, (o) => o.op === "route_removed")) parts.push(`${n(r, (o) => o.op === "route_removed")} removed`);
    const changed = n(r, (o) => o.op === "route_changed");
    if (changed) parts.push(`${changed} changed${n(r, (o) => o.risk === "security_middleware_removed") ? ` (${n(r, (o) => o.risk === "security_middleware_removed")} lost security middleware)` : ""}`);
    out.push(`**Routes:** ${parts.join(", ")}.`);
  }
  const m = [...obs("migrations"), ...obs("prisma")];
  if (m.length) {
    const parts = [];
    const add = (one, many, pred) => {
      const k = n(m, pred);
      if (k) parts.push(`${k} ${k === 1 ? one : many}`);
    };
    add("table created", "tables created", (o) => o.op === "table_created");
    add("table dropped", "tables dropped", (o) => o.op === "table_dropped");
    add("table rebuilt", "tables rebuilt", (o) => o.op === "table_rebuilt");
    add("column added to an existing table", "columns added to existing tables", (o) => o.op === "column_added");
    add("of them NOT NULL without a default", "of them NOT NULL without a default", (o) => o.risk === "not_null_without_default");
    add("column dropped", "columns dropped", (o) => o.op === "column_dropped");
    add("column retyped", "columns retyped", (o) => o.op === "column_changed");
    add("rename", "renames", (o) => o.op === "column_renamed" || o.op === "table_renamed");
    add("index change on an existing table", "index changes on existing tables", (o) => o.risk === "index_change_existing_table");
    add("data migration", "data migrations", (o) => o.op === "data_migration");
    add("shipped migration edited, renamed or deleted", "shipped migrations edited, renamed or deleted", (o) => o.risk === "migration_edited");
    if (parts.length) out.push(`**Schema:** ${parts.join(", ")}.`);
  }
  const d = obs("dependencies");
  if (d.length) {
    const parts = [];
    const add = (label, pred) => {
      const k = n(d, pred);
      if (k) parts.push(`${k} ${label}`);
    };
    add("direct dependency added", (o) => o.op === "dependency_added");
    add("removed", (o) => o.op === "dependency_removed");
    add("upgraded", (o) => o.op === "dependency_upgraded");
    add("of them major", (o) => o.risk === "major_upgrade");
    add("downgraded", (o) => o.op === "dependency_downgraded");
    add("with install scripts", (o) => o.op === "install_script");
    const t = d.find((o) => o.op === "transitive_changes");
    if (t) parts.push(`transitive: ${text(t.detail)}`);
    if (parts.length) out.push(`**Dependencies:** ${parts.join(", ")}.`);
  }
  const w = obs("workflows");
  if (w.length) {
    const refs = n(w, (o) => o.op === "action_ref_changed" || o.op === "action_added");
    const unpinned = n(w, (o) => o.risk === "unpinned_action");
    const changed = n(w, (o) => o.op === "workflow_changed");
    const parts = [];
    if (refs) parts.push(`${plural(refs, "Action reference")} added or moved${unpinned ? ` (${unpinned} not pinned to a SHA)` : ""}`);
    if (changed) parts.push(`${plural(changed, "workflow")} changed beyond \`uses:\` lines`);
    if (parts.length) out.push(`**CI:** ${parts.join(", ")}.`);
  }
  const gen = files.length - counted.files;
  out.push(`**Size:** ${plural(files.length, "file")}, +${counted.added} −${counted.removed} counted${gen ? `; ${plural(gen, "generated or vendored file")} not counted toward size` : ""}.`);
  return out;
}

function renderPr({ result, base, head, policy, version, mode = "shadow", policyError }) {
  const { risk, evidence, files } = result;
  const counted = result.counted || { ...result.lines, files: files.length };
  const ev = Object.fromEntries(evidence.map((e) => [e.extractor, e]));
  const hits = risk.hits.filter((h) => h.level !== "low");
  const out = [];

  // --- Review priority -----------------------------------------------------------------
  out.push(`### ${ICON[risk.tier] || ""} Change evidence · review priority: ${risk.tier}`, "");
  const notChecked = evidence.filter((e) => e.state === "NOT_APPLICABLE");
  if (risk.tier === "low") {
    out.push("No rule raised this change above low. **Low is not a finding that the change is safe**: it means none of the evidence below crossed an escalation threshold. The evaluator only sees what its extractors and rules cover; see *Uncertainty and coverage*.", "");
    if (notChecked.length) out.push(`**Not checked here:** ${notChecked.map((e) => text(e.extractor)).join(", ")}: this repository has nothing ${notChecked.length === 1 ? "that extractor reads" : "those extractors read"} (policy ${text(policy.name)}).`, "");
  } else {
    const decided = (risk.decided_by || []).map((d) => `${DIM[d]} (${(risk.contributors[d] || []).map((r) => code(r)).join(", ")})`);
    out.push(`A human should review this change. The priority is ${risk.tier} because of ${decided.join("; ")}.`, "");
  }
  if (policyError) out.push(`> ⚠️ ${text(policyError)}. The built-in policy was used.`, "");

  // --- Where to look -------------------------------------------------------------------
  const attention = [];
  for (const h of [...hits].sort((a, b) => ORDER[a.level] - ORDER[b.level] || (a.kind === "unknown") - (b.kind === "unknown"))) {
    if (h.kind === "size") continue;
    const places = hitPlaces(h);
    if (!places.length) continue;
    attention.push(`${ICON[h.level]} ${text(h.rule)} *(${KIND[h.kind] || h.kind})*: ${places.slice(0, 3).join("; ")}${places.length > 3 ? `; +${places.length - 3} more` : ""}`);
  }
  if (attention.length) {
    out.push("#### Where to look", "");
    attention.slice(0, 8).forEach((a, i) => out.push(`${i + 1}. ${a}`));
    if (attention.length > 8) out.push(`\n…and ${attention.length - 8} more below.`);
    out.push("");
  }

  // --- Observed impact -----------------------------------------------------------------
  out.push("#### Observed impact", "");
  for (const s of observedSummary(ev, files, counted)) out.push(`- ${s}`);
  out.push("");

  // Per-dimension evidence: rule hits, then the extractor items that belong there.
  const ruleRows = (dims) => {
    const rows = hits.filter((h) => dims.includes(h.dimension)).sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    if (!rows.length) return [];
    const t = ["| Level | Rule | Kind | Where |", "|---|---|---|---|"];
    for (const h of rows) {
      const places = hitPlaces(h, { table: true });
      t.push(`| ${ICON[h.level]} ${h.level} | ${text(h.rule, { table: true })} | ${KIND[h.kind] || h.kind} | ${places.slice(0, 4).join("<br>") + (places.length > 4 ? ` +${places.length - 4}` : "")} |`);
    }
    return [...t, ""];
  };
  const route = (o) => `${o.op === "route_added" ? "➕" : o.op === "route_removed" ? "➖" : "✏️"} ${code(o.key)}${o.detail ? ` — ${text(o.detail)}` : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`;
  const item = (o) => `\`${o.op}\` ${code(o.key)}${o.detail ? ` — ${text(o.detail)}` : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`;
  const sections = [
    { dims: ["security"], items: [["Routes", (ev.routes ? ev.routes.observed : []).map(route)]] },
    { dims: ["data"], items: [["Schema", schemaItems([...(ev.migrations ? ev.migrations.observed : []), ...(ev.prisma ? ev.prisma.observed : [])])]] },
    { dims: ["structural", "operational"], items: [["Dependencies", (ev.dependencies ? ev.dependencies.observed : []).map(item)]] },
    { dims: ["trust_root"], items: [["Workflows", (ev.workflows ? ev.workflows.observed : []).map(item)]] },
  ];
  for (const s of sections) {
    const rows = ruleRows(s.dims);
    const has = s.items.some(([, list]) => list.length);
    if (!rows.length && !has) continue;
    out.push(`#### ${s.dims.map((d) => DIM[d]).filter((v, i, a) => a.indexOf(v) === i).join(" · ").replace("Structure and dependencies · Operations", "Structure, dependencies and operations")}`, "");
    out.push(...rows);
    for (const [title, list] of s.items) details(out, title, list);
  }

  // --- Uncertainty and coverage --------------------------------------------------------
  out.push("#### Uncertainty and coverage", "");
  const unknown = evidence.filter((e) => e.unknown.length);
  if (unknown.length) {
    out.push("Could not be established (each one raises the priority; none counts as a pass):", "");
    for (const e of unknown) for (const u of e.unknown.slice(0, 10)) out.push(`- **${text(e.extractor)}**: ${text(u, { max: 300 })}`);
    out.push("");
  }
  const excused = risk.hits.filter((h) => h.excused);
  for (const h of excused) out.push(`- ${text(h.rule)}: ${plural(h.excused, "match", "matches")} excused by the rule's \`unless\` (set in the policy).`);
  const gen = files.filter((f) => f.generated);
  if (gen.length) {
    const dirs = new Map();
    for (const f of gen) {
      const d = f.path.split("/").slice(0, 2).join("/");
      dirs.set(d, (dirs.get(d) || 0) + 1);
    }
    out.push(`- Not counted toward size, as generated or vendored: ${[...dirs].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d, k]) => `${code(d)} (${k})`).join(", ")}. Path rules still apply to them.`);
  }
  for (const e of notChecked) out.push(`- **${text(e.extractor)}: not checked**: ${text(e.note || "nothing to read")}.`);
  out.push("- Not covered: routes registered by service providers or packages, and behaviour outside what the extractors read, which path and pattern rules see only by file name and changed text.");
  out.push("");

  // --- How the priority was decided ----------------------------------------------------
  // One row per rule and dimension; Count is how many places it fired (pattern lines,
  // files, or evidence items).
  const firedMap = new Map();
  for (const h of risk.hits) {
    const k = `${h.rule}\u0000${h.dimension}`;
    const prev = firedMap.get(k);
    const c = h.count ?? (h.kind === "size" ? null : 1);
    if (!prev) firedMap.set(k, { ...h, count: c });
    else if (c !== null) prev.count = (prev.count || 0) + c;
  }
  const fired = [...firedMap.values()];
  out.push("<details><summary><b>How the priority was decided</b></summary>", "");
  out.push("| Dimension | Level | Decided by |", "|---|---|---|");
  for (const [d, level] of Object.entries(risk.dimensions)) out.push(`| ${DIM[d]} | ${ICON[level]} ${level} | ${(risk.contributors && risk.contributors[d] ? risk.contributors[d] : []).map((r) => text(r, { table: true })).join(", ") || "—"} |`);
  out.push("", `The review priority is the highest dimension. Rules only escalate: nothing here lowers a level.`, "");
  if (fired.length) {
    out.push("| Rule | Dimension | Level | Kind | Count |", "|---|---|---|---|---|");
    for (const h of fired.sort((a, b) => ORDER[a.level] - ORDER[b.level])) out.push(`| ${text(h.rule, { table: true })} | ${DIM[h.dimension]} | ${h.level} | ${KIND[h.kind] || h.kind} | ${h.count ?? ""} |`);
    out.push("");
  }
  out.push("*observed*: read directly from the diff; the risk is the policy's judgement, the fact isn't. *heuristic*: a pattern match or an inference; worth checking, not a confirmed problem. *unknown*: couldn't be established.", "", "</details>", "");

  out.push(`<sub>change-evidence ${text(version)} · ${mode} mode: ${mode === "shadow" ? "reports only, never blocks" : "enforcing"} · policy ${text(policy.name)} v${text(policy.version)}${policy.selected ? ` (${text(policy.selected.how)})` : ""}${policy.overlay ? ` + ${text(policy.overlay)}` : ""} · ${text(base.slice(0, 7))}…${text(head.slice(0, 7))} · evidence read as data from git; the PR's code was not run</sub>`);
  return out.join("\n") + "\n";
}

module.exports = { renderPr, observedSummary, schemaItems };
