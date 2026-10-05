/**
 * Professional OpenProject work-package Status admin tools.
 *
 * Reads use API v3. Creates/updates cannot use API v3 (Statuses are GET-only).
 * Mutation backends (OPENPROJECT_STATUS_BACKEND):
 *   - rails — host-local `bin/rails runner` (preferred on track jail; survives 2FA)
 *   - web   — admin HTML session (CSRF + cookie; fails closed on 2FA)
 *   - auto  — rails when envfile+bin/rails are readable, else web
 */

import { collectionElements } from "./api.js";
import { createWebSession } from "./web-session.js";
import {
  createStatusViaRails,
  updateStatusViaRails,
  railsAdminAvailable,
} from "./statuses-rails.js";

export const STATUS_ADMIN_TOOLS = [
  {
    name: "get_status",
    description:
      "Get one OpenProject work-package status by id (API v3). Returns id, name, isClosed, isDefault, color, position.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Status id" },
      },
      required: ["id"],
    },
  },
  {
    name: "create_status",
    description:
      "Create an OpenProject work-package status (admin). API v3 cannot create statuses. Uses rails runner on the OpenProject host when available (OPENPROJECT_STATUS_BACKEND=auto|rails), else admin HTML session (web credentials from OPENPROJECT_WEB_USER + OPENPROJECT_WEB_PASSWORD_FILE — never pass passwords as arguments). Fails closed on 2FA for the web path. Idempotent: if a status with the same name exists, returns it unless force=true.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Status name (unique)" },
        isClosed: {
          type: "boolean",
          description: "Treat work packages in this status as closed",
          default: false,
        },
        isDefault: {
          type: "boolean",
          description: "Make this the default status for new work packages",
          default: false,
        },
        color: {
          type: "string",
          description: "Optional hex color (e.g. #74C0FC)",
        },
        defaultDoneRatio: {
          type: "number",
          description: "Default % complete when entering this status (0-100)",
        },
        force: {
          type: "boolean",
          description: "If true, create even when name already exists (will fail uniqueness)",
          default: false,
        },
      },
      required: ["name"],
    },
  },
  {
    name: "update_status",
    description:
      "Update an OpenProject work-package status by id (rails runner or admin HTML session). Rename, isClosed, color, defaultDoneRatio. Never pass passwords as arguments.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Status id" },
        name: { type: "string", description: "New status name" },
        isClosed: { type: "boolean", description: "Closed flag" },
        isDefault: { type: "boolean", description: "Default flag" },
        color: { type: "string", description: "Hex color" },
        defaultDoneRatio: { type: "number", description: "Default % complete 0-100" },
      },
      required: ["id"],
    },
  },
];

function summarizeStatus(s) {
  if (!s) return null;
  return {
    id: s.id,
    name: s.name,
    isClosed: !!s.isClosed,
    isDefault: !!s.isDefault,
    isReadonly: !!s.isReadonly,
    excludedFromTotals: !!s.excludedFromTotals,
    color: s.color ?? null,
    defaultDoneRatio: s.defaultDoneRatio ?? null,
    position: s.position ?? null,
  };
}

export async function listAllStatuses(apiRequest) {
  const payload = await apiRequest("/api/v3/statuses?pageSize=200");
  return collectionElements(payload).map(summarizeStatus);
}

export async function getStatus(apiRequest, id) {
  const s = await apiRequest("/api/v3/statuses/" + id);
  return summarizeStatus(s);
}

export async function findStatusByName(apiRequest, name) {
  const want = String(name).trim().toLowerCase();
  const all = await listAllStatuses(apiRequest);
  return all.find((s) => s.name.toLowerCase() === want) || null;
}

async function requireAdminCaller(apiRequest) {
  const me = await apiRequest("/api/v3/users/me");
  if (!me?.admin) {
    const err = new Error(
      "create_status/update_status require an OpenProject admin API token (users/me.admin)"
    );
    err.code = "ADMIN_REQUIRED";
    throw err;
  }
  return me;
}

function buildStatusFields(attrs) {
  const fields = {};
  if (attrs.name !== undefined) fields["status[name]"] = attrs.name;
  if (attrs.isClosed !== undefined) {
    fields["status[is_closed]"] = attrs.isClosed ? "1" : "0";
  }
  if (attrs.isDefault !== undefined) {
    fields["status[is_default]"] = attrs.isDefault ? "1" : "0";
  }
  if (attrs.color !== undefined && attrs.color !== null && attrs.color !== "") {
    fields["status[color]"] = attrs.color;
  }
  if (attrs.defaultDoneRatio !== undefined && attrs.defaultDoneRatio !== null) {
    fields["status[default_done_ratio]"] = attrs.defaultDoneRatio;
  }
  return fields;
}

function resolveStatusBackend(options = {}, env = process.env) {
  if (options.backend) return String(options.backend).toLowerCase();
  const fromEnv = (env.OPENPROJECT_STATUS_BACKEND || "auto").toLowerCase();
  if (fromEnv === "rails" || fromEnv === "web") return fromEnv;
  if (options.railsAvailable === true) return "rails";
  if (options.railsAvailable === false) return "web";
  return railsAdminAvailable(env) ? "rails" : "web";
}

/**
 * @param {Function} apiRequest
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, getCredentials?: Function, createSession?: Function, backend?: string, runRailsCreate?: Function }} options
 */
export async function createStatus(apiRequest, attrs, options = {}) {
  const name = String(attrs.name || "").trim();
  if (!name) {
    const err = new Error("status name is required");
    err.code = "VALIDATION";
    throw err;
  }

  const existing = await findStatusByName(apiRequest, name);
  if (existing && !attrs.force) {
    return { ...existing, created: false, idempotent: true };
  }

  await requireAdminCaller(apiRequest);

  const backend = resolveStatusBackend(options);
  if (backend === "rails") {
    const run =
      options.runRailsCreate || createStatusViaRails;
    const created = await run(
      {
        name,
        isClosed: !!attrs.isClosed,
        isDefault: !!attrs.isDefault,
        color: attrs.color,
        defaultDoneRatio: attrs.defaultDoneRatio,
        force: !!attrs.force,
      },
      options
    );
    if (created?.id) return created;
    const verified = await findStatusByName(apiRequest, name);
    if (!verified) {
      const err = new Error(
        "Status create (rails) submitted but status not found by name: " + name
      );
      err.code = "CREATE_VERIFY_FAILED";
      throw err;
    }
    return { ...verified, created: true, idempotent: false, backend: "rails" };
  }

  const createSession = options.createSession || createWebSession;
  const session = createSession({
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    getCredentials: options.getCredentials,
  });

  await session.submitForm(
    "/statuses/new",
    "/statuses",
    buildStatusFields({
      name,
      isClosed: !!attrs.isClosed,
      isDefault: !!attrs.isDefault,
      color: attrs.color,
      defaultDoneRatio: attrs.defaultDoneRatio,
    }),
    { method: "POST" }
  );

  const created = await findStatusByName(apiRequest, name);
  if (!created) {
    const err = new Error(
      "Status create submitted but status not found by name afterward: " + name
    );
    err.code = "CREATE_VERIFY_FAILED";
    throw err;
  }
  return { ...created, created: true, idempotent: false, backend: "web" };
}

/**
 * @param {Function} apiRequest
 * @param {number} id
 * @param {object} attrs
 * @param {{ baseUrl: string, fetchImpl?: typeof fetch, getCredentials?: Function, createSession?: Function, backend?: string, runRailsUpdate?: Function }} options
 */
export async function updateStatus(apiRequest, id, attrs, options = {}) {
  const statusId = Number(id);
  if (!Number.isFinite(statusId) || statusId <= 0) {
    const err = new Error("status id must be a positive number");
    err.code = "VALIDATION";
    throw err;
  }

  const before = await getStatus(apiRequest, statusId);
  const fields = buildStatusFields(attrs);
  if (Object.keys(fields).length === 0) {
    return { ...before, updated: false, reason: "no_fields" };
  }

  await requireAdminCaller(apiRequest);

  const backend = resolveStatusBackend(options);
  if (backend === "rails") {
    const run = options.runRailsUpdate || updateStatusViaRails;
    return run(statusId, attrs, options);
  }

  const createSession = options.createSession || createWebSession;
  const session = createSession({
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    getCredentials: options.getCredentials,
  });

  await session.submitForm(
    "/statuses/" + statusId + "/edit",
    "/statuses/" + statusId,
    fields,
    { method: "PATCH" }
  );

  const after = await getStatus(apiRequest, statusId);
  if (attrs.name !== undefined && after.name !== String(attrs.name)) {
    const err = new Error(
      "Status update submitted but name did not change (got " +
        after.name +
        ", expected " +
        attrs.name +
        ")"
    );
    err.code = "UPDATE_VERIFY_FAILED";
    throw err;
  }
  if (attrs.isClosed !== undefined && after.isClosed !== !!attrs.isClosed) {
    const err = new Error("Status update submitted but isClosed did not change");
    err.code = "UPDATE_VERIFY_FAILED";
    throw err;
  }
  return { ...after, updated: true, previousName: before.name, backend: "web" };
}

export async function handleStatusAdminTool(name, args, apiRequest, options = {}) {
  switch (name) {
    case "get_status":
      return getStatus(apiRequest, args.id);
    case "create_status":
      return createStatus(apiRequest, args || {}, options);
    case "update_status":
      return updateStatus(apiRequest, args.id, args || {}, options);
    default:
      return undefined;
  }
}
