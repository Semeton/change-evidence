#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { runStudy, analyseChange, toCsv, summarize } = require("../lib/study");
const { compile } = require("../lib/risk");
const { policyFor } = require("../lib/policy");
const { renderPr } = require("../lib/report");
const { git } = require("../lib/git");
const VERSION = require("../package.json").version;

const USAGE = `change-evidence: phase 1 study tool (read-only; never runs the code it studies)

  change-evidence study <repo> [--out DIR] [--since DATE] [--limit N]
                              [--policy FILE] [--followup-days N] [--ref REF]
      Replay merged PRs on the main line, write study.csv, study.json and summary.md.

  change-evidence pr <repo> --base SHA --head SHA [--out DIR] [--github]
                           [--policy FILE] [--overlay FILE] [--fail-on high|medium]
      Evidence and risk for one pull request, judged from the merge base. Writes
      report.md and evidence.json. The repo overlay (.change-evidence.json) is read
      from the base branch tip. --github also writes the GitHub step summary and outputs.
      Reports only (exit 0) unless --fail-on is given.

  change-evidence change <repo> <base> <head> [--policy FILE]
      Evidence and risk for one change, as JSON.

  change-evidence init
      Print the shadow-mode GitHub workflow, to save as .github/workflows/change-evidence.yml.

Exit codes: 0 ok, 1 tier at or above --fail-on, 2 usage or repository error.`;

function args(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      if (k === "help" || k === "github") opt[k] = true;
      else opt[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

function loadPolicy(file) {
  const p = file ? path.resolve(file) : path.join(__dirname, "..", "policies", "laravel.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  const { pos, opt } = args(process.argv.slice(2));
  const [cmd, repo, ...rest] = pos;
  if (cmd === "init") {
    process.stdout.write(fs.readFileSync(path.join(__dirname, "..", "templates", "change-evidence.yml"), "utf8"));
    return 0;
  }
  if (opt.help || !cmd || !repo) {
    console.log(USAGE);
    return opt.help ? 0 : 2;
  }
  const cwd = path.resolve(repo);
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.error(`not a git repository: ${cwd}`);
    return 2;
  }
  if (cmd === "pr") {
    if (!opt.base || !opt.head) {
      console.error("pr needs --base and --head");
      return 2;
    }
    // Judge what the PR introduces: diff from the merge base, not from the base tip.
    const mergeBase = git(cwd, ["merge-base", opt.base, opt.head]).trim();
    // Policy from the base branch tip: the newest rules a maintainer has merged.
    const { policy, error } = policyFor(cwd, opt.base, { policyFile: opt.policy, overlayFile: opt.overlay });
    const result = analyseChange(cwd, mergeBase, opt.head, compile(policy));
    const mode = opt["fail-on"] ? "enforce" : "shadow";
    const md = renderPr({ result, base: mergeBase, head: opt.head, policy, version: VERSION, mode, policyError: error });
    const json = { version: 1, evaluator: VERSION, mode, base: mergeBase, head: opt.head, policy: { name: policy.name, version: policy.version, overlay: policy.overlay || null }, files: result.files.length, lines: result.lines, risk: result.risk, evidence: result.evidence };
    const out = path.resolve(opt.out || ".");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "report.md"), md);
    fs.writeFileSync(path.join(out, "evidence.json"), JSON.stringify(json, null, 1));
    if (opt.github) {
      if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
      if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tier=${result.risk.tier}\n`);
    }
    console.log(`change-evidence: ${result.risk.tier} (${result.files.length} files) → ${out}/report.md`);
    const order = ["low", "medium", "high"];
    if (opt["fail-on"] && order.indexOf(result.risk.tier) >= order.indexOf(opt["fail-on"])) return 1;
    return 0;
  }
  const policy = loadPolicy(opt.policy);
  if (cmd === "change") {
    const [base, head] = rest;
    if (!base || !head) {
      console.error(USAGE);
      return 2;
    }
    const r = analyseChange(cwd, base, head, compile(policy));
    console.log(JSON.stringify({ version: 1, base, head, files: r.files.length, lines: r.lines, risk: r.risk, evidence: r.evidence }, null, 2));
    return 0;
  }
  if (cmd === "study") {
    const out = path.resolve(opt.out || "change-evidence-study");
    fs.mkdirSync(out, { recursive: true });
    const started = Date.now();
    const study = runStudy(cwd, {
      ref: opt.ref || "HEAD",
      since: opt.since,
      limit: opt.limit ? Number(opt.limit) : undefined,
      policy,
      followupDays: opt["followup-days"] ? Number(opt["followup-days"]) : 14,
      onProgress: process.stderr.isTTY ? (i, n) => process.stderr.write(`\r  ${i}/${n} PRs`) : undefined,
    });
    if (process.stderr.isTTY) process.stderr.write("\n");
    fs.writeFileSync(path.join(out, "study.csv"), toCsv(study.rows));
    const json = { version: 1, ...study, rows: study.rows.map(({ body, ...r }) => r) };
    fs.writeFileSync(path.join(out, "study.json"), JSON.stringify(json, null, 1));
    fs.writeFileSync(path.join(out, "summary.md"), summarize(study));
    console.log(`${study.rows.length} PRs in ${((Date.now() - started) / 1000).toFixed(0)}s → ${out}/{study.csv,study.json,summary.md}`);
    return 0;
  }
  console.error(USAGE);
  return 2;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}
