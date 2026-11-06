"use strict";

// The evidence model from the spec (revision 2). Every check result carries:
//   class     what kind of fact it is
//   producer  who generated it: "trusted" (read as data by the pinned evaluator) or
//             "candidate" (produced by running the candidate's code)
//   state     PASS | FAIL | UNKNOWN | NOT_APPLICABLE
//   coverage  what was inspected and what was skipped
// The study only reads files, so every result here is producer "trusted". A result
// that could not be established is UNKNOWN; it is never reported as PASS.

const STATES = Object.freeze({ PASS: "PASS", FAIL: "FAIL", UNKNOWN: "UNKNOWN", NOT_APPLICABLE: "NOT_APPLICABLE" });
const CLASSES = Object.freeze(["structural", "contractual", "runtime", "invariant", "heuristic"]);

// One extractor's result for one change.
//   observed: the changes it saw, as { op, key, detail?, risk? } items
//   unknown:  what it could not establish, as strings
// The ecosystem each built-in extractor reads. A second ecosystem's extractors declare
// their own through `ecosystem`.
const ECOSYSTEMS = { routes: "laravel", migrations: "laravel", dependencies: "composer+npm", workflows: "github-actions" };

function result(extractor, { cls = "structural", state, observed = [], unknown = [], inspected = 0, note, ecosystem } = {}) {
  const s = state || (unknown.length ? STATES.UNKNOWN : STATES.PASS);
  return {
    extractor,
    ecosystem: ecosystem || ECOSYSTEMS[extractor] || "unknown",
    class: cls,
    producer: "trusted",
    state: s,
    observed,
    unknown,
    coverage: { inspected, skipped: unknown.length },
    ...(note ? { note } : {}),
  };
}

function notApplicable(extractor, note) {
  return result(extractor, { state: STATES.NOT_APPLICABLE, note });
}

// The contract every extractor's output must meet. Returns a list of problems (empty if
// valid). Tests run it over every extractor, so a new one can't drift from what the risk
// engine and the report expect.
//   observed items: { op, key, detail?, risk?, file?, line?, category?, conditional?, ... }
//   unknown: strings, each naming what couldn't be established (and where, if known)
function validateResult(r) {
  const p = [];
  const isStr = (x) => typeof x === "string" && x.length > 0;
  if (!r || typeof r !== "object") return ["result is not an object"];
  if (!isStr(r.extractor)) p.push("extractor: missing");
  if (!isStr(r.ecosystem)) p.push("ecosystem: missing");
  if (!CLASSES.includes(r.class)) p.push(`class: ${r.class} isn't one of ${CLASSES.join(", ")}`);
  if (r.producer !== "trusted" && r.producer !== "candidate") p.push(`producer: ${r.producer}`);
  if (!Object.values(STATES).includes(r.state)) p.push(`state: ${r.state}`);
  if (!Array.isArray(r.observed)) p.push("observed: not a list");
  if (!Array.isArray(r.unknown)) p.push("unknown: not a list");
  if (Array.isArray(r.unknown)) {
    r.unknown.forEach((u, i) => isStr(u) || p.push(`unknown[${i}]: not a non-empty string`));
    if (r.unknown.length && r.state === STATES.PASS) p.push("state is PASS but there are unknowns: uncertainty must not be reported as a pass");
  }
  (Array.isArray(r.observed) ? r.observed : []).forEach((o, i) => {
    if (!o || typeof o !== "object") return p.push(`observed[${i}]: not an object`);
    if (!isStr(o.op)) p.push(`observed[${i}].op: missing`);
    if (!isStr(o.key)) p.push(`observed[${i}].key: missing`);
    for (const k of ["detail", "risk", "file", "category"]) if (o[k] !== undefined && typeof o[k] !== "string") p.push(`observed[${i}].${k}: not a string`);
    if (o.line !== undefined && !(Number.isInteger(o.line) && o.line > 0)) p.push(`observed[${i}].line: not a positive integer`);
  });
  if (!r.coverage || !Number.isInteger(r.coverage.inspected) || !Number.isInteger(r.coverage.skipped)) p.push("coverage: needs integer inspected and skipped");
  return p;
}

module.exports = { STATES, CLASSES, ECOSYSTEMS, result, notApplicable, validateResult };
