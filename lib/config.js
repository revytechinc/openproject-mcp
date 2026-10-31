/**
 * Startup configuration. Fail closed: there is no default OpenProject URL,
 * because a default would receive real API tokens.
 */

const PLACEHOLDER_HOSTS = new Set(["your-openproject-instance.com"]);

function configError(message) {
  const error = new Error(message);
  error.code = "CONFIG";
  return error;
}

/**
 * Validate the OpenProject base URL and return it without trailing slashes.
 * Throws (code CONFIG) when it is unset, a placeholder, or not http(s).
 * @param {string|undefined} value
 * @returns {string}
 */
export function requireBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw configError(
      "OPENPROJECT_URL is not set. Set it to your OpenProject base URL (for example https://track.example.org); refusing to start."
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError("OPENPROJECT_URL is not a valid URL: " + raw + "; refusing to start.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw configError("OPENPROJECT_URL must be http(s): " + raw + "; refusing to start.");
  }
  if (PLACEHOLDER_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw configError(
      "OPENPROJECT_URL is still the example placeholder (" + parsed.hostname + "); refusing to start."
    );
  }
  let root = raw;
  while (root.endsWith("/")) root = root.slice(0, -1);
  return root;
}

/** Default limit for any request to OpenProject. */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * The request timeout: the first positive number among the explicit
 * values, else OPENPROJECT_TIMEOUT_MS, else 30 s.
 * @param {...unknown} values
 */
export function requestTimeoutMs(...values) {
  for (const value of [...values, process.env.OPENPROJECT_TIMEOUT_MS]) {
    const n = Number(value);
    if (value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}
