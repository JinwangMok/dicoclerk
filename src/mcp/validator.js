/**
 * MCP Validation Utilities for dicoclerk
 *
 * Provides helpers for:
 *   - Input validation against centralized Zod schemas (INPUT_SCHEMAS)
 *   - Output validation against centralized Zod schemas (OUTPUT_SCHEMAS)
 *   - Formatting Zod validation errors into descriptive human-readable messages
 *   - Creating MCP protocol-level errors (McpError) for invalid parameters
 *   - Creating tool-level error content responses (isError: true)
 *
 * Usage in handlers:
 *   import { requireParam, validateDate, mcpInvalidParams } from './validator.js';
 *
 *   // Throws McpError(InvalidParams) if guildId is blank:
 *   requireParam(guildId, 'guild_id');
 *
 *   // Throws McpError(InvalidParams) if date is not YYYY-MM-DD:
 *   validateDate(params.date_from, 'date_from');
 *
 * Usage in tests:
 *   import { validateToolInput, validateToolOutput, formatZodErrors } from './validator.js';
 *
 *   const { success, errors } = validateToolInput('start_session', params);
 *   const { success, errors } = validateToolOutput('get_status', jsonData);
 */
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { INPUT_SCHEMAS, OUTPUT_SCHEMAS } from './schemas.js';

// ---------------------------------------------------------------------------
// Zod error formatting
// ---------------------------------------------------------------------------

/**
 * Format a Zod parse error into a human-readable, agent-friendly string.
 *
 * Each issue is rendered as:
 *   "• <path>: <message>"
 *
 * When path is empty (top-level error), only the message is shown.
 *
 * @param {import('zod').ZodError} zodError
 * @returns {string}
 */
export function formatZodErrors(zodError) {
  if (!zodError?.issues?.length) return 'Validation failed (no details available)';

  return zodError.issues
    .map((issue) => {
      const path = issue.path?.length ? issue.path.join('.') : null;
      return path ? `• ${path}: ${issue.message}` : `• ${issue.message}`;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate tool input parameters against the registered input schema.
 *
 * Returns a result object rather than throwing so callers can decide
 * whether to surface errors as McpError or as isError content.
 *
 * @param {string} toolName - One of the tool names registered in INPUT_SCHEMAS
 * @param {unknown} params - Raw params object from the tool call
 * @returns {{ success: true, data: object } | { success: false, errors: string }}
 */
export function validateToolInput(toolName, params) {
  const schema = INPUT_SCHEMAS[toolName];
  if (!schema) {
    return {
      success: false,
      errors: `Unknown tool: "${toolName}". No input schema registered.`,
    };
  }

  const result = schema.safeParse(params);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    errors: formatZodErrors(result.error),
  };
}

/**
 * Validate tool output data against the registered output schema.
 *
 * Intended for use in tests and debugging — not called in hot paths.
 *
 * @param {string} toolName - Tool name (or "get_transcript_raw" for raw format)
 * @param {unknown} data - Parsed JSON object from content[0].text
 * @returns {{ success: true, data: object } | { success: false, errors: string }}
 */
export function validateToolOutput(toolName, data) {
  const schema = OUTPUT_SCHEMAS[toolName];
  if (!schema) {
    return {
      success: false,
      errors: `No output schema registered for tool: "${toolName}".`,
    };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }

  return {
    success: false,
    errors: formatZodErrors(result.error),
  };
}

// ---------------------------------------------------------------------------
// Semantic parameter guards — throw McpError(InvalidParams) on failure
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Assert that a required string parameter is non-empty.
 * Throws McpError with ErrorCode.InvalidParams if the value is missing/blank.
 *
 * @param {unknown} value
 * @param {string} paramName - Name used in the error message (e.g. 'guild_id')
 * @param {string} [hint] - Optional extra guidance to include in the error
 * @throws {McpError}
 */
export function requireParam(value, paramName, hint) {
  if (value === null || value === undefined || value === '') {
    const base = `"${paramName}" is required and must be a non-empty string.`;
    throw new McpError(
      ErrorCode.InvalidParams,
      hint ? `${base} ${hint}` : base
    );
  }
}

/**
 * Assert that an optional date parameter, when provided, is in YYYY-MM-DD format.
 * Throws McpError with ErrorCode.InvalidParams on format mismatch.
 *
 * @param {unknown} value
 * @param {string} paramName - Name used in the error message (e.g. 'date_from')
 * @throws {McpError}
 */
export function validateDate(value, paramName) {
  if (value === null || value === undefined || value === '') return;
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${paramName}" must be in YYYY-MM-DD format (e.g. 2025-01-15). Received: ${JSON.stringify(value)}`
    );
  }
}

/**
 * Assert that a numeric parameter is a positive integer within an optional range.
 *
 * @param {unknown} value
 * @param {string} paramName
 * @param {{ min?: number, max?: number }} [range]
 * @throws {McpError}
 */
export function validatePositiveInt(value, paramName, { min = 1, max } = {}) {
  if (value === null || value === undefined) return; // optional params

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${paramName}" must be an integer. Received: ${JSON.stringify(value)}`
    );
  }
  if (value < min) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${paramName}" must be at least ${min}. Received: ${value}`
    );
  }
  if (max !== undefined && value > max) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${paramName}" must be at most ${max}. Received: ${value}`
    );
  }
}

/**
 * Assert that a language code, when provided, is a known value.
 *
 * @param {unknown} value
 * @param {string} [paramName='language']
 * @throws {McpError}
 */
export function validateLanguage(value, paramName = 'language') {
  const VALID = ['ko', 'en', 'multi'];
  if (value === null || value === undefined) return;
  if (!VALID.includes(value)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `"${paramName}" must be one of: ${VALID.map(v => `"${v}"`).join(', ')}. Received: ${JSON.stringify(value)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Error content helpers — for tool-level (non-protocol) errors
// ---------------------------------------------------------------------------

/**
 * Create a McpError for an invalid-params scenario.
 * Use this when you want to throw instead of return errorContent.
 *
 * @param {string} message - Descriptive error message
 * @param {object} [details] - Additional context attached as McpError.data
 * @returns {McpError}
 */
export function mcpInvalidParams(message, details) {
  return new McpError(ErrorCode.InvalidParams, message, details);
}

/**
 * Create a McpError for an internal error scenario.
 *
 * @param {string} message
 * @param {object} [details]
 * @returns {McpError}
 */
export function mcpInternalError(message, details) {
  return new McpError(ErrorCode.InternalError, message, details);
}

/**
 * Create a standard MCP tool error content response.
 * Use when an operation fails at the tool execution level
 * (not a parameter validation failure).
 *
 * @param {string} message - Human-readable error description
 * @param {string} [code] - Optional short error code (e.g. 'SESSION_NOT_FOUND')
 * @returns {{ content: Array<{type: string, text: string}>, isError: true }}
 */
export function errorContent(message, code) {
  const text = code ? `[${code}] ${message}` : message;
  return {
    content: [{ type: 'text', text: `Error: ${text}` }],
    isError: true,
  };
}

/**
 * Wrap an unknown thrown value into a descriptive error string.
 * Handles Error instances, McpError instances, and raw values.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (err instanceof McpError) {
    return `MCP error ${err.code}: ${err.message}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
