import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const serverSource = readFileSync(join(root, "lib", "server.js"), "utf8");
const indexSource = readFileSync(join(root, "index.js"), "utf8");

const UPSTREAM_TOOLS = [
  "list_projects",
  "get_work_package",
  "list_work_packages",
  "get_children",
  "list_statuses",
  "list_types",
  "get_user",
  "create_work_package",
  "update_work_package",
  "log_time",
  "raw_api_call",
];

const STATUS_ADMIN_TOOLS = ["get_status", "create_status", "update_status"];

const PROJECT_TOOLS = [
  "list_versions",
  "create_version",
  "update_project",
  "get_relations",
  "create_relation",
];

test("project tools are wired via PROJECT_TOOLS", () => {
  assert.match(serverSource, /\.\.\.PROJECT_TOOLS/);
  assert.match(serverSource, /handleProjectTool/);
  const projectSource = readFileSync(join(root, "lib", "project-tools.js"), "utf8");
  for (const name of PROJECT_TOOLS) {
    assert.match(
      projectSource,
      new RegExp('name: "' + name + '"'),
      "missing PROJECT_TOOLS entry: " + name
    );
  }
});

test("the work package tools read both response shapes", () => {
  // Instances differ: some carry status, type, assignee and parent as
  // top-level fields, others only through _links. The helper reads both.
  assert.match(serverSource, /normalizeWorkPackage/);
  const helperSource = readFileSync(join(root, "lib", "work-packages.js"), "utf8");
  assert.match(helperSource, /export function normalizeWorkPackage/);
  assert.match(helperSource, /export async function resolveProjectId/);
  assert.match(helperSource, /export async function listWorkPackages/);
  assert.match(helperSource, /export function workPackageUpdateBody/);
  assert.match(helperSource, /export function projectUpdateBody/);
});

test("a failing call says what failed and how", () => {
  assert.match(serverSource, /openproject-mcp: /);
  assert.match(serverSource, /HTTP " \+ error\.status/);
});

test("upstream OpenProject tools remain registered", () => {
  for (const name of UPSTREAM_TOOLS) {
    assert.match(
      serverSource,
      new RegExp('name: "' + name + '"'),
      "missing tool registration: " + name
    );
    assert.match(
      serverSource,
      new RegExp('case "' + name + '"'),
      "missing tool handler: " + name
    );
  }
});

test("status admin tools are wired via STATUS_ADMIN_TOOLS", () => {
  assert.match(serverSource, /\.\.\.STATUS_ADMIN_TOOLS/);
  assert.match(serverSource, /handleStatusAdminTool/);
  const adminSource = readFileSync(join(root, "lib", "statuses-admin.js"), "utf8");
  for (const name of STATUS_ADMIN_TOOLS) {
    assert.match(
      adminSource,
      new RegExp('name: "' + name + '"'),
      "missing STATUS_ADMIN_TOOLS entry: " + name
    );
  }
});

test("stdio entry delegates to createMcpServer", () => {
  assert.match(indexSource, /createMcpServer/);
  assert.match(indexSource, /StdioServerTransport/);
});
