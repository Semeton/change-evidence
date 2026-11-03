"use strict";

// The PR report. Evidence first, tier second: on a 2,500-line agent PR the useful
// question is "where do I look", and the answer is the structural changes and the
// rules that fired, with files. The tier says how much attention the change needs.

const ICON = { low: "🟢", medium: "🟡", high: "🔴" };
const DIM_LABEL = { security: "Security", data: "Data", structural: "Structure", operational: "Operations", trust_root: "Trust root" };

function esc(s) {
  return String(s ?? "").replace(/\|/g, "\\|").replace(/</g, "&lt;");
}

function section(lines, title, items) {
  if (!items.length) return;
  lines.push(`<details${items.length <= 12 ? " open" : ""}><summary><b>${title}</b> (${items.length})</summary>`, "");
  for (const i of items.slice(0, 60)) lines.push(`- ${i}`);
  if (items.length > 60) lines.push(`- … ${items.length - 60} more in the JSON artifact`);
  lines.push("", "</details>", "");
}

function renderPr({ result, base, head, policy, version, mode = "shadow", policyError }) {
  const { risk, evidence, files, lines: size } = result;
  const ev = Object.fromEntries(evidence.map((e) => [e.extractor, e]));
  const out = [];
  out.push(`### ${ICON[risk.tier] || ""} Change evidence: ${risk.tier} risk`);
  out.push("");
  const dims = Object.entries(risk.dimensions).filter(([, l]) => l !== "low");
  out.push(`${files.length} files, +${size.added} −${size.removed}.` + (dims.length ? ` Elevated: ${dims.map(([d, l]) => `${DIM_LABEL[d]} (${l})`).join(", ")}.` : " No dimension above low."));
  out.push("");
  if (policyError) out.push(`> ⚠️ ${esc(policyError)}. The built-in policy was used.`, "");

  // Why: rules at medium or high, grouped, with where they fired.
  const why = new Map();
  for (const h of risk.hits) {
    if (h.level === "low") continue;
    const k = h.rule;
    if (!why.has(k)) why.set(k, { ...h, where: new Set() });
    for (const f of h.files || []) why.get(k).where.add(f);
    if (h.key) why.get(k).where.add(h.key);
  }
  if (why.size) {
    out.push(`| Level | Rule | Where |`, `|---|---|---|`);
    const order = { high: 0, medium: 1 };
    for (const h of [...why.values()].sort((a, b) => order[a.level] - order[b.level])) {
      const where = [...h.where].slice(0, 4).map((w) => `\`${esc(w)}\``).join(", ") + (h.where.size > 4 ? ` +${h.where.size - 4}` : "") || esc(h.detail || "");
      out.push(`| ${ICON[h.level]} ${h.level} | ${esc(h.rule)}${h.heuristic ? " *(heuristic)*" : ""} | ${where} |`);
    }
    out.push("");
  }

  // What changed, structurally.
  const r = ev.routes ? ev.routes.observed : [];
  section(out, "Routes", r.map((o) => `${o.op === "route_added" ? "➕" : o.op === "route_removed" ? "➖" : "✏️"} \`${esc(o.key)}\`${o.detail ? ` — ${esc(o.detail)}` : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`));
  const m = ev.migrations ? ev.migrations.observed : [];
  section(out, "Schema", m.map((o) => `\`${o.op}\` ${esc(o.key)}${o.detail ? ` — ${esc(o.detail)}` : ""}${o.conditional ? " (conditional)" : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`));
  const d = ev.dependencies ? ev.dependencies.observed : [];
  section(out, "Dependencies", d.map((o) => `\`${o.op}\` ${esc(o.key)}${o.detail ? ` — ${esc(o.detail)}` : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`));
  const w = ev.workflows ? ev.workflows.observed : [];
  section(out, "Workflows", w.map((o) => `\`${o.op}\` ${esc(o.key)}${o.detail ? ` — ${esc(o.detail)}` : ""}${o.risk ? ` ⚠️ ${o.risk}` : ""}`));

  const unknown = evidence.flatMap((e) => e.unknown.map((u) => `**${e.extractor}**: ${esc(u)}`));
  if (unknown.length) {
    out.push(`**Could not be established** (counts as a reason to look, never as a pass):`, "");
    for (const u of unknown.slice(0, 20)) out.push(`- ${u}`);
    out.push("");
  }
  out.push(`<sub>change-evidence ${version} · ${mode} mode: reports only, never blocks · policy ${esc(policy.name)} v${policy.version}${policy.overlay ? ` + ${esc(policy.overlay)}` : ""} · ${base.slice(0, 7)}…${head.slice(0, 7)} · evidence read as data from git; the PR's code was not run</sub>`);
  return out.join("\n") + "\n";
}

module.exports = { renderPr };
