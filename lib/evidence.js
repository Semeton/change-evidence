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
function result(extractor, { cls = "structural", state, observed = [], unknown = [], inspected = 0, note } = {}) {
  const s = state || (unknown.length ? STATES.UNKNOWN : STATES.PASS);
  return {
    extractor,
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

module.exports = { STATES, CLASSES, result, notApplicable };
