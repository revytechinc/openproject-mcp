import test from "node:test";
import assert from "node:assert/strict";
import {
  STATUS_LANES,
  CLOUDBSD_STATUS_TOOLS,
  applyCustomFieldValues,
  extractCustomFieldMap,
  formatCustomFieldValue,
  isSameRelationEdge,
  mergeStatusDescription,
  normalizeLane,
  normalizeRelationType,
  parseStatusDescription,
  renderStatusDescription,
  statusUpsert,
  buildAnnotate,
  relationUpsert,
} from "../lib/cloudbsd-status.js";
import { createApi, hrefId } from "../lib/api.js";

const SCHEMA = {
  customField11: { name: "direction", type: "String", writable: true },
  customField12: { name: "jenkins_job", type: "String", writable: true },
  customField13: { name: "jenkins_number", type: "Integer", writable: true },
  customField14: { name: "jenkins_url", type: "String", writable: true },
};

function relation(id, type, fromId, toId, reverseType) {
  return {
    id,
    type,
    reverseType: reverseType || type,
    _links: {
      from: { href: "/api/v3/work_packages/" + fromId },
      to: { href: "/api/v3/work_packages/" + toId },
    },
  };
}

test("tool names are exact first-class write tools", () => {
  assert.deepEqual(
    CLOUDBSD_STATUS_TOOLS.map((tool) => tool.name),
    ["status_upsert", "build_annotate", "relation_upsert"]
  );
  assert.deepEqual(STATUS_LANES, [
    "Desktop",
    "HackMiami",
    "Server",
    "Wayfire",
    "Ports-InternalPkg",
    "Product-Media",
    "CI-Jenkins",
    "Networking",
    "Status",
  ]);
});

test("normalizeLane is case-insensitive and rejects unknown lanes", () => {
  assert.equal(normalizeLane("server"), "Server");
  assert.equal(normalizeLane("Ports-InternalPkg"), "Ports-InternalPkg");
  assert.throws(() => normalizeLane("Laptop"), /Unknown component\/lane/);
});

test("done/next description merge keeps the other section", () => {
  const existing = renderStatusDescription({
    extra: "Context note",
    done: "- shipped ISO",
    next: "- sign packages",
  });
  const merged = mergeStatusDescription(existing, { next: ["cut RC"] });
  const parsed = parseStatusDescription(merged);
  assert.equal(parsed.extra, "Context note");
  assert.equal(parsed.done, "- shipped ISO");
  assert.equal(parsed.next, "- cut RC");
});

test("custom field map uses OpenProject schema names", () => {
  const map = extractCustomFieldMap(SCHEMA);
  const target = {};
  applyCustomFieldValues(target, map, {
    direction: "keep Server first-class",
    jenkins_job: "cloudbsd-iso",
    jenkins_number: "44",
    jenkins_url: "https://ci.example.invalid/job/cloudbsd-iso/44/",
  });
  assert.equal(target.customField11, "keep Server first-class");
  assert.equal(target.customField12, "cloudbsd-iso");
  assert.equal(target.customField13, 44);
  assert.equal(
    target.customField14,
    "https://ci.example.invalid/job/cloudbsd-iso/44/"
  );
  assert.equal(formatCustomFieldValue({ type: "Integer" }, "9"), 9);
});

test("relates_to aliases relates and same-edge matching is idempotent", () => {
  assert.equal(normalizeRelationType("relates_to"), "relates");
  assert.equal(normalizeRelationType("precedes"), "precedes");
  assert.throws(() => normalizeRelationType("duplicates"), /Unsupported relation type/);

  const relates = relation(1, "relates", 10, 20, "relates");
  assert.equal(isSameRelationEdge(relates, 20, 10, "relates"), true);

  const follows = relation(2, "follows", 20, 10, "precedes");
  assert.equal(isSameRelationEdge(follows, 10, 20, "precedes"), true);

  const blocked = relation(3, "blocked", 20, 10, "blocks");
  assert.equal(isSameRelationEdge(blocked, 10, 20, "blocks"), true);
  assert.equal(isSameRelationEdge(blocked, 10, 20, "precedes"), false);
});

test("createApi sends Basic apikey auth and surfaces API errors", async () => {
  const calls = [];
  const api = createApi({
    baseUrl: "https://trackdev.example.invalid",
    apiKey: "test-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: false,
        status: 422,
        statusText: "Unprocessable Entity",
        async text() {
          return '{"message":"invalid"}';
        },
      };
    },
  });

  await assert.rejects(
    () => api.request("/api/v3/work_packages/1"),
    /API Error: 422/
  );
  assert.equal(calls[0].url, "https://trackdev.example.invalid/api/v3/work_packages/1");
  assert.match(calls[0].init.headers.Authorization, /^Basic /);
  const decoded = Buffer.from(
    calls[0].init.headers.Authorization.slice(6),
    "base64"
  ).toString();
  assert.equal(decoded, "apikey:test-key");
  assert.equal(hrefId("/api/v3/work_packages/88"), "88");
});

function createOpenProjectMock(state) {
  return async function request(endpoint, method, body, options) {
    method = method || "GET";
    const path = String(endpoint).split("?")[0];
    const allow = (options && options.allowStatuses) || [];

    if (method === "GET" && path === "/api/v3/projects/cloudbsd") {
      return { id: 3, identifier: "cloudbsd", name: "CloudBSD" };
    }
    if (method === "GET" && path === "/api/v3/projects/cloudbsd/types") {
      return {
        _embedded: {
          elements: [
            { id: 4, name: "Ops" },
            { id: 2, name: "Feature" },
          ],
        },
      };
    }
    if (method === "GET" && path === "/api/v3/projects/cloudbsd/categories") {
      return {
        _embedded: {
          elements: [
            { id: 7, name: "Desktop" },
            { id: 8, name: "Server" },
          ],
        },
      };
    }
    if (method === "GET" && path === "/api/v3/statuses") {
      return {
        _embedded: {
          elements: [
            { id: 1, name: "New" },
            { id: 2, name: "In progress" },
            { id: 3, name: "Blocked" },
            { id: 4, name: "Done" },
          ],
        },
      };
    }
    if (method === "GET" && path === "/api/v3/work_packages/schemas/3-4") {
      return SCHEMA;
    }
    if (method === "GET" && path.startsWith("/api/v3/work_packages/") && path.endsWith("/relations")) {
      const fromId = path.split("/")[4];
      return {
        _embedded: {
          elements: state.relations.filter((item) => {
            const from = item._links.from.href.split("/").pop();
            const to = item._links.to.href.split("/").pop();
            return from === String(fromId) || to === String(fromId);
          }),
        },
      };
    }
    if (method === "GET" && path.startsWith("/api/v3/work_packages/")) {
      const id = path.split("/").pop();
      const wp = state.workPackages[id];
      if (!wp) {
        const error = new Error("API Error: 404 Not Found");
        error.status = 404;
        throw error;
      }
      return structuredClone(wp);
    }
    if (method === "GET" && path === "/api/v3/projects/cloudbsd/work_packages") {
      const query = new URL(endpoint, "https://op.example.invalid").searchParams;
      const filters = JSON.parse(query.get("filters") || "[]");
      const elements = Object.values(state.workPackages).filter((wp) => {
        return filters.every((filter) => {
          if (filter.subject) {
            return filter.subject.values.includes(wp.subject);
          }
          if (filter.category) {
            const href = wp._links.category && wp._links.category.href;
            return href && filter.category.values.includes(href.split("/").pop());
          }
          return true;
        });
      });
      return { _embedded: { elements: elements.map((item) => structuredClone(item)) } };
    }
    if (method === "POST" && path === "/api/v3/projects/cloudbsd/work_packages") {
      const id = state.nextId++;
      const wp = {
        id,
        subject: body.subject,
        lockVersion: 1,
        description: body.description || { format: "markdown", raw: "" },
        customField11: body.customField11,
        customField12: body.customField12,
        customField13: body.customField13,
        customField14: body.customField14,
        _links: {
          schema: { href: "/api/v3/work_packages/schemas/3-4" },
          type: { href: "/api/v3/types/4", title: "Ops" },
          status: { href: "/api/v3/statuses/1", title: "New" },
          category:
            body._links && body._links.category
              ? { href: body._links.category.href, title: "Server" }
              : undefined,
        },
      };
      state.workPackages[id] = wp;
      return structuredClone(wp);
    }
    if (method === "PATCH" && path.startsWith("/api/v3/work_packages/")) {
      const id = path.split("/").pop();
      const wp = state.workPackages[id];
      const { lockVersion, _links, ...rest } = body;
      Object.assign(wp, rest);
      if (_links) wp._links = { ...wp._links, ..._links };
      wp.lockVersion = (lockVersion || wp.lockVersion || 1) + 1;
      return structuredClone(wp);
    }
    if (method === "POST" && path.endsWith("/relations")) {
      const fromId = path.split("/")[4];
      const toId = body._links.to.href.split("/").pop();
      const exists = state.relations.some((item) =>
        isSameRelationEdge(item, fromId, toId, body.type)
      );
      if (exists) {
        if (allow.includes(409)) {
          return { _type: "Error", errorIdentifier: "urn:openproject-org:api:v3:errors:UpdateConflict" };
        }
        const error = new Error("API Error: 409 Conflict");
        error.status = 409;
        throw error;
      }
      const created = relation(state.nextRelationId++, body.type, fromId, toId, {
        relates: "relates",
        blocks: "blocked",
        precedes: "follows",
      }[body.type]);
      created.description = body.description || null;
      state.relations.push(created);
      return structuredClone(created);
    }

    throw new Error("Unexpected request: " + method + " " + endpoint);
  };
}

test("status_upsert creates then updates a Server lane work package", async () => {
  const state = { workPackages: {}, relations: [], nextId: 40, nextRelationId: 1 };
  const request = createOpenProjectMock(state);

  const created = await statusUpsert(request, {
    component: "Server",
    done: ["bhyve guest boots"],
    next: "wire status portal",
    direction: "keep Server first-class",
    jenkins_job: "cloudbsd-iso",
  });

  assert.equal(created.action, "created");
  assert.equal(created.component, "Server");
  assert.equal(created.subject, "Server");
  assert.equal(created.done, "- bhyve guest boots");
  assert.equal(created.next, "wire status portal");
  assert.equal(created.direction, "keep Server first-class");
  assert.equal(created.jenkins_job, "cloudbsd-iso");
  assert.equal(created.category, "Server");

  const updated = await statusUpsert(request, {
    lane: "Server",
    next: "publish status.cloudbsd.org",
    status: "In progress",
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, created.id);
  assert.equal(updated.done, "- bhyve guest boots");
  assert.equal(updated.next, "publish status.cloudbsd.org");
});

test("build_annotate writes jenkins_* custom fields", async () => {
  const state = {
    workPackages: {
      41: {
        id: 41,
        subject: "CI-Jenkins",
        lockVersion: 3,
        description: { raw: "" },
        _links: {
          schema: { href: "/api/v3/work_packages/schemas/3-4" },
          type: { href: "/api/v3/types/4", title: "Ops" },
          status: { href: "/api/v3/statuses/2", title: "In progress" },
        },
      },
    },
    relations: [],
    nextId: 50,
    nextRelationId: 1,
  };
  const request = createOpenProjectMock(state);
  const result = await buildAnnotate(request, {
    workPackageId: 41,
    jenkins_job: "cloudbsd-iso",
    jenkins_number: 18,
    jenkins_url: "https://ci.example.invalid/job/cloudbsd-iso/18/",
  });
  assert.equal(result.action, "updated");
  assert.equal(result.jenkins_job, "cloudbsd-iso");
  assert.equal(result.jenkins_number, 18);
  assert.equal(state.workPackages[41].customField13, 18);
});

test("relation_upsert is idempotent for relates_to and reverse precedes", async () => {
  const state = {
    workPackages: {},
    relations: [relation(9, "follows", 22, 11, "precedes")],
    nextId: 1,
    nextRelationId: 20,
  };
  const request = createOpenProjectMock(state);

  const existing = await relationUpsert(request, {
    fromId: 11,
    toId: 22,
    type: "precedes",
  });
  assert.equal(existing.action, "existing");
  assert.equal(existing.id, 9);

  const created = await relationUpsert(request, {
    from: 11,
    to: 33,
    type: "relates_to",
  });
  assert.equal(created.action, "created");
  assert.equal(created.type, "relates");

  const again = await relationUpsert(request, {
    fromId: 33,
    toId: 11,
    type: "relates",
  });
  assert.equal(again.action, "existing");
  assert.equal(again.id, created.id);
});
