#!/usr/bin/env node
/**
 * Standalone MCP server entry point for dicoclerk
 *
 * Run this directly to start dicoclerk as an MCP server (stdio transport).
 * This mode allows Openclaw or other MCP clients to query transcripts,
 * minutes, and recordings without running the Discord bot.
 *
 * Usage:
 *   node src/mcp-server.js
 *
 * For combined bot + MCP mode, use src/index.js with --mcp flag.
 */
import dotenv from 'dotenv';
import { createMcpServer } from './mcp/server.js';
import { startStdioServer } from './mcp/transport.js';

dotenv.config();

async function main() {
  const server = createMcpServer({
    client: null,
    sessionManager: null,
  });

  console.error('[dicoclerk-mcp] Starting MCP server (stdio transport)...');
  await startStdioServer(server);
  console.error('[dicoclerk-mcp] MCP server running. Waiting for requests on stdin.');
}

main().catch((err) => {
  console.error('[dicoclerk-mcp] Fatal error:', err);
  process.exit(1);
});
