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

// Latest published version, or null. Resolves within `timeout` ms either way.
function latestVersion({ timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    try {
      const url = `${REGISTRY.replace(/\/$/, "")}/${NAME.replace("/", "%2f")}/latest`;
      const lib = url.startsWith("http://") ? require("http") : require("https");
      const req = lib.get(url, { headers: { accept: "application/json" }, timeout }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            finish(res.statusCode === 200 ? JSON.parse(body).version || null : null);
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

const withPin = (text, version) => text.replace(PIN, `$1${version}`);
const crypto = require("crypto");
const HISTORY = path.join(__dirname, "..", "templates", "history.json");

// Hash of a workflow with its pin blanked and line endings normalised: equal for every
// copy of the same template, whatever version it pins.
function templateHash(text) {
  return crypto.createHash("sha256").update(withPin(text.replace(/\r\n/g, "\n"), "X")).digest("hex");
}

// Hashes of every template this package has shipped, oldest first.
function knownTemplates() {
  return JSON.parse(fs.readFileSync(HISTORY, "utf8")).templates.map((t) => t.sha256);
}

// Move the pin to `target`. If the workflow is an unmodified copy of any template this
// package has shipped, and this CLI *is* the target version, the whole file is replaced
// with the current template, so new Action SHAs and steps arrive too. A customised
// workflow only gets its pin moved.
function upgradeWorkflow(file, { target, current, check = false }) {
  const text = fs.readFileSync(file, "utf8");
  const m = PIN.exec(text);
  if (!m) return { status: "no-pin", file };
  const pinned = m[2];
  if (cmp(target, pinned) < 0) return { status: "newer-pinned", file, pinned, target };
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const stock = knownTemplates().includes(templateHash(text));
  const canRefresh = stock && current === target;
  const next = canRefresh ? withPin(template, target) : withPin(text, target);
  if (next === text) return { status: "current", file, pinned };
  if (check) return { status: "outdated", file, pinned, target };
  fs.writeFileSync(file, next);
  return { status: "upgraded", file, pinned, target, refreshed: canRefresh && next !== withPin(text, target), customised: !stock };
}

module.exports = { latestVersion, notify, refreshCache, findWorkflow, upgradeWorkflow, templateHash, knownTemplates, checksDisabled, cacheFile, PIN, NAME };

if (require.main === module && process.argv[2] === "--refresh-cache") {
  refreshCache().catch(() => {});
}
