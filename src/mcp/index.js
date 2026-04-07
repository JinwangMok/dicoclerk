/**
 * MCP module entry point for dicoclerk
 *
 * Re-exports the public API for MCP server creation and transport setup.
 */
export { createMcpServer, SERVER_NAME, SERVER_VERSION } from './server.js';
export { startStdioServer, createStdioTransport, startSseServer } from './transport.js';
export { registerTools } from './tools.js';

// Schema definitions — tool input/output shapes and Zod schemas
export {
  INPUT_SHAPES,
  INPUT_SCHEMAS,
  OUTPUT_SCHEMAS,
} from './schemas.js';

// Validation utilities — for tests and external consumers
export {
  validateToolInput,
  validateToolOutput,
  formatZodErrors,
  requireParam,
  validateDate,
  validatePositiveInt,
  validateLanguage,
  mcpInvalidParams,
  mcpInternalError,
  errorContent,
  describeError,
} from './validator.js';

// JSON Schema tool manifests — for Openclaw agent discoverability
export {
  TOOL_MANIFESTS,
  REGISTERED_TOOL_NAMES,
  TOOL_ALIASES,
  SERVER_CAPABILITIES,
  SHARED_DEFINITIONS,
  getDiscoveryPayload,
} from './manifest.js';
