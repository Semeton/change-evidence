"use strict";

// Risk engine. Takes a change (files, line counts, diff lines) and the extractor results,
// applies a policy, and returns a tier per dimension plus every rule hit that produced it.
// Rules only escalate. A rule that throws makes its dimension UNKNOWN-escalated, never PASS.

const DIMENSIONS = ["security", "data", "structural", "operational", "trust_root"];

function rank(tiers, level) {
  const i = tiers.indexOf(level);
  return i === -1 ? 0 : i;
}

// Glob to RegExp: `**` any path, `*` any segment chars, `?` one char.
function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function compile(policy) {
  const g = (paths) => paths.map(globRe);
  return {
    ...policy,
    path_rules: (policy.path_rules || []).map((r) => ({ ...r, re: g(r.paths) })),
    deleted_path_rules: (policy.deleted_path_rules || []).map((r) => ({ ...r, re: g(r.paths) })),
    pattern_rules: (policy.pattern_rules || []).map((r) => ({
      ...r,
      re: g(r.paths || ["**"]),
      addedRe: r.added ? new RegExp(r.added) : null,
      removedRe: r.removed ? new RegExp(r.removed) : null,
    })),
  };
}

// change: { files: [{status,path,from?}], lines: {added, removed}, diff: Map(file -> {added[], removed[]}) }
// evidence: [result] from extractors
function assess(policyIn, change, evidence) {
  const policy = policyIn.re ? policyIn : policyIn.__compiled || (policyIn.__compiled = compile(policyIn));
  const tiers = policy.tiers;
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, tiers[0]]));
  const hits = [];
  const raise = (dimension, level, hit) => {
    if (rank(tiers, level) > rank(tiers, dims[dimension] ?? tiers[0])) dims[dimension] = level;
    hits.push({ dimension, level, ...hit });
  };
  const guard = (id, dimension, fn) => {
    try {
      fn();
    } catch (e) {
      raise(dimension, policy.on_unknown || "medium", { rule: id, unknown: `rule failed: ${e.message}` });
    }
  };

  for (const r of policy.path_rules) {
    guard(r.id, r.dimension, () => {
      const matched = change.files.filter((f) => r.re.some((re) => re.test(f.path) || (f.from && re.test(f.from))));
      if (matched.length) raise(r.dimension, r.level, { rule: r.id, files: matched.map((f) => f.path).slice(0, 5) });
    });
  }
  for (const r of policy.deleted_path_rules) {
    guard(r.id, r.dimension, () => {
      const matched = change.files.filter((f) => f.status === "D" && r.re.some((re) => re.test(f.path)));
      if (matched.length) raise(r.dimension, r.level, { rule: r.id, files: matched.map((f) => f.path).slice(0, 5) });
    });
  }
  for (const r of policy.pattern_rules) {
    guard(r.id, r.dimension, () => {
      const found = [];
      for (const [file, d] of change.diff) {
        if (!r.re.some((re) => re.test(file))) continue;
        // A pattern counts only if the PR changes how often it appears in that file:
        // a line moved within the file is not new.
        const count = (lines, re) => lines.filter((l) => re.test(l)).length;
        if (r.addedRe && count(d.added, r.addedRe) > count(d.removed, r.addedRe)) found.push(file);
        if (r.removedRe && count(d.removed, r.removedRe) > count(d.added, r.removedRe)) found.push(file);
      }
      if (found.length) raise(r.dimension, r.level, { rule: r.id, heuristic: true, files: [...new Set(found)].slice(0, 5) });
    });
  }
  for (const ev of evidence) {
    for (const o of ev.observed) {
      const er = o.risk && policy.evidence_rules[o.risk];
      if (er) raise(er.dimension, er.level, { rule: `evidence:${o.risk}`, extractor: ev.extractor, key: o.key, ...(er.heuristic ? { heuristic: true } : {}) });
      const or = policy.op_rules[o.op];
      if (or && rank(tiers, or.level) > 0) raise(or.dimension, or.level, { rule: `op:${o.op}`, extractor: ev.extractor, key: o.key });
    }
    if (ev.state === "UNKNOWN") {
      const dim = ev.extractor === "migrations" ? "data" : ev.extractor === "routes" ? "security" : "structural";
      raise(dim, policy.on_unknown || "medium", { rule: `unknown:${ev.extractor}`, unknown: ev.unknown.slice(0, 3) });
    }
  }
  const s = policy.size;
  if (s) {
    const lines = change.lines.added + change.lines.removed;
    if (lines > s.max_changed_lines) raise("structural", s.level, { rule: "size:lines", detail: `${lines} changed lines` });
    if (change.files.length > s.max_files) raise("structural", s.level, { rule: "size:files", detail: `${change.files.length} files` });
  }
  const tier = DIMENSIONS.reduce((t, d) => (rank(tiers, dims[d]) > rank(tiers, t) ? dims[d] : t), tiers[0]);
  return { tier, dimensions: dims, hits };
}

module.exports = { assess, compile, globRe, DIMENSIONS };
