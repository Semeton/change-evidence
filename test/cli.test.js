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

test("the current template is recorded in templates/history.json", () => {
  assert.ok(update.knownTemplates().includes(update.templateHash(TEMPLATE)), "append the new template hash to templates/history.json");
});

function workflowRepo(content) {
  const t = repo();
  t.write({ ".github/workflows/change-evidence.yml": content });
  return t;
}

test("upgrade moves the pin; a stock workflow is refreshed, a customised one only re-pinned", () => {
  // Stock template from an older release (same template text, older pin), upgraded to this version.
  const old = TEMPLATE.replace(/change-evidence@[^"]+/, "change-evidence@0.0.9");
  let t = workflowRepo(old);
  let r = run(["upgrade", t.dir, "--to", VERSION]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`0\\.0\\.9 → ${VERSION.replace(/\./g, "\\.")}`));
  assert.equal(fs.readFileSync(path.join(t.dir, ".github/workflows/change-evidence.yml"), "utf8"), TEMPLATE.replace(/change-evidence@[^"]+/, `change-evidence@${VERSION}`));
  assert.match(run(["upgrade", t.dir, "--to", VERSION]).stdout, /already on/);

  // An older template version (unknown to history) with local edits: only the pin moves.
  const custom = old.replace("timeout-minutes: 10", "timeout-minutes: 30");
  t = workflowRepo(custom);
  r = run(["upgrade", t.dir, "--to", "9.9.9"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /only the pin moved/);
  const after = fs.readFileSync(path.join(t.dir, ".github/workflows/change-evidence.yml"), "utf8");
  assert.match(after, /change-evidence@9\.9\.9"/);
  assert.match(after, /timeout-minutes: 30/);

  // --check reports and exits 1 without writing; a newer pin is left alone.
  t = workflowRepo(old);
  r = run(["upgrade", t.dir, "--to", "9.9.9", "--check"]);
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(path.join(t.dir, ".github/workflows/change-evidence.yml"), "utf8"), /@0\.0\.9"/);
  assert.match(run(["upgrade", t.dir, "--to", "0.0.1"]).stdout, /newer than 0\.0\.1; left as is/);

  // No workflow at all.
  assert.equal(run(["upgrade", repo().dir, "--to", "1.0.0"]).status, 2);
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
