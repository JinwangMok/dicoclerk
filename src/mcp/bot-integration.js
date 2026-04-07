/**
 * MCP server lifecycle integration with the Discord bot.
 *
 * This module is dynamically imported by src/index.js when the bot starts,
 * keeping MCP as a true optional layer that never affects standalone bot
 * operation.  All MCP-related env vars and SDK imports live here — not in
 * the core index.js — so the Discord bot can start and run with zero MCP
 * footprint when the feature is disabled.
 *
 * Controlled by env vars:
 *   MCP_ENABLED=true   — enable embedded MCP server (SSE transport)
 *   MCP_PORT=3000      — HTTP port for the SSE endpoint (default 3000)
 *
 * Or pass the CLI flag:  node src/index.js --mcp
 */
import { createMcpServer } from './server.js';
import { startSseServer } from './transport.js';

const ENABLED = process.env.MCP_ENABLED === 'true' || process.argv.includes('--mcp');
const PORT = parseInt(process.env.MCP_PORT ?? '3000', 10);

/**
 * Start the embedded MCP SSE server alongside the Discord bot.
 *
 * Called once from src/index.js after the Discord client fires its
 * `ClientReady` event so that `client.guilds.cache` is already populated
 * (MCP tools that resolve guilds/channels work immediately after startup).
 *
 * Returns `null` when MCP is disabled — the caller treats a null handle as a
 * no-op during shutdown.
 *
 * @param {import('discord.js').Client} client - Fully-ready Discord client
 * @param {import('../voice/session-manager.js').SessionManager} sessionManager
 * @returns {Promise<{ httpServer: import('node:http').Server, close: () => Promise<void> } | null>}
 */
export async function startBotMcp(client, sessionManager) {
  if (!ENABLED) return null;

  const server = createMcpServer({ client, sessionManager });
  const handle = await startSseServer(server, PORT);
  console.log(`✅ MCP server (SSE) running on http://127.0.0.1:${PORT}/sse`);
  return handle;
}
