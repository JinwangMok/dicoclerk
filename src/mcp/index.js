/**
 * MCP module entry point for dicoclerk
 *
 * Re-exports the public API for MCP server creation and transport setup.
 */
export { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export { startStdioServer, createStdioTransport } from './transport.js';
export { registerTools } from './tools.js';
