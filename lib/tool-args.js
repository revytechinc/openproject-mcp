/**
 * Shared helpers for the named tools: argument checking (unknown names are
 * refused, null means absent), path-safe ids, OpenProject error messages and
 * compact link rendering.
 */
import { seg, trimTrailingSlashes } from "./path.js";

function argumentError(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function editDistance(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = [i];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[cols - 1];
}

/** The closest accepted name, or null when nothing is close. */
export function didYouMean(name, accepted) {
  const lower = String(name).toLowerCase();
  let best = null;
  let bestScore = Infinity;
  for (const candidate of accepted) {
    const cand = candidate.toLowerCase();
    if (cand === lower) return candidate;
    const score = editDistance(lower, cand);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  const limit = Math.max(1, Math.min(3, Math.floor(lower.length / 3)));
  return bestScore <= limit ? best : null;
}

/**
 * Validate args against a tool definition. Returns a copy with null-valued
 * keys removed. Unknown names are refused, listing the accepted names and a
 * "did you mean" for close matches.
 */
export function checkArgs(tool, args, name = tool.name) {
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw argumentError(name + ": arguments must be an object");
  }
  const accepted = Object.keys((tool.inputSchema && tool.inputSchema.properties) || {});
  const unknown = Object.keys(args).filter((key) => !accepted.includes(key));
  if (unknown.length) {
    const parts = unknown.map((key) => {
      const hint = didYouMean(key, accepted);
      return '"' + key + '"' + (hint ? ' (did you mean "' + hint + '"?)' : "");
    });
    throw argumentError(
      name +
        ": Unknown argument" +
        (unknown.length > 1 ? "s " : " ") +
        parts.join(", ") +
        ". Accepted: " +
        accepted.join(", ")
    );
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== null && value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export function requireArg(args, key, label) {
  if (args[key] === undefined || args[key] === "") {
    throw argumentError((label ? label + ": " : "") + key + " is required");
  }
  return args[key];
}

/**
 * A positive integer id (accepts 1677, "1677" and "#1677"). Validation is
 * seg()'s (code INVALID_ID); only the message names the argument.
 */
export function parseId(value, label = "id") {
  const text = typeof value === "string" ? value.trim().replace(/^#/, "") : value;
  try {
    seg(text, "id");
  } catch (error) {
    error.message = label + " must be a positive integer, got " + JSON.stringify(value === undefined ? null : value);
    throw error;
  }
  return Number(text);
}

/**
 * A project id or identifier, validated and encoded for a path segment by
 * seg(value, "project"). Identifiers are lowercase, like OpenProject's.
 */
export function projectSegment(value, label = "project") {
  const text = typeof value === "string" ? value.trim() : value;
  try {
    return seg(text, "project");
  } catch (error) {
    error.message =
      label + " must be a project id or a lowercase identifier, got " + JSON.stringify(value === undefined ? null : value);
    throw error;
  }
}

/** The numeric id at the end of an href, or null when it does not end in one. */
export function idFromHref(href) {
  if (!href) return null;
  const last = trimTrailingSlashes(String(href).split("?")[0]).split("/").pop();
  return /^\d+$/.test(last) ? Number(last) : null;
}

/** {id, name} for a HAL link, or null when the link is empty. */
export function linkRef(link) {
  if (!link || !link.href) return null;
  return { id: idFromHref(link.href), name: link.title != null ? link.title : null };
}

export function linkList(links) {
  return Array.isArray(links) ? links.map(linkRef).filter(Boolean) : [];
}

/** Web URL of a work package, built from the API root. */
export function webUrl(baseUrl, id) {
  let root = String(baseUrl || "");
  while (root.endsWith("/")) root = root.slice(0, -1);
  root = root.replace(/\/api\/v3$/, "");
  return root + "/work_packages/" + seg(id, "id");
}

export function withNotify(path, notify) {
  if (notify === false) return path + (path.includes("?") ? "&" : "?") + "notify=false";
  return path;
}

function parseBody(error) {
  const raw = error && error.body;
  if (raw && typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** The OpenProject error message (all of them for MultipleErrors). */
export function opMessage(error) {
  const body = parseBody(error);
  if (body) {
    const nested = body._embedded && Array.isArray(body._embedded.errors) ? body._embedded.errors : null;
    if (nested && nested.length) {
      return nested.map((item) => item.message).filter(Boolean).join(" ");
    }
    if (body.message) return body.message;
  }
  return (error && error.message) || String(error);
}

/** The attributes an OpenProject error refers to. */
export function opAttributes(error) {
  const body = parseBody(error);
  if (!body) return [];
  const list = body._embedded && Array.isArray(body._embedded.errors) ? body._embedded.errors : [body];
  return list
    .map((item) => item && item._embedded && item._embedded.details && item._embedded.details.attribute)
    .filter(Boolean);
}

export function toolError(message, extra) {
  const error = new Error(message);
  if (extra) Object.assign(error, extra);
  return error;
}

/** Fields lib/api.js puts on an OpenProject HTTP error. */
const OP_ERROR_FIELDS = ["code", "status", "errorIdentifier", "attribute", "opMessage", "errors", "body", "document"];

/**
 * A new error with a better message that keeps everything OpenProject said
 * (code, status, errorIdentifier, attribute, opMessage, errors); extra
 * fields win.
 */
export function wrapOpError(error, message, extra) {
  const out = new Error(message);
  for (const key of OP_ERROR_FIELDS) {
    if (error && error[key] !== undefined && error[key] !== null) out[key] = error[key];
  }
  if (extra) Object.assign(out, extra);
  if (error instanceof Error) out.cause = error;
  return out;
}

export function filtersParam(filters) {
  return JSON.stringify(filters);
}

/** ISO 8601 duration: numbers (or numeric strings) are hours. */
export function duration(value) {
  const text = String(value).trim();
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(text)) return "PT" + Number(text) + "H";
  return text;
}
