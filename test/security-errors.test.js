import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApi, wpHref } from "../lib/api.js";
import { seg } from "../lib/path.js";
import { requireBaseUrl } from "../lib/config.js";
import { formatToolError } from "../lib/errors.js";
import { createMcpServer } from "../lib/server.js";
import { runWithCallerToken, requireCallerToken } from "../lib/auth-context.js";
import { CLOUDBSD_STATUS_TOOLS } from "../lib/cloudbsd-status.js";
import { createHttpServer, readJsonBody, createTokenCache } from "../http.js";
import { createSessionHub } from "../lib/session-hub.js";

const ROOT = "https://op.example.invalid";

function jsonResponse(status, body, statusText = "") {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return text;
    },
  };
}

/** Fake fetch that records every call; answers with `reply(url, init)`. */
function fakeFetch(reply = () => jsonResponse(200, { ok: true })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

function api(fetchImpl, extra = {}) {
  return createApi({ baseUrl: ROOT, getApiKey: () => "tok", fetchImpl, ...extra });
}

async function connectedClient(serverOptions) {
  const server = createMcpServer(serverOptions);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, server };
}

function errorBody(result) {
  assert.equal(result.isError, true);
  return JSON.parse(result.content[0].text).error;
}

// ---- item 2: same origin -------------------------------------------------

test("absolute foreign-origin URL is refused without a single fetch call", async () => {
  const f = fakeFetch();
  const a = api(f);
  for (const url of [
    "https://evil.example/api/v3/users/me",
    "http://op.example.invalid/api/v3/users/me", // scheme differs
    "https://op.example.invalid:8443/api/v3/x", // port differs
    "//evil.example/api/v3/x", // protocol-relative
    "HTTPS://evil.example/x",
  ]) {
    await assert.rejects(() => a.request(url), (e) => e.code === "FOREIGN_ORIGIN", url);
  }
  assert.equal(f.calls.length, 0);
});

test("relative endpoints cannot change the host", async () => {
  const f = fakeFetch();
  const a = api(f);
  await a.request("@evil.example/x");
  await a.request("api/v3/projects");
  for (const call of f.calls) {
    assert.equal(new URL(call.url).origin, ROOT);
  }
  assert.equal(f.calls[1].url, ROOT + "/api/v3/projects");
});

test("same-origin absolute URL (schema href) is allowed", async () => {
  const f = fakeFetch();
  await api(f).request(ROOT + "/api/v3/work_packages/schemas/1-2");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, ROOT + "/api/v3/work_packages/schemas/1-2");
  assert.match(f.calls[0].init.headers.Authorization, /^Basic /);
});

// ---- item 2: method, timeout, error body ---------------------------------

test("method is upper-cased; lowercase get with a body sends no body", async () => {
  const f = fakeFetch();
  const a = api(f);
  await a.request("/api/v3/work_packages/1", "patch", { subject: "x" });
  await a.request("/api/v3/work_packages/1", "get", { ignored: true });
  assert.equal(f.calls[0].init.method, "PATCH");
  assert.equal(f.calls[0].init.body, JSON.stringify({ subject: "x" }));
  assert.equal(f.calls[1].init.method, "GET");
  assert.equal(f.calls[1].init.body, undefined);
});

test("request times out with code TIMEOUT", async () => {
  const hang = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
  const a = api(hang, { timeoutMs: 20 });
  await assert.rejects(() => a.request("/api/v3/projects"), (e) => e.code === "TIMEOUT");
});

test("timeout default comes from OPENPROJECT_TIMEOUT_MS", async () => {
  const prev = process.env.OPENPROJECT_TIMEOUT_MS;
  process.env.OPENPROJECT_TIMEOUT_MS = "15";
  try {
    const hang = async (_url, init) =>
      new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("x"))));
    await assert.rejects(() => api(hang).request("/x"), (e) => e.code === "TIMEOUT");
  } finally {
    if (prev === undefined) delete process.env.OPENPROJECT_TIMEOUT_MS;
    else process.env.OPENPROJECT_TIMEOUT_MS = prev;
  }
});

test("OpenProject error body is kept whole on the error", async () => {
  const long = "x".repeat(2000);
  const f = fakeFetch(() =>
    jsonResponse(
      422,
      {
        _type: "Error",
        errorIdentifier: "urn:openproject-org:api:v3:errors:MultipleErrors",
        message: "Multiple field constraints have been violated. " + long,
        _embedded: {
          errors: [
            {
              errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
              message: "Subject can't be blank.",
              _embedded: { details: { attribute: "subject" } },
            },
            {
              errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
              message: "Type is not set to one of the allowed values.",
              _embedded: { details: { attribute: "type" } },
            },
          ],
        },
      },
      "Unprocessable Entity"
    )
  );
  const err = await api(f).request("/x", "POST", {}).catch((e) => e);
  assert.equal(err.status, 422);
  assert.equal(err.errorIdentifier, "urn:openproject-org:api:v3:errors:MultipleErrors");
  assert.ok(err.opMessage.endsWith(long), "full OpenProject message kept");
  assert.deepEqual(err.errors, ["Subject can't be blank.", "Type is not set to one of the allowed values."]);
  assert.deepEqual(err.attribute, ["subject", "type"]);
  assert.ok(err.body.length > 2000, "raw body not truncated");
  assert.match(err.message, /^API Error: 422/);
});

test("single error keeps details.attribute", async () => {
  const f = fakeFetch(() =>
    jsonResponse(422, {
      _type: "Error",
      errorIdentifier: "urn:openproject-org:api:v3:errors:PropertyConstraintViolation",
      message: "Subject can't be blank.",
      _embedded: { details: { attribute: "subject" } },
    })
  );
  const err = await api(f).request("/x", "POST", {}).catch((e) => e);
  assert.equal(err.attribute, "subject");
});

// ---- item 3: fail closed --------------------------------------------------

test("requireBaseUrl refuses unset and placeholder URLs", () => {
  assert.throws(() => requireBaseUrl(""), (e) => e.code === "CONFIG");
  assert.throws(() => requireBaseUrl(undefined), (e) => e.code === "CONFIG");
  assert.throws(
    () => requireBaseUrl("https://your-openproject-instance.com"),
    (e) => e.code === "CONFIG"
  );
  assert.throws(() => requireBaseUrl("not a url"), (e) => e.code === "CONFIG");
  assert.equal(requireBaseUrl("https://track.example/"), "https://track.example");
});

test("createMcpServer refuses to start without OPENPROJECT_URL", () => {
  const prev = process.env.OPENPROJECT_URL;
  delete process.env.OPENPROJECT_URL;
  try {
    assert.throws(() => createMcpServer({}), /OPENPROJECT_URL/);
    process.env.OPENPROJECT_URL = "https://your-openproject-instance.com";
    assert.throws(() => createMcpServer({}), /OPENPROJECT_URL/);
  } finally {
    if (prev === undefined) delete process.env.OPENPROJECT_URL;
    else process.env.OPENPROJECT_URL = prev;
  }
});

test("requireCallerToken never falls back to OPENPROJECT_API_KEY", async () => {
  const prev = process.env.OPENPROJECT_API_KEY;
  process.env.OPENPROJECT_API_KEY = "service-key";
  try {
    assert.throws(() => requireCallerToken(), (e) => e.code === "NO_CALLER_TOKEN");
    await runWithCallerToken("person", async () => {
      assert.equal(requireCallerToken(), "person");
    });
  } finally {
    if (prev === undefined) delete process.env.OPENPROJECT_API_KEY;
    else process.env.OPENPROJECT_API_KEY = prev;
  }
});

test("HTTP-mode server with no caller context errors NO_CALLER_TOKEN, sends nothing", async () => {
  const prev = process.env.OPENPROJECT_API_KEY;
  process.env.OPENPROJECT_API_KEY = "service-key";
  const f = fakeFetch();
  try {
    const { client } = await connectedClient({
      baseUrl: ROOT,
      getApiKey: requireCallerToken,
      fetchImpl: f,
    });
    const result = await client.callTool({ name: "list_statuses", arguments: {} });
    const error = errorBody(result);
    assert.equal(error.code, "NO_CALLER_TOKEN");
    assert.equal(f.calls.length, 0);
  } finally {
    if (prev === undefined) delete process.env.OPENPROJECT_API_KEY;
    else process.env.OPENPROJECT_API_KEY = prev;
  }
});

test("http.js source has no placeholder base URL and passes getApiKey", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../http.js", "../lib/server.js", "../index.js"]) {
    const src = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(src, /your-openproject-instance/, file);
  }
  const httpSrc = readFileSync(new URL("../http.js", import.meta.url), "utf8");
  assert.match(httpSrc, /createMcpServer\(\{[^}]*getApiKey:\s*requireCallerToken/);
});

// ---- item 4: path segments ------------------------------------------------

test("seg validates ids and project identifiers and encodes", () => {
  assert.equal(seg(12, "id"), "12");
  assert.equal(seg("12", "id"), "12");
  for (const bad of [0, -1, 1.5, "1/../2", "12abc", "", null, undefined, "01x"]) {
    assert.throws(() => seg(bad, "id"), (e) => e.code === "INVALID_ID", String(bad));
  }
  assert.equal(seg("cloudbsd", "project"), "cloudbsd");
  assert.equal(seg("my_proj-2", "project"), "my_proj-2");
  assert.equal(seg(3, "project"), "3");
  for (const bad of ["../x", "Proj", "a b", "-x", ""]) {
    assert.throws(() => seg(bad, "project"), (e) => e.code === "INVALID_ID", bad);
  }
  assert.equal(seg("a b/c"), "a%20b%2Fc");
  assert.throws(() => seg(".."), (e) => e.code === "INVALID_ID");
});

test("wpHref validates its id", () => {
  assert.equal(wpHref(5), "/api/v3/work_packages/5");
  assert.throws(() => wpHref("5/../../users"), (e) => e.code === "INVALID_ID");
});

// ---- item 5: structured errors, args default, body cap -------------------

test("formatToolError gives code/httpStatus/errorIdentifier/attribute/message/hint", () => {
  const e = new Error("API Error: 409 Conflict");
  e.code = "HTTP_ERROR";
  e.status = 409;
  e.errorIdentifier = "urn:openproject-org:api:v3:errors:UpdateConflict";
  e.opMessage = "Your changes could not be saved.";
  const out = JSON.parse(formatToolError(e).content[0].text).error;
  assert.equal(out.code, "HTTP_ERROR");
  assert.equal(out.httpStatus, 409);
  assert.equal(out.errorIdentifier, "urn:openproject-org:api:v3:errors:UpdateConflict");
  assert.equal(out.message, "Your changes could not be saved.");
  assert.match(out.hint, /lockVersion/);
  assert.equal("attribute" in out, false, "absent fields omitted");
  const plain = JSON.parse(formatToolError(new Error("boom")).content[0].text).error;
  assert.deepEqual(Object.keys(plain).sort(), ["code", "message"]);
});

test("CallTool with no arguments does not crash on args destructuring", async () => {
  const f = fakeFetch(() => jsonResponse(200, { _embedded: { elements: [] } }));
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  const result = await client.callTool({ name: "list_projects" });
  assert.equal(result.isError, undefined);
  assert.equal(f.calls.length, 1);
});

test("CallTool error is structured JSON with exact errorIdentifier", async () => {
  const f = fakeFetch(() =>
    jsonResponse(404, {
      _type: "Error",
      errorIdentifier: "urn:openproject-org:api:v3:errors:NotFound",
      message: "The requested resource could not be found.",
    })
  );
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  const result = await client.callTool({
    name: "raw_api_call",
    arguments: { endpoint: "/api/v3/work_packages/99999" },
  });
  const error = errorBody(result);
  assert.equal(error.httpStatus, 404);
  assert.equal(error.errorIdentifier, "urn:openproject-org:api:v3:errors:NotFound");
  assert.equal(error.message, "The requested resource could not be found.");
  assert.ok(error.hint);
});

function fakeReq(chunks, headers = {}) {
  return {
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield Buffer.from(c);
    },
  };
}

test("readJsonBody caps the body at 1 MiB with status 413", async () => {
  const big = "a".repeat(512 * 1024);
  await assert.rejects(
    () => readJsonBody(fakeReq(['{"x":"', big, big, '"}'])),
    (e) => e.statusCode === 413
  );
  await assert.rejects(
    () => readJsonBody(fakeReq([], { "content-length": String(2 * 1024 * 1024) })),
    (e) => e.statusCode === 413
  );
  assert.deepEqual(await readJsonBody(fakeReq(['{"a":1}'])), { a: 1 });
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function post(port, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "POST", path, headers: { "Content-Type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("POST /mcp over 1 MiB answers 413", async () => {
  const { server } = createHttpServer({
    baseUrl: ROOT,
    validateToken: async () => ({ ok: true, user: { id: 1, login: "a" } }),
  });
  const port = await listen(server);
  try {
    // The server answers 413 and then destroys the request (it does not read
    // the rest), so a client still writing may see the reset before the 413.
    const res = await post(port, "/mcp", { Authorization: "Bearer t" }, "x".repeat(1024 * 1024 + 10)).catch((error) => ({
      error: error.code,
    }));
    if (res.error) assert.ok(["EPIPE", "ECONNRESET"].includes(res.error), "unexpected client error " + res.error);
    else assert.equal(res.status, 413);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// ---- item 6: raw_api_call ---------------------------------------------------

test("raw_api_call: path alias, query object, any-case method, body as-is", async () => {
  const f = fakeFetch(() => jsonResponse(200, { id: 1 }));
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  await client.callTool({
    name: "raw_api_call",
    arguments: {
      path: "/api/v3/projects",
      method: "post",
      query: { pageSize: 5, filters: [{ active: { operator: "=", values: ["t"] } }] },
      body: { name: "x", nested: { a: [1] } },
    },
  });
  const call = f.calls[0];
  const url = new URL(call.url);
  assert.equal(url.pathname, "/api/v3/projects");
  assert.equal(url.searchParams.get("pageSize"), "5");
  assert.deepEqual(JSON.parse(url.searchParams.get("filters")), [{ active: { operator: "=", values: ["t"] } }]);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.body, JSON.stringify({ name: "x", nested: { a: [1] } }));
});

test("raw_api_call: path and endpoint that differ is an error", async () => {
  const f = fakeFetch();
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  const result = await client.callTool({
    name: "raw_api_call",
    arguments: { path: "/api/v3/a", endpoint: "/api/v3/b" },
  });
  assert.equal(errorBody(result).code, "INVALID_ARGUMENT");
  assert.equal(f.calls.length, 0);
});

test("raw_api_call refuses a foreign-origin endpoint without fetching", async () => {
  const f = fakeFetch();
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  const result = await client.callTool({
    name: "raw_api_call",
    arguments: { endpoint: "https://attacker.example/steal" },
  });
  assert.equal(errorBody(result).code, "FOREIGN_ORIGIN");
  assert.equal(f.calls.length, 0);
});

test("raw_api_call hints at the typed tool that covers the call", async () => {
  const f = fakeFetch(() => jsonResponse(200, { ok: 1 }));
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  const cases = [
    [{ endpoint: "/api/v3/work_packages/5/activities", method: "POST", body: {} }, /add_comment/],
    [{ endpoint: "/api/v3/work_packages/5/activities" }, /list_activities/],
    [{ endpoint: "/api/v3/work_packages/5", method: "patch", body: {} }, /update_work_package/],
    [{ endpoint: "/api/v3/work_packages", query: { filters: "[]" } }, /list_work_packages/],
    [{ endpoint: "/api/v3/work_packages?filters=%5B%5D" }, /list_work_packages/],
    [{ endpoint: "/api/v3/projects/cloudbsd/work_packages", method: "POST", body: {} }, /create_work_package/],
    [{ endpoint: "/api/v3/workspaces/3/work_packages", method: "POST", body: {} }, /create_work_package/],
  ];
  for (const [args, re] of cases) {
    const result = await client.callTool({ name: "raw_api_call", arguments: args });
    const payload = JSON.parse(result.content[0].text);
    assert.match(payload.hint, re, JSON.stringify(args));
    assert.match(payload.hint, /covers this/);
    assert.deepEqual(payload.result, { ok: 1 });
  }
  const plain = await client.callTool({ name: "raw_api_call", arguments: { endpoint: "/api/v3/statuses" } });
  assert.deepEqual(JSON.parse(plain.content[0].text), { ok: 1 });
});

test("raw_api_call schema: LAST RESORT, names typed tools, path alias accepted", async () => {
  const f = fakeFetch();
  const { client } = await connectedClient({ baseUrl: ROOT, getApiKey: () => "t", fetchImpl: f });
  const { tools } = await client.listTools();
  const raw = tools.find((t) => t.name === "raw_api_call");
  assert.match(raw.description, /LAST RESORT/);
  for (const name of ["add_comment", "list_activities", "update_work_package", "list_work_packages", "create_work_package"]) {
    assert.match(raw.description, new RegExp(name));
  }
  assert.ok(raw.inputSchema.properties.path);
  assert.ok(raw.inputSchema.properties.query);
  assert.ok(!(raw.inputSchema.required || []).includes("endpoint"));
});

// ---- review additions -------------------------------------------------------

test("build_annotate and relation_upsert schemas accept their documented aliases", () => {
  const byName = Object.fromEntries(CLOUDBSD_STATUS_TOOLS.map((t) => [t.name, t]));
  const ba = byName.build_annotate.inputSchema;
  assert.ok(!(ba.required || []).includes("workPackageId"));
  assert.ok(ba.properties.id && ba.properties.workPackageId);
  const ru = byName.relation_upsert.inputSchema;
  assert.ok(!(ru.required || []).includes("fromId"));
  assert.ok(!(ru.required || []).includes("toId"));
  assert.ok((ru.required || []).includes("type"));
});

test("token cache keys by SHA-256, honours TTL and cap", async () => {
  let now = 0;
  const cache = createTokenCache({ ttlMs: 60_000, max: 3, now: () => now });
  cache.set("secret-token", { ok: true, user: { id: 1 } });
  assert.ok(cache.get("secret-token"));
  for (const key of cache.keys()) {
    assert.doesNotMatch(key, /secret-token/);
    assert.match(key, /^[0-9a-f]{64}$/);
  }
  now = 60_001;
  assert.equal(cache.get("secret-token"), null);
  now = 0;
  for (let i = 0; i < 5; i++) cache.set("t" + i, { ok: true });
  assert.equal(cache.size(), 3);
  assert.equal(cache.get("t0"), null);
  assert.ok(cache.get("t4"));
});

test("requireCaller validates a token once per TTL", async () => {
  let validations = 0;
  const { server } = createHttpServer({
    baseUrl: ROOT,
    validateToken: async () => {
      validations += 1;
      return { ok: true, user: { id: 1, login: "a" } };
    },
  });
  const port = await listen(server);
  try {
    for (let i = 0; i < 3; i++) {
      await post(port, "/mcp", { Authorization: "Bearer t" }, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    }
    assert.equal(validations, 1);
    await post(port, "/mcp", { Authorization: "Bearer other" }, "{}");
    assert.equal(validations, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("rejected tokens are not cached", async () => {
  let validations = 0;
  const { server } = createHttpServer({
    baseUrl: ROOT,
    validateToken: async () => {
      validations += 1;
      return { ok: false, status: 401 };
    },
  });
  const port = await listen(server);
  try {
    await post(port, "/mcp", { Authorization: "Bearer bad" }, "{}");
    await post(port, "/mcp", { Authorization: "Bearer bad" }, "{}");
    assert.equal(validations, 2);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

function initializeSession(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          Authorization: "Bearer t",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, sessionId: res.headers["mcp-session-id"] }));
      }
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      })
    );
  });
}

/** Open the GET /mcp SSE stream; resolves once the server has answered 200. */
function openStream(port, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "GET",
      path: "/mcp",
      headers: { Authorization: "Bearer t", Accept: "text/event-stream", "mcp-session-id": sessionId },
    });
    req.on("response", (res) => resolve({ req, res, status: res.statusCode }));
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("timed out waiting for " + what);
}

test("idle sessions expire after 30 minutes unless a GET stream is open (real handler)", async () => {
  const hub = createSessionHub();
  const { server, sweepIdleSessions } = createHttpServer({
    baseUrl: ROOT,
    hub,
    validateToken: async () => ({ ok: true, user: { id: 1, login: "a" } }),
  });
  const port = await listen(server);
  const later = () => Date.now() + 31 * 60_000;
  try {
    const init = await initializeSession(port);
    assert.equal(init.status, 200);
    assert.ok(init.sessionId, "initialize returned mcp-session-id");
    const idle = await initializeSession(port);

    const stream = await openStream(port, init.sessionId);
    assert.equal(stream.status, 200);
    await waitFor(() => hub.get(init.sessionId).activeStreams === 1, "the stream to be counted");

    // 31 minutes on: the session with an open stream stays, the other goes.
    assert.deepEqual(await sweepIdleSessions(later()), [idle.sessionId]);
    assert.ok(hub.get(init.sessionId));
    assert.equal(hub.get(idle.sessionId), null);

    // Closing the stream refreshes lastSeen and lets the session expire later.
    const closedAt = Date.now();
    stream.req.destroy();
    await waitFor(() => hub.get(init.sessionId).activeStreams === 0, "the stream close to be seen");
    assert.ok(hub.get(init.sessionId).lastSeen >= closedAt);
    assert.deepEqual(await sweepIdleSessions(Date.now() + 5 * 60_000), [], "fresh after the stream closed");
    assert.deepEqual(await sweepIdleSessions(later()), [init.sessionId]);
    assert.equal(hub.get(init.sessionId), null);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
