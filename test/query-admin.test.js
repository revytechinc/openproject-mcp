import test from "node:test";
import assert from "node:assert/strict";
import { WP_QUERY_TOOLS, handleWpQueryTool } from "../lib/wp-query.js";
import { PROJECT_ADMIN_TOOLS, handleProjectAdminTool } from "../lib/project-admin.js";
import { WP_RELATED_TOOLS, handleWpRelatedTool } from "../lib/wp-related.js";
import { createLookups } from "../lib/lookups.js";
import { fakeApi, httpError, STATUSES, workPackage, collection } from "./fake-op.js";

const OPTIONS = { baseUrl: "https://op.example.invalid" };
const query = (name, args, request) => handleWpQueryTool(name, args, request, OPTIONS);
const admin = (name, args, request) => handleProjectAdminTool(name, args, request, OPTIONS);
const related = (name, args, request) => handleWpRelatedTool(name, args, request, OPTIONS);

const PROJECT_TYPES = collection([
  { id: 4, name: "Ops" },
  { id: 2, name: "Feature" },
]);
const PROJECT = { id: 3, identifier: "cloudbsd", name: "CloudBSD", active: true, public: false, _links: { parent: { href: null } } };

function filtersOf(call) {
  const value = new URL(call.path, "https://x.invalid").searchParams.get("filters");
  return value == null ? null : JSON.parse(value);
}
function param(call, name) {
  return new URL(call.path, "https://x.invalid").searchParams.get(name);
}

test("tool sets: names, additionalProperties:false, and no search_work_packages", () => {
  const all = [...WP_QUERY_TOOLS, ...PROJECT_ADMIN_TOOLS, ...WP_RELATED_TOOLS];
  for (const tool of all) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  const names = all.map((t) => t.name);
  assert.deepEqual(WP_QUERY_TOOLS.map((t) => t.name), ["list_work_packages", "create_work_package", "create_work_packages"]);
  assert.equal(names.includes("search_work_packages"), false);
  for (const name of [
    "get_project", "create_project", "list_project_types", "list_versions", "create_version",
    "list_memberships", "add_membership", "list_priorities", "list_roles", "find_user",
    "list_relations", "delete_relation", "list_watchers", "add_watcher", "list_time_entries",
  ]) {
    assert.ok(names.includes(name), "missing " + name);
  }
});

test("list_work_packages refuses unknown arguments", async () => {
  const { request, calls } = fakeApi([]);
  await assert.rejects(
    () => query("list_work_packages", { projectId: "cloudbsd", text: "nested" }, request),
    /Unknown argument.*"text".*Accepted: .*search/
  );
  await assert.rejects(
    () => query("list_work_packages", { pagesize: 5 }, request),
    /did you mean "pageSize"\?/
  );
  assert.equal(calls.length, 0);
});

test("list_work_packages: ids, search and subject build the right filters JSON", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/work_packages", reply: collection([]) },
  ]);
  await query("list_work_packages", { projectId: "cloudbsd", ids: [1677, "1678"], search: "nested virt", subject: "MCP" }, request);
  assert.deepEqual(filtersOf(calls[0]), [
    { id: { operator: "=", values: ["1677", "1678"] } },
    { search: { operator: "**", values: ["nested virt"] } },
    { subject: { operator: "~", values: ["MCP"] } },
  ]);
  assert.match(calls[0].path, /filters=%5B/, "filters are URL-encoded");
});

test("list_work_packages keeps the old args and resolves status/type names", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "GET", path: "/api/v3/projects/cloudbsd/work_packages", reply: collection([]) },
    { method: "GET", path: "/api/v3/work_packages", reply: collection([]) },
  ]);
  await query("list_work_packages", { projectId: "cloudbsd", parentId: 1600, assigneeId: "me", status: "in progress", type: "feature" }, request);
  const listCall = calls.find((c) => c.path.startsWith("/api/v3/projects/cloudbsd/work_packages"));
  assert.deepEqual(filtersOf(listCall), [
    { parent: { operator: "=", values: ["1600"] } },
    { assignee: { operator: "=", values: ["me"] } },
    { status: { operator: "=", values: ["2"] } },
    { type: { operator: "=", values: ["2"] } },
  ]);
  calls.length = 0;
  await query("list_work_packages", { status: "open" }, request);
  assert.deepEqual(filtersOf(calls[0]), [{ status: { operator: "o", values: [] } }]);
  calls.length = 0;
  await query("list_work_packages", { status: "closed", sortBy: "updatedAt:desc" }, request);
  assert.deepEqual(filtersOf(calls[0]), [{ status: { operator: "c", values: [] } }]);
  assert.deepEqual(JSON.parse(param(calls[0], "sortBy")), [["updatedAt", "desc"]]);
});

test("list_work_packages returns pagination fields and accepts offset", async () => {
  const elements = [
    workPackage({ id: 1, subject: "a" }),
    workPackage({ id: 2, subject: "b", _links: { parent: { href: null } } }),
  ];
  const { request, calls } = fakeApi([
    {
      method: "GET",
      path: "/api/v3/work_packages",
      reply: ({ query: q }) => collection(elements, { total: 7, pageSize: Number(q.get("pageSize")), offset: Number(q.get("offset")) }),
    },
  ]);
  const result = await query("list_work_packages", { pageSize: 2, offset: 2 }, request);
  assert.equal(param(calls[0], "pageSize"), "2");
  assert.equal(param(calls[0], "offset"), "2");
  assert.equal(result.total, 7);
  assert.equal(result.offset, 2);
  assert.equal(result.pageSize, 2);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.elements[0], {
    id: 1,
    subject: "a",
    status: { id: 1, name: "New" },
    type: { id: 4, name: "Ops" },
    assignee: null,
    parentId: 1600,
  });
  assert.equal(result.elements[1].parentId, null);
  assert.match(param(calls[0], "select"), /elements\/subject/);
  assert.match(param(calls[0], "select"), /total/);
});

test("list_work_packages pageSize defaults to 100 and caps at 500", async () => {
  const { request, calls } = fakeApi([{ method: "GET", path: "/api/v3/work_packages", reply: collection([]) }]);
  await query("list_work_packages", {}, request);
  await query("list_work_packages", { pageSize: 9999 }, request);
  assert.equal(param(calls[0], "pageSize"), "100");
  assert.equal(param(calls[1], "pageSize"), "500");
});

test("fields: select= is used, except for lockVersion/updatedAt/percentageDone which are trimmed in code", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/work_packages", reply: collection([workPackage()]) },
  ]);
  await query("list_work_packages", { fields: ["id", "subject"] }, request);
  assert.equal(param(calls[0], "select"), "total,count,pageSize,offset,elements/id,elements/subject");

  const result = await query("list_work_packages", { fields: ["subject", "lockVersion", "updatedAt"] }, request);
  assert.equal(param(calls[1], "select"), null);
  assert.deepEqual(result.elements[0], {
    id: 1677,
    subject: "MCP tools",
    lockVersion: 5,
    updatedAt: "2026-10-30T10:00:00Z",
  });
  await assert.rejects(() => query("list_work_packages", { fields: ["secret"] }, request), /Unknown field "secret"/);
});

test("list_work_packages validates projectId before putting it in a path", async () => {
  const { request, calls } = fakeApi([]);
  await assert.rejects(() => query("list_work_packages", { projectId: "../users" }, request), /project must be/);
  assert.equal(calls.length, 0);
});

test("create_work_package defaults the type to the project's first type", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
    {
      method: "POST",
      path: "/api/v3/projects/cloudbsd/work_packages",
      reply: ({ body }) => workPackage({ id: 1700, subject: body.subject, lockVersion: 0 }),
    },
  ]);
  const result = await query(
    "create_work_package",
    { projectId: "cloudbsd", subject: "New thing", status: "In progress", percentageDone: 0, scheduleManually: true, remainingTime: "PT2H" },
    request
  );
  const post = calls.find((c) => c.method === "POST");
  assert.equal(post.path, "/api/v3/projects/cloudbsd/work_packages");
  assert.deepEqual(post.body._links.type, { href: "/api/v3/types/4" });
  assert.deepEqual(post.body._links.status, { href: "/api/v3/statuses/2" });
  assert.equal(post.body.percentageDone, 0);
  assert.equal(post.body.scheduleManually, true);
  assert.equal(post.body.remainingTime, "PT2H");
  assert.deepEqual(result, {
    id: 1700,
    subject: "New thing",
    status: { id: 1, name: "New" },
    type: { id: 4, name: "Ops" },
    project: { id: 3, identifier: "cloudbsd", name: "CloudBSD" },
    parentId: 1600,
    lockVersion: 0,
    updatedAt: "2026-10-30T10:00:00Z",
    url: "https://op.example.invalid/work_packages/1700",
  });
});

test("create_work_package resolves type by name, honours legacy typeId, notify=false", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "POST", path: "/api/v3/projects/cloudbsd/work_packages", reply: workPackage({ id: 1701 }) },
  ]);
  await query("create_work_package", { projectId: "cloudbsd", subject: "x", type: "FEATURE", notify: false }, request);
  let post = calls.filter((c) => c.method === "POST").pop();
  assert.deepEqual(post.body._links.type, { href: "/api/v3/types/2" });
  assert.equal(post.path, "/api/v3/projects/cloudbsd/work_packages?notify=false");
  await query("create_work_package", { projectId: "cloudbsd", subject: "y", typeId: 2 }, request);
  post = calls.filter((c) => c.method === "POST").pop();
  assert.deepEqual(post.body._links.type, { href: "/api/v3/types/2" });
  await assert.rejects(
    () => query("create_work_package", { projectId: "cloudbsd", subject: "z", type: "Epic" }, request),
    /Unknown type "Epic".*Ops, Feature/
  );
});

test("create_work_package: a 422 about the type lists the project's types", async () => {
  const { request } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    {
      method: "POST",
      path: "/api/v3/projects/cloudbsd/work_packages",
      reply: () => {
        throw httpError(422, {
          message: "Type is not set to one of the allowed values.",
          _embedded: { details: { attribute: "type" } },
        });
      },
    },
  ]);
  await assert.rejects(
    () => query("create_work_package", { projectId: "cloudbsd", subject: "x", typeId: 1 }, request),
    /Type is not set to one of the allowed values.*Ops \(4\), Feature \(2\)/
  );
});

test("create_work_packages: per-item results, parentIndex, dedupe by subject, notify off by default", async () => {
  let nextId = 2000;
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd", reply: PROJECT },
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    {
      method: "GET",
      path: "/api/v3/work_packages",
      reply: ({ query: q }) => {
        const filters = JSON.parse(q.get("filters"));
        const subject = filters.find((f) => f.subject).subject.values[0];
        return subject === "Already there" ? collection([workPackage({ id: 1999, subject })]) : collection([]);
      },
    },
    {
      method: "POST",
      path: "/api/v3/projects/cloudbsd/work_packages",
      reply: ({ body }) => {
        if (body.subject === "Bad") throw httpError(422, { message: "Subject is too long." });
        return workPackage({ id: nextId++, subject: body.subject });
      },
    },
  ]);
  const result = await query(
    "create_work_packages",
    {
      projectId: "cloudbsd",
      dedupeBy: "subject",
      items: [
        { subject: "Epic" },
        { subject: "Child", parentIndex: 0 },
        { subject: "Bad" },
        { subject: "Orphan", parentIndex: 2 },
        { subject: "Already there", parentId: 1600 },
        { subject: "Typo", priorty: "High" },
      ],
    },
    request
  );
  assert.deepEqual(result.created, [
    { index: 0, id: 2000 },
    { index: 1, id: 2001 },
  ]);
  assert.deepEqual(result.existing, [{ index: 4, id: 1999 }]);
  assert.deepEqual(result.failed.map((f) => f.index), [2, 3, 5]);
  assert.match(result.failed[0].error, /Subject is too long/);
  assert.match(result.failed[1].error, /parentIndex 2/);
  assert.match(result.failed[2].error, /did you mean "priority"/);

  const posts = calls.filter((c) => c.method === "POST");
  assert.ok(posts.every((c) => c.path.endsWith("?notify=false")));
  assert.deepEqual(posts[1].body._links.parent, { href: "/api/v3/work_packages/2000" });
  assert.equal(calls.filter((c) => c.path.endsWith("/types")).length, 1, "types cached per call");

  const dedupeQuery = calls.find((c) => c.method === "GET" && c.path.includes("work_packages?") && filtersOf(c).some((f) => f.subject && f.subject.values[0] === "Already there"));
  assert.deepEqual(filtersOf(dedupeQuery), [
    { project: { operator: "=", values: ["3"] } },
    { subject: { operator: "~", values: ["Already there"] } },
    { parent: { operator: "=", values: ["1600"] } },
    { status: { operator: "*", values: [] } },
  ]);
});

test("lookups: project by id or identifier, cached per lookups instance", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd", reply: PROJECT },
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
  ]);
  const lookups = createLookups(request);
  const p = await lookups.project("cloudbsd");
  await lookups.project("cloudbsd");
  assert.deepEqual(p, { id: 3, identifier: "cloudbsd", name: "CloudBSD", parentId: null, active: true, public: false });
  assert.deepEqual(await lookups.resolveStatus("done"), { id: 4, name: "Done", isClosed: true });
  assert.deepEqual(await lookups.resolveStatus(2), { id: 2, name: "In progress", isClosed: false });
  await lookups.resolveStatus("New");
  assert.equal(calls.length, 2);
});

test("project admin: get_project, list_project_types, list_priorities, list_roles", async () => {
  const { request } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd", reply: PROJECT },
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "GET", path: "/api/v3/priorities", reply: collection([{ id: 8, name: "Normal", isDefault: true }]) },
    { method: "GET", path: "/api/v3/roles", reply: collection([{ id: 5, name: "Member" }]) },
  ]);
  assert.deepEqual(await admin("get_project", { project: "cloudbsd" }, request), {
    id: 3, identifier: "cloudbsd", name: "CloudBSD", parentId: null, active: true, public: false,
  });
  assert.deepEqual(await admin("list_project_types", { project: "cloudbsd" }, request), [
    { id: 4, name: "Ops" },
    { id: 2, name: "Feature" },
  ]);
  assert.deepEqual(await admin("list_priorities", {}, request), [{ id: 8, name: "Normal", isDefault: true }]);
  assert.deepEqual(await admin("list_roles", {}, request), [{ id: 5, name: "Member" }]);
});

test("project admin: create_project and create_version bodies", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd", reply: PROJECT },
    { method: "POST", path: "/api/v3/projects", reply: { id: 9, identifier: "sub", name: "Sub", active: true, public: false, _links: { parent: { href: "/api/v3/projects/3" } } } },
    { method: "POST", path: "/api/v3/versions", reply: { id: 11, name: "1.0", status: "open", startDate: null, endDate: "2026-12-01", _links: { definingProject: { href: "/api/v3/projects/3", title: "CloudBSD" } } } },
  ]);
  const project = await admin("create_project", { name: "Sub", identifier: "sub", parentId: 3, description: "d" }, request);
  const post = calls.find((c) => c.path === "/api/v3/projects");
  assert.deepEqual(post.body, {
    name: "Sub",
    identifier: "sub",
    public: false,
    description: { raw: "d" },
    _links: { parent: { href: "/api/v3/projects/3" } },
  });
  assert.equal(project.parentId, 3);
  const version = await admin("create_version", { project: "cloudbsd", name: "1.0", endDate: "2026-12-01" }, request);
  const vpost = calls.find((c) => c.path === "/api/v3/versions");
  assert.deepEqual(vpost.body, {
    name: "1.0",
    status: "open",
    endDate: "2026-12-01",
    _links: { definingProject: { href: "/api/v3/projects/3" } },
  });
  assert.deepEqual(version, { id: 11, name: "1.0", status: "open", startDate: null, endDate: "2026-12-01", project: { id: 3, name: "CloudBSD" } });
});

test("project admin: memberships list compactly and add_membership resolves role names", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd", reply: PROJECT },
    { method: "GET", path: "/api/v3/roles", reply: collection([{ id: 5, name: "Member" }, { id: 6, name: "Reader" }]) },
    {
      method: "GET",
      path: "/api/v3/memberships",
      reply: collection([
        { id: 70, _links: { principal: { href: "/api/v3/users/7", title: "Mark" }, roles: [{ href: "/api/v3/roles/5", title: "Member" }] } },
      ]),
    },
    {
      method: "POST",
      path: "/api/v3/memberships",
      reply: { id: 71, _links: { principal: { href: "/api/v3/users/8", title: "Bot" }, roles: [{ href: "/api/v3/roles/6", title: "Reader" }] } },
    },
  ]);
  assert.deepEqual(await admin("list_memberships", { project: "cloudbsd" }, request), [
    { id: 70, principal: { id: 7, name: "Mark" }, roles: [{ id: 5, name: "Member" }] },
  ]);
  assert.deepEqual(filtersOf(calls.find((c) => c.path.startsWith("/api/v3/memberships"))), [
    { project: { operator: "=", values: ["3"] } },
  ]);
  const added = await admin("add_membership", { project: "cloudbsd", userId: 8, roles: ["reader", 5] }, request);
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body._links, {
    project: { href: "/api/v3/projects/3" },
    principal: { href: "/api/v3/users/8" },
    roles: [{ href: "/api/v3/roles/6" }, { href: "/api/v3/roles/5" }],
  });
  assert.equal(added.id, 71);
  await assert.rejects(() => admin("add_membership", { project: "cloudbsd", userId: 8, roles: ["Owner"] }, request), /Unknown role "Owner".*Member, Reader/);
});

test("find_user by login and by name", async () => {
  const { request, calls } = fakeApi([
    {
      method: "GET",
      path: "/api/v3/principals",
      reply: ({ query: q }) =>
        JSON.parse(q.get("filters")).some((f) => f.any_name_attribute)
          ? collection([{ id: 7, name: "Mark LaPointe", login: "mlapointe", _type: "User" }])
          : collection([{ id: 7, name: "Mark LaPointe", _type: "User" }]),
    },
  ]);
  assert.deepEqual(await admin("find_user", { login: "mlapointe" }, request), [{ id: 7, name: "Mark LaPointe", login: "mlapointe" }]);
  assert.deepEqual(filtersOf(calls[0]), [
    { type: { operator: "=", values: ["User"] } },
    { any_name_attribute: { operator: "~", values: ["mlapointe"] } },
  ]);
  assert.deepEqual(await admin("find_user", { name: "Mark" }, request), [{ id: 7, name: "Mark LaPointe" }]);
  assert.deepEqual(filtersOf(calls[1]), [
    { type: { operator: "=", values: ["User"] } },
    { name: { operator: "~", values: ["Mark"] } },
  ]);
  await assert.rejects(() => admin("find_user", {}, request), /login or name/);
});

test("relations, watchers and time entries are compact; delete_relation needs confirm", async () => {
  const { request, calls } = fakeApi([
    {
      method: "GET",
      path: "/api/v3/work_packages/1677/relations",
      reply: collection([
        { id: 30, type: "blocks", description: null, _links: { from: { href: "/api/v3/work_packages/1677", title: "MCP tools" }, to: { href: "/api/v3/work_packages/1680", title: "Other" } } },
      ]),
    },
    { method: "DELETE", path: "/api/v3/relations/30", reply: null },
    { method: "GET", path: "/api/v3/work_packages/1677/watchers", reply: collection([{ id: 7, name: "Mark LaPointe", login: "x" }]) },
    { method: "POST", path: "/api/v3/work_packages/1677/watchers", reply: { id: 8, name: "Bot" } },
    {
      method: "GET",
      path: "/api/v3/time_entries",
      reply: collection([
        { id: 90, hours: "PT1H30M", spentOn: "2026-10-30", comment: { raw: "work" }, _links: { user: { href: "/api/v3/users/7", title: "Mark" }, activity: { href: "/api/v3/time_entries/activities/1", title: "Development" } } },
      ]),
    },
  ]);
  assert.deepEqual(await related("list_relations", { id: 1677 }, request), [
    { id: 30, type: "blocks", from: { id: 1677, name: "MCP tools" }, to: { id: 1680, name: "Other" }, description: null },
  ]);
  await assert.rejects(() => related("delete_relation", { relationId: 30 }, request), /confirm: true/);
  assert.equal(calls.some((c) => c.method === "DELETE"), false);
  assert.deepEqual(await related("delete_relation", { relationId: 30, confirm: true }, request), { deleted: true, relationId: 30 });
  assert.deepEqual(await related("list_watchers", { id: 1677 }, request), [{ id: 7, name: "Mark LaPointe" }]);
  assert.deepEqual(await related("add_watcher", { id: 1677, userId: 8 }, request), { workPackageId: 1677, watcher: { id: 8, name: "Bot" } });
  assert.deepEqual(calls.find((c) => c.method === "POST").body, { user: { href: "/api/v3/users/8" } });
  const entries = await related("list_time_entries", { id: 1677 }, request);
  assert.deepEqual(entries.elements, [
    { id: 90, hours: "PT1H30M", spentOn: "2026-10-30", user: { id: 7, name: "Mark" }, activity: { id: 1, name: "Development" }, comment: "work" },
  ]);
  assert.equal(entries.total, 1);
  assert.deepEqual(filtersOf(calls.find((c) => c.path.startsWith("/api/v3/time_entries"))), [
    { work_package: { operator: "=", values: ["1677"] } },
  ]);
});

test("query/admin/related handlers return undefined for tools they do not own", async () => {
  const { request } = fakeApi([]);
  assert.equal(await query("list_projects", {}, request), undefined);
  assert.equal(await admin("list_projects", {}, request), undefined);
  assert.equal(await related("list_projects", {}, request), undefined);
});
