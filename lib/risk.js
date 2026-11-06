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
    else if (c === "[") {
      const close = glob.indexOf("]", i);
      re += close === -1 ? "\\[" : glob.slice(i, close + 1);
      if (close !== -1) i = close;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const COMPILED = new WeakMap();

function compile(policy) {
  const g = (paths) => paths.map(globRe);
  return {
    ...policy,
    __isCompiled: true,
    path_rules: (policy.path_rules || []).map((r) => ({ ...r, re: g(r.paths) })),
    deleted_path_rules: (policy.deleted_path_rules || []).map((r) => ({ ...r, re: g(r.paths) })),
    pattern_rules: (policy.pattern_rules || []).map((r) => ({
      ...r,
      re: g(r.paths || ["**"]),
      addedRe: r.added ? new RegExp(r.added) : null,
      removedRe: r.removed ? new RegExp(r.removed) : null,
      unlessRe: r.unless ? new RegExp(r.unless) : null,
    })),
  };
}

// Every hit has a `kind`, so a reader can tell what the evaluator established from what
// it inferred:
//   observed   the change was read directly: this file changed, this route lost `auth`,
//              this column was dropped. The risk is the policy's judgement; the fact isn't.
//   heuristic  a pattern matched text, or an inference was made (e.g. "no auth middleware
//              found" on a new route). Worth a look; not a confirmed problem.
//   unknown    something couldn't be established, or a rule failed. Never a pass.
//   size       the change is large by the policy's thresholds.
//
// change: { files: [{ status, path, from?, generated? }], lines: { added, removed },
//           counted?: { added, removed, files } (excluding generated files),
//           diff: Map(file -> { added: [{ n, text }], removed: [{ n, text }] }) }
// evidence: [result] from extractors
function assess(policyIn, change, evidence) {
  // Compiled policies are cached by object identity (a WeakMap, not a property): a
  // property would be copied by `{ ...policy }`, and an overlay built from a spread
  // policy would then be evaluated with the base policy's rules.
  let policy = policyIn;
  if (!policyIn.__isCompiled) {
    policy = COMPILED.get(policyIn);
    if (!policy) {
      policy = compile(policyIn);
      COMPILED.set(policyIn, policy);
    }
  }
  const tiers = policy.tiers;
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, tiers[0]]));
  const hits = [];
  const raise = (dimension, level, hit) => {
    if (rank(tiers, level) > rank(tiers, dims[dimension] ?? tiers[0])) dims[dimension] = level;
    hits.push({ dimension, level, ...hit, ...(hit.kind === "heuristic" ? { heuristic: true } : {}) });
  };
  const guard = (id, dimension, fn) => {
    try {
      fn();
    } catch (e) {
      raise(dimension, policy.on_unknown || "medium", { rule: id, kind: "unknown", unknown: `rule failed: ${e.message}` });
    }
  };

  // `status` (optional) limits a path rule to files added (A), modified (M), renamed (R),
  // copied (C), type-changed (T) or deleted (D), e.g. ["M", "R", "D"] for "a file that
  // already existed was changed": an edited shipped migration, whatever its language.
  for (const r of policy.path_rules) {
    guard(r.id, r.dimension, () => {
      if (r.status && !(Array.isArray(r.status) && r.status.every((x) => /^[AMRCTD]$/.test(x)))) throw new Error(`status must be a list of A, M, R, C, T, D (got ${JSON.stringify(r.status)})`);
      const matched = change.files.filter((f) => (!r.status || r.status.includes(f.status)) && r.re.some((re) => re.test(f.path) || (f.from && re.test(f.from))));
      if (matched.length) raise(r.dimension, r.level, { rule: r.id, kind: "observed", files: matched.map((f) => f.path).slice(0, 20), count: matched.length });
    });
  }
  for (const r of policy.deleted_path_rules) {
    guard(r.id, r.dimension, () => {
      const matched = change.files.filter((f) => f.status === "D" && r.re.some((re) => re.test(f.path)));
      if (matched.length) raise(r.dimension, r.level, { rule: r.id, kind: "observed", files: matched.map((f) => f.path).slice(0, 20), count: matched.length });
    });
  }
  for (const r of policy.pattern_rules) {
    guard(r.id, r.dimension, () => {
      const locations = [];
      let excused = 0;
      for (const [file, d] of change.diff) {
        if (!r.re.some((re) => re.test(file))) continue;
        // A pattern counts only if the PR changes how often it appears in that file:
        // a line moved within the file is not new. `unless` is the policy's own,
        // reviewed exception (e.g. a bypass that re-applies the tenant filter on the
        // same line); excused matches are counted and reported, never hidden.
        const check = (lines, re, side) => {
          const all = lines.filter((l) => re.test(l.text));
          const kept = r.unlessRe ? all.filter((l) => !r.unlessRe.test(l.text)) : all;
          return { all, kept, excusedHere: all.length - kept.length, side };
        };
        if (r.addedRe) {
          const plus = check(d.added, r.addedRe, "+");
          const minus = d.removed.filter((l) => r.addedRe.test(l.text)).length;
          if (plus.all.length > minus) {
            excused += plus.excusedHere;
            for (const l of plus.kept) locations.push({ file, line: l.n, side: "+", text: l.text.trim().slice(0, 160) });
          }
        }
        if (r.removedRe) {
          const minus = check(d.removed, r.removedRe, "-");
          const plus = d.added.filter((l) => r.removedRe.test(l.text)).length;
          if (minus.all.length > plus) {
            excused += minus.excusedHere;
            for (const l of minus.kept) locations.push({ file, line: l.n, side: "-", text: l.text.trim().slice(0, 160) });
          }
        }
      }
      if (locations.length) {
        raise(r.dimension, r.level, { rule: r.id, kind: "heuristic", files: [...new Set(locations.map((l) => l.file))].slice(0, 20), count: locations.length, locations: locations.slice(0, 40), ...(excused ? { excused } : {}) });
      } else if (excused) {
        hits.push({ dimension: r.dimension, level: tiers[0], rule: r.id, kind: "heuristic", heuristic: true, count: 0, excused, note: `${excused} match${excused === 1 ? "" : "es"} excused by the rule's \`unless\`` });
      }
    });
  }
  for (const ev of evidence) {
    for (const o of ev.observed) {
      const er = o.risk && policy.evidence_rules[o.risk];
      if (er) raise(er.dimension, er.level, { rule: `evidence:${o.risk}`, kind: er.heuristic ? "heuristic" : "observed", extractor: ev.extractor, key: o.key, ...(o.file ? { files: [o.file] } : {}) });
      const or = policy.op_rules[o.op];
      if (or && rank(tiers, or.level) > 0) raise(or.dimension, or.level, { rule: `op:${o.op}`, kind: "observed", extractor: ev.extractor, key: o.key });
    }
    if (ev.state === "UNKNOWN") {
      const dim = ev.extractor === "migrations" ? "data" : ev.extractor === "routes" ? "security" : ev.extractor === "workflows" ? "trust_root" : "structural";
      raise(dim, policy.on_unknown || "medium", { rule: `unknown:${ev.extractor}`, kind: "unknown", extractor: ev.extractor, unknown: ev.unknown.slice(0, 10) });
    }
  }
  const s = policy.size;
  if (s) {
    const counted = change.counted || { ...change.lines, files: change.files.length };
    const lines = counted.added + counted.removed;
    const excluded = change.files.length - counted.files;
    const note = excluded ? ` (${excluded} generated or vendored file${excluded === 1 ? "" : "s"} not counted)` : "";
    if (lines > s.max_changed_lines) raise("structural", s.level, { rule: "size:lines", kind: "size", detail: `${lines} changed lines${note}` });
    if (counted.files > s.max_files) raise("structural", s.level, { rule: "size:files", kind: "size", detail: `${counted.files} files${note}` });
  }
  const tier = DIMENSIONS.reduce((t, d) => (rank(tiers, dims[d]) > rank(tiers, t) ? dims[d] : t), tiers[0]);
  // Which rules decided each dimension's level (the hits at that level), and the tier.
  const contributors = {};
  for (const d of DIMENSIONS) {
    if (dims[d] === tiers[0]) continue;
    contributors[d] = [...new Set(hits.filter((h) => h.dimension === d && h.level === dims[d]).map((h) => h.rule))];
  }
  const decidedBy = DIMENSIONS.filter((d) => dims[d] === tier && tier !== tiers[0]);
  return { tier, dimensions: dims, hits, contributors, decided_by: decidedBy };
}

module.exports = { assess, compile, globRe, DIMENSIONS };
