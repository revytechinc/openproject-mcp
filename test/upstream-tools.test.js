import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(new URL(".", import.meta.url)));
const serverSource = readFileSync(join(root, "lib", "server.js"), "utf8");
// Tools moved out of server.js into named-tool modules are registered by spreading their TOOLS arrays.
const toolSources = [
  serverSource,
  ...["wp-update.js", "wp-query.js", "comments.js", "wp-related.js", "project-admin.js", "raw-api.js"].map((file) =>
    readFileSync(join(root, "lib", file), "utf8")
  ),
].join("\n");
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

test("upstream OpenProject tools remain registered", () => {
  for (const name of UPSTREAM_TOOLS) {
    assert.match(
      toolSources,
      new RegExp('name: "' + name + '"'),
      "missing tool registration: " + name
    );
    assert.match(
      toolSources,
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

const NEW_TOOLS = [
  "set_status", "validate_update", "create_work_packages",
  "add_comment", "list_activities", "edit_comment",
  "list_relations", "delete_relation", "list_watchers", "add_watcher", "list_time_entries",
  "get_project", "create_project", "list_project_types", "list_versions", "create_version",
  "list_memberships", "add_membership", "list_priorities", "list_roles", "find_user",
];

async function connectedClient() {
  const { createMcpServer } = await import("../lib/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const server = createMcpServer({ baseUrl: "https://op.example.invalid", getApiKey: () => "" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return { client, server };
}

test("tools/list serves every tool once, including the new named tools", async () => {
  const { client, server } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length, "duplicate tool names: " + names);
    for (const name of [...UPSTREAM_TOOLS, ...STATUS_ADMIN_TOOLS, ...NEW_TOOLS]) {
      assert.ok(names.includes(name), "tools/list is missing " + name);
    }
    assert.equal(names.includes("search_work_packages"), false);
    const update = tools.find((tool) => tool.name === "update_work_package");
    assert.equal(update.inputSchema.additionalProperties, false);
  } finally {
    await server.close();
  }
});

test("tools/call routes to the named-tool modules and refuses unknown arguments", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "update_work_package", arguments: { id: 1, staus: "Done" } });
    assert.equal(result.isError, true);
    const { error } = JSON.parse(result.content[0].text);
    assert.match(error.message, /Unknown argument "staus" \(did you mean "status"\?\)/);
  } finally {
    await server.close();
  }
});
