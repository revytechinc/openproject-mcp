/**
 * OpenProject HTML session client (admin UI).
 *
 * API v3 cannot create/update Statuses (GET-only). Admin mutations go through
 * the Rails HTML controllers with CSRF + session cookie.
 *
 * Credentials: never accept plaintext passwords as tool args. Resolve from
 * env or 0600 credential files (CloudBSD ~/.creds pattern).
 */

import { readFileSync } from "node:fs";

function trimSlash(url) {
  let root = String(url || "");
  while (root.endsWith("/")) root = root.slice(0, -1);
  return root;
}

function readSecretFile(path) {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Resolve web login credentials without exposing values.
 * @returns {{ username: string, password: string, source: string }}
 */
export function resolveWebCredentials(env = process.env) {
  const username = env.OPENPROJECT_WEB_USER || env.TRACK_WEB_USER || "";
  const password =
    env.OPENPROJECT_WEB_PASSWORD ||
    env.TRACK_WEB_PASSWORD ||
    readSecretFile(env.OPENPROJECT_WEB_PASSWORD_FILE) ||
    readSecretFile(env.TRACK_WEB_PASSWORD_FILE) ||
    "";

  if (!username || !password) {
    const err = new Error(
      "OpenProject web credentials missing. Set OPENPROJECT_WEB_USER and " +
        "OPENPROJECT_WEB_PASSWORD_FILE (0600 secret file). Do not pass passwords as tool args."
    );
    err.code = "MISSING_WEB_CREDENTIALS";
    throw err;
  }

  return {
    username,
    password,
    source:
      env.OPENPROJECT_WEB_PASSWORD_FILE ||
      env.TRACK_WEB_PASSWORD_FILE ||
      "env",
  };
}

export function extractAuthenticityToken(html) {
  if (!html) return null;
  const meta = html.match(
    /<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/i
  );
  if (meta) return meta[1];
  const input = html.match(
    /name=["']authenticity_token["']\s+value=["']([^"']+)["']/i
  );
  if (input) return input[1];
  const inputRev = html.match(
    /value=["']([^"']+)["']\s+name=["']authenticity_token["']/i
  );
  return inputRev ? inputRev[1] : null;
}

function mergeSetCookie(jar, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const list = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : [setCookieHeaders];
  for (const raw of list) {
    const part = String(raw).split(";")[0];
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    jar.set(name, value);
  }
}

function applyResponseCookies(jar, headers) {
  if (typeof headers.getSetCookie === "function") {
    mergeSetCookie(jar, headers.getSetCookie());
    return;
  }
  const sc = headers.get("set-cookie");
  if (sc) mergeSetCookie(jar, sc);
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

function isRedirect(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isSuccess(status) {
  return (status >= 200 && status < 300) || isRedirect(status);
}

function throwTwoFactor(location) {
  const err = new Error(
    "OpenProject web login requires two-factor authentication. " +
      "Use OPENPROJECT_STATUS_BACKEND=rails on the OpenProject host " +
      "(bin/rails runner as the openproject user), or a non-2FA admin service account."
  );
  err.code = "LOGIN_REQUIRES_2FA";
  err.location = location;
  throw err;
}

function throwLoginFailed(detail) {
  const err = new Error(
    "OpenProject web login failed (" +
      detail +
      "). Check OPENPROJECT_WEB_USER and OPENPROJECT_WEB_PASSWORD_FILE."
  );
  err.code = "LOGIN_FAILED";
  throw err;
}

function sameOrigin(base, url) {
  try {
    const b = new URL(base);
    const u = new URL(url, base);
    return b.origin === u.origin;
  } catch {
    return false;
  }
}

/**
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, getCredentials?: Function }} options
 */
export function createWebSession(options = {}) {
  const baseUrl = trimSlash(options.baseUrl);
  const fetchFn = options.fetchImpl || globalThis.fetch;
  const getCredentials = options.getCredentials || resolveWebCredentials;
  const jar = new Map();
  let loggedIn = false;

  async function raw(method, path, { body, headers, sendCookies = true } = {}) {
    const url = path.startsWith("http") ? path : baseUrl + path;
    if (!sameOrigin(baseUrl, url)) {
      const err = new Error(
        "OpenProject web session refused cross-origin request: " + url
      );
      err.code = "CROSS_ORIGIN_REFUSED";
      throw err;
    }
    const init = {
      method,
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
    };
    if (headers) {
      Object.assign(init.headers, headers);
    }
    if (sendCookies) {
      const cookie = cookieHeader(jar);
      if (cookie) init.headers.Cookie = cookie;
    }
    if (body !== undefined) init.body = body;

    const response = await fetchFn(url, init);
    applyResponseCookies(jar, response.headers);
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      location: response.headers.get("location"),
      url,
    };
  }

  async function followRedirects(start, maxHops = 8) {
    let res = start;
    for (let i = 0; i < maxHops && isRedirect(res.status) && res.location; i++) {
      if (/two_factor_authentication/i.test(res.location)) {
        throwTwoFactor(res.location);
      }
      if (/\/login(?:\?|$)/i.test(res.location)) {
        throwLoginFailed("redirected to login");
      }
      const next = res.location.startsWith("http")
        ? res.location
        : baseUrl + res.location;
      if (!sameOrigin(baseUrl, next)) {
        const err = new Error(
          "OpenProject web session refused cross-origin redirect: " + next
        );
        err.code = "CROSS_ORIGIN_REFUSED";
        throw err;
      }
      res = await raw("GET", next);
    }
    return res;
  }

  async function assertAuthenticatedSession() {
    const probe = await followRedirects(await raw("GET", "/my/account"), 5);
    if (
      (isRedirect(probe.status) && /\/login|two_factor/i.test(probe.location || "")) ||
      /name=["']password["']/i.test(probe.text || "")
    ) {
      throwLoginFailed("session not authenticated after password POST");
    }
  }

  async function ensureLogin() {
    if (loggedIn) return;
    const creds = getCredentials();
    const loginPage = await raw("GET", "/login");
    const token = extractAuthenticityToken(loginPage.text);
    if (!token) {
      const err = new Error(
        "OpenProject login page missing authenticity_token. " +
          "Verify OPENPROJECT_URL points at a valid OpenProject web instance."
      );
      err.code = "LOGIN_CSRF_MISSING";
      throw err;
    }

    const form = new URLSearchParams();
    form.set("authenticity_token", token);
    form.set("username", creds.username);
    form.set("password", creds.password);
    form.set("login", "Sign in");

    const posted = await raw("POST", "/login", {
      body: form.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: baseUrl + "/login",
      },
    });

    if (!isSuccess(posted.status)) {
      const err = new Error(
        "OpenProject web login failed (HTTP " +
          posted.status +
          "). Check OPENPROJECT_WEB_USER and OPENPROJECT_WEB_PASSWORD_FILE."
      );
      err.code = "LOGIN_FAILED";
      err.status = posted.status;
      throw err;
    }

    await followRedirects(posted, 8);
    await assertAuthenticatedSession();
    loggedIn = true;
  }

  async function getHtml(path) {
    await ensureLogin();
    let res = await raw("GET", path);
    res = await followRedirects(res);
    if (res.status >= 400) {
      const err = new Error(
        "OpenProject GET " + path + " failed (HTTP " + res.status + ")"
      );
      err.code = "HTTP_ERROR";
      err.status = res.status;
      throw err;
    }
    if (/name=["']password["']/i.test(res.text || "") || /\/login/i.test(res.url || "")) {
      throwLoginFailed("landed on login page fetching " + path);
    }
    if (!extractAuthenticityToken(res.text) && isRedirect(res.status)) {
      const err = new Error(
        "OpenProject GET " +
          path +
          " redirected without landing on HTML (HTTP " +
          res.status +
          ")"
      );
      err.code = "REDIRECT_NO_HTML";
      err.status = res.status;
      err.location = res.location;
      throw err;
    }
    return res;
  }

  /**
   * Submit an HTML form.
   * @param {string} formPagePath path to GET for CSRF (e.g. /statuses/new)
   * @param {string} actionPath POST/PATCH target (e.g. /statuses)
   * @param {Record<string, string|boolean|number>} fields form fields including status[name]
   * @param {{ method?: string }} opts
   */
  async function submitForm(formPagePath, actionPath, fields, opts = {}) {
    await ensureLogin();
    const page = await getHtml(formPagePath);
    const token = extractAuthenticityToken(page.text);
    if (!token) {
      const err = new Error(
        "OpenProject form missing authenticity_token at " + formPagePath
      );
      err.code = "FORM_CSRF_MISSING";
      throw err;
    }

    const form = new URLSearchParams();
    form.set("authenticity_token", token);
    const httpMethod = (opts.method || "POST").toUpperCase();
    if (httpMethod === "PATCH" || httpMethod === "PUT") {
      form.set("_method", httpMethod.toLowerCase());
    }
    for (const [k, v] of Object.entries(fields || {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === "boolean") {
        form.set(k, v ? "1" : "0");
      } else {
        form.set(k, String(v));
      }
    }

    const res = await raw("POST", actionPath, {
      body: form.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: baseUrl + formPagePath,
      },
    });

    if (!isSuccess(res.status)) {
      const err = new Error(
        "OpenProject form submit " + actionPath + " failed (HTTP " + res.status + ")"
      );
      err.code = "FORM_POST_FAILED";
      err.status = res.status;
      throw err;
    }

    return { status: res.status, location: res.location };
  }

  return {
    ensureLogin,
    getHtml,
    submitForm,
    _jar: jar,
  };
}
