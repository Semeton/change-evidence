"use strict";

// Markdown for untrusted strings. Everything a PR controls (file paths, route URIs,
// middleware names, table and package names, Action references, branch names) reaches
// the report through `code()` or `text()`, never raw. Goals, in order:
//   1. Structure can't be broken: no newlines, no table pipes, no closing a code span,
//      no raw HTML, so a hostile name can't add rows, links, images or fake sections.
//   2. Nobody gets pinged: `@name` and `#123` from untrusted text don't notify or link.
//   3. The bot's comment marker can't be forged from inside a report.
//   4. Output stays bounded.

const MAX_ITEM = 200;
const MARKER = "<!-- change-evidence -->";
// Zero-width space: breaks @mentions, #refs and the comment marker without changing
// what a reader sees.
const ZWSP = "​";

// Control characters (including newlines and bidi overrides) become a visible "�".
function clean(s, max = MAX_ITEM) {
  let t = String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "�");
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t;
}

// Inline code. The fence is one backtick longer than the longest run inside, padded
// when the content starts or ends with a backtick (CommonMark rule). Inside a table,
// `|` must still be escaped: GFM splits cells before it parses code spans.
function code(s, { table = false, max } = {}) {
  let t = clean(s, max);
  if (!t) return "``";
  const longest = Math.max(0, ...(t.match(/`+/g) || []).map((r) => r.length));
  const fence = "`".repeat(longest + 1);
  if (table) t = t.replace(/\|/g, "\\|");
  const pad = t.startsWith("`") || t.endsWith("`") || (t.startsWith(" ") && t.endsWith(" ") && t.trim()) ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

// Plain text with every Markdown and HTML meaning removed.
function text(s, { table = false, max } = {}) {
  let t = clean(s, max)
    // Untrusted text is always placed mid-line, so only inline syntax needs escaping:
    // emphasis, code, links and images, strikethrough and table pipes.
    .replace(/[\\`*_[\]~|]/g, (c) => `\\${c}`)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/@/g, `@${ZWSP}`)
    .replace(/:\/\//g, `:${ZWSP}//`);
  return t;
}

// Final guard on the whole body: the marker appears once, at the end, and GitHub's
// 65,536-character comment limit is respected.
function finalizeComment(body, { limit = 60000 } = {}) {
  let b = String(body).split(MARKER).join(`<!-${ZWSP}- change-evidence -->`);
  if (b.length > limit) b = `${b.slice(0, limit)}\n\n… report truncated; the full evidence is in the workflow artifact.\n`;
  return `${b}\n${MARKER}\n`;
}

module.exports = { code, text, clean, finalizeComment, MARKER, ZWSP };
