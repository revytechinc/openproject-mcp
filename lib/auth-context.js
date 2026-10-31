import { AsyncLocalStorage } from "node:async_hooks";
import { requestTimeoutMs } from "./config.js";
import { isRedirectFailure, isRedirectResponse } from "./errors.js";

const storage = new AsyncLocalStorage();

/**
 * Extract Bearer token from an Authorization header value.
 * Accepts "Bearer <token>" only. Returns null if missing/invalid.
 */
export function parseBearerAuthorization(headerValue) {
  if (!headerValue || typeof headerValue !== "string") return null;
  const parts = headerValue.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  if (parts[0].toLowerCase() !== "bearer") return null;
  return parts[1] || null;
}

export function runWithCallerToken(token, fn) {
  return storage.run({ token: String(token || "") }, fn);
}

export function getCallerToken() {
  const store = storage.getStore();
  return store?.token || "";
}

/**
 * Resolve OpenProject API token for this call:
 * 1) caller Bearer (AsyncLocalStorage)
 * 2) OPENPROJECT_API_KEY env (stdio / bootstrap / health)
 */
export function resolveOpenProjectToken() {
  const caller = getCallerToken();
  if (caller) return caller;
  return process.env.OPENPROJECT_API_KEY || "";
}

/**
 * HTTP mode getter: the caller's Bearer token, never OPENPROJECT_API_KEY.
 * Throws (code NO_CALLER_TOKEN) when no caller context is present.
 */
export function requireCallerToken() {
  const caller = getCallerToken();
  if (caller) return caller;
  const error = new Error(
    "No caller token for this request; HTTP mode never uses the service OPENPROJECT_API_KEY"
  );
  error.code = "NO_CALLER_TOKEN";
  throw error;
}

/**
 * Validate token against OpenProject /api/v3/users/me.
 * Returns { ok, user?, status, unavailable?, code?, error? }. unavailable is
 * true when OpenProject could not answer (connection failure, timeout, 5xx,
 * or a redirect), so callers can tell an outage from a rejected token.
 * Bounded by OPENPROJECT_TIMEOUT_MS (default 30 s) like lib/api.js, and a
 * redirect is never followed (code REDIRECT_REFUSED).
 * @param {{ timeoutMs?: number }} [options]
 */
export async function validateCallerToken(baseUrl, token, fetchImpl, options = {}) {
  let root = String(baseUrl || "");
  while (root.endsWith("/")) root = root.slice(0, -1);
  if (!root) {
    return { ok: false, status: 503, unavailable: true, error: "OPENPROJECT_URL not configured" };
  }
  if (!token) {
    return { ok: false, status: 401, error: "missing bearer" };
  }
  const limit = requestTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    return await askUsersMe(fetchImpl || globalThis.fetch, root, token, controller.signal, limit);
  } finally {
    clearTimeout(timer);
  }
}

const REDIRECT_REFUSED = {
  ok: false,
  status: 502,
  unavailable: true,
  code: "REDIRECT_REFUSED",
  error: "OpenProject answered users/me with a redirect; refused",
};

/** Why a users/me fetch failed: timeout, redirect, or OpenProject unreachable. */
function usersMeFailure(error, signal, limit) {
  if (signal.aborted) {
    return {
      ok: false,
      status: 504,
      unavailable: true,
      code: "TIMEOUT",
      error: "OpenProject did not answer users/me within " + limit + " ms",
    };
  }
  if (isRedirectFailure(error)) return { ...REDIRECT_REFUSED };
  // OpenProject (or the proxy in front of it) is not answering. That says
  // nothing about the token, so it must not be reported as a bad token.
  return { ok: false, status: 503, unavailable: true, error: "OpenProject unreachable" };
}

async function askUsersMe(fetchFn, root, token, signal, limit) {
  let response;
  try {
    response = await fetchFn(root + "/api/v3/users/me", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from("apikey:" + token).toString("base64"),
      },
      redirect: "error",
      signal,
    });
  } catch (error) {
    return usersMeFailure(error, signal, limit);
  }
  if (isRedirectResponse(response)) return { ...REDIRECT_REFUSED };
  if (!response.ok) {
    // 5xx: OpenProject is down or restarting (nginx answers 502/503 while
    // Puma boots). Only a 4xx is a verdict on the token.
    const unavailable = response.status >= 500;
    return {
      ok: false,
      status: response.status,
      unavailable,
      error: unavailable ? "OpenProject unavailable" : "OpenProject rejected token",
    };
  }
  let user = null;
  try {
    user = await response.json();
  } catch {
    user = null;
  }
  return { ok: true, status: 200, user };
}
