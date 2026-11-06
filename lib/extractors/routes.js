"use strict";

// Laravel routes, read statically from routes/**/*.php.
//
// Follows Route::prefix()/middleware()/name()->group(closure) nesting, so each route
// carries its full URI and every middleware above it. What it can't resolve is reported,
// not guessed: a non-literal URI, a group loaded from another file, a route inside an
// `if` (registered only under some config) is marked conditional. Routes registered by
// service providers or packages are outside its coverage, and the result says so.

const { posix } = require("path");
const { show } = require("../git");
const { result, STATES } = require("../evidence");
const { stripComments, matching, splitArgs, literal, classRef, listValues, chainCalls } = require("./php");

const VERBS = { get: ["GET"], post: ["POST"], put: ["PUT"], patch: ["PATCH"], delete: ["DELETE"], options: ["OPTIONS"], any: ["ANY"] };
const RESOURCE = new Set(["resource", "apiResource", "singleton", "apiSingleton"]);
const OTHER_DEFS = new Set(["view", "redirect", "permanentRedirect", "fallback", "match"]);
// Middleware that authenticates or authorises. Throttling is protective but isn't auth,
// so a new route behind throttle alone still counts as unauthenticated.
const AUTH_MW = /(auth|^can:|^signed$|password\.confirm|abilit|role|permission)/i;
// Middleware whose removal from a route weakens it.
const SECURITY_MW = /(auth|^can:|^signed$|^throttle|^verified$|password\.confirm|^guest$|role|permission|abilit)/i;

const CANON = new Map(
  [...Object.keys(VERBS), ...RESOURCE, ...OTHER_DEFS, "prefix", "middleware", "withoutMiddleware", "name", "as", "domain", "group", "where", "only", "except"].map((n) => [n.toLowerCase(), n]),
);

function joinUri(prefixes, uri) {
  const parts = [...prefixes, uri].map((p) => String(p).replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return "/" + parts.join("/");
}

// Parse one route file's source. Returns { routes: Map(key -> attrs), unknown: [] , statements }.
// A PHP path expression used in `require` or `group(...)`, resolved against the including
// file: `__DIR__.'/x.php'`, `base_path('routes/x.php')`, or a plain literal. Null if dynamic.
function includePath(expr, file) {
  let t = String(expr || "").trim();
  // `require (__DIR__.'/x.php');`: unwrap parens only when they enclose the whole expression.
  while (t.startsWith("(") && matching(t, 0) === t.length - 1) t = t.slice(1, -1).trim();
  let m = /^__DIR__\s*\.\s*(['"])([^'"]+)\1$/.exec(t);
  if (m) return posix.normalize(posix.join(posix.dirname(file), m[2]));
  m = /^base_path\(\s*(['"])([^'"]+)\1\s*\)$/.exec(t);
  if (m) return posix.normalize(m[2].replace(/^\/+/, ""));
  m = /^dirname\(__DIR__\)\s*\.\s*(['"])([^'"]+)\1$/.exec(t);
  if (m) return posix.normalize(posix.join(posix.dirname(posix.dirname(file)), m[2]));
  return null;
}

const EMPTY_CTX = { prefixes: [], middleware: [], without: [], names: [], conditional: false, dynamic: false };

// opts.ctx: group context the file is loaded under (from a `require` inside a group)
// opts.resolve(path): source of another file, for following includes; null if absent
// opts.included: Set that collects every file reached through an include
function parseRoutes(source, file, opts = {}) {
  const code = stripComments(source);
  const routes = new Map();
  const unknown = [];
  const stack = opts.stack || new Set([file]);
  let statements = 0;

  function addRoute(key, attrs, line, where = file) {
    if (routes.has(key)) unknown.push(`${where}:${line}: ${key} is defined twice; the later definition wins at runtime`);
    routes.set(key, { ...attrs, file: attrs.file || where });
  }

  // Parse another route file under the current group context and merge its routes.
  function include(target, ctx, line) {
    if (!target) {
      unknown.push(`${file}:${line}: routes loaded from a dynamic path`);
      return;
    }
    if (stack.has(target)) {
      unknown.push(`${file}:${line}: ${target} includes itself`);
      return;
    }
    const src = opts.resolve ? opts.resolve(target) : null;
    if (src === null || src === undefined) {
      unknown.push(`${file}:${line}: routes loaded from ${target}, which could not be read`);
      return;
    }
    if (opts.included) opts.included.add(target);
    const child = parseRoutes(src, target, { ...opts, ctx, stack: new Set([...stack, target]) });
    for (const [k, v] of child.routes) addRoute(k, v, 0, v.file);
    unknown.push(...child.unknown);
    statements += child.statements;
  }

  function lineOf(i) {
    return code.slice(0, i).split("\n").length;
  }

  function apply(ctx, calls) {
    const next = { prefixes: [...ctx.prefixes], middleware: [...ctx.middleware], without: [...ctx.without], names: [...ctx.names], conditional: ctx.conditional, dynamic: ctx.dynamic };
    for (const c of calls) {
      if (c.name === "prefix") {
        const v = literal(c.args[0]);
        if (v === null) next.dynamic = true;
        else next.prefixes.push(v);
      } else if (c.name === "middleware") {
        // A middleware we can't read (e.g. config('jetstream.auth_session')) is kept as a
        // marker: the route is still identified, and adding or removing it still diffs.
        const { values, dynamic } = listValues(c.args);
        next.middleware.push(...values);
        if (dynamic) next.middleware.push("<dynamic>");
      } else if (c.name === "withoutMiddleware") {
        next.without.push(...listValues(c.args).values);
      } else if (c.name === "name" || c.name === "as") {
        const v = literal(c.args[0]);
        if (v !== null) next.names.push(v);
      } else if (c.name === "domain") {
        next.dynamic = true; // host-based routing: URI alone no longer identifies the route
      }
    }
    return next;
  }

  function routeDef(ctx, calls, at) {
    const first = calls[0];
    const rest = calls.slice(1);
    const local = apply(ctx, rest);
    const mw = [...new Set(local.middleware)].filter((m) => !local.without.includes(m)).sort();
    const line = lineOf(at);
    const uriLit = literal(first.args[0]);
    if (uriLit === null && first.name !== "fallback") {
      unknown.push(`${file}:${line}: ${first.name}() with a non-literal URI`);
      return;
    }
    let action = "unknown";
    const a = first.args[1];
    if (a !== undefined) {
      const t = a.trim();
      const cls = classRef(t);
      if (cls) action = cls.split("\\").pop();
      else if (t.startsWith("[")) {
        const parts = t.slice(1, -1).split(",").map((s) => s.trim());
        const c2 = classRef(parts[0]);
        const m = literal(parts[1]);
        action = c2 ? `${c2.split("\\").pop()}@${m ?? "?"}` : "unknown";
      } else if (/^(static\s+)?(fn|function)\b/.test(t)) action = "closure";
      else if (literal(t) !== null) action = literal(t);
      else action = "dynamic";
    }
    const attrs = { action, middleware: mw, ...(local.names.length ? { name: local.names.join("") } : {}), ...(local.conditional ? { conditional: true } : {}) };
    if (local.dynamic) unknown.push(`${file}:${line}: route ${uriLit} sits under a dynamic prefix, middleware or domain`);
    if (VERBS[first.name]) {
      for (const v of VERBS[first.name]) addRoute(`${v} ${joinUri(local.prefixes, uriLit)}`, attrs, line);
    } else if (first.name === "match") {
      const verbs = listValues([first.args[0]]).values.map((v) => v.toUpperCase());
      const uri = literal(first.args[1]);
      if (uri === null || !verbs.length) unknown.push(`${file}:${line}: match() with non-literal verbs or URI`);
      else for (const v of verbs) addRoute(`${v} ${joinUri(local.prefixes, uri)}`, { ...attrs, action: actionOf(first.args[2]) }, line);
    } else if (RESOURCE.has(first.name)) {
      addRoute(`${first.name.toUpperCase()} ${joinUri(local.prefixes, uriLit)}`, attrs, line);
    } else if (first.name === "fallback") {
      addRoute(`FALLBACK ${joinUri(local.prefixes, "")}`, { ...attrs, action: actionOf(first.args[0]) }, line);
    } else {
      addRoute(`${first.name.toUpperCase()} ${joinUri(local.prefixes, uriLit)}`, attrs, line);
    }
  }

  function actionOf(t) {
    if (t === undefined) return "unknown";
    const cls = classRef(t);
    if (cls) return cls.split("\\").pop();
    if (/^(static\s+)?(fn|function)\b/.test(t.trim())) return "closure";
    return "dynamic";
  }

  // Walk [start, end) of `code`, under group context `ctx`.
  function walk(start, end, ctx) {
    let i = start;
    while (i < end) {
      const c = code[i];
      if (c === "'" || c === '"') {
        i = require("./php").endOfString(code, i);
        continue;
      }
      const inc = /^(?:require|require_once|include|include_once)\b\s*([^;]+);/.exec(code.slice(i, i + 300));
      if (inc && !/[\w$>]/.test(code[i - 1] || "")) {
        statements++;
        include(includePath(inc[1], file), ctx, lineOf(i));
        i += inc[0].length;
        continue;
      }
      const rest = code.slice(i, i + 12);
      if (/^Route\s*::/.test(rest) && !/[\w$]/.test(code[i - 1] || "")) {
        i = statement(i, end, ctx);
        continue;
      }
      const cond = /^(if|elseif|foreach|for|while)\s*\(/.exec(code.slice(i, i + 10));
      if (cond && !/[\w$>]/.test(code[i - 1] || "")) {
        const open = code.indexOf("(", i);
        const close = matching(code, open);
        const brace = close === -1 ? -1 : code.slice(close + 1).search(/\S/) + close + 1;
        if (close !== -1 && code[brace] === "{") {
          const bodyEnd = matching(code, brace);
          if (bodyEnd !== -1) {
            walk(brace + 1, bodyEnd, { ...ctx, conditional: true });
            i = bodyEnd + 1;
            continue;
          }
        }
      }
      if (/^else\s*\{/.test(code.slice(i, i + 8)) && !/[\w$]/.test(code[i - 1] || "")) {
        const brace = code.indexOf("{", i);
        const bodyEnd = matching(code, brace);
        if (bodyEnd !== -1) {
          walk(brace + 1, bodyEnd, { ...ctx, conditional: true });
          i = bodyEnd + 1;
          continue;
        }
      }
      i++;
    }
  }

  // Read one Route:: statement starting at i; returns the index after it.
  function statement(i, end, ctx) {
    statements++;
    const startText = code.indexOf("::", i) + 2;
    // Find where the chain ends: `;` at bracket depth 0, scanning with brackets matched.
    let j = startText;
    let groupAt = -1;
    while (j < end) {
      const c = code[j];
      if (c === "'" || c === '"') {
        j = require("./php").endOfString(code, j);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") {
        if (c === "(" && groupAt === -1 && /(->|::)\s*group\s*$/.test(code.slice(Math.max(i, j - 12), j))) groupAt = j;
        const close = matching(code, j);
        if (close === -1) break;
        j = close + 1;
        continue;
      }
      if (c === ";") break;
      j++;
    }
    const chainText = code.slice(startText, groupAt === -1 ? j : groupAt);
    const calls = chainCalls(chainText).map((c) => ({ ...c, name: CANON.get(c.name.toLowerCase()) || c.name }));
    const line = lineOf(i);
    if (groupAt !== -1) {
      const close = matching(code, groupAt);
      const args = splitArgs(code.slice(groupAt + 1, close));
      // Legacy form: Route::group(['prefix' => ..., 'middleware' => ...], fn)
      const attrCalls = [];
      if (args.length > 1 && args[0].startsWith("[")) {
        for (const pair of splitArgs(args[0].slice(1, -1))) {
          const m = /^(['"])(\w+)\1\s*=>\s*([\s\S]+)$/.exec(pair);
          if (!m) {
            attrCalls.push({ name: "domain", args: [] }); // unreadable attribute: mark dynamic
            continue;
          }
          const key = m[2] === "as" ? "name" : m[2];
          attrCalls.push({ name: key, args: [m[3]] });
        }
      }
      const groupCtx = apply(ctx, [...calls, ...attrCalls]);
      const body = args[args.length - 1] || "";
      const rel = code.slice(groupAt + 1, close).lastIndexOf(body);
      const brace = body.indexOf("{");
      if (brace === -1 || !/^\s*(static\s+)?(function|fn)\b/.test(body)) {
        include(includePath(body, file), groupCtx, line);
      } else {
        const bodyStart = groupAt + 1 + rel + brace;
        const bodyEnd = matching(code, bodyStart);
        walk(bodyStart + 1, bodyEnd, groupCtx);
      }
      return j + 1;
    }
    if (!calls.length) {
      unknown.push(`${file}:${line}: unreadable Route statement`);
      return j + 1;
    }
    const first = calls[0];
    if (VERBS[first.name] || RESOURCE.has(first.name) || OTHER_DEFS.has(first.name)) routeDef(ctx, calls, i);
    else if (!["pattern", "patterns", "bind", "model", "macro", "aliasMiddleware", "middlewareGroup"].includes(first.name)) {
      // A chain without group() and without a verb, e.g. Route::middleware(...)->get(...)
      const verbAt = calls.findIndex((c) => VERBS[c.name] || RESOURCE.has(c.name) || OTHER_DEFS.has(c.name));
      if (verbAt > 0) routeDef(apply(ctx, calls.slice(0, verbAt)), calls.slice(verbAt), i);
      else unknown.push(`${file}:${line}: Route::${first.name}() not understood`);
    }
    return j + 1;
  }

  walk(0, code.length, opts.ctx || EMPTY_CTX);
  return { routes, unknown, statements };
}

// routes/**, plus module route files: nwidart-style Modules/*/routes and app/Modules/*/routes.
const MODULE_ROUTES = /^(?:app\/)?Modules\/[^/]+\/(?:routes|Routes)\/.+\.php$/;
function isRouteFile(path) {
  return /^routes\/.+\.php$/.test(path) || MODULE_ROUTES.test(path);
}

// All routes at a commit. Files that another route file includes are parsed through that
// include, so they inherit its group middleware; only the rest are parsed as roots.
// Module route files are registered by a service provider, whose prefix and middleware
// aren't visible here: their routes are marked provider_loaded.
function routesAt(cwd, commit, files) {
  const cache = new Map();
  const resolve = (f) => {
    if (!cache.has(f)) cache.set(f, show(cwd, commit, f));
    return cache.get(f);
  };
  const included = new Set();
  // Pass 1: which files are reached through an include from another file?
  for (const f of files) {
    const src = resolve(f);
    if (src === null) continue;
    for (const m of stripComments(src).matchAll(/\b(?:require|require_once|include|include_once)\b\s*([^;]+);|->\s*group\s*\(\s*((?:base_path|__DIR__)[^;]*?)\)\s*;/g)) {
      const target = includePath(m[1] || m[2], f);
      if (target && target !== f) included.add(target);
    }
  }
  const all = new Map();
  const unknown = [];
  let statements = 0;
  for (const f of files) {
    if (included.has(f)) continue;
    const src = resolve(f);
    if (src === null) continue;
    const provider = MODULE_ROUTES.test(f);
    const r = parseRoutes(src, f, { resolve });
    for (const [k, v] of r.routes) all.set(k, provider ? { ...v, provider_loaded: true } : v);
    unknown.push(...r.unknown);
    statements += r.statements;
  }
  return { routes: all, unknown, statements };
}

function sameAttrs(a, b) {
  return a.action === b.action && a.middleware.join(",") === b.middleware.join(",") && !!a.conditional === !!b.conditional;
}

// Middleware aliases ('auth' => Authenticate::class), from bootstrap/app.php
// (->alias([...]) / ->alias(name, Class)) and app/Http/Kernel.php ($middlewareAliases,
// $routeMiddleware). Remapping an alias changes every route that uses it, without any
// route file changing. Map(alias -> target), or null if no source file exists.
const ALIAS_FILES = ["bootstrap/app.php", "app/Http/Kernel.php"];
function aliasesAt(cwd, commit) {
  const out = new Map();
  let seen = false;
  for (const f of ALIAS_FILES) {
    const src = show(cwd, commit, f);
    if (src === null) continue;
    seen = true;
    const code = stripComments(src);
    const blocks = [];
    for (const m of code.matchAll(/->\s*alias\s*\(\s*\[|\$(?:middlewareAliases|routeMiddleware)\s*=\s*\[/g)) {
      const open = m.index + m[0].length - 1;
      const close = matching(code, open);
      if (close !== -1) blocks.push(code.slice(open + 1, close));
    }
    for (const b of blocks) {
      for (const pair of splitArgs(b)) {
        const kv = /^(['"])([^'"]+)\1\s*=>\s*([\s\S]+)$/.exec(pair.trim());
        if (kv) out.set(kv[2], classRef(kv[3]) || literal(kv[3]) || kv[3].trim().slice(0, 80));
      }
    }
    for (const m of code.matchAll(/->\s*alias\s*\(\s*(['"])([^'"]+)\1\s*,\s*([^)]+)\)/g)) out.set(m[2], classRef(m[3]) || m[3].trim().slice(0, 80));
  }
  return seen ? out : null;
}

// Route registration outside routes/: service providers calling Route:: or loading route
// files. Those routes aren't parsed; say so, with where, rather than miss them silently.
const REGISTERS = /\bRoute::(?:get|post|put|patch|delete|options|any|match|resource|apiResource|group|middleware|prefix|view|redirect|domain)\s*\(|->\s*loadRoutesFrom\s*\(|\bloadRoutesFrom\s*\(|->\s*routes\s*\(\s*(?:function|fn|static)/;
function outsideRegistrations(cwd, base, head, changed) {
  const files = changed.filter((f) => f.status !== "D" && /\.php$/.test(f.path) && !isRouteFile(f.path) && /(?:^app\/|^src\/|^Modules\/|^packages\/)/.test(f.path) && !/^tests?\//.test(f.path)).map((f) => f.path);
  if (!files.length) return [];
  const out = [];
  for (const [file, d] of require("../git").diffLines(cwd, base, head, files)) {
    for (const l of d.added) if (REGISTERS.test(stripComments(l.text))) out.push(`${file}:${l.n}: registers routes outside routes/; those routes aren't parsed`);
  }
  return out;
}

// Route changes between base and head.
function extractRoutes(ctx) {
  const { cwd, base, head, changed } = ctx;
  const touched = changed.filter((f) => isRouteFile(f.path) || (f.from && isRouteFile(f.from)));
  const aliasTouched = changed.some((f) => ALIAS_FILES.includes(f.path));
  const aliasObserved = [];
  if (aliasTouched) {
    const before = aliasesAt(cwd, base) || new Map();
    const after = aliasesAt(cwd, head) || new Map();
    for (const [k, v] of after) {
      const old = before.get(k);
      if (old === undefined) aliasObserved.push({ op: "middleware_alias_added", key: k, detail: `→ ${v}` });
      else if (old !== v) aliasObserved.push({ op: "middleware_alias_changed", key: k, detail: `${old} → ${v}: every route using '${k}' now runs this instead`, risk: "middleware_alias_changed" });
    }
    for (const [k, v] of before) if (!after.has(k)) aliasObserved.push({ op: "middleware_alias_removed", key: k, detail: `was ${v}`, risk: "middleware_alias_changed" });
  }
  const outside = outsideRegistrations(cwd, base, head, changed);
  if (!touched.length) {
    if (aliasObserved.length || outside.length) return result("routes", { observed: aliasObserved, unknown: outside, inspected: 0, note: "no route files changed" });
    return result("routes", { state: STATES.PASS, note: "no route files changed (provider- or package-registered routes are outside coverage)" });
  }
  // Parse every route file on both sides: a group change in one file can't move routes
  // in another, but parsing all keeps keys comparable when files are renamed.
  const list = (commit) => require("../git").git(cwd, ["ls-tree", "-r", "--name-only", commit, "--", "routes", "Modules", "app/Modules"]).split("\n").filter(isRouteFile);
  const before = routesAt(cwd, base, list(base));
  const after = routesAt(cwd, head, list(head));
  const observed = [];
  for (const [k, v] of after.routes) {
    const old = before.routes.get(k);
    // A provider-loaded route may get auth middleware from its service provider, which
    // isn't visible here; it is reported, but not flagged as unauthenticated.
    const unauth = !v.provider_loaded && !v.middleware.some((m) => AUTH_MW.test(m));
    if (!old) observed.push({ op: "route_added", key: k, detail: `${v.action} [${v.middleware.join(", ")}]${v.conditional ? " (conditional)" : ""}${v.provider_loaded ? " (module provider: its group middleware isn't visible)" : ""}`, risk: unauth ? "unauthenticated_route" : undefined });
    else if (!sameAttrs(old, v)) {
      const lost = old.middleware.filter((m) => !v.middleware.includes(m));
      const gained = v.middleware.filter((m) => !old.middleware.includes(m));
      const securityLost = lost.filter((m) => SECURITY_MW.test(m));
      observed.push({
        op: "route_changed",
        key: k,
        detail: [old.action !== v.action ? `action ${old.action} → ${v.action}` : null, lost.length ? `middleware removed: ${lost.join(", ")}` : null, gained.length ? `middleware added: ${gained.join(", ")}` : null].filter(Boolean).join("; ") || "conditional status changed",
        risk: securityLost.length ? "security_middleware_removed" : lost.length || gained.length ? "middleware_changed" : undefined,
      });
    }
  }
  for (const k of before.routes.keys()) if (!after.routes.has(k)) observed.push({ op: "route_removed", key: k });
  // UNKNOWNs that are new in head: an unreadable route on both sides is not this PR's doing.
  const baseUnknown = new Set(before.unknown.map((u) => u.replace(/:\d+:/, ":")));
  const unknown = after.unknown.filter((u) => !baseUnknown.has(u.replace(/:\d+:/, ":")));
  return result("routes", { observed: [...aliasObserved, ...observed], unknown: [...unknown, ...outside], inspected: after.statements, note: `${after.routes.size} routes parsed at head` });
}

module.exports = { extractRoutes, parseRoutes, routesAt, includePath, joinUri, isRouteFile, aliasesFor: aliasesAt };
