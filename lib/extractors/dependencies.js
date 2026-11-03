"use strict";

// Dependency changes, read from lockfiles: composer.lock, pnpm-lock.yaml, yarn.lock (v1)
// and package-lock.json (v2/v3). Direct dependencies (named in composer.json or
// package.json) are itemised; transitive changes are counted, so a lockfile refresh
// doesn't drown the signal. A manifest change without its lockfile is reported:
// what will actually be installed can't be established from the manifest alone.

const { show } = require("../git");
const { result, STATES } = require("../evidence");

const LOCKS = {
  "composer.lock": { eco: "composer", manifest: "composer.json", read: readComposerLock },
  "pnpm-lock.yaml": { eco: "npm", manifest: "package.json", read: readPnpmLock },
  "yarn.lock": { eco: "npm", manifest: "package.json", read: readYarnLock },
  "package-lock.json": { eco: "npm", manifest: "package.json", read: readPackageLock },
};

// Each reader returns Map(name -> { version, install?: true }) or null if unreadable.
function readComposerLock(text) {
  try {
    const j = JSON.parse(text);
    const m = new Map();
    for (const p of [...(j.packages || []), ...(j["packages-dev"] || [])]) m.set(p.name, { version: String(p.version || "").replace(/^v/, "") });
    return m;
  } catch {
    return null;
  }
}

function readPackageLock(text) {
  try {
    const j = JSON.parse(text);
    const m = new Map();
    if (j.packages) {
      for (const [k, v] of Object.entries(j.packages)) {
        if (!k) continue;
        const name = v.name || k.slice(k.lastIndexOf("node_modules/") + 13);
        if (!m.has(name)) m.set(name, { version: v.version, ...(v.hasInstallScript ? { install: true } : {}) });
      }
    } else if (j.dependencies) {
      const walk = (deps) => {
        for (const [name, v] of Object.entries(deps)) {
          if (!m.has(name)) m.set(name, { version: v.version });
          if (v.dependencies) walk(v.dependencies);
        }
      };
      walk(j.dependencies);
    }
    return m;
  } catch {
    return null;
  }
}

// pnpm: keys of the `packages:` section. v9 `name@1.2.3:`; v6 `/name@1.2.3:`; v5 `/name/1.2.3:`.
function readPnpmLock(text) {
  const m = new Map();
  const lines = text.split("\n");
  let inPackages = false;
  let current = null;
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inPackages = /^packages:\s*$/.test(line);
      current = null;
      continue;
    }
    if (!inPackages) continue;
    const key = /^ {2}(['"]?)(\/?[^\s'"]+?)\1:\s*$/.exec(line);
    if (key) {
      let k = key[2].replace(/^\//, "").replace(/\(.*$/, "");
      let name;
      let version;
      const v5 = /^((?:@[^/]+\/)?[^/@]+)\/(\d[^/]*)$/.exec(k);
      const at = k.lastIndexOf("@");
      if (v5) {
        name = v5[1];
        version = v5[2];
      } else if (at > 0) {
        name = k.slice(0, at);
        version = k.slice(at + 1);
      } else {
        const slash = k.lastIndexOf("/");
        name = k.slice(0, slash);
        version = k.slice(slash + 1);
      }
      version = version.replace(/_.*$/, "");
      current = name;
      if (!m.has(name)) m.set(name, { version });
      continue;
    }
    if (current && /^ {4}requiresBuild:\s*true/.test(line)) m.get(current).install = true;
  }
  return m.size || /packages:/.test(text) ? m : null;
}

// yarn v1: `"a@^1", a@^1.2:` headers followed by `  version "1.2.3"`.
function readYarnLock(text) {
  if (/^__metadata:/m.test(text)) return readYarnBerry(text);
  const m = new Map();
  let names = null;
  for (const line of text.split("\n")) {
    if (/^\S.*:\s*$/.test(line) && !line.startsWith("#")) {
      const first = line.split(",")[0].trim().replace(/^"|"$|:$/g, "").replace(/"$/, "");
      const at = first.lastIndexOf("@");
      names = at > 0 ? first.slice(0, at) : first;
      continue;
    }
    const v = /^ {2}version:? "?([^"\s]+)"?/.exec(line);
    if (v && names && !m.has(names)) m.set(names, { version: v[1] });
  }
  return m;
}

function readYarnBerry(text) {
  const m = new Map();
  let name = null;
  for (const line of text.split("\n")) {
    const h = /^"?((?:@[^@/]+\/)?[^@"]+)@/.exec(line);
    if (h && /:\s*$/.test(line)) {
      name = h[1];
      continue;
    }
    const v = /^ {2}version: "?([^"\s]+)"?/.exec(line);
    if (v && name && !m.has(name)) m.set(name, { version: v[1] });
  }
  return m;
}

function directDeps(text, eco) {
  try {
    const j = JSON.parse(text);
    const keys = eco === "composer" ? ["require", "require-dev"] : ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
    const out = new Set();
    for (const k of keys) for (const n of Object.keys(j[k] || {})) out.add(n);
    return out;
  } catch {
    return null;
  }
}

function major(v) {
  const m = /^(\d+)(?:\.(\d+))?/.exec(String(v || ""));
  if (!m) return null;
  // 0.x: the minor is the breaking part
  return m[1] === "0" ? `0.${m[2] || 0}` : m[1];
}

function cmp(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = String(b).split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

function extractDependencies(ctx) {
  const { cwd, base, head, changed } = ctx;
  const paths = new Set(changed.map((f) => f.path));
  const observed = [];
  const unknown = [];
  let inspected = 0;
  // Only root-level lockfiles; nested ones (fixtures, sub-packages) are out of scope.
  for (const [lock, spec] of Object.entries(LOCKS)) {
    if (!paths.has(lock)) continue;
    inspected++;
    const beforeText = show(cwd, base, lock);
    const afterText = show(cwd, head, lock);
    const before = beforeText === null ? new Map() : spec.read(beforeText);
    const after = afterText === null ? new Map() : spec.read(afterText);
    if (!before || !after) {
      unknown.push(`${lock}: could not be read`);
      continue;
    }
    const manifest = show(cwd, head, spec.manifest);
    const direct = (manifest && directDeps(manifest, spec.eco)) || new Set();
    const baseManifest = show(cwd, base, spec.manifest);
    const directBefore = (baseManifest && directDeps(baseManifest, spec.eco)) || new Set();
    const transitive = { added: 0, removed: 0, upgraded: 0, downgraded: 0 };
    const isDirect = (n) => direct.has(n) || directBefore.has(n);
    for (const [name, a] of after) {
      const b = before.get(name);
      const key = `${spec.eco}:${name}`;
      if (!b) {
        if (isDirect(name)) observed.push({ op: "dependency_added", key, detail: a.version, risk: "new_direct_dependency" });
        else transitive.added++;
        if (a.install) observed.push({ op: "install_script", key, detail: `${a.version} runs a build/install script`, risk: "install_script" });
      } else if (a.version !== b.version) {
        const down = cmp(a.version, b.version) < 0;
        const majorBump = major(a.version) !== major(b.version);
        if (isDirect(name)) {
          observed.push({ op: down ? "dependency_downgraded" : "dependency_upgraded", key, detail: `${b.version} → ${a.version}${majorBump ? " (major)" : ""}`, risk: down ? "dependency_downgrade" : majorBump ? "major_upgrade" : undefined });
        } else if (down) transitive.downgraded++;
        else transitive.upgraded++;
        if (a.install && !b.install) observed.push({ op: "install_script", key, detail: `${a.version} now runs a build/install script`, risk: "install_script" });
      }
    }
    for (const name of before.keys()) {
      if (after.has(name)) continue;
      if (isDirect(name)) observed.push({ op: "dependency_removed", key: `${spec.eco}:${name}` });
      else transitive.removed++;
    }
    const t = Object.entries(transitive).filter(([, n]) => n);
    if (t.length) observed.push({ op: "transitive_changes", key: `${spec.eco}:${lock}`, detail: t.map(([k, n]) => `${n} ${k}`).join(", "), counts: transitive });
  }
  // A manifest changed without its lockfile.
  for (const [manifest, locks] of [["composer.json", ["composer.lock"]], ["package.json", ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]]]) {
    if (!paths.has(manifest) || locks.some((l) => paths.has(l))) continue;
    const before = show(cwd, base, manifest);
    const after = show(cwd, head, manifest);
    const eco = manifest === "composer.json" ? "composer" : "npm";
    const a = before && directDeps(before, eco);
    const b = after && directDeps(after, eco);
    if (a && b && JSON.stringify(depVersions(before, eco)) !== JSON.stringify(depVersions(after, eco))) {
      const hasLock = locks.some((l) => show(cwd, head, l) !== null);
      if (hasLock) unknown.push(`${manifest}: dependency constraints changed but the lockfile did not; what installs can't be established`);
      else observed.push({ op: "manifest_changed", key: manifest, detail: "no lockfile in the repository", risk: "unlocked_dependencies" });
    }
  }
  if (!inspected && !observed.length && !unknown.length) return result("dependencies", { state: STATES.PASS, note: "no dependency files changed" });
  return result("dependencies", { observed, unknown, inspected });
}

function depVersions(text, eco) {
  const j = JSON.parse(text);
  const keys = eco === "composer" ? ["require", "require-dev"] : ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return keys.map((k) => j[k] || {});
}

module.exports = { extractDependencies, readComposerLock, readPnpmLock, readYarnLock, readPackageLock, major, cmp };
