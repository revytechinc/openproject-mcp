/**
 * Review fixes for Track #1677 (items 2-11). Fakes only: no network host is
 * contacted (the redirect test uses a loopback http.Server).
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../lib/server.js";
import { createApi } from "../lib/api.js";
import { validateCallerToken } from "../lib/auth-context.js";
import { createWebSession } from "../lib/web-session.js";
import { allHints, toolErrorObject } from "../lib/errors.js";
import { RAW_API_TOOL, TYPED_TOOL_PATTERNS } from "../lib/raw-api.js";
import { createHttpServer, readJsonBody } from "../http.js";
import { createSessionHub } from "../lib/session-hub.js";
import { handleWpQueryTool } from "../lib/wp-query.js";
import { handleWpUpdateTool } from "../lib/wp-update.js";
import { handleProjectAdminTool } from "../lib/project-admin.js";
import { checkArgs, parseId, projectSegment } from "../lib/tool-args.js";
import { fakeApi, httpError, STATUSES, workPackage, applyPatch, collection } from "./fake-op.js";

const ROOT = "https://op.example.invalid";
const OPTIONS = { baseUrl: ROOT };
const LIB = new URL("../lib/", import.meta.url);
const LIB_SOURCES = readdirSync(LIB)
  .filter((file) => file.endsWith(".js"))
  .map((file) => [file, readFileSync(new URL(file, LIB), "utf8")]);

function jsonResponse(status, body) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(),
    async text() {
      return text;
    },
    async json() {
      return JSON.parse(text);
    },
  };
}

function fakeFetch(reply = () => jsonResponse(200, { _embedded: { elements: [] } })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

/** A fetch that never answers until its signal aborts. */
function hangingFetch() {
  const calls = [];
  const fn = (url, init) => {
    calls.push({ url: String(url), init });
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("This operation was aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  };
  fn.calls = calls;
  return fn;
}

/**
 * A fetch whose server answers 302 to a foreign host. It behaves like
 * undici: redirect "error" throws, "manual" returns the 302, and the
 * default "follow" lands on the foreign host (which would see the token).
 */
function redirectingFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (init.redirect === "error") {
      throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
    }
    if (init.redirect === "manual") {
      return { ...jsonResponse(302, undefined), headers: new Headers({ location: "https://evil.example/" }) };
    }
    return jsonResponse(200, { id: 666, login: "evil" });
  };
  fn.calls = calls;
  return fn;
}

async function withEnv(name, value, fn) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

async function connected(fetchImpl) {
  const server = createMcpServer({ baseUrl: ROOT, getApiKey: () => "tok", fetchImpl });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

function errorOf(result) {
  assert.equal(result.isError, true, JSON.stringify(result));
  return JSON.parse(result.content[0].text).error;
}

function filtersOf(call) {
  const value = new URL(call.path, "https://x.invalid").searchParams.get("filters");
  return value == null ? null : JSON.parse(value);
}

function param(call, name) {
  return new URL(call.path, "https://x.invalid").searchParams.get(name);
}

// ---- item 2: seg() for every path segment ----------------------------------

test("lib sources never concatenate args, or an unchecked value, into a path", () => {
  const bad = [];
  for (const [file, src] of LIB_SOURCES) {
    src.split("\n").forEach((line, index) => {
      const where = file + ":" + (index + 1) + ": " + line.trim();
      if (/"\/api\/v3\/[^"]*"\s*\+\s*args\b/.test(line)) bad.push(where);
      if (/\+\s*args\./.test(line)) bad.push(where);
      // A literal path ending in "/" may only be followed by seg(...) or
      // projectSegment(...), which delegates to seg.
      for (const match of line.matchAll(/(["'])\/[^"']*\/\1\s*\+(?!\s*(?:seg|projectSegment)\()/g)) {
        bad.push(where + "  <" + match[0] + ">");
      }
      if (/`[^`]*\/\$\{(?!\s*(?:seg|projectSegment)\()/.test(line)) bad.push(where);
    });
  }
  assert.deepEqual(bad, []);
});

test("parseId and projectSegment delegate to seg (code INVALID_ID; identifiers lowercase)", () => {
  assert.equal(parseId(1677), 1677);
  assert.equal(parseId("#1677"), 1677);
  assert.equal(projectSegment("cloudbsd"), "cloudbsd");
  assert.equal(projectSegment(3), "3");
  for (const bad of ["1/../2", "5?x=", "0", "1.5", ""]) {
    assert.throws(() => parseId(bad), (e) => e.code === "INVALID_ID", bad);
  }
  for (const bad of ["CloudBSD", "../users", "a?b", "a/b", ""]) {
    assert.throws(() => projectSegment(bad), (e) => e.code === "INVALID_ID", bad);
  }
});

function idCases(bad) {
  return [
    ["get_work_package", { id: bad }],
    ["update_work_package", { id: bad, subject: "x" }],
    ["update_work_package", { id: 1, parentId: bad }],
    ["update_work_package", { id: 1, versionId: bad }],
    ["set_status", { id: bad, status: "Done" }],
    ["validate_update", { id: bad, subject: "x" }],
    ["add_comment", { id: bad, comment: "x" }],
    ["list_activities", { id: bad }],
    ["edit_comment", { activityId: bad, comment: "x" }],
    ["list_relations", { id: bad }],
    ["delete_relation", { relationId: bad, confirm: true }],
    ["list_watchers", { id: bad }],
    ["add_watcher", { id: bad, userId: 1 }],
    ["list_time_entries", { id: bad }],
    ["get_children", { parentId: bad }],
    ["get_user", { userId: bad }],
    ["log_time", { workPackageId: bad, hours: 1 }],
    ["log_time", { workPackageId: 1, hours: 1, activityId: bad }],
    ["get_status", { id: bad }],
    ["update_status", { id: bad, name: "x" }],
    ["build_annotate", { workPackageId: bad, jenkins_job: "j" }],
    ["relation_upsert", { fromId: bad, toId: 2, type: "relates" }],
    ["relation_upsert", { fromId: 1, toId: bad, type: "relates" }],
    ["status_upsert", { id: bad }],
    ["status_upsert", { component: "Server", projectId: bad }],
    ["list_work_packages", { projectId: bad }],
    ["list_work_packages", { parentId: bad }],
    ["create_work_package", { projectId: bad, subject: "x" }],
    ["create_work_packages", { projectId: bad, items: [{ subject: "x" }] }],
    ["get_project", { project: bad }],
    ["create_project", { name: "n", identifier: "n", parentId: bad }],
    ["list_project_types", { project: bad }],
    ["list_versions", { project: bad }],
    ["create_version", { project: bad, name: "v" }],
    ["list_memberships", { project: bad }],
    ["add_membership", { project: bad, userId: 1, roles: ["Member"] }],
  ];
}

test('tools refuse ids like "1/../../projects/x" and "5?x=" with INVALID_ID before any request', async () => {
  for (const bad of ["1/../../projects/x", "5?x="]) {
    const f = fakeFetch();
    const { client, server } = await connected(f);
    try {
      for (const [name, args] of idCases(bad)) {
        const error = errorOf(await client.callTool({ name, arguments: args }));
        assert.equal(error.code, "INVALID_ID", name + " " + JSON.stringify(args) + " -> " + JSON.stringify(error));
        assert.deepEqual(f.calls.map((c) => c.url), [], name + " sent a request");
      }
    } finally {
      await server.close();
    }
  }
});

// ---- item 3: descriptions and hints name only registered tools ---------------

test("every tool named in a description or hint is in the ListTools registry", async () => {
  const { client, server } = await connected(fakeFetch());
  try {
    const { tools } = await client.listTools();
    const names = new Set(tools.map((tool) => tool.name));
    const verbs = new Set([...names].map((name) => name.split("_")[0]));
    for (const verb of ["search", "remove", "move", "assign", "close", "read", "write", "upsert"]) verbs.add(verb);
    const texts = [];
    const walk = (node, where) => {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") texts.push([where, value]);
        else walk(value, where);
      }
    };
    for (const tool of tools) walk(tool, tool.name);
    for (const pattern of TYPED_TOOL_PATTERNS) {
      assert.ok(names.has(pattern.tool), "raw_api_call hint names a tool that does not exist: " + pattern.tool);
      texts.push(["raw-api hint", pattern.tool]);
    }
    for (const hint of allHints()) texts.push(["errors.js hint", hint]);
    const missing = [];
    for (const [where, text] of texts) {
      for (const match of text.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
        if (verbs.has(match[0].split("_")[0]) && !names.has(match[0])) missing.push(where + ": " + match[0]);
      }
    }
    assert.deepEqual(missing, []);
    const raw = tools.find((tool) => tool.name === "raw_api_call");
    assert.equal(raw.description, RAW_API_TOOL.description, "raw_api_call is defined in lib/raw-api.js");
  } finally {
    await server.close();
  }
});

// ---- item 4: timeouts and redirects -----------------------------------------

test("users/me validation times out (OPENPROJECT_TIMEOUT_MS) instead of hanging", async () => {
  await withEnv("OPENPROJECT_TIMEOUT_MS", "20", async () => {
    const f = hangingFetch();
    const result = await validateCallerToken(ROOT, "tok", f);
    assert.equal(result.ok, false);
    assert.equal(result.unavailable, true);
    assert.equal(result.code, "TIMEOUT");
    assert.equal(f.calls[0].init.redirect, "error");
  });
});

test("users/me answering 302 is refused with REDIRECT_REFUSED", async () => {
  const f = redirectingFetch();
  const result = await validateCallerToken(ROOT, "tok", f);
  assert.equal(result.ok, false);
  assert.equal(result.code, "REDIRECT_REFUSED");
  assert.equal(f.calls.length, 1);
});

test("api.js sets redirect: error and reports a 302 as REDIRECT_REFUSED", async () => {
  const f = redirectingFetch();
  const api = createApi({ baseUrl: ROOT, getApiKey: () => "tok", fetchImpl: f });
  await assert.rejects(() => api.request("/api/v3/projects"), (e) => e.code === "REDIRECT_REFUSED");
  assert.equal(f.calls[0].init.redirect, "error");
  // A fetch that hands back the 3xx anyway is refused too.
  const manual = fakeFetch(() => jsonResponse(302, undefined));
  const api2 = createApi({ baseUrl: ROOT, getApiKey: () => "tok", fetchImpl: manual });
  await assert.rejects(() => api2.request("/api/v3/projects"), (e) => e.code === "REDIRECT_REFUSED");
});

test("api.js with the real fetch refuses a loopback 302 (REDIRECT_REFUSED)", async () => {
  let hits = 0;
  const target = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const origin = http.createServer((req, res) => {
    res.writeHead(302, { Location: "http://127.0.0.1:" + target.address().port + "/stolen" });
    res.end();
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  try {
    const api = createApi({ baseUrl: "http://127.0.0.1:" + origin.address().port, getApiKey: () => "tok" });
    await assert.rejects(() => api.request("/api/v3/projects"), (e) => e.code === "REDIRECT_REFUSED");
    assert.equal(hits, 0, "the redirect target was never contacted");
  } finally {
    await new Promise((r) => origin.close(r));
    await new Promise((r) => target.close(r));
  }
});

test("web-session requests time out like api.js", async () => {
  await withEnv("OPENPROJECT_TIMEOUT_MS", "20", async () => {
    const f = hangingFetch();
    const session = createWebSession({
      baseUrl: ROOT,
      fetchImpl: f,
      getCredentials: () => ({ username: "u", password: "p" }),
    });
    await assert.rejects(() => session.ensureLogin(), (e) => e.code === "TIMEOUT");
    assert.ok(f.calls[0].init.signal, "a signal is passed");
  });
});

test("web-session refuses a redirect off the OpenProject origin with REDIRECT_REFUSED", async () => {
  const f = fakeFetch((url) => {
    if (url.endsWith("/login")) {
      return {
        status: 200,
        headers: new Headers(),
        async text() {
          return '<meta name="csrf-token" content="tok">';
        },
      };
    }
    return { status: 302, headers: new Headers({ location: "https://evil.example/x" }), async text() { return ""; } };
  });
  const session = createWebSession({ baseUrl: ROOT, fetchImpl: f, getCredentials: () => ({ username: "u", password: "p" }) });
  await assert.rejects(() => session.ensureLogin(), (e) => e.code === "REDIRECT_REFUSED");
  assert.ok(f.calls.every((c) => new URL(c.url).origin === ROOT));
});

// ---- item 5: http.js -----------------------------------------------------------

test("readJsonBody stops reading once the limit is exceeded (no draining)", async () => {
  let yielded = 0;
  const req = {
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < 20; i++) {
        yielded += 1;
        yield Buffer.alloc(512 * 1024, 97);
      }
    },
  };
  await assert.rejects(() => readJsonBody(req), (e) => e.statusCode === 413);
  assert.ok(yielded <= 3, "read " + yielded + " chunks after the 1 MiB limit");
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("a chunked body with no Content-Length over 1 MiB gets 413 and the request is destroyed", async () => {
  const { server } = createHttpServer({
    baseUrl: ROOT,
    validateToken: async () => ({ ok: true, user: { id: 1, login: "a" } }),
  });
  const port = await listen(server);
  const TOTAL = 64 * 1024 * 1024;
  try {
    const outcome = await new Promise((resolve) => {
      const state = { status: null, error: null, written: 0, finished: false };
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
      });
      assert.equal(req.getHeader("content-length"), undefined);
      req.on("response", (res) => {
        state.status = res.statusCode;
        res.resume();
      });
      req.on("error", (error) => {
        state.error = error.code || error.message;
      });
      req.on("finish", () => {
        state.finished = true;
      });
      req.on("close", () => resolve(state));
      const chunk = Buffer.alloc(64 * 1024, 97);
      const pump = () => {
        while (state.written < TOTAL && !req.destroyed) {
          state.written += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        if (!req.destroyed) req.end();
      };
      pump();
    });
    assert.ok(outcome.status === 413 || outcome.error, JSON.stringify(outcome));
    if (outcome.status !== null) assert.equal(outcome.status, 413);
    assert.ok(outcome.written < TOTAL, "server drained the whole body: " + JSON.stringify(outcome));
    assert.equal(outcome.finished, false);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

function getMcp(port, sessionId, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "GET",
        path: "/mcp",
        headers: { Authorization: "Bearer t", "mcp-session-id": sessionId, ...extraHeaders },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("session lastSeen is refreshed only after the identity check passes", async () => {
  const hub = createSessionHub();
  hub.register("s1", {
    sessionId: "s1",
    userId: 1,
    login: "a",
    lastSeen: 1000,
    activeStreams: 0,
    server: { async sendLoggingMessage() {} },
    transport: {
      async handleRequest(req, res) {
        res.writeHead(204);
        res.end();
      },
      async close() {},
    },
  });
  let caller = { id: 2, login: "b" };
  const { server } = createHttpServer({ baseUrl: ROOT, hub, validateToken: async () => ({ ok: true, user: caller }) });
  const port = await listen(server);
  try {
    assert.equal(await getMcp(port, "s1"), 403);
    assert.equal(hub.get("s1").lastSeen, 1000, "a refused caller must not keep the session alive");
    caller = { id: 1, login: "a" };
    assert.equal(await getMcp(port, "s1", { Authorization: "Bearer other" }), 204);
    assert.ok(hub.get("s1").lastSeen > 1000);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- item 6: duplicate detection and a stricter fake --------------------------

test("fake-op rejects operator/filter pairs that OpenProject rejects (400)", async () => {
  const { request } = fakeApi([{ method: "GET", path: "/api/v3/work_packages", reply: collection([]) }]);
  const send = (filters) => request("/api/v3/work_packages?filters=" + encodeURIComponent(JSON.stringify(filters)));
  for (const filters of [
    [{ subject: { operator: "=", values: ["x"] } }],
    [{ description: { operator: "=", values: ["x"] } }],
    [{ status: { operator: "~", values: ["x"] } }],
    [{ search: { operator: "~", values: ["x"] } }],
    [{ id: { operator: "~", values: ["1"] } }],
    [{ parent: { operator: "o", values: [] } }],
    [{ assignee: { operator: "**", values: ["me"] } }],
  ]) {
    await assert.rejects(() => send(filters), (e) => e.status === 400, JSON.stringify(filters));
  }
  for (const filters of [
    [{ subject: { operator: "~", values: ["x"] } }],
    [{ subject: { operator: "!*", values: [] } }],
    [{ status: { operator: "o", values: [] } }],
    [{ search: { operator: "**", values: ["x"] } }],
    [{ parent: { operator: "!*", values: [] } }],
    [{ assignee: { operator: "=", values: ["me"] } }],
  ]) {
    await send(filters);
  }
});

const PROJECT = { id: 3, identifier: "cloudbsd", name: "CloudBSD", active: true, public: false, _links: { parent: { href: null } } };
const PROJECT_TYPES = collection([
  { id: 4, name: "Ops" },
  { id: 2, name: "Feature" },
]);

test("dedupeBy subject: ~ filter in the project itself, exact subject and parent checked client-side", async () => {
  let nextId = 3000;
  const existing = [
    workPackage({ id: 2001, subject: "Root task", _links: { parent: { href: "/api/v3/work_packages/1600" } } }),
    workPackage({ id: 2002, subject: "Root task (copy)", _links: { parent: { href: null } } }),
    workPackage({ id: 2003, subject: "Child task", _links: { parent: { href: "/api/v3/work_packages/1600" } } }),
    workPackage({ id: 2004, subject: "Top", _links: { parent: { href: null } } }),
  ];
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd", reply: PROJECT },
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    {
      method: "GET",
      path: "/api/v3/work_packages",
      reply: ({ query: q }) => {
        const filters = JSON.parse(q.get("filters"));
        const text = filters.find((f) => f.subject).subject.values[0].toLowerCase();
        const parent = filters.find((f) => f.parent);
        return collection(
          existing.filter(
            (wp) =>
              wp.subject.toLowerCase().includes(text) &&
              (!parent || (wp._links.parent.href || "").endsWith("/" + parent.parent.values[0]))
          )
        );
      },
    },
    { method: "POST", path: "/api/v3/projects/cloudbsd/work_packages", reply: ({ body }) => workPackage({ id: nextId++, subject: body.subject }) },
  ]);
  const result = await handleWpQueryTool(
    "create_work_packages",
    {
      projectId: "cloudbsd",
      dedupeBy: "subject",
      items: [
        { subject: "Root task" }, // only exists under 1600 and as a longer subject: create
        { subject: "Child task", parentId: 1600 }, // exists: reuse
        { subject: "Top" }, // exists at the top level: reuse
      ],
    },
    request,
    OPTIONS
  );
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.created, [{ index: 0, id: 3000 }]);
  assert.deepEqual(result.existing, [
    { index: 1, id: 2003 },
    { index: 2, id: 2004 },
  ]);
  const lookups = calls.filter((c) => c.method === "GET" && c.path.startsWith("/api/v3/work_packages?"));
  assert.equal(lookups.length, 3);
  for (const call of lookups) assert.equal(param(call, "pageSize"), "50");
  assert.deepEqual(filtersOf(lookups[0]), [
    { project: { operator: "=", values: ["3"] } },
    { subject: { operator: "~", values: ["Root task"] } },
    { status: { operator: "*", values: [] } },
  ]);
  assert.deepEqual(filtersOf(lookups[1]), [
    { project: { operator: "=", values: ["3"] } },
    { subject: { operator: "~", values: ["Child task"] } },
    { parent: { operator: "=", values: ["1600"] } },
    { status: { operator: "*", values: [] } },
  ]);
  assert.equal(
    calls.some((c) => c.method === "GET" && c.path.startsWith("/api/v3/projects/cloudbsd/work_packages")),
    false,
    "the project collection (which includes subprojects) is not searched"
  );
});

// ---- item 7: user lookup by login through principals ---------------------------

test("find_user by login goes through /principals and matches exactly client-side", async () => {
  const { request, calls } = fakeApi([
    {
      method: "GET",
      path: "/api/v3/principals",
      reply: collection([
        { _type: "User", id: 7, name: "Mark LaPointe", login: "mlapointe" },
        { _type: "User", id: 9, name: "mlapointe2", login: "mlapointe2" },
      ]),
    },
  ]);
  const found = await handleProjectAdminTool("find_user", { login: "mlapointe" }, request, OPTIONS);
  assert.deepEqual(found, [{ id: 7, name: "Mark LaPointe", login: "mlapointe" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path.split("?")[0], "/api/v3/principals");
  assert.deepEqual(filtersOf(calls[0]), [
    { type: { operator: "=", values: ["User"] } },
    { any_name_attribute: { operator: "~", values: ["mlapointe"] } },
  ]);
});

test("find_user falls back to /users only when principals finds nothing", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/principals", reply: collection([]) },
    { method: "GET", path: "/api/v3/users", reply: collection([{ id: 8, name: "Bot", login: "track-bot" }]) },
  ]);
  assert.deepEqual(await handleProjectAdminTool("find_user", { login: "track-bot" }, request, OPTIONS), [
    { id: 8, name: "Bot", login: "track-bot" },
  ]);
  assert.deepEqual(
    calls.map((c) => c.path.split("?")[0]),
    ["/api/v3/principals", "/api/v3/users"]
  );
  assert.deepEqual(filtersOf(calls[1]), [{ login: { operator: "=", values: ["track-bot"] } }]);
  // A non-admin gets 403 from /users: that is "not found", not a crash.
  const { request: denied } = fakeApi([
    { method: "GET", path: "/api/v3/principals", reply: collection([]) },
    { method: "GET", path: "/api/v3/users", reply: () => { throw httpError(403, { message: "You are not authorized to access this resource." }); } },
  ]);
  assert.deepEqual(await handleProjectAdminTool("find_user", { login: "ghost" }, denied, OPTIONS), []);
});

test("find_user description says login search may need admin", async () => {
  const { client, server } = await connected(fakeFetch());
  try {
    const { tools } = await client.listTools();
    assert.match(tools.find((t) => t.name === "find_user").description, /admin/i);
  } finally {
    await server.close();
  }
});

// ---- item 8: current callers --------------------------------------------------

function wpRoutes(state) {
  return [
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
    { method: "GET", path: "/api/v3/work_packages/1677", reply: () => state.wp },
    {
      method: "PATCH",
      path: "/api/v3/work_packages/1677",
      reply: ({ body }) => {
        if (state.patchError) {
          const error = state.patchError;
          if (state.onConflict) state.onConflict(state);
          state.patchError = state.patchErrorOnce ? null : state.patchError;
          throw error;
        }
        state.wp = applyPatch(state.wp, body, { "/api/v3/statuses/2": "In progress" });
        return state.wp;
      },
    },
  ];
}

test("an empty description or subject is absent, not a clear", async () => {
  const state = { wp: workPackage() };
  const { request, calls } = fakeApi(wpRoutes(state));
  await handleWpUpdateTool("update_work_package", { id: 1677, subject: "", description: "", percentageDone: 0 }, request, OPTIONS);
  const patch = calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { lockVersion: 5, percentageDone: 0 });
  await assert.rejects(
    () => handleWpUpdateTool("update_work_package", { id: 1677, description: "" }, request, OPTIONS),
    /nothing to update/
  );
  await handleWpUpdateTool("update_work_package", { id: 1677, clear: ["description"] }, request, OPTIONS);
  assert.deepEqual(calls.filter((c) => c.method === "PATCH").pop().body.description, { format: "markdown", raw: "" });

  const created = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "POST", path: "/api/v3/projects/cloudbsd/work_packages", reply: workPackage({ id: 1700 }) },
  ]);
  await handleWpQueryTool("create_work_package", { projectId: "cloudbsd", subject: "x", description: "" }, created.request, OPTIONS);
  assert.equal("description" in created.calls.find((c) => c.method === "POST").body, false);
});

test("list_work_packages pageSize defaults to 100", async () => {
  const { request, calls } = fakeApi([{ method: "GET", path: "/api/v3/work_packages", reply: collection([]) }]);
  await handleWpQueryTool("list_work_packages", {}, request, OPTIONS);
  assert.equal(param(calls[0], "pageSize"), "100");
});

// ---- item 9: errors carry OpenProject details -----------------------------------

const TRANSITION_422 = {
  _type: "Error",
  errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
  message: "Status is invalid because no valid transition exists from old to new status for the current user's roles.",
  _embedded: { details: { attribute: "status" } },
};

test("a refused status transition keeps OpenProject's details and serializes allowedStatuses", async () => {
  const state = { wp: workPackage(), patchError: httpError(422, TRANSITION_422) };
  const { request } = fakeApi([
    ...wpRoutes(state),
    {
      method: "POST",
      path: "/api/v3/work_packages/1677/form",
      reply: { _embedded: { schema: { status: { _embedded: { allowedValues: [{ id: 3, name: "Blocked" }] } } } } },
    },
  ]);
  const error = await handleWpUpdateTool("update_work_package", { id: 1677, status: "Done" }, request, OPTIONS).catch((e) => e);
  assert.equal(error.errorIdentifier, TRANSITION_422.errorIdentifier);
  assert.equal(error.attribute, "status");
  assert.equal(error.opMessage, TRANSITION_422.message);
  const out = toolErrorObject(error);
  assert.equal(out.code, "INVALID_TRANSITION");
  assert.equal(out.httpStatus, 422);
  assert.equal(out.errorIdentifier, TRANSITION_422.errorIdentifier);
  assert.equal(out.attribute, "status");
  assert.deepEqual(out.allowedStatuses, [{ id: 3, name: "Blocked" }]);
  assert.match(out.message, /no valid transition/);
});

test("any other refused update keeps errorIdentifier, attribute and opMessage", async () => {
  const body = {
    _type: "Error",
    errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
    message: "Finish date must be after start date.",
    _embedded: { details: { attribute: "dueDate" } },
  };
  const state = { wp: workPackage(), patchError: httpError(422, body) };
  const { request } = fakeApi(wpRoutes(state));
  const error = await handleWpUpdateTool("update_work_package", { id: 1677, dueDate: "2020-01-01" }, request, OPTIONS).catch((e) => e);
  const out = toolErrorObject(error);
  assert.equal(out.httpStatus, 422);
  assert.equal(out.errorIdentifier, body.errorIdentifier);
  assert.equal(out.attribute, "dueDate");
  assert.match(out.message, /Finish date must be after start date/);
});

test("a 409 conflict is UPDATE_CONFLICT with the UpdateConflict errorIdentifier", async () => {
  const state = {
    wp: workPackage(),
    patchError: httpError(409, { _type: "Error", errorIdentifier: "urn:openproject-org:api:v3:errors:UpdateConflict", message: "Couldn't update the resource because of conflicting modifications." }),
  };
  const { request } = fakeApi(wpRoutes(state));
  const error = await handleWpUpdateTool("update_work_package", { id: 1677, subject: "x", lockVersion: 5 }, request, OPTIONS).catch((e) => e);
  const out = toolErrorObject(error);
  assert.equal(out.code, "UPDATE_CONFLICT");
  assert.equal(out.httpStatus, 409);
  assert.equal(out.errorIdentifier, "urn:openproject-org:api:v3:errors:UpdateConflict");
  assert.match(out.hint, /lockVersion/);
  // Also when the conflict is detected after re-reading.
  const state2 = {
    wp: workPackage(),
    patchError: httpError(409, { message: "conflict" }),
    patchErrorOnce: true,
    onConflict: (s) => {
      s.wp = { ...s.wp, lockVersion: 6, subject: "Theirs" };
    },
  };
  const second = await handleWpUpdateTool("update_work_package", { id: 1677, subject: "Mine" }, fakeApi(wpRoutes(state2)).request, OPTIONS).catch((e) => e);
  assert.equal(toolErrorObject(second).code, "UPDATE_CONFLICT");
  assert.equal(toolErrorObject(second).errorIdentifier, "urn:openproject-org:api:v3:errors:UpdateConflict");
});

test("a type 422 on create serializes allowedTypes and keeps OpenProject's details", async () => {
  const body = {
    _type: "Error",
    errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
    message: "Type is not set to one of the allowed values.",
    _embedded: { details: { attribute: "type" } },
  };
  const { request } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "POST", path: "/api/v3/projects/cloudbsd/work_packages", reply: () => { throw httpError(422, body); } },
  ]);
  const error = await handleWpQueryTool("create_work_package", { projectId: "cloudbsd", subject: "x", typeId: 1 }, request, OPTIONS).catch((e) => e);
  const out = toolErrorObject(error);
  assert.equal(out.httpStatus, 422);
  assert.equal(out.errorIdentifier, body.errorIdentifier);
  assert.equal(out.attribute, "type");
  assert.deepEqual(out.allowedTypes, [
    { id: 4, name: "Ops" },
    { id: 2, name: "Feature" },
  ]);
  // Other create errors keep the identifier too.
  const { request: other } = fakeApi([
    { method: "GET", path: "/api/v3/projects/cloudbsd/types", reply: PROJECT_TYPES },
    { method: "POST", path: "/api/v3/projects/cloudbsd/work_packages", reply: () => { throw httpError(403, { _type: "Error", errorIdentifier: "urn:openproject-org:api:v3:errors:MissingPermission", message: "No." }); } },
  ]);
  const denied = await handleWpQueryTool("create_work_package", { projectId: "cloudbsd", subject: "x" }, other, OPTIONS).catch((e) => e);
  assert.equal(toolErrorObject(denied).errorIdentifier, "urn:openproject-org:api:v3:errors:MissingPermission");
  assert.equal(toolErrorObject(denied).httpStatus, 403);
});

test("error codes are UPPER_SNAKE everywhere", () => {
  const sources = [...LIB_SOURCES, ["http.js", readFileSync(new URL("../http.js", import.meta.url), "utf8")]];
  const bad = [];
  for (const [file, src] of sources) {
    for (const match of src.matchAll(/(?:\bcode\s*:\s*|\.code\s*=\s*)"([^"]*)"/g)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(match[1])) bad.push(file + ": " + match[1]);
    }
  }
  assert.deepEqual(bad, []);
  try {
    checkArgs({ name: "t", inputSchema: { properties: { a: {} } } }, { b: 1 });
    assert.fail("checkArgs accepted an unknown argument");
  } catch (error) {
    assert.equal(error.code, "INVALID_ARGUMENT");
  }
});

// ---- item 10: no union types --------------------------------------------------

test("no inputSchema anywhere declares an array-valued type", async () => {
  const { client, server } = await connected(fakeFetch());
  try {
    const { tools } = await client.listTools();
    const bad = [];
    const walk = (node, where) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.type)) bad.push(where + " " + JSON.stringify(node.type));
      for (const [key, value] of Object.entries(node)) walk(value, where + "." + key);
    };
    for (const tool of tools) walk(tool.inputSchema, tool.name);
    assert.deepEqual(bad, []);
  } finally {
    await server.close();
  }
});

test("string-declared id-or-name arguments still accept numbers at runtime", async () => {
  const { request, calls } = fakeApi([
    { method: "GET", path: "/api/v3/statuses", reply: STATUSES },
    { method: "GET", path: "/api/v3/projects/3/work_packages", reply: collection([]) },
  ]);
  await handleWpQueryTool("list_work_packages", { projectId: 3, status: 2 }, request, OPTIONS);
  assert.deepEqual(filtersOf(calls.pop()), [{ status: { operator: "=", values: ["2"] } }]);
  const state = { wp: workPackage() };
  const update = fakeApi(wpRoutes(state));
  await handleWpUpdateTool("update_work_package", { id: 1677, estimatedTime: 2, remainingTime: "1.5" }, update.request, OPTIONS);
  const patch = update.calls.find((c) => c.method === "PATCH");
  assert.equal(patch.body.estimatedTime, "PT2H");
  assert.equal(patch.body.remainingTime, "PT1.5H");
});

// ---- item 11: version and changelog --------------------------------------------

test("version is 2.0.0 in package.json and the server, and CHANGELOG.md lists the breaking changes", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, "2.0.0");
  const { client, server } = await connected(fakeFetch());
  try {
    assert.equal(client.getServerVersion().version, "2.0.0");
  } finally {
    await server.close();
  }
  const changelogUrl = new URL("../CHANGELOG.md", import.meta.url);
  assert.ok(existsSync(changelogUrl), "CHANGELOG.md exists");
  const changelog = readFileSync(changelogUrl, "utf8");
  assert.match(changelog, /^## 2\.0\.0/m);
  for (const needle of [
    "{id, name}",
    "{total, offset, pageSize, hasMore, elements}",
    "JSON",
    "{hint, result}",
    "nknown argument",
    "first allowed type",
  ]) {
    assert.ok(changelog.includes(needle), "CHANGELOG.md is missing: " + needle);
  }
  assert.ok(pkg.files.includes("CHANGELOG.md"), "CHANGELOG.md is published");
});

// ---- Sonar S8786: linear-time trimming on adversarial input ------------------

test("trailing-slash and trailing-space trimming is linear on long adversarial input", async () => {
  const { trimTrailingSlashes } = await import("../lib/path.js");
  const { idFromHref } = await import("../lib/tool-args.js");
  const N = 200_000;
  const slashes = "/".repeat(N) + "x";
  let started = performance.now();
  assert.equal(trimTrailingSlashes(slashes), slashes);
  assert.equal(trimTrailingSlashes("/api/v3/x" + "/".repeat(N)), "/api/v3/x");
  assert.equal(idFromHref("/api/v3/work_packages/5" + "/".repeat(N)), 5);
  assert.equal(idFromHref(slashes), null);
  assert.ok(performance.now() - started < 250, "slash trimming took " + (performance.now() - started) + " ms");

  // An OpenProject error body full of whitespace that does not end in whitespace.
  const f = fakeFetch(() => ({ ...jsonResponse(500, undefined), async text() { return "a" + " ".repeat(N) + "b"; } }));
  const api = createApi({ baseUrl: ROOT, getApiKey: () => "tok", fetchImpl: f });
  started = performance.now();
  const error = await api.request("/api/v3/x").catch((e) => e);
  assert.equal(error.status, 500);
  assert.ok(performance.now() - started < 250, "error message trimming took " + (performance.now() - started) + " ms");

  // raw_api_call with a root path that ends in many slashes is handled in linear time.
  const { handleRawApiCall } = await import("../lib/raw-api.js");
  const rawApi = {
    baseUrl: "https://op.example.invalid/op" + "/".repeat(N) + "x",
    resolveUrl: (p) => "https://op.example.invalid" + p,
    request: async () => ({ ok: 1 }),
  };
  started = performance.now();
  await handleRawApiCall({ endpoint: "/api/v3/statuses" }, rawApi);
  assert.ok(performance.now() - started < 250, "raw_api_call root trimming took " + (performance.now() - started) + " ms");
});

// ---- Sonar S3776 split of server.js: the upstream tools keep their shapes ----

test("upstream tools (list_projects, get_children, list_statuses, list_types, get_user, log_time) keep their results", async () => {
  const f = fakeFetch((url, init) => {
    const { pathname } = new URL(url);
    const coll = (elements) => jsonResponse(200, { _embedded: { elements } });
    if (pathname === "/api/v3/projects") return coll([{ id: 3, name: "CloudBSD", identifier: "cloudbsd", status: "on track", x: 1 }]);
    if (pathname === "/api/v3/work_packages") {
      return coll([{ id: 9, subject: "c", _links: { status: { title: "New" }, type: { title: "Ops" }, assignee: { href: null } } }]);
    }
    if (pathname === "/api/v3/statuses") return coll([{ id: 1, name: "New", isClosed: false, isDefault: true, color: "#fff" }]);
    if (pathname === "/api/v3/types") return coll([{ id: 4, name: "Ops", color: "#000", position: 1 }]);
    if (pathname === "/api/v3/users/me" || pathname === "/api/v3/users/7") {
      return jsonResponse(200, { id: 7, name: "Mark", login: "m", email: "e", status: "active", admin: true });
    }
    if (pathname === "/api/v3/time_entries" && init.method === "POST") {
      return jsonResponse(201, { id: 90, hours: "PT1.5H", spentOn: "2026-10-30", comment: { raw: "w" } });
    }
    return jsonResponse(404, { message: "no" });
  });
  const { client, server } = await connected(f);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  try {
    assert.deepEqual(await call("list_projects", { pageSize: 5 }), [{ id: 3, name: "CloudBSD", identifier: "cloudbsd", status: "on track" }]);
    assert.equal(new URL(f.calls.at(-1).url).searchParams.get("pageSize"), "5");
    // An empty assignee link has no title, so JSON leaves assignee out (as before the split).
    assert.deepEqual(await call("get_children", { parentId: 1600 }), [{ id: 9, subject: "c", status: "New", type: "Ops" }]);
    assert.deepEqual(JSON.parse(new URL(f.calls.at(-1).url).searchParams.get("filters")), [{ parent: { operator: "=", values: ["1600"] } }]);
    assert.deepEqual(await call("list_statuses", {}), [{ id: 1, name: "New", isClosed: false, isDefault: true }]);
    assert.deepEqual(await call("list_types", {}), [{ id: 4, name: "Ops", color: "#000" }]);
    const user = { id: 7, name: "Mark", login: "m", email: "e", status: "active" };
    assert.deepEqual(await call("get_user", { userId: "me" }), user);
    assert.deepEqual(await call("get_user", { userId: 7 }), user);
    assert.deepEqual(await call("log_time", { workPackageId: 1677, hours: 1.5, comment: "w", spentOn: "2026-10-30" }), {
      id: 90, hours: "PT1.5H", spentOn: "2026-10-30", workPackageId: 1677, comment: "w",
    });
    const body = JSON.parse(f.calls.at(-1).init.body);
    assert.deepEqual(body, {
      _links: { workPackage: { href: "/api/v3/work_packages/1677" }, activity: { href: "/api/v3/time_entries/activities/1" } },
      hours: "PT1.5H",
      spentOn: "2026-10-30",
      comment: { format: "plain", raw: "w" },
    });
  } finally {
    await server.close();
  }
});

// ---- Sonar S3800: idFromHref returns a number or null, never a string -------

test("idFromHref always returns a numeric id (or null)", async () => {
  const { idFromHref, linkRef } = await import("../lib/tool-args.js");
  assert.equal(idFromHref("/api/v3/work_packages/5"), 5);
  assert.equal(idFromHref("/api/v3/work_packages/5/?x=1"), 5);
  for (const href of ["/api/v3/users/me", "/api/v3/work_packages/schemas/3-4", "", null, undefined, "/"]) {
    assert.equal(idFromHref(href), null, String(href));
  }
  assert.deepEqual(linkRef({ href: "/api/v3/users/me", title: "Me" }), { id: null, name: "Me" });
});

// ---- findUsersByLogin pages /principals --------------------------------------

test("find_user by login pages /principals (pageSize 100) until the exact login", async () => {
  const near = Array.from({ length: 130 }, (_, i) => ({ _type: "User", id: 1000 + i, name: "Bot " + i, login: "track-bot-" + i }));
  const all = [...near, { _type: "User", id: 8, name: "Bot", login: "track-bot" }];
  const { request, calls } = fakeApi([
    {
      method: "GET",
      path: "/api/v3/principals",
      reply: ({ query: q }) => {
        const size = Number(q.get("pageSize") || 20);
        const offset = Number(q.get("offset") || 1);
        return collection(all.slice((offset - 1) * size, offset * size), { total: all.length, pageSize: size, offset });
      },
    },
  ]);
  assert.deepEqual(await handleProjectAdminTool("find_user", { login: "track-bot" }, request, OPTIONS), [
    { id: 8, name: "Bot", login: "track-bot" },
  ]);
  assert.deepEqual(calls.map((c) => param(c, "pageSize")), ["100", "100"]);
  assert.deepEqual(calls.map((c) => param(c, "offset")), [null, "2"]);
  assert.equal(calls.some((c) => c.path.startsWith("/api/v3/users")), false, "no admin-only fallback when principals has it");
});
