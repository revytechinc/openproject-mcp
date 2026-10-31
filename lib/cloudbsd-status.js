import { collectionElements, findInPages, hrefId, wpHref } from "./api.js";
import { seg } from "./path.js";
import { createLookups, resolvePreferredType, resolveStatusByName } from "./lookups.js";

export const CLOUDBSD_PROJECT_IDENTIFIER = "cloudbsd";

const LANE_PAGE_SIZE = 100;

export const STATUS_LANES = [
  "Desktop",
  "HackMiami",
  "Server",
  "Wayfire",
  "Ports-InternalPkg",
  "Product-Media",
  "CI-Jenkins",
  "Networking",
  "Status",
];

export const RELATION_TYPES = ["relates", "blocks", "precedes"];

export const RELATION_REVERSE = {
  relates: "relates",
  blocks: "blocked",
  blocked: "blocks",
  precedes: "follows",
  follows: "precedes",
};

export const CUSTOM_FIELD_NAMES = {
  direction: "direction",
  jenkins_job: "jenkins_job",
  jenkins_number: "jenkins_number",
  jenkins_url: "jenkins_url",
};

export const CLOUDBSD_STATUS_TOOLS = [
  {
    name: "status_upsert",
    description:
      "Create or update a CloudBSD status.cloudbsd.org work package on the trackdev write path. " +
      "Identity is component/lane (Desktop|HackMiami|Server|Wayfire|Ports-InternalPkg|Product-Media|CI-Jenkins|Networking|Status) " +
      "or an existing work package id. Writes done/next into the description and optional direction plus jenkins_* custom fields.",
    inputSchema: {
      type: "object",
      properties: {
        component: {
          type: "string",
          description:
            "Status component/lane. One of: Desktop, HackMiami, Server, Wayfire, Ports-InternalPkg, Product-Media, CI-Jenkins, Networking, Status",
        },
        lane: {
          type: "string",
          description: "Alias for component",
        },
        projectId: {
          type: "string",
          description:
            "OpenProject project id or identifier. Defaults to cloudbsd.",
        },
        id: {
          type: "number",
          description: "Existing work package id to update",
        },
        workPackageId: {
          type: "number",
          description: "Alias for id",
        },
        subject: {
          type: "string",
          description: "Override work package subject (defaults to the lane name)",
        },
        done: {
          description: "What was completed (string or list of strings)",
        },
        next: {
          description: "What is next (string or list of strings)",
        },
        direction: {
          type: "string",
          description: "Direction custom field value",
        },
        status: {
          type: "string",
          description: "OpenProject status name (New, In progress, Blocked, Done)",
        },
        type: {
          type: "string",
          description: "Work package type name when creating (default Ops)",
        },
        jenkins_job: {
          type: "string",
          description: "Optional Jenkins job custom field",
        },
        jenkins_number: {
          description: "Optional Jenkins build number custom field",
        },
        jenkins_url: {
          type: "string",
          description: "Optional Jenkins build URL custom field",
        },
      },
    },
  },
  {
    name: "build_annotate",
    description:
      "Attach or update Jenkins build annotation custom fields (jenkins_job, jenkins_number, jenkins_url) on a work package. " +
      "workPackageId (or its alias id) is required.",
    inputSchema: {
      type: "object",
      properties: {
        workPackageId: {
          type: "number",
          description: "Work package ID to annotate",
        },
        id: {
          type: "number",
          description: "Alias for workPackageId",
        },
        jenkins_job: {
          type: "string",
          description: "Jenkins job name",
        },
        jenkins_number: {
          description: "Jenkins build number",
        },
        jenkins_url: {
          type: "string",
          description: "Jenkins build URL",
        },
      },
      // No "required": workPackageId may arrive as its alias id; the handler checks.
    },
  },
  {
    name: "relation_upsert",
    description:
      "Create or ensure a native OpenProject relation for the CloudBSD status node map. " +
      "Types: relates, blocks, precedes. relates_to is accepted as an alias for relates. " +
      "Idempotent when the same edge already exists (including the reverse representation). " +
      "fromId (alias from) and toId (alias to) are required.",
    inputSchema: {
      type: "object",
      properties: {
        fromId: {
          type: "number",
          description: "Source work package ID",
        },
        toId: {
          type: "number",
          description: "Target work package ID",
        },
        from: {
          type: "number",
          description: "Alias for fromId",
        },
        to: {
          type: "number",
          description: "Alias for toId",
        },
        type: {
          type: "string",
          description: "Relation type: relates, blocks, precedes (relates_to aliases relates)",
        },
        description: {
          type: "string",
          description: "Optional relation description",
        },
      },
      // fromId/toId may arrive as their aliases from/to; the handler checks.
      required: ["type"],
    },
  },
];

export function normalizeLane(value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const found = STATUS_LANES.find(
    (lane) => lane.toLowerCase() === raw.toLowerCase()
  );
  if (found) return found;
  throw new Error(
    "Unknown component/lane: " +
      value +
      ". Expected one of: " +
      STATUS_LANES.join(", ")
  );
}

export function resolveLaneArg(args) {
  return normalizeLane(args.component || args.lane);
}

export function normalizeMultiline(value) {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const text = String(item);
        return text.startsWith("- ") || text.startsWith("* ")
          ? text
          : "- " + text;
      })
      .join("\n");
  }
  return String(value);
}

export function parseStatusDescription(raw) {
  const text = raw == null ? "" : String(raw);
  const buckets = { extra: [], done: [], next: [] };
  let current = "extra";

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^##\s+(Done|Next)\s*$/i);
    if (match) {
      current = match[1].toLowerCase();
      continue;
    }
    buckets[current].push(line);
  }

  return {
    done: buckets.done.join("\n").trim(),
    next: buckets.next.join("\n").trim(),
    extra: buckets.extra.join("\n").trim(),
  };
}

export function renderStatusDescription(sections) {
  const parts = [];
  if (sections.extra) parts.push(sections.extra);
  if (sections.done) parts.push("## Done\n\n" + sections.done);
  if (sections.next) parts.push("## Next\n\n" + sections.next);
  return parts.join("\n\n").trim();
}

export function mergeStatusDescription(existingRaw, fields) {
  const parsed = parseStatusDescription(existingRaw || "");
  if (Object.prototype.hasOwnProperty.call(fields, "done") && fields.done !== undefined) {
    parsed.done = normalizeMultiline(fields.done) || "";
  }
  if (Object.prototype.hasOwnProperty.call(fields, "next") && fields.next !== undefined) {
    parsed.next = normalizeMultiline(fields.next) || "";
  }
  return renderStatusDescription(parsed);
}

export function normalizeFieldKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function extractCustomFieldMap(schema) {
  const map = {};
  if (!schema || typeof schema !== "object") return map;

  for (const [key, def] of Object.entries(schema)) {
    if (!key.startsWith("customField") || !def || typeof def !== "object") {
      continue;
    }
    const name = def.name || def.title;
    if (!name) continue;
    map[normalizeFieldKey(name)] = {
      key,
      name,
      type: def.type || def._type || "String",
      writable: def.writable !== false,
    };
  }
  return map;
}

export function formatCustomFieldValue(field, value) {
  if (value == null) return value;
  const type = String(field.type || "String");
  if (type === "Integer") return Number(value);
  if (type === "Float") return Number(value);
  if (type === "Boolean") {
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  }
  if (type === "Text" || type === "Formattable") {
    return { format: "markdown", raw: String(value) };
  }
  return String(value);
}

export function applyCustomFieldValues(target, fieldMap, values) {
  const applied = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const field = fieldMap[normalizeFieldKey(name)];
    if (!field) {
      throw new Error(
        "Custom field not found: " +
          name +
          ". Available: " +
          (Object.values(fieldMap).map((item) => item.name).join(", ") || "(none)")
      );
    }
    target[field.key] = formatCustomFieldValue(field, value);
    applied[name] = value;
  }
  return applied;
}

export function normalizeRelationType(type) {
  if (type == null || type === "") {
    throw new Error("type is required");
  }
  const raw = String(type).trim().toLowerCase().replace(/[-\s]/g, "_");
  if (raw === "relates_to" || raw === "relatesto" || raw === "relate") {
    return "relates";
  }
  if (RELATION_TYPES.includes(raw)) return raw;
  throw new Error(
    "Unsupported relation type: " +
      type +
      ". Use relates, blocks, or precedes (relates_to is accepted as relates)."
  );
}

export function isSameRelationEdge(relation, fromId, toId, type) {
  const from = hrefId(relation && relation._links && relation._links.from && relation._links.from.href);
  const to = hrefId(relation && relation._links && relation._links.to && relation._links.to.href);
  const relType = relation && relation.type;
  const reverseType = relation && relation.reverseType;
  const wantFrom = String(fromId);
  const wantTo = String(toId);

  if (from === wantFrom && to === wantTo && relType === type) return true;
  if (from === wantTo && to === wantFrom && reverseType === type) return true;
  if (from === wantTo && to === wantFrom && relType === RELATION_REVERSE[type]) {
    return true;
  }
  if (type === "relates" && relType === "relates") {
    return (
      (from === wantFrom && to === wantTo) ||
      (from === wantTo && to === wantFrom)
    );
  }
  return false;
}

function pickWorkPackageId(args) {
  const value = args.workPackageId != null ? args.workPackageId : args.id;
  return value == null ? null : value;
}

function pickProjectId(args) {
  return args.projectId || args.project || CLOUDBSD_PROJECT_IDENTIFIER;
}

async function getProject(request, projectId) {
  const project = await request("/api/v3/projects/" + seg(projectId, "project"));
  return {
    id: project.id,
    identifier: project.identifier,
    name: project.name,
  };
}

async function listNamedCollection(request, endpoint) {
  const page = await request(endpoint);
  return collectionElements(page);
}

async function resolveCategory(request, projectId, lane) {
  if (!lane) return null;
  let categories = [];
  try {
    categories = await listNamedCollection(
      request,
      "/api/v3/projects/" + seg(projectId, "project") + "/categories"
    );
  } catch {
    categories = [];
  }
  return (
    categories.find(
      (item) => String(item.name).toLowerCase() === String(lane).toLowerCase()
    ) || null
  );
}

async function getSchema(request, { workPackage, projectNumericId, typeId }) {
  if (workPackage && workPackage._links && workPackage._links.schema && workPackage._links.schema.href) {
    return request(workPackage._links.schema.href);
  }
  if (projectNumericId && typeId) {
    try {
      return await request(
        "/api/v3/work_packages/schemas/" + seg(projectNumericId, "id") + "-" + seg(typeId, "id")
      );
    } catch {
      const form = await request(
        "/api/v3/projects/" + seg(projectNumericId, "id") + "/work_packages/form",
        "POST",
        { _links: { type: { href: "/api/v3/types/" + seg(typeId, "id") } } }
      );
      if (form && form._embedded && form._embedded.schema) {
        return form._embedded.schema;
      }
    }
  }
  return {};
}

function readCustomFieldValue(workPackage, field) {
  if (!workPackage || !field) return null;
  const value = workPackage[field.key];
  if (value && typeof value === "object") {
    return value.raw != null ? value.raw : value.href || null;
  }
  return value == null ? null : value;
}

function summarizeWorkPackage(workPackage, extras = {}) {
  return {
    id: workPackage.id,
    subject: workPackage.subject,
    status:
      workPackage._links && workPackage._links.status
        ? workPackage._links.status.title
        : null,
    type:
      workPackage._links && workPackage._links.type
        ? workPackage._links.type.title
        : null,
    category:
      workPackage._links && workPackage._links.category
        ? workPackage._links.category.title
        : extras.category || null,
    lockVersion: workPackage.lockVersion,
    ...extras,
  };
}

function subjectCandidates(lane) {
  return [lane, "Status: " + lane, lane + " status"];
}

function subjectMatchesLane(subject, lane) {
  const value = String(subject || "").trim().toLowerCase();
  return subjectCandidates(lane).some((item) => item.toLowerCase() === value);
}

/**
 * The lane's work package in the project itself (not its subprojects): the
 * global collection with a project filter, every page of each search.
 * OpenProject's subject filter only knows "~" (contains), "!~", "*", "!*":
 * a subject search is "~" and only an exact lane subject counts. A category
 * search may fall back to the category's first work package.
 */
async function findStatusWorkPackage(request, { projectNumericId, lane, category }) {
  const inProject = { project: { operator: "=", values: [String(projectNumericId)] } };
  const searches = [];
  if (category) {
    searches.push({ exactOnly: false, filter: { category: { operator: "=", values: [String(category.id)] } } });
  }
  for (const subject of subjectCandidates(lane)) {
    searches.push({ exactOnly: true, filter: { subject: { operator: "~", values: [subject] } } });
  }

  for (const { exactOnly, filter } of searches) {
    const { match, first } = await findInPages(
      request,
      "/api/v3/work_packages",
      { filters: JSON.stringify([inProject, filter]) },
      LANE_PAGE_SIZE,
      (wp) => subjectMatchesLane(wp.subject, lane)
    );
    if (match) return match;
    if (!exactOnly && first) return first;
  }
  return null;
}

function jenkinsValuesFromArgs(args) {
  return {
    jenkins_job: args.jenkins_job,
    jenkins_number: args.jenkins_number,
    jenkins_url: args.jenkins_url,
  };
}

function customFieldResults(workPackage, fieldMap, names) {
  const out = {};
  for (const name of names) out[name] = readCustomFieldValue(workPackage, fieldMap[normalizeFieldKey(name)]);
  return out;
}

/** The PATCH/POST body for status_upsert (without lockVersion or type). */
function statusBody(args, { workPackage, lane, status, category, fieldMap }) {
  const existingRaw = workPackage?.description?.raw || "";
  const writeDescription = args.done !== undefined || args.next !== undefined || !workPackage;
  const body = { _links: {} };
  if (args.subject) body.subject = args.subject;
  else if (!workPackage) body.subject = lane;
  if (writeDescription) {
    body.description = {
      format: "markdown",
      raw: mergeStatusDescription(existingRaw, { done: args.done, next: args.next }),
    };
  }
  if (status) body._links.status = { href: "/api/v3/statuses/" + seg(status.id, "id") };
  if (category) body._links.category = { href: "/api/v3/categories/" + seg(category.id, "id") };
  const cfValues = {};
  if (args.direction !== undefined) cfValues.direction = args.direction;
  Object.assign(cfValues, jenkinsValuesFromArgs(args));
  applyCustomFieldValues(body, fieldMap, cfValues);
  return body;
}

/** PATCH the found work package, or create one in the project. */
async function writeStatusWorkPackage(request, body, { workPackage, project, type }) {
  if (workPackage) {
    if (!Object.keys(body._links).length) delete body._links;
    body.lockVersion = workPackage.lockVersion;
    return { action: "updated", workPackage: await request(wpHref(workPackage.id), "PATCH", body) };
  }
  body._links.type = { href: "/api/v3/types/" + seg(type.id, "id") };
  const created = await request(
    "/api/v3/projects/" + seg(project.identifier, "project") + "/work_packages",
    "POST",
    body
  );
  return { action: "created", workPackage: created };
}

export async function statusUpsert(request, args = {}) {
  const id = pickWorkPackageId(args);
  const lane = args.component || args.lane ? resolveLaneArg(args) : null;
  if (!id && !lane) {
    throw new Error("status_upsert requires component/lane or workPackageId");
  }

  if (id) wpHref(id); // validate before any request (code INVALID_ID)
  const projectRef = pickProjectId(args);
  seg(projectRef, "project");
  const project = await getProject(request, projectRef);
  const lookups = createLookups(request);
  const type = await resolvePreferredType(lookups, project.identifier, args.type || "Ops");
  const category = lane ? await resolveCategory(request, project.identifier, lane) : null;
  const status = await resolveStatusByName(lookups, args.status);

  const found = id
    ? await request(wpHref(id))
    : await findStatusWorkPackage(request, { projectNumericId: project.id, lane, category });

  const schema = await getSchema(request, { workPackage: found, projectNumericId: project.id, typeId: type.id });
  const fieldMap = extractCustomFieldMap(schema);
  const body = statusBody(args, { workPackage: found, lane, status, category, fieldMap });
  const { action, workPackage } = await writeStatusWorkPackage(request, body, { workPackage: found, project, type });

  const parsed = parseStatusDescription(workPackage.description?.raw);
  return summarizeWorkPackage(workPackage, {
    action,
    component: lane || null,
    project: project.identifier,
    done: parsed.done || null,
    next: parsed.next || null,
    ...customFieldResults(workPackage, fieldMap, ["direction", "jenkins_job", "jenkins_number", "jenkins_url"]),
  });
}

export async function buildAnnotate(request, args = {}) {
  const id = pickWorkPackageId(args);
  if (!id) {
    throw new Error("build_annotate requires workPackageId");
  }
  wpHref(id); // validate before any request (code INVALID_ID)

  const values = jenkinsValuesFromArgs(args);
  if (
    values.jenkins_job === undefined &&
    values.jenkins_number === undefined &&
    values.jenkins_url === undefined
  ) {
    throw new Error(
      "build_annotate requires at least one of jenkins_job, jenkins_number, jenkins_url"
    );
  }

  const workPackage = await request(wpHref(id));
  const schema = await getSchema(request, { workPackage });
  const fieldMap = extractCustomFieldMap(schema);
  const body = { lockVersion: workPackage.lockVersion };
  applyCustomFieldValues(body, fieldMap, values);

  const updated = await request(wpHref(id), "PATCH", body);
  return summarizeWorkPackage(updated, {
    action: "updated",
    jenkins_job: readCustomFieldValue(
      updated,
      fieldMap[normalizeFieldKey("jenkins_job")]
    ),
    jenkins_number: readCustomFieldValue(
      updated,
      fieldMap[normalizeFieldKey("jenkins_number")]
    ),
    jenkins_url: readCustomFieldValue(
      updated,
      fieldMap[normalizeFieldKey("jenkins_url")]
    ),
  });
}

function summarizeRelation(relation, action) {
  return {
    id: relation.id,
    type: relation.type,
    reverseType: relation.reverseType || null,
    fromId: hrefId(relation._links && relation._links.from && relation._links.from.href),
    toId: hrefId(relation._links && relation._links.to && relation._links.to.href),
    description: relation.description || null,
    action,
  };
}

async function listWorkPackageRelations(request, workPackageId) {
  const payload = await request(wpHref(workPackageId) + "/relations");
  return collectionElements(payload);
}

export async function relationUpsert(request, args = {}) {
  const fromId = args.fromId != null ? args.fromId : args.from;
  const toId = args.toId != null ? args.toId : args.to;
  if (fromId == null || toId == null) {
    throw new Error("relation_upsert requires fromId and toId");
  }
  wpHref(fromId); // both ids are validated before any request (code INVALID_ID)
  wpHref(toId);
  if (String(fromId) === String(toId)) {
    throw new Error("relation_upsert cannot relate a work package to itself");
  }

  const type = normalizeRelationType(args.type);
  const existing = await listWorkPackageRelations(request, fromId);
  const match = existing.find((relation) =>
    isSameRelationEdge(relation, fromId, toId, type)
  );
  if (match) {
    return summarizeRelation(match, "existing");
  }

  const createBody = {
    type,
    _links: {
      to: { href: wpHref(toId) },
    },
  };
  if (args.description) {
    createBody.description = args.description;
  }

  try {
    const created = await request(
      wpHref(fromId) + "/relations",
      "POST",
      createBody,
      { allowStatuses: [409] }
    );
    if (created && created.id) {
      return summarizeRelation(created, "created");
    }
  } catch (error) {
    if (!error || error.status !== 409) throw error;
  }

  const refreshed = await listWorkPackageRelations(request, fromId);
  const after = refreshed.find((relation) =>
    isSameRelationEdge(relation, fromId, toId, type)
  );
  if (after) {
    return summarizeRelation(after, "existing");
  }
  throw new Error(
    "OpenProject reported a relation conflict but the existing edge was not found"
  );
}

export async function handleCloudbsdStatusTool(name, args, request) {
  switch (name) {
    case "status_upsert":
      return statusUpsert(request, args);
    case "build_annotate":
      return buildAnnotate(request, args);
    case "relation_upsert":
      return relationUpsert(request, args);
    default:
      return undefined;
  }
}
