#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { runStudy, analyseChange, toCsv, summarize } = require("../lib/study");
const { compile } = require("../lib/risk");
const { policyFor, OVERLAY } = require("../lib/policy");
const { renderPr } = require("../lib/report");
const { git, resolveCommit } = require("../lib/git");
const { suggest } = require("../lib/suggest");
const update = require("../lib/update");
const VERSION = require("../package.json").version;

const USAGE = `change-evidence ${VERSION}: evidence for pull requests, read from git as data. It never runs the code it judges.

Usage: change-evidence <command> [options]

  pr <repo> --base SHA --head SHA [--out DIR] [--github] [--policy FILE] [--overlay FILE] [--fail-on high|medium]
      One pull request, diffed from the merge base, judged by the policy on the base branch
      tip. Writes report.md and evidence.json. --github also writes the step summary and a
      \`tier\` output. Reports only (exit 0) unless --fail-on is given.

  init [repo] [--write] [--force] [--trigger] [--integrity sha512-…]
      The shadow-mode GitHub integration: two workflows, a no-permission trigger on
      pull_request and a reporter on workflow_run that GitHub runs from the default branch.
      --write creates both in .github/workflows/. Without it, the reporter is printed and
      --trigger prints the trigger. Pins this version and its published sha512.

  github-report [--workspace DIR] [--out DIR] [--no-status]
      Used by the reporter workflow: validates the workflow_run event, finds the open PR
      with exactly that head commit, fetches it as git objects, evaluates it, and posts one
      comment and an informational commit status. Exit 3 means input was refused.

  suggest [repo] [--budget 0.2] [--write] [--force]
      Propose a ${OVERLAY} for this repository: a size threshold from its own PR history,
      policy and middleware folders the defaults miss, global (tenant) scopes, and payment
      code. Size is only loosened when the default flags more than --budget (default 0.2)
      of your PRs; pass --budget to tighten it too. --write saves it; review it, then
      commit it in its own PR.

  upgrade [repo] [--to VERSION] [--integrity sha512-…] [--check] [--workflow FILE]
      Move the workflow's pinned version and integrity to the latest release (or --to). A
      workflow that is an unmodified shipped template is refreshed whole; one still on
      pull_request_target is migrated, and the trigger workflow is added. --check only reports, and exits 1 if
      out of date. Run it with the latest CLI: npx @semeton/change-evidence@latest upgrade

  study <repo> [--out DIR] [--since DATE] [--limit N] [--policy FILE] [--followup-days N] [--ref REF]
      Replay merged PRs; write study.csv, study.json and summary.md.

  change <repo> <base> <head> [--policy FILE]
      Evidence and risk for one diff, as JSON.

Options: -h, --help   show this help        -v, --version   print the version

Exit codes: 0 ok · 1 tier at or above --fail-on, upgrade --check found a newer version, or github-report failed · 2 usage or repository error · 3 github-report refused its input`;

const FLAGS = new Set(["help", "github", "version", "write", "force", "check", "trigger", "no-status"]);
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
    if (opt.trigger) {
      process.stdout.write(update.renderTemplates(VERSION, `sha512-${"A".repeat(86)}==`).trigger);
      return 0;
    }
    // Pin this exact version and its published tarball's sha512.
    const integrity = opt.integrity || ((await update.registryInfo(VERSION)) || {}).integrity;
    if (!update.SHA512.test(String(integrity))) {
      console.error(`couldn't find the published integrity of ${update.NAME}@${VERSION} on the npm registry; pass --integrity sha512-…`);
      return 2;
    }
    const t = update.renderTemplates(VERSION, integrity);
    if (!opt.write) {
      process.stdout.write(t.workflow);
      console.error(`\nThis workflow needs its trigger too. Write both with: change-evidence init --write\n(or: change-evidence init --trigger > .github/workflows/${update.TRIGGER_NAME})`);
      return 0;
    }
    const cwd = repoDir(repo);
    const dir = path.join(cwd, ".github", "workflows");
    const files = [[path.join(dir, "change-evidence.yml"), t.workflow], [path.join(dir, update.TRIGGER_NAME), t.trigger]];
    const existing = files.filter(([f]) => fs.existsSync(f));
    if (existing.length && !opt.force) {
      console.error(`${existing.map(([f]) => path.relative(cwd, f)).join(" and ")} already exist${existing.length === 1 ? "s" : ""}. To move an existing install forward, use: change-evidence upgrade (or --force to overwrite)`);
      return 2;
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, content] of files) fs.writeFileSync(f, content);
    console.log(`Wrote ${files.map(([f]) => path.relative(cwd, f)).join(" and ")}, pinned to ${VERSION}.`);
    console.log(`Merge them to the default branch in their own PR: change-evidence reports on PRs opened after that.`);
    return 0;
  }

  if (cmd === "github-report") {
    const { githubReport, TrustError } = require("../lib/github");
    try {
      const r = await githubReport({ workspace: opt.workspace, out: opt.out, version: VERSION, status: !opt["no-status"], log: (m) => console.log(`change-evidence: ${m}`) });
      return r.status === "reported" || r.status === "skipped" ? 0 : 1;
    } catch (e) {
      // A trust-boundary failure is reported loudly and nothing is posted.
      console.error(`::error::change-evidence: ${e instanceof TrustError ? "refused: " : ""}${e.message}`);
      return e instanceof TrustError ? 3 : 1;
    }
  }

  if (cmd === "upgrade") {
    const cwd = repoDir(repo);
    const file = update.findWorkflow(cwd, opt.workflow);
    if (!file || !fs.existsSync(file)) {
      console.error(`no workflow pins ${update.NAME}. Create one with: change-evidence init --write`);
      return 2;
    }
    const info = opt.to ? (opt.integrity ? { version: opt.to, integrity: opt.integrity } : await update.registryInfo(opt.to)) : await update.registryInfo("latest");
    if (!info || !info.version) {
      console.error(`couldn't reach the npm registry for ${opt.to ? `${update.NAME}@${opt.to}` : "the latest version"}; pass --to <version> --integrity sha512-…`);
      return 2;
    }
    const r = update.upgradeWorkflow(file, { target: info.version, integrity: info.integrity, current: VERSION, check: !!opt.check });
    const rel = path.relative(cwd, file);
    for (const w of r.warnings || []) console.log(`  ! ${w}`);
    if (r.status === "no-pin") {
      console.error(`${rel} doesn't pin a version with CHANGE_EVIDENCE: "${update.NAME}@<version>"`);
      return 2;
    }
    if (r.status === "no-integrity") {
      console.error(`no sha512 integrity for ${update.NAME}@${r.target}; pass --integrity sha512-…`);
      return 2;
    }
    if (r.status === "current") console.log(`${rel}: already on ${r.pinned}`);
    else if (r.status === "newer-pinned") console.log(`${rel}: pins ${r.pinned}, newer than ${r.target}; left as is`);
    else if (r.status === "outdated") {
      console.log(`${rel}: pins ${r.pinned}; ${r.target} is available`);
      return 1;
    } else {
      console.log(`${rel}: ${r.pinned} → ${r.target}${r.refreshed ? " (workflow refreshed from the template)" : ""}`);
      if (r.migrated) console.log(`  Migrated from pull_request_target to the trigger + workflow_run design (docs/security.md).`);
      if (r.trigger) console.log(`  ${r.trigger === "added" ? "Added" : "Refreshed"} ${path.relative(cwd, r.triggerFile)}.`);
      if (r.customised) console.log(`  The workflow differs from the stock templates, so only the pin and integrity moved. Compare with: npx ${update.NAME}@${r.target} init`);
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
    const baseSha = resolveCommit(cwd, opt.base);
    const headSha = resolveCommit(cwd, opt.head);
    // Judge what the PR introduces: diff from the merge base, not from the base tip.
    const mergeBase = (git(cwd, ["merge-base", baseSha, headSha], { allowFail: true }) || "").trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) {
      console.error(`no merge base between ${opt.base} and ${opt.head}: unrelated histories`);
      return 2;
    }
    // Policy from the base branch tip: the newest rules a maintainer has merged.
    const { policy, error } = policyFor(cwd, baseSha, { policyFile: opt.policy, overlayFile: opt.overlay });
    const result = analyseChange(cwd, mergeBase, headSha, compile(policy));
    const mode = opt["fail-on"] ? "enforce" : "shadow";
    const md = renderPr({ result, base: mergeBase, head: headSha, policy, version: VERSION, mode, policyError: error });
    const json = { version: 1, evaluator: VERSION, mode, base: mergeBase, head: headSha, policy: { name: policy.name, version: policy.version, overlay: policy.overlay || null }, files: result.files.length, lines: result.lines, risk: result.risk, evidence: result.evidence };
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
    const r = analyseChange(cwd, resolveCommit(cwd, base), resolveCommit(cwd, head), compile(loadPolicy(opt.policy)));
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
