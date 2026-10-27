/**
 * Shared MCP server factory (stdio + HTTP caller-token).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createApi } from "./api.js";
import {
  assertApplied,
  listWorkPackages,
  normalizeWorkPackage,
  projectBasePath,
  workPackageUpdateBody,
} from "./work-packages.js";
import { PROJECT_TOOLS, handleProjectTool } from "./project-tools.js";
import { resolveOpenProjectToken } from "./auth-context.js";
import {
  CLOUDBSD_STATUS_TOOLS,
  handleCloudbsdStatusTool,
} from "./cloudbsd-status.js";
import {
  STATUS_ADMIN_TOOLS,
  handleStatusAdminTool,
} from "./statuses-admin.js";

export function createMcpServer(options = {}) {
  const baseUrl =
    options.baseUrl ||
    process.env.OPENPROJECT_URL ||
    "https://your-openproject-instance.com";
  const { request: apiRequest } = createApi({
    baseUrl,
    getApiKey: options.getApiKey || resolveOpenProjectToken,
    fetchImpl: options.fetchImpl,
  });
  const statusAdminOptions = {
    baseUrl,
    fetchImpl: options.fetchImpl,
    getCredentials: options.getWebCredentials,
    createSession: options.createWebSession,
  };

  const server = new Server(
    { name: "openproject-mcp", version: "1.3.1" },
    { capabilities: { tools: {}, logging: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "list_projects",
        description: "List all projects in OpenProject",
        inputSchema: {
          type: "object",
          properties: {
            pageSize: { type: "number", description: "Number of results per page", default: 20 }
          }
        }
      },
      {
        name: "get_work_package",
        description: "Get a specific work package by ID",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Work package ID" }
          },
          required: ["id"]
        }
      },
      {
        name: "list_work_packages",
        description: "List work packages with optional filters",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "Project ID or slug" },
            parentId: { type: "number", description: "Parent work package ID to list children" },
            assigneeId: { type: "string", description: "Assignee user ID or 'me'" },
            status: { type: "string", description: "Status filter" },
            pageSize: { type: "number", description: "Number of results", default: 100 }
          }
        }
      },
      {
        name: "get_children",
        description: "Get child work packages of a parent",
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
        description: "List all available statuses",
        inputSchema: { type: "object", properties: {} }
      },
      ...STATUS_ADMIN_TOOLS,
      {
        name: "list_types",
        description: "List all work package types (Feature, Task, Bug, etc.)",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "get_user",
        description: "Get user information",
        inputSchema: {
          type: "object",
          properties: {
            userId: { type: "string", description: "User ID or 'me' for current user" }
          },
          required: ["userId"]
        }
      },
      {
        name: "create_work_package",
        description: "Create a new work package (Task)",
        inputSchema: {
          type: "object",
          properties: {
            projectId: { type: "string", description: "Project ID or slug" },
            subject: { type: "string", description: "Work package title/subject" },
            description: { type: "string", description: "Work package description" },
            typeId: { type: "number", description: "Type ID (1=Task, 4=Feature, 5=Bug)", default: 1 },
            parentId: { type: "number", description: "Parent work package ID" },
            assigneeId: { type: "number", description: "Assignee user ID" },
            versionId: { type: "number", description: "Sprint/Version ID" },
            startDate: { type: "string", description: "Start date (YYYY-MM-DD)" },
            dueDate: { type: "string", description: "Due date (YYYY-MM-DD)" }
          },
          required: ["subject"]
        }
      },
      {
        name: "update_work_package",
        description: "Update an existing work package",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "Work package ID" },
            subject: { type: "string", description: "New subject" },
            description: { type: "string", description: "New description" },
            statusId: { type: "number", description: "New status ID" },
            assigneeId: { type: "number", description: "New assignee ID" },
            versionId: { type: "number", description: "Sprint/Version ID" },
            parentId: { type: "number", description: "New parent work package ID" },
            priority: { type: "string", description: "New priority name (Low, Normal, High, Immediate)" },
            startDate: { type: "string", description: "Start date, YYYY-MM-DD" },
            dueDate: { type: "string", description: "Finish date, YYYY-MM-DD" },
            percentageDone: { type: "number", description: "Percentage complete, 0 to 100" },
            scheduleManually: { type: "boolean", description: "Keep the dates set here instead of deriving them from relations" },
            estimatedTime: { type: "string", description: "Estimated time in ISO 8601 duration format (e.g., PT2H for 2 hours, PT30M for 30 minutes)" },
            remainingTime: { type: "string", description: "Remaining work in ISO 8601 duration format" }
          },
          required: ["id"]
        }
      },
      {
        name: "log_time",
        description: "Log time entry for a work package",
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
      {
        name: "raw_api_call",
        description:
          "Make a raw API call to any OpenProject endpoint. Two traps: a description sent as a plain string is accepted and then ignored, so send {raw: \"...\"}; and a project-scoped path needs /api/v3/workspaces/<id>/ on newer instances, /api/v3/projects/<id>/ on older ones. Prefer the dedicated tools when one covers the call.",
        inputSchema: {
          type: "object",
          properties: {
            endpoint: { type: "string", description: "API endpoint (e.g., /api/v3/work_packages)" },
            method: { type: "string", description: "HTTP method", default: "GET" },
            body: { type: "object", description: "Request body for POST/PATCH" }
          },
          required: ["endpoint"]
        }
      },
      ...CLOUDBSD_STATUS_TOOLS,
      ...PROJECT_TOOLS
    ]
  }));
  
  server.setRequestHandler(CallToolRequestSchema, async (request) => { // NOSONAR S3776 -- tool switch moved intact from index; split tracked separately
    const { name, arguments: args } = request.params;
  
    try {
      let result;
  
      switch (name) {
        case "list_projects": {
          const pageSize = args.pageSize || 20;
          result = await apiRequest("/api/v3/projects?pageSize=" + pageSize);
          if (result._embedded?.elements) {
            result = result._embedded.elements.map(function(p) {
              return {
                id: p.id,
                name: p.name,
                identifier: p.identifier,
                status: p.status
              };
            });
          }
          break;
        }
  

  
        case "get_work_package": {
          result = await apiRequest("/api/v3/work_packages/" + args.id);
          result = normalizeWorkPackage(result);
          break;
        }

        case "list_work_packages": {
          var filters = [];
          if (args.parentId) {
            filters.push({ parent: { operator: "=", values: [String(args.parentId)] } });
          }
          if (args.assigneeId) {
            filters.push({ assignee: { operator: "=", values: [args.assigneeId] } });
          }
          if (args.status) {
            filters.push({ status: { operator: "=", values: [args.status] } });
          }

          var params = new URLSearchParams();
          params.set("pageSize", String(args.pageSize || 100));
          if (filters.length > 0) {
            params.set("filters", JSON.stringify(filters));
          }

          var payload = await listWorkPackages(apiRequest, args.projectId, params.toString());
          result = (payload._embedded?.elements ?? []).map(function(wp) {
            return normalizeWorkPackage(wp);
          });
          break;
        }
  
        case "get_children": {
          var childFilters = [{ parent: { operator: "=", values: [String(args.parentId)] } }];
          var childParams = new URLSearchParams();
          childParams.set("pageSize", "100");
          childParams.set("filters", JSON.stringify(childFilters));

          var childPayload = await apiRequest("/api/v3/work_packages?" + childParams.toString());
          result = (childPayload._embedded?.elements ?? []).map(function(wp) {
            return normalizeWorkPackage(wp);
          });
          break;
        }
  
        case "list_statuses": {
          result = await apiRequest("/api/v3/statuses");
          if (result._embedded?.elements) {
            result = result._embedded.elements.map(function(s) {
              return {
                id: s.id,
                name: s.name,
                isClosed: s.isClosed,
                isDefault: s.isDefault
              };
            });
          }
          break;
        }
  
        case "list_types": {
          result = await apiRequest("/api/v3/types");
          if (result._embedded?.elements) {
            result = result._embedded.elements.map(function(t) {
              return {
                id: t.id,
                name: t.name,
                color: t.color
              };
            });
          }
          break;
        }
  
        case "get_user": {
          var userId = args.userId === "me" ? "me" : args.userId;
          result = await apiRequest("/api/v3/users/" + userId);
          result = {
            id: result.id,
            name: result.name,
            login: result.login,
            email: result.email,
            status: result.status
          };
          break;
        }
  
        case "create_work_package": {
          if (!args.projectId) {
            throw new Error("projectId is required");
          }
          var projectId = args.projectId;
          var createBody = {
            subject: args.subject,
            _links: {
              type: { href: "/api/v3/types/" + (args.typeId || 1) }
            }
          };
  
          if (args.description) {
            createBody.description = { format: "markdown", raw: args.description };
          }
          if (args.parentId) {
            createBody._links.parent = { href: "/api/v3/work_packages/" + args.parentId };
          }
          if (args.assigneeId) {
            createBody._links.assignee = { href: "/api/v3/users/" + args.assigneeId };
          }
          if (args.versionId) {
            createBody._links.version = { href: "/api/v3/versions/" + args.versionId };
          }
          if (args.startDate) {
            createBody.startDate = args.startDate;
          }
          if (args.dueDate) {
            createBody.dueDate = args.dueDate;
          }
  
          var createBase = await projectBasePath(apiRequest, projectId);
          result = await apiRequest(createBase + "/work_packages", "POST", createBody);
          result = normalizeWorkPackage(result);
          break;
        }
  
        case "update_work_package": {
          var current = await apiRequest("/api/v3/work_packages/" + args.id);
          var updateBody = workPackageUpdateBody(current, args);
          result = await apiRequest("/api/v3/work_packages/" + args.id, "PATCH", updateBody);
          result = assertApplied(normalizeWorkPackage(result), args, "the work package");
          break;
        }
  
        case "log_time": {
          var today = new Date().toISOString().split('T')[0];
          var timeBody = {
            _links: {
              workPackage: { href: "/api/v3/work_packages/" + args.workPackageId },
              activity: { href: "/api/v3/time_entries/activities/" + (args.activityId || 1) }
            },
            hours: "PT" + args.hours + "H",
            spentOn: args.spentOn || today,
            comment: { format: "plain", raw: args.comment || "" }
          };
  
          result = await apiRequest("/api/v3/time_entries", "POST", timeBody);
          result = {
            id: result.id,
            hours: result.hours,
            spentOn: result.spentOn,
            workPackageId: args.workPackageId,
            comment: result.comment?.raw
          };
          break;
        }
  
        case "raw_api_call": {
          result = await apiRequest(args.endpoint, args.method || "GET", args.body);
          break;
        }
  
        default: {
          const projectResult = await handleProjectTool(name, args, apiRequest);
          if (projectResult !== undefined) {
            result = projectResult;
            break;
          }
          const statusAdminResult = await handleStatusAdminTool(
            name,
            args,
            apiRequest,
            statusAdminOptions
          );
          if (statusAdminResult !== undefined) {
            result = statusAdminResult;
            break;
          }
          const cloudbsdResult = await handleCloudbsdStatusTool(name, args, apiRequest);
          if (cloudbsdResult !== undefined) {
            result = cloudbsdResult;
            break;
          }
          throw new Error("Unknown tool: " + name);
        }
      }
  
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text:
              "openproject-mcp: " +
              error.message +
              (error.status ? " (HTTP " + error.status + ")" : "") +
              ". Check the ids and permissions, and use the dedicated tools " +
              "where one covers the call.",
          },
        ],
        isError: true
      };
    }
  });
  

  return server;
}
