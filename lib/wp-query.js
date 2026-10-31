/**
 * Work-package queries and creation: list_work_packages (filters, search,
 * pagination, field selection), create_work_package, create_work_packages.
 */
import { collectionElements } from "./api.js";
import { createLookups } from "./lookups.js";
import { FIELD_PROPERTIES, buildFieldBody } from "./wp-update.js";
import { summarizeWorkPackage, wpParentId } from "./wp-compact.js";
import { seg } from "./path.js";
import {
  checkArgs,
  filtersParam,
  linkRef,
  opAttributes,
  opMessage,
  parseId,
  projectSegment,
  requireArg,
  withNotify,
  wrapOpError,
} from "./tool-args.js";

const DEFAULT_PAGE_SIZE = 100;
const DEDUPE_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

/** field → select= key. Fields mapped to null cannot be selected (OpenProject answers 400). */
const LIST_FIELDS = {
  id: "elements/id",
  subject: "elements/subject",
  status: "elements/status",
  type: "elements/type",
  assignee: "elements/assignee",
  parentId: "elements/parent",
  project: "elements/project",
  priority: "elements/priority",
  version: "elements/version",
  startDate: "elements/startDate",
  dueDate: "elements/dueDate",
  percentageDone: null,
  updatedAt: null,
  lockVersion: null,
};
const DEFAULT_FIELDS = ["id", "subject", "status", "type", "assignee", "parentId"];
const LINK_FIELDS = ["status", "type", "assignee", "project", "priority", "version"];

const LIST_PROPERTIES = {
  projectId: { type: "string", description: "Project id or identifier (omit for all projects); a number is accepted too" },
  ids: { type: "array", items: { type: "number" }, description: "Only these work package ids" },
  parentId: { type: "number", description: "Children of this work package" },
  assigneeId: { type: "string", description: 'Assignee user id, login, or "me"; a number is accepted too' },
  status: {
    type: "string",
    description:
      'Status id or name, or "open", "closed", "all"; a number is accepted too. With no filter at all OpenProject lists open work packages only.',
  },
  type: { type: "string", description: "Type id or name (resolved in projectId's types when given); a number is accepted too" },
  search: { type: "string", description: "Full-text search over subject, description and comments" },
  subject: { type: "string", description: "Subject contains this text" },
  sortBy: { type: "string", description: 'Sort, e.g. "updatedAt:desc" or "id:asc,subject:desc"' },
  pageSize: { type: "number", description: "Results per page (default 100, max 500)", default: DEFAULT_PAGE_SIZE },
  offset: { type: "number", description: "Page number, 1-based (OpenProject semantics; default 1)", default: 1 },
  fields: {
    type: "array",
    items: { type: "string", enum: Object.keys(LIST_FIELDS) },
    description: "Fields per element (id is always included). Default: " + DEFAULT_FIELDS.join(", "),
  },
};

const CREATE_FIELDS = {
  ...FIELD_PROPERTIES,
  type: { type: "string", description: "Type id or name; a number is accepted too. Default: the first type the project allows" },
  typeId: { type: "number", description: "Type id (legacy; prefer type)" },
};
delete CREATE_FIELDS.statusId;

const ITEM_PROPERTIES = {
  ...CREATE_FIELDS,
  parentIndex: { type: "number", description: "Index of an earlier item in this batch to use as the parent" },
};

const CREATE_RESULT =
  "Returns {id, subject, status:{id,name}, type:{id,name}, project:{id,identifier?,name}, parentId, lockVersion, updatedAt, url}.";

export const WP_QUERY_TOOLS = [
  {
    name: "list_work_packages",
    description:
      "Find work packages: by ids, project, parent, assignee, status (name, open/closed/all), type, full-text search, or subject text, " +
      "with sorting and paging. Use this for any lookup or search (there is no separate search tool; raw_api_call is a last resort). Unknown arguments are refused. " +
      "Returns {total, offset, pageSize, hasMore, elements:[{id, subject, status:{id,name}, ...fields}]}; ask for the next page with offset+1.",
    inputSchema: { type: "object", additionalProperties: false, properties: LIST_PROPERTIES },
  },
  {
    name: "create_work_package",
    description:
      "Create one work package. type and status can be names; type defaults to the first type the project allows, " +
      "and a type the project refuses is reported with the allowed list. For several at once use create_work_packages. " +
      CREATE_RESULT,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", description: "Project id or identifier; a number is accepted too" },
        ...CREATE_FIELDS,
        notify: { type: "boolean", description: "Send notifications (default true)", default: true },
      },
      required: ["projectId", "subject"],
    },
  },
  {
    name: "create_work_packages",
    description:
      "Create many work packages in one project, in order. Each item takes the create_work_package fields, plus parentIndex to " +
      "parent it under an earlier item of the same batch. Never all-or-nothing: returns {created:[{index,id}], existing:[{index,id}], " +
      "failed:[{index,error}]}. dedupeBy:\"subject\" reports an existing work package with the same subject and parent instead of " +
      "creating a duplicate (safe to re-run). Notifications are off unless notify:true.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", description: "Project id or identifier; a number is accepted too" },
        items: {
          type: "array",
          items: { type: "object", additionalProperties: false, properties: ITEM_PROPERTIES, required: ["subject"] },
          description: "Work packages to create",
        },
        dedupeBy: { type: "string", enum: ["subject"], description: "Skip items whose subject+parent already exists" },
        notify: { type: "boolean", description: "Send notifications (default false for bulk)", default: false },
      },
      required: ["projectId", "items"],
    },
  },
];

const TOOL = Object.fromEntries(WP_QUERY_TOOLS.map((tool) => [tool.name, tool]));
const ITEM_TOOL = { name: "item", inputSchema: { properties: ITEM_PROPERTIES } };

function isIdLike(value) {
  return typeof value === "number" || /^#?\d+$/.test(String(value).trim());
}

function parseSort(sortBy) {
  return String(sortBy)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [field, dirRaw] = part.split(":");
      const dir = (dirRaw || "asc").toLowerCase();
      if (!field || (dir !== "asc" && dir !== "desc")) {
        throw new Error('sortBy must look like "updatedAt:desc", got ' + JSON.stringify(sortBy));
      }
      return [field, dir];
    });
}

async function statusFilter(lookups, status) {
  const word = String(status).trim().toLowerCase();
  if (word === "open") return { status: { operator: "o", values: [] } };
  if (word === "closed") return { status: { operator: "c", values: [] } };
  if (word === "all" || word === "*") return { status: { operator: "*", values: [] } };
  const refs = Array.isArray(status) ? status : [status];
  const ids = [];
  for (const ref of refs) ids.push(String((await lookups.resolveStatus(ref)).id));
  return { status: { operator: "=", values: ids } };
}

function pickFields(fields) {
  if (fields === undefined) return DEFAULT_FIELDS;
  const list = Array.isArray(fields) ? fields : String(fields).split(",").map((f) => f.trim());
  for (const field of list) {
    if (!Object.prototype.hasOwnProperty.call(LIST_FIELDS, field)) {
      throw new Error('Unknown field "' + field + '". Fields: ' + Object.keys(LIST_FIELDS).join(", "));
    }
  }
  return ["id", ...list.filter((field) => field !== "id")];
}

function elementFields(wp, fields) {
  const out = {};
  for (const field of fields) {
    if (field === "parentId") out.parentId = wpParentId(wp);
    else if (LINK_FIELDS.includes(field)) out[field] = linkRef(wp._links && wp._links[field]);
    else out[field] = wp[field] !== undefined ? wp[field] : null;
  }
  return out;
}

/** The filters= array for list_work_packages, in argument order. */
async function listFilters(args, lookups) {
  const filters = [];
  if (args.ids !== undefined) {
    const ids = (Array.isArray(args.ids) ? args.ids : [args.ids]).map((id) => String(parseId(id, "ids")));
    filters.push({ id: { operator: "=", values: ids } });
  }
  if (args.parentId !== undefined) {
    filters.push({ parent: { operator: "=", values: [String(parseId(args.parentId, "parentId"))] } });
  }
  if (args.assigneeId !== undefined) {
    const who = await lookups.resolveUser(args.assigneeId);
    filters.push({ assignee: { operator: "=", values: [String(who)] } });
  }
  if (args.status !== undefined) filters.push(await statusFilter(lookups, args.status));
  if (args.type !== undefined) {
    const typeId = isIdLike(args.type)
      ? parseId(args.type, "type")
      : (await lookups.resolveType(args.projectId ?? null, args.type)).id;
    filters.push({ type: { operator: "=", values: [String(typeId)] } });
  }
  if (args.search !== undefined) filters.push({ search: { operator: "**", values: [String(args.search)] } });
  if (args.subject !== undefined) filters.push({ subject: { operator: "~", values: [String(args.subject)] } });
  return filters;
}

function listParams(args, filters, fields, pageSize, offset) {
  const params = new URLSearchParams();
  params.set("pageSize", String(pageSize));
  if (args.offset !== undefined) params.set("offset", String(offset));
  if (filters.length) params.set("filters", filtersParam(filters));
  if (args.sortBy !== undefined) params.set("sortBy", JSON.stringify(parseSort(args.sortBy)));
  if (fields.every((field) => LIST_FIELDS[field])) {
    params.set("select", ["total", "count", "pageSize", "offset", ...fields.map((f) => LIST_FIELDS[f])].join(","));
  }
  return params;
}

export async function listWorkPackages(request, args) {
  const endpoint =
    args.projectId === undefined
      ? "/api/v3/work_packages"
      : "/api/v3/projects/" + projectSegment(args.projectId) + "/work_packages";
  const fields = pickFields(args.fields);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(Number(args.pageSize) || DEFAULT_PAGE_SIZE)));
  const offset = args.offset === undefined ? 1 : Math.max(1, Math.floor(Number(args.offset) || 1));
  const filters = await listFilters(args, createLookups(request));
  const params = listParams(args, filters, fields, pageSize, offset);

  const payload = (await request(endpoint + "?" + params.toString())) || {};
  const elements = collectionElements(payload);
  const total = payload.total ?? elements.length;
  const gotOffset = payload.offset ?? offset;
  const gotPageSize = payload.pageSize ?? pageSize;
  return {
    total,
    offset: gotOffset,
    pageSize: gotPageSize,
    hasMore: gotOffset * gotPageSize < total,
    elements: elements.map((wp) => elementFields(wp, fields)),
  };
}

async function createOne(request, lookups, projectRef, fields, notify, baseUrl) {
  const projectPath = "/api/v3/projects/" + projectSegment(projectRef, "projectId") + "/work_packages";
  requireArg(fields, "subject");
  const { body } = await buildFieldBody(fields, lookups, { projectRef, allowClear: false });
  body._links = body._links || {};
  if (!body._links.type) {
    const types = await lookups.projectTypes(projectRef);
    if (!types.length) throw new Error("Project " + projectRef + " allows no work package types");
    body._links.type = { href: "/api/v3/types/" + seg(types[0].id, "id") };
  }
  let created;
  try {
    created = await request(withNotify(projectPath, notify), "POST", body);
  } catch (error) {
    throw await createError(error, lookups, projectRef);
  }
  return summarizeWorkPackage(created, baseUrl, projectRef);
}

/** The error for a refused create; a type 422 lists the project's types (allowedTypes). */
async function createError(error, lookups, projectRef) {
  const status = error?.status;
  if (!status) return error;
  const message = opMessage(error);
  const aboutType = opAttributes(error).includes("type") || /\btype\b/i.test(message);
  if (status !== 422 || !aboutType) {
    return wrapOpError(error, "OpenProject refused the create (" + status + "): " + message);
  }
  let allowedTypes = [];
  try {
    allowedTypes = await lookups.projectTypes(projectRef);
  } catch {
    allowedTypes = [];
  }
  const allowed = allowedTypes.map((t) => t.name + " (" + t.id + ")").join(", ");
  return wrapOpError(
    error,
    "OpenProject refused the create (422): " + message + (allowed ? " Types this project allows: " + allowed + "." : ""),
    { code: "TYPE_NOT_ALLOWED", allowedTypes }
  );
}

/**
 * An existing work package with exactly this subject and parent, in the
 * project itself (not its subprojects), or null. OpenProject's subject filter
 * only knows "~" (contains), so the exact subject - and, without a parent
 * filter, the parent - are checked here.
 */
async function findExisting(request, lookups, projectRef, subject, parentId) {
  const project = await lookups.project(projectRef);
  const filters = [
    { project: { operator: "=", values: [String(project.id)] } },
    { subject: { operator: "~", values: [String(subject)] } },
  ];
  if (parentId != null) filters.push({ parent: { operator: "=", values: [String(parentId)] } });
  filters.push({ status: { operator: "*", values: [] } });
  const wantParent = parentId != null ? Number(parentId) : null;
  for (let offset = 1; ; offset++) {
    const params = new URLSearchParams();
    params.set("pageSize", String(DEDUPE_PAGE_SIZE));
    if (offset > 1) params.set("offset", String(offset));
    params.set("filters", filtersParam(filters));
    const payload = await request("/api/v3/work_packages?" + params.toString());
    const elements = collectionElements(payload);
    const match = elements.find((wp) => wp.subject === subject && wpParentId(wp) === wantParent);
    if (match) return match;
    const total = payload && payload.total !== undefined ? Number(payload.total) : elements.length;
    if (!elements.length || offset * DEDUPE_PAGE_SIZE >= total) return null;
  }
}

/** The parent id an item's parentIndex points at (an earlier, created item). */
function parentFromIndex(parentIndex, fields, index, ids) {
  if (fields.parentId !== undefined) throw new Error("pass parentId or parentIndex, not both");
  const at = Number(parentIndex);
  if (!Number.isInteger(at) || at < 0 || at >= index) {
    throw new Error("parentIndex " + parentIndex + " must point at an earlier item");
  }
  if (!ids.has(at)) throw new Error("parentIndex " + at + " did not produce a work package");
  return ids.get(at);
}

/** Create (or, with dedupeBy, find) one batch item. Returns {kind, id}. */
async function createItem(ctx, rawItem, index) {
  const { request, lookups, args, ids, notify, baseUrl } = ctx;
  const { parentIndex, ...fields } = checkArgs(ITEM_TOOL, rawItem, "items[" + index + "]");
  if (parentIndex !== undefined) fields.parentId = parentFromIndex(parentIndex, fields, index, ids);
  if (args.dedupeBy === "subject") {
    requireArg(fields, "subject");
    const parent = fields.parentId === undefined ? null : parseId(fields.parentId, "parentId");
    const found = await findExisting(request, lookups, args.projectId, fields.subject, parent);
    if (found) return { kind: "existing", id: found.id };
  }
  const created = await createOne(request, lookups, args.projectId, fields, notify, baseUrl);
  return { kind: "created", id: created.id };
}

export async function createWorkPackages(request, args, baseUrl) {
  projectSegment(args.projectId, "projectId");
  if (!Array.isArray(args.items) || !args.items.length) throw new Error("create_work_packages: items must be a non-empty array");
  if (args.dedupeBy !== undefined && args.dedupeBy !== "subject") throw new Error('dedupeBy must be "subject"');
  const ctx = { request, args, baseUrl, lookups: createLookups(request), ids: new Map(), notify: args.notify ?? false };
  const out = { created: [], existing: [], failed: [] };
  for (let index = 0; index < args.items.length; index++) {
    try {
      const { kind, id } = await createItem(ctx, args.items[index], index);
      ctx.ids.set(index, id);
      out[kind].push({ index, id });
    } catch (error) {
      out.failed.push({ index, error: error.message });
    }
  }
  return out;
}

export async function handleWpQueryTool(name, rawArgs, request, options = {}) {
  const tool = TOOL[name];
  if (!tool) return undefined;
  const args = checkArgs(tool, rawArgs);
  switch (name) {
    case "list_work_packages":
      return listWorkPackages(request, args);
    case "create_work_package": {
      requireArg(args, "projectId", name);
      const { projectId, notify, ...fields } = args;
      return createOne(request, createLookups(request), projectId, fields, notify, options.baseUrl);
    }
    case "create_work_packages":
      requireArg(args, "projectId", name);
      return createWorkPackages(request, args, options.baseUrl);
    default:
      return undefined;
  }
}
