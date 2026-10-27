import test from "node:test";
import assert from "node:assert/strict";

import { assertApplied, assertProjectApplied } from "../lib/work-packages.js";
import { handleProjectTool } from "../lib/project-tools.js";

test("assertApplied passes when every requested field took", () => {
  const after = {
    subject: "new",
    priority: "High",
    statusId: 7,
    assigneeId: 22,
    versionId: 9,
    parentId: 1400,
    startDate: "2026-10-27",
    dueDate: "2026-11-30",
    percentageDone: 25,
  };
  const requested = {
    subject: "new",
    priority: "High",
    statusId: 7,
    assigneeId: 22,
    versionId: 9,
    parentId: 1400,
    startDate: "2026-10-27",
    dueDate: "2026-11-30",
    percentageDone: 25,
  };
  assert.equal(assertApplied(after, requested, "the work package"), after);
});

test("assertApplied names a field the instance ignored", () => {
  const after = { subject: "new", priority: "Normal", statusId: 7 };
  const requested = { subject: "new", priority: "High", statusId: 7 };
  assert.throws(
    () => assertApplied(after, requested, "the work package"),
    /did not take: priority/
  );
});

test("assertApplied ignores fields nobody asked for", () => {
  const after = { subject: "new", priority: "Normal" };
  assert.doesNotThrow(() => assertApplied(after, { subject: "new" }, "the work package"));
});

test("assertProjectApplied names a field the instance ignored", () => {
  const after = { name: "cloudtop", description: "" };
  assert.throws(
    () => assertProjectApplied(after, { description: "the plan" }),
    /did not take: description/
  );
});

test("get_relations reads a relation that carries its type as a string", async () => {
  const apiRequest = async () => ({
    _embedded: {
      elements: [
        {
          id: 7,
          type: "relates",
          from: { href: "/api/v3/work_packages/1455" },
          to: { href: "/api/v3/work_packages/1491" },
        },
      ],
    },
  });
  const relations = await handleProjectTool(
    "get_relations",
    { workPackageId: 1455 },
    apiRequest
  );
  assert.equal(relations[0].type, "relates");
  // Ids are numbers everywhere, so they compare with an id without a cast.
  assert.equal(relations[0].fromId, 1455);
  assert.equal(relations[0].toId, 1491);
});

test("get_relations reads a relation that carries its links", async () => {
  const apiRequest = async () => ({
    _embedded: {
      elements: [
        {
          id: 7,
          _links: {
            type: { href: "/api/v3/relations/relates", title: "relates" },
            from: { href: "/api/v3/work_packages/1455" },
            to: { href: "/api/v3/work_packages/1491" },
          },
        },
      ],
    },
  });
  const relations = await handleProjectTool(
    "get_relations",
    { workPackageId: 1455 },
    apiRequest
  );
  assert.equal(relations[0].type, "relates");
  // Ids are numbers everywhere, so they compare with an id without a cast.
  assert.equal(relations[0].fromId, 1455);
  assert.equal(relations[0].toId, 1491);
});

test("create_relation sends the type as a plain string", async () => {
  let seen = null;
  const apiRequest = async (endpoint, method, body) => {
    if (method === "POST") {
      seen = body;
      return { id: 7, type: "relates" };
    }
    return {};
  };
  const created = await handleProjectTool(
    "create_relation",
    { fromId: 1455, toId: 1491, type: "relates" },
    apiRequest
  );
  assert.equal(seen.type, "relates");
  assert.equal(typeof seen.type, "string");
  assert.equal(seen.from.href, "/api/v3/work_packages/1455");
  assert.equal(created.id, 7);
});

test("create_relation fails when the relation came back with another type", async () => {
  const apiRequest = async (endpoint, method) => {
    if (method === "POST") return { id: 7, type: "precedes" };
    return {};
  };
  await assert.rejects(
    () =>
      handleProjectTool(
        "create_relation",
        { fromId: 1455, toId: 1491, type: "relates" },
        apiRequest
      ),
    /created with type precedes/
  );
});
