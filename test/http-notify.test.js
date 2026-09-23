import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHttpServer } from "../http.js";
import { createSessionHub, isLoopbackAddress } from "../lib/session-hub.js";

test("isLoopbackAddress accepts v4/v6 loopback", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.1"), false);
  assert.equal(isLoopbackAddress(""), false);
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

function request(port, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "Content-Type": "application/json",
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

test("POST /internal/notify fans out to matching hub session", async () => {
  const hub = createSessionHub();
  const sent = [];
  hub.register("sess-a", {
    sessionId: "sess-a",
    userId: 7,
    login: "track-mcp",
    server: {
      async sendLoggingMessage(params) {
        sent.push(params);
      },
    },
  });

  const { server } = createHttpServer({
    hub,
    validateToken: async () => ({ ok: true, user: { id: 7, login: "track-mcp" } }),
  });
  const port = await listen(server);
  try {
    const res = await request(port, {
      method: "POST",
      path: "/internal/notify",
      body: {
        event: "ready",
        workPackageId: 101,
        assigneeId: 7,
        bearer: "MUST-NOT-ECHO",
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.delivered, 1);
    assert.deepEqual(res.json.sessionIds, ["sess-a"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].data.workPackageId, 101);
    assert.equal(sent[0].data.bearer, undefined);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("healthz reports notify capability", async () => {
  const { server } = createHttpServer({
    validateToken: async () => ({ ok: false, status: 401 }),
  });
  const port = await listen(server);
  try {
    const res = await request(port, { method: "GET", path: "/healthz" });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.notify, true);
    assert.equal(typeof res.json.sessions, "number");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
