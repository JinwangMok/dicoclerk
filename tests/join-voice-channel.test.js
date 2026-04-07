/**
 * Tests for the MCP 'join_voice_channel' tool handler.
 *
 * Covers:
 *   - Standalone mode (no Discord client) → errorContent
 *   - Guild not found → errorContent
 *   - Channel not found → errorContent
 *   - Non-voice channel → errorContent
 *   - Already connected (session active in same channel) → already_connected
 *   - Session active in different channel → session_active
 *   - Input schema validation (guild_id, channel_id required, non-empty)
 *   - Output schema validation (JoinVoiceChannelOutputSchema)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { joinVoiceChannel } from '../src/mcp/handlers.js';
import { validateToolInput, validateToolOutput } from '../src/mcp/validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal Discord.js Collection-like object for mocking channel.members.
 * Discord.js Collections extend Map and add a .filter() that returns a new Collection.
 */
function makeCollection(entries = []) {
  const m = new Map(entries);
  // Add .filter() that mirrors Discord.js Collection.filter() — returns a filtered Map-like
  m.filter = function (fn) {
    const result = new Map();
    result.filter = m.filter.bind(result);
    for (const [k, v] of this) {
      if (fn(v, k, this)) result.set(k, v);
    }
    return result;
  };
  return m;
}

function makeVoiceChannel(id = 'vc123', name = 'General', memberCount = 3) {
  const entries = [];
  for (let i = 0; i < memberCount; i++) {
    entries.push([`user${i}`, { user: { bot: false } }]);
  }
  const members = makeCollection(entries);
  return {
    id,
    name,
    isVoiceBased: () => true,
    members,
  };
}

function makeTextChannel(id = 'tc123') {
  return { id, isVoiceBased: () => false };
}

function makeGuild(channels = {}) {
  const channelCache = new Map(Object.entries(channels));
  return {
    id: 'guild123',
    channels: { cache: channelCache },
  };
}

function makeClient(guilds = {}) {
  const guildCache = new Map(Object.entries(guilds));
  return { guilds: { cache: guildCache } };
}

function makeSessionManager(sessions = {}) {
  const sessionMap = new Map(Object.entries(sessions));
  return {
    hasSession: (guildId) => sessionMap.has(guildId),
    getSession: (guildId) => sessionMap.get(guildId) ?? null,
    getAllSessions: () => sessionMap,
  };
}

function parseResult(result) {
  assert.ok(result.content, 'result must have content');
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// Schema validation tests
// ---------------------------------------------------------------------------

describe('join_voice_channel — input schema validation', () => {
  it('accepts valid guild_id and channel_id', () => {
    const r = validateToolInput('join_voice_channel', {
      guild_id: '123456789',
      channel_id: '987654321',
    });
    assert.ok(r.success, `Expected success but got errors: ${r.errors}`);
    assert.equal(r.data.guild_id, '123456789');
    assert.equal(r.data.channel_id, '987654321');
  });

  it('rejects missing guild_id', () => {
    const r = validateToolInput('join_voice_channel', { channel_id: 'vc123' });
    assert.ok(!r.success, 'Should fail when guild_id is missing');
  });

  it('rejects missing channel_id', () => {
    const r = validateToolInput('join_voice_channel', { guild_id: 'g123' });
    assert.ok(!r.success, 'Should fail when channel_id is missing');
  });

  it('rejects empty guild_id', () => {
    const r = validateToolInput('join_voice_channel', { guild_id: '', channel_id: 'vc123' });
    assert.ok(!r.success, 'Should fail with empty guild_id');
  });

  it('rejects empty channel_id', () => {
    const r = validateToolInput('join_voice_channel', { guild_id: 'g123', channel_id: '' });
    assert.ok(!r.success, 'Should fail with empty channel_id');
  });
});

describe('join_voice_channel — output schema validation', () => {
  it('validates a successful connected response', () => {
    const data = {
      connected: true,
      guild_id: 'g123',
      channel_id: 'vc123',
      channel_name: 'General',
      member_count: 2,
      connection_state: 'connected',
      message: 'Successfully joined.',
    };
    const r = validateToolOutput('join_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('validates a failed response', () => {
    const data = {
      connected: false,
      guild_id: 'g123',
      channel_id: 'vc123',
      channel_name: 'General',
      member_count: 0,
      connection_state: 'failed',
      message: 'Could not connect.',
    };
    const r = validateToolOutput('join_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('validates an already_connected response with optional session_id', () => {
    const data = {
      connected: true,
      guild_id: 'g123',
      channel_id: 'vc123',
      channel_name: 'General',
      member_count: 3,
      connection_state: 'already_connected',
      session_id: 'session-abc',
      message: 'Already in channel.',
    };
    const r = validateToolOutput('join_voice_channel', data);
    assert.ok(r.success, `Output schema validation failed: ${r.errors}`);
  });

  it('rejects invalid connection_state enum value', () => {
    const data = {
      connected: true,
      guild_id: 'g123',
      channel_id: 'vc123',
      member_count: 0,
      connection_state: 'unknown_state',
      message: 'Bad state.',
    };
    const r = validateToolOutput('join_voice_channel', data);
    assert.ok(!r.success, 'Should reject unknown connection_state');
  });
});

// ---------------------------------------------------------------------------
// Handler behaviour tests
// ---------------------------------------------------------------------------

describe('join_voice_channel — standalone mode (no client)', () => {
  it('returns errorContent when client is null', async () => {
    const result = await joinVoiceChannel({ client: null, sessionManager: null }, 'guild123', 'vc123');
    assert.ok(result.isError, 'Should be an error response');
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });

  it('returns errorContent when client is undefined', async () => {
    const result = await joinVoiceChannel({}, 'guild123', 'vc123');
    assert.ok(result.isError, 'Should be an error response');
  });
});

describe('join_voice_channel — guild/channel resolution errors', () => {
  it('returns error when guild is not found', async () => {
    const client = makeClient({}); // empty guild cache
    const result = await joinVoiceChannel({ client, sessionManager: null }, 'guild123', 'vc123');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild123'));
  });

  it('returns error when channel is not found in guild', async () => {
    const guild = makeGuild({}); // empty channel cache
    const client = makeClient({ guild123: guild });
    const result = await joinVoiceChannel({ client, sessionManager: null }, 'guild123', 'vc999');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('vc999'));
  });

  it('returns error when channel is not a voice channel', async () => {
    const textChannel = makeTextChannel('tc123');
    const guild = makeGuild({ tc123: textChannel });
    const client = makeClient({ guild123: guild });
    const result = await joinVoiceChannel({ client, sessionManager: null }, 'guild123', 'tc123');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('not a voice channel'));
  });
});

describe('join_voice_channel — already_connected (active session in same channel)', () => {
  it('returns already_connected when bot is in the same channel via active session', async () => {
    const voiceChannel = makeVoiceChannel('vc123', 'Gaming', 2);
    const guild = makeGuild({ vc123: voiceChannel });
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({
      guild123: {
        voiceChannelId: 'vc123',
        textChannelId: 'tc123',
        startedAt: new Date(),
        participants: new Set(['user1', 'user2']),
        transcript: [],
      },
    });

    const result = await joinVoiceChannel({ client, sessionManager }, 'guild123', 'vc123');
    assert.ok(!result.isError, 'Should not be an error');
    const data = parseResult(result);
    assert.ok(data.connected);
    assert.equal(data.connection_state, 'already_connected');
    assert.equal(data.guild_id, 'guild123');
    assert.equal(data.channel_id, 'vc123');
    assert.equal(data.channel_name, 'Gaming');
    assert.equal(typeof data.member_count, 'number');
    assert.ok(data.message.includes('already connected'));
  });
});

describe('join_voice_channel — session_active (active session in different channel)', () => {
  it('returns session_active when bot is in a different channel for the guild', async () => {
    const voiceChannel = makeVoiceChannel('vc456', 'Meetings', 1);
    const guild = makeGuild({ vc456: voiceChannel });
    const client = makeClient({ guild123: guild });
    const sessionManager = makeSessionManager({
      guild123: {
        voiceChannelId: 'vc789', // different channel
        textChannelId: 'tc123',
        startedAt: new Date(),
        participants: new Set(['user1']),
        transcript: [],
      },
    });

    const result = await joinVoiceChannel({ client, sessionManager }, 'guild123', 'vc456');
    assert.ok(!result.isError, 'Should not be an error response (it is a status response)');
    const data = parseResult(result);
    assert.ok(!data.connected);
    assert.equal(data.connection_state, 'session_active');
    assert.ok(data.message.includes('vc789'));
  });
});
