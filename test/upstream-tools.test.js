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

test("stdio entry delegates to createMcpServer", () => {
  assert.match(indexSource, /createMcpServer/);
  assert.match(indexSource, /StdioServerTransport/);
});
