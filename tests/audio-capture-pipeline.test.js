/**
 * Tests for AudioCapturePipeline
 *
 * Uses Node.js built-in test runner with mocked Discord voice objects.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AudioCapturePipeline, SILENCE_TIMEOUT_MS, MAX_CONCURRENT_STREAMS } from '../src/audio/audio-capture-pipeline.js';

// --- Mock Factories ---

function createMockSpeakingMap() {
  const emitter = new EventEmitter();
  emitter.users = new Map();
  return emitter;
}

function createMockOpusStream() {
  const stream = new EventEmitter();
  stream.destroyed = false;
  stream.destroy = mock.fn(() => {
    stream.destroyed = true;
    stream.emit('close');
  });
  stream.read = mock.fn();
  stream.pipe = mock.fn();
  return stream;
}

function createMockReceiver() {
  const speaking = createMockSpeakingMap();
  const streams = new Map();

  return {
    speaking,
    subscriptions: streams,
    subscribe: mock.fn((userId, options) => {
      const stream = createMockOpusStream();
      streams.set(userId, stream);
      return stream;
    }),
  };
}

function createMockConnection() {
  const receiver = createMockReceiver();
  return {
    receiver,
    destroy: mock.fn(),
  };
}

function createMockDeepgramClient(connected = true) {
  return {
    isConnected: connected,
    send: mock.fn(() => true),
    state: connected ? 'connected' : 'idle',
  };
}

// --- Tests ---

describe('AudioCapturePipeline', () => {
  let connection;
  let deepgramClient;
  let pipeline;

  beforeEach(() => {
    connection = createMockConnection();
    deepgramClient = createMockDeepgramClient(true);
    pipeline = new AudioCapturePipeline({
      connection,
      deepgramClient,
      resolveUsername: async (id) => `TestUser-${id}`,
    });
  });

  afterEach(() => {
    if (pipeline.isRunning) {
      pipeline.stop();
    }
  });

  describe('constructor', () => {
    it('should throw if no deepgramClient is provided', () => {
      assert.throws(
        () => new AudioCapturePipeline({ connection }),
        { message: 'DeepgramStreamingClient is required' }
      );
    });

    it('should initialize in stopped state', () => {
      assert.equal(pipeline.isRunning, false);
      assert.equal(pipeline.activeStreamCount, 0);
      assert.equal(pipeline.totalPackets, 0);
    });

    it('should work without connection (consumer mode)', () => {
      const p = new AudioCapturePipeline({ deepgramClient });
      assert.equal(p.isRunning, false);
    });
  });

  describe('start()', () => {
    it('should set running state to true', () => {
      pipeline.start();
      assert.equal(pipeline.isRunning, true);
    });

    it('should emit warning if called while already running', () => {
      const warnings = [];
      pipeline.on('warning', (msg) => warnings.push(msg));

      pipeline.start();
      pipeline.start();

      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /already running/);
    });

    it('should register speaking event listeners in direct mode', () => {
      pipeline.start();

      assert.ok(connection.receiver.speaking.listenerCount('start') > 0);
      assert.ok(connection.receiver.speaking.listenerCount('end') > 0);
    });

    it('should not fail in consumer mode (no connection)', () => {
      const p = new AudioCapturePipeline({ deepgramClient });
      p.start();
      assert.equal(p.isRunning, true);
      p.stop();
    });
  });

  describe('stop()', () => {
    it('should set running state to false', () => {
      pipeline.start();
      pipeline.stop();
      assert.equal(pipeline.isRunning, false);
    });

    it('should be safe to call when not running', () => {
      pipeline.stop();
      assert.equal(pipeline.isRunning, false);
    });

    it('should remove speaking event listeners', () => {
      pipeline.start();
      pipeline.stop();

      assert.equal(connection.receiver.speaking.listenerCount('start'), 0);
      assert.equal(connection.receiver.speaking.listenerCount('end'), 0);
    });

    it('should destroy all active streams on stop', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');
      assert.equal(pipeline.activeStreamCount, 1);

      pipeline.stop();
      assert.equal(pipeline.activeStreamCount, 0);
    });
  });

  describe('direct mode — audio forwarding', () => {
    it('should subscribe to user audio when speaking starts', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      assert.equal(connection.receiver.subscribe.mock.calls.length, 1);
      const call = connection.receiver.subscribe.mock.calls[0];
      assert.equal(call.arguments[0], 'user-1');
      assert.equal(call.arguments[1].end.behavior, 1); // AfterSilence = 1
    });

    it('should forward Opus packets to Deepgram', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      assert.ok(stream);

      const packet = Buffer.from([0x80, 0x78, 0x00, 0x01]);
      stream.emit('data', packet);

      assert.equal(deepgramClient.send.mock.calls.length, 1);
      assert.deepEqual(deepgramClient.send.mock.calls[0].arguments[0], packet);
    });

    it('should increment packet count on successful forward', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));
      stream.emit('data', Buffer.from([0x02]));
      stream.emit('data', Buffer.from([0x03]));

      assert.equal(pipeline.totalPackets, 3);
    });

    it('should emit audio_forwarded event', () => {
      const events = [];
      pipeline.on('audio_forwarded', (e) => events.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01, 0x02]));

      assert.equal(events.length, 1);
      assert.equal(events[0].userId, 'user-1');
      assert.equal(events[0].byteLength, 2);
    });

    it('should drop audio when Deepgram is not connected', () => {
      deepgramClient.isConnected = false;
      const dropped = [];
      pipeline.on('audio_dropped', (e) => dropped.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));

      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].reason, 'deepgram_not_connected');
      assert.equal(deepgramClient.send.mock.calls.length, 0);
    });

    it('should emit audio_dropped when send fails', () => {
      deepgramClient.send = mock.fn(() => false);
      const dropped = [];
      pipeline.on('audio_dropped', (e) => dropped.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));

      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].reason, 'send_failed');
    });

    it('should not forward audio after pipeline is stopped', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));
      assert.equal(pipeline.totalPackets, 1);

      pipeline.stop();

      stream.emit('data', Buffer.from([0x02]));
      assert.equal(pipeline.totalPackets, 1);
    });
  });

  describe('consumer mode — addStream()', () => {
    let consumerPipeline;

    beforeEach(() => {
      consumerPipeline = new AudioCapturePipeline({
        deepgramClient,
        resolveUsername: async (id) => `Resolved-${id}`,
      });
    });

    afterEach(() => {
      if (consumerPipeline.isRunning) consumerPipeline.stop();
    });

    it('should accept and forward audio from added streams', () => {
      consumerPipeline.start();

      const stream = createMockOpusStream();
      consumerPipeline.addStream('user-1', stream, 'Alice');

      assert.equal(consumerPipeline.activeStreamCount, 1);

      const packet = Buffer.from([0x01, 0x02, 0x03]);
      stream.emit('data', packet);

      assert.equal(deepgramClient.send.mock.calls.length, 1);
      assert.equal(consumerPipeline.totalPackets, 1);
    });

    it('should emit user_speaking on addStream', () => {
      const events = [];
      consumerPipeline.on('user_speaking', (e) => events.push(e));

      consumerPipeline.start();
      consumerPipeline.addStream('user-1', createMockOpusStream(), 'Alice');

      assert.equal(events.length, 1);
      assert.equal(events[0].userId, 'user-1');
      assert.equal(events[0].username, 'Alice');
    });

    it('should clean up stream on end', () => {
      consumerPipeline.start();
      const stream = createMockOpusStream();
      consumerPipeline.addStream('user-1', stream, 'Alice');

      assert.equal(consumerPipeline.activeStreamCount, 1);
      stream.emit('end');
      assert.equal(consumerPipeline.activeStreamCount, 0);
    });

    it('should ignore addStream when not running', () => {
      const warnings = [];
      consumerPipeline.on('warning', (msg) => warnings.push(msg));

      consumerPipeline.addStream('user-1', createMockOpusStream());

      assert.equal(consumerPipeline.activeStreamCount, 0);
      assert.equal(warnings.length, 1);
    });

    it('should ignore duplicate addStream for same user', () => {
      consumerPipeline.start();
      consumerPipeline.addStream('user-1', createMockOpusStream(), 'Alice');
      consumerPipeline.addStream('user-1', createMockOpusStream(), 'Alice');

      assert.equal(consumerPipeline.activeStreamCount, 1);
    });

    it('should respect MAX_CONCURRENT_STREAMS', () => {
      const warnings = [];
      consumerPipeline.on('warning', (msg) => warnings.push(msg));

      consumerPipeline.start();
      for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
        consumerPipeline.addStream(`user-${i}`, createMockOpusStream(), `User${i}`);
      }
      assert.equal(consumerPipeline.activeStreamCount, MAX_CONCURRENT_STREAMS);

      consumerPipeline.addStream('overflow', createMockOpusStream(), 'Overflow');
      assert.equal(consumerPipeline.activeStreamCount, MAX_CONCURRENT_STREAMS);
      assert.equal(warnings.length, 1);
    });
  });

  describe('user tracking', () => {
    it('should emit user_speaking when a user starts', () => {
      const events = [];
      pipeline.on('user_speaking', (e) => events.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      assert.equal(events.length, 1);
      assert.equal(events[0].userId, 'user-1');
      assert.ok(events[0].username);
    });

    it('should emit user_speaking with registered name', () => {
      pipeline.registerUser('user-1', 'Alice');

      const events = [];
      pipeline.on('user_speaking', (e) => events.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      assert.equal(events.length, 1);
      assert.equal(events[0].username, 'Alice');
    });

    it('should emit user_silent when a user stops speaking', () => {
      const events = [];
      pipeline.on('user_silent', (e) => events.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('end', 'user-1');

      assert.equal(events.length, 1);
      assert.equal(events[0].userId, 'user-1');
    });

    it('should not create duplicate streams for the same user', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('start', 'user-1');

      assert.equal(connection.receiver.subscribe.mock.calls.length, 1);
    });

    it('should handle multiple concurrent users', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('start', 'user-2');
      connection.receiver.speaking.emit('start', 'user-3');

      assert.equal(connection.receiver.subscribe.mock.calls.length, 3);
      assert.equal(pipeline.activeStreamCount, 3);
    });

    it('should clean up stream on end event', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');
      assert.equal(pipeline.activeStreamCount, 1);

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('end');

      assert.equal(pipeline.activeStreamCount, 0);
    });

    it('should clean up stream on error', () => {
      const errors = [];
      pipeline.on('error', (e) => errors.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('error', new Error('test error'));

      assert.equal(pipeline.activeStreamCount, 0);
      assert.equal(errors.length, 1);
    });

    it('should allow re-subscription after stream ends', () => {
      pipeline.start();

      connection.receiver.speaking.emit('start', 'user-1');
      assert.equal(connection.receiver.subscribe.mock.calls.length, 1);

      const stream1 = connection.receiver.subscriptions.get('user-1');
      stream1.emit('end');
      assert.equal(pipeline.activeStreamCount, 0);

      connection.receiver.speaking.emit('start', 'user-1');
      assert.equal(connection.receiver.subscribe.mock.calls.length, 2);
      assert.equal(pipeline.activeStreamCount, 1);
    });

    it('should track user map persistently', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('start', 'user-2');

      const userMap = pipeline.userMap;
      assert.equal(userMap.size, 2);
      assert.ok(userMap.has('user-1'));
      assert.ok(userMap.has('user-2'));
    });

    it('should use registerUser for pre-known users', () => {
      pipeline.registerUser('user-1', 'Alice');

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const userMap = pipeline.userMap;
      assert.equal(userMap.get('user-1'), 'Alice');
    });
  });

  describe('concurrency limits', () => {
    it('should support at least 10 concurrent users (5-10 participant requirement)', () => {
      pipeline.start();

      const forwardedEvents = [];
      pipeline.on('audio_forwarded', (e) => forwardedEvents.push(e));

      // Simulate 10 concurrent users speaking
      for (let i = 0; i < 10; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }

      assert.equal(pipeline.activeStreamCount, 10);
      assert.equal(connection.receiver.subscribe.mock.calls.length, 10);

      // Each user sends audio — all 10 should forward successfully
      for (let i = 0; i < 10; i++) {
        const stream = connection.receiver.subscriptions.get(`user-${i}`);
        assert.ok(stream, `Stream for user-${i} should exist`);
        stream.emit('data', Buffer.from([0x80, 0x78, i]));
      }

      assert.equal(forwardedEvents.length, 10);
      assert.equal(pipeline.totalPackets, 10);

      // Verify each user's packet was individually forwarded
      const userIds = forwardedEvents.map(e => e.userId);
      for (let i = 0; i < 10; i++) {
        assert.ok(userIds.includes(`user-${i}`), `user-${i} should have forwarded audio`);
      }
    });

    it('should track all 10 concurrent users in userMap', () => {
      pipeline.start();

      for (let i = 0; i < 10; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }

      const userMap = pipeline.userMap;
      assert.equal(userMap.size, 10);
      for (let i = 0; i < 10; i++) {
        assert.ok(userMap.has(`user-${i}`));
      }
    });

    it('should handle interleaved speaking from 10 users', () => {
      pipeline.start();

      // All 10 users start speaking
      for (let i = 0; i < 10; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }

      // Users send audio in interleaved order
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 10; i++) {
          const stream = connection.receiver.subscriptions.get(`user-${i}`);
          stream.emit('data', Buffer.from([round, i]));
        }
      }

      // 10 users * 5 rounds = 50 packets
      assert.equal(pipeline.totalPackets, 50);
      assert.equal(deepgramClient.send.mock.calls.length, 50);
    });

    it('should handle users leaving and new ones joining up to 10', () => {
      pipeline.start();

      // 5 users start
      for (let i = 0; i < 5; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }
      assert.equal(pipeline.activeStreamCount, 5);

      // 3 users stop (stream ends)
      for (let i = 0; i < 3; i++) {
        const stream = connection.receiver.subscriptions.get(`user-${i}`);
        stream.emit('end');
      }
      assert.equal(pipeline.activeStreamCount, 2);

      // 8 new users join (total active = 2 remaining + 8 new = 10)
      for (let i = 10; i < 18; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }
      assert.equal(pipeline.activeStreamCount, 10);

      // All 10 active users can forward audio
      const allActive = [...connection.receiver.subscriptions.entries()]
        .filter(([id]) => {
          // Only count active streams: user-3, user-4, and user-10 through user-17
          return id === 'user-3' || id === 'user-4' ||
                 (parseInt(id.split('-')[1]) >= 10 && parseInt(id.split('-')[1]) < 18);
        });

      for (const [, stream] of allActive) {
        stream.emit('data', Buffer.from([0x01]));
      }
      assert.equal(pipeline.totalPackets, 10);
    });

    it('should reject streams beyond MAX_CONCURRENT_STREAMS', () => {
      const warnings = [];
      pipeline.on('warning', (msg) => warnings.push(msg));

      pipeline.start();

      for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }
      assert.equal(pipeline.activeStreamCount, MAX_CONCURRENT_STREAMS);

      connection.receiver.speaking.emit('start', 'user-overflow');
      assert.equal(pipeline.activeStreamCount, MAX_CONCURRENT_STREAMS);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Max concurrent streams/);
    });
  });

  describe('getStats()', () => {
    it('should return pipeline statistics', () => {
      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));
      stream.emit('data', Buffer.from([0x02]));

      const stats = pipeline.getStats();
      assert.equal(stats.running, true);
      assert.equal(stats.activeStreams, 1);
      assert.equal(stats.totalPackets, 2);
      assert.equal(stats.participants, 1);
      assert.equal(stats.users.length, 1);
      assert.equal(stats.users[0].userId, 'user-1');
      assert.equal(stats.users[0].packetCount, 2);
    });

    it('should reflect stopped state', () => {
      const stats = pipeline.getStats();
      assert.equal(stats.running, false);
      assert.equal(stats.activeStreams, 0);
    });
  });

  describe('exported constants', () => {
    it('should export SILENCE_TIMEOUT_MS', () => {
      assert.equal(typeof SILENCE_TIMEOUT_MS, 'number');
      assert.ok(SILENCE_TIMEOUT_MS > 0);
    });

    it('should export MAX_CONCURRENT_STREAMS', () => {
      assert.equal(typeof MAX_CONCURRENT_STREAMS, 'number');
      assert.ok(MAX_CONCURRENT_STREAMS >= 10);
    });
  });
});
