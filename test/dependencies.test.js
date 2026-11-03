"use strict";
const test = require("node:test");
const assert = require("node:assert");
const d = require("../lib/extractors/dependencies");
const { changedFiles } = require("../lib/git");
const { repo } = require("./helpers");

test("lockfile readers", () => {
  const pnpm9 = "lockfileVersion: '9.0'\n\npackages:\n\n  '@a/b@1.2.3':\n    resolution: {}\n\n  c@2.0.0(d@1.0.0):\n    resolution: {}\n    requiresBuild: true\n\nsnapshots:\n\n  e@9.9.9: {}\n";
  const p = d.readPnpmLock(pnpm9);
  assert.deepEqual([...p.keys()], ["@a/b", "c"]);
  assert.equal(p.get("c").install, true);
  const pnpm5 = "lockfileVersion: 5.4\npackages:\n  /left-pad/1.3.0:\n    dev: false\n  /@x/y/2.0.0_react@18:\n    dev: true\n";
  assert.deepEqual([...d.readPnpmLock(pnpm5)].map(([k, v]) => `${k}@${v.version}`), ["left-pad@1.3.0", "@x/y@2.0.0"]);
  const yarn = '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.2.0"\n\nlodash@^4:\n  version "4.17.21"\n';
  assert.deepEqual([...d.readYarnLock(yarn)].map(([k, v]) => `${k}@${v.version}`), ["@babel/core@7.2.0", "lodash@4.17.21"]);
  const npm = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": { version: "1.0.0", hasInstallScript: true }, "node_modules/a/node_modules/b": { version: "2.0.0" } } });
  assert.deepEqual([...d.readPackageLock(npm)].map(([k, v]) => `${k}@${v.version}${v.install ? "!" : ""}`), ["a@1.0.0!", "b@2.0.0"]);
  assert.equal(d.major("0.4.1"), "0.4");
  assert.ok(d.cmp("1.10.0", "1.9.0") > 0);
});

test("composer.lock diff: direct items, transitive counts, majors and downgrades", () => {
  const t = repo();
  const lock = (pkgs) => JSON.stringify({ packages: pkgs.map(([name, version]) => ({ name, version })) });
  const base = t.commit("init", {
    "composer.json": JSON.stringify({ require: { "laravel/framework": "^10", "a/b": "^1" } }),
    "composer.lock": lock([["laravel/framework", "v10.1.0"], ["a/b", "1.5.0"], ["t/one", "1.0.0"]]),
  });
  const head = t.commit("bump", {
    "composer.json": JSON.stringify({ require: { "laravel/framework": "^11", "a/b": "^1", "new/pkg": "^2" } }),
    "composer.lock": lock([["laravel/framework", "v11.0.0"], ["a/b", "1.4.0"], ["new/pkg", "2.0.0"], ["t/two", "1.0.0"]]),
  });
  const r = d.extractDependencies({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
  const by = Object.fromEntries(r.observed.map((o) => [o.key, o]));
  assert.equal(by["composer:laravel/framework"].risk, "major_upgrade");
  assert.equal(by["composer:a/b"].risk, "dependency_downgrade");
  assert.equal(by["composer:new/pkg"].risk, "new_direct_dependency");
  assert.deepEqual(by["composer:composer.lock"].counts, { added: 1, removed: 1, upgraded: 0, downgraded: 0 });
});

test("manifest change without lockfile is UNKNOWN when a lockfile exists", () => {
  const t = repo();
  const base = t.commit("init", { "package.json": JSON.stringify({ dependencies: { a: "^1" } }), "yarn.lock": "" });
  const head = t.commit("x", { "package.json": JSON.stringify({ dependencies: { a: "^2" } }) });
  const r = d.extractDependencies({ cwd: t.dir, base, head, changed: changedFiles(t.dir, base, head) });
  assert.equal(r.state, "UNKNOWN");
});
