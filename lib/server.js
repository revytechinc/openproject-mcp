/**
 * Shared MCP server factory (stdio + HTTP caller-token).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApi, wpHref } from "./api.js";
import { seg } from "./path.js";
import { duration, parseId, requireArg } from "./tool-args.js";
import { resolveOpenProjectToken } from "./auth-context.js";
import { requireBaseUrl } from "./config.js";
import { formatToolError } from "./errors.js";
import { RAW_API_TOOL, handleRawApiCall } from "./raw-api.js";
import {
  CLOUDBSD_STATUS_TOOLS,
  handleCloudbsdStatusTool,
} from "./cloudbsd-status.js";
import {
  STATUS_ADMIN_TOOLS,
  handleStatusAdminTool,
} from "./statuses-admin.js";
import { COMMENT_TOOLS, handleCommentTool } from "./comments.js";
import { WP_UPDATE_TOOLS, handleWpUpdateTool } from "./wp-update.js";
import { WP_QUERY_TOOLS, handleWpQueryTool } from "./wp-query.js";
import { WP_RELATED_TOOLS, handleWpRelatedTool } from "./wp-related.js";
import {
  PROJECT_ADMIN_TOOLS,
  handleProjectAdminTool,
} from "./project-admin.js";

export const SERVER_VERSION = "2.0.0";

/** Named-tool modules: each handler returns undefined for names it does not own. */
const TOOL_HANDLERS = [
  handleWpUpdateTool,
  handleWpQueryTool,
  handleCommentTool,
  handleWpRelatedTool,
  handleProjectAdminTool,
];

/** Elements of a collection mapped by `pick`, or the payload unchanged when it is not a collection. */
function mapElements(payload, pick) {
  return payload?._embedded?.elements
    ? payload._embedded.elements.map(pick)
    : payload;
}

function linkTitle(wp, key) {
  const link = wp._links?.[key];
  return link ? link.title : null;
}

async function listProjects(apiRequest, args) {
  const pageSize = Math.max(1, Math.min(500, Math.floor(Number(args.pageSize)) || 20));
  const payload = await apiRequest("/api/v3/projects?pageSize=" + pageSize);
  return mapElements(payload, (p) => ({ id: p.id, name: p.name, identifier: p.identifier, status: p.status }));
}

async function getChildren(apiRequest, args, name) {
  const parentId = parseId(requireArg(args, "parentId", name), "parentId");
  const params = new URLSearchParams();
  params.set("pageSize", "100");
  params.set("filters", JSON.stringify([{ parent: { operator: "=", values: [String(parentId)] } }]));
  const payload = await apiRequest("/api/v3/work_packages?" + params.toString());
  return mapElements(payload, (wp) => ({
    id: wp.id,
    subject: wp.subject,
    status: linkTitle(wp, "status"),
    type: linkTitle(wp, "type"),
    assignee: linkTitle(wp, "assignee"),
  }));
}

async function listStatuses(apiRequest) {
  const payload = await apiRequest("/api/v3/statuses");
  return mapElements(payload, (st) => ({ id: st.id, name: st.name, isClosed: st.isClosed, isDefault: st.isDefault }));
}

async function listTypes(apiRequest) {
  const payload = await apiRequest("/api/v3/types");
  return mapElements(payload, (t) => ({ id: t.id, name: t.name, color: t.color }));
}

async function getUser(apiRequest, args, name) {
  const userRef = requireArg(args, "userId", name);
  const userPath =
    String(userRef).trim().toLowerCase() === "me"
      ? "/api/v3/users/me"
      : "/api/v3/users/" + seg(parseId(userRef, "userId"), "id");
  const user = await apiRequest(userPath);
  return { id: user.id, name: user.name, login: user.login, email: user.email, status: user.status };
}

async function logTime(apiRequest, args, name) {
  const today = new Date().toISOString().split("T")[0];
  const workPackageId = parseId(requireArg(args, "workPackageId", name), "workPackageId");
  const activityId = parseId(args.activityId ?? 1, "activityId");
  const hours = requireArg(args, "hours", name);
  const body = {
    _links: {
      workPackage: { href: wpHref(workPackageId) },
      activity: { href: "/api/v3/time_entries/activities/" + seg(activityId, "id") },
    },
    hours: duration(hours),
    spentOn: args.spentOn || today,
    comment: { format: "plain", raw: args.comment || "" },
  };
  const entry = await apiRequest("/api/v3/time_entries", "POST", body);
  return { id: entry.id, hours: entry.hours, spentOn: entry.spentOn, workPackageId, comment: entry.comment?.raw };
}

/**
 * @param {{ baseUrl?: string, getApiKey?: () => string, fetchImpl?: typeof fetch,
 *   timeoutMs?: number, getWebCredentials?: Function, createWebSession?: Function }} [options]
 *   getApiKey: HTTP mode passes requireCallerToken (never the service key);
 *   stdio defaults to resolveOpenProjectToken (OPENPROJECT_API_KEY).
 * Throws (code CONFIG) when OPENPROJECT_URL is unset or a placeholder.
 */
export function createMcpServer(options = {}) {
  const baseUrl = requireBaseUrl(options.baseUrl || process.env.OPENPROJECT_URL);
  const api = createApi({
    baseUrl,
    getApiKey: options.getApiKey || resolveOpenProjectToken,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
  const apiRequest = api.request;
  const statusAdminOptions = {
    baseUrl,
    fetchImpl: options.fetchImpl,
    getCredentials: options.getWebCredentials,
    createSession: options.createWebSession,
  };

  const server = new Server(
    { name: "openproject-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {}, logging: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_projects",
        description: "List projects (id, name, identifier). Use get_project for one project by identifier.",
        inputSchema: {
          type: "object",
          properties: {
            pageSize: { type: "number", description: "Number of results per page", default: 20 }
          }
        }
      },
      ...WP_UPDATE_TOOLS,
      ...WP_QUERY_TOOLS,
      ...COMMENT_TOOLS,
      ...WP_RELATED_TOOLS,
      ...PROJECT_ADMIN_TOOLS,
      {
        name: "get_children",
        description: "List the direct children of a work package (names only). For paging, fields or status filters use list_work_packages with parentId.",
        inputSchema: {
          type: "object",
          properties: {
            parentId: { type: "number", description: "Parent work package ID" }
          },
          required: ["parentId"]
        }
      },
      {
        name: "list_statuses",
        description: "List every work package status (id, name, isClosed). Tools take status names directly, so this is for discovery only.",
        inputSchema: { type: "object", properties: {} }
      },
      ...STATUS_ADMIN_TOOLS,
      {
        name: "list_types",
        description: "List every work package type in the instance. A project may allow only some: use list_project_types before creating.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "get_user",
        description: "Get one user by id or 'me'. To find an id by login or name use find_user.",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string", description: "User ID or 'me' for current user" }
          },
          required: ["userId"]
        }
      },
      {
        name: "log_time",
        description: "Log a time entry on a work package. list_time_entries reads them back.",
        inputSchema: {
          type: "object",
          properties: {
            workPackageId: { type: "number", description: "Work package ID" },
            hours: { type: "number", description: "Hours spent (e.g., 2 for 2 hours, 0.5 for 30 minutes)" },
            comment: { type: "string", description: "Comment for the time entry" },
            spentOn: { type: "string", description: "Date spent (YYYY-MM-DD), defaults to today" },
            activityId: { type: "number", description: "Activity type ID (1=Development)", default: 1 }
          },
          required: ["workPackageId", "hours"]
        }
      },
      RAW_API_TOOL,
      ...CLOUDBSD_STATUS_TOOLS
    ]
  }));
  
  /** The first named-tool module that owns `name`, or undefined. */
  async function moduleTool(name, args) {
    for (const handle of TOOL_HANDLERS) {
      const result = await handle(name, args, apiRequest, { baseUrl });
      if (result !== undefined) return result;
    }
    const statusAdmin = await handleStatusAdminTool(name, args, apiRequest, statusAdminOptions);
    if (statusAdmin !== undefined) return statusAdmin;
    return handleCloudbsdStatusTool(name, args, apiRequest);
  }

  async function callTool(name, args) {
    switch (name) {
      case "list_projects":
        return listProjects(apiRequest, args);
      case "get_children":
        return getChildren(apiRequest, args, name);
      case "list_statuses":
        return listStatuses(apiRequest);
      case "list_types":
        return listTypes(apiRequest);
      case "get_user":
        return getUser(apiRequest, args, name);
      case "log_time":
        return logTime(apiRequest, args, name);
      case "raw_api_call":
        return handleRawApiCall(args, api);
      default: {
        const result = await moduleTool(name, args);
        if (result === undefined) throw new Error("Unknown tool: " + name);
        return result;
      }
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments || {};
    try {
      const result = await callTool(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return formatToolError(error);
    }
  });

  return server;
}
