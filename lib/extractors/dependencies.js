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
// Where a package comes from, reduced to something comparable: "registry:<host>",
// "git:<host>", "path", "link", or "" when the lockfile doesn't say. A move between
// these, or to a different host, is a supply-chain change worth a reviewer's eye.
function sourceOf(url, type, kind) {
  if (kind === "link") return "link";
  const u = String(url || "");
  if (!u) return type === "path" ? "path" : "";
  if (type === "path" || /^(?:file:|\.{0,2}\/)/.test(u)) return "path";
  const host = (/^(?:git\+)?(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)/i.exec(u) || /^git@([^:]+):/.exec(u) || [])[1];
  const git = type === "git" || /^git(?:\+|@|:)|\.git(?:#|$)/.test(u);
  return host ? `${git ? "git" : "registry"}:${host.toLowerCase()}` : "unknown";
}

function readComposerLock(text) {
  try {
    const j = JSON.parse(text);
    const m = new Map();
    for (const p of [...(j.packages || []), ...(j["packages-dev"] || [])]) {
      const src = (p.dist && p.dist.url) || (p.source && p.source.url) || "";
      const replaces = Object.keys(p.replace || {}).sort().join(",");
      m.set(p.name, { version: String(p.version || "").replace(/^v/, ""), source: sourceOf(src, p.dist ? p.dist.type : p.source && p.source.type), ...(replaces ? { replaces } : {}) });
    }
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
        if (!m.has(name)) m.set(name, { version: v.version, source: sourceOf(v.resolved || "", null, v.link ? "link" : null), ...(v.hasInstallScript ? { install: true } : {}) });
      }
    } else if (j.dependencies) {
      const walk = (deps) => {
        for (const [name, v] of Object.entries(deps)) {
          if (!m.has(name)) m.set(name, { version: v.version, source: sourceOf(v.resolved || "") });
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
      if (b && a.source && b.source && a.source !== b.source) observed.push({ op: "dependency_source_changed", key, detail: `${b.source} → ${a.source}`, risk: "dependency_source_changed" });
      if (!b && a.source && !/^registry:(?:registry\.npmjs\.org|repo\.packagist\.org|api\.github\.com|codeload\.github\.com|github\.com|registry\.yarnpkg\.com)$/.test(a.source) && (isDirect(name) || /^(git|path|link)/.test(a.source))) observed.push({ op: "dependency_source_changed", key, detail: `new, from ${a.source}`, risk: "dependency_source_changed" });

    }
    // A real replacement: a package left the lockfile and another one now claims it via
    // composer's `replace` (a different implementation installs under the old name).
    const claimedBy = new Map();
    for (const [n, v] of after) for (const r of String(v.replaces || "").split(",").filter(Boolean)) claimedBy.set(r, n);
    for (const name of before.keys()) {
      if (!after.has(name) && claimedBy.has(name)) observed.push({ op: "package_replaced", key: `${spec.eco}:${name}`, detail: `removed; now provided by ${claimedBy.get(name)}`, risk: "package_replacement_changed" });
    }
    for (const name of before.keys()) {
      if (after.has(name)) continue;
      if (isDirect(name)) observed.push({ op: "dependency_removed", key: `${spec.eco}:${name}` });
      else transitive.removed++;
    }
    const t = Object.entries(transitive).filter(([, n]) => n);
    if (t.length) observed.push({ op: "transitive_changes", key: `${spec.eco}:${lock}`, detail: t.map(([k, n]) => `${n} ${k}`).join(", "), counts: transitive });
  }
  // Direct dependencies the manifest requires but the lockfile doesn't lock: what will be
  // installed for them can't be established.
  for (const [lock, spec] of Object.entries(LOCKS)) {
    if (!paths.has(lock) && !paths.has(spec.manifest)) continue;
    const lockText = show(cwd, head, lock);
    const manifestText = show(cwd, head, spec.manifest);
    if (lockText === null || manifestText === null) continue;
    const locked = spec.read(lockText);
    // Required ones only: peer and optional dependencies may legitimately be unlocked.
    const direct = requiredDeps(manifestText, spec.eco);
    if (!locked || !direct) continue;
    const platform = spec.eco === "composer" ? /^(php|ext-|lib-|composer(-plugin|-runtime)?-api$|composer$)/ : /^$/;
    const missing = [...direct].filter((n) => !platform.test(n) && !locked.has(n));
    if (missing.length) unknown.push(`${spec.manifest} requires ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}, not in ${lock}`);
  }
  // npm overrides / yarn resolutions / pnpm overrides: they change what installs without
  // touching any version constraint.
  if (paths.has("package.json")) {
    const pick = (t) => {
      try {
        const j = JSON.parse(t || "{}");
        return JSON.stringify([j.overrides || null, j.resolutions || null, (j.pnpm && j.pnpm.overrides) || null]);
      } catch {
        return null;
      }
    };
    const ob = pick(show(cwd, base, "package.json"));
    const oa = pick(show(cwd, head, "package.json"));
    if (ob !== null && oa !== null && ob !== oa) observed.push({ op: "dependency_overrides_changed", key: "npm:package.json", detail: "overrides or resolutions changed", risk: "dependency_overrides_changed" });
  }
  // Vendored code (committed vendor/ or node_modules/) that changed although its locked
  // version didn't: nobody reads vendored code in review, so an edit there is easy to miss.
  observed.push(...vendoredChanges(cwd, base, head, changed));

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

// Package directories under vendor/ (composer) and node_modules/ (npm) whose files changed.
// Tooling files that regenerate on every install are ignored.
const VENDOR_IGNORE = /^vendor\/(?:composer|bin)\/|^vendor\/autoload\.php$|^node_modules\/(?:\.bin|\.package-lock\.json|\.cache|\.vite)/;
function vendoredChanges(cwd, base, head, changed) {
  const pkgs = new Map();
  for (const f of changed) {
    const p = f.path;
    if (VENDOR_IGNORE.test(p)) continue;
    let m = /^vendor\/([^/]+\/[^/]+)\//.exec(p);
    let eco = "composer";
    if (!m) {
      m = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
      eco = "npm";
    }
    if (!m) continue;
    const key = `${eco}:${m[1]}`;
    if (!pkgs.has(key)) pkgs.set(key, { eco, name: m[1], files: 0 });
    pkgs.get(key).files++;
  }
  if (!pkgs.size) return [];
  const lockFor = { composer: ["composer.lock"], npm: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] };
  const versions = {};
  for (const eco of ["composer", "npm"]) {
    for (const lock of lockFor[eco]) {
      const spec = LOCKS[lock];
      const b = show(cwd, base, lock);
      const a = show(cwd, head, lock);
      if (a === null && b === null) continue;
      versions[eco] = { before: b === null ? new Map() : spec.read(b) || new Map(), after: a === null ? new Map() : spec.read(a) || new Map(), lock };
      break;
    }
  }
  const out = [];
  for (const { eco, name, files } of pkgs.values()) {
    const v = versions[eco];
    const before = v && v.before.get(name);
    const after = v && v.after.get(name);
    const lockMoved = before && after ? before.version !== after.version : before !== after;
    if (v && lockMoved) continue; // an install or upgrade: the lockfile accounts for it
    out.push({ op: "vendored_code_changed", key: `${eco}:${name}`, detail: `${files} file${files === 1 ? "" : "s"} changed in ${eco === "composer" ? "vendor" : "node_modules"}/${name}, ${v ? `but its version in ${v.lock} didn't change` : "and no lockfile records it"}`, risk: "vendored_code_changed" });
  }
  return out;
}

function requiredDeps(text, eco) {
  try {
    const j = JSON.parse(text);
    const keys = eco === "composer" ? ["require", "require-dev"] : ["dependencies", "devDependencies"];
    const out = new Set();
    for (const k of keys) for (const [n, v] of Object.entries(j[k] || {})) if (!/^(workspace:|link:|file:|npm:|catalog:|portal:|patch:)/.test(String(v))) out.add(n);
    return out;
  } catch {
    return null;
  }
}

function depVersions(text, eco) {
  const j = JSON.parse(text);
  const keys = eco === "composer" ? ["require", "require-dev"] : ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  return keys.map((k) => j[k] || {});
}

module.exports = { extractDependencies, readComposerLock, readPnpmLock, readYarnLock, readPackageLock, major, cmp };
