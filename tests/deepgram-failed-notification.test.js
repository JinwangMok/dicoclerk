/**
 * Tests for Sub-AC 2: User notification and graceful session termination
 * when all Deepgram reconnect attempts are exhausted.
 *
 * Verifies that the deepgram_failed handler in /start:
 * 1. Sends a clear failure message to the configured textChannelId (not the command channel)
 * 2. Calls cleanupSession to gracefully tear down the recording session
 * 3. Calls generateAndDeliverMinutes when transcript entries exist
 * 4. Skips minutes generation when no transcript was captured
 * 5. Skips cleanup when session already ended (race condition guard)
 *
 * Uses the _deps injection parameter on handleStart() to avoid module mocking —
 * AudioSessionCoordinator, cleanupSession, and generateAndDeliverMinutes are all
 * passed in directly from the test.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { handleStart } from '../src/commands/start.js';

// ---------------------------------------------------------------------------
// Controllable coordinator stub — extends EventEmitter so tests can emit events
// ---------------------------------------------------------------------------

class StubCoordinator extends EventEmitter {
  constructor() {
    super();
    this.started = false;
    this.registeredUsers = [];
  }
  async start() { this.started = true; }
  registerUser(userId, name) { this.registeredUsers.push({ userId, name }); }
  get transcript() { return []; }
  get speakerMap() { return new Map(); }
  get isRunning() { return this.started; }
  stop() { this.started = false; return Promise.resolve({ transcript: [], filePath: null }); }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeCleanupResult({
  transcriptCount = 3,
  transcript = null,
  reason = 'deepgram_failed',
} = {}) {
  return {
    success: true,
    reason,
    duration: 120,
    durationMinutes: 2,
    durationSeconds: 0,
    participantCount: 2,
    transcriptCount,
    transcript: transcript ?? Array.from({ length: transcriptCount }, (_, i) => ({ text: `entry ${i}` })),
    transcriptFilePath: transcriptCount > 0 ? '/data/transcripts/t.json' : null,
    speakerMap: null,
    warnings: [],
  };
}

function makeMinutesResult() {
  return {
    success: true,
    filePath: '/data/minutes/m.md',
    error: null,
    deliverySuccess: true,
    deliveryError: null,
    generationTimeMs: 500,
  };
}

function makeFakeSession({
  guildId = 'guild-1',
  voiceChannelId = 'vc-1',
  textChannelId = 'text-configured',
} = {}) {
  return {
    guildId,
    voiceChannelId,
    textChannelId,
    language: 'multi',
    startedAt: new Date(Date.now() - 120_000),
    startedBy: 'TestUser#0001',
    participants: new Set(['u1', 'u2']),
    transcript: [],
    status: 'active',
  };
}

function makeSessionManager(session, { hasSessionOverride = null } = {}) {
  // Track whether startSession has been called so the first hasSession()
  // call (inside handleStart's "already active?" guard) returns false, while
  // subsequent calls (inside the deepgram_failed handler's race-condition guard)
  // return true — unless overridden.
  let sessionStarted = false;

  return {
    hasSession: mock.fn(() => {
      if (hasSessionOverride !== null) return hasSessionOverride;
      return sessionStarted;
    }),
    getSession: mock.fn(() => session),
    stopSession: mock.fn(() => {
      if (session) { session.status = 'stopped'; sessionStarted = false; }
      return session;
    }),
    startSession: mock.fn(async () => {
      sessionStarted = true;
      return session;
    }),
    getConnectionManager: mock.fn(() => ({
      connection: {},   // truthy — handleStart won't throw
    })),
  };
}

function makeInteraction({
  guildId = 'guild-1',
  commandChannelId = 'text-command',
  voiceChannelId = 'vc-1',
  channelCache = new Map(),
} = {}) {
  return {
    guildId,
    channelId: commandChannelId,
    member: {
      user: { tag: 'TestUser#0001', bot: false },
      voice: {
        channel: {
          id: voiceChannelId,
          members: new Map(),
          // Required by the permission checks in handleStart
          permissionsFor: mock.fn(() => ({ has: mock.fn(() => true) })),
        },
      },
    },
    options: { getString: mock.fn(() => null) },
    guild: {
      id: guildId,
      voiceAdapterCreator: {},
      channels: { cache: channelCache },
      members: {
        fetch: mock.fn(async () => ({ displayName: 'Test', user: { username: 'test' } })),
        me: { id: 'bot-id' },
      },
    },
    reply: mock.fn(async () => {}),
    deferReply: mock.fn(async () => {}),
    editReply: mock.fn(async () => {}),
    client: {
      guilds: {
        cache: new Map([[guildId, { channels: { cache: channelCache } }]]),
      },
    },
    deferred: false,
    replied: false,
  };
}

/**
 * Wait for the async deepgram_failed handler to finish after the event fires.
 * Uses setImmediate + setTimeout to flush both microtasks and macro-tasks.
 */
async function flushAsync(ms = 30) {
  await new Promise(r => setImmediate(r));
  await new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deepgram_failed: notification and graceful session termination', () => {

  beforeEach(() => {
    // Ensure DEEPGRAM_API_KEY is set so handleStart doesn't bail out early
    process.env.DEEPGRAM_API_KEY = 'test-api-key';
  });

  it('sends failure notification to configured textChannelId, not the command invocation channel', async () => {
    const configuredTextChannelId = 'text-configured';
    const commandChannelId = 'text-command';   // Where /start was typed — DIFFERENT

    const sentTo = [];
    const configuredChannel = { send: mock.fn(async (msg) => sentTo.push({ ch: 'configured', msg })) };
    const commandChannel    = { send: mock.fn(async (msg) => sentTo.push({ ch: 'command',    msg })) };

    const channelCache = new Map([
      [configuredTextChannelId, configuredChannel],
      [commandChannelId,        commandChannel],
    ]);

    const session = makeFakeSession({ textChannelId: configuredTextChannelId });
    const sm = makeSessionManager(session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor(opts) { super(); coordinator = this; }
    };

    const cleanupMock = mock.fn(async () => makeCleanupResult());
    const minutesMock = mock.fn(async () => makeMinutesResult());

    const interaction = makeInteraction({ commandChannelId, channelCache });
    const guildConfigStore = { getTextChannelId: mock.fn(async () => configuredTextChannelId) };

    await handleStart(interaction, sm, guildConfigStore, {
      AudioSessionCoordinator: CoordinatorStub,
      cleanupSession: cleanupMock,
      generateAndDeliverMinutes: minutesMock,
    });

    assert.ok(coordinator, 'coordinator stub should be created');

    // Trigger the permanent failure
    coordinator.emit('deepgram_failed');
    await flushAsync();

    // Notification must go to the configured text channel
    const configuredSends = sentTo.filter(s => s.ch === 'configured');
    assert.ok(
      configuredSends.length >= 1,
      `Expected ≥1 send to configured channel, got ${configuredSends.length}. Sends: ${JSON.stringify(sentTo.map(s => s.ch))}`
    );

    // The command channel must receive nothing from the failure handler
    const commandSends = sentTo.filter(s => s.ch === 'command');
    assert.equal(
      commandSends.length, 0,
      `Failure notification must NOT go to command channel. Got: ${JSON.stringify(commandSends)}`
    );
  });


  it('first failure message clearly indicates permanent disconnection', async () => {
    const textChannelId = 'text-ch';
    const receivedMessages = [];
    const channel = { send: mock.fn(async (msg) => receivedMessages.push(msg)) };
    const channelCache = new Map([[textChannelId, channel]]);

    const session = makeFakeSession({ textChannelId });
    const sm = makeSessionManager(session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor() { super(); coordinator = this; }
    };

    await handleStart(
      makeInteraction({ channelCache }),
      sm,
      { getTextChannelId: mock.fn(async () => textChannelId) },
      {
        AudioSessionCoordinator: CoordinatorStub,
        cleanupSession: mock.fn(async () => makeCleanupResult()),
        generateAndDeliverMinutes: mock.fn(async () => makeMinutesResult()),
      }
    );

    coordinator.emit('deepgram_failed');
    await flushAsync();

    assert.ok(receivedMessages.length >= 1, 'At least one message should be sent');

    const firstContent = receivedMessages[0].content;
    assert.ok(
      /permanent|exhausted|stopped/i.test(firstContent),
      `First message should indicate permanent failure. Got: "${firstContent}"`
    );
    // Should mention transcription / speech recognition
    assert.ok(
      /transcript|speech|transcri/i.test(firstContent),
      `Message should reference transcription. Got: "${firstContent}"`
    );
  });


  it('calls cleanupSession with guildId and reason=deepgram_failed', async () => {
    const textChannelId = 'text-ch';
    const channel = { send: mock.fn(async () => {}) };
    const channelCache = new Map([[textChannelId, channel]]);

    const session = makeFakeSession({ textChannelId });
    const sm = makeSessionManager(session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor() { super(); coordinator = this; }
    };

    const cleanupMock = mock.fn(async () => makeCleanupResult());

    await handleStart(
      makeInteraction({ channelCache }),
      sm,
      { getTextChannelId: mock.fn(async () => textChannelId) },
      {
        AudioSessionCoordinator: CoordinatorStub,
        cleanupSession: cleanupMock,
        generateAndDeliverMinutes: mock.fn(async () => makeMinutesResult()),
      }
    );

    coordinator.emit('deepgram_failed');
    await flushAsync();

    assert.equal(cleanupMock.mock.callCount(), 1, 'cleanupSession should be called exactly once');
    const args = cleanupMock.mock.calls[0].arguments[0];
    assert.equal(args.guildId, 'guild-1', 'guildId should match the session guild');
    assert.equal(args.reason, 'deepgram_failed', 'reason must be deepgram_failed');
    assert.ok(args.sessionManager, 'sessionManager should be passed through');
  });


  it('calls generateAndDeliverMinutes when transcriptCount > 0', async () => {
    const textChannelId = 'text-ch';
    const channel = { send: mock.fn(async () => {}) };
    const channelCache = new Map([[textChannelId, channel]]);

    const session = makeFakeSession({ textChannelId });
    const sm = makeSessionManager(session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor() { super(); coordinator = this; }
    };

    const minutesMock = mock.fn(async () => makeMinutesResult());

    await handleStart(
      makeInteraction({ channelCache }),
      sm,
      { getTextChannelId: mock.fn(async () => textChannelId) },
      {
        AudioSessionCoordinator: CoordinatorStub,
        cleanupSession: mock.fn(async () => makeCleanupResult({ transcriptCount: 5 })),
        generateAndDeliverMinutes: minutesMock,
      }
    );

    coordinator.emit('deepgram_failed');
    await flushAsync();

    assert.equal(minutesMock.mock.callCount(), 1, 'generateAndDeliverMinutes should be called once');
    const args = minutesMock.mock.calls[0].arguments[0];
    assert.equal(args.reason, 'deepgram_failed', 'reason should propagate to minutes generator');
    assert.equal(args.transcript.length, 5, 'full captured transcript should be passed');
  });


  it('does NOT call generateAndDeliverMinutes when transcriptCount is 0', async () => {
    const textChannelId = 'text-ch';
    const receivedMessages = [];
    const channel = { send: mock.fn(async (msg) => receivedMessages.push(msg)) };
    const channelCache = new Map([[textChannelId, channel]]);

    const session = makeFakeSession({ textChannelId });
    const sm = makeSessionManager(session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor() { super(); coordinator = this; }
    };

    const minutesMock = mock.fn(async () => makeMinutesResult());

    await handleStart(
      makeInteraction({ channelCache }),
      sm,
      { getTextChannelId: mock.fn(async () => textChannelId) },
      {
        AudioSessionCoordinator: CoordinatorStub,
        cleanupSession: mock.fn(async () => makeCleanupResult({ transcriptCount: 0, transcript: [] })),
        generateAndDeliverMinutes: minutesMock,
      }
    );

    coordinator.emit('deepgram_failed');
    await flushAsync();

    assert.equal(minutesMock.mock.callCount(), 0, 'generateAndDeliverMinutes must NOT be called when no transcript');

    // The session-end summary should mention that no minutes will be generated
    const allContent = receivedMessages.map(m => m.content).join('\n');
    assert.ok(
      /no.*transcript|not.*generat|will not/i.test(allContent),
      `Session summary should mention no minutes. Got: "${allContent}"`
    );
  });


  it('skips cleanupSession when session already ended (race condition guard)', async () => {
    const textChannelId = 'text-ch';
    const channel = { send: mock.fn(async () => {}) };
    const channelCache = new Map([[textChannelId, channel]]);

    const session = makeFakeSession({ textChannelId });

    // hasSession returns false — the session was already stopped (e.g. user ran /stop simultaneously)
    const sm = makeSessionManager(session, { hasSessionOverride: false });
    // startSession still returns session so handleStart can proceed to coordinator setup
    sm.startSession = mock.fn(async () => session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor() { super(); coordinator = this; }
    };

    const cleanupMock = mock.fn(async () => makeCleanupResult());

    await handleStart(
      makeInteraction({ channelCache }),
      sm,
      { getTextChannelId: mock.fn(async () => textChannelId) },
      {
        AudioSessionCoordinator: CoordinatorStub,
        cleanupSession: cleanupMock,
        generateAndDeliverMinutes: mock.fn(async () => makeMinutesResult()),
      }
    );

    coordinator.emit('deepgram_failed');
    await flushAsync();

    // Initial failure notification should still arrive
    assert.ok(channel.send.mock.callCount() >= 1, 'Failure notification should still be sent');

    // cleanupSession must be skipped — session is already gone
    assert.equal(
      cleanupMock.mock.callCount(), 0,
      'cleanupSession must not be called when session is already stopped'
    );
  });


  it('sends error recovery message when cleanupSession itself throws', async () => {
    const textChannelId = 'text-ch';
    const receivedMessages = [];
    const channel = { send: mock.fn(async (msg) => receivedMessages.push(msg)) };
    const channelCache = new Map([[textChannelId, channel]]);

    const session = makeFakeSession({ textChannelId });
    const sm = makeSessionManager(session);

    let coordinator = null;
    const CoordinatorStub = class extends StubCoordinator {
      constructor() { super(); coordinator = this; }
    };

    await handleStart(
      makeInteraction({ channelCache }),
      sm,
      { getTextChannelId: mock.fn(async () => textChannelId) },
      {
        AudioSessionCoordinator: CoordinatorStub,
        cleanupSession: mock.fn(async () => { throw new Error('cleanup exploded'); }),
        generateAndDeliverMinutes: mock.fn(async () => makeMinutesResult()),
      }
    );

    coordinator.emit('deepgram_failed');
    await flushAsync();

    // Should have sent at least: (1) initial failure notice + (2) cleanup error notice
    assert.ok(receivedMessages.length >= 2, `Expected ≥2 messages, got ${receivedMessages.length}`);

    const allContent = receivedMessages.map(m => m.content).join('\n');
    assert.ok(
      /stop.*manually|\/stop|error.*stop/i.test(allContent),
      `Should suggest manual /stop after cleanup failure. Got: "${allContent}"`
    );
  });

});
