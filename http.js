#!/usr/bin/env node
/**
 * HTTP Streamable MCP gateway with caller-token auth (Approach A).
 *
 * Client: Authorization: Bearer <that person's OpenProject API token>
 * MCP validates via GET /api/v3/users/me, then uses that token for OP API
 * calls so OpenProject ACLs apply as that person.
 *
 * OPENPROJECT_API_KEY is NOT used for tools in this mode (fail closed).
 * GET /healthz is unauthenticated liveness only.
 */

import http from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./lib/server.js";
import {
  parseBearerAuthorization,
  runWithCallerToken,
  validateCallerToken,
} from "./lib/auth-context.js";

const BASE_URL =
  process.env.OPENPROJECT_URL || "https://your-openproject-instance.com";
const PORT = Number(process.env.OPENPROJECT_MCP_PORT || process.env.PORT || 8000);
const BIND = process.env.OPENPROJECT_MCP_BIND || "127.0.0.1";

async function readJsonBody(req) {
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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${BIND}`);

  if (
    req.method === "GET" &&
    (url.pathname === "/healthz" || url.pathname === "/health")
  ) {
    sendJson(res, 200, { ok: true, mode: "caller-token" });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not found" });
    return;
  }

  const bearer = parseBearerAuthorization(req.headers.authorization || "");
  if (!bearer) {
    sendJson(res, 401, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Authorization Bearer required" },
      id: null,
    });
    return;
  }

  const validated = await validateCallerToken(BASE_URL, bearer);
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
    return;
  }

  await runWithCallerToken(bearer, async () => {
    const mcp = createMcpServer({ baseUrl: BASE_URL });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await mcp.connect(transport);
    const body = await readJsonBody(req);
    try {
      await transport.handleRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    } finally {
      res.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
    }
  });
});

httpServer.listen(PORT, BIND, () => {
  console.error(`openproject-mcp caller-token http on ${BIND}:${PORT}`);
});
