"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// An empty global config, so the developer's own git config (signing, hooks, prompts)
// can't affect tests. A real empty file, not os.devNull: git on Windows can't open \\.\nul.
const EMPTY_CONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-gitcfg-")), "config");
fs.writeFileSync(EMPTY_CONFIG, "");
const NO_HOOKS = fs.mkdtempSync(path.join(os.tmpdir(), "ce-hooks-"));
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: EMPTY_CONFIG, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-"));
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { env: ENV, encoding: "utf8", timeout: 20000 }).trim();
  g("init", "-q", "-b", "main");
  g("config", "core.hooksPath", NO_HOOKS);
  let day = 1;
  return {
    dir,
    g,
    write(files) {
      for (const [f, c] of Object.entries(files)) {
        const p = path.join(dir, f);
        if (c === null) fs.rmSync(p, { force: true });
        else {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, c);
        }
      }
    },
    // Commit files straight into git objects, bypassing the working tree and the real
    // index (a temporary GIT_INDEX_FILE), so paths no filesystem here could hold
    // (Windows: | < > " ? *, or a newline anywhere) can still be tested. A hostile PR's
    // commits are made elsewhere and arrive as objects. HEAD doesn't move.
    commitObjects(msg, files, { parent = g("rev-parse", "HEAD") } = {}) {
      const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-idx-")), "index");
      const env = { ...ENV, GIT_INDEX_FILE: index };
      const run = (args, extra = {}) => execFileSync("git", ["-C", dir, "-c", "core.protectNTFS=false", ...args], { env, encoding: "utf8", timeout: 20000, ...extra }).trim();
      run(["read-tree", parent]);
      for (const [f, content] of Object.entries(files)) {
        const blob = run(["hash-object", "-w", "--stdin"], { input: content });
        run(["update-index", "--add", "--cacheinfo", `100644,${blob},${f}`]);
      }
      const date = `2026-01-${String(day++).padStart(2, "0")}T12:00:00Z`;
      const tree = run(["write-tree"]);
      return execFileSync("git", ["-C", dir, "commit-tree", tree, "-p", parent, "-m", msg], { env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, encoding: "utf8" }).trim();
    },
    commit(msg, files = {}) {
      this.write(files);
      g("add", "-A");
      const date = `2026-01-${String(day++).padStart(2, "0")}T12:00:00Z`;
      execFileSync("git", ["-C", dir, "commit", "-q", "--allow-empty", "-m", msg], { env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, timeout: 20000 });
      return g("rev-parse", "HEAD");
    },
  };
}
module.exports = { repo };
