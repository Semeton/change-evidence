#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { runStudy, analyseChange, toCsv, summarize } = require("../lib/study");
const { compile } = require("../lib/risk");
const { policyFor, OVERLAY } = require("../lib/policy");
const { renderPr } = require("../lib/report");
const { git } = require("../lib/git");
const { suggest } = require("../lib/suggest");
const update = require("../lib/update");
const VERSION = require("../package.json").version;

const USAGE = `change-evidence ${VERSION}: evidence for pull requests, read from git as data. It never runs the code it judges.

Usage: change-evidence <command> [options]

  pr <repo> --base SHA --head SHA [--out DIR] [--github] [--policy FILE] [--overlay FILE] [--fail-on high|medium]
      One pull request, diffed from the merge base, judged by the policy on the base branch
      tip. Writes report.md and evidence.json. --github also writes the step summary and a
      \`tier\` output. Reports only (exit 0) unless --fail-on is given.

  init
      Print the shadow-mode GitHub workflow:
        change-evidence init > .github/workflows/change-evidence.yml

  suggest [repo] [--budget 0.2] [--write] [--force]
      Propose a ${OVERLAY} for this repository: a size threshold from its own PR history,
      policy and middleware folders the defaults miss, global (tenant) scopes, and payment
      code. Size is only loosened when the default flags more than --budget (default 0.2)
      of your PRs; pass --budget to tighten it too. --write saves it; review it, then
      commit it in its own PR.

  upgrade [repo] [--to VERSION] [--check] [--workflow FILE]
      Move the workflow's pinned version to the latest release (or --to). A workflow that is
      still the stock template is refreshed whole. --check only reports, and exits 1 if
      out of date. Run it with the latest CLI: npx @semeton/change-evidence@latest upgrade

  study <repo> [--out DIR] [--since DATE] [--limit N] [--policy FILE] [--followup-days N] [--ref REF]
      Replay merged PRs; write study.csv, study.json and summary.md.

  change <repo> <base> <head> [--policy FILE]
      Evidence and risk for one diff, as JSON.

Options: -h, --help   show this help        -v, --version   print the version

Exit codes: 0 ok · 1 tier at or above --fail-on, or upgrade --check found a newer version · 2 usage or repository error`;

const FLAGS = new Set(["help", "github", "version", "write", "force", "check"]);
const SHORT = { h: "help", v: "version" };

function args(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    let k = null;
    if (a.startsWith("--")) k = a.slice(2);
    else if (/^-[a-zA-Z]$/.test(a)) k = SHORT[a[1]] || a.slice(1);
    if (k === null) {
      pos.push(a);
      continue;
    }
    const eq = k.indexOf("=");
    if (eq !== -1) opt[k.slice(0, eq)] = k.slice(eq + 1);
    else if (FLAGS.has(k)) opt[k] = true;
    else if (i + 1 < argv.length) opt[k] = argv[++i];
    else throw new Error(`--${k} needs a value`);
  }
  return { pos, opt };
}

function loadPolicy(file) {
  const p = file ? path.resolve(file) : path.join(__dirname, "..", "policies", "laravel.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function repoDir(repo) {
  const cwd = path.resolve(repo || ".");
  if (!fs.existsSync(path.join(cwd, ".git"))) throw Object.assign(new Error(`not a git repository: ${cwd}`), { exit: 2 });
  return cwd;
}

async function main(argv) {
  const { pos, opt } = args(argv);
  const [cmd, repo, ...rest] = pos;
  if (opt.version || cmd === "version") {
    console.log(VERSION);
    return 0;
  }
  if (opt.help || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (!cmd) {
    console.error(USAGE);
    return 2;
  }

  if (cmd === "init") {
    process.stdout.write(fs.readFileSync(path.join(__dirname, "..", "templates", "change-evidence.yml"), "utf8"));
    return 0;
  }

  if (cmd === "upgrade") {
    const cwd = repoDir(repo);
    const file = update.findWorkflow(cwd, opt.workflow);
    if (!file || !fs.existsSync(file)) {
      console.error(`no workflow pins ${update.NAME}. Create one with: change-evidence init > .github/workflows/change-evidence.yml`);
      return 2;
    }
    const target = opt.to || (await update.latestVersion());
    if (!target) {
      console.error("couldn't reach the npm registry to find the latest version; pass --to <version>");
      return 2;
    }
    const r = update.upgradeWorkflow(file, { target, current: VERSION, check: !!opt.check });
    const rel = path.relative(cwd, file);
    if (r.status === "no-pin") {
      console.error(`${rel} doesn't pin a version with CHANGE_EVIDENCE: "${update.NAME}@<version>"`);
      return 2;
    }
    if (r.status === "current") console.log(`${rel}: already on ${r.pinned}`);
    else if (r.status === "newer-pinned") console.log(`${rel}: pins ${r.pinned}, newer than ${r.target}; left as is`);
    else if (r.status === "outdated") {
      console.log(`${rel}: pins ${r.pinned}; ${r.target} is available`);
      return 1;
    } else {
      console.log(`${rel}: ${r.pinned} → ${r.target}${r.refreshed ? " (workflow refreshed from the template)" : ""}`);
      if (r.customised) console.log(`  The workflow differs from the stock template, so only the pin moved. Compare with: npx ${update.NAME}@${r.target} init`);
      else if (VERSION !== r.target) console.log(`  Only the pin moved. To also pick up template changes, run: npx ${update.NAME}@${r.target} upgrade`);
      console.log(`  Review the diff and commit it in its own PR: the evaluator is part of your trust root.`);
    }
    return 0;
  }

  if (cmd === "suggest") {
    const cwd = repoDir(repo);
    const { policy } = policyFor(cwd, "HEAD", { policyFile: opt.policy, overlayFile: opt.overlay });
    const budget = opt.budget ? Number(opt.budget) : 0.2;
    if (!(budget > 0 && budget < 1)) {
      console.error("--budget is a share between 0 and 1, e.g. 0.2");
      return 2;
    }
    const s = suggest(cwd, policy, { budget, budgetGiven: opt.budget !== undefined });
    for (const n of s.notes) console.error(`- ${n}`);
    if (!s.overlay) {
      console.error(`\nNothing to suggest: the defaults fit this repository.`);
      return 0;
    }
    const json = JSON.stringify(s.overlay, null, 2) + "\n";
    if (opt.write) {
      const target = path.join(cwd, opt.overlay || OVERLAY);
      if (fs.existsSync(target) && !opt.force) {
        console.error(`\n${path.relative(cwd, target)} already exists; printing the suggestion instead (--force to overwrite).\n`);
        process.stdout.write(json);
        return 0;
      }
      fs.writeFileSync(target, json);
      console.error(`\nWrote ${path.relative(cwd, target)}. Review it and commit it in its own PR: the overlay is trust root.`);
    } else process.stdout.write(json);
    return 0;
  }

  if (cmd === "pr") {
    const cwd = repoDir(repo);
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

  if (cmd === "change") {
    const cwd = repoDir(repo);
    const [base, head] = rest;
    if (!base || !head) {
      console.error("change needs <repo> <base> <head>");
      return 2;
    }
    const r = analyseChange(cwd, base, head, compile(loadPolicy(opt.policy)));
    console.log(JSON.stringify({ version: 1, base, head, files: r.files.length, lines: r.lines, risk: r.risk, evidence: r.evidence }, null, 2));
    return 0;
  }

  if (cmd === "study") {
    const cwd = repoDir(repo);
    const out = path.resolve(opt.out || "change-evidence-study");
    fs.mkdirSync(out, { recursive: true });
    const started = Date.now();
    const study = runStudy(cwd, {
      ref: opt.ref || "HEAD",
      since: opt.since,
      limit: opt.limit ? Number(opt.limit) : undefined,
      policy: loadPolicy(opt.policy),
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

  console.error(`unknown command: ${cmd}\nRun change-evidence --help for usage.`);
  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
    // `upgrade` already looked at the registry; `pr --github` runs in CI.
    const cmd = process.argv[2];
    if (code !== 2 && cmd !== "upgrade" && !/^(-v|--version|-h|--help)$/.test(cmd || "")) update.notify(VERSION);
  })
  .catch((e) => {
    console.error(e.message);
    process.exitCode = e.exit || 2;
  });
