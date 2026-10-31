/**
 * Path-segment helpers. Every value placed into an OpenProject URL path goes
 * through seg() so an id like "5/../../users" cannot change the endpoint.
 */

const PROJECT_IDENTIFIER = /^[a-z0-9][a-z0-9_-]*$/;
const POSITIVE_INT = /^[1-9]\d*$/;

function invalid(kind, value) {
  const error = new Error(
    "Invalid " + (kind || "path segment") + ": " + JSON.stringify(value === undefined ? null : value)
  );
  error.code = "INVALID_ID";
  return error;
}

function isPositiveInteger(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  if (typeof value === "string") return POSITIVE_INT.test(value) && Number.isSafeInteger(Number(value));
  return false;
}

/**
 * Encode one URL path segment.
 * kind "id": a positive integer (number or digit string).
 * kind "project": a positive integer or an identifier matching ^[a-z0-9][a-z0-9_-]*$.
 * otherwise: any non-empty string or finite number except "." and "..".
 * @param {string|number} value
 * @param {"id"|"project"|string} [kind]
 * @returns {string}
 */
export function seg(value, kind) {
  if (kind === "id") {
    if (!isPositiveInteger(value)) throw invalid("id", value);
    return encodeURIComponent(String(value));
  }
  if (kind === "project") {
    if (isPositiveInteger(value)) return encodeURIComponent(String(value));
    if (typeof value === "string" && PROJECT_IDENTIFIER.test(value)) {
      return encodeURIComponent(value);
    }
    throw invalid("project", value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return encodeURIComponent(String(value));
  if (typeof value !== "string" || value === "" || value === "." || value === "..") {
    throw invalid(kind, value);
  }
  return encodeURIComponent(value);
}

/**
 * Drop trailing "/" characters in linear time (a /\/+$/ regex backtracks
 * quadratically on "////...x").
 * @param {string} text
 * @returns {string}
 */
export function trimTrailingSlashes(text) {
  const value = String(text);
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
