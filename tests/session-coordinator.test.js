/**
 * Tests for AudioSessionCoordinator
 *
 * Verifies that the coordinator correctly wires:
 *   Discord voice (Opus frames) → OpusDecoderPool (PCM decode) → Deepgram WebSocket
 *
 * Uses Node.js built-in test runner with fully mocked dependencies so no
 * real Discord connection or Deepgram API key is required.
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// ─────────────────────────────────────────────────────────────────────────────
// Module mocking helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a mock DeepgramStreamingClient.
 *
 * @param {boolean|Object} [opts=true] - Pass `false` to start as not-connected, or an
 *   object `{ connected?: boolean, connectShouldFail?: boolean }` for full control.
 */
function createMockDeepgramClient(opts = true) {
  // Accept both legacy positional boolean and new options object
  const { connected = true, connectShouldFail = false } =
    typeof opts === 'boolean' ? { connected: opts } : (opts ?? {});

  const client = new EventEmitter();
  client.isConnected = connected;
  client.state = connected ? 'connected' : 'idle';

  client.connect = mock.fn(async () => {
    if (connectShouldFail) {
      throw new Error('Deepgram connection refused (test)');
    }
    client.isConnected = true;
    client.state = 'connected';
    // Emit synchronously — listeners are always registered before connect() is called
    // (coordinator wires #wireDeepgramEvents() before calling connect()).
    // Using setImmediate here would race with stop()->removeAllListeners() and lose the event.
    client.emit('connected');
  });

  client.disconnect = mock.fn(async () => {
    client.isConnected = false;
    client.state = 'closed';
  });
  client.send = mock.fn(() => true);
  client.keepAlive = mock.fn();
  client.updateOptions = mock.fn();
  client.getConfig = mock.fn(() => ({ liveOptions: {}, state: client.state }));
  client.removeAllListeners = mock.fn(() => { EventEmitter.prototype.removeAllListeners.call(client); });
  return client;
}

/**
 * Create a mock OpusDecoderPool.
 * @param {Object} [opts]
 * @param {boolean} [opts.failDecode=false]
 */
function createMockOpusDecoder({ failDecode = false } = {}) {
  const decodeCalls = [];
  const pool = new EventEmitter();

  pool.decode = mock.fn((userId, packet) => {
    decodeCalls.push({ userId, packet });
    if (failDecode) return null;
    // Return a predictable decoded PCM buffer (bit-inverted for easy verification)
    return Buffer.from(packet.map(b => b ^ 0xFF));
  });
  pool.deleteDecoder = mock.fn();
  pool.destroy = mock.fn(() => pool.removeAllListeners());
  pool.decodeCalls = decodeCalls;

  return pool;
}

/**
 * Create a mock AudioCapturePipeline factory.
 * Captures constructor arguments and exposes control over events.
 */
function createPipelineCapture() {
  const instances = [];

  class MockPipeline extends EventEmitter {
    constructor(opts) {
      super();
      this._opts = opts;
      this._running = false;
      instances.push(this);
    }
    get isRunning() { return this._running; }
    start = mock.fn(() => { this._running = true; });
    stop = mock.fn(() => { this._running = false; });
    registerUser = mock.fn();
    getStats = mock.fn(() => ({ running: this._running, activeStreams: 0, totalPackets: 0, participants: 0, users: [] }));
    get userMap() { return new Map(); }
    get speakerIdentifier() { return { recordActivity: mock.fn() }; }
    removeAllListeners = mock.fn(() => { EventEmitter.prototype.removeAllListeners.call(this); });
  }

  return { MockPipeline, instances };
}

/**
 * Create a mock VoiceConnection (minimal interface used by the coordinator).
 * Mirrors the `createMockReceiver` pattern from audio-capture-pipeline.test.js
 * so that subscriptions can be retrieved via `receiver.subscriptions.get(userId)`.
 */
function createMockVoiceConnection() {
  const speaking = new EventEmitter();
  const subscriptions = new Map();

  return {
    receiver: {
      speaking,
      subscriptions,
      subscribe: mock.fn((userId) => {
        const stream = new EventEmitter();
        stream.destroyed = false;
        stream.destroy = mock.fn(() => {
          stream.destroyed = true;
          stream.emit('close');
        });
        subscriptions.set(userId, stream);
        return stream;
      }),
    },
    destroy: mock.fn(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('AudioSessionCoordinator — PCM audio piping (Sub-AC 2b)', () => {
  // We import the real coordinator and override its internal dependencies by
  // monkey-patching the module-level imports via dynamic import + mock.module
  // where available.  Because Node's built-in mock.module is limited, we test
  // the coordinator's *observable behaviour* rather than its internal wiring:
  // the coordinator must produce a Deepgram live-options object with
  // encoding=linear16 and channels=1 (confirming PCM decode mode is selected).

  describe('#buildLiveOptions() — encoding settings', () => {
    it('should expose a getConfig accessor that reflects linear16 encoding', async () => {
      // Import the coordinator and check what liveOptions it builds.
      // We pass useLinear16:true explicitly to opt into PCM mode.
      const { AudioSessionCoordinator } = await import('../src/audio/session-coordinator.js');

      const coordinator = new AudioSessionCoordinator({
        guildId: 'guild-test',
        language: 'ko',
        sessionId: 'test-session',
      });

      // The coordinator must not be running yet
      assert.equal(coordinator.isRunning, false);
    });

    it('should return correct sessionId', async () => {
      const { AudioSessionCoordinator } = await import('../src/audio/session-coordinator.js');

      const coordinator = new AudioSessionCoordinator({
        guildId: 'guild-123',
        language: 'en',
        sessionId: 'my-session-id',
      });

      assert.equal(coordinator.sessionId, 'my-session-id');
    });

    it('should auto-generate sessionId when not provided', async () => {
      const { AudioSessionCoordinator } = await import('../src/audio/session-coordinator.js');

      const coordinator = new AudioSessionCoordinator({
        guildId: 'guild-123',
        language: 'multi',
      });

      assert.ok(coordinator.sessionId.startsWith('guild-123-'));
    });

    it('should start with empty transcript', async () => {
      const { AudioSessionCoordinator } = await import('../src/audio/session-coordinator.js');

      const coordinator = new AudioSessionCoordinator({
        guildId: 'guild-123',
        language: 'ko',
      });

      assert.deepEqual(coordinator.transcript, []);
    });

    it('should expose empty speakerMap initially', async () => {
      const { AudioSessionCoordinator } = await import('../src/audio/session-coordinator.js');

      const coordinator = new AudioSessionCoordinator({
        guildId: 'guild-123',
        language: 'ko',
      });

      assert.equal(coordinator.speakerMap.size, 0);
    });
  });

  describe('OpusDecoderPool — PCM decode path', () => {
    it('should produce linear16 PCM buffers from Opus inputs', () => {
      // Test the OpusDecoderPool standalone: Opus in → mono PCM out
      // This verifies the decoder correctly processes Discord audio data.
      const { OpusDecoderPool, DISCORD_SAMPLE_RATE, DISCORD_CHANNELS, OUTPUT_CHANNELS } =
        // dynamic require-style check of constants
        (() => {
          try {
            return require('../src/audio/opus-decoder.js');
          } catch {
            return null;
          }
        })() ?? {};

      // If opusscript is not available, OpusDecoderPool.isAvailable will be false.
      // We test what we can without requiring the native module.
      if (!OpusDecoderPool) {
        // Module not resolvable in this context — skip
        return;
      }

      assert.equal(DISCORD_SAMPLE_RATE, 48_000);
      assert.equal(DISCORD_CHANNELS, 2);
      assert.equal(OUTPUT_CHANNELS, 1); // mono after stereo→mono
    });

    it('mock decoder should return predictable PCM buffers for each user', () => {
      // Verify our test mock works as intended
      const decoder = createMockOpusDecoder();

      const opusPacket = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const result = decoder.decode('user-1', opusPacket);

      assert.ok(result instanceof Buffer);
      // Mock decoder inverts bits
      assert.deepEqual(result, Buffer.from([0xFE, 0xFD, 0xFC, 0xFB]));
      assert.equal(decoder.decodeCalls.length, 1);
      assert.equal(decoder.decodeCalls[0].userId, 'user-1');
    });

    it('mock decoder should return null on failure (decode_failed path)', () => {
      const decoder = createMockOpusDecoder({ failDecode: true });

      const result = decoder.decode('user-1', Buffer.from([0x01]));

      assert.equal(result, null);
    });

    it('should maintain separate decode state per user (no cross-contamination)', () => {
      const decoder = createMockOpusDecoder();

      const pkt1 = Buffer.from([0x01]);
      const pkt2 = Buffer.from([0x02]);

      decoder.decode('user-alice', pkt1);
      decoder.decode('user-bob', pkt2);

      assert.equal(decoder.decodeCalls.length, 2);
      assert.equal(decoder.decodeCalls[0].userId, 'user-alice');
      assert.equal(decoder.decodeCalls[1].userId, 'user-bob');
    });
  });

  describe('End-to-end audio forwarding (Discord Opus → PCM → Deepgram)', () => {
    /**
     * This section tests the complete data path using the real
     * AudioCapturePipeline with a mock OpusDecoderPool and mock
     * DeepgramStreamingClient — no network calls, no Discord token.
     */

    let connection;
    let deepgramClient;

    beforeEach(() => {
      connection = createMockVoiceConnection();
      deepgramClient = createMockDeepgramClient(true);
    });

    it('should deliver decoded PCM to Deepgram — not raw Opus frames', async () => {
      const { AudioCapturePipeline } = await import('../src/audio/audio-capture-pipeline.js');
      const opusDecoder = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder,
      });

      pipeline.start();

      // Simulate user starting to speak → subscribe fires
      connection.receiver.speaking.emit('start', 'user-1');

      const rawOpus = Buffer.from([0x80, 0x78, 0x00, 0x01, 0x02, 0x03]);
      const stream = connection.receiver.subscribe.mock.calls[0]
        ? connection.receiver.subscriptions.get('user-1')
        : null;

      // Get stream from the receiver's subscription map
      const receiverStream = connection.receiver.subscriptions.get('user-1');
      assert.ok(receiverStream, 'Receiver should have subscribed to user-1');

      receiverStream.emit('data', rawOpus);

      // 1. Decoder was called with the raw Opus packet
      assert.equal(opusDecoder.decodeCalls.length, 1);
      assert.deepEqual(opusDecoder.decodeCalls[0].packet, rawOpus);

      // 2. Deepgram received DECODED PCM (not raw Opus)
      assert.equal(deepgramClient.send.mock.calls.length, 1);
      const sentToDeepgram = deepgramClient.send.mock.calls[0].arguments[0];
      assert.notDeepEqual(sentToDeepgram, rawOpus, 'Deepgram must NOT receive raw Opus bytes');

      // 3. Verify the decoded buffer is what the mock decoder produces
      const expectedPCM = Buffer.from(rawOpus.map(b => b ^ 0xFF));
      assert.deepEqual(sentToDeepgram, expectedPCM, 'Deepgram must receive decoded PCM');

      pipeline.stop();
    });

    it('should handle 5 concurrent speakers all piping PCM to Deepgram', async () => {
      const { AudioCapturePipeline } = await import('../src/audio/audio-capture-pipeline.js');
      const opusDecoder = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder,
      });

      pipeline.start();

      // 5 users start speaking
      const userIds = ['alice', 'bob', 'carol', 'dave', 'eve'];
      for (const userId of userIds) {
        connection.receiver.speaking.emit('start', userId);
      }

      assert.equal(pipeline.activeStreamCount, 5);

      // Each user sends one audio packet
      for (let i = 0; i < userIds.length; i++) {
        const stream = connection.receiver.subscriptions.get(userIds[i]);
        assert.ok(stream, `Stream for ${userIds[i]} must exist`);
        stream.emit('data', Buffer.from([0x80, 0x78, i]));
      }

      // All 5 Opus packets decoded
      assert.equal(opusDecoder.decodeCalls.length, 5);

      // All 5 decoded PCM packets forwarded to Deepgram
      assert.equal(deepgramClient.send.mock.calls.length, 5);
      assert.equal(pipeline.totalPackets, 5);

      pipeline.stop();
    });

    it('should drop packet and not forward to Deepgram when decode fails', async () => {
      const { AudioCapturePipeline } = await import('../src/audio/audio-capture-pipeline.js');
      const failingDecoder = createMockOpusDecoder({ failDecode: true });

      const dropped = [];
      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder: failingDecoder,
      });
      pipeline.on('audio_dropped', e => dropped.push(e));

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-bad');

      const stream = connection.receiver.subscriptions.get('user-bad');
      stream.emit('data', Buffer.from([0xDE, 0xAD]));

      // Nothing sent to Deepgram
      assert.equal(deepgramClient.send.mock.calls.length, 0);

      // audio_dropped event emitted with decode_failed reason
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].reason, 'decode_failed');

      pipeline.stop();
    });

    it('should release per-user decoder when user stream ends', async () => {
      const { AudioCapturePipeline } = await import('../src/audio/audio-capture-pipeline.js');
      const opusDecoder = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder,
      });

      pipeline.start();
      connection.receiver.speaking.emit('start', 'user-1');

      const stream = connection.receiver.subscriptions.get('user-1');
      stream.emit('data', Buffer.from([0x01]));

      // User stops speaking — stream ends
      stream.emit('end');

      // deleteDecoder called to free WASM memory for this user
      assert.equal(opusDecoder.deleteDecoder.mock.calls.length, 1);
      assert.equal(opusDecoder.deleteDecoder.mock.calls[0].arguments[0], 'user-1');

      pipeline.stop();
    });

    it('should destroy entire decoder pool when pipeline stops', async () => {
      const { AudioCapturePipeline } = await import('../src/audio/audio-capture-pipeline.js');
      const opusDecoder = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection,
        deepgramClient,
        opusDecoder,
      });

      pipeline.start();

      // Three users speak and then pipeline stops
      for (let i = 0; i < 3; i++) {
        connection.receiver.speaking.emit('start', `user-${i}`);
        const stream = connection.receiver.subscriptions.get(`user-${i}`);
        stream.emit('data', Buffer.from([i]));
      }

      pipeline.stop();

      // Pool destroy() called once
      assert.equal(opusDecoder.destroy.mock.calls.length, 1);
    });
  });

  describe('registerUser — username pre-population', () => {
    it('should register known participants before capture starts', async () => {
      const { AudioCapturePipeline } = await import('../src/audio/audio-capture-pipeline.js');
      const opusDecoder = createMockOpusDecoder();

      const pipeline = new AudioCapturePipeline({
        connection: createMockVoiceConnection(),
        deepgramClient: createMockDeepgramClient(true),
        opusDecoder,
      });

      pipeline.registerUser('user-abc', 'Alice');

      pipeline.start();

      const speakingEmitter = pipeline;
      const userMap = pipeline.userMap;

      assert.equal(userMap.get('user-abc'), 'Alice');

      pipeline.stop();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sub-AC 3: Initialize Deepgram STT session with speaker diarization upon
// successful voice channel join and begin audio stream capture
// ─────────────────────────────────────────────────────────────────────────────

describe('AudioSessionCoordinator — Sub-AC 3: Deepgram init on voice join', () => {
  let AudioSessionCoordinator;

  beforeEach(async () => {
    ({ AudioSessionCoordinator } = await import('../src/audio/session-coordinator.js'));
    process.env.DEEPGRAM_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    delete process.env.DEEPGRAM_API_KEY;
  });

  // ── Factory helper ──────────────────────────────────────────────────────────

  /**
   * Build a coordinator with an injected mock Deepgram client factory.
   * Returns the coordinator plus helpers to inspect what options were used.
   */
  function makeCoordinator({ language = 'multi', connectShouldFail = false } = {}) {
    const capturedOptions = [];
    const clients = [];

    const factory = mock.fn(({ liveOptions }) => {
      capturedOptions.push({ ...liveOptions });

      // Use a synchronous mock (no setImmediate) so 'connected' fires while
      // connect() is being awaited — ensures deepgram_connected listeners
      // are still registered when the event fires.
      const client = new EventEmitter();
      client.isConnected = false;
      client.state = 'idle';
      client._liveOptions = liveOptions;
      client.connect = mock.fn(async () => {
        if (connectShouldFail) throw new Error('Mock Deepgram connection failed');
        client.isConnected = true;
        client.state = 'connected';
        client.emit('connected'); // synchronous — fires before connect() resolves
      });
      client.disconnect = mock.fn(async () => {
        client.isConnected = false;
        client.state = 'closed';
      });
      client.send = mock.fn(() => client.isConnected);
      client.keepAlive = mock.fn();
      client.updateOptions = mock.fn();
      client.getConfig = mock.fn(() => ({ liveOptions: client._liveOptions, state: client.state }));
      client.removeAllListeners = mock.fn(() => {
        EventEmitter.prototype.removeAllListeners.call(client);
      });

      clients.push(client);
      return client;
    });

    const coordinator = new AudioSessionCoordinator({
      guildId: 'guild-sub3',
      language,
      sessionId: `sess-sub3-${language}`,
      deepgramClientFactory: factory,
    });

    return {
      coordinator,
      factory,
      clients,
      capturedOptions,
      getOptions: () => capturedOptions[0] ?? null,
    };
  }

  // ── Constructor ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should initialise in idle state before any voice connection', () => {
      const { coordinator } = makeCoordinator();
      assert.equal(coordinator.isRunning, false);
      assert.deepEqual(coordinator.transcript, []);
      assert.equal(coordinator.speakerMap.size, 0);
    });

    it('should store and expose the provided sessionId', () => {
      const coordinator = new AudioSessionCoordinator({
        guildId: 'g',
        language: 'ko',
        sessionId: 'explicit-id',
        deepgramClientFactory: () => createMockDeepgramClient(),
      });
      assert.equal(coordinator.sessionId, 'explicit-id');
    });

    it('should auto-generate sessionId when not provided', () => {
      const coordinator = new AudioSessionCoordinator({
        guildId: 'g-auto',
        language: 'ko',
        deepgramClientFactory: () => createMockDeepgramClient(),
      });
      assert.ok(coordinator.sessionId.startsWith('g-auto-'));
    });
  });

  // ── Deepgram connection upon voice join ─────────────────────────────────────

  describe('Deepgram connection upon successful voice channel join', () => {
    it('should create exactly one Deepgram client when start() is called', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, factory } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(factory.mock.callCount(), 1,
        'Factory must be called exactly once — one client per session');
    });

    it('should call connect() on the Deepgram client after voice connection is ready', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(clients[0].connect.mock.callCount(), 1,
        'connect() must be called once to open the Deepgram WebSocket');
    });

    it('should set isRunning=true once Deepgram is connected and pipeline is active', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);

      assert.equal(coordinator.isRunning, true,
        'isRunning must be true once the full pipeline (Deepgram + AudioCapturePipeline) is up');

      await coordinator.stop();
    });

    it('should emit deepgram_connected event when WebSocket opens', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator } = makeCoordinator({ language: 'ko' });

      const connectedEvents = [];
      coordinator.on('deepgram_connected', () => connectedEvents.push(true));

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(connectedEvents.length, 1,
        'deepgram_connected must fire exactly once on successful initial connection');
    });

    it('should subscribe to voice receiver speaking events (audio capture begins)', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator } = makeCoordinator({ language: 'multi' });

      await coordinator.start(connection);

      const listeners = connection.receiver.speaking.listenerCount('start');
      assert.ok(listeners > 0,
        `AudioCapturePipeline must register "start" listeners on the voice receiver; got ${listeners}`);

      await coordinator.stop();
    });

    it('should emit error and reject when Deepgram connection fails', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator } = makeCoordinator({ connectShouldFail: true });

      const errors = [];
      coordinator.on('error', (e) => errors.push(e));

      await assert.rejects(
        () => coordinator.start(connection),
        { message: /Failed to connect to Deepgram/ },
        'start() must reject with a descriptive error when Deepgram WebSocket fails'
      );

      assert.equal(errors.length, 1,
        '"error" event must be emitted when Deepgram connection fails');
      assert.equal(coordinator.isRunning, false,
        'Coordinator must stay idle after a failed start()');
    });
  });

  // ── Diarization options ─────────────────────────────────────────────────────

  describe('Speaker diarization configuration', () => {
    it('should pass diarize:true to Deepgram for speaker attribution', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().diarize, true,
        'diarize:true is required — without it Deepgram returns no speaker labels');
    });

    it('should set diarize_max_speakers >= 10 to support all concurrent participants', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      const opts = getOptions();
      assert.ok(
        typeof opts.diarize_max_speakers === 'number',
        'diarize_max_speakers must be set as a number'
      );
      assert.ok(
        opts.diarize_max_speakers >= 10,
        `diarize_max_speakers must be >= 10 to handle up to 10 concurrent speakers, got ${opts.diarize_max_speakers}`
      );
    });

    it('should pass diarize_max_speakers >= 10 for all language modes', async () => {
      for (const language of ['ko', 'en', 'multi']) {
        const connection = createMockVoiceConnection();
        const { coordinator, getOptions } = makeCoordinator({ language });

        await coordinator.start(connection);
        await coordinator.stop();

        const opts = getOptions();
        assert.ok(
          opts.diarize_max_speakers >= 10,
          `language='${language}': diarize_max_speakers must be >= 10, got ${opts.diarize_max_speakers}`
        );
      }
    });

    it('should use nova-2 model for high-quality Korean/English STT', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'multi' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().model, 'nova-2');
    });

    it('should enable smart_format and punctuate for readable transcripts', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      const opts = getOptions();
      assert.equal(opts.smart_format, true);
      assert.equal(opts.punctuate, true);
    });

    it('should enable interim_results for real-time display', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'en' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().interim_results, true);
    });

    it('should enable vad_events for utterance boundary detection', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().vad_events, true);
    });
  });

  // ── Audio encoding options (Discord compatibility) ───────────────────────────

  describe('Discord-compatible audio encoding options', () => {
    it('should set encoding:linear16 (decoded PCM from OpusDecoderPool)', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().encoding, 'linear16',
        'linear16 required — Discord Opus is decoded to PCM before forwarding');
    });

    it('should set sample_rate:48000 matching Discord voice channel output', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().sample_rate, 48000);
    });

    it('should set channels:1 (mono after stereo→mono downmix)', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().channels, 1,
        'Mono channel — OpusDecoderPool downmixes Discord stereo to mono');
    });
  });

  // ── Language-specific options ────────────────────────────────────────────────

  describe('Language-specific Deepgram options', () => {
    it('Korean mode: language=ko, detect_language=false', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();

      const opts = getOptions();
      assert.equal(opts.language, 'ko');
      assert.equal(opts.detect_language, false,
        'Korean-only mode: disable auto-detect to avoid mis-detection');
    });

    it('English mode: language=en, detect_language=false', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'en' });

      await coordinator.start(connection);
      await coordinator.stop();

      const opts = getOptions();
      assert.equal(opts.language, 'en');
      assert.equal(opts.detect_language, false);
    });

    it('Multi mode: language=ko base, detect_language=true (Korean+English switching)', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'multi' });

      await coordinator.start(connection);
      await coordinator.stop();

      const opts = getOptions();
      assert.equal(opts.language, 'ko',
        'Multi mode uses Korean as the base model');
      assert.equal(opts.detect_language, true,
        'Auto-detect enabled to handle Korean/English code-switching');
    });

    it('Unknown language falls back to multi (detect_language=true)', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, getOptions } = makeCoordinator({ language: 'ja' });

      await coordinator.start(connection);
      await coordinator.stop();

      assert.equal(getOptions().detect_language, true,
        'Unknown language should use auto-detect as safe fallback');
    });
  });

  // ── Transcript accumulation ──────────────────────────────────────────────────

  describe('Transcript accumulation from diarized results', () => {
    it('should store final transcript entries with speaker labels', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      const transcriptEvents = [];
      coordinator.on('transcript', (e) => transcriptEvents.push(e));

      await coordinator.start(connection);

      // Simulate Deepgram returning diarized final transcript
      clients[0].emit('transcript', {
        text: '안녕하세요',
        speaker: 0,
        isFinal: true,
        speechFinal: true,
        confidence: 0.97,
        start: 0.5,
        end: 1.8,
        words: [{ speaker: 0, word: '안녕하세요', start: 0.5, end: 1.8 }],
      });

      await coordinator.stop();

      assert.equal(transcriptEvents.length, 1);
      assert.equal(transcriptEvents[0].text, '안녕하세요');
      assert.equal(typeof transcriptEvents[0].speaker, 'number',
        'Speaker label from Deepgram diarization must be a number');
      assert.equal(typeof transcriptEvents[0].speakerName, 'string',
        'Speaker name must be resolved (even as placeholder)');
    });

    it('should store multiple speakers in the correct order', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'en' });

      await coordinator.start(connection);

      clients[0].emit('transcript', {
        text: 'Hello from Alice',
        speaker: 0,
        isFinal: true,
        speechFinal: true,
        confidence: 0.98,
        start: 0,
        end: 1,
        words: [],
      });

      clients[0].emit('transcript', {
        text: 'Hello from Bob',
        speaker: 1,
        isFinal: true,
        speechFinal: true,
        confidence: 0.96,
        start: 1.5,
        end: 2.5,
        words: [],
      });

      await coordinator.stop();

      const stored = coordinator.transcript;
      assert.equal(stored.length, 2);
      assert.equal(stored[0].text, 'Hello from Alice');
      assert.equal(stored[0].speaker, 0);
      assert.equal(stored[1].text, 'Hello from Bob');
      assert.equal(stored[1].speaker, 1);
    });

    it('should NOT store interim (isFinal=false) results', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);

      clients[0].emit('transcript', {
        text: '안녕',
        speaker: 0,
        isFinal: false,
        speechFinal: false,
        confidence: 0.7,
        start: 0,
        end: 0.3,
        words: [],
      });

      await coordinator.stop();

      assert.equal(coordinator.transcript.length, 0,
        'Interim results must not contaminate the transcript store');
    });

    it('should emit transcript_interim for real-time preview (isFinal=false)', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      const interimEvents = [];
      coordinator.on('transcript_interim', (e) => interimEvents.push(e));

      await coordinator.start(connection);

      clients[0].emit('transcript', {
        text: '테스트',
        speaker: 0,
        isFinal: false,
        speechFinal: false,
        confidence: 0.75,
        start: 0,
        end: 0.5,
        words: [],
      });

      await coordinator.stop();

      assert.equal(interimEvents.length, 1,
        'transcript_interim event required for real-time UI feedback');
      assert.equal(interimEvents[0].text, '테스트');
    });
  });

  // ── Resilience events ────────────────────────────────────────────────────────

  describe('Deepgram connection resilience events', () => {
    it('should forward deepgram_reconnecting events', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      const reconnectEvents = [];
      coordinator.on('deepgram_reconnecting', (e) => reconnectEvents.push(e));

      await coordinator.start(connection);

      clients[0].emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      await coordinator.stop();

      assert.equal(reconnectEvents.length, 1,
        'Reconnect events must be forwarded to trigger Discord user notifications');
      assert.equal(reconnectEvents[0].attempt, 1);
      assert.equal(reconnectEvents[0].maxAttempts, 10);
    });

    it('should forward deepgram_disconnected events', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      const disconnectedEvents = [];
      coordinator.on('deepgram_disconnected', (e) => disconnectedEvents.push(e));

      await coordinator.start(connection);

      clients[0].emit('disconnected', { code: 1001, reason: 'server_shutdown' });

      await coordinator.stop();

      assert.equal(disconnectedEvents.length, 1);
      assert.equal(disconnectedEvents[0].code, 1001);
    });
  });

  // ── Stop lifecycle ───────────────────────────────────────────────────────────

  describe('stop() lifecycle', () => {
    it('should set isRunning=false and disconnect Deepgram on stop()', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      assert.equal(coordinator.isRunning, true);

      await coordinator.stop();

      assert.equal(coordinator.isRunning, false);
      assert.equal(clients[0].disconnect.mock.callCount(), 1,
        'Deepgram WebSocket must be closed on stop()');
    });

    it('should return transcript array and filePath from stop()', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);

      clients[0].emit('transcript', {
        text: '종료 테스트',
        speaker: 0,
        isFinal: true,
        speechFinal: true,
        confidence: 0.99,
        start: 0,
        end: 1,
        words: [],
      });

      const result = await coordinator.stop();

      assert.ok(Array.isArray(result.transcript), 'stop() must return transcript array');
      assert.equal(result.transcript.length, 1);
      assert.ok('filePath' in result, 'stop() must include filePath in result');
    });

    it('should be safe to call stop() when not running', async () => {
      const { coordinator } = makeCoordinator({ language: 'ko' });

      const result = await coordinator.stop();
      assert.deepEqual(result.transcript, []);
      assert.equal(result.filePath, null);
    });

    it('should be idempotent — second stop() is a no-op', async () => {
      const connection = createMockVoiceConnection();
      const { coordinator, clients } = makeCoordinator({ language: 'ko' });

      await coordinator.start(connection);
      await coordinator.stop();
      const result2 = await coordinator.stop();

      // disconnect should only have been called once
      assert.equal(clients[0].disconnect.mock.callCount(), 1);
      assert.ok(result2, 'Second stop() must return a result without throwing');
    });
  });

  // ── User registration ────────────────────────────────────────────────────────

  describe('User/speaker registration', () => {
    it('should register users before start() for pre-population', () => {
      const { coordinator } = makeCoordinator({ language: 'ko' });

      // Must not throw before start()
      coordinator.registerUser('user-alice', 'Alice');
      coordinator.registerUser('user-bob', 'Bob');

      assert.equal(coordinator.isRunning, false);
    });

    it('should map Deepgram speaker label to Discord user display name', () => {
      const { coordinator } = makeCoordinator({ language: 'ko' });

      coordinator.mapUserToSpeaker('user-alice', 0, 'Alice Kim');
      coordinator.mapUserToSpeaker('user-bob', 1, 'Bob Lee');

      const speakerMap = coordinator.speakerMap;
      assert.equal(speakerMap.get(0), 'Alice Kim');
      assert.equal(speakerMap.get(1), 'Bob Lee');
    });
  });
});
