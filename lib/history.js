"use strict";

// Merged pull requests, recovered from git history alone (no GitHub API needed):
//   squash merges   "subject (#123)"       base = parent, head = commit
//   merge commits   "Merge pull request #123 from ..."  base = first parent, head = commit
// Walks the first-parent chain of the given branch, so each PR is one step of main.

const { git } = require("./git");

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*/;

function parseSubject(subject) {
  let pr = null;
  let kind = null;
  let title = subject;
  let m = /^Merge pull request #(\d+) from \S+/.exec(subject);
  if (m) {
    pr = Number(m[1]);
    kind = "merge";
  } else if ((m = /\s\(#(\d+)\)\s*$/.exec(subject))) {
    pr = Number(m[1]);
    kind = "squash";
    title = subject.slice(0, m.index);
  }
  const c = CONVENTIONAL.exec(title);
  const revert = /^Revert\s+"/.test(title) || (c && c[1].toLowerCase() === "revert");
  return { pr, kind, title, type: revert ? "revert" : c ? c[1].toLowerCase() : null, scope: c ? c[2] || null : null, breaking: !!(c && c[3]) };
}

// List merged PRs on `ref`, oldest first. Options: since (ISO date), limit (most recent N).
function mergedPRs(cwd, { ref = "HEAD", since, limit } = {}) {
  const args = ["log", "--first-parent", "--format=%H%x1f%P%x1f%aI%x1f%s%x1f%b%x1e", ref];
  if (since) args.splice(2, 0, `--since=${since}`);
  const out = git(cwd, args);
  const prs = [];
  for (const rec of out.split("\x1e")) {
    const [sha, parents, date, subject, body] = rec.replace(/^\n/, "").split("\x1f");
    if (!sha) continue;
    const ps = (parents || "").split(" ").filter(Boolean);
    if (!ps.length) continue; // root commit
    const info = parseSubject(subject || "");
    if (!info.pr) continue;
    if (info.kind === "merge" && ps.length < 2) continue;
    // For merge commits the PR's own title is the first body line.
    const title = info.kind === "merge" ? (String(body || "").trim().split("\n")[0] || info.title) : info.title;
    const t = info.kind === "merge" ? parseSubject(title) : info;
    prs.push({ pr: info.pr, sha, base: ps[0], date, title, type: t.type, scope: t.scope, breaking: t.breaking, kind: info.kind, body: String(body || "") });
  }
  prs.reverse();
  return limit ? prs.slice(-limit) : prs;
}

// SHA a revert commit reverts ("This reverts commit <sha>."), if stated.
function revertedSha(body) {
  const m = /This reverts commit ([0-9a-f]{7,40})/.exec(body || "");
  return m ? m[1] : null;
}

module.exports = { mergedPRs, parseSubject, revertedSha };
