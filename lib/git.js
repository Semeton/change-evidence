"use strict";

// Read-only git access. Everything the study needs comes from the object database:
// it never checks out, builds or executes the code under study, so every result it
// produces is "trusted" evidence in the spec's sense (produced by reading files as data).

const { execFileSync } = require("child_process");

// core.quotePath=false keeps non-ASCII paths unquoted, so diff headers and name lists
// agree. `env` adds variables for one call (used to pass credentials as config through
// the environment rather than argv, where other processes could read them).
function git(cwd, args, { allowFail = false, env = {} } = {}) {
  try {
    return execFileSync("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
    });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// A user-supplied revision, resolved to a full commit SHA. `--end-of-options` means a
// value like "--upload-pack=…" can only ever be read as a revision, never as an option.
function resolveCommit(cwd, rev) {
  if (typeof rev !== "string" || !rev || rev.length > 256 || /[\0\n]/.test(rev)) throw Object.assign(new Error(`not a revision: ${String(rev).slice(0, 60)}`), { exit: 2 });
  const out = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], { allowFail: true });
  if (!out || !/^[0-9a-f]{40}\s*$/.test(out)) throw Object.assign(new Error(`not a commit in this repository: ${rev.slice(0, 60)}`), { exit: 2 });
  return out.trim();
}

// File content at a commit; null if absent there.
function show(cwd, commit, file) {
  return git(cwd, ["show", `${commit}:${file}`], { allowFail: true });
}

// Files changed between two commits, with rename detection.
// Returns [{ status: "A"|"M"|"D"|"R"|"C"|"T", path, from? }]
function changedFiles(cwd, base, head) {
  const out = git(cwd, ["diff", "--name-status", "-M", "-z", `${base}`, `${head}`]).split("\0").filter(Boolean);
  const files = [];
  for (let i = 0; i < out.length; ) {
    const status = out[i++];
    if (status[0] === "R" || status[0] === "C") {
      const from = out[i++];
      const to = out[i++];
      files.push({ status: status[0], path: to, from });
    } else {
      files.push({ status: status[0], path: out[i++] });
    }
  }
  return files;
}

// Added and removed line counts per file (binary files count as 0).
function numstat(cwd, base, head) {
  const out = git(cwd, ["diff", "--numstat", "-M", base, head]).trim();
  let added = 0;
  let removed = 0;
  for (const line of out ? out.split("\n") : []) {
    const [a, r] = line.split("\t");
    added += Number(a) || 0;
    removed += Number(r) || 0;
  }
  return { added, removed };
}

// Added and removed lines of a diff, per file, for pattern rules.
function diffLines(cwd, base, head, files) {
  if (!files.length) return new Map();
  const out = git(cwd, ["diff", "-U0", "-M", base, head, "--", ...files]);
  const byFile = new Map();
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("+++ ")) {
      current = line.startsWith("+++ b/") ? line.slice(6) : null;
      if (current && !byFile.has(current)) byFile.set(current, { added: [], removed: [] });
    } else if (line.startsWith("--- ")) {
      // the "from" side; the "+++" line names the file
    } else if (current && line.startsWith("+")) {
      byFile.get(current).added.push(line.slice(1));
    } else if (current && line.startsWith("-")) {
      byFile.get(current).removed.push(line.slice(1));
    }
  }
  return byFile;
}

module.exports = { git, show, changedFiles, numstat, diffLines, resolveCommit };
