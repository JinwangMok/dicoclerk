/**
 * Tests for MCP JSON Schema definitions and validation
 *
 * Covers:
 *   - Input schema validation for all 11 tools (valid and invalid inputs)
 *   - Output schema validation for all tools that return JSON
 *   - Validator utility helpers (validateToolInput, validateToolOutput)
 *   - McpError throws for semantic validation failures (dates, limits)
 *   - Descriptive error message content
 *   - errorContent() format compliance
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

import {
  INPUT_SCHEMAS,
  OUTPUT_SCHEMAS,
  StartSessionInputSchema,
  StopSessionInputSchema,
  GetTranscriptInputSchema,
  ListRecordingsInputSchema,
  SearchMinutesInputSchema,
  SearchMeetingMinutesInputSchema,
  SummarizeMinutesInputSchema,
  GetStatusOutputSchema,
  ListSessionsOutputSchema,
  ListRecordingsOutputSchema,
  SearchMinutesOutputSchema,
  SearchMeetingMinutesOutputSchema,
  SummarizeMinutesOutputSchema,
  GetTranscriptRawOutputSchema,
} from '../src/mcp/schemas.js';

import {
  validateToolInput,
  validateToolOutput,
  formatZodErrors,
  requireParam,
  validateDate,
  validatePositiveInt,
  validateLanguage,
  mcpInvalidParams,
  errorContent,
  describeError,
} from '../src/mcp/validator.js';

// ---------------------------------------------------------------------------
// Schema registry completeness
// ---------------------------------------------------------------------------

describe('Schema registry completeness', () => {
  const EXPECTED_TOOLS = [
    'start_session', 'stop_session', 'list_sessions', 'get_session',
    'get_status', 'get_transcript', 'get_minutes', 'list_recordings',
    'search_minutes', 'search_meeting_minutes', 'summarize_minutes',
  ];

  it('INPUT_SCHEMAS has an entry for every tool', () => {
    for (const tool of EXPECTED_TOOLS) {
      assert.ok(INPUT_SCHEMAS[tool], `INPUT_SCHEMAS missing entry for "${tool}"`);
    }
  });

  it('OUTPUT_SCHEMAS has an entry for tools that return JSON', () => {
    const jsonOutputTools = [
      'start_session', 'stop_session', 'list_sessions', 'get_session',
      'get_status', 'list_recordings', 'search_minutes',
      'search_meeting_minutes', 'summarize_minutes',
    ];
    for (const tool of jsonOutputTools) {
      assert.ok(OUTPUT_SCHEMAS[tool], `OUTPUT_SCHEMAS missing entry for "${tool}"`);
    }
  });

  it('every schema in INPUT_SCHEMAS has a safeParse method', () => {
    for (const [name, schema] of Object.entries(INPUT_SCHEMAS)) {
      assert.equal(typeof schema.safeParse, 'function', `${name} input schema missing safeParse`);
    }
  });

  it('every schema in OUTPUT_SCHEMAS has a safeParse method', () => {
    for (const [name, schema] of Object.entries(OUTPUT_SCHEMAS)) {
      assert.equal(typeof schema.safeParse, 'function', `${name} output schema missing safeParse`);
    }
  });
});

// ---------------------------------------------------------------------------
// Input schema — start_session
// ---------------------------------------------------------------------------

describe('Input schema: start_session', () => {
  it('accepts valid input', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '123456789',
      voice_channel_id: '987654321',
      text_channel_id: '111222333',
      language: 'ko',
    });
    assert.ok(r.success, `Unexpected error: ${r.error?.message}`);
  });

  it('applies default language=multi when omitted', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '123', voice_channel_id: '456', text_channel_id: '789',
    });
    assert.ok(r.success);
    assert.equal(r.data.language, 'multi');
  });

  it('rejects empty guild_id', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '', voice_channel_id: '456', text_channel_id: '789',
    });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('guild_id'), `Expected guild_id in error: ${msg}`);
  });

  it('rejects missing voice_channel_id', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '123', text_channel_id: '789',
    });
    assert.ok(!r.success);
  });

  it('rejects invalid language enum', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '123', voice_channel_id: '456', text_channel_id: '789',
      language: 'fr',
    });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('language'), `Expected language in error: ${msg}`);
  });

  it('rejects empty voice_channel_id', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '123', voice_channel_id: '', text_channel_id: '789',
    });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// Input schema — stop_session
// ---------------------------------------------------------------------------

describe('Input schema: stop_session', () => {
  it('accepts valid input', () => {
    const r = StopSessionInputSchema.safeParse({ guild_id: 'guild-abc' });
    assert.ok(r.success);
  });

  it('rejects empty guild_id', () => {
    const r = StopSessionInputSchema.safeParse({ guild_id: '' });
    assert.ok(!r.success);
  });

  it('rejects missing guild_id', () => {
    const r = StopSessionInputSchema.safeParse({});
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// Input schema — get_transcript
// ---------------------------------------------------------------------------

describe('Input schema: get_transcript', () => {
  it('accepts valid input with default format', () => {
    const r = GetTranscriptInputSchema.safeParse({ guild_id: 'g1' });
    assert.ok(r.success);
    assert.equal(r.data.format, 'formatted');
  });

  it('accepts raw format', () => {
    const r = GetTranscriptInputSchema.safeParse({ guild_id: 'g1', format: 'raw' });
    assert.ok(r.success);
  });

  it('rejects invalid format value', () => {
    const r = GetTranscriptInputSchema.safeParse({ guild_id: 'g1', format: 'json' });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('format'), `Expected format in error: ${msg}`);
  });

  it('rejects missing guild_id', () => {
    const r = GetTranscriptInputSchema.safeParse({ format: 'formatted' });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// Input schema — list_recordings
// ---------------------------------------------------------------------------

describe('Input schema: list_recordings', () => {
  it('accepts valid input with defaults', () => {
    const r = ListRecordingsInputSchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data.limit, 20);
  });

  it('accepts explicit limit and guild_id', () => {
    const r = ListRecordingsInputSchema.safeParse({ limit: 5, guild_id: 'g1' });
    assert.ok(r.success);
  });

  it('rejects limit = 0', () => {
    const r = ListRecordingsInputSchema.safeParse({ limit: 0 });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('limit'), `Expected limit in error: ${msg}`);
  });

  it('rejects limit > 100', () => {
    const r = ListRecordingsInputSchema.safeParse({ limit: 101 });
    assert.ok(!r.success);
  });

  it('rejects non-integer limit', () => {
    const r = ListRecordingsInputSchema.safeParse({ limit: 5.5 });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// Input schema — search_minutes (date format enforcement)
// ---------------------------------------------------------------------------

describe('Input schema: search_minutes — date validation', () => {
  it('accepts valid YYYY-MM-DD dates', () => {
    const r = SearchMinutesInputSchema.safeParse({
      date_from: '2025-01-01',
      date_to: '2025-12-31',
    });
    assert.ok(r.success, formatZodErrors(r.error));
  });

  it('accepts omitted dates (optional)', () => {
    const r = SearchMinutesInputSchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data.date_from, undefined);
    assert.equal(r.data.date_to, undefined);
  });

  it('rejects date_from in wrong format (YYYYMMDD)', () => {
    const r = SearchMinutesInputSchema.safeParse({ date_from: '20250115' });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('date_from') || msg.includes('YYYY-MM-DD'), `Error: ${msg}`);
  });

  it('rejects date_from in MM/DD/YYYY format', () => {
    const r = SearchMinutesInputSchema.safeParse({ date_from: '01/15/2025' });
    assert.ok(!r.success);
  });

  it('rejects date_from as a plain word', () => {
    const r = SearchMinutesInputSchema.safeParse({ date_from: 'yesterday' });
    assert.ok(!r.success);
  });

  it('rejects limit = 0', () => {
    const r = SearchMinutesInputSchema.safeParse({ limit: 0 });
    assert.ok(!r.success);
  });

  it('rejects offset < 0', () => {
    const r = SearchMinutesInputSchema.safeParse({ offset: -1 });
    assert.ok(!r.success);
  });

  it('applies default limit=20 and offset=0', () => {
    const r = SearchMinutesInputSchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data.limit, 20);
    assert.equal(r.data.offset, 0);
  });
});

// ---------------------------------------------------------------------------
// Input schema — search_meeting_minutes
// ---------------------------------------------------------------------------

describe('Input schema: search_meeting_minutes', () => {
  it('accepts fully populated valid input', () => {
    const r = SearchMeetingMinutesInputSchema.safeParse({
      query: 'budget review',
      guild_id: 'g1',
      channel_name: 'general',
      participant: 'Alice',
      date_from: '2025-01-01',
      date_to: '2025-06-30',
      keywords: ['budget', 'Q1'],
      language: 'en',
      limit: 5,
      offset: 0,
      include_content: true,
    });
    assert.ok(r.success, formatZodErrors(r.error));
  });

  it('rejects limit > 50', () => {
    const r = SearchMeetingMinutesInputSchema.safeParse({ limit: 51 });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('limit'), `Expected limit in error: ${msg}`);
  });

  it('rejects invalid date_to format', () => {
    const r = SearchMeetingMinutesInputSchema.safeParse({ date_to: '2025/06/30' });
    assert.ok(!r.success);
  });

  it('accepts empty keywords array', () => {
    const r = SearchMeetingMinutesInputSchema.safeParse({ keywords: [] });
    assert.ok(r.success);
  });

  it('rejects keywords containing non-string values', () => {
    const r = SearchMeetingMinutesInputSchema.safeParse({ keywords: [123] });
    assert.ok(!r.success);
  });

  it('defaults include_content to true', () => {
    const r = SearchMeetingMinutesInputSchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data.include_content, true);
  });
});

// ---------------------------------------------------------------------------
// Input schema — summarize_minutes
// ---------------------------------------------------------------------------

describe('Input schema: summarize_minutes', () => {
  it('accepts defaults', () => {
    const r = SummarizeMinutesInputSchema.safeParse({});
    assert.ok(r.success);
    assert.equal(r.data.limit, 5);
    assert.equal(r.data.max_topics, 5);
    assert.equal(r.data.max_action_items, 10);
    assert.equal(r.data.max_narrative_length, 500);
  });

  it('rejects max_topics > 20', () => {
    const r = SummarizeMinutesInputSchema.safeParse({ max_topics: 21 });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('max_topics'), `Expected max_topics in error: ${msg}`);
  });

  it('rejects max_action_items > 50', () => {
    const r = SummarizeMinutesInputSchema.safeParse({ max_action_items: 51 });
    assert.ok(!r.success);
  });

  it('rejects max_narrative_length < 50', () => {
    const r = SummarizeMinutesInputSchema.safeParse({ max_narrative_length: 10 });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('max_narrative_length'), `Expected max_narrative_length in error: ${msg}`);
  });

  it('rejects max_narrative_length > 2000', () => {
    const r = SummarizeMinutesInputSchema.safeParse({ max_narrative_length: 2001 });
    assert.ok(!r.success);
  });

  it('rejects invalid date in date_from', () => {
    const r = SummarizeMinutesInputSchema.safeParse({ date_from: 'not-a-date' });
    assert.ok(!r.success);
  });
});

// ---------------------------------------------------------------------------
// validateToolInput utility
// ---------------------------------------------------------------------------

describe('validateToolInput()', () => {
  it('returns success:true for valid start_session params', () => {
    const result = validateToolInput('start_session', {
      guild_id: 'g1', voice_channel_id: 'vc1', text_channel_id: 'tc1',
    });
    assert.ok(result.success);
    assert.equal(result.data.language, 'multi'); // default applied
  });

  it('returns success:false with errors string for invalid params', () => {
    const result = validateToolInput('start_session', {
      guild_id: '', voice_channel_id: 'vc1', text_channel_id: 'tc1',
    });
    assert.ok(!result.success);
    assert.ok(typeof result.errors === 'string');
    assert.ok(result.errors.includes('guild_id'), `Error: ${result.errors}`);
  });

  it('returns success:false for unknown tool name', () => {
    const result = validateToolInput('nonexistent_tool', {});
    assert.ok(!result.success);
    assert.ok(result.errors.includes('nonexistent_tool'));
  });

  it('validates search_minutes with bad date', () => {
    const result = validateToolInput('search_minutes', { date_from: 'bad-date' });
    assert.ok(!result.success);
    assert.ok(result.errors.includes('YYYY-MM-DD') || result.errors.includes('date_from'));
  });

  it('validates list_recordings with out-of-range limit', () => {
    const result = validateToolInput('list_recordings', { limit: 0 });
    assert.ok(!result.success);
    assert.ok(result.errors.includes('limit'));
  });

  it('validates summarize_minutes with bad max_topics', () => {
    const result = validateToolInput('summarize_minutes', { max_topics: 99 });
    assert.ok(!result.success);
    assert.ok(result.errors.includes('max_topics'));
  });
});

// ---------------------------------------------------------------------------
// validateToolOutput utility
// ---------------------------------------------------------------------------

describe('validateToolOutput()', () => {
  it('validates a correct get_status response', () => {
    const data = {
      bot_mode: 'standalone',
      active_session_count: 0,
      sessions: [],
      system: { version: '1.0.0', uptime_seconds: 42, deepgram_configured: false },
    };
    const result = validateToolOutput('get_status', data);
    assert.ok(result.success, `Unexpected errors: ${result.errors}`);
  });

  it('rejects get_status response with wrong bot_mode', () => {
    const data = {
      bot_mode: 'unknown_mode',
      active_session_count: 0,
      sessions: [],
      system: { version: '1.0.0', uptime_seconds: 42, deepgram_configured: false },
    };
    const result = validateToolOutput('get_status', data);
    assert.ok(!result.success);
    assert.ok(result.errors.includes('bot_mode'));
  });

  it('validates a correct list_sessions response', () => {
    const data = {
      sessions: [
        { guild_id: 'g1', started_at: '2025-01-01T10:00:00Z', participant_count: 3, transcript_count: 10 },
      ],
      count: 1,
    };
    const result = validateToolOutput('list_sessions', data);
    assert.ok(result.success, `Errors: ${result.errors}`);
  });

  it('rejects list_sessions where count is missing', () => {
    const data = { sessions: [] };
    const result = validateToolOutput('list_sessions', data);
    assert.ok(!result.success);
    assert.ok(result.errors.includes('count'));
  });

  it('validates a correct list_recordings response', () => {
    const data = {
      recordings: [
        {
          type: 'transcript',
          filename: 'test.json',
          size_bytes: 1024,
          created_at: '2025-01-01T00:00:00.000Z',
          modified_at: '2025-01-01T01:00:00.000Z',
        },
      ],
      total: 1,
      showing: 1,
    };
    const result = validateToolOutput('list_recordings', data);
    assert.ok(result.success, `Errors: ${result.errors}`);
  });

  it('rejects list_recordings with invalid type field', () => {
    const data = {
      recordings: [{ type: 'video', filename: 'x', size_bytes: 0, created_at: '', modified_at: '' }],
      total: 1,
      showing: 1,
    };
    const result = validateToolOutput('list_recordings', data);
    assert.ok(!result.success);
  });

  it('validates a correct search_minutes response', () => {
    const data = {
      minutes: [{
        session_id: 'sess-1',
        date: '2025-01-15',
        time: '10:00',
        duration_seconds: 3600,
        participants: ['Alice', 'Bob'],
        participant_count: 2,
        transcript_count: 42,
        filename: 'minutes-2025.md',
      }],
      total: 1,
      showing: 1,
    };
    const result = validateToolOutput('search_minutes', data);
    assert.ok(result.success, `Errors: ${result.errors}`);
  });

  it('rejects search_minutes entry missing required session_id', () => {
    const data = {
      minutes: [{ date: '2025-01-15', time: '10:00', duration_seconds: 0,
        participants: [], participant_count: 0, transcript_count: 0, filename: 'f.md' }],
      total: 1, showing: 1,
    };
    const result = validateToolOutput('search_minutes', data);
    assert.ok(!result.success);
    assert.ok(result.errors.includes('session_id'));
  });

  it('returns error for unknown tool name', () => {
    const result = validateToolOutput('nonexistent_tool', {});
    assert.ok(!result.success);
    assert.ok(result.errors.includes('nonexistent_tool'));
  });

  it('validates get_transcript_raw output', () => {
    const data = {
      session_id: 'guild-test-1714000000000',
      guild_id: 'g1',
      format: 'raw',
      status: 'live',
      entry_count: 2,
      speaker_count: 2,
      language: 'en',
      entries: [
        {
          session_id: 'guild-test-1714000000000',
          speaker_label: 0,
          speaker_name: 'Alice',
          user_id: 'user-alice',
          text: 'Hi',
          start: 0.5,
          end: 1.5,
          duration: 1.0,
          confidence: 0.95,
          language: 'en',
          is_final: true,
          wall_clock_ms: 1714000001000,
        },
        {
          session_id: 'guild-test-1714000000000',
          speaker_label: 1,
          speaker_name: 'Bob',
          user_id: null,
          text: 'Hey',
          start: 2.0,
          end: 3.0,
          duration: 1.0,
          confidence: 0.90,
          language: 'en',
          is_final: true,
          wall_clock_ms: 1714000003000,
        },
      ],
    };
    const result = validateToolOutput('get_transcript_raw', data);
    assert.ok(result.success, `Errors: ${result.errors}`);
  });
});

// ---------------------------------------------------------------------------
// formatZodErrors utility
// ---------------------------------------------------------------------------

describe('formatZodErrors()', () => {
  it('formats multiple field errors with bullet points', () => {
    const r = StartSessionInputSchema.safeParse({});
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('•'), 'Expected bullet points in error output');
  });

  it('includes field path in error message', () => {
    const r = StartSessionInputSchema.safeParse({
      guild_id: '', voice_channel_id: 'vc1', text_channel_id: 'tc1',
    });
    assert.ok(!r.success);
    const msg = formatZodErrors(r.error);
    assert.ok(msg.includes('guild_id'), `Expected "guild_id" in: ${msg}`);
  });

  it('handles null/undefined input gracefully', () => {
    const msg = formatZodErrors(null);
    assert.ok(typeof msg === 'string');
    assert.ok(msg.length > 0);
  });

  it('handles ZodError with no issues gracefully', () => {
    const fakeError = { issues: [] };
    const msg = formatZodErrors(fakeError);
    assert.ok(typeof msg === 'string');
  });
});

// ---------------------------------------------------------------------------
// requireParam() guard
// ---------------------------------------------------------------------------

describe('requireParam()', () => {
  it('does not throw for a valid non-empty string', () => {
    assert.doesNotThrow(() => requireParam('guild-123', 'guild_id'));
  });

  it('throws McpError(InvalidParams) for empty string', () => {
    assert.throws(
      () => requireParam('', 'guild_id'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for null', () => {
    assert.throws(
      () => requireParam(null, 'guild_id'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for undefined', () => {
    assert.throws(
      () => requireParam(undefined, 'guild_id'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('error message includes the param name', () => {
    try {
      requireParam(null, 'voice_channel_id');
      assert.fail('Expected throw');
    } catch (err) {
      assert.ok(err.message.includes('voice_channel_id'));
    }
  });

  it('appends hint when provided', () => {
    try {
      requireParam('', 'guild_id', 'Use the server Settings to find the guild ID.');
      assert.fail('Expected throw');
    } catch (err) {
      assert.ok(err.message.includes('guild_id'));
      assert.ok(err.message.includes('Use the server Settings'));
    }
  });
});

// ---------------------------------------------------------------------------
// validateDate() guard
// ---------------------------------------------------------------------------

describe('validateDate()', () => {
  it('does not throw for undefined (optional)', () => {
    assert.doesNotThrow(() => validateDate(undefined, 'date_from'));
  });

  it('does not throw for null (optional)', () => {
    assert.doesNotThrow(() => validateDate(null, 'date_from'));
  });

  it('does not throw for empty string (treated as absent)', () => {
    assert.doesNotThrow(() => validateDate('', 'date_from'));
  });

  it('does not throw for valid YYYY-MM-DD', () => {
    assert.doesNotThrow(() => validateDate('2025-01-15', 'date_from'));
  });

  it('throws McpError(InvalidParams) for YYYYMMDD', () => {
    assert.throws(
      () => validateDate('20250115', 'date_from'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for MM/DD/YYYY', () => {
    assert.throws(
      () => validateDate('01/15/2025', 'date_to'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for natural language date', () => {
    assert.throws(
      () => validateDate('yesterday', 'date_from'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('error message includes param name and received value', () => {
    try {
      validateDate('bad-date', 'date_from');
      assert.fail('Expected throw');
    } catch (err) {
      assert.ok(err.message.includes('date_from'));
      assert.ok(err.message.includes('YYYY-MM-DD'));
      assert.ok(err.message.includes('bad-date'));
    }
  });

  it('throws McpError(InvalidParams) for non-string value', () => {
    assert.throws(
      () => validateDate(20250115, 'date_from'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });
});

// ---------------------------------------------------------------------------
// validatePositiveInt() guard
// ---------------------------------------------------------------------------

describe('validatePositiveInt()', () => {
  it('does not throw for undefined (optional)', () => {
    assert.doesNotThrow(() => validatePositiveInt(undefined, 'limit'));
  });

  it('does not throw for valid integer within range', () => {
    assert.doesNotThrow(() => validatePositiveInt(10, 'limit', { min: 1, max: 100 }));
  });

  it('throws McpError(InvalidParams) for 0 when min=1', () => {
    assert.throws(
      () => validatePositiveInt(0, 'limit', { min: 1 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for negative offset', () => {
    assert.throws(
      () => validatePositiveInt(-1, 'offset', { min: 0 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for value exceeding max', () => {
    assert.throws(
      () => validatePositiveInt(101, 'limit', { min: 1, max: 100 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for float', () => {
    assert.throws(
      () => validatePositiveInt(5.5, 'limit'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for string value', () => {
    assert.throws(
      () => validatePositiveInt('10', 'limit'),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('error message includes param name and received value', () => {
    try {
      validatePositiveInt(0, 'limit', { min: 1 });
      assert.fail('Expected throw');
    } catch (err) {
      assert.ok(err.message.includes('limit'), `Error: ${err.message}`);
      assert.ok(err.message.includes('1'), `Error: ${err.message}`);
    }
  });
});

// ---------------------------------------------------------------------------
// mcpInvalidParams() factory
// ---------------------------------------------------------------------------

describe('mcpInvalidParams()', () => {
  it('returns a McpError with InvalidParams code', () => {
    const err = mcpInvalidParams('guild_id is required');
    assert.ok(err instanceof McpError);
    assert.equal(err.code, ErrorCode.InvalidParams);
    // McpError.message is prefixed: "MCP error <code>: <message>"
    assert.ok(err.message.includes('guild_id is required'), `Got: ${err.message}`);
  });

  it('attaches optional details to the error', () => {
    const err = mcpInvalidParams('bad date', { param: 'date_from', received: 'yesterday' });
    assert.ok(err instanceof McpError);
    assert.deepEqual(err.data, { param: 'date_from', received: 'yesterday' });
  });
});

// ---------------------------------------------------------------------------
// errorContent() response format
// ---------------------------------------------------------------------------

describe('errorContent()', () => {
  it('returns isError:true content response', () => {
    const resp = errorContent('Session not found');
    assert.ok(resp.isError);
    assert.ok(Array.isArray(resp.content));
    assert.equal(resp.content.length, 1);
    assert.equal(resp.content[0].type, 'text');
    assert.ok(resp.content[0].text.includes('Session not found'));
  });

  it('prefixes message with "Error:"', () => {
    const resp = errorContent('Something failed');
    assert.ok(resp.content[0].text.startsWith('Error:'), `Got: ${resp.content[0].text}`);
  });

  it('includes optional error code in brackets when provided', () => {
    const resp = errorContent('Not found', 'SESSION_NOT_FOUND');
    assert.ok(resp.content[0].text.includes('[SESSION_NOT_FOUND]'), `Got: ${resp.content[0].text}`);
    assert.ok(resp.content[0].text.includes('Not found'));
  });

  it('content type is always "text"', () => {
    const resp = errorContent('error');
    assert.equal(resp.content[0].type, 'text');
  });
});

// ---------------------------------------------------------------------------
// describeError() utility
// ---------------------------------------------------------------------------

describe('describeError()', () => {
  it('describes a plain Error', () => {
    const msg = describeError(new Error('something failed'));
    assert.ok(msg.includes('something failed'));
  });

  it('describes a McpError with code prefix', () => {
    const err = new McpError(ErrorCode.InvalidParams, 'bad param');
    const msg = describeError(err);
    assert.ok(msg.includes('bad param'));
    assert.ok(msg.includes(String(ErrorCode.InvalidParams)));
  });

  it('describes a raw string', () => {
    const msg = describeError('some string error');
    assert.ok(msg.includes('some string error'));
  });

  it('describes a number', () => {
    const msg = describeError(42);
    assert.ok(msg.includes('42'));
  });
});

// ---------------------------------------------------------------------------
// Handler-level validation: searchMinutes with bad dates throws McpError
// ---------------------------------------------------------------------------

describe('Handler semantic validation — searchMinutes', async () => {
  const { searchMinutes } = await import('../src/mcp/handlers.js');

  it('throws McpError(InvalidParams) for invalid date_from format', async () => {
    await assert.rejects(
      () => searchMinutes({}, { date_from: '15-01-2025' }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for invalid date_to format', async () => {
    await assert.rejects(
      () => searchMinutes({}, { date_to: 'next-friday' }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('does NOT throw for valid YYYY-MM-DD dates', async () => {
    // Should reach the search logic (not throw on validation)
    await assert.doesNotReject(
      () => searchMinutes({}, { date_from: '2025-01-01', date_to: '2025-12-31' })
    );
  });

  it('throws McpError(InvalidParams) for limit = 0', async () => {
    await assert.rejects(
      () => searchMinutes({}, { limit: 0 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for negative offset', async () => {
    await assert.rejects(
      () => searchMinutes({}, { offset: -5 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });
});

// ---------------------------------------------------------------------------
// Handler-level validation: searchMeetingMinutes
// ---------------------------------------------------------------------------

describe('Handler semantic validation — searchMeetingMinutes', async () => {
  const { searchMeetingMinutes } = await import('../src/mcp/handlers.js');

  it('throws McpError(InvalidParams) for bad date_from', async () => {
    await assert.rejects(
      () => searchMeetingMinutes({}, { date_from: '2025.01.15' }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for bad date_to', async () => {
    await assert.rejects(
      () => searchMeetingMinutes({}, { date_to: '20250131' }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('does NOT throw for valid dates', async () => {
    await assert.doesNotReject(
      () => searchMeetingMinutes({}, { date_from: '2025-01-01', date_to: '2025-01-31' })
    );
  });

  it('throws McpError(InvalidParams) for limit exceeding max', async () => {
    await assert.rejects(
      () => searchMeetingMinutes({}, { limit: 51 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });
});

// ---------------------------------------------------------------------------
// Handler-level validation: summarizeMinutes
// ---------------------------------------------------------------------------

describe('Handler semantic validation — summarizeMinutes', async () => {
  const { summarizeMinutes } = await import('../src/mcp/handlers.js');

  it('throws McpError(InvalidParams) for bad date_from', async () => {
    await assert.rejects(
      () => summarizeMinutes({}, { date_from: 'jan-15-2025' }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for max_topics > 20', async () => {
    await assert.rejects(
      () => summarizeMinutes({}, { max_topics: 25 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for max_action_items > 50', async () => {
    await assert.rejects(
      () => summarizeMinutes({}, { max_action_items: 55 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for max_narrative_length < 50', async () => {
    await assert.rejects(
      () => summarizeMinutes({}, { max_narrative_length: 10 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for max_narrative_length > 2000', async () => {
    await assert.rejects(
      () => summarizeMinutes({}, { max_narrative_length: 9999 }),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('does NOT throw for all valid params', async () => {
    await assert.doesNotReject(
      () => summarizeMinutes({}, {
        date_from: '2025-01-01',
        limit: 3,
        max_topics: 5,
        max_action_items: 10,
        max_narrative_length: 500,
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Handler-level validation: listRecordings
// ---------------------------------------------------------------------------

describe('Handler semantic validation — listRecordings', async () => {
  const { listRecordings } = await import('../src/mcp/handlers.js');

  it('throws McpError(InvalidParams) for limit = 0', async () => {
    await assert.rejects(
      () => listRecordings({}, 0),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('throws McpError(InvalidParams) for limit > 100', async () => {
    await assert.rejects(
      () => listRecordings({}, 200),
      (err) => err instanceof McpError && err.code === ErrorCode.InvalidParams
    );
  });

  it('does NOT throw for default limit=20', async () => {
    await assert.doesNotReject(() => listRecordings({}, 20));
  });

  it('does NOT throw for limit=1', async () => {
    await assert.doesNotReject(() => listRecordings({}, 1));
  });
});

// ---------------------------------------------------------------------------
// MCP content response structure compliance
// ---------------------------------------------------------------------------

describe('MCP content response structure', () => {
  it('errorContent response has correct MCP content structure', () => {
    const resp = errorContent('Test error');
    // Must have content array
    assert.ok(Array.isArray(resp.content), 'content must be an array');
    assert.ok(resp.content.length > 0, 'content must have at least one item');
    // Each item must have type and text
    for (const item of resp.content) {
      assert.ok(item.type, 'content item must have type');
      assert.ok(typeof item.text === 'string', 'content item must have text string');
    }
    // Must have isError flag
    assert.equal(resp.isError, true);
  });

  it('handler errorContent uses text content type', () => {
    const resp = errorContent('Test');
    assert.equal(resp.content[0].type, 'text');
  });
});
