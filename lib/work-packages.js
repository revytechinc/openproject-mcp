/**
 * Helpers for reading and writing OpenProject projects and work packages.
 *
 * Two response shapes are in the wild. Some instances carry status, type,
 * assignee and parent as top-level fields; others expose them only through
 * _links. Both are read here. The top-level field wins for status and type,
 * because it carries the machine-readable name. For the assignee the link
 * wins, because it carries the person's name while the top-level field
 * carries their login.
 *
 * Project-scoped endpoints are addressed two ways as well. Newer instances
 * serve /api/v3/workspaces/<id>/..., older ones serve
 * /api/v3/projects/<id>/..., and a project identifier is not a path
 * segment: it has to be resolved to the numeric id first.
 */

import { hrefId } from "./api.js";

/** linkTitle reads a link's human name. */
function linkTitle(link) {
  if (!link) return null;
  if (typeof link === "string") return link;
  return link.title || link.name || null;
}

/** firstName reads a nested object's name under several possible keys. */
function firstName(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.name || value.title || value.login || null;
}

/**
 * parentIdOf reads a work package's parent id.
 *
 * The two shapes give it in different types: the _links href is a string, the
 * top-level field is a number. The reported value is always a number, so a
 * caller can compare it with a numeric id without a cast.
 */
function parentIdOf(wp, links) {
  const fromLink = hrefId(links.parent?.href);
  if (fromLink !== null && /^\d+$/.test(String(fromLink))) return Number(fromLink);
  if (wp.parent && wp.parent.id) return wp.parent.id;
  return fromLink;
}

/**
 * normalizeWorkPackage turns a work package payload into the flat shape the
 * tools report.
 */
export function normalizeWorkPackage(wp) {
  if (!wp) return null;
  const links = wp._links || {};
  let description = null;
  if (wp.description && wp.description.raw !== undefined) {
    description = wp.description.raw;
  } else if (typeof wp.description === "string") {
    description = wp.description;
  }
  return {
    id: wp.id,
    subject: wp.subject,
    description,
    status: firstName(wp.status) || linkTitle(links.status),
    statusId: idOf(links.status, wp.status),
    type: firstName(wp.type) || linkTitle(links.type),
    assignee: linkTitle(links.assignee) || firstName(wp.assignee),
    assigneeId: idOf(links.assignee, wp.assignee),
    parentId: parentIdOf(wp, links),
    version: linkTitle(links.version) || firstName(wp.version),
    versionId: idOf(links.version, wp.version),
    priority: firstName(wp.priority),
    startDate: wp.startDate ?? null,
    dueDate: wp.dueDate ?? null,
    percentageDone: wp.percentageDone ?? null,
    estimatedTime: wp.estimatedTime ?? null,
    remainingTime: wp.remainingTime ?? null,
    lockVersion: wp.lockVersion ?? null,
  };
}

/**
 * idOf reads the numeric id behind a link or a nested object.
 */
function idOf(link, object) {
  const fromLink = hrefId(link?.href);
  if (fromLink !== null && /^\d+$/.test(String(fromLink))) return Number(fromLink);
  if (object?.id) return object.id;
  return null;
}

/**
 * numericId turns an id from a link or a payload into a number, so every id
 * a tool reports can be compared with another without a cast.
 */
export function numericId(value) {
  if (value === null || value === undefined) return null;
  const asString = String(value);
  if (/^\d+$/.test(asString)) return Number(asString);
  return null;
}

/**
 * assertApplied checks that the fields a caller asked for actually took.
 *
 * An instance can accept a write, answer 200, and ignore a field it does
 * not recognise. A tool that reports success for a write that changed
 * nothing is worse than one that fails: the caller has no way to tell the
 * difference. So the response is compared against the request, and a field
 * that did not take is named.
 */
export function assertApplied(after, requested, subject) {
  const missing = [];
  const check = (field, wanted, got) => {
    if (wanted === undefined || wanted === null || wanted === "") return;
    if (got !== wanted) missing.push(field);
  };
  // An id is compared only when the response carries one. An instance that
  // reports a status by name and no id cannot be checked against an id.
  const checkId = (field, wanted, got) => {
    if (wanted === undefined || wanted === null || wanted === "") return;
    if (got === null || got === undefined) return;
    if (got !== wanted) missing.push(field);
  };
  check("subject", requested.subject, after.subject);
  check("description", requested.description, after.description);
  check("priority", requested.priority, after.priority);
  checkId("status", requested.statusId, after.statusId);
  checkId("assignee", requested.assigneeId, after.assigneeId);
  checkId("version", requested.versionId, after.versionId);
  checkId("parent", requested.parentId, after.parentId);
  check("startDate", requested.startDate, after.startDate);
  check("dueDate", requested.dueDate, after.dueDate);
  check("percentageDone", requested.percentageDone, after.percentageDone);
  check("estimatedTime", requested.estimatedTime, after.estimatedTime);
  check("remainingTime", requested.remainingTime, after.remainingTime);
  check("scheduleManually", requested.scheduleManually, after.scheduleManually);
  if (missing.length > 0) {
    throw new Error(
      subject +
        " was accepted but these fields did not take: " +
        missing.join(", ") +
        ". The instance ignored them."
    );
  }
  return after;
}

/**
 * assertProjectApplied checks that a project update took.
 */
export function assertProjectApplied(after, requested) {
  const missing = [];
  if (requested.name && after.name !== requested.name) missing.push("name");
  if (requested.description && after.description !== requested.description) {
    missing.push("description");
  }
  if (requested.status && after.status !== requested.status) missing.push("status");
  if (missing.length > 0) {
    throw new Error(
      "the project was accepted but these fields did not take: " +
        missing.join(", ") +
        ". The instance ignored them."
    );
  }
  return after;
}

/**
 * resolveProjectId turns a project identifier or number into the numeric id
 * the API paths want.
 */
export async function resolveProjectId(apiRequest, projectId) {
  if (projectId === undefined || projectId === null || projectId === "") return null;
  const asString = String(projectId);
  if (/^\d+$/.test(asString)) return Number(asString);
  const filters = encodeURIComponent(
    JSON.stringify([{ identifier: { operator: "=", values: [asString] } }])
  );
  const payload = await apiRequest("/api/v3/projects?filters=" + filters);
  const elements = (payload && payload._embedded && payload._embedded.elements) || [];
  const match = elements.find((p) => p && p.identifier === asString);
  if (!match || !match.id) {
    throw new Error(
      "no project matches identifier: " +
        asString +
        ". Check the identifier, or pass the numeric project ID."
    );
  }
  return match.id;
}

/**
 * listWorkPackages reads a project's work packages, trying the endpoint
 * shape this instance serves.
 */
export async function listWorkPackages(apiRequest, projectId, query) {
  const suffix = query ? "?" + query : "";
  const id = await resolveProjectId(apiRequest, projectId);
  if (id === null) return apiRequest("/api/v3/work_packages" + suffix);
  try {
    return await apiRequest("/api/v3/workspaces/" + id + "/work_packages" + suffix);
  } catch (error) {
    if (!error || error.status !== 404) throw error;
    return apiRequest("/api/v3/projects/" + id + "/work_packages" + suffix);
  }
}

/**
 * projectBasePath returns the project-scoped base path this instance
 * serves: /api/v3/workspaces/<id> on newer instances, /api/v3/projects/<id>
 * on older ones.
 */
export async function projectBasePath(apiRequest, projectId) {
  const id = await resolveProjectId(apiRequest, projectId);
  if (id === null) {
    throw new Error("a project is required: pass a project ID or identifier");
  }
  try {
    await apiRequest("/api/v3/workspaces/" + id + "/work_packages?pageSize=1");
    return "/api/v3/workspaces/" + id;
  } catch (error) {
    if (!error || error.status !== 404) throw error;
    return "/api/v3/projects/" + id;
  }
}

/**
 * workPackageUpdateBody builds the PATCH body for a work package.
 *
 * The lockVersion of the work package being updated travels with the body:
 * OpenProject refuses an update that was computed against a stale version,
 * and that refusal is a safety net, not an obstacle.
 */
export function workPackageUpdateBody(current, args) {
  const body = { lockVersion: current.lockVersion };
  if (args.subject) body.subject = args.subject;
  if (args.description) body.description = { format: "markdown", raw: args.description };
  if (args.estimatedTime) body.estimatedTime = args.estimatedTime;
  if (args.remainingTime) body.remainingTime = args.remainingTime;
  if (args.priority) body.priority = { name: args.priority };
  if (args.startDate !== undefined) body.startDate = args.startDate;
  if (args.dueDate !== undefined) body.dueDate = args.dueDate;
  if (args.percentageDone !== undefined) body.percentageDone = args.percentageDone;
  if (args.scheduleManually !== undefined) body.scheduleManually = args.scheduleManually;

  const links = {};
  if (args.statusId) links.status = { href: "/api/v3/statuses/" + args.statusId };
  if (args.assigneeId) links.assignee = { href: "/api/v3/users/" + args.assigneeId };
  if (args.versionId) links.version = { href: "/api/v3/versions/" + args.versionId };
  if (args.parentId) links.parent = { href: "/api/v3/work_packages/" + args.parentId };
  if (Object.keys(links).length > 0) body._links = links;
  return body;
}

/**
 * projectUpdateBody builds the PATCH body for a project.
 *
 * The description is sent as a formattable. A plain string is accepted by
 * the API and then ignored, which is why a project description never
 * appeared after a 200 response.
 */
export function projectUpdateBody(args) {
  const body = {};
  if (args.name) body.name = args.name;
  if (args.description) body.description = { format: "markdown", raw: args.description };
  if (args.status) body.status = { name: args.status };
  return body;
}
