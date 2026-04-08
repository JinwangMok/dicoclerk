/**
 * MCP Transport setup for dicoclerk
 *
 * Provides two transport modes:
 *
 *   1. stdio  — used by the standalone MCP entry point (src/mcp-server.js).
 *               Reads JSON-RPC messages from stdin and writes responses to
 *               stdout.  Cannot be used when the Discord bot is running in the
 *               same process because bot logging already writes to stdout.
 *
 *   2. SSE    — used when the MCP server runs embedded inside the Discord bot
 *               process (src/index.js with MCP_ENABLED=true or --mcp flag).
 *               Exposes an HTTP server that speaks the MCP SSE sub-protocol so
 *               multiple MCP clients (e.g. Openclaw) can connect without
 *               interfering with bot logging.
 */
import http from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// ---------------------------------------------------------------------------
// stdio transport (standalone MCP mode)
// ---------------------------------------------------------------------------

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
 * Registers SIGINT / SIGTERM handlers for graceful shutdown — suitable for
 * the standalone `mcp-server.js` entry point.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @returns {Promise<StdioServerTransport>}
 */
export async function startStdioServer(server) {
  const transport = createStdioTransport();
  await server.connect(transport);

  const cleanup = async () => {
    try {
      await server.close();
    } catch {
      // Ignore errors during shutdown
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  return transport;
}

// ---------------------------------------------------------------------------
// SSE transport (embedded / combined bot+MCP mode)
// ---------------------------------------------------------------------------

/**
 * Start an HTTP server exposing the MCP SSE sub-protocol.
 *
 * Endpoints:
 *   GET  /sse             — establishes a new SSE stream for an MCP client
 *   POST /messages        — client-to-server JSON-RPC messages
 *                           (query param: ?sessionId=<id>)
 *   GET  /health          — liveness check; returns { status: "ok" }
 *
 * Multiple concurrent clients are supported — each GET /sse creates a
 * dedicated SSEServerTransport instance keyed by its sessionId.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {number} [port=3000]  Port to listen on (env MCP_PORT overrides)
 * @returns {Promise<{ httpServer: http.Server, close: () => Promise<void> }>}
 */
export async function startSseServer(server, port = 3000) {
  /** @type {Map<string, SSEServerTransport>} */
  const transports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      // --- New SSE connection ---
      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        const sessionId = transport.sessionId;
        transports.set(sessionId, transport);

        transport.onclose = () => {
          transports.delete(sessionId);
          console.log(`[MCP-SSE] Client disconnected (session=${sessionId}) — active=${transports.size}`);
        };

        console.log(`[MCP-SSE] Client connected (session=${sessionId}) — active=${transports.size + 1}`);
        // server.connect wires the transport into the McpServer instance
        await server.connect(transport);
        return;
      }

      // --- Client → server JSON-RPC messages ---
      if (req.method === 'POST' && url.pathname === '/messages') {
        const sessionId = url.searchParams.get('sessionId');
        const transport = sessionId ? transports.get(sessionId) : undefined;

        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found', sessionId }));
        }
        return;
      }

      // --- Health check ---
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          server: 'dicoclerk-mcp',
          transport: 'sse',
          activeSessions: transports.size,
        }));
        return;
      }

      // --- Unknown route ---
      res.writeHead(404);
      res.end();
    } catch (err) {
      console.error('[MCP-SSE] Request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    const host = process.env.MCP_HOST || '127.0.0.1';
    httpServer.listen(port, host, () => resolve(undefined));
    httpServer.on('error', reject);
  });

  const boundHost = process.env.MCP_HOST || '127.0.0.1';
  console.log(`[MCP-SSE] Server listening on http://${boundHost}:${port}/sse`);

  /**
   * Close the HTTP server and all active SSE connections.
   * @returns {Promise<void>}
   */
  const close = () =>
    new Promise((resolve) => {
      // Close all active transports first
      for (const transport of transports.values()) {
        try {
          transport.close?.();
        } catch {
          // Ignore individual close errors
        }
      }
      transports.clear();

      httpServer.close(() => resolve(undefined));
    });

  return { httpServer, close };
}
