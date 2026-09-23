import { AsyncLocalStorage } from "node:async_hooks";

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
 * Validate token against OpenProject /api/v3/users/me.
 * Returns { ok, user?, status, error? }.
 */
export async function validateCallerToken(baseUrl, token, fetchImpl) {
  let root = String(baseUrl || "");
  while (root.endsWith("/")) root = root.slice(0, -1);
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!token) {
    return { ok: false, status: 401, error: "missing bearer" };
  }
  const auth = Buffer.from("apikey:" + token).toString("base64");
  const response = await fetchFn(root + "/api/v3/users/me", {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: "Basic " + auth,
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: "OpenProject rejected token",
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
