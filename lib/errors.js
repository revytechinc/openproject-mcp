/**
 * Structured tool errors. The CallTool handler returns
 *   { isError: true, content: [{ type: "text", text: '{"error":{...}}' }] }
 * with code, httpStatus, errorIdentifier (exactly as OpenProject sent it),
 * attribute, message and hint; fields that are not known are omitted.
 */

const ERROR_URN = "urn:openproject-org:api:v3:errors:";

const HINTS_BY_IDENTIFIER = {
  UpdateConflict:
    "The work package changed since it was read: fetch it again and retry with the current lockVersion.",
  PropertyConstraintViolation:
    "OpenProject rejected the value of the named attribute; check it against the form/schema for this work package type.",
  MultipleErrors:
    "Several attributes were rejected; see the messages for each attribute.",
  NotFound:
    "Check the id. OpenProject also answers 404 when the token cannot see the resource.",
  MissingPermission:
    "The caller's OpenProject account lacks the permission for this action in this project.",
  Unauthenticated:
    "The OpenProject token is missing or invalid; send a valid personal API token.",
  InvalidQuery:
    "The filters or sort parameters are malformed; filters must be a JSON array of {name: {operator, values}}.",
  InvalidRequestBody: "The request body is not valid JSON for this endpoint.",
  PropertyIsReadOnly: "That attribute cannot be written through the API.",
};

const HINTS_BY_CODE = {
  FOREIGN_ORIGIN:
    "Only the configured OpenProject origin may be called; pass a path such as /api/v3/work_packages/1.",
  TIMEOUT: "OpenProject was slow to answer; retry, or raise OPENPROJECT_TIMEOUT_MS.",
  NO_CALLER_TOKEN:
    "HTTP mode runs every call as the caller; send Authorization: Bearer <your OpenProject API token>.",
  NO_TOKEN: "Set OPENPROJECT_API_KEY (stdio) or send a caller Bearer token (HTTP).",
  INVALID_ID: "Ids must be positive integers; project ids may also be lowercase identifiers.",
  CONFIG: "Set OPENPROJECT_URL to the OpenProject base URL.",
  INVALID_ARGUMENT: "Check the argument names and values against the tool's inputSchema.",
  REDIRECT_REFUSED:
    "OpenProject answered with a redirect, which is never followed (the token would go with it); check OPENPROJECT_URL (scheme, host, path).",
  UPDATE_CONFLICT:
    "The work package changed since it was read: fetch it again and retry with the current lockVersion.",
  INVALID_TRANSITION: "The workflow does not allow that status from here; pick one of allowedStatuses.",
  TYPE_NOT_ALLOWED: "The project does not allow that type; pick one of allowedTypes (list_project_types lists them).",
};

const HINTS_BY_STATUS = {
  401: HINTS_BY_IDENTIFIER.Unauthenticated,
  403: HINTS_BY_IDENTIFIER.MissingPermission,
  404: HINTS_BY_IDENTIFIER.NotFound,
  409: HINTS_BY_IDENTIFIER.UpdateConflict,
  422: "OpenProject rejected the request body; check the attribute named in the error.",
  429: "OpenProject is rate limiting; wait and retry.",
  502: "OpenProject is unavailable; retry shortly.",
  503: "OpenProject is unavailable; retry shortly.",
  504: "OpenProject is unavailable; retry shortly.",
};

/** Every hint text, for checks that they only name tools that exist. */
export function allHints() {
  return [
    ...Object.values(HINTS_BY_IDENTIFIER),
    ...Object.values(HINTS_BY_CODE),
    ...Object.values(HINTS_BY_STATUS),
  ];
}

/** Structured fields copied into the error object when present. */
const LIST_FIELDS = ["allowedStatuses", "allowedTypes"];

/** Pick a hint for an error, or undefined when none is known. */
export function hintFor(error) {
  if (!error) return undefined;
  if (typeof error.hint === "string" && error.hint) return error.hint;
  const id = typeof error.errorIdentifier === "string" ? error.errorIdentifier : "";
  if (id.startsWith(ERROR_URN)) {
    const hint = HINTS_BY_IDENTIFIER[id.slice(ERROR_URN.length)];
    if (hint) return hint;
  }
  if (error.code && HINTS_BY_CODE[error.code]) return HINTS_BY_CODE[error.code];
  if (error.status && HINTS_BY_STATUS[error.status]) return HINTS_BY_STATUS[error.status];
  return undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value !== "";
}

function errorCode(e) {
  if (nonEmptyString(e.code)) return e.code;
  return e.status ? "HTTP_ERROR" : "ERROR";
}

/**
 * {message, opMessage?}. A bare lib/api.js error ("API Error: 404 ...") is
 * best told in OpenProject's words; a tool's own message (which already
 * quotes OpenProject) is kept, with OpenProject's next to it if it is not
 * quoted.
 */
function errorMessage(e) {
  const own = String(e.message || e);
  const opText = nonEmptyString(e.opMessage) ? e.opMessage : "";
  if (opText && (!e.message || own.startsWith("API Error:"))) {
    const errors = Array.isArray(e.errors) && e.errors.length ? " " + e.errors.join(" ") : "";
    return { message: opText + errors };
  }
  if (opText && !own.includes(opText)) return { message: own, opMessage: opText };
  return { message: own };
}

/** The {"error": {...}} object for an error, with absent fields omitted. */
export function toolErrorObject(error) {
  const e = error || {};
  const out = { code: errorCode(e) };
  if (Number.isInteger(e.status)) out.httpStatus = e.status;
  if (nonEmptyString(e.errorIdentifier)) out.errorIdentifier = e.errorIdentifier;
  if (e.attribute != null) out.attribute = e.attribute;
  const { message, opMessage } = errorMessage(e);
  if (opMessage) out.opMessage = opMessage;
  out.message = message;
  for (const key of LIST_FIELDS) {
    if (Array.isArray(e[key])) out[key] = e[key];
  }
  const hint = hintFor(e);
  if (hint) out.hint = hint;
  return out;
}

/** True when a fetch failed because the server answered with a redirect. */
export function isRedirectFailure(error) {
  for (let e = error, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (/redirect/i.test(String(e.message || ""))) return true;
  }
  return false;
}

/** True for a 3xx (or opaque redirect) response. */
export function isRedirectResponse(response) {
  if (!response) return false;
  if (response.type === "opaqueredirect") return true;
  return Number.isInteger(response.status) && response.status >= 300 && response.status < 400 && response.status !== 304;
}

/** MCP CallTool result for a thrown error. */
export function formatToolError(error) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: toolErrorObject(error) }, null, 2) }],
    isError: true,
  };
}
