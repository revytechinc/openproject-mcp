/**
 * Work-package read and write: get_work_package, update_work_package,
 * set_status, validate_update. Unknown arguments are refused; status is
 * resolved by name; 409s are retried only when safe; a 422 on a status
 * change reports the statuses the workflow allows.
 */
import { wpHref } from "./api.js";
import { createLookups } from "./lookups.js";
import { seg } from "./path.js";
import { listActivities, pickWpId, postComment } from "./comments.js";
import { describeWorkPackage, summarizeWorkPackage } from "./wp-compact.js";
import {
  checkArgs,
  duration,
  idFromHref,
  linkRef,
  opMessage,
  parseId,
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
  parentId: { type: "number", description: "Parent work package id (to remove the parent use clear: [\"parentId\"])" },
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
      "Change fields on a work package and optionally comment, in one call. Use this for any edit instead of raw_api_call (a last resort) (status by name, dates, %, parent, assignee, ...). " +
      "Unknown argument names are refused. lockVersion is read for you; a 409 is retried once if none of the fields you write changed meanwhile. " +
      "A refused status transition (422) lists the statuses you may move to. The comment is posted after the PATCH; if only the comment fails, " +
      "the update still succeeds and comment.error says why (do not redo the update). Check first with validate_update if unsure. " +
      RESULT_NOTE,
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
async function patchWithRetry(request, id, path, body, args) {
  const explicitLock = args.lockVersion !== undefined;
  const current = explicitLock ? null : await request(path);
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

export async function updateWorkPackage(request, args, options = {}, label = "update_work_package") {
  const id = pickWpId(args, label);
  const lookups = createLookups(request);
  const { body, status } = await buildFieldBody(args, lookups);
  const hasChanges = Object.keys(body).length > 0;
  if (!hasChanges && args.comment === undefined) {
    throw new Error(label + ": nothing to update. Pass at least one field or a comment.");
  }

  const path = wpHref(id);
  let result;
  let retried = false;
  if (hasChanges) {
    ({ result, retried } = await patchWithRetry(request, id, path, body, args));
    if (status) assertStatusApplied(result, status);
  } else {
    result = await request(path);
  }

  const out = {
    ...summarizeWorkPackage(result, options.baseUrl),
    assignee: linkRef(result._links && result._links.assignee),
    percentageDone: orNull(result.percentageDone),
    startDate: orNull(result.startDate),
    dueDate: orNull(result.dueDate),
    retried,
  };
  if (args.comment !== undefined) {
    try {
      const posted = await postComment(request, id, args.comment, args.notify);
      out.commentId = posted.activityId;
    } catch (error) {
      out.comment = { error: "The update succeeded but the comment was not posted: " + opMessage(error) };
    }
  }
  return out;
}

export async function validateUpdate(request, args) {
  const id = pickWpId(args, "validate_update");
  const lookups = createLookups(request);
  const { body } = await buildFieldBody(args, lookups);
  const lockVersion =
    args.lockVersion !== undefined ? Number(args.lockVersion) : (await request(wpHref(id))).lockVersion;
  const form = await postForm(request, id, { ...body, lockVersion });
  const payload = (form && form._embedded && form._embedded.payload) || {};
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

export async function handleWpUpdateTool(name, rawArgs, request, options = {}) {
  const tool = TOOL[name];
  if (!tool) return undefined;
  const args = checkArgs(tool, rawArgs);
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
