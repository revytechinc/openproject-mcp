/**
 * Work-package read and write: get_work_package, update_work_package,
 * set_status, validate_update. Unknown arguments are refused; status is
 * resolved by name; 409s are retried only when safe; a 422 on a status
 * change reports the statuses the workflow allows. projectId moves a work
 * package to another project; its type must be enabled there (#1910).
 */
import { wpHref } from "./api.js";
import { createLookups } from "./lookups.js";
import { seg } from "./path.js";
import { listActivities, pickWpId, postComment } from "./comments.js";
import { describeWorkPackage, summarizeWorkPackage, wpProject } from "./wp-compact.js";
import {
  checkArgs,
  duration,
  idFromHref,
  linkRef,
  projectSegment,
  opMessage,
  parseId,
  toolError,
  withNotify,
  wrapOpError,
} from "./tool-args.js";

const UPDATE_CONFLICT_URN = "urn:openproject-org:api:v3:errors:UpdateConflict";

const MAX_COMMENTS = 50;

/** Text fields where "" means absent (as before 2.0); clearing goes through `clear`. */
const TEXT_FIELDS = ["subject", "description"];
/** Plain fields written as-is (estimatedTime/remainingTime as durations). */
const SCALAR_FIELDS = ["subject", "startDate", "dueDate", "percentageDone", "scheduleManually", "estimatedTime", "remainingTime"];
/** Fields `clear` may empty, and where they live. */
const CLEARABLE = {
  parentId: { link: "parent" },
  assigneeId: { link: "assignee" },
  versionId: { link: "version" },
  startDate: { field: "startDate" },
  dueDate: { field: "dueDate" },
  estimatedTime: { field: "estimatedTime" },
  remainingTime: { field: "remainingTime" },
  description: { field: "description" },
};

export const FIELD_PROPERTIES = {
  subject: { type: "string", description: "Subject (title)" },
  description: {
    type: "string",
    description: 'Description (markdown). An empty string is ignored; to empty it use clear: ["description"].',
  },
  status: { type: "string", description: 'Status id or name (case-insensitive, e.g. "In progress"); a number is accepted too' },
  statusId: { type: "number", description: "Status id (alternative to status)" },
  priority: { type: "string", description: 'Priority id or name (e.g. "High"); a number is accepted too' },
  assigneeId: { type: "string", description: 'Assignee user id, login, or "me"; a number is accepted too' },
  versionId: { type: "number", description: "Version / sprint id" },
  parentId: {
    type: "number",
    description:
      'Parent work package id. To remove the parent pass clear: ["parentId"]; parentId: null does the same where your client can send a null',
  },
  startDate: { type: "string", description: "Start date YYYY-MM-DD" },
  dueDate: { type: "string", description: "Finish date YYYY-MM-DD" },
  scheduleManually: { type: "boolean", description: "Manual scheduling (true) or automatic (false)" },
  percentageDone: { type: "number", description: "% complete, 0-100" },
  estimatedTime: { type: "string", description: 'Work: ISO 8601 duration ("PT2H") or a number of hours ("2" or 2)' },
  remainingTime: { type: "string", description: 'Remaining work: ISO 8601 duration ("PT2H") or a number of hours ("2" or 2)' },
};

const UPDATE_PROPERTIES = {
  id: { type: "number", description: "Work package ID" },
  workPackageId: { type: "number", description: "Alias for id" },
  ...FIELD_PROPERTIES,
  projectId: {
    type: "string",
    description:
      "Move the work package to this project (id or identifier; a number is accepted too). Its type must be enabled in that project; " +
      "the type is never changed for you (the move fails with allowedTypes). Children may or may not follow: " +
      "the result's children field says which moved, read back from OpenProject.",
  },
  comment: { type: "string", description: "Comment to post after the update succeeds (#NNN auto-links to work package NNN)" },
  clear: {
    type: "array",
    items: { type: "string", enum: Object.keys(CLEARABLE) },
    description: "Fields to empty: " + Object.keys(CLEARABLE).join(", ") + ". (A null argument is ignored, not a clear.)",
  },
  lockVersion: {
    type: "number",
    description: "Optional optimistic lock. If given, a 409 is never retried; omit it and the tool reads the current one.",
  },
  notify: { type: "boolean", description: "Send notifications (default true)", default: true },
};

const RESULT_NOTE =
  "Returns {id, subject, status:{id,name}, type, assignee, project:{id,identifier?,name}, parentId, percentageDone, startDate, dueDate, lockVersion, updatedAt, url, retried, commentId? | comment:{error}?}.";
const MOVE_NOTE =
  " After a projectId move it also has moved:{from,to}, children:{moved,notMoved,unknown} (lists of {id,subject}) when there are children, and childrenNote?; " +
  "projectNote when the work package was already in that project.";

export const WP_UPDATE_TOOLS = [
  {
    name: "get_work_package",
    description:
      "Read one work package compactly: links as {id,name}, project, lockVersion, updatedAt, url, ancestors [{id,name}], childIds. " +
      "Use this before editing, or to inspect a ticket. Comments are opt-in: includeComments=N adds the newest N (max 50).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "number", description: "Work package ID" },
        workPackageId: { type: "number", description: "Alias for id" },
        includeComments: { type: "number", description: "Also return the newest N comments (default 0, max 50)", default: 0 },
      },
    },
  },
  {
    name: "update_work_package",
    description:
      "Change fields on a work package and optionally comment, in one call. Use this for any edit instead of raw_api_call (a last resort) (status by name, dates, %, parent, assignee, projectId to move it, ...). " +
      "Unknown argument names are refused. lockVersion is read for you; a 409 is retried once if none of the fields you write changed meanwhile. " +
      "A refused status transition (422) lists the statuses you may move to. The comment is posted after the PATCH; if only the comment fails, " +
      "the update still succeeds and comment.error says why (do not redo the update). Check first with validate_update if unsure. " +
      RESULT_NOTE +
      MOVE_NOTE,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: UPDATE_PROPERTIES,
    },
  },
  {
    name: "set_status",
    description:
      "Move a work package to a status (by name or id), optionally with % complete and a comment. Shortcut for update_work_package. " +
      RESULT_NOTE,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: UPDATE_PROPERTIES.id,
        workPackageId: UPDATE_PROPERTIES.workPackageId,
        status: FIELD_PROPERTIES.status,
        statusId: FIELD_PROPERTIES.statusId,
        percentageDone: FIELD_PROPERTIES.percentageDone,
        comment: UPDATE_PROPERTIES.comment,
        lockVersion: UPDATE_PROPERTIES.lockVersion,
        notify: UPDATE_PROPERTIES.notify,
      },
    },
  },
  {
    name: "validate_update",
    description:
      "Dry run of update_work_package: OpenProject checks the change (POST .../form) and nothing is written. " +
      "Use it to see whether a status move is allowed or what dates scheduling would produce. Takes the same arguments (comment and notify are ignored). " +
      "Returns {valid, errors:[{attribute,message}], allowedStatuses:[{id,name}], resulting:{startDate,dueDate,derivedStartDate,derivedDueDate}}.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: UPDATE_PROPERTIES,
    },
  },
];

const TOOL = Object.fromEntries(WP_UPDATE_TOOLS.map((tool) => [tool.name, tool]));

async function userHref(lookups, ref) {
  const user = await lookups.resolveUser(ref);
  const id = user === "me" ? await lookups.meId() : user;
  return "/api/v3/users/" + seg(id, "id");
}

function scalarFields(args, body) {
  for (const key of SCALAR_FIELDS) {
    if (args[key] === undefined) continue;
    body[key] = key === "estimatedTime" || key === "remainingTime" ? duration(args[key]) : args[key];
  }
  if (args.description !== undefined) {
    body.description = { format: "markdown", raw: String(args.description) };
  }
}

async function statusLink(args, lookups, linksOut) {
  if (args.status !== undefined && args.statusId !== undefined) {
    throw new Error("Pass status or statusId, not both");
  }
  const statusRef = args.status ?? args.statusId;
  if (statusRef === undefined) return null;
  const status = await lookups.resolveStatus(statusRef);
  linksOut.status = { href: "/api/v3/statuses/" + seg(status.id, "id") };
  return status;
}

/** Ids go straight through (OpenProject's 422 lists the allowed types); names are resolved in the project. */
async function typeId(lookups, projectRef, ref) {
  if (typeof ref === "number" || /^#?\d+$/.test(String(ref).trim())) return parseId(ref, "type");
  return (await lookups.resolveType(projectRef, ref)).id;
}

async function referenceLinks(args, lookups, projectRef, linksOut) {
  if (args.priority !== undefined) {
    const priority = await lookups.resolvePriority(args.priority);
    linksOut.priority = { href: "/api/v3/priorities/" + seg(priority.id, "id") };
  }
  const typeRef = args.type ?? args.typeId;
  if (typeRef !== undefined) {
    linksOut.type = { href: "/api/v3/types/" + seg(await typeId(lookups, projectRef, typeRef), "id") };
  }
  if (args.assigneeId !== undefined) {
    linksOut.assignee = { href: await userHref(lookups, args.assigneeId) };
  }
  if (args.versionId !== undefined) {
    linksOut.version = { href: "/api/v3/versions/" + seg(parseId(args.versionId, "versionId"), "id") };
  }
  if (args.parentId !== undefined) {
    linksOut.parent = { href: wpHref(parseId(args.parentId, "parentId")) };
  }
}

function clearFields(args, body, linksOut) {
  const list = Array.isArray(args.clear) ? args.clear : [args.clear];
  for (const name of list) {
    const target = CLEARABLE[name];
    if (!target) {
      throw new Error('clear: unknown field "' + name + '". Clearable: ' + Object.keys(CLEARABLE).join(", "));
    }
    if (args[name] !== undefined) throw new Error("clear: " + name + " is both set and cleared");
    if (target.link) linksOut[target.link] = { href: null };
    else if (target.field === "description") body.description = { format: "markdown", raw: "" };
    else body[target.field] = null;
  }
}

/**
 * Turn field arguments into an OpenProject body. Shared by update and create.
 * Returns {body, status} where status is the resolved status (or null).
 */
export async function buildFieldBody(rawArgs, lookups, { projectRef, allowClear = true } = {}) {
  const args = { ...rawArgs };
  for (const key of TEXT_FIELDS) {
    if (args[key] === "") delete args[key];
  }
  const body = {};
  const linksOut = {};
  scalarFields(args, body);
  const status = await statusLink(args, lookups, linksOut);
  await referenceLinks(args, lookups, projectRef, linksOut);
  if (allowClear && args.clear !== undefined) clearFields(args, body, linksOut);
  if (Object.keys(linksOut).length) body._links = linksOut;
  return { body, status };
}

/** What a written key currently holds on a work package, for conflict checks. */
function writtenValues(wp, body) {
  const out = {};
  for (const key of Object.keys(body)) {
    if (key === "_links") Object.assign(out, linkValues(wp, body._links));
    else if (key !== "lockVersion") out[key] = fieldValue(wp, key);
  }
  return out;
}

/** link name -> current href (or null) for each link being written. */
function linkValues(wp, links) {
  const out = {};
  for (const link of Object.keys(links)) out[link] = wp?._links?.[link]?.href || null;
  return out;
}

/** The current value of a written field; description compares by its raw text. */
function fieldValue(wp, key) {
  if (key === "description") return wp?.description ? wp.description.raw || "" : "";
  return wp?.[key] !== undefined ? wp[key] : null;
}

/** A 409: UPDATE_CONFLICT with OpenProject's UpdateConflict identifier, keeping what it said. */
function conflict(message, error) {
  return wrapOpError(error, message, {
    code: "UPDATE_CONFLICT",
    status: 409,
    errorIdentifier: UPDATE_CONFLICT_URN,
  });
}

function allowedFromForm(form) {
  const schema = form && form._embedded && form._embedded.schema;
  const status = schema && schema.status;
  if (!status) return [];
  const embedded = status._embedded && status._embedded.allowedValues;
  if (Array.isArray(embedded)) return embedded.map((s) => ({ id: s.id, name: s.name }));
  const linked = status._links && status._links.allowedValues;
  if (Array.isArray(linked)) return linked.map((s) => ({ id: idFromHref(s.href), name: s.title }));
  return [];
}

function formErrors(form) {
  const errors = (form && form._embedded && form._embedded.validationErrors) || {};
  const out = [];
  for (const [key, error] of Object.entries(errors)) {
    const nested = error && error._embedded && Array.isArray(error._embedded.errors) ? error._embedded.errors : [error];
    for (const item of nested) {
      const attribute = (item && item._embedded && item._embedded.details && item._embedded.details.attribute) || key;
      out.push({ attribute, message: item && item.message });
    }
  }
  return out;
}

async function postForm(request, id, body) {
  return request(wpHref(id) + "/form", "POST", body);
}

async function patchError(request, id, body, error) {
  const message = opMessage(error);
  if (error && error.status === 422 && body._links && body._links.status) {
    let allowedStatuses = [];
    try {
      allowedStatuses = allowedFromForm(await postForm(request, id, body));
    } catch {
      allowedStatuses = [];
    }
    return wrapOpError(
      error,
      "OpenProject refused the update (422): " +
        message +
        (allowedStatuses.length
          ? " Statuses this work package may move to: " +
            allowedStatuses.map((s) => s.name + " (" + s.id + ")").join(", ") +
            "."
          : ""),
      { status: 422, code: "INVALID_TRANSITION", allowedStatuses }
    );
  }
  const status = error && error.status;
  if (!status) return error;
  return wrapOpError(error, "OpenProject refused the update (" + status + "): " + message);
}

const STALE_LOCK =
  " is stale. Re-read the work package and decide again; not retried because lockVersion was given.";

/**
 * PATCH body; on a 409 re-read and retry once when none of the written
 * fields changed meanwhile. Returns {result, retried}.
 */
async function patchWithRetry(request, id, path, body, args, alreadyRead = null) {
  const explicitLock = args.lockVersion !== undefined;
  const current = explicitLock ? null : alreadyRead || (await request(path));
  const lockVersion = explicitLock ? Number(args.lockVersion) : current.lockVersion;
  const patch = (lv) => request(withNotify(path, args.notify), "PATCH", { ...body, lockVersion: lv });
  try {
    return { result: await patch(lockVersion), retried: false };
  } catch (error) {
    if (error?.status !== 409) throw await patchError(request, id, { ...body, lockVersion }, error);
    if (explicitLock) throw conflict("Update conflict (409): lockVersion " + lockVersion + STALE_LOCK, error);
    const fresh = await request(path);
    const changed = changedFields(current, fresh, body);
    if (changed.length) {
      throw conflict(
        "Update conflict (409): someone else changed " + changed.join(", ") + " meanwhile. Re-read the work package and decide again.",
        error
      );
    }
    return { result: await retryPatch(request, id, body, patch, fresh.lockVersion), retried: true };
  }
}

function changedFields(current, fresh, body) {
  const before = writtenValues(current, body);
  const after = writtenValues(fresh, body);
  // A move was checked against the type it had: a type change meanwhile blocks the retry too.
  if (body._links?.project) {
    before.type = current?._links?.type?.href || null;
    after.type = fresh?._links?.type?.href || null;
  }
  return Object.keys(before).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

async function retryPatch(request, id, body, patch, lockVersion) {
  try {
    return await patch(lockVersion);
  } catch (second) {
    if (second?.status === 409) {
      throw conflict("Update conflict (409) again after one retry. Re-read the work package and try later.", second);
    }
    throw await patchError(request, id, { ...body, lockVersion }, second);
  }
}

function assertStatusApplied(result, status) {
  const link = result?._links?.status;
  const got = idFromHref(link?.href);
  if (got !== status.id) {
    throw new Error('Status change to "' + status.name + '" was not applied: status is still ' + (link?.title || got));
  }
}

function orNull(value) {
  return value === undefined ? null : value;
}

/** At most this many children are read back after a move; the rest are reported unchecked. */
const MAX_CHILD_READS = 50;

function typesText(types) {
  if (!types.length) return "No types are enabled there.";
  return "Enabled there: " + types.map((t) => t.name + " (" + t.id + ")").join(", ") + ".";
}

function projectRef(target) {
  return target.identifier || String(target.id);
}

/**
 * Plan a move to args.projectId: resolve the project, read the work package
 * and check its type is enabled there. Returns null when there is no move,
 * else {link, current, from, target, same, typeError}. typeError is a
 * TYPE_NOT_ENABLED error (not thrown, so validate_update can report it);
 * a work package whose type cannot be read is refused too (fail closed).
 */
async function planMove(request, lookups, id, args) {
  if (args.projectId === undefined) return null;
  const ref = typeof args.projectId === "string" ? args.projectId.trim() : args.projectId;
  projectSegment(ref, "projectId");
  const project = await lookups.project(ref);
  const target = { id: project.id, identifier: project.identifier, name: project.name };
  const current = await request(wpHref(id));
  const from = wpProject(current);
  const same = from != null && Number(from.id) === Number(target.id);
  const type = linkRef(current?._links?.type);
  const base = { link: { href: "/api/v3/projects/" + seg(target.id, "id") }, current, from, target, same, type };
  if (same) return { ...base, typeError: null };
  const allowedTypes = await lookups.projectTypes(target.id);
  let typeError = null;
  if (type?.id == null) {
    typeError = toolError(
      "Not moved: the type of work package " + id + " could not be read, so it cannot be checked against project " + target.name + ".",
      { code: "TYPE_UNKNOWN", attribute: "type", allowedTypes }
    );
  } else if (!allowedTypes.some((t) => Number(t.id) === Number(type.id))) {
    typeError = toolError(
      'Not moved: type "' +
        type.name +
        '" is not enabled in project ' +
        target.name +
        " (" +
        projectRef(target) +
        "). " +
        typesText(allowedTypes) +
        " The tool does not change the type for you: change it first if that is right, or ask a project admin to enable it.",
      { code: "TYPE_NOT_ENABLED", attribute: "type", allowedTypes }
    );
  }
  return { ...base, typeError };
}

/**
 * The child links of a moved work package, read back from the PATCH
 * answer; the pre-move read only when the answer carries no children list.
 */
function childLinks(result, current) {
  const after = result?._links?.children;
  if (Array.isArray(after)) return after;
  const before = current?._links?.children;
  return Array.isArray(before) ? before : [];
}

function childEntry(link) {
  return { id: idFromHref(link?.href), subject: link?.title ?? null };
}

/** Read one child back: {id, subject} plus the project id it is in now (null when unknown). */
async function readChild(request, link) {
  const entry = childEntry(link);
  const id = entry.id;
  if (id == null) return { entry, projectId: null };
  try {
    const child = await request(wpHref(id));
    if (child?.subject != null) entry.subject = child.subject;
    return { entry, projectId: idFromHref(child?._links?.project?.href) };
  } catch {
    return { entry, projectId: null };
  }
}

/**
 * Where each child of a moved work package ended up, read back from
 * OpenProject: {moved, notMoved, unknown}, each a list of {id, subject}.
 * A child that cannot be read, or whose project cannot be read, or past
 * MAX_CHILD_READS, is unknown.
 */
async function childrenAfterMove(request, result, move) {
  const links = childLinks(result, move.current);
  if (!links.length) return { report: null, unread: [], unchecked: [] };
  const report = { moved: [], notMoved: [], unknown: [] };
  const unread = [];
  const unchecked = [];
  for (const [index, link] of links.entries()) {
    if (index >= MAX_CHILD_READS) {
      const entry = childEntry(link);
      report.unknown.push(entry);
      unchecked.push(entry);
      continue;
    }
    const { entry, projectId } = await readChild(request, link);
    if (projectId == null) {
      report.unknown.push(entry);
      unread.push(entry);
    }
    else if (Number(projectId) === Number(move.target.id)) report.moved.push(entry);
    else report.notMoved.push(entry);
  }
  return { report, unread, unchecked };
}

/** At most this many children are named per sentence of the note; subjects are cut to NOTE_SUBJECT. */
const NOTE_NAMES = 20;
const NOTE_SUBJECT = 80;

function idList(entries) {
  const named = entries.slice(0, NOTE_NAMES).map((entry) => {
    const id = entry.id == null ? "unknown id" : String(entry.id);
    if (entry.subject == null) return id;
    const subject = String(entry.subject);
    return id + " (" + (subject.length > NOTE_SUBJECT ? subject.slice(0, NOTE_SUBJECT) + "..." : subject) + ")";
  });
  const more = entries.length - named.length;
  return named.join(", ") + (more > 0 ? " and " + more + " more" : "");
}

function childrenNote(report, unread, unchecked, target) {
  const parts = [];
  if (report.notMoved.length) {
    parts.push(
      "Children left in other projects (target was " +
        target.name +
        "): " +
        idList(report.notMoved) +
        ". If they belong in " +
        target.name +
        ', move each with update_work_package projectId: "' +
        projectRef(target) +
        '".'
    );
  }
  if (unread.length) parts.push("Children that could not be read: " + idList(unread) + "; check them with get_work_package.");
  if (unchecked.length) {
    parts.push(
      "Children not checked (more than " + MAX_CHILD_READS + " children): " + idList(unchecked) + "; check them with get_work_package."
    );
  }
  return parts.length ? parts.join(" ") : null;
}

/**
 * After the PATCH: the work package must be in the target project with its
 * type unchanged. Either failure is reported as an error that says the
 * update was applied, so the caller does not repeat it.
 */
function assertMoveLanded(result, move, commentAsked) {
  const applied =
    "The update was applied to work package " + result.id + (commentAsked ? "; the comment was not posted" : "") + ". ";
  const landedLink = linkRef(result?._links?.project);
  if (!landedLink) {
    throw toolError(applied + "But its project could not be read from the answer. Read it with get_work_package before trying again.", {
      code: "MOVE_UNVERIFIED",
      attribute: "project",
    });
  }
  if (Number(landedLink.id) !== Number(move.target.id)) {
    throw toolError(
      applied +
        "But it is not in project " +
        move.target.name +
        ": it is still in project " +
        (landedLink.name || landedLink.id) +
        ". Read it before trying again.",
      { code: "MOVE_NOT_APPLIED", attribute: "project" }
    );
  }
  const after = linkRef(result?._links?.type);
  if (!after) {
    throw toolError(
      applied + "It is now in " + move.target.name + ", but its type could not be read from the answer. Read it with get_work_package before changing anything.",
      { code: "MOVE_UNVERIFIED", attribute: "type" }
    );
  }
  if (Number(after.id) !== Number(move.type.id)) {
    throw toolError(
      applied +
        "It is now in " +
        move.target.name +
        ", but OpenProject changed its type from " +
        move.type.name +
        " to " +
        after.name +
        ". Do not repeat the move; set the type back in OpenProject if that was wrong.",
      { code: "TYPE_CHANGED", attribute: "type" }
    );
  }
}

/** Add the project link to the body's links; the move link always wins. */
function addMoveLink(body, move) {
  body._links = { ...body._links, project: move.link };
}

/**
 * moved / children / childrenNote for the result of a move. Never throws on
 * a child it cannot read (readChild reports it as unknown), so a move that
 * was applied is never reported as a failure here.
 */
async function moveReport(request, result, move) {
  // move.target was resolved before the PATCH and assertMoveLanded has confirmed the work package is there.
  const out = { moved: { from: move.from, to: { ...move.target } } };
  const { report: children, unread, unchecked } = await childrenAfterMove(request, result, move);
  if (!children) return out;
  out.children = children;
  const note = childrenNote(children, unread, unchecked, move.target);
  if (note) out.childrenNote = note;
  return out;
}

async function commentResult(request, id, args) {
  try {
    const posted = await postComment(request, id, args.comment, args.notify);
    return { commentId: posted.activityId };
  } catch (error) {
    return { comment: { error: "The update succeeded but the comment was not posted: " + opMessage(error) } };
  }
}

/** PATCH the body and check that what was asked for took. Returns {result, retried}. */
async function writeChanges(request, id, body, args, { status, planned, move }) {
  const written = await patchWithRetry(request, id, wpHref(id), body, args, planned?.current);
  if (status) assertStatusApplied(written.result, status);
  if (move) assertMoveLanded(written.result, move, args.comment !== undefined);
  return written;
}

export async function updateWorkPackage(request, args, options = {}, label = "update_work_package") {
  const id = pickWpId(args, label);
  const lookups = createLookups(request);
  const { body, status } = await buildFieldBody(args, lookups);
  const planned = await planMove(request, lookups, id, args);
  if (planned?.typeError && !planned.same) throw planned.typeError;
  const move = planned && !planned.same ? planned : null;
  if (move) addMoveLink(body, move);
  const hasChanges = Object.keys(body).length > 0;
  if (!hasChanges && args.comment === undefined && !planned) {
    throw new Error(label + ": nothing to update. Pass at least one field or a comment.");
  }

  const { result, retried } = hasChanges
    ? await writeChanges(request, id, body, args, { status, planned, move })
    : { result: planned?.current || (await request(wpHref(id))), retried: false };

  const out = {
    ...summarizeWorkPackage(result, options.baseUrl),
    assignee: linkRef(result._links?.assignee),
    percentageDone: orNull(result.percentageDone),
    startDate: orNull(result.startDate),
    dueDate: orNull(result.dueDate),
    retried,
  };
  if (move) Object.assign(out, await moveReport(request, result, move));
  else if (planned) {
    out.projectNote =
      "Already in project " + planned.target.name + "; not moved." + (hasChanges ? " The other changes in this call were applied." : "");
  }
  if (args.comment !== undefined) Object.assign(out, await commentResult(request, id, args));
  return out;
}

export async function validateUpdate(request, args) {
  const id = pickWpId(args, "validate_update");
  const lookups = createLookups(request);
  const { body } = await buildFieldBody(args, lookups);
  const planned = await planMove(request, lookups, id, args);
  if (planned?.typeError && !planned.same) {
    return {
      valid: false,
      errors: [{ attribute: "type", code: planned.typeError.code, message: planned.typeError.message.replace(/^Not moved: (\w)/, (_, c) => c.toUpperCase()) }],
      allowedStatuses: [],
      allowedTypes: planned.typeError.allowedTypes,
      resulting: { startDate: null, dueDate: null, derivedStartDate: null, derivedDueDate: null },
    };
  }
  if (planned && !planned.same) addMoveLink(body, planned);
  let lockVersion;
  if (args.lockVersion !== undefined) lockVersion = Number(args.lockVersion);
  else lockVersion = (planned?.current || (await request(wpHref(id)))).lockVersion;
  const form = await postForm(request, id, { ...body, lockVersion });
  const payload = form?._embedded?.payload || {};
  const errors = formErrors(form);
  const pick = (key) => (payload[key] !== undefined ? payload[key] : null);
  return {
    valid: errors.length === 0,
    errors,
    allowedStatuses: allowedFromForm(form),
    resulting: {
      startDate: pick("startDate"),
      dueDate: pick("dueDate"),
      derivedStartDate: pick("derivedStartDate"),
      derivedDueDate: pick("derivedDueDate"),
    },
  };
}

export async function getWorkPackage(request, args, options = {}) {
  const id = pickWpId(args, "get_work_package");
  const wp = await request(wpHref(id));
  const out = describeWorkPackage(wp, options.baseUrl);
  const wanted = args.includeComments !== undefined ? Math.floor(Number(args.includeComments) || 0) : 0;
  if (wanted > 0) {
    const activities = await listActivities(request, id, {
      limit: Math.min(MAX_COMMENTS, wanted),
      order: "desc",
      commentsOnly: true,
    });
    out.comments = activities.elements;
  }
  return out;
}

/**
 * parentId: null is the one null that means something: remove the parent.
 * Every other null is "absent" (checkArgs drops it). Folded into clear.
 */
function nullParentToClear(tool, rawArgs, args) {
  if (!tool.inputSchema.properties.clear || rawArgs?.parentId !== null) return args;
  const clear = [];
  if (Array.isArray(args.clear)) clear.push(...args.clear);
  else if (args.clear !== undefined) clear.push(args.clear);
  if (!clear.includes("parentId")) clear.push("parentId");
  return { ...args, clear };
}

export async function handleWpUpdateTool(name, rawArgs, request, options = {}) {
  const tool = TOOL[name];
  if (!tool) return undefined;
  const args = nullParentToClear(tool, rawArgs, checkArgs(tool, rawArgs));
  switch (name) {
    case "get_work_package":
      return getWorkPackage(request, args, options);
    case "update_work_package":
      return updateWorkPackage(request, args, options);
    case "set_status": {
      if (args.status === undefined && args.statusId === undefined) {
        throw new Error("set_status: status or statusId is required");
      }
      return updateWorkPackage(request, args, options, "set_status");
    }
    case "validate_update":
      return validateUpdate(request, args);
    default:
      return undefined;
  }
}
