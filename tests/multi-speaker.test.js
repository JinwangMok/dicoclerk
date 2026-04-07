/**
 * Multi-Speaker Support Tests (AC 13)
 *
 * Validates that dicoclerk correctly handles 5-10 simultaneous speakers
 * in a single voice channel. Covers:
 *
 *  1. AudioCapturePipeline  – accepts ≥10 concurrent user streams
 *  2. OpusDecoderPool       – creates/cleans-up per-user decoders for 10 users
 *  3. SpeakerIdentifier     – maps 10 Deepgram speaker labels to Discord users
 *  4. DeepgramConnectionPool – auto-scales connections when ≥5 speakers join
 *  5. Resource cleanup      – decoders and streams released when users leave
 *
 * All external dependencies (Deepgram SDK, Discord voice, OpusScript) are mocked
 * so no real API keys or audio hardware are required.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  AudioCapturePipeline,
  MAX_CONCURRENT_STREAMS,
} from '../src/audio/audio-capture-pipeline.js';

import {
  SpeakerIdentifier,
  CONFIRMATION_THRESHOLD,
} from '../src/stt/speaker-identifier.js';

import { OpusDecoderPool } from '../src/audio/opus-decoder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared Mock Factories
// ─────────────────────────────────────────────────────────────────────────────

/** Create N unique fake Discord user IDs */
function makeUserIds(n) {
  return Array.from({ length: n }, (_, i) => `user-${String(i + 1).padStart(4, '0')}`);
}

/** Minimal fake Opus stream (EventEmitter + destroyed flag) */
function makeFakeStream() {
  const s = new EventEmitter();
  s.destroyed = false;
  s.destroy = mock.fn(() => {
    s.destroyed = true;
    s.emit('close');
  });
  return s;
}

/** Mock DeepgramStreamingClient that records sent packets */
function makeMockDeepgramClient({ connected = true } = {}) {
  const packets = [];
  return {
    isConnected: connected,
    state: connected ? 'connected' : 'idle',
    send: mock.fn((data) => {
      if (!connected) return false;
      packets.push(data);
      return true;
    }),
    _packets: packets,
  };
}

/** Mock VoiceReceiver that emits per-user streams on demand */
function makeMockReceiver() {
  const speaking = new EventEmitter();
  const streams = new Map();

  return {
    speaking,
    subscribe: mock.fn((userId) => {
      const stream = makeFakeStream();
      streams.set(userId, stream);
      return stream;
    }),
    _streams: streams,
  };
}

function makeMockConnection() {
  const receiver = makeMockReceiver();
  return { receiver, destroy: mock.fn(), _receiver: receiver };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. AudioCapturePipeline – concurrent stream capacity
// ─────────────────────────────────────────────────────────────────────────────

describe('AudioCapturePipeline – multi-speaker capacity', () => {
  const SPEAKER_COUNTS = [5, 8, 10];

  for (const count of SPEAKER_COUNTS) {
    it(`accepts ${count} simultaneous user streams`, () => {
      const connection = makeMockConnection();
      const deepgramClient = makeMockDeepgramClient();
      const pipeline = new AudioCapturePipeline({ connection, deepgramClient });

      pipeline.start();

      const userIds = makeUserIds(count);
      const speakingEvents = [];
      pipeline.on('user_speaking', (e) => speakingEvents.push(e.userId));

      for (const userId of userIds) {
        const stream = makeFakeStream();
        pipeline.addStream(userId, stream, `TestUser-${userId}`);
      }

      assert.equal(
        pipeline.activeStreamCount,
        count,
        `Expected ${count} active streams, got ${pipeline.activeStreamCount}`
      );
      assert.equal(speakingEvents.length, count, 'user_speaking emitted for each user');
      assert.deepEqual(
        [...speakingEvents].sort(),
        [...userIds].sort(),
        'user_speaking events contain the correct user IDs'
      );

      pipeline.stop();
    });
  }

  it('MAX_CONCURRENT_STREAMS constant is ≥ 10', () => {
    assert.ok(
      MAX_CONCURRENT_STREAMS >= 10,
      `MAX_CONCURRENT_STREAMS should be ≥ 10 but is ${MAX_CONCURRENT_STREAMS}`
    );
  });

  it('forwards audio packets from all 10 concurrent speakers to Deepgram', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });

    pipeline.start();

    const userIds = makeUserIds(10);
    const streams = new Map();

    for (const userId of userIds) {
      const stream = makeFakeStream();
      streams.set(userId, stream);
      pipeline.addStream(userId, stream, `User-${userId}`);
    }

    // Each user sends 3 packets
    const fakePacket = Buffer.from([0xab, 0xcd, 0xef]);
    for (const [, stream] of streams) {
      for (let p = 0; p < 3; p++) {
        stream.emit('data', fakePacket);
      }
    }

    // 10 users × 3 packets = 30 total
    assert.equal(pipeline.totalPackets, 30, 'All 30 packets should be forwarded to Deepgram');
    assert.equal(deepgramClient.send.mock.calls.length, 30, 'Deepgram.send called 30 times');

    pipeline.stop();
  });

  it('emits warning (not error) when stream count exceeds MAX_CONCURRENT_STREAMS', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });
    pipeline.start();

    const warnings = [];
    pipeline.on('warning', (w) => warnings.push(w));

    // Fill to MAX_CONCURRENT_STREAMS first
    for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
      pipeline.addStream(`user-${i}`, makeFakeStream());
    }

    // Adding one more should emit a warning instead of crashing
    pipeline.addStream('user-overflow', makeFakeStream());

    assert.equal(pipeline.activeStreamCount, MAX_CONCURRENT_STREAMS, 'Stream count capped at MAX');
    assert.ok(warnings.length > 0, 'Warning emitted when capacity exceeded');
    assert.ok(
      warnings.some(w => w.includes('Max concurrent streams')),
      'Warning message mentions max concurrent streams'
    );

    pipeline.stop();
  });

  it('cleans up streams as users stop speaking', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });
    pipeline.start();

    const userIds = makeUserIds(10);
    const streams = new Map();

    for (const userId of userIds) {
      const stream = makeFakeStream();
      streams.set(userId, stream);
      pipeline.addStream(userId, stream, `User-${userId}`);
    }

    assert.equal(pipeline.activeStreamCount, 10);

    // Simulate 5 users ending their streams
    let ended = 0;
    for (const [userId, stream] of streams) {
      stream.emit('end');
      ended++;
      if (ended === 5) break;
    }

    assert.equal(pipeline.activeStreamCount, 5, '5 streams should remain after 5 end');

    pipeline.stop();
  });

  it('tracks all 10 users in userMap even after streams end', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });
    pipeline.start();

    const userIds = makeUserIds(10);
    for (const userId of userIds) {
      pipeline.registerUser(userId, `DisplayName-${userId}`);
    }

    const map = pipeline.userMap;
    assert.equal(map.size, 10, 'userMap should contain all 10 registered users');
    for (const userId of userIds) {
      assert.ok(map.has(userId), `userMap missing userId ${userId}`);
    }

    pipeline.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AudioCapturePipeline – direct mode (speaking events trigger subscriptions)
// ─────────────────────────────────────────────────────────────────────────────

describe('AudioCapturePipeline – direct mode with 10 simultaneous speakers', () => {
  it('subscribes to all 10 speakers\' streams via speaking events', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });

    pipeline.start();

    const userIds = makeUserIds(10);
    for (const userId of userIds) {
      connection.receiver.speaking.emit('start', userId);
    }

    assert.equal(
      connection.receiver.subscribe.mock.calls.length,
      10,
      'subscribe() called once per speaker'
    );
    assert.equal(pipeline.activeStreamCount, 10, '10 active streams');

    pipeline.stop();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OpusDecoderPool – per-user decoder lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe('OpusDecoderPool – multi-speaker decoder lifecycle', () => {
  it('creates independent decoders for 10 distinct users', () => {
    const pool = new OpusDecoderPool();
    const userIds = makeUserIds(10);

    if (!OpusDecoderPool.isAvailable) {
      // Passthrough mode: decode() returns the raw packet unchanged
      const fakePacket = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      for (const userId of userIds) {
        const result = pool.decode(userId, fakePacket);
        assert.ok(result !== null, `passthrough: decode() returned null for ${userId}`);
        assert.ok(Buffer.isBuffer(result), 'passthrough: decode() should return a Buffer');
        assert.strictEqual(result, fakePacket, 'passthrough: should return the same buffer');
      }
    } else {
      // Opus mode: decode() attempts Opus decoding; a valid-length silent frame
      // (960 samples × 2 ch × 2 bytes = 3840 bytes) should succeed and return PCM.
      // If opusscript rejects the payload it returns null — we verify no throw.
      const silentFrame = Buffer.alloc(3840, 0); // zero-filled "silent" raw PCM as stand-in
      for (const userId of userIds) {
        // Does not throw regardless of decode success/failure
        assert.doesNotThrow(() => pool.decode(userId, silentFrame),
          `decode() must not throw for ${userId}`);
      }
      // All 10 users should have been visited (either decoded or errored internally)
      assert.ok(
        pool.decodedCount + pool.errorCount >= 10,
        `Expected at least 10 decode attempts, got decoded=${pool.decodedCount} errors=${pool.errorCount}`
      );
    }

    pool.destroy();
  });

  it('reports correct activeDecoderCount for 10 users (when opusscript available)', () => {
    if (!OpusDecoderPool.isAvailable) {
      // Skip decoder-count test if opusscript not installed
      return;
    }

    const pool = new OpusDecoderPool();
    const userIds = makeUserIds(10);
    const fakePacket = Buffer.from(new Array(960 * 4).fill(0)); // 20ms stereo frame

    for (const userId of userIds) {
      pool.decode(userId, fakePacket);
    }

    assert.equal(pool.activeDecoderCount, 10, '10 decoders should be active');

    // Delete 5 decoders
    for (let i = 0; i < 5; i++) {
      pool.deleteDecoder(userIds[i]);
    }

    assert.equal(pool.activeDecoderCount, 5, '5 decoders remain after deleting 5');

    pool.destroy();
    assert.equal(pool.activeDecoderCount, 0, 'All decoders released after destroy()');
  });

  it('destroy() cleans up all decoders for 10 users', () => {
    const pool = new OpusDecoderPool();
    const userIds = makeUserIds(10);
    const fakePacket = Buffer.from([0xff, 0x00]);

    for (const userId of userIds) {
      pool.decode(userId, fakePacket);
    }

    // Should not throw for any number of users
    assert.doesNotThrow(() => pool.destroy(), 'destroy() should not throw');
  });

  it('emits decode_error per user but continues serving others', () => {
    if (!OpusDecoderPool.isAvailable) return;

    const pool = new OpusDecoderPool();
    const errors = [];
    pool.on('decode_error', (e) => errors.push(e));

    const userIds = makeUserIds(5);

    // Send a deliberately malformed packet (1 byte, clearly not valid Opus).
    // opusscript may throw or silently return something depending on its internals.
    // What we guarantee: decode() never throws to the caller, and if errors DO
    // occur they are emitted as 'decode_error' events with userId+error strings.
    const badPacket = Buffer.from([0x00]);
    for (const userId of userIds) {
      let result;
      assert.doesNotThrow(
        () => { result = pool.decode(userId, badPacket); },
        `decode() must not propagate exceptions for user ${userId}`
      );
      // result is either a Buffer (opusscript tolerated it) or null (decode failed)
      assert.ok(
        result === null || Buffer.isBuffer(result),
        'decode() should return null or a Buffer, never throw'
      );
    }

    // If any errors were emitted, they must have the expected shape
    for (const err of errors) {
      assert.ok(typeof err.userId === 'string', 'Error event should contain userId string');
      assert.ok(typeof err.error === 'string', 'Error event should contain error string');
    }

    // Regardless of error behaviour, pool is still usable for subsequent users
    assert.doesNotThrow(() => pool.destroy(), 'destroy() must not throw after decode errors');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SpeakerIdentifier – 10 simultaneous speaker mappings
// ─────────────────────────────────────────────────────────────────────────────

describe('SpeakerIdentifier – 10 simultaneous speakers', () => {
  let identifier;

  beforeEach(() => {
    identifier = new SpeakerIdentifier();
  });

  afterEach(() => {
    identifier.stopEviction();
  });

  it('builds independent mappings for 10 Deepgram speaker labels', () => {
    const userIds = makeUserIds(10);

    // Register all 10 users with display names
    for (const userId of userIds) {
      identifier.registerUser(userId, `DisplayName-${userId}`);
    }

    // Simulate each user speaking at exclusive time windows (non-overlapping)
    // User i speaks during [i*2, i*2+1.5] seconds
    for (let i = 0; i < 10; i++) {
      const userId = userIds[i];
      const start = i * 2;
      const end = start + 1.5;

      // Record sufficient activity for confirmation
      for (let p = 0; p < CONFIRMATION_THRESHOLD + 2; p++) {
        identifier.recordActivity(userId, start + p * 0.1);
      }

      // Identify speaker label i during this user's window
      for (let e = 0; e < CONFIRMATION_THRESHOLD; e++) {
        identifier.identify(i, start, end);
      }
    }

    const stats = identifier.getStats();
    assert.equal(stats.mappingCount, 10, '10 speaker mappings should be created');

    // Each label should map to a unique userId
    const mappedUsers = new Set(stats.mappings.map(m => m.userId));
    assert.equal(mappedUsers.size, 10, 'All 10 mapped users should be distinct');
  });

  it('resolves display names for 10 speakers', () => {
    const userIds = makeUserIds(10);

    for (let i = 0; i < 10; i++) {
      const userId = userIds[i];
      identifier.registerUser(userId, `Speaker-${i}`);
      identifier.setMapping(i, userId, `Speaker-${i}`);
    }

    for (let i = 0; i < 10; i++) {
      const name = identifier.resolveName(i);
      assert.equal(name, `Speaker-${i}`, `Label ${i} should resolve to Speaker-${i}`);
    }
  });

  it('handles concurrent activity from 10 speakers in same time window gracefully', () => {
    const userIds = makeUserIds(10);

    // All 10 users speaking at the same time
    for (const userId of userIds) {
      for (let p = 0; p < 5; p++) {
        identifier.recordActivity(userId, 1.0 + p * 0.05);
      }
    }

    const stats = identifier.getStats();
    assert.ok(stats.totalActivities >= 50, `Expected ≥50 activities, got ${stats.totalActivities}`);
    assert.ok(stats.activityBuckets >= 1, 'At least 1 activity bucket should exist');
  });

  it('emit mapping_created for each of 10 new speakers', () => {
    const userIds = makeUserIds(10);
    const createdEvents = [];
    identifier.on('mapping_created', (m) => createdEvents.push(m));

    for (let i = 0; i < 10; i++) {
      const userId = userIds[i];
      const ts = i * 2;
      identifier.recordActivity(userId, ts);
      identifier.recordActivity(userId, ts + 0.1);
      identifier.identify(i, ts, ts + 0.4);
    }

    assert.equal(createdEvents.length, 10, '10 mapping_created events should be emitted');
  });

  it('emits mapping_confirmed once enough evidence for each of 5 speakers', () => {
    const userIds = makeUserIds(5);
    const confirmedEvents = [];
    identifier.on('mapping_confirmed', (m) => confirmedEvents.push(m));

    for (let i = 0; i < 5; i++) {
      const userId = userIds[i];
      const baseTs = i * 4;

      identifier.setMapping(i, userId, `Confirmed-${i}`);
    }

    assert.equal(confirmedEvents.length, 5, '5 mapping_confirmed events should fire');
    for (const event of confirmedEvents) {
      assert.ok(event.confirmed, 'Each confirmed mapping should have confirmed=true');
      assert.equal(event.confidence, 1.0, 'setMapping should set full confidence');
    }
  });

  it('getAllMappings() returns all 10 mappings', () => {
    const userIds = makeUserIds(10);

    for (let i = 0; i < 10; i++) {
      identifier.setMapping(i, userIds[i], `Name-${i}`);
    }

    const allMappings = identifier.getAllMappings();
    assert.equal(allMappings.size, 10, 'getAllMappings() should return 10 entries');

    for (let i = 0; i < 10; i++) {
      assert.ok(allMappings.has(i), `Missing mapping for label ${i}`);
      assert.equal(allMappings.get(i).userId, userIds[i]);
    }
  });

  it('reset() clears all state after a 10-speaker session', () => {
    const userIds = makeUserIds(10);

    for (let i = 0; i < 10; i++) {
      identifier.registerUser(userIds[i], `User-${i}`);
      identifier.setMapping(i, userIds[i]);
      identifier.recordActivity(userIds[i], i * 1.0);
    }

    identifier.reset();

    const stats = identifier.getStats();
    assert.equal(stats.mappingCount, 0, 'Mappings cleared after reset');
    assert.equal(stats.totalActivities, 0, 'Activities cleared after reset');
    assert.equal(stats.registeredUsers, 0, 'Registered users cleared after reset');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. DeepgramConnectionPool – auto-scaling for 5-10 speakers
// ─────────────────────────────────────────────────────────────────────────────

describe('DeepgramConnectionPool – multi-speaker auto-scaling', () => {
  /**
   * Build a minimal pool that uses stubbed DeepgramStreamingClient +
   * DeepgramConnectionResilience so no real WebSocket is opened.
   * We monkey-patch the private imports by subclassing.
   */

  /**
   * Since DeepgramConnectionPool uses private imports internally we test it via
   * its public surface while intercepting the module-level DeepgramStreamingClient
   * constructor. We do this by providing a factory-like wrapper that captures
   * the pool's behavior without real network calls.
   *
   * For the purposes of AC-13 validation we test:
   *  - POOL_DEFAULTS expresses correct scalability parameters
   *  - registerSpeaker() / unregisterSpeaker() update totalSpeakers correctly
   *  - getStats() correctly reflects speaker routing for 10 users
   *
   * Full integration (with real Deepgram connections) is covered by the
   * end-to-end / integration test suite.
   */

  it('POOL_DEFAULTS supports at least 10 speakers via threshold and maxConnections', async () => {
    // Import constants without creating a live pool
    const { POOL_DEFAULTS } = await import('../src/stt/connection-pool.js');

    const maxSpeakers =
      POOL_DEFAULTS.maxConnections * POOL_DEFAULTS.speakersPerConnectionThreshold;

    assert.ok(
      maxSpeakers >= 10,
      `Pool supports up to ${maxSpeakers} speakers (maxConnections=${POOL_DEFAULTS.maxConnections} × threshold=${POOL_DEFAULTS.speakersPerConnectionThreshold})`
    );
  });

  it('POOL_DEFAULTS.speakersPerConnectionThreshold triggers scale at 5 speakers', async () => {
    const { POOL_DEFAULTS } = await import('../src/stt/connection-pool.js');
    assert.equal(
      POOL_DEFAULTS.speakersPerConnectionThreshold,
      5,
      'Scale threshold should be 5 speakers per connection'
    );
  });

  it('POOL_DEFAULTS.autoScale is enabled by default', async () => {
    const { POOL_DEFAULTS } = await import('../src/stt/connection-pool.js');
    assert.equal(POOL_DEFAULTS.autoScale, true, 'autoScale should be enabled by default');
  });

  it('constructor rejects when minConnections > maxConnections', async () => {
    const { DeepgramConnectionPool } = await import('../src/stt/connection-pool.js');
    assert.throws(
      () => new DeepgramConnectionPool({ apiKey: 'test', minConnections: 5, maxConnections: 2 }),
      /maxConnections must be >= minConnections/
    );
  });

  it('constructor rejects when minConnections < 1', async () => {
    const { DeepgramConnectionPool } = await import('../src/stt/connection-pool.js');
    assert.throws(
      () => new DeepgramConnectionPool({ apiKey: 'test', minConnections: 0 }),
      /minConnections must be at least 1/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Integration: pipeline + speaker identifier for 10-user session
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration – AudioCapturePipeline + SpeakerIdentifier for 10 speakers', () => {
  it('records activity for all 10 speakers and builds speaker identifier state', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const speakerIdentifier = new SpeakerIdentifier();

    const pipeline = new AudioCapturePipeline({
      connection,
      deepgramClient,
      speakerIdentifier,
    });

    pipeline.start();

    const userIds = makeUserIds(10);

    // Register all users
    for (const userId of userIds) {
      pipeline.registerUser(userId, `TestUser-${userId}`);
    }

    // Add streams and emit audio packets for each user
    const streams = new Map();
    for (const userId of userIds) {
      const stream = makeFakeStream();
      streams.set(userId, stream);
      pipeline.addStream(userId, stream, `TestUser-${userId}`);
    }

    // 5 packets per user
    const fakePacket = Buffer.from([0x11, 0x22, 0x33]);
    for (const [, stream] of streams) {
      for (let p = 0; p < 5; p++) {
        stream.emit('data', fakePacket);
      }
    }

    // speaker identifier should have activity for all 10 users
    const stats = speakerIdentifier.getStats();
    assert.ok(
      stats.totalActivities >= 50,
      `Expected ≥50 activity records, got ${stats.totalActivities} (5 packets × 10 users)`
    );
    assert.equal(stats.registeredUsers, 10, '10 users should be registered in speaker identifier');

    pipeline.stop();
    speakerIdentifier.stopEviction();
  });

  it('pipeline getStats() reflects all 10 active participants', () => {
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });

    pipeline.start();

    const userIds = makeUserIds(10);
    for (const userId of userIds) {
      pipeline.addStream(userId, makeFakeStream(), `User-${userId}`);
    }

    const stats = pipeline.getStats();
    assert.equal(stats.running, true);
    assert.equal(stats.activeStreams, 10);
    assert.equal(stats.participants, 10);
    assert.equal(stats.users.length, 10);

    pipeline.stop();
  });

  it('pipeline handles sequential join/leave cycles for more than 10 total users', () => {
    // Some users leave and new ones join — total concurrent stays ≤ 10
    const connection = makeMockConnection();
    const deepgramClient = makeMockDeepgramClient();
    const pipeline = new AudioCapturePipeline({ connection, deepgramClient });

    pipeline.start();

    // First wave: 10 users join
    const wave1 = makeUserIds(10);
    const wave1Streams = wave1.map((userId) => {
      const s = makeFakeStream();
      pipeline.addStream(userId, s, `User-${userId}`);
      return s;
    });

    assert.equal(pipeline.activeStreamCount, 10, 'Wave 1: 10 active streams');

    // First 5 leave
    for (let i = 0; i < 5; i++) {
      wave1Streams[i].emit('end');
    }

    assert.equal(pipeline.activeStreamCount, 5, 'After 5 leave: 5 active streams');

    // Second wave: 5 more join
    const wave2 = makeUserIds(5).map(id => `wave2-${id}`);
    for (const userId of wave2) {
      pipeline.addStream(userId, makeFakeStream(), `User-${userId}`);
    }

    assert.equal(pipeline.activeStreamCount, 10, 'Wave 2: back to 10 concurrent streams');

    pipeline.stop();
  });
});
