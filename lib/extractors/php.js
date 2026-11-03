"use strict";

// Just enough PHP lexing to read Laravel route files and migrations as data:
// comments stripped, strings respected, balanced brackets found, call chains split.
// It never evaluates anything. Constructs it can't read become UNKNOWN upstream.

// Replace comments with spaces (newlines kept), leaving string literals intact.
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "'" || c === '"') {
      const j = endOfString(src, i);
      out += src.slice(i, j);
      i = j;
    } else if (c === "/" && d === "/") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "#" && d !== "[") {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && d === "*") {
      const j = src.indexOf("*/", i + 2);
      const end = j === -1 ? n : j + 2;
      out += src.slice(i, end).replace(/[^\n]/g, " ");
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// Index just past the string literal that starts at i.
function endOfString(src, i) {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === "\\") j += 2;
    else if (src[j] === q) return j + 1;
    else j++;
  }
  return src.length;
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

// Index of the bracket that closes the one at i, respecting strings.
function matching(src, i) {
  const stack = [OPEN[src[i]]];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"') {
      j = endOfString(src, j);
      continue;
    }
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return j;
    }
    j++;
  }
  return -1;
}

// Split an argument list (text between parens) on top-level commas.
function splitArgs(text) {
  const args = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const j = endOfString(text, i);
      cur += text.slice(i, j);
      i = j - 1;
      continue;
    }
    if (OPEN[c]) depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

// A PHP string literal's value, or null if the text is not a plain literal.
// Double-quoted strings with interpolation are treated as non-literal.
function literal(text) {
  const t = String(text || "").trim();
  let m = /^'((?:[^'\\]|\\.)*)'$/.exec(t);
  if (m) return m[1].replace(/\\(['\\])/g, "$1");
  m = /^"((?:[^"\\$]|\\.)*)"$/.exec(t);
  if (m) return m[1].replace(/\\(["\\$])/g, "$1");
  return null;
}

// `Foo::class` → "Foo"; anything else → null.
function classRef(text) {
  const m = /^\\?([A-Za-z_][\w\\]*)::class$/.exec(String(text || "").trim());
  return m ? m[1] : null;
}

// Values of a middleware-like argument: string, Class::class, or an array of those.
// Returns { values, dynamic } where dynamic counts parts that could not be read.
function listValues(args) {
  const values = [];
  let dynamic = 0;
  const take = (a) => {
    const t = a.trim();
    if (t.startsWith("[") && t.endsWith("]")) {
      for (const x of splitArgs(t.slice(1, -1))) take(x.replace(/^['"][^'"]*['"]\s*=>\s*/, ""));
      return;
    }
    const v = literal(t) ?? classRef(t);
    if (v !== null) values.push(v);
    else dynamic++;
  };
  for (const a of args) take(a);
  return { values, dynamic };
}

// Parse a call chain like `Route::middleware('auth')->prefix('x')->get('a', X::class)`
// into [{ name, args, argsText }]. `text` starts at the first identifier after `Route::`.
function chainCalls(text) {
  const calls = [];
  let i = 0;
  while (i < text.length) {
    const m = /^\s*(?:->|::)?\s*([A-Za-z_]\w*)\s*\(/.exec(text.slice(i));
    if (!m) break;
    const open = i + m[0].length - 1;
    const close = matching(text, open);
    if (close === -1) break;
    const argsText = text.slice(open + 1, close);
    calls.push({ name: m[1], args: splitArgs(argsText), argsText });
    i = close + 1;
  }
  return calls;
}

module.exports = { stripComments, endOfString, matching, splitArgs, literal, classRef, listValues, chainCalls };
