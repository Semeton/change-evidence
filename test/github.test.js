"use strict";
// Adversarial end-to-end tests for `github-report`, the privileged half of the GitHub
// integration. A fake GitHub API runs on loopback and a local bare repository plays
// `origin`, with hostile pull-request content under refs/pull/N/head. No network.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFile, execFileSync } = require("child_process");
const { repo } = require("./helpers");
const { MARKER } = require("../lib/markdown");
const gh = require("../lib/github");

const BIN = path.join(__dirname, "..", "bin", "change-evidence.js");
const REPO = "acme/app";
const WIN = process.platform === "win32";

// origin (bare) with main, a hostile same-repo PR #7 and a fork PR #8; plus a workspace
// clone of main, as actions/checkout leaves it.
function fixture() {
  const t = repo();
  const base = t.commit("init", {
    "routes/web.php": "<?php\nRoute::middleware('auth')->group(function () {\n  Route::get('home', Home::class);\n});\n",
    "app/Models/Matter.php": "<?php\nclass Matter {}\n",
  });
  t.g("checkout", "-q", "-b", "pr7");
  const hostileUri = "x`|@octocat <img src=x onerror=alert(1)> " + MARKER + " #1";
  const files = {
    // A route whose URI is built to break Markdown, ping someone and forge the marker.
    "routes/web.php": `<?php\nRoute::get('home', Home::class);\nRoute::get('${hostileUri.replace(/'/g, "")}', Evil::class);\n`,
    // Things that would execute if anything installed, built or checked out the PR.
    "package.json": JSON.stringify({ name: "x", scripts: { postinstall: "node -e \"require('fs').writeFileSync(process.env.PWNED_PATH,'x')\"", preinstall: "touch PWNED" } }),
    ".npmrc": "registry=http://127.0.0.1:9/\n",
    ".gitattributes": "* filter=evil diff=evil\n",
    "app/Models/Matter.php": "<?php\nclass Matter { function all() { return static::withoutGlobalScopes()->get(); } }\n",
    [`app/a\`b|c @octocat ${MARKER}.php`]: "<?php\n",
  };
  if (!WIN) files["app/new\nline.php"] = "<?php\n";
  const head = t.commit("hostile", files);
  t.g("checkout", "-q", "main");
  t.g("checkout", "-q", "-b", "fork8");
  const forkHead = t.commit("fork change", { "app/Models/Matter.php": "<?php\nclass Matter { public $guarded = []; }\n" });
  t.g("checkout", "-q", "main");
  const origin = fs.mkdtempSync(path.join(os.tmpdir(), "ce-origin-"));
  execFileSync("git", ["clone", "-q", "--bare", t.dir, origin], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  const og = (...a) => execFileSync("git", ["-C", origin, ...a], { encoding: "utf8" });
  og("update-ref", "refs/pull/7/head", head);
  og("update-ref", "refs/pull/8/head", forkHead);
  og("update-ref", "-d", "refs/heads/pr7");
  og("update-ref", "-d", "refs/heads/fork8");
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ws-"));
  execFileSync("git", ["clone", "-q", origin, ws], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  return { base, head, forkHead, origin, ws, hostileUri };
}

// A fake GitHub API. `state` controls what it returns; every write is recorded.
function fakeGitHub(state) {
  const writes = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url, "http://x");
      const send = (code, json) => {
        res.statusCode = code;
        res.setEncoding?.("utf8");
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== "Bearer test-token") return send(401, { message: "bad token" });
      if (req.method !== "GET") writes.push({ method: req.method, path: u.pathname, body: body ? JSON.parse(body) : null });
      let m;
      if (req.method === "GET" && (m = /^\/repos\/acme\/app\/pulls\/(\d+)$/.exec(u.pathname))) {
        const pr = state.prs[m[1]];
        return pr ? send(200, pr) : send(404, { message: "Not Found" });
      }
      if (req.method === "GET" && (m = /^\/repos\/acme\/app\/commits\/([0-9a-f]{40})\/pulls$/.exec(u.pathname))) {
        return send(200, Object.values(state.prs).filter((p) => p.head.sha === m[1]).map((p) => ({ number: p.number })));
      }
      if (req.method === "GET" && u.pathname === "/repos/acme/app/pulls") return send(200, Object.values(state.prs));
      if (req.method === "GET" && /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(u.pathname)) return send(200, state.comments);
      if (req.method === "POST" && /^\/repos\/acme\/app\/issues\/\d+\/comments$/.test(u.pathname)) {
        const c = { id: 900 + state.comments.length, user: { login: "github-actions[bot]", type: "Bot" }, body: JSON.parse(body).body };
        state.comments.push(c);
        return send(201, c);
      }
      if (req.method === "PATCH" && (m = /^\/repos\/acme\/app\/issues\/comments\/(\d+)$/.exec(u.pathname))) {
        const c = state.comments.find((x) => String(x.id) === m[1]);
        if (!c) return send(404, {});
        c.body = JSON.parse(body).body;
        return send(200, c);
      }
      if (req.method === "POST" && /^\/repos\/acme\/app\/statuses\/[0-9a-f]{40}$/.test(u.pathname)) return send(201, {});
      send(404, { message: `unhandled ${req.method} ${u.pathname}` });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, writes, url: `http://127.0.0.1:${server.address().port}` })));
}

function pr(number, head, { base, state = "open", baseRepo = REPO, headRepo = REPO } = {}) {
  return { number, state, draft: false, head: { sha: head, repo: { full_name: headRepo, owner: { login: headRepo.split("/")[0] } } }, base: { ref: "main", sha: base, repo: { full_name: baseRepo } } };
}

function workflowRunEvent(headSha, { prs = [], headRepo = REPO, event = "pull_request", repository = REPO } = {}) {
  return {
    action: "completed",
    workflow_run: {
      id: 1,
      event,
      head_sha: headSha,
      head_branch: "$(touch PWNED_BRANCH)`id`;curl http://127.0.0.1:9",
      display_title: `${MARKER} @octocat`,
      pull_requests: prs.map((n) => ({ number: n })),
      repository: { full_name: repository },
      head_repository: { full_name: headRepo },
    },
  };
}

// Run the real CLI asynchronously (the fake API lives in this process).
function report(f, api, event, { eventName = "workflow_run", extraEnv = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-run-"));
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, typeof event === "string" ? event : JSON.stringify(event));
  const summary = path.join(dir, "summary.md");
  const pwned = path.join(dir, "PWNED");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BIN, "github-report", "--workspace", f.ws, "--out", path.join(dir, "out")],
      {
        cwd: dir,
        env: { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1", GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: "test-token", GITHUB_API_URL: api.url, GITHUB_STEP_SUMMARY: summary, CHANGE_EVIDENCE_GIT_NO_AUTH: "1", PWNED_PATH: pwned, ...extraEnv },
        timeout: 60000,
      },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr, dir, pwned }),
    );
  });
}

function assertNothingExecuted(f, r) {
  assert.ok(!fs.existsSync(r.pwned), "a PR install script ran");
  for (const d of [f.ws, r.dir, process.cwd()]) {
    assert.ok(!fs.existsSync(path.join(d, "PWNED")), `PWNED in ${d}`);
    assert.ok(!fs.existsSync(path.join(d, "PWNED_BRANCH")), `branch name executed in ${d}`);
  }
  // The workspace is still the default branch, with a clean worktree: nothing was checked out.
  const g = (...a) => execFileSync("git", ["-C", f.ws, ...a], { encoding: "utf8" }).trim();
  assert.equal(g("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(g("status", "--porcelain"), "");
  assert.ok(!fs.existsSync(path.join(f.ws, "package.json")), "PR files appeared in the worktree");
}

test("hostile same-repo PR: reported from git objects, nothing executes, report can't break out", async () => {
  const f = fixture();
  const state = {
    prs: { 7: pr(7, f.head, { base: f.base }) },
    // An attacker's own comment carrying the marker must never be treated as the bot's.
    comments: [{ id: 1, user: { login: "mallory", type: "User" }, body: `fake report\n${MARKER}` }],
  };
  const api = await fakeGitHub(state);
  try {
    const r = await report(f, api, workflowRunEvent(f.head, { prs: [7] }));
    assert.equal(r.code, 0, r.stderr);
    assertNothingExecuted(f, r);
    const posts = api.writes.filter((w) => w.path.endsWith("/comments"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].method, "POST", "must not PATCH the attacker's comment");
    assert.equal(state.comments[0].body, `fake report\n${MARKER}`, "attacker comment untouched");
    const body = posts[0].body.body;
    // What renders as prose: the body with every code span removed.
    const prose = body.replace(/(`+)[\s\S]*?\1/g, "");
    assert.equal(body.split(MARKER).length - 1, 1, "exactly one marker");
    assert.ok(body.trimEnd().endsWith(MARKER));
    // GitHub never links mentions inside code spans; outside them, none may survive.
    assert.ok(!/@octocat/.test(prose), "an @mention survived outside code");
    assert.ok(!/(^|[^`])@octocat/.test(body.replace(/(`+)[^`]*?@octocat[^`]*?\1/g, "")), "an @mention escaped its code span");
    assert.ok(!/<img/i.test(prose), "raw HTML survived outside code");
    assert.ok(/`+[^`]*<img[^`]*`+/.test(body), "the hostile URI is shown, inert, inside code");
    // Every table row keeps exactly its three columns: unescaped pipes (cell separators)
    // number four per row, whatever the hostile names contained.
    for (const row of body.split("\n").filter((l) => l.startsWith("|"))) {
      assert.equal((row.match(/(?<!\\)\|/g) || []).length, 4, `table row was split: ${row}`);
    }
    assert.ok(!body.split("\n").some((l) => l.startsWith("|") && /Evil/.test(l)), "a table row was injected");
    assert.match(body, /without-global-scope/);
    assert.match(body, /GET \//);
    const status = api.writes.find((w) => w.path.includes("/statuses/"));
    assert.ok(status && status.path.endsWith(f.head));
    assert.equal(status.body.context, "change-evidence");
    assert.equal(status.body.state, "success");
    const ev = JSON.parse(fs.readFileSync(path.join(r.dir, "out", "evidence.json"), "utf8"));
    assert.equal(ev.pull_request, 7);
    assert.equal(ev.head, f.head);

    // Second run: the bot's own comment is updated in place.
    const r2 = await report(f, api, workflowRunEvent(f.head, { prs: [7] }));
    assert.equal(r2.code, 0, r2.stderr);
    const patch = api.writes.filter((w) => w.method === "PATCH");
    assert.equal(patch.length, 1);
    assert.equal(patch[0].path, `/repos/${REPO}/issues/comments/${state.comments[1].id}`);
  } finally {
    api.server.close();
  }
});

test("fork PR (no pull_requests in the payload) is found through the API and reported", async () => {
  const f = fixture();
  const state = { prs: { 8: pr(8, f.forkHead, { base: f.base, headRepo: "mallory/app" }) }, comments: [] };
  const api = await fakeGitHub(state);
  try {
    const r = await report(f, api, workflowRunEvent(f.forkHead, { headRepo: "mallory/app" }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /#8 \(fork\)/);
    assertNothingExecuted(f, r);
    assert.match(api.writes.find((w) => w.method === "POST" && w.path.endsWith("/comments")).body.body, /mass-assignment-open/);
  } finally {
    api.server.close();
  }
});

test("claims that don't match the API are skipped, and nothing is written", async () => {
  const f = fixture();
  const cases = [
    ["head moved", { 7: pr(7, f.forkHead, { base: f.base }) }],
    ["closed", { 7: pr(7, f.head, { base: f.base, state: "closed" }) }],
    ["PR on another repository", { 7: pr(7, f.head, { base: f.base, baseRepo: "other/app" }) }],
    ["no such PR", {}],
  ];
  for (const [name, prs] of cases) {
    const api = await fakeGitHub({ prs, comments: [] });
    try {
      const r = await report(f, api, workflowRunEvent(f.head, { prs: [7] }));
      assert.equal(r.code, 0, `${name}: ${r.stderr}`);
      assert.match(r.stdout, /nothing to report/, name);
      assert.deepEqual(api.writes, [], `${name}: wrote to GitHub`);
    } finally {
      api.server.close();
    }
  }
});

test("malformed or hostile events are refused (exit 3) before any API call", async () => {
  const f = fixture();
  const sha = f.head;
  const bad = [
    ["not JSON", "{nope", {}],
    ["head_sha injection", workflowRunEvent("abc$(touch PWNED);"), {}],
    ["short sha", workflowRunEvent(sha.slice(0, 12)), {}],
    ["push event", workflowRunEvent(sha, { event: "push" }), {}],
    ["issue_comment event", workflowRunEvent(sha, { event: "issue_comment" }), {}],
    ["other repository", workflowRunEvent(sha, { repository: "other/app" }), {}],
    ["bad head repo", workflowRunEvent(sha, { headRepo: "../../etc" }), {}],
    ["wrong trigger", workflowRunEvent(sha), { eventName: "push" }],
    ["plain-http API", workflowRunEvent(sha), { extraEnv: { GITHUB_API_URL: "http://example.com" } }],
    ["bad GITHUB_REPOSITORY", workflowRunEvent(sha), { extraEnv: { GITHUB_REPOSITORY: "acme/app;id" } }],
  ];
  const api = await fakeGitHub({ prs: { 7: pr(7, sha, { base: f.base }) }, comments: [] });
  let requests = 0;
  api.server.on("request", () => requests++);
  try {
    for (const [name, event, opts] of bad) {
      const r = await report(f, api, event, opts);
      assert.equal(r.code, 3, `${name}: expected refusal, got ${r.code}\n${r.stderr}`);
      assert.match(r.stderr, /refused/, name);
      assertNothingExecuted(f, r);
    }
    assert.equal(requests, 0, "a refused event still reached the API");
  } finally {
    api.server.close();
  }
});

test("hostile PR numbers in the payload hint can't redirect the reporter", async () => {
  const f = fixture();
  // The payload hints PR 8, whose head is a different commit: it must be rejected.
  const api = await fakeGitHub({ prs: { 8: pr(8, f.forkHead, { base: f.base }) }, comments: [] });
  try {
    const r = await report(f, api, workflowRunEvent(f.head, { prs: [8, -1, "7; rm", 1e12] }));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /nothing to report/);
    assert.deepEqual(api.writes, []);
  } finally {
    api.server.close();
  }
});

test("event readers validate every field they use", () => {
  const sha = "a".repeat(40);
  assert.throws(() => gh.readWorkflowRunEvent(null, REPO), gh.TrustError);
  assert.throws(() => gh.readWorkflowRunEvent({ workflow_run: { event: "pull_request", head_sha: sha.toUpperCase(), repository: { full_name: REPO } } }, REPO), /40-character/);
  const ok = gh.readWorkflowRunEvent({ workflow_run: { event: "pull_request", head_sha: sha, repository: { full_name: REPO }, head_repository: { full_name: "mallory/app" }, pull_requests: [{ number: 3 }, { number: "4" }, null, { number: 3 }] } }, REPO);
  assert.deepEqual(ok.hinted, [3]);
  assert.equal(ok.fork, true);
  for (const r of ["a/b", "Acme-1/app.js", "x/y_z"]) assert.ok(gh.isRepo(r), r);
  for (const r of ["a", "a/b/c", "-a/b", "a/..", "a/b;c", "a/b c", "../x"]) assert.ok(!gh.isRepo(r), r);
});
