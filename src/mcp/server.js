/**
 * MCP Server for dicoclerk
 *
 * Exposes dicoclerk functionality as MCP tools for Openclaw agent integration.
 * Uses stdio transport for communication.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from './tools.js';

const SERVER_NAME = 'dicoclerk';
const SERVER_VERSION = '1.0.0';

/**
 * Create and configure the MCP server with all tool registrations.
 *
 * @param {object} deps - Dependencies injected from the main app
 * @param {import('discord.js').Client} [deps.client] - Discord client (null in standalone MCP mode)
 * @param {import('../voice/session-manager.js').SessionManager} [deps.sessionManager] - Session manager
 * @returns {McpServer} Configured MCP server instance
 */
export function createMcpServer(deps = {}) {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  }, {
    capabilities: {
      tools: {},
    },
  });

  // Register all tools with the server
  registerTools(server, deps);

  return server;
}

export { SERVER_NAME, SERVER_VERSION };
