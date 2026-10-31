#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./lib/server.js";

let server;
try {
  server = createMcpServer();
} catch (error) {
  // Fail closed: no default OpenProject URL (it would receive real tokens).
  console.error("openproject-mcp: " + error.message);
  process.exit(1);
}
const transport = new StdioServerTransport();
await server.connect(transport);
