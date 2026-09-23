import test from "node:test";
import assert from "node:assert/strict";
import { createSessionHub, eventMatchesSession, sanitizeNotifyEvent } from "../lib/session-hub.js";

test("eventMatchesSession by assigneeId", () => {
  const session = { userId: 7, login: "track-mcp" };
  assert.equal(eventMatchesSession(session, { assigneeId: 7 }), true);
  assert.equal(eventMatchesSession(session, { assigneeId: 8 }), false);
});

test("eventMatchesSession by assigneeLogin (case-insensitive)", () => {
  const session = { userId: 7, login: "Track-MCP" };
  assert.equal(eventMatchesSession(session, { assigneeLogin: "track-mcp" }), true);
  assert.equal(eventMatchesSession(session, { assigneeLogin: "other" }), false);
});

test("eventMatchesSession by mentionIds", () => {
  const session = { userId: 22, login: "mlapointe" };
  assert.equal(eventMatchesSession(session, { mentionIds: [22, 9] }), true);
  assert.equal(eventMatchesSession(session, { mentionIds: [9] }), false);
});

test("sanitizeNotifyEvent strips secrets", () => {
  const clean = sanitizeNotifyEvent({
    event: "comment",
    workPackageId: 101,
    assigneeId: 7,
    bearer: "SECRET",
    token: "SECRET2",
    authorization: "Bearer x",
    excerpt: "hello",
  });
  assert.equal(clean.bearer, undefined);
  assert.equal(clean.token, undefined);
  assert.equal(clean.authorization, undefined);
  assert.equal(clean.workPackageId, 101);
  assert.equal(clean.excerpt, "hello");
});

test("session hub notify delivers only to matching sessions", async () => {
  const sent = [];
  const hub = createSessionHub();
  hub.register("s1", {
    sessionId: "s1",
    userId: 7,
    login: "track-mcp",
    server: {
      async sendLoggingMessage(params) {
        sent.push({ session: "s1", params });
      },
    },
  });
  hub.register("s2", {
    sessionId: "s2",
    userId: 22,
    login: "mlapointe",
    server: {
      async sendLoggingMessage(params) {
        sent.push({ session: "s2", params });
      },
    },
  });

  const result = await hub.notify({
    event: "comment",
    workPackageId: 101,
    assigneeId: 7,
    excerpt: "ping",
  });
  assert.equal(result.delivered, 1);
  assert.deepEqual(result.sessionIds, ["s1"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].session, "s1");
  assert.equal(sent[0].params.data.workPackageId, 101);
  assert.equal(sent[0].params.logger, "openproject-mcp");
});

test("session hub unregister stops delivery", async () => {
  const hub = createSessionHub();
  let calls = 0;
  hub.register("s1", {
    sessionId: "s1",
    userId: 7,
    login: "track-mcp",
    server: { async sendLoggingMessage() { calls++; } },
  });
  hub.unregister("s1");
  const result = await hub.notify({ assigneeId: 7, event: "ready" });
  assert.equal(result.delivered, 0);
  assert.equal(calls, 0);
});
