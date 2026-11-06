"use strict";

// Policy loading. A repository can carry an overlay (`.change-evidence.json`) on top of
// the built-in policy. In CI the overlay is read from the BASE commit, never from the PR:
// a change can't rewrite the rules it is judged by. Changing the overlay is itself a
// trust-root change, so the overlay's own path is escalated.

const fs = require("fs");
const path = require("path");
const { show } = require("./git");

const OVERLAY = ".change-evidence.json";
const BUILTIN = path.join(__dirname, "..", "policies");

function builtin(name = "laravel") {
  return JSON.parse(fs.readFileSync(path.join(BUILTIN, `${name}.json`), "utf8"));
}

// Merge rules by id: an overlay rule with the same id replaces the built-in one.
function byId(base = [], extra = [], disabled) {
  const out = new Map(base.map((r) => [r.id, r]));
  for (const r of extra) out.set(r.id, r);
  return [...out.values()].filter((r) => !disabled.has(r.id));
}

function applyOverlay(policy, overlay, source) {
  if (!overlay) return policy;
  const disabled = new Set(overlay.disable || []);
  const evidence = { ...policy.evidence_rules, ...(overlay.evidence_rules || {}) };
  for (const k of disabled) delete evidence[k];
  return {
    ...policy,
    name: `${policy.name}+${overlay.name || "repo"}`,
    overlay: source,
    on_unknown: overlay.on_unknown || policy.on_unknown,
    size: overlay.size === null ? null : { ...policy.size, ...(overlay.size || {}) },
    // Additive: an overlay can name more generated paths, not un-generate the defaults.
    generated: [...new Set([...(policy.generated || []), ...(Array.isArray(overlay.generated) ? overlay.generated : [])])],
    path_rules: byId(policy.path_rules, overlay.path_rules, disabled),
    deleted_path_rules: byId(policy.deleted_path_rules, overlay.deleted_path_rules, disabled),
    pattern_rules: byId(policy.pattern_rules, overlay.pattern_rules, disabled),
    evidence_rules: evidence,
    op_rules: { ...policy.op_rules, ...(overlay.op_rules || {}) },
  };
}

// Overlay text at a commit. Returns { overlay, source, error }.
function overlayAt(cwd, commit, file = OVERLAY) {
  const text = show(cwd, commit, file);
  if (text === null) return { overlay: null, source: null };
  try {
    return { overlay: JSON.parse(text), source: `${file}@${commit.slice(0, 10)}` };
  } catch (e) {
    return { overlay: null, source: `${file}@${commit.slice(0, 10)}`, error: `overlay is not valid JSON: ${e.message}` };
  }
}

// The policy a change is judged by: built-in (or --policy file) + overlay from `base`.
function policyFor(cwd, base, { policyFile, overlayFile = OVERLAY } = {}) {
  const p = policyFile ? JSON.parse(fs.readFileSync(path.resolve(policyFile), "utf8")) : builtin();
  const { overlay, source, error } = overlayAt(cwd, base, overlayFile);
  const merged = applyOverlay(p, overlay, source);
  // The overlay file itself is trust root.
  merged.path_rules = [...merged.path_rules.filter((r) => r.id !== "policy-overlay"), { id: "policy-overlay", dimension: "trust_root", level: "high", paths: [overlayFile] }];
  return { policy: merged, error };
}

module.exports = { policyFor, applyOverlay, overlayAt, builtin, OVERLAY };
