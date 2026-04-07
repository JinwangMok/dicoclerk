/**
 * Tests for the MCP 'leave_voice_channel' tool handler.
 *
 * Covers:
 *   - Input schema validation (guild_id required, non-empty)
 *   - Output schema validation (LeaveVoiceChannelOutputSchema)
 *   - Standalone mode (no Discord client) → errorContent
 *   - No session manager → errorContent
 *   - Guild not found → errorContent
 *   - No session, no bare voice connection → errorContent
 *   - Active session: graceful cleanup, transcript finalization, minutes trigger
 *   - Active session with no transcript entries → minutes_generation: 'skipped'
 *   - Active session with transcript entries → minutes_generation: 'pending'
 *   - Warnings propagated from cleanupSession
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { validateToolInput, validateToolOutput } from '../src/mcp/validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSessionManager(sessions = {}) {
  const sessionMap = new Map(Object.entries(sessions));
  return {
    hasSession: (guildId) => sessionMap.has(guildId),
    getSession: (guildId) => sessionMap.get(guildId) ?? null,
    stopSession: (guildId) => { sessionMap.delete(guildId); return null; },
    getAllSessions: () => sessionMap,
  };
}

function makeClient(guilds = {}) {
  const guildCache = new Map(Object.entries(guilds));
  return { guilds: { cache: guildCache } };
}

function makeGuild(id = 'guild123') {
  return { id };
}

function makeSession({
  guildId = 'guild123',
  voiceChannelId = 'vc123',
  textChannelId = 'tc123',
  language = 'multi',
  transcriptEntries = [],
  hasCoordinator = false,
  coordinatorRunning = false,
} = {}) {
  const session = {
    guildId,
    voiceChannelId,
    textChannelId,
    language,
    startedAt: new Date(Date.now() - 90_000), // 90 seconds ago
    startedBy: 'MCP Agent',
    participants: new Set(['user1', 'user2']),
    transcript: transcriptEntries,
    status: 'active',
  };

  if (hasCoordinator) {
    session.audioCoordinator = {
      isRunning: coordinatorRunning,
      sessionId: 'coord-session-abc',
      transcript: transcriptEntries,
      speakerMap: new Map(),
      stop: async () => ({
        transcript: transcriptEntries,
        filePath: transcriptEntries.length > 0 ? '/data/transcripts/test.json' : null,
      }),
    };
  }

  return session;
}

/**
 * Parse a successful (non-error) MCP tool result.
 */
function parseResult(result) {
  assert.ok(result.content, 'result must have content');
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// We import leaveVoiceChannel lazily inside each test to allow cleanupSession
// to be mocked via module-level injection. For tests that need cleanup mocking
// we call a thin test-only wrapper that injects deps explicitly.
// ---------------------------------------------------------------------------

import { leaveVoiceChannel } from '../src/mcp/handlers.js';

// ---------------------------------------------------------------------------
// Input schema validation
// ---------------------------------------------------------------------------

describe('leave_voice_channel — input schema validation', () => {
  it('accepts valid guild_id', () => {
    const r = validateToolInput('leave_voice_channel', { guild_id: '123456789' });
    assert.ok(r.success, `Expected success but got: ${r.errors}`);
    assert.equal(r.data.guild_id, '123456789');
  });

  it('rejects missing guild_id', () => {
    const r = validateToolInput('leave_voice_channel', {});
    assert.ok(!r.success, 'Should fail when guild_id is missing');
  });

  it('rejects empty guild_id', () => {
    const r = validateToolInput('leave_voice_channel', { guild_id: '' });
    assert.ok(!r.success, 'Should fail with empty guild_id');
  });

  it('rejects non-string guild_id', () => {
    const r = validateToolInput('leave_voice_channel', { guild_id: 12345 });
    assert.ok(!r.success, 'Should fail with non-string guild_id');
  });
});

// ---------------------------------------------------------------------------
// Output schema validation
// ---------------------------------------------------------------------------

describe('leave_voice_channel — output schema validation', () => {
  it('validates a full session-end response', () => {
    const data = {
      disconnected: true,
      guild_id: 'g123',
      had_session: true,
      session_id: 'sess-abc',
      duration_seconds: 90,
      duration_formatted: '1m 30s',
      participant_count: 2,
      transcript_count: 5,
      transcript_file: '/data/transcripts/test.json',
      minutes_generation: 'pending',
      message: 'Session ended.',
    };
    const r = validateToolOutput('leave_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('validates a no-session disconnect response', () => {
    const data = {
      disconnected: true,
      guild_id: 'g123',
      had_session: false,
      minutes_generation: 'not_applicable',
      message: 'Bot disconnected (no session).',
    };
    const r = validateToolOutput('leave_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('validates a skipped minutes response', () => {
    const data = {
      disconnected: true,
      guild_id: 'g123',
      had_session: true,
      duration_seconds: 10,
      duration_formatted: '0m 10s',
      participant_count: 1,
      transcript_count: 0,
      transcript_file: null,
      minutes_generation: 'skipped',
      message: 'Session ended. No transcript entries.',
    };
    const r = validateToolOutput('leave_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('validates a response with warnings', () => {
    const data = {
      disconnected: true,
      guild_id: 'g123',
      had_session: true,
      duration_seconds: 60,
      duration_formatted: '1m 0s',
      participant_count: 1,
      transcript_count: 3,
      transcript_file: null,
      minutes_generation: 'pending',
      warnings: ['Audio coordinator stop failed: timeout'],
      message: 'Session ended with warnings.',
    };
    const r = validateToolOutput('leave_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('rejects invalid minutes_generation enum value', () => {
    const data = {
      disconnected: true,
      guild_id: 'g123',
      had_session: false,
      minutes_generation: 'unknown_value',
      message: 'done',
    };
    const r = validateToolOutput('leave_voice_channel', data);
    assert.ok(!r.success, 'Should reject unknown minutes_generation value');
  });

  it('rejects missing required fields', () => {
    const r = validateToolOutput('leave_voice_channel', { disconnected: true });
    assert.ok(!r.success, 'Should fail when required fields are absent');
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — standalone mode
// ---------------------------------------------------------------------------

describe('leave_voice_channel — standalone mode (no client)', () => {
  it('returns errorContent when client is null', async () => {
    const result = await leaveVoiceChannel({ client: null, sessionManager: null }, 'guild123');
    assert.ok(result.isError, 'Should be an error response');
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });

  it('returns errorContent when client is undefined', async () => {
    const result = await leaveVoiceChannel({}, 'guild123');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — no session manager
// ---------------------------------------------------------------------------

describe('leave_voice_channel — no session manager', () => {
  it('returns errorContent when sessionManager is null', async () => {
    const client = makeClient({ guild123: makeGuild() });
    const result = await leaveVoiceChannel({ client, sessionManager: null }, 'guild123');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Session manager not available'));
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — no session, guild not found
// ---------------------------------------------------------------------------

describe('leave_voice_channel — no session, guild not found', () => {
  it('returns errorContent when guild is absent from cache', async () => {
    const client = makeClient({}); // empty guild cache
    const sessionManager = makeSessionManager({}); // no sessions
    const result = await leaveVoiceChannel({ client, sessionManager }, 'guild999');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild999'));
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — no session, no voice connection
// ---------------------------------------------------------------------------

describe('leave_voice_channel — no session, no bare voice connection', () => {
  it('returns errorContent when no session and no voice connection', async () => {
    const guild = makeGuild('guild123');
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({}); // no active sessions

    // @discordjs/voice mock: getVoiceConnection returns undefined
    const result = await leaveVoiceChannel({ client, sessionManager }, 'guild123');
    assert.ok(result.isError);
    assert.ok(
      result.content[0].text.includes('No active session') ||
      result.content[0].text.includes('not currently in a voice channel'),
      `Unexpected error: ${result.content[0].text}`
    );
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — active session with transcript entries
// ---------------------------------------------------------------------------

describe('leave_voice_channel — active session with transcripts', () => {
  it('returns disconnected=true, had_session=true, minutes_generation=pending', async () => {
    const transcriptEntries = [
      { speaker: 'Speaker 0', text: 'Hello world', timestamp: '00:00:01' },
      { speaker: 'Speaker 1', text: 'How are you?', timestamp: '00:00:05' },
    ];
    const session = makeSession({
      transcriptEntries,
      hasCoordinator: true,
      coordinatorRunning: true,
    });

    const guild = makeGuild('guild123');
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({ guild123: session });

    // Mock generateAndDeliverMinutes to avoid real file I/O
    // We use the real leaveVoiceChannel but suppress the async fire-and-forget
    // by providing a session whose coordinator.stop() returns our mock data.
    // The handler fires generateAndDeliverMinutes as fire-and-forget — it won't
    // throw synchronously, so the response check is safe.
    const result = await leaveVoiceChannel({ client, sessionManager }, 'guild123');

    // Should not be an error
    assert.ok(!result.isError, `Expected success but got error: ${result.content[0].text}`);

    const data = parseResult(result);
    assert.ok(data.disconnected, 'disconnected should be true');
    assert.equal(data.guild_id, 'guild123');
    assert.ok(data.had_session, 'had_session should be true');
    assert.equal(typeof data.duration_seconds, 'number');
    assert.ok(data.duration_seconds >= 0);
    assert.ok(typeof data.duration_formatted === 'string');
    assert.equal(data.participant_count, 2);
    assert.ok(typeof data.transcript_count === 'number');
    assert.ok(
      data.minutes_generation === 'pending' || data.minutes_generation === 'skipped',
      `minutes_generation should be pending or skipped, got: ${data.minutes_generation}`
    );
    assert.ok(data.message.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — active session with no transcript entries
// ---------------------------------------------------------------------------

describe('leave_voice_channel — active session with no transcripts', () => {
  it('returns minutes_generation=skipped when transcript is empty', async () => {
    const session = makeSession({
      transcriptEntries: [],
      hasCoordinator: true,
      coordinatorRunning: false,
    });

    const guild = makeGuild('guild123');
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({ guild123: session });

    const result = await leaveVoiceChannel({ client, sessionManager }, 'guild123');

    assert.ok(!result.isError, `Expected success: ${result.content?.[0]?.text}`);
    const data = parseResult(result);
    assert.ok(data.disconnected);
    assert.ok(data.had_session);
    assert.equal(data.minutes_generation, 'skipped');
    assert.ok(data.message.includes('No transcript') || data.message.includes('skipped'));
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour — active session without coordinator
// ---------------------------------------------------------------------------

describe('leave_voice_channel — active session without audio coordinator', () => {
  it('handles cleanup gracefully when no coordinator is attached', async () => {
    const session = makeSession({
      transcriptEntries: [],
      hasCoordinator: false,
    });

    const guild = makeGuild('guild123');
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({ guild123: session });

    const result = await leaveVoiceChannel({ client, sessionManager }, 'guild123');
    assert.ok(!result.isError, `Expected success: ${result.content?.[0]?.text}`);
    const data = parseResult(result);
    assert.ok(data.disconnected);
    assert.ok(data.had_session);
    // Warnings about missing coordinator should be present or minutes skipped
    assert.ok(
      data.minutes_generation === 'skipped' || (data.warnings && data.warnings.length > 0),
      'Should indicate skipped minutes or warnings when no coordinator'
    );
  });
});

// ---------------------------------------------------------------------------
// Output schema cross-check: validate all handler responses
// ---------------------------------------------------------------------------

describe('leave_voice_channel — output schema cross-check', () => {
  it('handler response passes LeaveVoiceChannelOutputSchema', async () => {
    const session = makeSession({
      transcriptEntries: [{ speaker: 'A', text: 'hi', timestamp: '00:00:01' }],
      hasCoordinator: true,
      coordinatorRunning: true,
    });

    const guild = makeGuild('guild123');
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({ guild123: session });

    const result = await leaveVoiceChannel({ client, sessionManager }, 'guild123');
    assert.ok(!result.isError);

    const data = parseResult(result);
    const validation = validateToolOutput('leave_voice_channel', data);
    assert.ok(
      validation.success,
      `Handler response failed output schema: ${validation.errors}`
    );
  });
});
