#!/usr/bin/env node
/**
 * HTTP Streamable MCP gateway with caller-token auth (Approach A).
 *
 * Client: Authorization: Bearer <that person's OpenProject API token>
 * MCP validates via GET /api/v3/users/me, then uses that token for OP API
 * calls so OpenProject ACLs apply as that person.
 *
 * Sessions are stateful so seats can keep an SSE stream open and receive
 * push notifications (Ready / comment / assign) via MCP logging messages.
 * Ingest is POST /internal/notify, loopback-only (webhook bridge is #100).
 *
 * OPENPROJECT_API_KEY is NOT used for tools in this mode (fail closed).
 * GET /healthz is unauthenticated liveness only.
 */

import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./lib/server.js";
import {
  parseBearerAuthorization,
  requireCallerToken,
  runWithCallerToken,
  validateCallerToken,
} from "./lib/auth-context.js";
import {
  createSessionHub,
  isLoopbackAddress,
  sanitizeNotifyEvent,
} from "./lib/session-hub.js";
import { requireBaseUrl } from "./lib/config.js";

// No default: an unset or placeholder OPENPROJECT_URL refuses to start (see isMain).
const BASE_URL = process.env.OPENPROJECT_URL || "";
const PORT = Number(process.env.OPENPROJECT_MCP_PORT || process.env.PORT || 8000);
const BIND = process.env.OPENPROJECT_MCP_BIND || "127.0.0.1";

export const MAX_BODY_BYTES = 1024 * 1024;
export const TOKEN_CACHE_TTL_MS = 60 * 1000;
export const TOKEN_CACHE_MAX = 1000;
export const SESSION_IDLE_MS = 30 * 60 * 1000;

function bodyTooLarge() {
  const error = new Error("Request body exceeds " + MAX_BODY_BYTES + " bytes");
  error.statusCode = 413;
  return error;
}

/**
 * Read and parse a JSON body, at most MAX_BODY_BYTES. Throws an error with
 * statusCode 413 as soon as the body is larger (a declared Content-Length,
 * or the running total of a chunked body): the rest is never read. The
 * caller answers 413 and then destroys the request (refuseTooLarge).
 * Returns undefined for empty or unparseable bodies.
 */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw bodyTooLarge();
  const chunks = [];
  let total = 0;
  // destroyOnReturn: false so that stopping early does not tear the socket
  // down before the 413 is written.
  const source = typeof req.iterator === "function" ? req.iterator({ destroyOnReturn: false }) : req;
  for await (const chunk of source) {
    total += chunk.length;
    if (total > limit) {
      if (typeof req.pause === "function") req.pause();
      throw bodyTooLarge();
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Answer 413 (Connection: close) and destroy the request once the answer
 * is written, instead of draining an oversized body.
 */
export function refuseTooLarge(req, res, payload) {
  if (!res.headersSent) sendJson(res, 413, payload, { Connection: "close" });
  else if (!res.writableEnded) res.end();
  const destroy = () => {
    if (!req.destroyed) req.destroy();
  };
  if (res.writableFinished) destroy();
  else {
    res.once("finish", destroy);
    res.once("close", destroy);
  }
}

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendTooLarge(req, res) {
  refuseTooLarge(req, res, {
    jsonrpc: "2.0",
    error: { code: -32600, message: "Request body too large (limit " + MAX_BODY_BYTES + " bytes)" },
    id: null,
  });
}

/**
 * In-memory cache of successfully validated caller tokens. Keys are the
 * SHA-256 of the token; the token itself is never stored. Entries live for
 * ttlMs; at most max entries are kept (oldest evicted first).
 */
export function createTokenCache({ ttlMs = TOKEN_CACHE_TTL_MS, max = TOKEN_CACHE_MAX, now = Date.now } = {}) {
  /** @type {Map<string, { value: unknown, expires: number }>} */
  const entries = new Map();
  const keyOf = (token) => createHash("sha256").update(String(token)).digest("hex");
  return {
    get(token) {
      const key = keyOf(token);
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expires <= now()) {
        entries.delete(key);
        return null;
      }
      return hit.value;
    },
    set(token, value) {
      const key = keyOf(token);
      entries.delete(key);
      const t = now();
      if (entries.size >= max) {
        for (const [k, v] of entries) {
          if (v.expires <= t) entries.delete(k);
        }
      }
      while (entries.size >= max) {
        entries.delete(entries.keys().next().value);
      }
      entries.set(key, { value, expires: t + ttlMs });
    },
    keys() {
      return [...entries.keys()];
    },
    size() {
      return entries.size;
    },
  };
}

function userIdentity(user) {
  if (!user || typeof user !== "object") {
    return { userId: null, login: null };
  }
  const userId = user.id != null ? Number(user.id) : null;
  const login = typeof user.login === "string" ? user.login : null;
  return { userId: Number.isFinite(userId) ? userId : null, login };
}

function sessionIdFrom(req) {
  const sessionHeader = req.headers["mcp-session-id"];
  if (typeof sessionHeader === "string") return sessionHeader;
  if (Array.isArray(sessionHeader)) return sessionHeader[0];
  return undefined;
}

function jsonRpcError(res, status, code, message) {
  sendJson(res, status, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function sessionForCaller(hub, sessionId, caller, res) {
  const entry = hub.get(sessionId);
  const entryId = entry?.userId != null ? Number(entry.userId) : Number.NaN;
  const callerId = caller?.identity?.userId != null ? Number(caller.identity.userId) : Number.NaN;
  if (!entry || !Number.isFinite(entryId) || !Number.isFinite(callerId) || entryId !== callerId) {
    if (!entry) jsonRpcError(res, 404, -32001, "Unknown session");
    else jsonRpcError(res, 403, -32001, "Session identity mismatch");
    return null;
  }
  const entryLogin = typeof entry.login === "string" ? entry.login : "";
  const callerLogin = typeof caller.identity.login === "string" ? caller.identity.login : "";
  if (entryLogin) {
    if (!callerLogin || entryLogin.toLowerCase() !== callerLogin.toLowerCase()) {
      jsonRpcError(res, 403, -32001, "Session identity mismatch");
      return null;
    }
  }
  // Only a caller who passed the identity check keeps the session alive.
  entry.lastSeen = Date.now();
  return entry;
}

/**
 * Build the request handler. Exported for tests.
 * @param {{ baseUrl?: string, hub?: ReturnType<typeof createSessionHub>, validateToken?: Function }} [options]
 */
export function createRequestHandler(options = {}) {
  const baseUrl = options.baseUrl || BASE_URL;
  const hub = options.hub || createSessionHub();
  const validateToken = options.validateToken || validateCallerToken;
  const tokenCache = options.tokenCache || createTokenCache();
  const notifyToken =
    options.notifyToken !== undefined
      ? options.notifyToken
      : process.env.OPENPROJECT_NOTIFY_TOKEN;

  function notifyAuthorized(req) {
    if (typeof notifyToken !== "string" || notifyToken.length === 0) return false;
    const header = req.headers["x-notify-token"];
    const presented = Array.isArray(header) ? header[0] : header;
    if (typeof presented !== "string") return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(notifyToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async function requireCaller(req, res) {
    const bearer = parseBearerAuthorization(req.headers.authorization || "");
    if (!bearer) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "Authorization Bearer required" },
        id: null,
      });
      return null;
    }
    const cached = tokenCache.get(bearer);
    const validated = cached || (await validateToken(baseUrl, bearer));
    if (!validated.ok && validated.unavailable) {
      // OpenProject itself is down or restarting; the token was not judged.
      sendJson(
        res,
        503,
        {
          jsonrpc: "2.0",
          error: {
            code: -32002,
            message: "OpenProject unavailable, retry shortly",
            data: { status: validated.status },
          },
          id: null,
        },
        { "Retry-After": "10" }
      );
      return null;
    }
    if (!validated.ok) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "Invalid OpenProject token",
          data: { status: validated.status },
        },
        id: null,
      });
      return null;
    }
    const identity = userIdentity(validated.user);
    if (identity.userId == null) {
      sendJson(res, 401, {
        jsonrpc: "2.0",
        error: { code: -32001, message: "OpenProject user id required" },
        id: null,
      });
      return null;
    }
    if (!cached) tokenCache.set(bearer, validated);
    return { bearer, identity };
  }

  async function handleNotify(req, res) {
    const remote =
      req.socket?.remoteAddress ||
      req.connection?.remoteAddress ||
      "";
    if (!isLoopbackAddress(remote)) {
      sendJson(res, 403, { error: "loopback only" });
      return;
    }
    if (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers.forwarded) {
      sendJson(res, 403, { error: "proxied notify refused" });
      return;
    }
    if (!notifyAuthorized(req)) {
      sendJson(res, 401, { error: "notify token required" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      if (error.statusCode === 413) {
        refuseTooLarge(req, res, { error: "body too large" });
        return;
      }
      throw error;
    }
    if (!body || typeof body !== "object") {
      sendJson(res, 400, { error: "JSON body required" });
      return;
    }
    const event = sanitizeNotifyEvent(body);
    const result = await hub.notify(event);
    sendJson(res, 200, {
      ok: true,
      delivered: result.delivered,
      sessionIds: result.sessionIds,
    });
  }

  async function openSession(req, res, caller, body) {
    // Tool calls run as the caller only: requireCallerToken never falls back
    // to OPENPROJECT_API_KEY (code NO_CALLER_TOKEN when the context is missing).
    const mcp = createMcpServer({ baseUrl, getApiKey: requireCallerToken });
    let registeredId = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        registeredId = id;
        hub.register(id, {
          sessionId: id,
          userId: caller.identity.userId,
          login: caller.identity.login,
          server: mcp,
          transport,
          lastSeen: Date.now(),
          activeStreams: 0,
        });
      },
    });
    let closed = false;
    transport.onclose = () => {
      // mcp.close() closes the transport, which fires onclose again: once only.
      if (closed) return;
      closed = true;
      if (registeredId) hub.unregister(registeredId);
      mcp.close().catch(() => {});
    };
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handleMcpPost(req, res, caller, sessionId) {
    const body = await readJsonBody(req);
    if (sessionId) {
      const entry = sessionForCaller(hub, sessionId, caller, res);
      if (!entry) return;
      await entry.transport.handleRequest(req, res, body);
      return;
    }
    if (!isInitializeRequest(body)) {
      jsonRpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
      return;
    }
    await openSession(req, res, caller, body);
  }

  async function handleMcpListen(req, res, caller, sessionId) {
    if (!sessionId) {
      jsonRpcError(res, 400, -32000, "mcp-session-id required");
      return;
    }
    const entry = sessionForCaller(hub, sessionId, caller, res);
    if (!entry) return;
    if (req.method === "GET") {
      // An open SSE stream keeps the session alive for push notifications.
      entry.activeStreams = (entry.activeStreams || 0) + 1;
      res.on("close", () => {
        entry.activeStreams = Math.max(0, (entry.activeStreams || 1) - 1);
        entry.lastSeen = Date.now();
      });
    }
    await entry.transport.handleRequest(req, res);
    if (req.method === "DELETE") hub.unregister(sessionId);
  }

  async function handleMcp(req, res) {
    const caller = await requireCaller(req, res);
    if (!caller) return;
    const sessionId = sessionIdFrom(req);

    await runWithCallerToken(caller.bearer, async () => {
      try {
        if (req.method === "POST") {
          await handleMcpPost(req, res, caller, sessionId);
          return;
        }
        if (req.method === "GET" || req.method === "DELETE") {
          await handleMcpListen(req, res, caller, sessionId);
          return;
        }
        sendJson(res, 405, { error: "method not allowed" });
      } catch (error) {
        if (error && error.statusCode === 413) {
          sendTooLarge(req, res);
          return;
        }
        console.error("mcp request failed:", error);
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      }
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url || "/", `http://${BIND}`);

    if (
      req.method === "GET" &&
      (url.pathname === "/healthz" || url.pathname === "/health")
    ) {
      sendJson(res, 200, {
        ok: true,
        mode: "caller-token",
        sessions: hub.size(),
        notify: typeof notifyToken === "string" && notifyToken.length > 0,
      });
      return;
    }

    if (url.pathname === "/internal/notify") {
      await handleNotify(req, res);
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }

    await handleMcp(req, res);
  };
}

/**
 * Close sessions idle longer than idleMs that have no open SSE stream.
 * @param {ReturnType<typeof createSessionHub>} hub
 */
export async function sweepIdle(hub, idleMs = SESSION_IDLE_MS, now = Date.now()) {
  const expired = [];
  for (const entry of hub.list()) {
    if ((entry.activeStreams || 0) > 0) continue;
    const lastSeen = Number(entry.lastSeen);
    if (!Number.isFinite(lastSeen) || now - lastSeen <= idleMs) continue;
    expired.push(entry.sessionId);
    hub.unregister(entry.sessionId);
    try {
      await entry.transport?.close?.();
    } catch {
      // A transport that fails to close is already gone from the hub.
    }
  }
  return expired;
}

export function createHttpServer(options = {}) {
  const hub = options.hub || createSessionHub();
  const handler = createRequestHandler({ ...options, hub });
  const server = http.createServer(handler);
  const idleMs = options.sessionIdleMs || SESSION_IDLE_MS;
  const sweepIdleSessions = (now = Date.now()) => sweepIdle(hub, idleMs, now);
  const timer = setInterval(() => {
    sweepIdleSessions().catch(() => {});
  }, Math.min(idleMs, 60 * 1000));
  timer.unref();
  server.on("close", () => clearInterval(timer));
  return { server, hub, handler, sweepIdleSessions };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/http.js") ||
    process.argv[1].endsWith("openproject-mcp-http"));

if (isMain) {
  try {
    requireBaseUrl(BASE_URL);
  } catch (error) {
    console.error("openproject-mcp-http: " + error.message);
    process.exit(1);
  }
  const { server } = createHttpServer({ baseUrl: requireBaseUrl(BASE_URL) });
  server.listen(PORT, BIND, () => {
    console.error(
      `openproject-mcp caller-token http on ${BIND}:${PORT} (stateful + /internal/notify)`
    );
  });
}
