/**
 * OpenProject 17.7.2 (Track) answers GET /api/v3/work_packages/:id/relations
 * with HTTP 308 to /api/v3/relations?filters=[{"involved":...}]. The MCP
 * must not follow that redirect (the Bearer would go with it). list_relations
 * and relation_upsert therefore GET the collection filter URL directly.
 * POST create stays on /api/v3/work_packages/:id/relations (POST
 * /api/v3/relations is 404 on this instance).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleWpRelatedTool } from "../lib/wp-related.js";
import { relationUpsert } from "../lib/cloudbsd-status.js";
import {
  fetchInvolvedRelations,
  relationInvolves,
  relationsCollectionHref,
  DEFAULT_RELATION_PAGE_SIZE,
} from "../lib/api.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function parseFilters(path) {
  const url = new URL(path, "https://op.example.invalid");
  return JSON.parse(url.searchParams.get("filters") || "[]");
}

function isWpRelationsPath(path, id) {
  return path === "/api/v3/work_packages/" + id + "/relations";
}

function redirectRefused(method, path) {
  const error = new Error(
    "OpenProject answered " + method + " " + path + " with a redirect (308); redirects are refused"
  );
  error.code = "REDIRECT_REFUSED";
  error.status = 308;
  return error;
}

function relationPayload(id, type, fromId, toId) {
  return {
    id,
    type,
    reverseType: type === "relates" ? "relates" : null,
    description: null,
    _links: {
      from: { href: "/api/v3/work_packages/" + fromId, title: "From " + fromId },
      to: { href: "/api/v3/work_packages/" + toId, title: "To " + toId },
    },
  };
}

test("list_relations GETs /api/v3/relations?filters=involved, not the work-package subresource", async () => {
  const calls = [];
  async function request(path, method = "GET") {
    calls.push({ method, path });
    if (method === "GET" && isWpRelationsPath(path, 2481)) {
      throw redirectRefused(method, path);
    }
    if (method === "GET" && path.startsWith("/api/v3/relations?")) {
      return { total: 1, _embedded: { elements: [relationPayload(859, "relates", 2481, 2480)] } };
    }
    throw new Error("unexpected " + method + " " + path);
  }

  const result = await handleWpRelatedTool("list_relations", { id: 2481 }, request);
  assert.deepEqual(result, [
    {
      id: 859,
      type: "relates",
      from: { id: 2481, name: "From 2481" },
      to: { id: 2480, name: "To 2480" },
      description: null,
    },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].path, /^\/api\/v3\/relations\?/);
  assert.deepEqual(parseFilters(calls[0].path), [
    { involved: { operator: "=", values: ["2481"] } },
  ]);
  assert.equal(new URL(calls[0].path, "https://op.example.invalid").searchParams.get("pageSize"), "100");
  assert.equal(
    calls.some((call) => isWpRelationsPath(call.path, 2481)),
    false
  );
});

test("relation_upsert lists via the collection filter and POSTs to the work-package relations path", async () => {
  const calls = [];
  const created = relationPayload(900, "relates", 2481, 2159);
  async function request(path, method = "GET", body) {
    calls.push({ method, path, body });
    if (method === "GET" && isWpRelationsPath(path, 2481)) {
      throw redirectRefused(method, path);
    }
    if (method === "GET" && path.startsWith("/api/v3/relations?")) {
      assert.deepEqual(parseFilters(path), [
        { involved: { operator: "=", values: ["2481"] } },
      ]);
      return { total: 1, _embedded: { elements: [relationPayload(859, "relates", 2481, 2480)] } };
    }
    if (method === "POST" && isWpRelationsPath(path, 2481)) {
      return created;
    }
    if (method === "POST" && path.split("?")[0] === "/api/v3/relations") {
      const error = new Error("API Error: 404 Not Found");
      error.status = 404;
      throw error;
    }
    throw new Error("unexpected " + method + " " + path);
  }

  const existing = await relationUpsert(request, { fromId: 2481, toId: 2480, type: "relates" });
  assert.equal(existing.action, "existing");
  assert.equal(existing.id, 859);

  const made = await relationUpsert(request, { fromId: 2481, toId: 2159, type: "relates" });
  assert.equal(made.action, "created");
  assert.equal(made.id, 900);

  const gets = calls.filter((call) => call.method === "GET");
  assert.ok(gets.length >= 2);
  for (const call of gets) {
    assert.match(call.path, /^\/api\/v3\/relations\?/);
    assert.equal(isWpRelationsPath(call.path, 2481), false);
  }
  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/api/v3/work_packages/2481/relations");
});

test("fetchInvolvedRelations walks every page so an edge on page 2 is found and not re-created", async () => {
  const calls = [];
  const page1 = relationPayload(1, "relates", 2481, 100);
  const page2 = relationPayload(2, "relates", 2481, 2480);
  async function request(path, method = "GET") {
    calls.push({ method, path });
    if (method === "GET" && isWpRelationsPath(path, 2481)) {
      throw redirectRefused(method, path);
    }
    if (method === "GET" && path.startsWith("/api/v3/relations?")) {
      const query = new URL(path, "https://op.example.invalid").searchParams;
      assert.deepEqual(parseFilters(path), [
        { involved: { operator: "=", values: ["2481"] } },
      ]);
      assert.equal(query.get("pageSize"), "100");
      const offset = query.get("offset") || "1";
      if (offset === "1") {
        return { total: 2, count: 1, pageSize: 1, offset: 1, _embedded: { elements: [page1] } };
      }
      if (offset === "2") {
        return { total: 2, count: 1, pageSize: 1, offset: 2, _embedded: { elements: [page2] } };
      }
      throw new Error("unexpected offset " + offset);
    }
    if (method === "POST") {
      throw new Error("must not POST when the edge is on page 2");
    }
    throw new Error("unexpected " + method + " " + path);
  }

  // The tools always request pageSize=100. The mock still returns total 2
  // with one element per page, so the walker must request offset=2 because
  // seen < total — not because we asked for pageSize 1.
  const listed = await handleWpRelatedTool("list_relations", { id: 2481 }, request);
  assert.deepEqual(listed.map((r) => r.id), [1, 2]);
  assert.equal(calls.filter((c) => c.method === "GET").length, 2);

  const existing = await relationUpsert(request, { fromId: 2481, toId: 2480, type: "relates" });
  assert.equal(existing.action, "existing");
  assert.equal(existing.id, 2);
  assert.equal(calls.some((c) => c.method === "POST"), false);
});

test("fetchInvolvedRelations honours pageSize and finds an edge on page 2", async () => {
  const calls = [];
  const page1 = relationPayload(1, "relates", 2481, 100);
  const page2 = relationPayload(2, "relates", 2481, 2480);
  async function request(path, method = "GET") {
    calls.push({ method, path });
    const query = new URL(path, "https://op.example.invalid").searchParams;
    assert.equal(query.get("pageSize"), "1");
    const offset = query.get("offset") || "1";
    if (offset === "1") {
      return { total: 2, count: 1, pageSize: 1, offset: 1, _embedded: { elements: [page1] } };
    }
    if (offset === "2") {
      return { total: 2, count: 1, pageSize: 1, offset: 2, _embedded: { elements: [page2] } };
    }
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481, { pageSize: 1 });
  assert.deepEqual(listed.map((relation) => relation.id), [1, 2]);
  assert.equal(calls.length, 2);
});

test("fetchInvolvedRelations drops relations that do not involve the work package", async () => {
  async function request() {
    return {
      total: 2,
      pageSize: 100,
      _embedded: {
        elements: [
          relationPayload(859, "relates", 2481, 2480),
          relationPayload(860, "relates", 100, 101),
        ],
      },
    };
  }
  const listed = await fetchInvolvedRelations(request, 2481);
  assert.deepEqual(listed.map((relation) => relation.id), [859]);
});

test("fetchInvolvedRelations throws when the server repeats a page before total is reached", async () => {
  const calls = [];
  const page = Array.from({ length: 100 }, (_, i) => relationPayload(i + 1, "relates", 2481, 3000 + i));
  async function request(path) {
    calls.push(path);
    return { total: 150, count: 100, pageSize: 100, _embedded: { elements: page } };
  }
  await assert.rejects(
    () => fetchInvolvedRelations(request, 2481),
    (error) =>
      error.code === "RELATIONS_INCOMPLETE" &&
      /Nothing was written/i.test(error.message) &&
      /repeated a page/.test(error.message)
  );
  assert.ok(calls.length <= 2, "must not keep requesting a page that did not advance");
});

test("fetchInvolvedRelations throws when a page is empty before total is reached, and upsert does not POST", async () => {
  const calls = [];
  const page = Array.from({ length: 100 }, (_, i) => relationPayload(i + 1, "relates", 2481, 3000 + i));
  async function request(path, method = "GET") {
    calls.push({ method, path });
    if (method === "POST") throw new Error("must not POST from a partial list");
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") {
      return { total: 150, count: 100, pageSize: 100, _embedded: { elements: page } };
    }
    return { total: 150, count: 0, pageSize: 100, _embedded: { elements: [] } };
  }
  await assert.rejects(
    () => fetchInvolvedRelations(request, 2481),
    (error) =>
      error.code === "RELATIONS_INCOMPLETE" &&
      /empty page/.test(error.message) &&
      !/repeated a page/.test(error.message)
  );
  assert.equal(calls.filter((call) => call.method === "GET").length, 2);
  await assert.rejects(
    () => relationUpsert(request, { fromId: 2481, toId: 2480, type: "relates" }),
    (error) => error.code === "RELATIONS_INCOMPLETE"
  );
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("fetchInvolvedRelations keeps a relation whose href sits under a path prefix", async () => {
  async function request() {
    return {
      total: 1,
      pageSize: 100,
      _embedded: {
        elements: [
          {
            id: 859,
            type: "relates",
            _links: {
              from: { href: "/openproject/api/v3/work_packages/2481", title: "From 2481" },
              to: { href: "https://op.example.invalid/openproject/api/v3/work_packages/2480", title: "To 2480" },
            },
          },
        ],
      },
    };
  }
  const listed = await fetchInvolvedRelations(request, 2481);
  assert.deepEqual(listed.map((relation) => relation.id), [859]);
});

test("fetchInvolvedRelations walks a capped page when total is omitted", async () => {
  const calls = [];
  const page1 = Array.from({ length: 25 }, (_, i) => relationPayload(i + 1, "relates", 2481, 4000 + i));
  const page2 = Array.from({ length: 25 }, (_, i) => relationPayload(i + 26, "relates", 2481, 5000 + i));
  async function request(path) {
    calls.push(path);
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") {
      return { pageSize: 25, count: 25, _embedded: { elements: page1 }, _links: { next: { href: "/api/v3/relations?offset=2" } } };
    }
    if (offset === "2") {
      return { pageSize: 25, count: 25, _embedded: { elements: page2 } };
    }
    if (offset === "3") {
      return { pageSize: 25, count: 0, _embedded: { elements: [] } };
    }
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481);
  assert.equal(listed.length, 50);
  assert.equal(calls.length, 3);
});

test("fetchInvolvedRelations walks a full capped page with no total and no next link", async () => {
  const calls = [];
  const page1 = Array.from({ length: 25 }, (_, i) => relationPayload(i + 1, "relates", 2481, 4000 + i));
  const page2 = Array.from({ length: 10 }, (_, i) => relationPayload(i + 26, "relates", 2481, 5000 + i));
  async function request(path) {
    calls.push(path);
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") {
      return { pageSize: 25, count: 25, _embedded: { elements: page1 } };
    }
    if (offset === "2") {
      return { pageSize: 25, count: 10, _embedded: { elements: page2 } };
    }
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481);
  assert.equal(listed.length, 35);
  assert.equal(calls.length, 2);
});

test("fetchInvolvedRelations throws RELATIONS_INCOMPLETE rather than returning a partial list", async () => {
  const calls = [];
  async function request(path) {
    calls.push(path);
    const offset = Number(new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1");
    const start = (offset - 1) * 25 + 1;
    const elements = Array.from({ length: 25 }, (_, i) => relationPayload(start + i, "relates", 2481, 8000 + start + i));
    return { total: 10000, count: 25, pageSize: 25, offset, _embedded: { elements } };
  }
  await assert.rejects(
    () => fetchInvolvedRelations(request, 2481, { maxPages: 3, pageSize: 100 }),
    (error) =>
      error.code === "RELATIONS_INCOMPLETE" &&
      /Nothing was written/i.test(error.message) &&
      /3 pages/.test(error.message) &&
      /75/.test(error.message)
  );
  assert.equal(calls.length, 3);
});


test("fetchInvolvedRelations treats a bare array payload as not a collection", async () => {
  await assert.rejects(
    () => fetchInvolvedRelations(async () => [relationPayload(1, "relates", 2481, 2480)], 2481),
    (error) => error.code === "RELATIONS_INCOMPLETE" && /not return a relations collection/.test(error.message)
  );
});

test("fetchInvolvedRelations throws when the payload is not a collection, and upsert does not POST", async () => {
  const calls = [];
  async function request(path, method = "GET") {
    calls.push({ method, path });
    if (method === "POST") throw new Error("must not POST from a non-collection body");
    return {};
  }
  await assert.rejects(
    () => fetchInvolvedRelations(request, 2481),
    (error) => error.code === "RELATIONS_INCOMPLETE" && /not return a relations collection/.test(error.message)
  );
  await assert.rejects(
    () => relationUpsert(request, { fromId: 2481, toId: 2480, type: "relates" }),
    (error) => error.code === "RELATIONS_INCOMPLETE"
  );
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("fetchInvolvedRelations throws when a full page repeats and total is omitted", async () => {
  const calls = [];
  const page = Array.from({ length: 100 }, (_, i) => relationPayload(i + 1, "relates", 2481, 3000 + i));
  async function request(path, method = "GET") {
    calls.push({ method, path });
    if (method === "POST") throw new Error("must not POST from a partial list");
    return { count: 100, pageSize: 100, _embedded: { elements: page } };
  }
  await assert.rejects(
    () => fetchInvolvedRelations(request, 2481),
    (error) => error.code === "RELATIONS_INCOMPLETE" && /repeated a page/.test(error.message)
  );
  await assert.rejects(
    () => relationUpsert(request, { fromId: 2481, toId: 9999, type: "relates" }),
    (error) => error.code === "RELATIONS_INCOMPLETE"
  );
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("fetchInvolvedRelations throws when the same id-less page is repeated before total is reached", async () => {
  const rel = { type: "relates", _links: { from: { href: "/api/v3/work_packages/2481", title: "A" }, to: { href: "/api/v3/work_packages/100", title: "B" } } };
  const other = { type: "relates", _links: { from: { href: "/api/v3/work_packages/2481", title: "A" }, to: { href: "/api/v3/work_packages/101", title: "C" } } };
  async function request(path) {
    return { total: 3, pageSize: 2, _embedded: { elements: [rel, other] } };
  }
  await assert.rejects(
    () => fetchInvolvedRelations(request, 2481, { pageSize: 2 }),
    (error) => error.code === "RELATIONS_INCOMPLETE" && /repeated a page/.test(error.message)
  );
});

test("fetchInvolvedRelations does not treat distinct id-less pages as a repeat", async () => {
  const page1 = { type: "relates", _links: { from: { href: "/api/v3/work_packages/2481", title: "A" }, to: { href: "/api/v3/work_packages/100", title: "B" } } };
  const page2 = { type: "relates", _links: { from: { href: "/api/v3/work_packages/2481", title: "C" }, to: { href: "/api/v3/work_packages/101", title: "D" } } };
  async function request(path) {
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") return { total: 2, pageSize: 1, _embedded: { elements: [page1] } };
    if (offset === "2") return { total: 2, pageSize: 1, _embedded: { elements: [page2] } };
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481, { pageSize: 1 });
  assert.equal(listed.length, 2);
});

test("fetchInvolvedRelations keeps walking when overlapping pages would over-count total", async () => {
  const one = relationPayload(1, "relates", 2481, 100);
  const two = relationPayload(2, "relates", 2481, 101);
  const three = relationPayload(3, "relates", 2481, 102);
  async function request(path) {
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") return { total: 3, pageSize: 1, _embedded: { elements: [one] } };
    if (offset === "2") return { total: 3, pageSize: 1, _embedded: { elements: [one, two] } };
    if (offset === "3") return { total: 3, pageSize: 1, _embedded: { elements: [three] } };
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481, { pageSize: 1 });
  assert.deepEqual(listed.map((relation) => relation.id), [1, 2, 3]);
});

test("fetchInvolvedRelations does not treat a short first page as complete when pageSize is omitted", async () => {
  const calls = [];
  const page1 = Array.from({ length: 25 }, (_, i) => relationPayload(i + 1, "relates", 2481, 4000 + i));
  const page2 = Array.from({ length: 5 }, (_, i) => relationPayload(i + 26, "relates", 2481, 5000 + i));
  async function request(path) {
    calls.push(path);
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") return { _embedded: { elements: page1 } };
    if (offset === "2") return { _embedded: { elements: page2 } };
    if (offset === "3") return { _embedded: { elements: [] } };
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481);
  assert.equal(listed.length, 30);
  assert.ok(calls.length >= 2);
});

test("fetchInvolvedRelations dedupes the same relation id across pages", async () => {
  const one = relationPayload(1, "relates", 2481, 100);
  const two = relationPayload(2, "relates", 2481, 101);
  async function request(path) {
    const offset = new URL(path, "https://op.example.invalid").searchParams.get("offset") || "1";
    if (offset === "1") return { total: 2, pageSize: 1, _embedded: { elements: [one] } };
    if (offset === "2") return { total: 2, pageSize: 1, _embedded: { elements: [one, two] } };
    throw new Error("unexpected offset " + offset);
  }
  const listed = await fetchInvolvedRelations(request, 2481, { pageSize: 1 });
  assert.deepEqual(listed.map((relation) => relation.id), [1, 2]);
});

const hrefHelper = fileURLToPath(new URL("../scripts/relations-collection-href.js", import.meta.url));

function runHrefHelper(args, options = {}) {
  return spawnSync(process.execPath, [hrefHelper, ...args], {
    encoding: "utf8",
    timeout: 10000,
    ...options,
  });
}

test("relations-collection-href prints the same first-page URL the MCP builds", () => {
  const result = runHrefHelper(["2481"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, relationsCollectionHref(2481, { pageSize: String(DEFAULT_RELATION_PAGE_SIZE) }) + "\n");
});

test("relations-collection-href --check-collection-body uses relationInvolves", () => {
  const dir = mkdtempSync(join(tmpdir(), "relations-href-"));
  try {
    const involved = join(dir, "involved.json");
    const foreign = join(dir, "foreign.json");
    const empty = join(dir, "empty.json");
    const notCollection = join(dir, "bare.json");
    const notJson = join(dir, "plain.txt");
    writeFileSync(
      involved,
      JSON.stringify({
        _type: "Collection",
        _embedded: { elements: [relationPayload(859, "relates", 2481, 2480)] },
      })
    );
    writeFileSync(
      foreign,
      JSON.stringify({
        _type: "Collection",
        _embedded: { elements: [relationPayload(860, "relates", 100, 101)] },
      })
    );
    writeFileSync(empty, JSON.stringify({ _type: "Collection", _embedded: { elements: [] } }));
    writeFileSync(notCollection, JSON.stringify({}));
    writeFileSync(notJson, "<html>login</html>");
    const ok = runHrefHelper(["--check-collection-body", "2481", involved]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /^elements=1\n$/);
    assert.equal(relationInvolves(relationPayload(859, "relates", 2481, 2480), "2481"), true);
    const bad = runHrefHelper(["--check-collection-body", "2481", foreign]);
    assert.equal(bad.status, 1);
    const zero = runHrefHelper(["--check-collection-body", "2481", empty]);
    assert.equal(zero.status, 0, zero.stderr);
    assert.match(zero.stdout, /^elements=0\n$/);
    const bare = runHrefHelper(["--check-collection-body", "2481", notCollection]);
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /not a collection/);
    const html = runHrefHelper(["--check-collection-body", "2481", notJson]);
    assert.equal(html.status, 1);
    assert.match(html.stderr, /not JSON/);
    assert.match(html.stderr, /TRACK_CURL_CONFIG/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const probeScript = fileURLToPath(new URL("../scripts/check-relations-endpoints.sh", import.meta.url));

function writeCurlConfig(dir, body) {
  const file = join(dir, "curl.config");
  writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function runProbe(args, env) {
  return spawnSync("sh", [probeScript, ...args], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ...env },
  });
}

test("check-relations-endpoints refuses a non-integer id and a curl config that sets a url", () => {
  const dir = mkdtempSync(join(tmpdir(), "relations-probe-"));
  try {
    const okConfig = writeCurlConfig(dir, 'silent = true\nheader = "Authorization: Bearer dummy"\n');
    const badId = runProbe(["12abc"], { TRACK_CURL_CONFIG: okConfig, TRACK_API_BASE: "https://example.invalid" });
    assert.equal(badId.status, 2);
    assert.match(badId.stderr, /positive integer/);
    const missingId = runProbe([], { TRACK_CURL_CONFIG: okConfig, TRACK_API_BASE: "https://example.invalid" });
    assert.equal(missingId.status, 2);
    assert.match(missingId.stderr, /required/);
    for (const body of [
      'silent = true\nheader = "Authorization: Bearer dummy"\nurl = "https://evil.example/"\n',
      'silent = true\nheader = "Authorization: Bearer dummy"\nurl "https://evil.example/"\n',
      'silent = true\nheader = "Authorization: Bearer dummy"\n--url=https://evil.example/\n',
    ]) {
      const cfg = writeCurlConfig(dir, body);
      const result = runProbe(["2481"], { TRACK_CURL_CONFIG: cfg, TRACK_API_BASE: "https://example.invalid" });
      assert.equal(result.status, 2, result.stderr);
      assert.match(result.stderr, /directive other than silent, header/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
