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
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./lib/server.js";
import {
  parseBearerAuthorization,
  runWithCallerToken,
  validateCallerToken,
} from "./lib/auth-context.js";
import {
  createSessionHub,
  isLoopbackAddress,
  sanitizeNotifyEvent,
} from "./lib/session-hub.js";

const BASE_URL =
  process.env.OPENPROJECT_URL || "https://your-openproject-instance.com";
const PORT = Number(process.env.OPENPROJECT_MCP_PORT || process.env.PORT || 8000);
const BIND = process.env.OPENPROJECT_MCP_BIND || "127.0.0.1";

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function userIdentity(user) {
  if (!user || typeof user !== "object") {
    return { userId: null, login: null };
  }
  const userId = user.id != null ? Number(user.id) : null;
  const login =
    typeof user.login === "string"
      ? user.login
      : typeof user.name === "string"
        ? user.name
        : null;
  return { userId: Number.isFinite(userId) ? userId : null, login };
}

/**
 * Build the request handler. Exported for tests.
 * @param {{ baseUrl?: string, hub?: ReturnType<typeof createSessionHub>, validateToken?: Function }} [options]
 */
export function createRequestHandler(options = {}) {
  const baseUrl = options.baseUrl || BASE_URL;
  const hub = options.hub || createSessionHub();
  const validateToken = options.validateToken || validateCallerToken;

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
    const validated = await validateToken(baseUrl, bearer);
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
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "POST only" });
      return;
    }
    const body = await readJsonBody(req);
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

  async function handleMcp(req, res) {
    const caller = await requireCaller(req, res);
    if (!caller) return;

    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionHeader === "string"
        ? sessionHeader
        : Array.isArray(sessionHeader)
          ? sessionHeader[0]
          : undefined;

    await runWithCallerToken(caller.bearer, async () => {
      try {
        if (req.method === "POST") {
          const body = await readJsonBody(req);

          if (sessionId) {
            const entry = hub.get(sessionId);
            if (!entry) {
              sendJson(res, 404, {
                jsonrpc: "2.0",
                error: { code: -32001, message: "Unknown session" },
                id: null,
              });
              return;
            }
            if (
              entry.userId != null &&
              caller.identity.userId != null &&
              Number(entry.userId) !== Number(caller.identity.userId)
            ) {
              sendJson(res, 403, {
                jsonrpc: "2.0",
                error: { code: -32001, message: "Session identity mismatch" },
                id: null,
              });
              return;
            }
            await entry.transport.handleRequest(req, res, body);
            return;
          }

          if (!isInitializeRequest(body)) {
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
              },
              id: null,
            });
            return;
          }

          const mcp = createMcpServer({ baseUrl });
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
              });
            },
          });
          transport.onclose = () => {
            if (registeredId) hub.unregister(registeredId);
            mcp.close().catch(() => {});
          };
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }

        if (req.method === "GET" || req.method === "DELETE") {
          if (!sessionId) {
            sendJson(res, 400, {
              jsonrpc: "2.0",
              error: { code: -32000, message: "mcp-session-id required" },
              id: null,
            });
            return;
          }
          const entry = hub.get(sessionId);
          if (!entry) {
            sendJson(res, 404, {
              jsonrpc: "2.0",
              error: { code: -32001, message: "Unknown session" },
              id: null,
            });
            return;
          }
          if (
            entry.userId != null &&
            caller.identity.userId != null &&
            Number(entry.userId) !== Number(caller.identity.userId)
          ) {
            sendJson(res, 403, {
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session identity mismatch" },
              id: null,
            });
            return;
          }
          await entry.transport.handleRequest(req, res);
          if (req.method === "DELETE") {
            hub.unregister(sessionId);
          }
          return;
        }

        sendJson(res, 405, { error: "method not allowed" });
      } catch (error) {
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
        notify: true,
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

export function createHttpServer(options = {}) {
  const hub = options.hub || createSessionHub();
  const handler = createRequestHandler({ ...options, hub });
  const server = http.createServer(handler);
  return { server, hub, handler };
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("/http.js") ||
    process.argv[1].endsWith("openproject-mcp-http"));

if (isMain) {
  const { server } = createHttpServer();
  server.listen(PORT, BIND, () => {
    console.error(
      `openproject-mcp caller-token http on ${BIND}:${PORT} (stateful + /internal/notify)`
    );
  });
}
