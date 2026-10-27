import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeWorkPackage,
  resolveProjectId,
  listWorkPackages,
  workPackageUpdateBody,
  projectUpdateBody,
} from "../lib/work-packages.js";

/**
 * A work package as an instance that only fills the top-level fields. The
 * _links block is absent, which is what broke the previous reading.
 */
const topLevelOnly = {
  id: 1455,
  subject: "cloudtop",
  description: { format: "markdown", raw: "# plan" },
  status: { name: "New" },
  type: { name: "Summary task" },
  assignee: { login: "mlapointe" },
  parent: { id: 1400 },
  version: { name: "gotop v0.1" },
  priority: { name: "High" },
  startDate: "2026-10-27",
  dueDate: "2026-11-30",
  percentageDone: 0,
  estimatedTime: "P27D",
  lockVersion: 3,
};

/** A work package as an instance that only fills the _links block. */
const linksOnly = {
  id: 1455,
  subject: "cloudtop",
  _links: {
    status: { href: "/api/v3/statuses/1", title: "New" },
    type: { href: "/api/v3/types/3", title: "Summary task" },
    assignee: { href: "/api/v3/users/22", title: "Mark LaPointe" },
    parent: { href: "/api/v3/work_packages/1400", title: "Program" },
  },
};

test("normalizeWorkPackage reads the top-level fields", () => {
  const wp = normalizeWorkPackage(topLevelOnly);
  assert.equal(wp.status, "New");
  assert.equal(wp.type, "Summary task");
  assert.equal(wp.assignee, "mlapointe");
  assert.equal(wp.parentId, 1400);
  assert.equal(wp.version, "gotop v0.1");
  assert.equal(wp.priority, "High");
  assert.equal(wp.description, "# plan");
  assert.equal(wp.lockVersion, 3);
});

test("normalizeWorkPackage falls back to the _links fields", () => {
  const wp = normalizeWorkPackage(linksOnly);
  assert.equal(wp.status, "New");
  assert.equal(wp.type, "Summary task");
  assert.equal(wp.assignee, "Mark LaPointe");
  assert.equal(wp.parentId, 1400);
});

test("resolveProjectId passes a numeric id through", async () => {
  let called = 0;
  const apiRequest = async () => {
    called += 1;
    return {};
  };
  assert.equal(await resolveProjectId(apiRequest, "57"), 57);
  assert.equal(called, 0, "a numeric id needs no lookup");
});

test("resolveProjectId resolves an identifier to a numeric id", async () => {
  const seen = [];
  const apiRequest = async (endpoint) => {
    seen.push(endpoint);
    return {
      _embedded: {
        elements: [{ id: 57, identifier: "cloudtop", name: "cloudtop" }],
      },
    };
  };
  assert.equal(await resolveProjectId(apiRequest, "cloudtop"), 57);
  assert.match(seen[0], /\/api\/v3\/projects\?filters=/);
  assert.match(decodeURIComponent(seen[0]), /"identifier"/);
});

test("resolveProjectId fails loudly for an unknown identifier", async () => {
  const apiRequest = async () => ({ _embedded: { elements: [] } });
  await assert.rejects(
    () => resolveProjectId(apiRequest, "nope"),
    /no project matches identifier/
  );
});

test("listWorkPackages prefers the workspaces endpoint", async () => {
  const seen = [];
  const apiRequest = async (endpoint) => {
    seen.push(endpoint);
    return { _embedded: { elements: [] } };
  };
  await listWorkPackages(apiRequest, 57, "pageSize=10");
  assert.equal(seen.length, 1);
  assert.equal(seen[0], "/api/v3/workspaces/57/work_packages?pageSize=10");
});

test("listWorkPackages falls back to the projects endpoint", async () => {
  const seen = [];
  const apiRequest = async (endpoint) => {
    seen.push(endpoint);
    if (endpoint.startsWith("/api/v3/workspaces/")) {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    }
    return { _embedded: { elements: [] } };
  };
  await listWorkPackages(apiRequest, 57, "");
  assert.equal(seen[0], "/api/v3/workspaces/57/work_packages");
  assert.equal(seen[1], "/api/v3/projects/57/work_packages");
});

test("listWorkPackages does not swallow a real failure", async () => {
  const apiRequest = async () => {
    const error = new Error("boom");
    error.status = 500;
    throw error;
  };
  await assert.rejects(() => listWorkPackages(apiRequest, 57, ""), /boom/);
});

test("workPackageUpdateBody carries the lockVersion", () => {
  const body = workPackageUpdateBody({ lockVersion: 7 }, { subject: "new" });
  assert.equal(body.lockVersion, 7);
  assert.equal(body.subject, "new");
});

test("workPackageUpdateBody carries every board field", () => {
  const body = workPackageUpdateBody(
    { lockVersion: 1 },
    {
      subject: "s",
      description: "d",
      priority: "High",
      startDate: "2026-10-27",
      dueDate: "2026-11-30",
      percentageDone: 25,
      scheduleManually: true,
      statusId: 7,
      assigneeId: 22,
      versionId: 9,
      parentId: 1400,
      estimatedTime: "P2D",
    }
  );
  assert.equal(body.priority.name, "High");
  assert.equal(body.startDate, "2026-10-27");
  assert.equal(body.dueDate, "2026-11-30");
  assert.equal(body.percentageDone, 25);
  assert.equal(body.scheduleManually, true);
  assert.equal(body.description.raw, "d");
  assert.equal(body._links.status.href, "/api/v3/statuses/7");
  assert.equal(body._links.assignee.href, "/api/v3/users/22");
  assert.equal(body._links.version.href, "/api/v3/versions/9");
  assert.equal(body._links.parent.href, "/api/v3/work_packages/1400");
  assert.equal(body.estimatedTime, "P2D");
});

test("workPackageUpdateBody omits fields that were not asked for", () => {
  const body = workPackageUpdateBody({ lockVersion: 1 }, { statusId: 7 });
  assert.deepEqual(Object.keys(body).sort(), ["_links", "lockVersion"]);
});

test("projectUpdateBody sends the description as a formattable", () => {
  const body = projectUpdateBody({ name: "cloudtop", description: "# what" });
  assert.equal(body.name, "cloudtop");
  assert.equal(body.description.format, "markdown");
  assert.equal(body.description.raw, "# what");
});
