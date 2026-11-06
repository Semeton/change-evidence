"use strict";

// Independent human labels, collected blind.
//
// `study --export-sample FILE` writes two files:
//   FILE           what the labeller sees: PR number, title, link, size. No tier, no rules,
//                  no outcome proxy. Rows are shuffled, so order says nothing either.
//   FILE.key.json  what the study needs to join labels back: sample id → PR, and the
//                  stratum each was drawn from. Keep it away from the labeller.
// The sample is stratified by tier (an equal share from each, as far as each tier allows),
// so low-tier PRs are examined: that is where a miss would hide. Because strata are
// sampled at different rates, population estimates are weighted by stratum size.
//
// The labeller answers one question per PR, from its diff: did this change warrant a
// careful human review before merge (it touches security, data integrity, money,
// infrastructure, or is likely to break something)? `risky`, `fine` or `unsure`.
//
// `study --labels FILE` reads the labelled file and its key and reports, per tier, the
// share judged risky, and how the tool and the outcome proxies agree with the humans.

const fs = require("fs");
const { prop } = require("./metrics");

// Deterministic PRNG (mulberry32), so a seed reproduces the same sample.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const t = String(text).replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

function toCsvRows(objs) {
  if (!objs.length) return "";
  const cols = Object.keys(objs[0]);
  const esc = (v) => {
    const s = String(v ?? "");
    // Leading = + - @ would be formulas in a spreadsheet; quote and prefix them.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) || safe !== s ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [cols.join(","), ...objs.map((o) => cols.map((c) => esc(o[c])).join(","))].join("\n") + "\n";
}

// Choose `size` rows, stratified by tier. Returns [{ row, stratum }].
function sample(rows, { size = 60, seed = 1 } = {}) {
  const rand = rng(seed);
  const strata = ["low", "medium", "high"].map((t) => ({ t, pool: shuffle(rows.filter((r) => r.risk.tier === t), rand) }));
  const picked = [];
  let left = Math.min(size, rows.length);
  // Round-robin across strata until the budget runs out or the strata do.
  while (left > 0 && strata.some((s) => s.pool.length)) {
    for (const s of strata) {
      if (!left) break;
      const r = s.pool.shift();
      if (r) {
        picked.push({ row: r, stratum: s.t });
        left--;
      }
    }
  }
  return shuffle(picked, rand);
}

function exportSample(rows, file, { size, seed, repository, policy, url }) {
  const chosen = sample(rows, { size, seed });
  const strataSize = Object.fromEntries(["low", "medium", "high"].map((t) => [t, rows.filter((r) => r.risk.tier === t).length]));
  const items = chosen.map(({ row, stratum }, i) => ({ id: `S${String(i + 1).padStart(3, "0")}`, row, stratum }));
  const sheet = items.map(({ id, row }) => ({
    sample_id: id,
    pr: row.pr,
    merged: row.date.slice(0, 10),
    title: row.title,
    link: url ? `${url}/pull/${row.pr}` : "",
    files: row.counted ? row.counted.files : row.files.length,
    changed_lines: row.counted ? row.counted.added + row.counted.removed : row.lines.added + row.lines.removed,
    judgement: "",
    notes: "",
  }));
  fs.writeFileSync(file, toCsvRows(sheet));
  const key = {
    version: 1,
    question: "Did this change warrant a careful human review before merge (it touches security, data integrity, money, infrastructure, or is likely to break something)? Answer risky, fine or unsure.",
    repository: repository || null,
    policy,
    seed,
    population: rows.length,
    strata: strataSize,
    items: Object.fromEntries(items.map(({ id, row, stratum }) => [id, { pr: row.pr, sha: row.sha, stratum }])),
  };
  fs.writeFileSync(`${file}.key.json`, JSON.stringify(key, null, 1) + "\n");
  return { file, key: `${file}.key.json`, size: items.length };
}

// Join a labelled sheet to the study rows. Returns { labelled: [{ row, stratum, judgement }], key, problems }.
function readLabels(file, rows, keyFile = `${file}.key.json`) {
  const problems = [];
  if (!fs.existsSync(keyFile)) throw new Error(`the sample key ${keyFile} is missing; it was written next to the exported sample`);
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  const labelled = [];
  for (const rec of parseCsv(fs.readFileSync(file, "utf8"))) {
    const k = key.items[rec.sample_id];
    if (!k) {
      problems.push(`${rec.sample_id || "(blank id)"}: not in the key`);
      continue;
    }
    const j = String(rec.judgement || "").toLowerCase();
    if (!["risky", "fine", "unsure"].includes(j)) {
      if (j) problems.push(`${rec.sample_id}: judgement "${rec.judgement}" isn't risky, fine or unsure`);
      continue;
    }
    const row = bySha.get(k.sha);
    if (!row) {
      problems.push(`${rec.sample_id}: PR #${k.pr} isn't in this study (different history or window?)`);
      continue;
    }
    labelled.push({ row, stratum: k.stratum, judgement: j });
  }
  return { labelled, key, problems };
}

// Per-tier risky rates (each stratum is a simple random sample, so these are unbiased
// within the tier) and weighted population estimates of what the tool catches.
function assessLabels({ labelled, key }) {
  const usable = labelled.filter((l) => l.judgement !== "unsure");
  const perTier = {};
  for (const t of ["low", "medium", "high"]) {
    const g = usable.filter((l) => l.stratum === t);
    perTier[t] = { population: key.strata[t] || 0, labelled: g.length, risky: prop(g.filter((l) => l.judgement === "risky").length, g.length) };
  }
  // Weighted estimate of recall: share of all risky PRs (population) that are flagged.
  let riskyFlagged = 0;
  let riskyAll = 0;
  for (const t of ["low", "medium", "high"]) {
    const s = perTier[t];
    if (!s.labelled) continue;
    const est = (s.risky.value || 0) * s.population;
    riskyAll += est;
    if (t !== "low") riskyFlagged += est;
  }
  return {
    labelled: labelled.length,
    unsure: labelled.length - usable.length,
    perTier,
    weighted_recall: riskyAll ? riskyFlagged / riskyAll : null,
    exploratory: usable.filter((l) => l.judgement === "risky").length < 20,
  };
}

module.exports = { rng, shuffle, parseCsv, toCsvRows, sample, exportSample, readLabels, assessLabels };
