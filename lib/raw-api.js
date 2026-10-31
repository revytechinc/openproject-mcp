/**
 * raw_api_call: the last-resort escape hatch. Same-origin enforcement lives
 * in lib/api.js; this module normalises arguments and points the agent at
 * the typed tool when one covers the call.
 */
import { checkArgs } from "./tool-args.js";
import { trimTrailingSlashes } from "./path.js";

function argumentError(message) {
  const error = new Error(message);
  error.code = "INVALID_ARGUMENT";
  return error;
}

function queryValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Append a query object to an endpoint, URL-encoded. */
export function appendQuery(endpoint, query) {
  if (query === undefined || query === null) return endpoint;
  if (typeof query !== "object" || Array.isArray(query)) {
    throw argumentError("query must be an object of name: value pairs");
  }
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    const v = queryValue(value);
    if (v !== null) params.append(name, v);
  }
  const qs = params.toString();
  if (!qs) return endpoint;
  return endpoint + (endpoint.includes("?") ? "&" : "?") + qs;
}

const ID = "[^/]+";
const WP = "^/api/v3/work_packages/" + ID;

/**
 * Calls a typed tool covers. Each `tool` is exactly one registered tool name
 * (test/review-1677.test.js checks them against ListTools).
 */
export const TYPED_TOOL_PATTERNS = [
  { method: "POST", path: new RegExp(WP + "/activities$"), tool: "add_comment" },
  { method: "GET", path: new RegExp(WP + "/activities$"), tool: "list_activities" },
  { method: "PATCH", path: new RegExp("^/api/v3/activities/" + ID + "$"), tool: "edit_comment" },
  { method: "GET", path: new RegExp(WP + "$"), tool: "get_work_package" },
  { method: "PATCH", path: new RegExp(WP + "$"), tool: "update_work_package" },
  {
    method: "GET",
    path: new RegExp("^/api/v3/(?:(?:projects|workspaces)/" + ID + "/)?work_packages$"),
    needsFilters: true,
    tool: "list_work_packages",
  },
  { method: "POST", path: new RegExp("^/api/v3/(?:projects|workspaces)/" + ID + "/work_packages$"), tool: "create_work_package" },
  { method: "GET", path: new RegExp(WP + "/relations$"), tool: "list_relations" },
  { method: "POST", path: new RegExp(WP + "/relations$"), tool: "relation_upsert" },
  { method: "DELETE", path: new RegExp("^/api/v3/relations/" + ID + "$"), tool: "delete_relation" },
  { method: "GET", path: new RegExp(WP + "/watchers$"), tool: "list_watchers" },
  { method: "POST", path: new RegExp(WP + "/watchers$"), tool: "add_watcher" },
  { method: "POST", path: /^\/api\/v3\/time_entries$/, tool: "log_time" },
];

/** Typed tools the description points at, in the order an agent should look. */
const PREFERRED_TOOLS = [
  "get_work_package",
  "list_work_packages",
  "update_work_package",
  "set_status",
  "create_work_package",
  "create_work_packages",
  "add_comment",
  "list_activities",
  "list_relations",
  "relation_upsert",
  "log_time",
  "find_user",
  "get_project",
];

export const RAW_API_TOOL = {
  name: "raw_api_call",
  description:
    "LAST RESORT: make a raw OpenProject API v3 call when no typed tool fits. " +
    "Prefer the typed tools: " +
    PREFERRED_TOOLS.join(", ") +
    ". Only the configured OpenProject origin is reachable; an absolute URL to any other host is refused, " +
    "and redirects are never followed. Pass endpoint (or its alias path). When a typed tool covers the call, " +
    'the answer is {hint: "<tool> covers this", result}; otherwise it is the OpenProject response as-is.',
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      endpoint: { type: "string", description: "API path, e.g. /api/v3/statuses (endpoint or path is required)" },
      path: { type: "string", description: "Alias for endpoint" },
      method: { type: "string", description: "HTTP method, any case (GET, POST, PATCH, DELETE)", default: "GET" },
      query: { type: "object", description: "Query parameters; object/array values are JSON-encoded (e.g. filters)" },
      body: { type: "object", description: "Request body for POST/PATCH, sent as given" },
    },
  },
};

/**
 * The typed tool that covers method + url, or undefined.
 * @param {string} method upper-case HTTP method
 * @param {string} href absolute URL (already resolved against the root)
 * @param {string} rootPath path prefix of the configured root ("" or "/openproject")
 */
export function typedToolFor(method, href, rootPath = "") {
  const url = new URL(href);
  let path = url.pathname;
  if (rootPath && path.startsWith(rootPath + "/")) path = path.slice(rootPath.length);
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  for (const pattern of TYPED_TOOL_PATTERNS) {
    if (pattern.method !== method || !pattern.path.test(path)) continue;
    if (pattern.needsFilters && !url.searchParams.has("filters")) continue;
    return pattern.tool;
  }
  return undefined;
}

/**
 * Run raw_api_call.
 * @param {Record<string, unknown>} args
 * @param {{ request: Function, resolveUrl: Function, baseUrl: string }} api
 */
export async function handleRawApiCall(rawArgs, api) {
  const args = checkArgs(RAW_API_TOOL, rawArgs);
  const { endpoint, path } = args;
  if (endpoint != null && path != null && String(endpoint) !== String(path)) {
    throw argumentError("raw_api_call: pass endpoint or path, not two different values");
  }
  const target = endpoint != null ? endpoint : path;
  if (target == null || target === "") {
    throw argumentError("raw_api_call requires endpoint (or its alias path)");
  }
  const method = String(args.method || "GET").toUpperCase();
  const full = appendQuery(String(target), args.query);
  const href = api.resolveUrl(full);
  const result = await api.request(full, method, args.body);
  let rootPath = "";
  try {
    rootPath = trimTrailingSlashes(new URL(api.baseUrl).pathname);
  } catch {
    rootPath = "";
  }
  const tool = typedToolFor(method, href, rootPath);
  if (!tool) return result;
  return { hint: tool + " covers this", result };
}
