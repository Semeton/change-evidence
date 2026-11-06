"use strict";

// Staying current without giving up the pin.
//
// The CI workflow pins an exact evaluator version on purpose: a floating `@latest` would let
// whoever publishes the next version change your trust root without a review. So upgrades
// are a reviewed change: `upgrade` moves the pin (and refreshes the workflow when it is
// still the stock template), and you commit that like any other change to the rules.
//
// Locally, a notice says when a newer version exists. The check runs at most once a day,
// in a detached background process, so it never slows a command; it never runs in CI,
// never installs anything, and is off with CHANGE_EVIDENCE_NO_UPDATE_CHECK=1 or
// NO_UPDATE_NOTIFIER=1.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { cmp } = require("./extractors/dependencies");

const NAME = "@semeton/change-evidence";
const REGISTRY = process.env.CHANGE_EVIDENCE_REGISTRY || "https://registry.npmjs.org";
const DAY = 24 * 60 * 60 * 1000;
const PIN = /(CHANGE_EVIDENCE:\s*["']?@semeton\/change-evidence@)([^"'\s]+)/;
const TEMPLATE = path.join(__dirname, "..", "templates", "change-evidence.yml");

function cacheFile() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "change-evidence", "update-check.json");
}

// Registry metadata for a version (or "latest"): { version, integrity }, or null.
// Resolves within `timeout` ms either way.
function registryInfo(spec = "latest", { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      if (!/^(latest|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.test(spec)) return finish(null);
      const url = `${REGISTRY.replace(/\/$/, "")}/${NAME.replace("/", "%2f")}/${spec}`;
      const lib = url.startsWith("http://") ? require("http") : require("https");
      const req = lib.get(url, { headers: { accept: "application/json" }, timeout }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = res.statusCode === 200 ? JSON.parse(body) : null;
            finish(j && j.version ? { version: j.version, integrity: (j.dist && j.dist.integrity) || null } : null);
          } catch {
            finish(null);
          }
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => finish(null));
      setTimeout(() => finish(null), timeout + 200).unref();
    } catch {
      finish(null);
    }
  });
}

async function latestVersion(opts) {
  const info = await registryInfo("latest", opts);
  return info ? info.version : null;
}

function checksDisabled(env = process.env) {
  return !!(env.CI || env.GITHUB_ACTIONS || env.CHANGE_EVIDENCE_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.NODE_ENV === "test");
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(), "utf8"));
  } catch {
    return null;
  }
}

// Called by the CLI. Prints a notice from the cached result and, if the cache is stale,
// refreshes it in a detached process for next time.
function notify(current, { stream = process.stderr, env = process.env, now = Date.now() } = {}) {
  if (checksDisabled(env) || !stream.isTTY) return null;
  const cache = readCache();
  if (!cache || now - (cache.checkedAt || 0) > DAY) {
    try {
      const child = spawn(process.execPath, [__filename, "--refresh-cache"], { detached: true, stdio: "ignore", env: { ...env, CHANGE_EVIDENCE_NO_UPDATE_CHECK: "" } });
      child.unref();
    } catch {
      // best effort
    }
  }
  if (cache && cache.latest && cmp(cache.latest, current) > 0) {
    const msg = `\nchange-evidence ${cache.latest} is available (you have ${current}).\nTo move your workflow's pinned version: npx ${NAME}@latest upgrade\n`;
    stream.write(msg);
    return msg;
  }
  return null;
}

async function refreshCache() {
  const latest = await latestVersion();
  if (!latest) return;
  const file = cacheFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ checkedAt: Date.now(), latest }));
}

// Find the workflow that pins this tool.
function findWorkflow(cwd, explicit) {
  if (explicit) return path.resolve(cwd, explicit);
  const dir = path.join(cwd, ".github", "workflows");
  const preferred = path.join(dir, "change-evidence.yml");
  if (fs.existsSync(preferred)) return preferred;
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const p = path.join(dir, f);
    if (PIN.test(fs.readFileSync(p, "utf8"))) return p;
  }
  return null;
}

const INTEGRITY = /(CHANGE_EVIDENCE_INTEGRITY:\s*["']?)(sha512-[A-Za-z0-9+/=]+|sha512-PLACEHOLDER)(["']?)/;
const SHA512 = /^sha512-[A-Za-z0-9+/]{86}==$/;
const withPin = (text, version) => text.replace(PIN, `$1${version}`);
const withIntegrity = (text, integrity) => text.replace(INTEGRITY, `$1${integrity}$3`);
const crypto = require("crypto");
const HISTORY = path.join(__dirname, "..", "templates", "history.json");
const TRIGGER = path.join(__dirname, "..", "templates", "change-evidence-trigger.yml");
const TRIGGER_NAME = "change-evidence-trigger.yml";

// Hash of a workflow with its pin and integrity blanked and line endings normalised:
// equal for every copy of the same template, whatever version it pins.
function templateHash(text) {
  const t = withIntegrity(withPin(String(text).replace(/\r\n/g, "\n"), "X"), "sha512-X");
  return crypto.createHash("sha256").update(t).digest("hex");
}

// Every template this package has shipped: [{ since, kind, sha256 }], oldest first.
function history() {
  return JSON.parse(fs.readFileSync(HISTORY, "utf8")).templates;
}
function knownTemplates(kind) {
  return history().filter((t) => !kind || (t.kind || "workflow") === kind).map((t) => t.sha256);
}

// The workflow and trigger files `init` writes, pinned to `version`/`integrity`.
function renderTemplates(version, integrity) {
  if (!SHA512.test(String(integrity))) throw new Error(`not a sha512 integrity: ${integrity}`);
  // LF always: a checkout on Windows may have converted the shipped files to CRLF.
  const lf = (f) => fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n");
  return {
    workflow: withIntegrity(withPin(lf(TEMPLATE), version), integrity),
    trigger: lf(TRIGGER),
  };
}

// Move the pin to `target` (with its `integrity`). If the workflow is an unmodified copy
// of any template this package has shipped, and this CLI *is* the target version, the
// file is replaced with the current template, so new Action SHAs and steps arrive too,
// and a missing trigger workflow is added. A customised workflow only gets its pin and
// integrity moved, with warnings for what it is missing.
function upgradeWorkflow(file, { target, integrity, current, check = false }) {
  const text = fs.readFileSync(file, "utf8");
  const m = PIN.exec(text);
  if (!m) return { status: "no-pin", file };
  const pinned = m[2];
  if (cmp(target, pinned) < 0) return { status: "newer-pinned", file, pinned, target };
  if (!SHA512.test(String(integrity))) return { status: "no-integrity", file, pinned, target };
  const stock = knownTemplates("workflow").includes(templateHash(text));
  const canRefresh = stock && current === target;
  const triggerFile = path.join(path.dirname(file), TRIGGER_NAME);
  const fresh = canRefresh ? renderTemplates(target, integrity) : null;
  const next = fresh ? fresh.workflow : withIntegrity(withPin(text, target), integrity);
  const warnings = [];
  if (!fresh) {
    if (!INTEGRITY.test(text)) warnings.push("the workflow doesn't verify the evaluator's integrity; compare it with `init`");
    if (/^\s*pull_request_target\s*:/m.test(text)) warnings.push("the workflow runs on pull_request_target, which GitHub blocks by default in public repositories from December 2, 2026; compare it with `init`");
  }
  const addTrigger = !!fresh && !fs.existsSync(triggerFile);
  const triggerStock = fs.existsSync(triggerFile) && knownTemplates("trigger").includes(templateHash(fs.readFileSync(triggerFile, "utf8")));
  const refreshTrigger = !!fresh && triggerStock && fs.readFileSync(triggerFile, "utf8") !== fresh.trigger;
  if (next === text && !addTrigger && !refreshTrigger) return { status: "current", file, pinned, warnings };
  if (check) return { status: "outdated", file, pinned, target, warnings };
  fs.writeFileSync(file, next);
  if (addTrigger || refreshTrigger) fs.writeFileSync(triggerFile, fresh.trigger);
  const migrated = /^\s*pull_request_target\s*:/m.test(text) && !!fresh;
  return { status: "upgraded", file, pinned, target, refreshed: !!fresh && next !== withIntegrity(withPin(text, target), integrity), customised: !stock, trigger: addTrigger ? "added" : refreshTrigger ? "refreshed" : null, triggerFile, migrated, warnings };
}

module.exports = { latestVersion, registryInfo, notify, refreshCache, findWorkflow, upgradeWorkflow, renderTemplates, templateHash, knownTemplates, history, checksDisabled, cacheFile, PIN, INTEGRITY, SHA512, NAME, TRIGGER_NAME };

if (require.main === module && process.argv[2] === "--refresh-cache") {
  refreshCache().catch(() => {});
}
