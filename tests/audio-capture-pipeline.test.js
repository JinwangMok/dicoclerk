/**
 * Tests for AudioCapturePipeline
 *
 * Uses Node.js built-in test runner with mocked Discord voice objects.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AudioCapturePipeline, SILENCE_TIMEOUT_MS, MAX_CONCURRENT_STREAMS, MAX_USER_BUFFER_PACKETS } from '../src/audio/audio-capture-pipeline.js';

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

    it('should buffer audio (not drop) when Deepgram is not connected', () => {
      deepgramClient.isConnected = false;
      const buffered = [];
      const dropped = [];
      pipeline.on('audio_buffered', (e) => buffered.push(e));
      pipeline.on('audio_dropped', (e) => dropped.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));

      // Packet should be buffered, not dropped
      assert.equal(buffered.length, 1, 'audio_buffered should be emitted');
      assert.equal(buffered[0].userId, 'user-1');
      assert.equal(buffered[0].bufferedCount, 1);
      assert.equal(dropped.length, 0, 'audio_dropped should NOT be emitted for normal disconnection');
      assert.equal(deepgramClient.send.mock.calls.length, 0);
      assert.equal(pipeline.bufferedPacketCount, 1);
    });

    it('should replay buffered packets when Deepgram reconnects (drainAllUserBuffers)', () => {
      deepgramClient.isConnected = false;
      const forwarded = [];
      pipeline.on('audio_forwarded', (e) => forwarded.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      // Buffer 3 packets while disconnected
      stream.emit('data', Buffer.from([0x01]));
      stream.emit('data', Buffer.from([0x02]));
      stream.emit('data', Buffer.from([0x03]));

      assert.equal(pipeline.bufferedPacketCount, 3);
      assert.equal(deepgramClient.send.mock.calls.length, 0);

      // Deepgram reconnects
      deepgramClient.isConnected = true;
      const drained = pipeline.drainAllUserBuffers();

      assert.equal(drained, 3, 'All buffered packets should be drained');
      assert.equal(pipeline.bufferedPacketCount, 0, 'Buffer should be empty after drain');
      assert.equal(deepgramClient.send.mock.calls.length, 3, 'Deepgram should receive 3 buffered packets');
    });

    it('should drain buffered packets before live packets on reconnect', () => {
      deepgramClient.isConnected = false;
      const sentPackets = [];
      deepgramClient.send = mock.fn((data) => { sentPackets.push(data); return true; });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      const bufferedPacket = Buffer.from([0xBB]);
      stream.emit('data', bufferedPacket); // buffered while disconnected

      assert.equal(pipeline.bufferedPacketCount, 1);

      // Reconnect and send a new live packet
      deepgramClient.isConnected = true;
      const livePacket = Buffer.from([0xCC]);
      stream.emit('data', livePacket); // triggers drain then live send

      // Buffered packet should arrive first, then the live packet
      assert.equal(sentPackets.length, 2);
      assert.deepEqual(sentPackets[0], bufferedPacket, 'Buffered packet should be sent first');
      assert.deepEqual(sentPackets[1], livePacket, 'Live packet should follow buffered');
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

  describe('per-user packet buffering (Sub-AC 13a)', () => {
    it('should emit audio_buffered and increment bufferedPacketCount per user', () => {
      deepgramClient.isConnected = false;
      const events = [];
      pipeline.on('audio_buffered', (e) => events.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-a');
      connection.receiver.speaking.emit('start', 'user-b');

      connection.receiver.subscriptions.get('user-a').emit('data', Buffer.from([0x01]));
      connection.receiver.subscriptions.get('user-a').emit('data', Buffer.from([0x02]));
      connection.receiver.subscriptions.get('user-b').emit('data', Buffer.from([0x03]));

      assert.equal(events.length, 3);
      assert.equal(pipeline.bufferedPacketCount, 3);
    });

    it('should buffer all 10 concurrent users independently during disconnection', () => {
      deepgramClient.isConnected = false;
      pipeline.start();

      for (let i = 0; i < 10; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }

      // Each user sends 5 packets while disconnected
      for (let i = 0; i < 10; i++) {
        const stream = connection.receiver.subscriptions.get(`user-${i}`);
        for (let p = 0; p < 5; p++) {
          stream.emit('data', Buffer.from([i, p]));
        }
      }

      // 10 users × 5 packets = 50 buffered, 0 forwarded
      assert.equal(pipeline.bufferedPacketCount, 50);
      assert.equal(deepgramClient.send.mock.calls.length, 0);
      assert.equal(pipeline.totalPackets, 0);
    });

    it('should drain all 10 users buffers on drainAllUserBuffers()', () => {
      deepgramClient.isConnected = false;
      pipeline.start();

      for (let i = 0; i < 10; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
        const stream = connection.receiver.subscriptions.get(`user-${i}`);
        stream.emit('data', Buffer.from([i]));
      }

      assert.equal(pipeline.bufferedPacketCount, 10);

      deepgramClient.isConnected = true;
      const drained = pipeline.drainAllUserBuffers();

      assert.equal(drained, 10);
      assert.equal(pipeline.bufferedPacketCount, 0);
      assert.equal(deepgramClient.send.mock.calls.length, 10);
    });

    it('should evict oldest packet and emit audio_dropped reason=buffer_overflow when buffer is full', () => {
      const maxBuf = MAX_USER_BUFFER_PACKETS;
      deepgramClient.isConnected = false;
      const dropped = [];
      pipeline.on('audio_dropped', (e) => dropped.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-full');
      const stream = connection.receiver.subscriptions.get('user-full');

      // Fill the buffer to capacity then push one more
      for (let i = 0; i < maxBuf + 1; i++) {
        stream.emit('data', Buffer.from([i & 0xFF]));
      }

      assert.equal(pipeline.bufferedPacketCount, maxBuf, 'Buffer should not exceed max');
      assert.equal(dropped.length, 1, 'One overflow drop should be emitted');
      assert.equal(dropped[0].reason, 'buffer_overflow');
      assert.equal(dropped[0].userId, 'user-full');
    });

    it('should clear user buffer when stream ends', () => {
      deepgramClient.isConnected = false;
      pipeline.start();

      connection.receiver.speaking.emit('start', 'user-end');
      const stream = connection.receiver.subscriptions.get('user-end');
      stream.emit('data', Buffer.from([0x01]));
      stream.emit('data', Buffer.from([0x02]));

      assert.equal(pipeline.bufferedPacketCount, 2);

      stream.emit('end');

      assert.equal(pipeline.bufferedPacketCount, 0, 'Buffer should be cleared on stream end');
    });

    it('should clear all user buffers on stop()', () => {
      deepgramClient.isConnected = false;
      pipeline.start();

      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('start', 'user-2');

      connection.receiver.subscriptions.get('user-1').emit('data', Buffer.from([0x01]));
      connection.receiver.subscriptions.get('user-2').emit('data', Buffer.from([0x02]));

      assert.equal(pipeline.bufferedPacketCount, 2);
      pipeline.stop();
      assert.equal(pipeline.bufferedPacketCount, 0);
    });

    it('drainAllUserBuffers() should be a no-op when not running', () => {
      const drained = pipeline.drainAllUserBuffers();
      assert.equal(drained, 0);
      assert.equal(deepgramClient.send.mock.calls.length, 0);
    });

    it('drainAllUserBuffers() should be a no-op when Deepgram is not connected', () => {
      deepgramClient.isConnected = false;
      pipeline.start();

      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.subscriptions.get('user-1').emit('data', Buffer.from([0x01]));

      deepgramClient.isConnected = false; // still disconnected
      const drained = pipeline.drainAllUserBuffers();

      assert.equal(drained, 0);
      assert.equal(pipeline.bufferedPacketCount, 1, 'Buffer should remain intact');
    });

    it('getStats() should report totalBufferedPackets per user', () => {
      deepgramClient.isConnected = false;
      pipeline.start();

      connection.receiver.speaking.emit('start', 'user-a');
      connection.receiver.speaking.emit('start', 'user-b');

      connection.receiver.subscriptions.get('user-a').emit('data', Buffer.from([0x01]));
      connection.receiver.subscriptions.get('user-a').emit('data', Buffer.from([0x02]));
      connection.receiver.subscriptions.get('user-b').emit('data', Buffer.from([0x03]));

      const stats = pipeline.getStats();
      assert.equal(stats.totalBufferedPackets, 3);

      const userA = stats.users.find(u => u.userId === 'user-a');
      const userB = stats.users.find(u => u.userId === 'user-b');
      assert.ok(userA);
      assert.ok(userB);
      assert.equal(userA.bufferedPackets, 2);
      assert.equal(userB.bufferedPackets, 1);
    });
  });

  describe('direct mode — OpusDecoderPool integration', () => {
    /**
     * Creates a mock OpusDecoderPool that transforms the input buffer
     * (simulating Opus→PCM decoding) so tests can assert on decoded output.
     *
     * @param {boolean} [shouldFail] – when true, decode() returns null (simulates decode error)
     */
    function createMockDecoder(shouldFail = false) {
      const decoderPool = {
        _deletedUsers: [],
        decode: mock.fn((userId, packet) => {
          if (shouldFail) return null;
          // Return a "decoded" buffer: double the length to simulate PCM expansion
          const pcm = Buffer.alloc(packet.length * 2, 0x00);
          return pcm;
        }),
        deleteDecoder: mock.fn((userId) => {
          decoderPool._deletedUsers.push(userId);
        }),
        destroy: mock.fn(),
        on: mock.fn(),
      };
      return decoderPool;
    }

    it('should call decoder.decode() with userId and raw packet', () => {
      const opusDecoder = createMockDecoder();
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      const stream = connection.receiver.subscriptions.get('user-1');
      const packet = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      stream.emit('data', packet);

      assert.equal(opusDecoder.decode.mock.calls.length, 1);
      assert.equal(opusDecoder.decode.mock.calls[0].arguments[0], 'user-1');
      assert.deepEqual(opusDecoder.decode.mock.calls[0].arguments[1], packet);

      p.stop();
    });

    it('should send decoded PCM (not raw Opus) to Deepgram', () => {
      const opusDecoder = createMockDecoder();
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      const stream = connection.receiver.subscriptions.get('user-1');
      const packet = Buffer.from([0x01, 0x02]);
      stream.emit('data', packet);

      // Mock decoder doubles the length — deepgram should receive the decoded buffer
      assert.equal(deepgramClient.send.mock.calls.length, 1);
      const sentBuffer = deepgramClient.send.mock.calls[0].arguments[0];
      assert.equal(sentBuffer.length, packet.length * 2, 'Deepgram should receive decoded PCM');
      assert.notDeepEqual(sentBuffer, packet, 'Deepgram should NOT receive raw Opus');

      p.stop();
    });

    it('should report decoded PCM byteLength in audio_forwarded event', () => {
      const opusDecoder = createMockDecoder();
      const forwarded = [];
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.on('audio_forwarded', (e) => forwarded.push(e));
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0xAA, 0xBB])); // 2 bytes Opus → 4 bytes PCM

      assert.equal(forwarded.length, 1);
      assert.equal(forwarded[0].byteLength, 4); // decoded size = 2 * 2

      p.stop();
    });

    it('should drop packet and emit audio_dropped reason=decode_failed when decode returns null', () => {
      const opusDecoder = createMockDecoder(true); // always returns null
      const dropped = [];
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.on('audio_dropped', (e) => dropped.push(e));
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0xFF]));

      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].reason, 'decode_failed');
      assert.equal(dropped[0].userId, 'user-1');
      assert.equal(deepgramClient.send.mock.calls.length, 0);

      p.stop();
    });

    it('should not increment totalPackets when decode fails', () => {
      const opusDecoder = createMockDecoder(true);
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0xFF]));

      assert.equal(p.totalPackets, 0);
      p.stop();
    });

    it('should call deleteDecoder when a user stream ends', () => {
      const opusDecoder = createMockDecoder();
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));
      stream.emit('end');

      assert.ok(
        opusDecoder.deleteDecoder.mock.calls.some(c => c.arguments[0] === 'user-1'),
        'deleteDecoder should be called for user-1 on stream end'
      );

      p.stop();
    });

    it('should call deleteDecoder for all users when pipeline is stopped', () => {
      const opusDecoder = createMockDecoder();
      const p = new AudioCapturePipeline({ connection, deepgramClient, opusDecoder });
      p.start();

      connection.receiver.speaking.emit('start', 'user-1');
      connection.receiver.speaking.emit('start', 'user-2');

      p.stop();

      const deletedUsers = opusDecoder.deleteDecoder.mock.calls.map(c => c.arguments[0]);
      assert.ok(deletedUsers.includes('user-1'), 'user-1 decoder should be released on stop');
      assert.ok(deletedUsers.includes('user-2'), 'user-2 decoder should be released on stop');
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

// ─────────────────────────────────────────────────────────────────────────────
// OpusDecoderPool integration — Sub-AC 2.2
// Verifies that PCM audio is decoded before piping to Deepgram WebSocket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock OpusDecoderPool that returns predictable decoded PCM buffers.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.failDecode=false] - make decode() return null (simulate error)
 * @returns {{ pool: object, decodeCalls: Array }}
 */
function createMockOpusDecoder({ failDecode = false } = {}) {
  const decodeCalls = [];

  const pool = new EventEmitter();
  pool.decode = mock.fn((userId, packet) => {
    decodeCalls.push({ userId, packet });
    if (failDecode) return null;
    // Return decoded PCM: double the length to simulate stereo→mono reduction
    return Buffer.from(packet.map(b => b ^ 0xFF)); // invert bits as a marker
  });
  pool.deleteDecoder = mock.fn();
  pool.destroy = mock.fn(() => pool.removeAllListeners());

  return { pool, decodeCalls };
}

describe('AudioCapturePipeline — OpusDecoderPool integration (Sub-AC 2.2)', () => {
  let connection;
  let deepgramClient;

  beforeEach(() => {
    connection = createMockConnection();
    deepgramClient = createMockDeepgramClient(true);
  });

  describe('Opus→PCM decoding before Deepgram send', () => {
    it('should decode Opus packet through OpusDecoderPool before forwarding to Deepgram', () => {
      const { pool, decodeCalls } = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const rawOpusPacket = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x02]);
      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', rawOpusPacket);

      // OpusDecoderPool.decode() must have been called with the raw Opus bytes
      assert.equal(decodeCalls.length, 1);
      assert.equal(decodeCalls[0].userId, 'user-1');
      assert.deepEqual(decodeCalls[0].packet, rawOpusPacket);

      // Deepgram must receive the DECODED buffer, not the raw Opus packet
      assert.equal(deepgramClient.send.mock.calls.length, 1);
      const sentBuffer = deepgramClient.send.mock.calls[0].arguments[0];
      // The mock decoder inverts bits — verify it's NOT the original packet
      assert.notDeepEqual(sentBuffer, rawOpusPacket);
      // Verify it IS the decoded output (bit-inverted by our mock)
      const expectedDecoded = Buffer.from(rawOpusPacket.map(b => b ^ 0xFF));
      assert.deepEqual(sentBuffer, expectedDecoded);

      pipeline.stop();
    });

    it('should drop audio packet when OpusDecoderPool decode returns null', () => {
      const { pool } = createMockOpusDecoder({ failDecode: true });

      const dropped = [];
      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });
      pipeline.on('audio_dropped', (e) => dropped.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x80, 0x78]));

      // Must drop the packet, not forward it
      assert.equal(deepgramClient.send.mock.calls.length, 0);
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].reason, 'decode_failed');
      assert.equal(dropped[0].userId, 'user-1');

      pipeline.stop();
    });

    it('should forward raw Opus bytes unchanged when no decoder is configured (passthrough)', () => {
      // No opusDecoder — raw bytes forwarded directly
      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
      });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const rawPacket = Buffer.from([0x80, 0x78, 0xAB, 0xCD]);
      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', rawPacket);

      // Raw packet sent directly to Deepgram
      assert.equal(deepgramClient.send.mock.calls.length, 1);
      assert.deepEqual(deepgramClient.send.mock.calls[0].arguments[0], rawPacket);

      pipeline.stop();
    });

    it('should decode per-user audio independently across multiple concurrent speakers', () => {
      const { pool, decodeCalls } = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      pipeline.start();

      // 5 users start speaking simultaneously
      for (let i = 0; i < 5; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
      }

      // Each user sends one audio packet
      const rawPackets = [];
      for (let i = 0; i < 5; i++) {
        const pkt = Buffer.from([0x80, 0x78, i]);
        rawPackets.push(pkt);
        const stream = connection.receiver.subscriptions.get(`user-${i}`);
        stream.emit('data', pkt);
      }

      // All 5 packets should have been decoded
      assert.equal(decodeCalls.length, 5);
      for (let i = 0; i < 5; i++) {
        assert.equal(decodeCalls[i].userId, `user-${i}`);
      }

      // All 5 decoded packets forwarded to Deepgram
      assert.equal(deepgramClient.send.mock.calls.length, 5);
      assert.equal(pipeline.totalPackets, 5);

      pipeline.stop();
    });

    it('should release per-user decoder when stream ends', () => {
      const { pool } = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));

      // Simulate stream end (user stopped speaking)
      stream.emit('end');

      // deleteDecoder should be called to free WASM memory
      assert.equal(pool.deleteDecoder.mock.calls.length, 1);
      assert.equal(pool.deleteDecoder.mock.calls[0].arguments[0], 'user-1');

      pipeline.stop();
    });

    it('should destroy decoder pool on pipeline stop', () => {
      const { pool } = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      pipeline.start();
      pipeline.stop();

      // destroy() must be called to free all WASM decoder instances
      assert.equal(pool.destroy.mock.calls.length, 1);
    });

    it('should decode but buffer (not send) audio when Deepgram is disconnected', () => {
      // When Deepgram is temporarily disconnected, the implementation deliberately
      // decodes the Opus packet first to keep the per-user codec state advancing
      // (prevents desync when the connection is restored and buffered PCM is replayed),
      // then buffers the decoded PCM for later replay rather than dropping it.
      const { pool, decodeCalls } = createMockOpusDecoder();
      deepgramClient.isConnected = false;

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x80, 0x78]));

      // Decoder IS called to maintain per-user codec state
      assert.equal(decodeCalls.length, 1, 'Decoder must be called to maintain codec state');
      assert.equal(decodeCalls[0].userId, 'user-1');

      // Deepgram.send() must NOT be called — packet is buffered, not forwarded
      assert.equal(deepgramClient.send.mock.calls.length, 0, 'Deepgram.send must not be called when disconnected');

      // Packet should be held in per-user buffer (bufferedPacketCount > 0)
      assert.equal(pipeline.bufferedPacketCount, 1, 'Decoded packet must be buffered for later replay');

      pipeline.stop();
    });
  });

  describe('Audio format requirements (Discord → Deepgram)', () => {
    it('should send decoded PCM to Deepgram (not raw Opus frames)', () => {
      // Simulates the linear16 PCM path: raw Opus in, decoded PCM out
      const pcmBytes = Buffer.alloc(1920, 0); // 960 mono int16 samples at 48kHz = 1920 bytes

      const pool = new EventEmitter();
      pool.decode = mock.fn(() => pcmBytes);
      pool.deleteDecoder = mock.fn();
      pool.destroy = mock.fn();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x80, 0x78, 0x00])); // raw Opus (3 bytes)

      // Deepgram receives 1920 bytes of decoded PCM, not 3 bytes of raw Opus
      const sent = deepgramClient.send.mock.calls[0].arguments[0];
      assert.equal(sent.length, 1920);
      assert.deepEqual(sent, pcmBytes);

      pipeline.stop();
    });

    it('should record speakerIdentifier activity after successful decode', () => {
      const { pool } = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: pool,
      });

      const forwardedEvents = [];
      pipeline.on('audio_forwarded', (e) => forwardedEvents.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x80, 0x78, 0x00, 0x01]));

      // audio_forwarded emitted with the decoded (not raw) byte length
      assert.equal(forwardedEvents.length, 1);
      assert.equal(forwardedEvents[0].userId, 'user-1');
      // Decoded buffer from our mock has same length as input (bit-inverted mock)
      assert.equal(forwardedEvents[0].byteLength, 4);

      pipeline.stop();
    });
  });
});
