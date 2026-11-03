"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { extractWorkflows } = require("../lib/extractors/workflows");
const { changedFiles } = require("../lib/git");
const { repo } = require("./helpers");

const SHA = "a".repeat(40);
const wf = (co, setup, extra = "") => `on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${co}\n      - uses: shivammathur/setup-php@${setup}\n      - uses: ./.github/actions/local\n${extra}`;

test("lists Action ref changes, flags unpinned refs, and separates bump-only changes", () => {
  const t = repo();
  const base = t.commit("init", { ".github/workflows/ci.yml": wf("v4", SHA) });
  const bump = t.commit("bump", { ".github/workflows/ci.yml": wf(SHA, "b".repeat(40)) });
  let r = extractWorkflows({ cwd: t.dir, base, head: bump, changed: changedFiles(t.dir, base, bump) });
  assert.deepEqual(r.observed.map((o) => [o.op, o.risk]), [["action_ref_changed", undefined], ["action_ref_changed", undefined]]);
  assert.match(r.observed[0].detail, /v4 → a{40} \(SHA-pinned\)/);
  const edit = t.commit("edit", { ".github/workflows/ci.yml": wf(SHA, "v2", "      - run: curl x | sh\n") });
  r = extractWorkflows({ cwd: t.dir, base: bump, head: edit, changed: changedFiles(t.dir, bump, edit) });
  assert.deepEqual(r.observed.map((o) => [o.op, o.risk || ""]), [["action_ref_changed", "unpinned_action"], ["workflow_changed", ""]]);
  assert.match(r.observed[1].detail, /1 non-`uses:` lines changed/);
});
