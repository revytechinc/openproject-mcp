import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../lib/server.js";

/**
 * These tests drive the real tool handlers over a real MCP connection, with
 * a fake API underneath. The source-matching tests elsewhere in this suite
 * cannot catch a handler that assembles its answer wrongly: they only see
 * that the code is there.
 */

function fakeFetch(routes) {
  return async (url) => {
    for (const [pattern, body] of Object.entries(routes)) {
      if (String(url).includes(pattern)) {
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: "not found" }) };
  };
}

async function callTool(name, args, routes) {
  const server = createMcpServer({
    baseUrl: "http://openproject.test",
    fetchImpl: fakeFetch(routes),
    getApiKey: () => "test-token",
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

const workPackage = {
  id: 1455,
  subject: "cloudtop",
  status: { name: "New" },
  type: { name: "Summary task" },
  assignee: { login: "mlapointe" },
  parent: { id: 1400 },
};

test("list_work_packages returns the work packages it found", async () => {
  const result = await callTool(
    "list_work_packages",
    { projectId: 57 },
    {
      "/api/v3/workspaces/57/work_packages": {
        _embedded: { elements: [workPackage] },
      },
    }
  );
  const payload = JSON.parse(result.content[0].text);
  assert.ok(Array.isArray(payload), "the tool must return a list");
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 1455);
  assert.equal(payload[0].subject, "cloudtop");
  assert.equal(payload[0].status, "New");
  assert.equal(payload[0].type, "Summary task");
  assert.equal(payload[0].assignee, "mlapointe");
  assert.equal(payload[0].parentId, 1400);
});

test("list_work_packages resolves a project identifier before asking", async () => {
  const result = await callTool(
    "list_work_packages",
    { projectId: "cloudtop" },
    {
      "/api/v3/projects?filters=": {
        _embedded: { elements: [{ id: 57, identifier: "cloudtop" }] },
      },
      "/api/v3/workspaces/57/work_packages": {
        _embedded: { elements: [workPackage] },
      },
    }
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].id, 1455);
});

test("get_children returns the children it found", async () => {
  const result = await callTool(
    "get_children",
    { parentId: 1455 },
    {
      "/api/v3/work_packages?": {
        _embedded: { elements: [workPackage] },
      },
    }
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].parentId, 1400);
});

test("a failing call says what failed", async () => {
  const result = await callTool(
    "list_work_packages",
    { projectId: 57 },
    {}
  );
  const text = result.content[0].text;
  assert.match(text, /openproject-mcp:/);
  assert.match(text, /HTTP 404/);
});
