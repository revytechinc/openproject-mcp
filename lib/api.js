/**
 * OpenProject API v3 client used by both upstream tools and CloudBSD write tools.
 * Auth stays OPENPROJECT_URL + OPENPROJECT_API_KEY (Basic apikey:<token>).
 */

export function createApi({
  baseUrl,
  apiKey,
  fetchImpl,
} = {}) {
  const root = String(baseUrl || "").replace(/\/+$/, "");
  const fetchFn = fetchImpl || globalThis.fetch;

  async function request(endpoint, method, body, options) {
    method = method || "GET";
    options = options || {};
    const url = String(endpoint).startsWith("http") ? endpoint : root + endpoint;

    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    if (apiKey) {
      const auth = Buffer.from("apikey:" + apiKey).toString("base64");
      headers.Authorization = "Basic " + auth;
    }

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

  return { request, baseUrl: root };
}

export function hrefId(href) {
  if (!href) return null;
  const cleaned = String(href).split("?")[0].replace(/\/+$/, "");
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
