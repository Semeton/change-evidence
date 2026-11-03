"use strict";

// GitHub Actions workflows. A change here is trust-root by policy, so this extractor
// doesn't lower anything: it makes the review cheap by saying exactly what moved.
// Each `uses:` reference is listed with its old and new ref, and whether the new ref is
// pinned to a full commit SHA (a tag or branch can be moved under you; a SHA can't).
// Everything else that changed in the workflow is counted, so "only Action bumps" is visible.

const { show, diffLines } = require("../git");
const { result, STATES } = require("../evidence");

const isWorkflow = (p) => /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+)$/.test(p);
const USES = /^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)['"]?/;

function usesIn(text) {
  const out = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = USES.exec(line);
    if (!m || m[1].startsWith("./") || m[1].startsWith("docker://")) continue;
    const [action, ref = ""] = m[1].split("@");
    if (!out.has(action)) out.set(action, new Set());
    out.get(action).add(ref);
  }
  return out;
}

const pinned = (ref) => /^[0-9a-f]{40}$/.test(ref);

function extractWorkflows(ctx) {
  const { cwd, base, head, changed } = ctx;
  const touched = changed.filter((f) => isWorkflow(f.path) || (f.from && isWorkflow(f.from)));
  if (!touched.length) return result("workflows", { state: STATES.PASS, note: "no workflow files changed" });
  const observed = [];
  const diff = diffLines(cwd, base, head, touched.filter((f) => f.status !== "D").map((f) => f.path));
  for (const f of touched) {
    const before = usesIn(f.status === "A" ? "" : show(cwd, base, f.from || f.path));
    const after = usesIn(f.status === "D" ? "" : show(cwd, head, f.path));
    for (const [action, refs] of after) {
      const old = before.get(action);
      for (const ref of refs) {
        if (old && old.has(ref)) continue;
        const from = old ? [...old].filter((r) => !refs.has(r)).join(", ") : null;
        observed.push({
          op: from ? "action_ref_changed" : "action_added",
          key: `${f.path}: ${action}`,
          detail: `${from ? `${from} → ` : ""}${ref || "(no ref)"}${pinned(ref) ? " (SHA-pinned)" : ""}`,
          ...(pinned(ref) ? {} : { risk: "unpinned_action" }),
        });
      }
    }
    for (const [action] of before) if (!after.has(action)) observed.push({ op: "action_removed", key: `${f.path}: ${action}` });
    const d = diff.get(f.path) || { added: [], removed: [] };
    const other = [...d.added, ...d.removed].filter((l) => l.trim() && !USES.test(l)).length;
    if (other || f.status === "A" || f.status === "D") observed.push({ op: "workflow_changed", key: f.path, detail: f.status === "A" ? "new workflow" : f.status === "D" ? "workflow deleted" : `${other} non-\`uses:\` lines changed` });
  }
  return result("workflows", { observed, inspected: touched.length });
}

module.exports = { extractWorkflows, usesIn };
