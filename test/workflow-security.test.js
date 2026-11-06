"use strict";
// Static guarantees about the shipped workflows and the evaluator's use of git. These
// fail if a future edit weakens the trust model; see docs/security.md.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const update = require("../lib/update");

const { workflow, trigger } = update.renderTemplates("1.0.0", `sha512-${"A".repeat(86)}==`);

// Lines that are shell: the body of `run: |` blocks and inline `run:` values.
function shellLines(yaml) {
  const out = [];
  const lines = yaml.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && m[2] !== "|" && m[2] !== ">") {
      out.push(m[2]);
      continue;
    }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (lines[j].search(/\S/) <= indent) break;
      out.push(lines[j]);
    }
  }
  return out;
}

const uses = (yaml) => [...yaml.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]);

test("the reporter runs on workflow_run, never pull_request or pull_request_target", () => {
  const on = /^on:\n((?:[ \t]+.*\n)+)/m.exec(workflow)[1];
  assert.match(on, /^\s+workflow_run:/m);
  assert.match(on, /workflows: \[change-evidence-trigger\]/);
  assert.doesNotMatch(workflow, /^\s+pull_request_target\s*:/m);
  assert.doesNotMatch(on, /^\s+pull_request\s*:/m);
  assert.match(workflow, /if: github\.event\.workflow_run\.event == 'pull_request'/);
});

test("the trigger has no permissions, no Actions, no secrets and no expressions", () => {
  assert.match(trigger, /^permissions: \{\}$/m);
  assert.match(trigger, /^\s+pull_request:/m);
  assert.deepEqual(uses(trigger), []);
  assert.doesNotMatch(trigger, /secrets\./);
  assert.doesNotMatch(trigger, /\$\{\{/);
});

test("reporter permissions are exactly contents:read, pull-requests:write, statuses:write", () => {
  const block = /^permissions:\n((?:[ \t]+.*\n)+)/m.exec(workflow)[1];
  const perms = Object.fromEntries([...block.matchAll(/^\s+([\w-]+):\s*(\w+)/gm)].map((m) => [m[1], m[2]]));
  assert.deepEqual(perms, { contents: "read", "pull-requests": "write", statuses: "write" });
  assert.doesNotMatch(workflow, /write-all|read-all/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("every Action is pinned to a full commit SHA", () => {
  const all = uses(workflow);
  assert.ok(all.length >= 3);
  for (const u of all) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, u);
});

test("no expression is interpolated into shell; untrusted values arrive through env", () => {
  for (const yaml of [workflow, trigger]) for (const line of shellLines(yaml)) assert.doesNotMatch(line, /\$\{\{/, line);
  // The only expressions are in non-shell positions, and none reads PR-controlled text.
  const exprs = [...workflow.matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  for (const e of exprs) assert.ok(["github.event.workflow_run.head_sha", "runner.temp", "github.token"].includes(e), `unexpected expression: ${e}`);
});

test("the checkout is the default branch, without persisted credentials", () => {
  const step = /- uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n((?:\s{8,}.*\n)+)/.exec(workflow);
  assert.ok(step, "checkout step");
  assert.doesNotMatch(step[1], /\bref:|\brepository:/);
  assert.match(step[1], /persist-credentials: false/);
  assert.equal((workflow.match(/actions\/checkout@/g) || []).length, 1);
});

test("the evaluator is integrity-checked before it runs, and nothing is npm-installed", () => {
  const shell = shellLines(workflow).join("\n");
  assert.match(shell, /npm pack --json --silent "\$CHANGE_EVIDENCE"/);
  assert.match(shell, /if \[ "\$got" != "\$CHANGE_EVIDENCE_INTEGRITY" \]/);
  assert.ok(shell.indexOf("CHANGE_EVIDENCE_INTEGRITY") < shell.indexOf("github-report"), "verify before run");
  assert.doesNotMatch(shell, /npm (i|install|ci)\b|npx /);
  assert.match(workflow, /CHANGE_EVIDENCE_INTEGRITY: "sha512-/);
});

test("the evaluator never checks out, switches, restores or creates worktrees", () => {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith(".js")) files.push(p);
    }
  };
  walk(path.join(__dirname, "..", "lib"));
  walk(path.join(__dirname, "..", "bin"));
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    for (const verb of ["checkout", "switch", "restore", "worktree", "stash", "reset", "clean", "apply", "am", "submodule"]) {
      assert.doesNotMatch(src, new RegExp(`git\\([^)]*\\[[^\\]]*"${verb}"`), `${path.relative(process.cwd(), f)} runs git ${verb}`);
    }
    assert.doesNotMatch(src, /\bspawn(Sync)?\(\s*["'](npm|npx|composer|php|sh|bash)["']/, `${f} spawns a build tool`);
  }
});
