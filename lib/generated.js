"use strict";

// Which changed files are generated or vendored. They're still in the evidence (path
// rules still apply, and a PR that edits `vendor/` is still reported), but they don't
// count toward the size rules: a rebuilt asset bundle isn't a bigger change to review.
//
// Two sources, both trusted:
//   - the policy's `generated` globs (defaults below; an overlay adds its own);
//   - `linguist-generated` / `linguist-vendored` in the BASE commit's root .gitattributes.
// The PR's own .gitattributes is never read: otherwise a PR could mark its own code as
// generated to stay under the size threshold. Nested .gitattributes files aren't read.

const { show } = require("./git");
const { globRe } = require("./risk");

// gitattributes pattern → our glob: no slash matches at any depth; a leading slash
// anchors at the root; a trailing slash means a directory.
function attrGlob(pattern) {
  let p = pattern.trim();
  if (!p || p.startsWith("!")) return null;
  const dir = p.endsWith("/");
  if (dir) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\//, "");
  if (!anchored) p = `**/${p}`;
  return dir || !/[*?[]/.test(p.split("/").pop()) ? [p, `${p}/**`] : [p];
}

function attributeGlobs(text) {
  const out = [];
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    const on = attrs.some((a) => a === "linguist-generated" || a === "linguist-generated=true" || a === "linguist-vendored" || a === "linguist-vendored=true");
    if (!on) continue;
    const g = attrGlob(pattern);
    if (g) out.push(...g);
  }
  return out;
}

// A classifier for one evaluation: (path) -> reason or null.
function classifier(cwd, base, policy) {
  const fromPolicy = (policy.generated || []).map((g) => ({ re: globRe(g), why: `policy: ${g}` }));
  const attrs = attributeGlobs(base ? show(cwd, base, ".gitattributes") : "").map((g) => ({ re: globRe(g), why: `.gitattributes: ${g}` }));
  const all = [...fromPolicy, ...attrs];
  return (path) => {
    for (const { re, why } of all) if (re.test(path)) return why;
    return null;
  };
}

module.exports = { classifier, attributeGlobs, attrGlob };
