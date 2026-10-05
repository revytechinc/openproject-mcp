/**
 * Host-local OpenProject Status admin via `bin/rails runner`.
 *
 * Use when the MCP process can read OPENPROJECT_ENVFILE and run as the
 * openproject user (typical on the track jail). Prefer this over the HTML
 * session when 2FA blocks web login — API v3 Statuses remain GET-only.
 *
 * Never logs secrets. Payloads are base64-encoded into single-quoted Ruby
 * literals (no double-quote interpolation).
 */

import { accessSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";

const DEFAULT_WWW = "/usr/local/www/openproject";
const DEFAULT_ENVFILE = "/usr/local/etc/cloudbsd/openproject/openproject.env";

function trimSlash(p) {
  let s = String(p || "");
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

function shellSingleQuote(s) {
  return "'" + String(s).replaceAll("'", String.raw`'\''`) + "'";
}

export function resolveRailsPaths(env = process.env) {
  return {
    wwwDir: trimSlash(env.OPENPROJECT_WWWDIR || DEFAULT_WWW),
    envFile: env.OPENPROJECT_ENVFILE || DEFAULT_ENVFILE,
  };
}

export function railsAdminAvailable(env = process.env) {
  const { wwwDir, envFile } = resolveRailsPaths(env);
  try {
    accessSync(envFile, constants.R_OK);
    accessSync(wwwDir + "/bin/rails", constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} rubySource
 * @param {{ wwwDir?: string, envFile?: string, spawnImpl?: Function, timeoutMs?: number }} options
 * @returns {Promise<{ stdout: string, stderr: string, code: number }>}
 */
export function runRailsRunner(rubySource, options = {}) {
  const wwwDir = options.wwwDir || resolveRailsPaths().wwwDir;
  const envFile = options.envFile || resolveRailsPaths().envFile;
  const spawnImpl = options.spawnImpl || spawn;
  const timeoutMs = options.timeoutMs || 120000;

  const script =
    "set -e\n" +
    "set -a\n" +
    ". " +
    shellSingleQuote(envFile) +
    "\n" +
    "set +a\n" +
    "cd " +
    shellSingleQuote(wwwDir) +
    "\n" +
    'exec bin/rails runner "$1"\n';

  return new Promise((resolve, reject) => {
    const child = spawnImpl("/bin/sh", ["-s", "--", rubySource], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      const err = new Error("rails runner timed out after " + timeoutMs + "ms");
      err.code = "RAILS_TIMEOUT";
      reject(err);
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code == null ? 1 : code });
    });

    child.stdin.write(script);
    child.stdin.end();
  });
}

function parseJsonLine(stdout) {
  const lines = String(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const marked = line.startsWith("OPSTATUS:")
      ? line.slice("OPSTATUS:".length)
      : null;
    const candidate = marked || (line.startsWith("{") ? line : null);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

function rubyWithPayload(payload, body) {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  // Single-quoted Ruby string: no #{interpolation}. Base64 alphabet is safe.
  return (
    "require 'json'; require 'base64'\n" +
    "attrs = JSON.parse(Base64.strict_decode64('" +
    b64 +
    "'))\n" +
    "def emit(h); puts('OPSTATUS:' + h.to_json); end\n" +
    body
  );
}

async function runAndParse(ruby, options, failCode) {
  const result = await runRailsRunner(ruby, options);
  if (result.code !== 0) {
    const err = new Error(
      "rails status admin failed (exit " +
        result.code +
        "): " +
        (result.stderr || result.stdout).slice(0, 500)
    );
    err.code = failCode;
    err.stderr = result.stderr;
    throw err;
  }
  const parsed = parseJsonLine(result.stdout);
  if (!parsed) {
    const err = new Error("rails status admin returned no JSON");
    err.code = "RAILS_PARSE_FAILED";
    err.stdout = result.stdout;
    throw err;
  }
  return parsed;
}

/**
 * Create or return existing status by name.
 */
export async function createStatusViaRails(attrs, options = {}) {
  const name = String(attrs.name || "").trim();
  if (!name) {
    const err = new Error("status name is required");
    err.code = "VALIDATION";
    throw err;
  }

  const payload = {
    name,
    is_closed: !!attrs.isClosed,
    is_default: !!attrs.isDefault,
    color: attrs.color || null,
    default_done_ratio:
      attrs.defaultDoneRatio === undefined || attrs.defaultDoneRatio === null
        ? null
        : Number(attrs.defaultDoneRatio),
    force: !!attrs.force,
  };

  const ruby = rubyWithPayload(
    payload,
    "existing = Status.find_by(name: attrs['name'])\n" +
      "if existing && !attrs['force']\n" +
      "  emit({id: existing.id, name: existing.name, isClosed: existing.is_closed, isDefault: existing.is_default, created: false, idempotent: true, backend: 'rails'})\n" +
      "  exit 0\n" +
      "end\n" +
      "color = nil\n" +
      "if attrs['color'].is_a?(String) && !attrs['color'].empty?\n" +
      "  color = Color.find_or_create_by!(hexcode: attrs['color'])\n" +
      "else\n" +
      "  ref = Status.find_by(name: 'Developed') || Status.first\n" +
      "  color = ref&.color\n" +
      "end\n" +
      "pos = (Status.maximum(:position) || 0) + 1\n" +
      "s = Status.create!(name: attrs['name'], is_closed: !!attrs['is_closed'], is_default: !!attrs['is_default'], is_readonly: false, color: color, position: pos, default_done_ratio: attrs['default_done_ratio'])\n" +
      "emit({id: s.id, name: s.name, isClosed: s.is_closed, isDefault: s.is_default, created: true, idempotent: false, backend: 'rails'})\n"
  );

  return runAndParse(ruby, options, "RAILS_CREATE_FAILED");
}

/**
 * Update status by id.
 */
export async function updateStatusViaRails(id, attrs, options = {}) {
  const statusId = Number(id);
  if (!Number.isFinite(statusId) || statusId <= 0) {
    const err = new Error("status id must be a positive number");
    err.code = "VALIDATION";
    throw err;
  }

  const payload = {
    id: statusId,
    name: attrs.name === undefined ? null : String(attrs.name),
    is_closed: attrs.isClosed === undefined ? null : !!attrs.isClosed,
    is_default: attrs.isDefault === undefined ? null : !!attrs.isDefault,
    color: attrs.color === undefined ? null : attrs.color,
    default_done_ratio:
      attrs.defaultDoneRatio === undefined ? null : attrs.defaultDoneRatio,
  };

  const ruby = rubyWithPayload(
    payload,
    "s = Status.find(attrs['id'])\n" +
      "prev = s.name\n" +
      "changed = false\n" +
      "if !attrs['name'].nil? && attrs['name'] != s.name\n" +
      "  s.name = attrs['name']; changed = true\n" +
      "end\n" +
      "unless attrs['is_closed'].nil?\n" +
      "  s.is_closed = attrs['is_closed']; changed = true\n" +
      "end\n" +
      "unless attrs['is_default'].nil?\n" +
      "  s.is_default = attrs['is_default']; changed = true\n" +
      "end\n" +
      "if attrs['color'].is_a?(String) && !attrs['color'].empty?\n" +
      "  s.color = Color.find_or_create_by!(hexcode: attrs['color']); changed = true\n" +
      "end\n" +
      "unless attrs['default_done_ratio'].nil?\n" +
      "  s.default_done_ratio = attrs['default_done_ratio']; changed = true\n" +
      "end\n" +
      "s.save! if changed\n" +
      "emit({id: s.id, name: s.name, isClosed: s.is_closed, isDefault: s.is_default, updated: changed, previousName: prev, backend: 'rails'})\n"
  );

  return runAndParse(ruby, options, "RAILS_UPDATE_FAILED");
}
