/**
 * Fake OpenProject apiRequest for behavioural tests. Records every call as
 * {method, path, body} and answers from a route table with canned v3 JSON.
 * Never touches the network.
 */

import { parseOpenProjectError } from "../lib/api.js";

/** An error shaped like the ones lib/api.js throws for a non-2xx answer. */
export function httpError(status, payload) {
  const text = JSON.stringify(payload || {});
  const parsed = parseOpenProjectError(text);
  const error = new Error("API Error: " + status + " " + (parsed.opMessage || text));
  error.code = "HTTP_ERROR";
  error.status = status;
  error.body = text;
  for (const key of ["errorIdentifier", "opMessage", "attribute", "errors", "document"]) {
    if (parsed[key] !== undefined) error[key] = parsed[key];
  }
  return error;
}

const TEXT_OPERATORS = ["~", "!~", "*", "!*"];
const REF_OPERATORS = ["=", "!", "*", "!*"];
/** Operators OpenProject accepts per filter (filters not listed are not checked). */
export const FILTER_OPERATORS = {
  subject: TEXT_OPERATORS,
  description: TEXT_OPERATORS,
  status: ["o", "c", "=", "!", "*"],
  search: ["**"],
  id: REF_OPERATORS,
  parent: REF_OPERATORS,
  assignee: REF_OPERATORS,
};

function invalidQuery(message) {
  return httpError(400, {
    _type: "Error",
    errorIdentifier: "urn:openproject-org:api:v3:errors:InvalidQuery",
    message,
  });
}

/** Throw a 400 like OpenProject for a filters= value it would refuse. */
export function checkFilters(endpoint) {
  const raw = new URL(endpoint, "https://op.example.invalid").searchParams.get("filters");
  if (raw == null) return;
  let filters;
  try {
    filters = JSON.parse(raw);
  } catch {
    throw invalidQuery("filters is not valid JSON.");
  }
  if (!Array.isArray(filters)) throw invalidQuery("filters must be a JSON array.");
  for (const filter of filters) {
    if (!filter || typeof filter !== "object") throw invalidQuery("Each filter must be an object.");
    for (const [name, spec] of Object.entries(filter)) {
      if (!spec || typeof spec.operator !== "string") throw invalidQuery("Filter " + name + " has no operator.");
      const allowed = FILTER_OPERATORS[name];
      if (allowed && !allowed.includes(spec.operator)) {
        throw invalidQuery(name + ': the operator "' + spec.operator + '" is not valid (allowed: ' + allowed.join(" ") + ").");
      }
    }
  }
}

/**
 * routes: [{ method, path, reply, times }]
 *   path  — exact string (matched without the query) or RegExp (full endpoint)
 *   reply — value, or function({ endpoint, body, query, calls }) (may throw)
 *   times — optional: the route answers this many times, then is skipped
 * A filters= value OpenProject would refuse (see FILTER_OPERATORS) is
 * answered with a 400 InvalidQuery before any route is consulted.
 */
/** True when route answers this call; a route with `times` uses one up. */
function takeRoute(route, method, bare, path) {
  if ((route.method || "GET") !== method) return false;
  const matched = typeof route.path === "string" ? bare === route.path : route.path.test(path);
  if (!matched) return false;
  if (route.times === undefined) return true;
  if (route.times <= 0) return false;
  route.times -= 1;
  return true;
}

export function fakeApi(routes) {
  const calls = [];
  async function request(endpoint, method, body) {
    method = method || "GET";
    const call = {
      method,
      path: String(endpoint),
      body: body === undefined ? undefined : structuredClone(body),
    };
    calls.push(call);
    checkFilters(call.path);
    const bare = call.path.split("?")[0];
    for (const route of routes) {
      if (!takeRoute(route, method, bare, call.path)) continue;
      const query = new URL(call.path, "https://op.example.invalid").searchParams;
      const out =
        typeof route.reply === "function"
          ? await route.reply({ endpoint: call.path, body, query, calls })
          : route.reply;
      return out === undefined ? out : structuredClone(out);
    }
    throw new Error("Unexpected request: " + method + " " + endpoint);
  }
  return { request, calls };
}

export function collection(elements, extra) {
  return {
    _type: "Collection",
    total: elements.length,
    count: elements.length,
    pageSize: elements.length,
    offset: 1,
    ...(extra || {}),
    _embedded: { elements },
  };
}

export const STATUSES = collection([
  { id: 1, name: "New", isClosed: false },
  { id: 2, name: "In progress", isClosed: false },
  { id: 3, name: "Blocked", isClosed: false },
  { id: 4, name: "Done", isClosed: true },
]);

export function workPackage(overrides) {
  const base = {
    _type: "WorkPackage",
    id: 1677,
    subject: "MCP tools",
    lockVersion: 5,
    createdAt: "2026-10-01T09:00:00Z",
    updatedAt: "2026-10-30T10:00:00Z",
    percentageDone: 10,
    startDate: "2026-10-01",
    dueDate: null,
    derivedStartDate: null,
    derivedDueDate: null,
    scheduleManually: false,
    estimatedTime: null,
    remainingTime: null,
    description: { format: "markdown", raw: "desc" },
    _embedded: { project: { id: 3, identifier: "cloudbsd", name: "CloudBSD" } },
    _links: {
      self: { href: "/api/v3/work_packages/1677", title: "MCP tools" },
      project: { href: "/api/v3/projects/3", title: "CloudBSD" },
      status: { href: "/api/v3/statuses/1", title: "New" },
      type: { href: "/api/v3/types/4", title: "Ops" },
      priority: { href: "/api/v3/priorities/8", title: "Normal" },
      assignee: { href: null },
      responsible: { href: null },
      version: { href: null },
      parent: { href: "/api/v3/work_packages/1600", title: "Track MCP" },
      ancestors: [
        { href: "/api/v3/work_packages/1500", title: "Root" },
        { href: "/api/v3/work_packages/1600", title: "Track MCP" },
      ],
      children: [{ href: "/api/v3/work_packages/1678", title: "Child" }],
    },
  };
  const out = { ...base, ...(overrides || {}) };
  if (overrides && overrides._links) out._links = { ...base._links, ...overrides._links };
  return out;
}

/** Apply a PATCH body to a canned work package the way OpenProject would. */
export function applyPatch(wp, body, titles) {
  const next = structuredClone(wp);
  const { lockVersion, _links, ...rest } = body || {};
  Object.assign(next, rest);
  if (_links) {
    for (const [key, link] of Object.entries(_links)) {
      next._links[key] = {
        href: link.href,
        title: link.href && titles ? titles[link.href] : undefined,
      };
    }
  }
  next.lockVersion = (lockVersion != null ? lockVersion : wp.lockVersion) + 1;
  next.updatedAt = "2026-10-31T12:00:00Z";
  return next;
}
