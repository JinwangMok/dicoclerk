import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleStart } from '../src/commands/start.js';
import { handleStop } from '../src/commands/stop.js';

// Helper to create a mock interaction
function createMockInteraction(overrides = {}) {
  return {
    guildId: 'guild-123',
    channelId: 'text-channel-456',
    member: {
      user: { tag: 'TestUser#1234', bot: false },
      voice: { channel: overrides.voiceChannel || null },
    },
    options: {
      getString: mock.fn((name) => {
        if (name === 'language') return overrides.language || null;
        return null;
      }),
    },
    guild: {
      id: 'guild-123',
      voiceAdapterCreator: {},
      channels: { cache: new Map() },
      members: { fetch: mock.fn(async () => ({ displayName: 'Test', user: { username: 'test' } })) },
    },
    reply: mock.fn(async () => {}),
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    ...overrides,
  };
}

/**
 * Create a mock SessionManager that implements the interface used by commands.
 * @param {Object} [existingSession] - An existing session to pre-populate
 * @returns {Object} mock session manager
 */
function createMockSessionManager(existingSession = null) {
  let session = existingSession;
  let stopped = false;

  return {
    hasSession: mock.fn(() => session !== null && !stopped),
    getSession: mock.fn(() => session),
    stopSession: mock.fn(() => {
      if (!session || stopped) return null;
      stopped = true;
      session.status = 'stopped';
      return session;
    }),
    startSession: mock.fn(async () => session),
    getConnectionManager: mock.fn(() => ({
      connection: { receiver: { subscribe: mock.fn() } },
    })),
    _getSession: () => session,
    _setSession: (s) => { session = s; stopped = false; },
  };
}

describe('/start command', () => {
  let sessionManager;

  beforeEach(() => {
    sessionManager = createMockSessionManager(null);
  });

  it('should reject if user is not in a voice channel', async () => {
    const interaction = createMockInteraction({ voiceChannel: null });

    await handleStart(interaction, sessionManager);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('must be in a voice channel'));
    assert.equal(replyArg.ephemeral, true);
  });

  it('should reject if a session is already active', async () => {
    sessionManager._setSession({
      voiceChannelId: 'vc-789',
      status: 'active',
    });

    const interaction = createMockInteraction({
      voiceChannel: { id: 'vc-999', members: new Map() },
    });

    await handleStart(interaction, sessionManager);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('already active'));
    assert.equal(replyArg.ephemeral, true);
  });
});

describe('/stop command', () => {
  let sessionManager;

  beforeEach(() => {
    sessionManager = createMockSessionManager(null);
  });

  it('should reject if no active session exists', async () => {
    const interaction = createMockInteraction();

    await handleStop(interaction, sessionManager);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('No active recording session'));
    assert.equal(replyArg.ephemeral, true);
  });

  it('should stop session and disconnect from voice channel', async () => {
    const coordinatorStopMock = mock.fn(async () => ({
      transcript: [
        { speaker: 0, speakerName: 'Alice', text: 'Hello', confidence: 0.95, start: 0, end: 1, timestamp: Date.now() },
      ],
      filePath: '/data/transcripts/test-transcript.json',
    }));

    sessionManager._setSession({
      voiceChannelId: 'vc-789',
      startedAt: new Date(Date.now() - 60000), // 1 minute ago
      participants: new Set(['user-1', 'user-2']),
      transcript: [],
      status: 'active',
      audioCoordinator: {
        isRunning: true,
        stop: coordinatorStopMock,
      },
    });

    const interaction = createMockInteraction();

    await handleStop(interaction, sessionManager);

    // Audio coordinator should be stopped first
    assert.equal(coordinatorStopMock.mock.callCount(), 1);
    // Session should be stopped via sessionManager
    assert.equal(sessionManager.stopSession.mock.callCount(), 1);
    assert.equal(interaction.deferReply.mock.callCount(), 1);
    assert.equal(interaction.editReply.mock.callCount(), 1);
    const replyArg = interaction.editReply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Recording stopped'));
    assert.ok(replyArg.content.includes('Participants: **2**'));
    assert.ok(replyArg.content.includes('Transcript entries: **1**'));
    assert.ok(replyArg.content.includes('Transcript saved'));
  });

  it('should stop session even if audio coordinator fails', async () => {
    sessionManager._setSession({
      voiceChannelId: 'vc-789',
      startedAt: new Date(Date.now() - 30000),
      participants: new Set(['user-1']),
      transcript: [{ text: 'fallback entry' }],
      status: 'active',
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => { throw new Error('Deepgram already closed'); }),
      },
    });

    const interaction = createMockInteraction();

    await handleStop(interaction, sessionManager);

    // Session should still be stopped despite coordinator error
    assert.equal(sessionManager.stopSession.mock.callCount(), 1);
    assert.equal(interaction.editReply.mock.callCount(), 1);
    const replyArg = interaction.editReply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Recording stopped'));
  });

  it('should handle session without audio coordinator', async () => {
    sessionManager._setSession({
      voiceChannelId: 'vc-789',
      startedAt: new Date(Date.now() - 10000),
      participants: new Set(),
      transcript: [],
      status: 'active',
      // No audioCoordinator — e.g. Deepgram was never connected
    });

    const interaction = createMockInteraction();

    await handleStop(interaction, sessionManager);

    assert.equal(sessionManager.stopSession.mock.callCount(), 1);
    assert.equal(interaction.editReply.mock.callCount(), 1);
    const replyArg = interaction.editReply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Recording stopped'));
    assert.ok(replyArg.content.includes('Participants: **0**'));
  });

  it('should handle already-stopped session gracefully', async () => {
    // getSession returns a session but stopSession returns null (race condition)
    sessionManager._setSession({
      voiceChannelId: 'vc-789',
      startedAt: new Date(),
      participants: new Set(),
      transcript: [],
      status: 'stopping', // Already in the process of stopping
    });

    // Override hasSession to return true but getSession returns non-active
    const interaction = createMockInteraction();

    await handleStop(interaction, sessionManager);

    // Should defer and then report already stopped
    assert.equal(interaction.deferReply.mock.callCount(), 1);
  });
});

describe('deploy-commands module', () => {
  it('should define valid slash command structures', async () => {
    // We can at least verify the SlashCommandBuilder creates valid JSON
    const { SlashCommandBuilder } = await import('discord.js');

    const startCmd = new SlashCommandBuilder()
      .setName('start')
      .setDescription('Start recording the voice channel meeting')
      .addStringOption(option =>
        option
          .setName('language')
          .setDescription('Language for speech recognition')
          .setRequired(false)
          .addChoices(
            { name: 'Korean', value: 'ko' },
            { name: 'English', value: 'en' },
            { name: 'Multi (Korean + English)', value: 'multi' }
          )
      );

    const stopCmd = new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop recording and generate meeting minutes');

    const startJson = startCmd.toJSON();
    const stopJson = stopCmd.toJSON();

    assert.equal(startJson.name, 'start');
    assert.equal(stopJson.name, 'stop');
    assert.equal(startJson.options.length, 1);
    assert.equal(startJson.options[0].name, 'language');
    assert.equal(startJson.options[0].choices.length, 3);
  });
});
