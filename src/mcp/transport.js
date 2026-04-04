/**
 * MCP Transport setup for dicoclerk
 *
 * Provides stdio transport for MCP server communication.
 * The stdio transport reads JSON-RPC messages from stdin and writes to stdout.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * Create a stdio transport for the MCP server.
 *
 * @returns {StdioServerTransport} Transport instance
 */
export function createStdioTransport() {
  return new StdioServerTransport();
}

/**
 * Connect the MCP server to a stdio transport and start listening.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server - MCP server instance
 * @returns {Promise<void>}
 */
export async function startStdioServer(server) {
  const transport = createStdioTransport();
  await server.connect(transport);

  // Handle process signals for graceful shutdown
  const cleanup = async () => {
    try {
      await server.close();
    } catch {
      // Ignore close errors during shutdown
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return transport;
}
