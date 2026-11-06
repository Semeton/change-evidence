"use strict";

// What happened to each PR after it merged, with provenance. None of this is ground
// truth; every label says how it was found and how much weight it can bear.
//
// Reverts, by how the revert names its target:
//   sha     "This reverts commit <sha>" (git revert's own message)     confidence high
//   title   `Revert "<the PR's exact title>"`                          confidence medium
//   pr-ref  the revert's title mentions #N                             confidence low
// A revert that was itself reverted later (`Revert "Revert …"`, or `Reapply "…"` from
// git 2.43 on: the change was restored) is marked `restored`:
// the original may have been pulled for timing or a dependency, not a defect.
//
// Fix follow-ups (SZZ): a later fix PR deletes or modifies lines this PR introduced
// (`git blame -w` at the fix's base). Always a candidate, never confirmed: the blamed
// line may have been touched for an unrelated reason, and fixes that only add lines
// implicate nothing. A fix is any main-line commit (a PR or a direct push) typed `fix`
// or titled "Fix…", "Fixed…", "Hotfix…", "Bugfix…".
//
// Labels built from these (see labelFor):
//   strict     positive = a high- or medium-confidence revert that stayed reverted;
//              negative = no outcome of any kind; everything else is excluded as
//              ambiguous, and counted, never silently treated as a failure.
//   inclusive  positive = any revert or SZZ candidate; negative = none.

const { git, changedFiles } = require("./git");
const { parseSubject, revertedSha } = require("./history");

const NOISE = /(^|\/)(composer\.(json|lock)|package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|CHANGELOG[^/]*|README[^/]*|\.version)$|\.(md|snap|svg|png|jpg|lock)$/i;
const FIX_TITLE = /^(?:hot|bug)?fix(?:e[sd]|ing)?\b/i;
const CONFIDENCE = { sha: "high", title: "medium", "pr-ref": "low" };

function isFix(pr) {
  return pr.type === "fix" || FIX_TITLE.test(String(pr.title || "").trim());
}

const days = (a, b) => (new Date(b) - new Date(a)) / 86400000;

// Every revert on the main line (from a PR or a direct push) → the PR it undoes.
// Returns Map(prNumber -> [{ by, date, how, confidence, restored? }]), oldest first.
function findReverts(cwd, prs, ref) {
  const bySha = new Map(prs.map((p) => [p.sha, p]));
  const byNum = new Map(prs.map((p) => [p.pr, p]));
  const byTitle = new Map();
  for (const p of prs) {
    byTitle.set(p.title.trim(), p);
    byTitle.set(`${p.title.trim()} (#${p.pr})`, p);
  }
  const log = git(cwd, ["log", "--first-parent", "--reverse", "--format=%H%x1f%aI%x1f%s%x1f%b%x1e", ref]);
  const commits = log
    .split("\x1e")
    .map((rec) => rec.replace(/^\n/, "").split("\x1f"))
    .filter(([sha]) => sha)
    .map(([sha, date, subject, body]) => ({ sha, date, subject: subject || "", body: body || "" }));
  const revertOf = new Map(); // revert commit sha -> { target sha, how }
  const out = new Map();
  for (const c of commits) {
    const info = parseSubject(c.subject);
    // git ≥ 2.43 titles the revert of a revert `Reapply "…"` rather than `Revert "Revert …"`.
    const reapply = /^Reapply\s+"/.test(c.subject);
    if (info.type !== "revert" && !reapply) continue;
    let target = null;
    let how = null;
    const rs = revertedSha(c.body);
    if (rs) {
      const full = [...bySha.keys()].find((s) => s.startsWith(rs) || rs.startsWith(s)) || [...revertOf.keys()].find((s) => s.startsWith(rs) || rs.startsWith(s));
      if (full) {
        target = full;
        how = "sha";
      }
    }
    if (!target) {
      const q = /^(?:Revert|Reapply)\s+"(.+)"\s*$/.exec(info.title);
      if (q) {
        const inner = q[1].trim();
        if (byTitle.has(inner)) {
          target = byTitle.get(inner).sha;
          how = "title";
        } else {
          // `Revert "Revert ..."`: find the revert commit with that subject.
          const prior = commits.find((x) => x.subject.trim() === inner && revertOf.has(x.sha));
          if (prior) {
            target = prior.sha;
            how = "title";
          }
        }
      }
    }
    if (!target) {
      const nums = [...info.title.matchAll(/#(\d+)/g)].map((m) => Number(m[1])).filter((n) => n !== info.pr && byNum.has(n));
      if (nums.length) {
        target = byNum.get(nums[0]).sha;
        how = "pr-ref";
      }
    }
    if (!target || target === c.sha) continue;
    revertOf.set(c.sha, { target, how });
    if (revertOf.has(target)) {
      // Reverting a revert restores the original change.
      const original = revertOf.get(target).target;
      const pr = bySha.get(original);
      if (pr && out.has(pr.pr)) {
        const entry = out.get(pr.pr).find((e) => e.revertSha === target);
        if (entry) entry.restored = { by: c.sha.slice(0, 10), date: c.date };
      }
      continue;
    }
    const pr = bySha.get(target);
    if (!pr) continue;
    if (!out.has(pr.pr)) out.set(pr.pr, []);
    out.get(pr.pr).push({ by: c.sha.slice(0, 10), revertSha: c.sha, date: c.date, how, confidence: CONFIDENCE[how] });
  }
  for (const list of out.values()) for (const e of list) delete e.revertSha;
  return out;
}

// SZZ: commits that last touched the lines a fix deletes or modifies, with how many
// lines each one is blamed for. Map(sha -> blamedLines).
function fixInducing(cwd, fix) {
  const blamed = new Map();
  const files = fix.files.filter((x) => x.status === "M" && !NOISE.test(x.path) && !/^tests?\//.test(x.path) && !x.generated).map((x) => x.path).slice(0, 30);
  if (!files.length) return blamed;
  const diff = git(cwd, ["diff", "-U0", "--no-color", "--no-ext-diff", fix.base, fix.sha, "--", ...files], { allowFail: true }) || "";
  const ranges = new Map();
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) file = line.startsWith("--- a/") ? line.slice(6) : null;
    const h = /^@@ -(\d+)(?:,(\d+))? \+/.exec(line);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) {
        if (!ranges.has(file)) ranges.set(file, []);
        ranges.get(file).push([start, start + count - 1]);
      }
    }
  }
  for (const [path, rs] of ranges) {
    const args = ["blame", "--line-porcelain", "-w", ...rs.slice(0, 50).flatMap(([a, b]) => ["-L", `${a},${b}`]), fix.base, "--", path];
    const out = git(cwd, args, { allowFail: true }) || "";
    for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) blamed.set(m[1], (blamed.get(m[1]) || 0) + 1);
  }
  return blamed;
}

// Every fix on the main line, whether it came through a PR or was pushed directly:
// many maintainers push small fixes straight to the default branch, and those fixes
// are evidence about the PRs that introduced the lines they change.
function mainLineFixes(cwd, ref, rows) {
  const prBySha = new Map(rows.map((r) => [r.sha, r]));
  const out = [];
  const log = git(cwd, ["log", "--first-parent", "--format=%H%x1f%P%x1f%aI%x1f%s%x1f%b%x1e", ref]);
  for (const rec of log.split("\x1e")) {
    const [sha, parents, date, subject, body] = rec.replace(/^\n/, "").split("\x1f");
    if (!sha || !parents) continue;
    const base = parents.split(" ")[0];
    const pr = prBySha.get(sha);
    const title = pr ? pr.title : /^Merge pull request #/.test(subject || "") ? String(body || "").trim().split("\n")[0] : subject || "";
    const conventional = /^(\w+)(?:\([^)]*\))?!?:/.exec(title);
    if (!(isFix({ type: conventional ? conventional[1].toLowerCase() : null, title }))) continue;
    out.push({ sha, base, date, title, pr: pr ? pr.pr : null, files: pr ? pr.files : changedFiles(cwd, base, sha) });
  }
  return out;
}

// Attach outcomes to study rows (in place). `allPrs` is the full history, so reverts of
// PRs outside the studied window still resolve.
function attachOutcomes(cwd, rows, { ref = "HEAD", allPrs, followupDays = 14 } = {}) {
  const reverts = findReverts(cwd, allPrs || rows, ref);
  // Blame names the commit that wrote a line. For a squash merge that is the PR's own
  // commit; for a merge commit it is one of the branch's commits, never the merge. So
  // map every commit a merged PR brought in back to that PR, or merge-based histories
  // would get no SZZ labels at all.
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  for (const r of rows) {
    if (r.kind !== "merge") continue;
    const brought = git(cwd, ["rev-list", "--no-merges", `${r.base}..${r.sha}`], { allowFail: true }) || "";
    for (const c of brought.split("\n").filter(Boolean)) if (!bySha.has(c)) bySha.set(c, r);
  }
  for (const r of rows) r.outcomes = { reverts: reverts.get(r.pr) || [], fixes: [] };
  const first = rows.length ? rows[0].date : null;
  for (const f of mainLineFixes(cwd, ref, rows)) {
    if (first && f.date < first) continue; // older than anything studied
    for (const [sha, lines] of fixInducing(cwd, f)) {
      const origin = bySha.get(sha);
      if (!origin || origin.sha === f.sha) continue;
      const d = days(origin.date, f.date);
      if (d < 0 || d > followupDays) continue;
      const id = f.pr || f.sha.slice(0, 10);
      if (!origin.outcomes.fixes.some((x) => (x.pr || x.commit) === id)) origin.outcomes.fixes.push({ ...(f.pr ? { pr: f.pr } : { commit: f.sha.slice(0, 10) }), blamed_lines: lines, days: Math.round(d * 10) / 10, confidence: "candidate" });
    }
  }
  // Legacy fields kept for existing CSV consumers.
  for (const r of rows) {
    const firm = r.outcomes.reverts.find((e) => !e.restored) || r.outcomes.reverts[0] || null;
    r.reverted = firm ? { by: firm.by, date: firm.date, how: firm.how } : null;
    r.fix_followups = r.outcomes.fixes.map((x) => (x.pr ? x.pr : x.commit));
  }
  return rows;
}

// true (positive), false (negative) or null (ambiguous: excluded, and counted).
function labelFor(r, definition = "strict") {
  const o = r.outcomes || { reverts: [], fixes: [] };
  const firm = o.reverts.some((e) => (e.confidence === "high" || e.confidence === "medium") && !e.restored);
  const any = o.reverts.length > 0 || o.fixes.length > 0;
  if (definition === "inclusive") return any;
  if (firm) return true;
  return any ? null : false;
}

module.exports = { findReverts, fixInducing, attachOutcomes, mainLineFixes, labelFor, isFix, NOISE };
