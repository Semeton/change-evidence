"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync, spawnSync } = require("child_process");
const update = require("../lib/update");
const { repo } = require("./helpers");

const BIN = path.join(__dirname, "..", "bin", "change-evidence.js");
const VERSION = require("../package.json").version;
const TEMPLATE = fs.readFileSync(path.join(__dirname, "..", "templates", "change-evidence.yml"), "utf8");
const ENV = { ...process.env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" };
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: ENV, ...opts });

test("-v, --version, version print the version; -h and --help print usage", () => {
  for (const a of [["-v"], ["--version"], ["version"]]) assert.equal(run(a).stdout.trim(), VERSION);
  for (const a of [["-h"], ["--help"], ["help"]]) {
    const r = run(a);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: change-evidence <command>/);
  }
  const none = run([]);
  assert.equal(none.status, 2);
  const bad = run(["nope"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown command: nope/);
});

const INTEGRITY = `sha512-${"Q".repeat(86)}==`;
const OLD = fs.readFileSync(path.join(__dirname, "fixtures", "workflow-0.3.0-pull_request_target.yml"), "utf8");
const WF = ".github/workflows/change-evidence.yml";
const TRIGGER = ".github/workflows/change-evidence-trigger.yml";

test("the current templates are recorded in templates/history.json", () => {
  const t = update.renderTemplates(VERSION, INTEGRITY);
  assert.ok(update.knownTemplates("workflow").includes(update.templateHash(t.workflow)), "append the workflow template's hash to templates/history.json");
  assert.ok(update.knownTemplates("trigger").includes(update.templateHash(t.trigger)), "append the trigger template's hash to templates/history.json");
  assert.ok(update.knownTemplates("workflow").includes(update.templateHash(OLD)), "the 0.1–0.3 template must stay known, so installs can migrate");
});

function workflowRepo(content) {
  const t = repo();
  t.write({ [WF]: content });
  return t;
}
const read = (t, f) => fs.readFileSync(path.join(t.dir, f), "utf8");

test("upgrade migrates a stock 0.1–0.3 pull_request_target install to trigger + workflow_run", () => {
  const t = workflowRepo(OLD);
  const r = run(["upgrade", t.dir, "--to", VERSION, "--integrity", INTEGRITY]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`0\\.3\\.0 → ${VERSION.replace(/\./g, "\\.")}`));
  assert.match(r.stdout, /Migrated from pull_request_target/);
  assert.match(r.stdout, /Added \.github\/workflows\/change-evidence-trigger\.yml/);
  const fresh = update.renderTemplates(VERSION, INTEGRITY);
  assert.equal(read(t, WF), fresh.workflow);
  assert.equal(read(t, TRIGGER), fresh.trigger);
  assert.doesNotMatch(read(t, WF), /pull_request_target/);
  assert.match(run(["upgrade", t.dir, "--to", VERSION, "--integrity", INTEGRITY]).stdout, /already on/);
});

test("upgrade on a customised workflow moves only the pin and integrity, and says what it lacks", () => {
  let t = workflowRepo(OLD.replace("timeout-minutes: 10", "timeout-minutes: 30"));
  let r = run(["upgrade", t.dir, "--to", "9.9.9", "--integrity", INTEGRITY]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /only the pin and integrity moved/);
  assert.match(r.stdout, /doesn't verify the evaluator's integrity/);
  assert.match(r.stdout, /blocks by default in public repositories from December 2, 2026/);
  assert.match(read(t, WF), /change-evidence@9\.9\.9"/);
  assert.match(read(t, WF), /timeout-minutes: 30/);
  assert.ok(!fs.existsSync(path.join(t.dir, TRIGGER)), "a customised install isn't restructured");

  // A customised new-style workflow: the integrity line moves with the pin.
  const custom = update.renderTemplates("0.4.0", `sha512-${"B".repeat(86)}==`).workflow.replace("timeout-minutes: 10", "timeout-minutes: 20");
  t = workflowRepo(custom);
  r = run(["upgrade", t.dir, "--to", "9.9.9", "--integrity", INTEGRITY]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(read(t, WF), new RegExp(`CHANGE_EVIDENCE_INTEGRITY: "${INTEGRITY.replace(/[+/]/g, "\\$&")}"`));
  assert.match(read(t, WF), /timeout-minutes: 20/);

  // --check reports and exits 1 without writing; a newer pin is left alone; integrity is required.
  t = workflowRepo(OLD);
  assert.equal(run(["upgrade", t.dir, "--to", "9.9.9", "--integrity", INTEGRITY, "--check"]).status, 1);
  assert.equal(read(t, WF), OLD);
  assert.match(run(["upgrade", t.dir, "--to", "0.0.1", "--integrity", INTEGRITY]).stdout, /newer than 0\.0\.1; left as is/);
  assert.equal(run(["upgrade", t.dir, "--to", "9.9.9", "--integrity", "sha1-nope"]).status, 2);
  assert.equal(run(["upgrade", repo().dir, "--to", "1.0.0", "--integrity", INTEGRITY]).status, 2);
});

test("latestVersion reads the registry and gives null when it can't", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/@semeton%2fchange-evidence/latest") res.end(JSON.stringify({ version: "4.5.6" }));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // The server lives in this process, so the child must run asynchronously.
  const child = (registry, timeout) =>
    new Promise((resolve) => {
      const { execFile } = require("child_process");
      execFile(process.execPath, ["-e", `require('./lib/update').latestVersion({ timeout: ${timeout} }).then(v => console.log(v))`], { cwd: path.join(__dirname, ".."), env: { ...ENV, CHANGE_EVIDENCE_REGISTRY: registry, NODE_USE_ENV_PROXY: "", HTTP_PROXY: "", http_proxy: "" } }, (err, stdout) => resolve(stdout));
    });
  const out = await child(url, 3000);
  const dead = await child("http://127.0.0.1:9", 500);
  server.close();
  assert.equal(out.trim(), "4.5.6");
  assert.equal(dead.trim(), "null");
});

test("the update notice uses the daily cache, and never runs in CI or when turned off", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ce-cache-"));
  const env = { XDG_CACHE_HOME: home };
  fs.mkdirSync(path.join(home, "change-evidence"), { recursive: true });
  fs.writeFileSync(path.join(home, "change-evidence", "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "99.0.0" }));
  const prev = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = home;
  try {
    let written = "";
    const tty = { isTTY: true, write: (s) => (written += s) };
    assert.match(update.notify("0.1.0", { stream: tty, env }), /99\.0\.0 is available \(you have 0\.1\.0\)/);
    assert.match(written, /npx @semeton\/change-evidence@latest upgrade/);
    assert.equal(update.notify("99.0.0", { stream: tty, env }), null, "not when current");
    assert.equal(update.notify("0.1.0", { stream: tty, env: { ...env, CI: "true" } }), null);
    assert.equal(update.notify("0.1.0", { stream: tty, env: { ...env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "1" } }), null);
    assert.equal(update.notify("0.1.0", { stream: { isTTY: false, write() {} }, env }), null, "not when piped");
  } finally {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  }
});

test("init pins this version and its integrity, prints or writes both workflows", () => {
  const out = run(["init", "--integrity", INTEGRITY]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`CHANGE_EVIDENCE: "@semeton/change-evidence@${VERSION.replace(/\./g, "\\.")}"`));
  assert.ok(out.stdout.includes(`CHANGE_EVIDENCE_INTEGRITY: "${INTEGRITY}"`));
  assert.match(out.stderr, /needs its trigger too/);
  assert.match(run(["init", "--trigger"]).stdout, /^name: change-evidence-trigger$/m);
  assert.equal(run(["init", "--integrity", "sha512-short"]).status, 2);

  const t = repo();
  const w = run(["init", t.dir, "--write", "--integrity", INTEGRITY]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(read(t, WF), update.renderTemplates(VERSION, INTEGRITY).workflow);
  assert.equal(read(t, TRIGGER), update.renderTemplates(VERSION, INTEGRITY).trigger);
  assert.equal(run(["init", t.dir, "--write", "--integrity", INTEGRITY]).status, 2, "won't overwrite");
  assert.equal(run(["init", t.dir, "--write", "--force", "--integrity", INTEGRITY]).status, 0);
});

test("init finds the published integrity on the registry", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === `/@semeton%2fchange-evidence/${VERSION}`) res.end(JSON.stringify({ version: VERSION, dist: { integrity: INTEGRITY } }));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = await new Promise((resolve) => {
    require("child_process").execFile(process.execPath, [BIN, "init"], { env: { ...ENV, CHANGE_EVIDENCE_REGISTRY: `http://127.0.0.1:${server.address().port}` } }, (err, stdout) => resolve(stdout));
  });
  server.close();
  assert.ok(out.includes(`CHANGE_EVIDENCE_INTEGRITY: "${INTEGRITY}"`));
});
