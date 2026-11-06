"use strict";

// The privileged half of the GitHub integration (`change-evidence github-report`).
//
// It runs in a `workflow_run` job: GitHub runs that workflow file from the DEFAULT BRANCH,
// with a token that can comment, after the unprivileged `pull_request` trigger workflow
// finishes. Nothing produced by the PR's workflow is consumed: no artifact, no output, no
// log. The only input is the event payload GitHub generates, and every field read from it
// is validated, then cross-checked against the API, before use. The evaluator then reads
// the PR's commits as git objects, exactly as `pr` does: nothing from the PR is checked
// out, installed, built or run.
//
// See docs/security.md for the threat model.

const fs = require("fs");
const path = require("path");
const { git } = require("./git");
const { policyFor } = require("./policy");
const { analyseChange } = require("./study");
const { compile } = require("./risk");
const { renderPr } = require("./report");
const { finalizeComment, MARKER } = require("./markdown");

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const DEFAULT_BOT = "github-actions[bot]";

class TrustError extends Error {}

const isSha = (s) => typeof s === "string" && SHA.test(s);
const isPrNumber = (n) => Number.isSafeInteger(n) && n > 0 && n < 1e9;
const isRepo = (s) => typeof s === "string" && REPO.test(s) && !s.includes("..");

function must(cond, msg) {
  if (!cond) throw new TrustError(msg);
}

// --- GitHub REST, with no dependencies -------------------------------------------------

function apiBase(env) {
  const u = new URL(env.GITHUB_API_URL || "https://api.github.com");
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  must(u.protocol === "https:" || (u.protocol === "http:" && loopback), `GITHUB_API_URL must be https (got ${u.protocol})`);
  return u.toString().replace(/\/$/, "");
}

function makeApi(env) {
  const base = apiBase(env);
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  must(token, "GITHUB_TOKEN is not set");
  return function api(method, route, body) {
    const url = new URL(base + route);
    const lib = url.protocol === "http:" ? require("http") : require("https");
    const payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "change-evidence",
            ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          },
          timeout: 20000,
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => {
            data += c;
            if (data.length > 20 * 1024 * 1024) req.destroy(new Error("GitHub API response too large"));
          });
          res.on("end", () => {
            let json = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              // leave null
            }
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(Object.assign(new Error(`GitHub API ${method} ${url.pathname} → ${res.statusCode}${json && json.message ? `: ${json.message}` : ""}`), { status: res.statusCode }));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`GitHub API ${method} ${url.pathname} timed out`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  };
}

// --- Trust boundary: the event ---------------------------------------------------------

// What the trigger run claims about itself, validated. Nothing here is trusted yet: it
// only says which commit to look for. `head_branch` and `display_title` are never used.
function readWorkflowRunEvent(event, repo) {
  must(event && typeof event === "object", "event payload is not an object");
  const run = event.workflow_run;
  must(run && typeof run === "object", "not a workflow_run event");
  must(run.event === "pull_request", `the triggering run was a '${String(run.event).slice(0, 40)}' event, not pull_request`);
  must(isSha(run.head_sha), "workflow_run.head_sha is not a 40-character SHA");
  must(run.repository && run.repository.full_name === repo, "workflow_run.repository is not this repository");
  const headRepo = run.head_repository && run.head_repository.full_name;
  must(headRepo === undefined || headRepo === null || isRepo(headRepo), "workflow_run.head_repository.full_name is malformed");
  // Same-repository runs list their PRs; fork runs list none (a GitHub limitation).
  const hinted = Array.isArray(run.pull_requests) ? run.pull_requests.map((p) => p && p.number).filter(isPrNumber) : [];
  return { headSha: run.head_sha, headRepo: headRepo || null, fork: !!headRepo && headRepo !== repo, hinted: [...new Set(hinted)].slice(0, 5), runId: run.id };
}

// Back-compat for workflows still on pull_request_target: the payload is the PR itself,
// but it is still cross-checked against the API like any other claim.
function readPullRequestTargetEvent(event) {
  const pr = event && event.pull_request;
  must(pr && isPrNumber(pr.number), "pull_request.number is missing or malformed");
  must(pr.head && isSha(pr.head.sha), "pull_request.head.sha is not a 40-character SHA");
  return { headSha: pr.head.sha, headRepo: pr.head.repo ? pr.head.repo.full_name : null, hinted: [pr.number] };
}

// Find the open PR on THIS repository whose head is exactly `headSha`. Every candidate is
// re-read from the API, so a payload can't point the reporter at a PR it doesn't match.
async function resolvePr(api, repo, claim) {
  const candidates = new Set(claim.hinted);
  if (!candidates.size) {
    try {
      for (const p of (await api("GET", `/repos/${repo}/commits/${claim.headSha}/pulls?per_page=10`)) || []) if (isPrNumber(p.number)) candidates.add(p.number);
    } catch {
      // fall through to the head-label search
    }
  }
  if (!candidates.size && claim.headRepo && isRepo(claim.headRepo)) {
    const owner = claim.headRepo.split("/")[0];
    const open = (await api("GET", `/repos/${repo}/pulls?state=open&per_page=100&sort=updated&direction=desc`)) || [];
    for (const p of open) if (p && p.head && p.head.sha === claim.headSha && p.head.repo && p.head.repo.owner && p.head.repo.owner.login === owner && isPrNumber(p.number)) candidates.add(p.number);
  }
  for (const n of [...candidates].slice(0, 10)) {
    let pr;
    try {
      pr = await api("GET", `/repos/${repo}/pulls/${n}`);
    } catch (e) {
      if (e.status === 404) continue; // a hint that names no PR here is just a non-match
      throw e;
    }
    if (!pr || pr.number !== n) continue;
    if (pr.state !== "open") continue;
    if (!pr.base || !pr.base.repo || pr.base.repo.full_name !== repo) continue;
    if (!pr.head || pr.head.sha !== claim.headSha) continue; // pushed again since: a newer run will report
    must(isSha(pr.base.sha), "API returned a malformed base SHA");
    must(typeof pr.base.ref === "string" && /^[A-Za-z0-9._/-]{1,250}$/.test(pr.base.ref) && !pr.base.ref.includes(".."), "API returned an unusual base ref");
    return { number: n, headSha: pr.head.sha, baseRef: pr.base.ref, baseSha: pr.base.sha, draft: !!pr.draft, fork: !!(pr.head.repo && pr.head.repo.full_name !== repo) };
  }
  return null;
}

// --- Git: fetch the PR as objects only -------------------------------------------------

// Credentials for the fetch go through GIT_CONFIG_* environment variables, not argv,
// and are never written to .git/config (the checkout uses persist-credentials: false).
function authEnv(env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token || env.CHANGE_EVIDENCE_GIT_NO_AUTH) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}` };
}

function fetchPr(cwd, pr, env) {
  // Objects only: these refs are never checked out.
  git(cwd, ["fetch", "--no-tags", "--no-recurse-submodules", "--quiet", "origin", `+refs/pull/${pr.number}/head:refs/change-evidence/head`, `+refs/heads/${pr.baseRef}:refs/change-evidence/base`], { env: authEnv(env) });
  const head = git(cwd, ["rev-parse", "--verify", "--quiet", "refs/change-evidence/head^{commit}"], { allowFail: true });
  must(head && head.trim() === pr.headSha, "the PR head moved while this run was starting; the run for the new head will report");
  const base = git(cwd, ["rev-parse", "--verify", "refs/change-evidence/base^{commit}"]).trim();
  must(isSha(base), "could not resolve the base branch");
  return { head: pr.headSha, base };
}

// --- Reporting -------------------------------------------------------------------------

async function upsertComment(api, repo, number, body, bot) {
  let mine = null;
  for (let page = 1; page <= 10 && !mine; page++) {
    const comments = (await api("GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`)) || [];
    // Only a comment this bot wrote counts: anyone can paste the marker into their own.
    mine = comments.find((c) => c && c.user && c.user.login === bot && c.user.type === "Bot" && typeof c.body === "string" && c.body.trimEnd().endsWith(MARKER)) || null;
    if (comments.length < 100) break;
  }
  if (mine) {
    await api("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
    return { action: "updated", id: mine.id };
  }
  const created = await api("POST", `/repos/${repo}/issues/${number}/comments`, { body });
  return { action: "created", id: created && created.id };
}

async function postStatus(api, repo, sha, tier) {
  const description = `${tier} review priority (shadow mode: informational)`.slice(0, 140);
  await api("POST", `/repos/${repo}/statuses/${sha}`, { state: "success", context: "change-evidence", description });
}

// Entry point. Returns { status, ... } and never throws on an expected skip.
async function githubReport({ env = process.env, workspace, out, version, status = true, log = () => {} }) {
  const repo = env.GITHUB_REPOSITORY;
  must(isRepo(repo), "GITHUB_REPOSITORY is missing or malformed");
  const eventName = env.GITHUB_EVENT_NAME;
  must(env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH), "GITHUB_EVENT_PATH is missing");
  const raw = fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8");
  must(raw.length < 25 * 1024 * 1024, "event payload is implausibly large");
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new TrustError("event payload is not JSON");
  }
  let claim;
  if (eventName === "workflow_run") claim = readWorkflowRunEvent(event, repo);
  else if (eventName === "pull_request_target") claim = readPullRequestTargetEvent(event);
  else throw new TrustError(`github-report runs on workflow_run (got '${String(eventName).slice(0, 40)}')`);

  const cwd = path.resolve(workspace || env.GITHUB_WORKSPACE || ".");
  must(fs.existsSync(path.join(cwd, ".git")), `not a git repository: ${cwd}`);
  const api = makeApi(env);
  const pr = await resolvePr(api, repo, claim);
  if (!pr) {
    log(`no open pull request on ${repo} has head ${claim.headSha}; nothing to report`);
    return { status: "skipped", reason: "no-matching-pr" };
  }
  const { base, head } = fetchPr(cwd, pr, env);
  const mergeBase = git(cwd, ["merge-base", base, head]).trim();
  must(isSha(mergeBase), "no merge base between the PR and its base branch");
  const { policy, error } = policyFor(cwd, base);
  const result = analyseChange(cwd, mergeBase, head, compile(policy));
  const md = renderPr({ result, base: mergeBase, head, policy, version, mode: "shadow", policyError: error });
  const body = finalizeComment(md);

  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "report.md"), body);
    fs.writeFileSync(
      path.join(out, "evidence.json"),
      JSON.stringify({ version: 1, evaluator: version, mode: "shadow", repository: repo, pull_request: pr.number, fork: pr.fork, base: mergeBase, head, policy: { name: policy.name, version: policy.version, overlay: policy.overlay || null }, files: result.files.length, lines: result.lines, risk: result.risk, evidence: result.evidence }, null, 1),
    );
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `tier=${result.risk.tier}\npull_request=${pr.number}\n`);
  const comment = await upsertComment(api, repo, pr.number, body, env.CHANGE_EVIDENCE_BOT_LOGIN || DEFAULT_BOT);
  if (status) await postStatus(api, repo, head, result.risk.tier);
  log(`#${pr.number}${pr.fork ? " (fork)" : ""}: ${result.risk.tier}; comment ${comment.action}`);
  return { status: "reported", pr: pr.number, tier: result.risk.tier, comment: comment.action, fork: pr.fork };
}

module.exports = { githubReport, readWorkflowRunEvent, readPullRequestTargetEvent, resolvePr, upsertComment, makeApi, isSha, isRepo, isPrNumber, TrustError };
