/**
 * OpenProject API v3 client used by both upstream tools and CloudBSD write tools.
 *
 * Auth: Basic apikey:<token>. Token may be a static string or resolved per-call
 * via getApiKey() (caller-token / AsyncLocalStorage). Fail closed if empty.
 *
 * Every request goes to the configured root's origin. An absolute URL is
 * accepted only when its origin equals the root's (OpenProject's own
 * _links hrefs); anything else is refused before a request is made, so the
 * caller's token never leaves for another host. Redirects are never
 * followed (redirect: "error"); a 3xx is refused with code REDIRECT_REFUSED.
 * Every request is bounded by OPENPROJECT_TIMEOUT_MS (default 30 s).
 */
import { seg } from "./path.js";
import { requestTimeoutMs } from "./config.js";
import { isRedirectFailure, isRedirectResponse } from "./errors.js";

const MESSAGE_LIMIT = 800;
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i;

function codedError(message, code, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * Pull the useful fields out of an OpenProject error document.
 * @param {string} text raw response body
 */
export function parseOpenProjectError(text) {
  let doc = null;
  try {
    doc = text ? JSON.parse(text) : null;
  } catch {
    doc = null;
  }
  if (!doc || typeof doc !== "object") return {};
  const out = { document: doc };
  if (typeof doc.errorIdentifier === "string") out.errorIdentifier = doc.errorIdentifier;
  if (typeof doc.message === "string") out.opMessage = doc.message;
  const embedded = doc._embedded || {};
  if (embedded.details && embedded.details.attribute != null) {
    out.attribute = embedded.details.attribute;
  }
  if (Array.isArray(embedded.errors)) {
    out.errors = embedded.errors
      .map((e) => (e && typeof e.message === "string" ? e.message : null))
      .filter(Boolean);
    const attributes = embedded.errors
      .map((e) => e && e._embedded && e._embedded.details && e._embedded.details.attribute)
      .filter((a) => a != null);
    if (attributes.length && out.attribute == null) out.attribute = attributes;
  }
  return out;
}

function hasBody(method, body) {
  return body !== undefined && body !== null && method !== "GET" && method !== "HEAD";
}

/** Fetch and read the body; timeouts and redirects become coded errors. */
async function fetchText(fetchFn, init, call) {
  let response;
  try {
    response = await fetchFn(call.url, init);
  } catch (error) {
    throw fetchFailure(error, call);
  }
  if (isRedirectResponse(response)) {
    throw codedError(
      "OpenProject answered " + call.where + " with a redirect (" + response.status + "); redirects are refused",
      "REDIRECT_REFUSED",
      { status: response.status }
    );
  }
  try {
    const text = response.status === 204 ? "" : await response.text();
    return { response, text };
  } catch (error) {
    throw fetchFailure(error, call);
  }
}

function fetchFailure(error, call) {
  if (call.signal.aborted) {
    return codedError("OpenProject did not answer within " + call.limit + " ms (" + call.where + ")", "TIMEOUT");
  }
  if (isRedirectFailure(error)) {
    return codedError("OpenProject answered " + call.where + " with a redirect; redirects are refused", "REDIRECT_REFUSED");
  }
  return error;
}

/** The HTTP_ERROR for a non-2xx answer, carrying what OpenProject said. */
function httpError(response, text) {
  const parsed = parseOpenProjectError(text);
  const detail = parsed.opMessage || text || "";
  const extra = parsed.errors && parsed.errors.length ? " " + parsed.errors.join(" ") : "";
  const tail = detail || extra ? " " + detail + extra : "";
  let message = "API Error: " + response.status + " " + (response.statusText || "") + tail;
  if (message.length > MESSAGE_LIMIT) message = message.slice(0, MESSAGE_LIMIT) + "...";
  return codedError(message.trimEnd(), "HTTP_ERROR", {
    status: response.status,
    body: text,
    errorIdentifier: parsed.errorIdentifier,
    opMessage: parsed.opMessage,
    attribute: parsed.attribute,
    errors: parsed.errors,
    document: parsed.document,
  });
}

function parseBody(response, text) {
  if (response.status === 204) return null;
  if (!text) return { status: response.status, empty: true };
  try {
    return JSON.parse(text);
  } catch {
    return { status: response.status, raw: text };
  }
}

export function createApi({
  baseUrl,
  apiKey,
  getApiKey,
  fetchImpl,
  timeoutMs,
} = {}) {
  let root = String(baseUrl || "");
  while (root.endsWith("/")) root = root.slice(0, -1);
  const fetchFn = fetchImpl || globalThis.fetch;
  let rootOrigin = null;
  try {
    rootOrigin = root ? new URL(root).origin : null;
  } catch {
    rootOrigin = null;
  }

  function resolveKey() {
    if (typeof getApiKey === "function") {
      const v = getApiKey();
      if (v) return String(v);
    }
    if (apiKey) return String(apiKey);
    return "";
  }

  /** Resolve endpoint against the root; throw FOREIGN_ORIGIN for any other origin. */
  function resolveUrl(endpoint) {
    if (!rootOrigin) {
      throw codedError("OpenProject base URL is not configured (OPENPROJECT_URL)", "CONFIG");
    }
    const text = String(endpoint == null ? "" : endpoint);
    let url;
    if (ABSOLUTE_URL.test(text) || text.startsWith("//") || text.startsWith("\\\\")) {
      try {
        url = new URL(text, root + "/");
      } catch {
        throw codedError("Invalid URL: " + text, "INVALID_ARGUMENT");
      }
    } else {
      url = new URL(root + (text.startsWith("/") ? "" : "/") + text);
    }
    if (url.origin !== rootOrigin) {
      throw codedError(
        "Refusing to send the OpenProject token to " + url.origin + " (only " + rootOrigin + " is allowed)",
        "FOREIGN_ORIGIN"
      );
    }
    return url.href;
  }

  function authHeaders() {
    const key = resolveKey();
    if (!key) {
      throw codedError(
        "API Error: 401 Unauthorized missing OpenProject API token (caller Bearer or OPENPROJECT_API_KEY)",
        "NO_TOKEN",
        { status: 401 }
      );
    }
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from("apikey:" + key).toString("base64"),
    };
  }

  async function request(endpoint, verb, body, options = {}) {
    const method = String(verb || "GET").toUpperCase();
    const url = resolveUrl(endpoint);
    const headers = authHeaders();
    const limit = requestTimeoutMs(options.timeoutMs, timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const call = { url, limit, signal: controller.signal, where: method + " " + new URL(url).pathname };
    const init = { method, headers, signal: controller.signal, redirect: "error" };
    if (hasBody(method, body)) init.body = JSON.stringify(body);
    try {
      const { response, text } = await fetchText(fetchFn, init, call);
      const allowed = options.allowStatuses || [];
      if (!response.ok && !allowed.includes(response.status)) throw httpError(response, text);
      return parseBody(response, text);
    } finally {
      clearTimeout(timer);
    }
  }

  return { request, baseUrl: root, resolveKey, resolveUrl };
}

export function hrefId(href) {
  if (!href) return null;
  let cleaned = String(href).split("?")[0];
  while (cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1);
  const part = cleaned.split("/").pop();
  return part || null;
}

export function collectionElements(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (payload._embedded && Array.isArray(payload._embedded.elements)) {
    return payload._embedded.elements;
  }
  return [];
}

/**
 * Walk a paged collection (offset 1, 2, ...) until an element satisfies
 * `want` or offset * pageSize reaches total. Returns {match, elements, first}:
 * the matching element and the page it was on (or null and []), and the
 * first element of page 1 (or null). With firstPageOnly, only page 1 is read.
 * @param {Function} request
 * @param {string} endpoint path without a query
 * @param {Record<string, string>} params other query parameters (e.g. filters)
 * @param {number} pageSize
 * @param {(element: any) => boolean} want
 * @param {{ firstPageOnly?: boolean }} [options]
 */
export async function findInPages(request, endpoint, params, pageSize, want, { firstPageOnly = false } = {}) {
  let first = null;
  for (let offset = 1; ; offset++) {
    const query = new URLSearchParams(params);
    query.set("pageSize", String(pageSize));
    if (offset > 1) query.set("offset", String(offset));
    const payload = await request(endpoint + "?" + query.toString());
    const elements = collectionElements(payload);
    if (offset === 1) first = elements[0] ?? null;
    const match = elements.find(want);
    if (match) return { match, elements, first };
    const total = Number(payload?.total ?? elements.length);
    if (firstPageOnly || !elements.length || offset * pageSize >= total) return { match: null, elements: [], first };
  }
}

export function wpHref(id) {
  return "/api/v3/work_packages/" + seg(id, "id");
}
