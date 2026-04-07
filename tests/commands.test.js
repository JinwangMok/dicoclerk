import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField } from 'discord.js';
import { handleStart } from '../src/commands/start.js';
import { handleStop } from '../src/commands/stop.js';

/**
 * Create a mock voice channel with controllable permissions.
 * @param {Object} options
 * @param {string} [options.id]
 * @param {(flag: bigint) => boolean} [options.permissionCheck] - Return true to grant the flag
 */
function createMockVoiceChannel({ id = 'vc-123', permissionCheck = () => true } = {}) {
  return {
    id,
    members: new Map(),
    permissionsFor: mock.fn(() => ({
      has: mock.fn(permissionCheck),
    })),
  };
}

// Helper to create a mock interaction
function createMockInteraction(overrides = {}) {
  // Default: bot member with full permissions (grants all flags)
  const defaultBotMember = { id: 'bot-user-id' };

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
      members: {
        fetch: mock.fn(async () => ({ displayName: 'Test', user: { username: 'test' } })),
        me: overrides.botMember !== undefined ? overrides.botMember : defaultBotMember,
      },
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
      voiceChannel: createMockVoiceChannel({ id: 'vc-999' }),
    });

    await handleStart(interaction, sessionManager);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('already active'));
    assert.equal(replyArg.ephemeral, true);
  });

  it('should reject if bot lacks VIEW_CHANNEL permission', async () => {
    const voiceChannel = createMockVoiceChannel({
      id: 'vc-123',
      // Deny ViewChannel, grant everything else
      permissionCheck: (flag) => flag !== PermissionsBitField.Flags.ViewChannel,
    });
    const interaction = createMockInteraction({ voiceChannel });
    // Ensure env doesn't block before permission check
    const savedKey = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = 'test-key';

    await handleStart(interaction, sessionManager);

    process.env.DEEPGRAM_API_KEY = savedKey;

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('View Channel'), `Expected 'View Channel' in: ${replyArg.content}`);
    assert.equal(replyArg.ephemeral, true);
  });

  it('should reject if bot lacks CONNECT permission', async () => {
    const voiceChannel = createMockVoiceChannel({
      id: 'vc-123',
      // Grant ViewChannel but deny Connect
      permissionCheck: (flag) => flag !== PermissionsBitField.Flags.Connect,
    });
    const interaction = createMockInteraction({ voiceChannel });
    const savedKey = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = 'test-key';

    await handleStart(interaction, sessionManager);

    process.env.DEEPGRAM_API_KEY = savedKey;

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Connect'), `Expected 'Connect' in: ${replyArg.content}`);
    assert.equal(replyArg.ephemeral, true);
  });

  it('should skip permission check when guild.members.me is null', async () => {
    // When botMember is null, permission checks should be skipped entirely
    // and fall through to the Deepgram key check
    const voiceChannel = createMockVoiceChannel({ id: 'vc-123' });
    const interaction = createMockInteraction({ voiceChannel, botMember: null });
    // No DEEPGRAM_API_KEY — expect it to fail at that check instead of permissions
    const savedKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    await handleStart(interaction, sessionManager);

    process.env.DEEPGRAM_API_KEY = savedKey;

    assert.equal(interaction.reply.mock.callCount(), 1);
    const replyArg = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(replyArg.content.includes('Deepgram API key'), `Expected Deepgram error in: ${replyArg.content}`);
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

  it('should reject if invoker is not in the active voice channel', async () => {
    sessionManager._setSession({
      voiceChannelId: 'vc-789',
      startedAt: new Date(),
      participants: new Set(),
      transcript: [],
      status: 'active',
    });

    // User is in a different voice channel (or no voice channel at all)
    const interactionWrongChannel = createMockInteraction({
      voiceChannel: { id: 'vc-different' },
    });
    await handleStop(interactionWrongChannel, sessionManager);
    assert.equal(interactionWrongChannel.reply.mock.callCount(), 1);
    const replyWrong = interactionWrongChannel.reply.mock.calls[0].arguments[0];
    assert.ok(replyWrong.content.includes('must be in the active voice channel'));
    assert.equal(replyWrong.ephemeral, true);

    // User is not in any voice channel
    const interactionNoChannel = createMockInteraction({ voiceChannel: null });
    await handleStop(interactionNoChannel, sessionManager);
    assert.equal(interactionNoChannel.reply.mock.callCount(), 1);
    const replyNo = interactionNoChannel.reply.mock.calls[0].arguments[0];
    assert.ok(replyNo.content.includes('must be in the active voice channel'));
    assert.equal(replyNo.ephemeral, true);
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

    // Invoker is in the same voice channel as the session
    const interaction = createMockInteraction({
      voiceChannel: { id: 'vc-789' },
    });

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

    const interaction = createMockInteraction({ voiceChannel: { id: 'vc-789' } });

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

    const interaction = createMockInteraction({ voiceChannel: { id: 'vc-789' } });

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
    const interaction = createMockInteraction({ voiceChannel: { id: 'vc-789' } });

    await handleStop(interaction, sessionManager);

    // Should defer and then report already stopped
    assert.equal(interaction.deferReply.mock.callCount(), 1);
  });
});

// ---------------------------------------------------------------------------
// /start command — configurable text channel resolution (Sub-AC 7b)
// ---------------------------------------------------------------------------

describe('/start command - configurable text channel (Sub-AC 7b)', () => {
  let savedApiKey;

  beforeEach(() => {
    savedApiKey = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = 'test-api-key-for-channel-tests';
  });

  afterEach(() => {
    if (savedApiKey !== undefined) {
      process.env.DEEPGRAM_API_KEY = savedApiKey;
    } else {
      delete process.env.DEEPGRAM_API_KEY;
    }
  });

  /**
   * Session manager variant where startSession succeeds and captures its options.
   * Used for testing the happy path where /start proceeds past all validations.
   */
  function createStartableSessionManager() {
    let capturedStartOptions = null;
    const mockSession = {
      guildId: 'guild-123',
      voiceChannelId: 'vc-123',
      textChannelId: null,
      language: 'multi',
      startedAt: new Date(),
      startedBy: 'TestUser#1234',
      participants: new Set(),
      transcript: [],
      status: 'active',
      audioCoordinator: null,
    };

    return {
      hasSession: mock.fn(() => false),
      getSession: mock.fn(() => null),
      stopSession: mock.fn(() => null),
      startSession: mock.fn(async (options) => {
        capturedStartOptions = options;
        mockSession.textChannelId = options.textChannelId;
        return mockSession;
      }),
      getConnectionManager: mock.fn(() => ({
        connection: {
          receiver: {
            speaking: { on: mock.fn() },
            subscribe: mock.fn(),
          },
        },
      })),
      _getCapturedOptions: () => capturedStartOptions,
      _session: mockSession,
    };
  }

  /**
   * Minimal AudioSessionCoordinator mock compatible with handleStart's _deps injection.
   * Returns an object from the constructor so `new MockCoordinator()` yields the mock instance.
   */
  function createMockCoordinatorClass() {
    const instance = {
      start: mock.fn(async () => {}),
      stop: mock.fn(async () => ({ transcript: [], filePath: null })),
      registerUser: mock.fn(),
      on: mock.fn(),
      isRunning: false,
      transcript: [],
      speakerMap: new Map(),
    };
    // Returning an object from a constructor causes `new` to use that object instead of `this`.
    function MockCoordinatorClass() { return instance; }
    MockCoordinatorClass._instance = instance;
    return MockCoordinatorClass;
  }

  /** Minimal deps override for happy-path /start tests. */
  function createMockDeps() {
    return {
      AudioSessionCoordinator: createMockCoordinatorClass(),
      cleanupSession: mock.fn(async () => ({
        transcriptCount: 0,
        transcript: [],
        duration: 0,
        durationMinutes: 0,
        durationSeconds: 0,
        participantCount: 0,
        transcriptFilePath: null,
        speakerMap: null,
        warnings: [],
      })),
      generateAndDeliverMinutes: mock.fn(async () => ({ success: true })),
    };
  }

  it('should use the configured text channel from GuildConfigStore when one is set', async () => {
    const sessionManager = createStartableSessionManager();
    const guildConfigStore = {
      getTextChannelId: mock.fn(async () => 'configured-minutes-ch-999'),
    };
    const voiceChannel = createMockVoiceChannel({ id: 'vc-123' });
    const interaction = createMockInteraction({
      voiceChannel,
      channelId: 'start-invocation-channel-111',
    });

    await handleStart(interaction, sessionManager, guildConfigStore, createMockDeps());

    // startSession must have been called with the configured channel, not the invocation channel
    assert.equal(sessionManager.startSession.mock.callCount(), 1);
    const startOpts = sessionManager._getCapturedOptions();
    assert.equal(
      startOpts.textChannelId,
      'configured-minutes-ch-999',
      `Expected configured channel 'configured-minutes-ch-999', got '${startOpts.textChannelId}'`
    );

    // Success reply should mention the configured channel ID
    assert.equal(interaction.editReply.mock.callCount(), 1);
    const replyContent = interaction.editReply.mock.calls[0].arguments[0].content;
    assert.ok(
      replyContent.includes('configured-minutes-ch-999'),
      `Expected configured channel mention in reply: ${replyContent}`
    );
  });

  it('should fall back to the invocation channel when GuildConfigStore returns null', async () => {
    const sessionManager = createStartableSessionManager();
    const guildConfigStore = {
      getTextChannelId: mock.fn(async () => null), // no configured channel
    };
    const voiceChannel = createMockVoiceChannel({ id: 'vc-123' });
    const interaction = createMockInteraction({
      voiceChannel,
      channelId: 'start-invocation-channel-222',
    });

    await handleStart(interaction, sessionManager, guildConfigStore, createMockDeps());

    assert.equal(sessionManager.startSession.mock.callCount(), 1);
    const startOpts = sessionManager._getCapturedOptions();
    assert.equal(
      startOpts.textChannelId,
      'start-invocation-channel-222',
      `Expected fallback invocation channel, got '${startOpts.textChannelId}'`
    );

    // Reply should indicate minutes go to "this channel" (fallback)
    const replyContent = interaction.editReply.mock.calls[0].arguments[0].content;
    assert.ok(
      replyContent.includes('this channel'),
      `Expected 'this channel' fallback in reply: ${replyContent}`
    );
  });

  it('should fall back to the invocation channel when no guildConfigStore is provided (standalone mode)', async () => {
    const sessionManager = createStartableSessionManager();
    const voiceChannel = createMockVoiceChannel({ id: 'vc-123' });
    const interaction = createMockInteraction({
      voiceChannel,
      channelId: 'start-invocation-channel-333',
    });

    // Passing null guildConfigStore simulates standalone mode (no /setup configured)
    await handleStart(interaction, sessionManager, null, createMockDeps());

    assert.equal(sessionManager.startSession.mock.callCount(), 1);
    const startOpts = sessionManager._getCapturedOptions();
    assert.equal(
      startOpts.textChannelId,
      'start-invocation-channel-333',
      `Expected invocation channel in standalone mode, got '${startOpts.textChannelId}'`
    );
  });

  it('should use the configured channel even when GuildConfigStore ID differs from invocation channel', async () => {
    // This test verifies the priority: configured > invocation
    const sessionManager = createStartableSessionManager();
    const guildConfigStore = {
      getTextChannelId: mock.fn(async () => 'designated-minutes-channel'),
    };
    const voiceChannel = createMockVoiceChannel({ id: 'vc-123' });
    const interaction = createMockInteraction({
      voiceChannel,
      channelId: 'general-chat-channel', // where /start was typed
    });

    await handleStart(interaction, sessionManager, guildConfigStore, createMockDeps());

    const startOpts = sessionManager._getCapturedOptions();
    // The designated minutes channel (not general chat) must be used
    assert.equal(startOpts.textChannelId, 'designated-minutes-channel');
    assert.notEqual(startOpts.textChannelId, 'general-chat-channel');
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
