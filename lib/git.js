"use strict";

// Read-only git access. Everything the study needs comes from the object database:
// it never checks out, builds or executes the code under study, so every result it
// produces is "trusted" evidence in the spec's sense (produced by reading files as data).

const { execFileSync } = require("child_process");

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
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

module.exports = { git, show, changedFiles, numstat, diffLines };
