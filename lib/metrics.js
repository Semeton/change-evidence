"use strict";

// Classification metrics with honest uncertainty. Every proportion comes with a Wilson
// 95% interval and its numerator/denominator. A result is marked exploratory when it
// rests on fewer than MIN_POSITIVES positive labels: below that, intervals are wide
// enough that a difference between rules or repositories usually isn't a finding.

const MIN_POSITIVES = 20;
const Z = 1.959964;

// Wilson score interval for k successes in n trials.
function wilson(k, n, z = Z) {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / d;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

function prop(k, n) {
  return { k, n, value: n ? k / n : null, ci: wilson(k, n) };
}

// rows: items; flagged(r) -> bool; label(r) -> true | false | null (null is excluded).
function confusion(rows, flagged, label) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  let excluded = 0;
  for (const r of rows) {
    const y = label(r);
    if (y === null || y === undefined) {
      excluded++;
      continue;
    }
    const f = flagged(r);
    if (f && y) tp++;
    else if (f && !y) fp++;
    else if (!f && y) fn++;
    else tn++;
  }
  const n = tp + fp + fn + tn;
  return {
    n,
    excluded,
    positives: tp + fn,
    tp,
    fp,
    fn,
    tn,
    flagged_share: prop(tp + fp, n),
    precision: prop(tp, tp + fp),
    recall: prop(tp, tp + fn),
    false_positive_rate: prop(fp, fp + tn),
    false_negative_rate: prop(fn, tp + fn),
    base_rate: prop(tp + fn, n),
    exploratory: tp + fn < MIN_POSITIVES,
  };
}

// Capture at a fixed review budget: review the top ceil(budget × n) items by `score`
// (ties broken by `tie`), and see what share of the positives they hold.
function captureAtBudget(rows, { score, tie, label, budget }) {
  const usable = rows.filter((r) => label(r) !== null && label(r) !== undefined);
  const k = Math.ceil(budget * usable.length);
  const ranked = [...usable].sort((a, b) => score(b) - score(a) || tie(a) - tie(b));
  const top = ranked.slice(0, k);
  const positives = usable.filter((r) => label(r)).length;
  const caught = top.filter((r) => label(r)).length;
  return { budget, reviewed: k, n: usable.length, capture: prop(caught, positives), precision: prop(caught, k), exploratory: positives < MIN_POSITIVES };
}

function fmt(p, { digits = 1 } = {}) {
  if (!p || p.value === null) return "–";
  const pc = (x) => (100 * x).toFixed(digits);
  return `${pc(p.value)}% [${pc(p.ci[0])}–${pc(p.ci[1])}] (${p.k}/${p.n})`;
}

module.exports = { wilson, prop, confusion, captureAtBudget, fmt, MIN_POSITIVES };
