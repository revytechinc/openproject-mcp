/**
 * OpenProject API v3 client used by both upstream tools and CloudBSD write tools.
 *
 * Auth: Basic apikey:<token>. Token may be a static string or resolved per-call
 * via getApiKey() (caller-token / AsyncLocalStorage). Fail closed if empty.
 */

export function createApi({
  baseUrl,
  apiKey,
  getApiKey,
  fetchImpl,
} = {}) {
  let root = String(baseUrl || "");
  while (root.endsWith("/")) root = root.slice(0, -1);
  const fetchFn = fetchImpl || globalThis.fetch;

  function resolveKey() {
    if (typeof getApiKey === "function") {
      const v = getApiKey();
      if (v) return String(v);
    }
    if (apiKey) return String(apiKey);
    return "";
  }

  async function request(endpoint, method, body, options) {
    method = method || "GET";
    options = options || {};
    const url = String(endpoint).startsWith("http") ? endpoint : root + endpoint;

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    const key = resolveKey();
    if (!key) {
      const error = new Error(
        "API Error: 401 Unauthorized missing OpenProject API token (caller Bearer or OPENPROJECT_API_KEY)"
      );
      error.status = 401;
      throw error;
    }
    const auth = Buffer.from("apikey:" + key).toString("base64");
    headers.Authorization = "Basic " + auth;

    const init = { method, headers };
    if (body && method !== "GET" && method !== "HEAD") {
      init.body = JSON.stringify(body);
    }

    const response = await fetchFn(url, init);
    const allowed = options.allowStatuses || [];

    if (!response.ok && !allowed.includes(response.status)) {
      let detail = "";
      try {
        detail = (await response.text()).slice(0, 800);
      } catch {
        detail = "";
      }
      const suffix = detail ? " " + detail : "";
      const error = new Error(
        "API Error: " + response.status + " " + response.statusText + suffix
      );
      error.status = response.status;
      error.body = detail;
      throw error;
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return { status: response.status, empty: true };
    }

    try {
      return JSON.parse(text);
    } catch {
      return { status: response.status, raw: text };
    }
  }

  return { request, baseUrl: root, resolveKey };
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

export function wpHref(id) {
  return "/api/v3/work_packages/" + id;
}
