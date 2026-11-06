"use strict";

// GitHub Actions workflows and local actions. A change here is trust root by policy, so
// this extractor never lowers anything: it says exactly what kind of change it is, so a
// routine Action bump reads differently from a change to what a workflow may do.
//
// For each changed file, the facts on both sides are compared:
//   uses        each Action / reusable workflow reference, its old and new ref, and
//               whether the new ref is a full commit SHA (a tag or branch can be moved)
//   triggers    `on:` events; adding pull_request_target, workflow_run or issue_comment
//               (privileged triggers that run with the base repository's token) is flagged
//   permissions every `permissions:` scope, workflow- and job-level; a new write scope or
//               write-all is flagged
//   secrets     `secrets.NAME` references and `secrets: inherit`; new ones are flagged
//   shell       `${{ github.event.* }}` / `github.head_ref` inside `run:`: PR-controlled
//               text interpolated into shell (heuristic: flags the pattern, not an exploit)
//   checkout    a workflow with a privileged trigger that checks out PR code (heuristic)
//   release     publishing or deploying (npm publish, docker push, gh release, environment:,
//               id-token: write)
//
// Read as text, not parsed YAML: anchors, multi-document files and flow-style mappings
// beyond the common forms are outside coverage. Facts it can't read are not invented.

const { show, diffLines } = require("../git");
const { result, STATES } = require("../evidence");

const isWorkflow = (p) => /^\.github\/(workflows\/[^/]+\.ya?ml|actions\/.+)$/.test(p);
const USES = /^\s*(?:-\s*)?uses:\s*['"]?([^'"\s#]+)['"]?/;
const PRIVILEGED = new Set(["pull_request_target", "workflow_run", "issue_comment", "pull_request_review_comment", "discussion_comment"]);
const UNTRUSTED_EXPR = /\$\{\{\s*(github\.event\.(?:pull_request|issue|comment|review|review_comment|discussion|head_commit|commits|workflow_run|pages)\b[^}]*|github\.head_ref\b[^}]*)\}\}/;
const RELEASE = /\bnpm\s+publish\b|\bdocker\s+(?:buildx\s+)?push\b|\bgh\s+release\b|\btwine\s+upload\b|\bvercel\b.*--prod|^\s*environment:|id-token:\s*write/m;

function usesIn(text) {
  const out = new Map();
  for (const line of String(text || "").split("\n")) {
    const m = USES.exec(line);
    if (!m || m[1].startsWith("docker://")) continue;
    if (m[1].startsWith("./")) {
      if (!out.has(m[1])) out.set(m[1], new Set(["(local)"]));
      continue;
    }
    const [action, ref = ""] = m[1].split("@");
    if (!out.has(action)) out.set(action, new Set());
    out.get(action).add(ref);
  }
  return out;
}

// `on:` events, from the inline and block forms.
function triggersIn(text) {
  const events = new Set();
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(?:on|"on"|'on'):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const inline = m[1].replace(/#.*$/, "").trim();
    if (inline.startsWith("[")) inline.slice(1, -1).split(",").forEach((e) => e.trim() && events.add(e.trim().replace(/['"]/g, "")));
    else if (inline) events.add(inline.replace(/['"]/g, ""));
    else {
      // Events are the keys at the first indentation level under `on:`, nothing deeper.
      let level = null;
      for (let j = i + 1; j < lines.length && (/^\s/.test(lines[j]) || !lines[j].trim()); j++) {
        if (!lines[j].trim() || /^\s*#/.test(lines[j])) continue;
        const indent = lines[j].search(/\S/);
        if (level === null) level = indent;
        if (indent !== level) continue;
        const k = /^\s*([A-Za-z_]+)\s*:/.exec(lines[j]) || /^\s*-\s*([A-Za-z_]+)\s*$/.exec(lines[j]);
        if (k) events.add(k[1]);
      }
    }
  }
  return events;
}

// Permission scopes as "where scope=level" strings. `where` is "workflow" or the job id.
function permissionsIn(text) {
  const out = new Set();
  const lines = String(text || "").split("\n");
  let job = null;
  let inJobs = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^jobs:\s*$/.test(l)) inJobs = true;
    else if (/^\S/.test(l)) inJobs = false;
    const jm = inJobs && /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (jm) job = jm[1];
    const pm = /^(\s*)permissions:\s*(.*)$/.exec(l);
    if (!pm) continue;
    const where = pm[1].length === 0 ? "workflow" : job || "job";
    const inline = pm[2].replace(/#.*$/, "").trim();
    if (inline && inline !== "{}") out.add(`${where} ${inline}`);
    else if (inline === "{}") out.add(`${where} none`);
    else {
      const indent = pm[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        if (lines[j].search(/\S/) <= indent) break;
        const s = /^\s*([a-z-]+):\s*(read|write|none)\b/.exec(lines[j]);
        if (s) out.add(`${where} ${s[1]}=${s[2]}`);
      }
    }
  }
  return out;
}

function secretsIn(text) {
  const out = new Set();
  // GITHUB_TOKEN is the run's built-in token, there whether referenced or not; its reach
  // is set by `permissions:`, which is tracked separately.
  for (const m of String(text || "").matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (m[1] !== "GITHUB_TOKEN") out.add(m[1]);
  if (/^\s*secrets:\s*inherit\b/m.test(String(text || ""))) out.add("(inherit)");
  return out;
}

// Lines of shell: `run:` inline values and the bodies of `run: |` blocks.
function shellLines(text) {
  const out = [];
  const lines = String(text || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (m[2] && !/^[|>][+-]?\s*$/.test(m[2])) {
      out.push({ n: i + 1, text: m[2] });
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) continue;
      if (lines[j].search(/\S/) <= m[1].length) break;
      out.push({ n: j + 1, text: lines[j] });
    }
  }
  return out;
}

const pinned = (ref) => /^[0-9a-f]{40}$/.test(ref);
const isWrite = (p) => /=write$|\swrite-all$/.test(p);

function extractWorkflows(ctx) {
  const { cwd, base, head, changed } = ctx;
  const touched = changed.filter((f) => isWorkflow(f.path) || (f.from && isWorkflow(f.from)));
  if (!touched.length) return result("workflows", { state: STATES.PASS, note: "no workflow files changed" });
  const observed = [];
  const unknown = [];
  const diff = diffLines(cwd, base, head, touched.filter((f) => f.status !== "D").map((f) => f.path));
  for (const f of touched) {
    const beforeText = f.status === "A" ? "" : show(cwd, base, f.from || f.path) || "";
    const afterText = f.status === "D" ? "" : show(cwd, head, f.path) || "";
    const file = f.path;
    const separators = (afterText.match(/^---\s*$/gm) || []).length - (/^---\s*\n/.test(afterText) ? 1 : 0);
    if (/^\t/m.test(afterText) || separators > 0) unknown.push(`${file}: tab indentation or several YAML documents; the facts below may be incomplete`);

    // Actions and reusable workflows.
    const before = usesIn(beforeText);
    const after = usesIn(afterText);
    for (const [action, refs] of after) {
      const old = before.get(action);
      for (const ref of refs) {
        if (old && old.has(ref)) continue;
        const local = ref === "(local)";
        const reusable = /\/\.github\/workflows\//.test(action);
        const from = old ? [...old].filter((r) => !refs.has(r)).join(", ") : null;
        observed.push({
          op: local ? "local_action_referenced" : from ? "action_ref_changed" : "action_added",
          key: `${file}: ${action}`,
          file,
          detail: local ? "local action or workflow (its own changes are listed separately)" : `${reusable ? "reusable workflow, " : ""}${from ? `${from} → ` : ""}${ref || "(no ref)"}${pinned(ref) ? " (SHA-pinned)" : ""}`,
          ...(local || pinned(ref) ? {} : { risk: "unpinned_action" }),
        });
      }
    }
    for (const [action] of before) if (!after.has(action)) observed.push({ op: "action_removed", key: `${file}: ${action}`, file });

    // Triggers.
    const tb = triggersIn(beforeText);
    const ta = triggersIn(afterText);
    for (const e of ta) if (!tb.has(e)) observed.push({ op: "trigger_added", key: `${file}: on ${e}`, file, ...(PRIVILEGED.has(e) ? { risk: "privileged_trigger_added", detail: "runs with the base repository's token and secrets" } : {}) });
    for (const e of tb) if (!ta.has(e)) observed.push({ op: "trigger_removed", key: `${file}: on ${e}`, file });

    // Permissions.
    const pb = permissionsIn(beforeText);
    const pa = permissionsIn(afterText);
    const gained = [...pa].filter((p) => !pb.has(p));
    const lost = [...pb].filter((p) => !pa.has(p));
    if (gained.length || lost.length) {
      const widened = gained.filter(isWrite);
      observed.push({ op: "permissions_changed", key: `${file}: permissions`, file, detail: [gained.length ? `now ${gained.join(", ")}` : null, lost.length ? `no longer ${lost.join(", ")}` : null].filter(Boolean).join("; "), ...(widened.length ? { risk: "permissions_widened" } : {}) });
    }
    if (!pa.size && pb.size && f.status !== "D") observed.push({ op: "permissions_changed", key: `${file}: permissions`, file, detail: "explicit permissions removed: the repository default now applies", risk: "permissions_widened" });

    // Secrets.
    const sb = secretsIn(beforeText);
    const sa = secretsIn(afterText);
    const newSecrets = [...sa].filter((s) => !sb.has(s));
    if (newSecrets.length) observed.push({ op: "secrets_referenced", key: `${file}: secrets`, file, detail: newSecrets.join(", "), risk: "secret_exposure_changed" });

    // Untrusted expressions in shell, on lines this change added.
    const added = new Set((diff.get(file) || { added: [] }).added.map((l) => l.n));
    for (const l of shellLines(afterText)) {
      const m = UNTRUSTED_EXPR.exec(l.text);
      if (m && (f.status === "A" || added.has(l.n))) observed.push({ op: "untrusted_expression_in_shell", key: `${file}:${l.n}`, file, line: l.n, detail: `\${{ ${m[1].trim()} }} in a run: line`, risk: "untrusted_expression_in_shell" });
    }

    // A privileged trigger plus a checkout of PR code: the "pwn request" shape.
    const privileged = [...ta].some((e) => PRIVILEGED.has(e));
    const prCheckout = /ref:\s*\$\{\{\s*github\.event\.(?:pull_request\.head\.(?:sha|ref)|workflow_run\.head_(?:sha|branch))|refs\/pull\/|repository:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo/.test(afterText);
    const prCheckoutBefore = /ref:\s*\$\{\{\s*github\.event\.(?:pull_request\.head\.(?:sha|ref)|workflow_run\.head_(?:sha|branch))|refs\/pull\/|repository:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo/.test(beforeText) && [...tb].some((e) => PRIVILEGED.has(e));
    if (privileged && prCheckout && !prCheckoutBefore) observed.push({ op: "privileged_pr_checkout", key: `${file}: privileged trigger + PR ref`, file, detail: "a workflow with a privileged trigger references the PR's code; check it is never checked out, built or run", risk: "privileged_pr_checkout" });

    // Release and deployment.
    const releasing = RELEASE.test(afterText) || RELEASE.test(beforeText);
    const d = diff.get(file) || { added: [], removed: [] };
    const other = [...d.added, ...d.removed].filter((l) => l.text.trim() && !USES.test(l.text)).length;
    if (other || f.status === "A" || f.status === "D") {
      observed.push({
        op: "workflow_changed",
        key: file,
        file,
        detail: f.status === "A" ? "new workflow" : f.status === "D" ? "workflow deleted" : `${other} non-\`uses:\` lines changed`,
        ...(releasing ? { risk: "release_workflow_changed" } : {}),
      });
    }
  }
  return result("workflows", { observed, unknown, inspected: touched.length });
}

module.exports = { extractWorkflows, usesIn, triggersIn, permissionsIn, secretsIn, shellLines };
