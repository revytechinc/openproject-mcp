/**
 * Project administration and reference data: projects, types, versions,
 * memberships, priorities, roles, users. Compact outputs.
 */
import { collectionElements } from "./api.js";
import { compactProject, createLookups } from "./lookups.js";
import { seg } from "./path.js";
import { checkArgs, filtersParam, linkList, linkRef, parseId, projectSegment, requireArg } from "./tool-args.js";

const PROJECT_ARG = { type: "string", description: "Project id or identifier; a number is accepted too" };
const schema = (properties, required) => ({
  type: "object",
  additionalProperties: false,
  properties,
  ...(required ? { required } : {}),
});

export const PROJECT_ADMIN_TOOLS = [
  {
    name: "get_project",
    description: "Look up one project by id or identifier. Returns {id, identifier, name, parentId, active, public}.",
    inputSchema: schema({ project: PROJECT_ARG }, ["project"]),
  },
  {
    name: "create_project",
    description:
      "Create a project (needs the right to add projects). Returns {id, identifier, name, parentId, active, public}.",
    inputSchema: schema(
      {
        name: { type: "string", description: "Project name" },
        identifier: { type: "string", description: "URL identifier (lowercase letters, digits, - and _)" },
        parentId: { type: "string", description: "Parent project id or identifier; a number is accepted too" },
        description: { type: "string", description: "Description (markdown)" },
        public: { type: "boolean", description: "Public project (default false)", default: false },
      },
      ["name", "identifier"]
    ),
  },
  {
    name: "list_project_types",
    description:
      "List the work package types a project allows, in order (create_work_package defaults to the first). Returns [{id, name}].",
    inputSchema: schema({ project: PROJECT_ARG }, ["project"]),
  },
  {
    name: "list_versions",
    description: "List a project's versions (sprints/releases). Returns [{id, name, status, startDate, endDate, project}].",
    inputSchema: schema({ project: PROJECT_ARG }, ["project"]),
  },
  {
    name: "create_version",
    description: "Create a version in a project. Returns {id, name, status, startDate, endDate, project:{id,name}}.",
    inputSchema: schema(
      {
        project: PROJECT_ARG,
        name: { type: "string", description: "Version name" },
        startDate: { type: "string", description: "YYYY-MM-DD" },
        endDate: { type: "string", description: "YYYY-MM-DD" },
        status: { type: "string", enum: ["open", "locked", "closed"], description: "Default open", default: "open" },
      },
      ["project", "name"]
    ),
  },
  {
    name: "list_memberships",
    description: "List who is a member of a project and with which roles. Returns [{id, principal:{id,name}, roles:[{id,name}]}].",
    inputSchema: schema({ project: PROJECT_ARG }, ["project"]),
  },
  {
    name: "add_membership",
    description:
      "Add a user to a project with roles (role names or ids; see list_roles). Returns {id, principal:{id,name}, roles:[{id,name}]}.",
    inputSchema: schema(
      {
        project: PROJECT_ARG,
        userId: { type: "string", description: 'User id, login, or "me" (see find_user); a number is accepted too' },
        roles: { type: "array", items: { type: "string" }, description: "Role ids or names (numbers are accepted too)" },
      },
      ["project", "userId", "roles"]
    ),
  },
  {
    name: "list_priorities",
    description: "List work package priorities. Returns [{id, name, isDefault}].",
    inputSchema: schema({}),
  },
  {
    name: "list_roles",
    description: "List project roles (for add_membership). Returns [{id, name}].",
    inputSchema: schema({}),
  },
  {
    name: "find_user",
    description:
      "Find a user id by exact login or by name (contains). Use it before assigning or adding a watcher. " +
      "Logins are matched through /principals; when that finds nothing it falls back to /users, which OpenProject " +
      "only answers for admins, so searching by login may need admin (a non-admin then gets []). Returns [{id, name, login?}].",
    inputSchema: schema({
      login: { type: "string", description: "Exact login" },
      name: { type: "string", description: "Part of the user's name" },
    }),
  },
];

const TOOL = Object.fromEntries(PROJECT_ADMIN_TOOLS.map((tool) => [tool.name, tool]));

function compactVersion(version) {
  return {
    id: version.id,
    name: version.name,
    status: version.status,
    startDate: version.startDate !== undefined ? version.startDate : null,
    endDate: version.endDate !== undefined ? version.endDate : null,
    project: linkRef(version._links && version._links.definingProject),
  };
}

function compactMembership(membership) {
  const links = membership._links || {};
  return { id: membership.id, principal: linkRef(links.principal), roles: linkList(links.roles) };
}

async function projectParentId(lookups, ref) {
  if (typeof ref === "number" || /^\d+$/.test(String(ref))) return parseId(ref, "parentId");
  return (await lookups.project(ref)).id;
}

async function createProject({ args, request, lookups }) {
  const body = { name: String(args.name), identifier: String(args.identifier), public: args.public === true };
  if (args.description !== undefined) body.description = { raw: String(args.description) };
  if (args.parentId !== undefined) {
    const parentId = await projectParentId(lookups, args.parentId);
    body._links = { parent: { href: "/api/v3/projects/" + seg(parentId, "id") } };
  }
  return compactProject(await request("/api/v3/projects", "POST", body));
}

async function listVersions({ args, request }) {
  const payload = await request("/api/v3/projects/" + projectSegment(args.project) + "/versions");
  return collectionElements(payload).map(compactVersion);
}

async function createVersion({ args, request, lookups }) {
  const project = await lookups.project(args.project);
  const body = { name: String(args.name), status: args.status || "open" };
  if (args.startDate !== undefined) body.startDate = args.startDate;
  if (args.endDate !== undefined) body.endDate = args.endDate;
  body._links = { definingProject: { href: "/api/v3/projects/" + seg(project.id, "id") } };
  return compactVersion(await request("/api/v3/versions", "POST", body));
}

async function listMemberships({ args, request, lookups }) {
  const project = await lookups.project(args.project);
  const params = new URLSearchParams();
  params.set("pageSize", "500");
  params.set("filters", filtersParam([{ project: { operator: "=", values: [String(project.id)] } }]));
  return collectionElements(await request("/api/v3/memberships?" + params.toString())).map(compactMembership);
}

async function addMembership({ args, request, lookups }) {
  const project = await lookups.project(args.project);
  const user = await lookups.resolveUser(args.userId);
  const userId = user === "me" ? await lookups.meId() : user;
  const roleRefs = Array.isArray(args.roles) ? args.roles : [args.roles];
  if (!roleRefs.length) throw new Error("add_membership: roles must not be empty");
  const roles = [];
  for (const ref of roleRefs) roles.push({ href: "/api/v3/roles/" + seg((await lookups.resolveRole(ref)).id, "id") });
  const created = await request("/api/v3/memberships", "POST", {
    _links: {
      project: { href: "/api/v3/projects/" + seg(project.id, "id") },
      principal: { href: "/api/v3/users/" + seg(userId, "id") },
      roles,
    },
  });
  return compactMembership(created);
}

function findUser({ args, lookups }) {
  if (args.login !== undefined) return lookups.findUsersByLogin(String(args.login));
  if (args.name !== undefined) return lookups.findUsersByName(String(args.name));
  throw new Error("find_user: pass login or name");
}

/** One function per tool, each taking {args, request, lookups}. */
const RUN = {
  get_project: ({ args, lookups }) => lookups.project(args.project),
  create_project: createProject,
  list_project_types: ({ args, lookups }) => lookups.projectTypes(args.project),
  list_versions: listVersions,
  create_version: createVersion,
  list_memberships: listMemberships,
  add_membership: addMembership,
  list_priorities: ({ lookups }) => lookups.priorities(),
  list_roles: ({ lookups }) => lookups.roles(),
  find_user: findUser,
};

export async function handleProjectAdminTool(name, rawArgs, request) {
  const tool = TOOL[name];
  if (!tool) return undefined;
  const args = checkArgs(tool, rawArgs);
  for (const key of tool.inputSchema.required || []) requireArg(args, key, name);
  return RUN[name]({ args, request, lookups: createLookups(request) });
}
