"use strict";

// Policy loading. A repository can carry an overlay (`.change-evidence.json`) on top of
// the built-in policy. In CI the overlay is read from the BASE commit, never from the PR:
// a change can't rewrite the rules it is judged by. Changing the overlay is itself a
// trust-root change, so the overlay's own path is escalated.

const fs = require("fs");
const path = require("path");
const { git, show } = require("./git");

const OVERLAY = ".change-evidence.json";
const BUILTIN = path.join(__dirname, "..", "policies");

const BUILTINS = ["laravel", "node-next"];

function builtin(name = "laravel") {
  if (!BUILTINS.includes(name)) throw new Error(`no built-in policy "${name}" (available: ${BUILTINS.join(", ")})`);
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
// Which built-in policy fits the repository at `commit`, from files at its root:
//   laravel    an `artisan` file and composer.json
//   node-next  next.config.*, a Prisma schema, or `next` / `@prisma/client` in package.json
// Both: Laravel (the backend decides most consequences), with the reason saying so. None:
// Laravel's language-agnostic rules still apply (CI, test harness, infrastructure,
// dependencies, workflows), and the report says nothing ecosystem-specific matched.
function detectEcosystem(cwd, commit) {
  const root = new Set((git(cwd, ["ls-tree", "--name-only", commit], { allowFail: true }) || "").split("\n").filter(Boolean));
  const laravel = root.has("artisan") && root.has("composer.json") ? ["artisan", "composer.json"] : [];
  // Next.js and Prisma can live anywhere in a monorepo (apps/web, packages/prisma).
  const tree = (git(cwd, ["ls-tree", "-r", "--name-only", commit], { allowFail: true }) || "").split("\n").filter((f) => f && !/(^|\/)(node_modules|vendor)\//.test(f));
  const node = [
    ...tree.filter((f) => /(^|\/)next\.config\.(js|mjs|cjs|ts)$/.test(f)).slice(0, 3),
    ...tree.filter((f) => /(^|\/)schema\.prisma$/.test(f)).slice(0, 2),
  ];
  if (root.has("package.json")) {
    try {
      const pkg = JSON.parse(show(cwd, commit, "package.json") || "{}");
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) node.push("package.json: next");
      else if (deps["@prisma/client"] || deps.prisma) node.push("package.json: prisma");
    } catch {
      // unreadable package.json: no evidence either way
    }
  }
  if (laravel.length && node.length) return { name: "laravel", how: `detected (${laravel.join(", ")}; also ${node.join(", ")}: set "extends" in ${OVERLAY} to choose)` };
  if (laravel.length) return { name: "laravel", how: `detected (${laravel.join(", ")})` };
  if (node.length) return { name: "node-next", how: `detected (${[...new Set(node)].join(", ")})` };
  return { name: "laravel", how: "default: no supported ecosystem detected; only language-agnostic rules apply" };
}

// The policy a change is judged by, in order of precedence:
//   --policy FILE > the overlay's "extends" > detected from the repository.
// Then the overlay (from `commit`, the base branch tip) is applied on top.
function policyFor(cwd, base, { policyFile, overlayFile = OVERLAY } = {}) {
  const { overlay, source, error: overlayError } = overlayAt(cwd, base, overlayFile);
  let p;
  let selected;
  let error = overlayError;
  if (policyFile) {
    p = JSON.parse(fs.readFileSync(path.resolve(policyFile), "utf8"));
    selected = { name: p.name, how: "--policy" };
  } else if (overlay && overlay.extends) {
    try {
      p = builtin(String(overlay.extends));
      selected = { name: String(overlay.extends), how: `extends in ${OVERLAY}` };
    } catch (e) {
      error = `${OVERLAY}: ${e.message}`;
    }
  }
  if (!p) {
    selected = detectEcosystem(cwd, base);
    p = builtin(selected.name);
  }
  const merged = applyOverlay(p, overlay, source);
  merged.selected = selected;
  // The overlay file itself is trust root.
  merged.path_rules = [...merged.path_rules.filter((r) => r.id !== "policy-overlay"), { id: "policy-overlay", dimension: "trust_root", level: "high", paths: [overlayFile] }];
  return { policy: merged, error };
}

module.exports = { policyFor, applyOverlay, overlayAt, builtin, detectEcosystem, BUILTINS, OVERLAY };
