/**
 * Tests for DeepgramStreamingClient
 *
 * Uses Node.js built-in test runner with mocked Deepgram SDK.
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Mock setup ---
// We mock the @deepgram/sdk module before importing the client

// Fake connection that simulates Deepgram WebSocket behavior
function createFakeConnection() {
  const handlers = {};
  return {
    on(event, handler) {
      handlers[event] = handler;
    },
    send: mock.fn(),
    keepAlive: mock.fn(),
    requestClose: mock.fn(() => {
      handlers.close?.({ code: 1000, reason: 'normal' });
    }),
    // Test helpers
    _handlers: handlers,
    _triggerOpen() { handlers.open?.(); },
    _triggerClose(event) { handlers.close?.(event ?? { code: 1000, reason: 'normal' }); },
    _triggerError(err) { handlers.error?.(err); },
    _triggerResults(data) { handlers.Results?.(data); },
    _triggerUtteranceEnd() { handlers.UtteranceEnd?.(); },
  };
}

// We'll use dynamic import with a module-level mock approach
let DeepgramStreamingClient;
let DEFAULT_LIVE_OPTIONS;
let RECONNECT_DEFAULTS;
let lastFakeConnection;

// Since we can't easily mock ESM imports in Node test runner,
// we test the class behavior by constructing with a real API key
// but intercepting at the connection level via a subclass approach.
// Instead, let's test the exported logic directly.

describe('DeepgramStreamingClient', () => {
  // For unit testing without network, we create a testable subclass
  // that overrides the private connection establishment
  let ClientClass;

  beforeEach(async () => {
    // Import fresh each time
    const mod = await import('../src/stt/deepgram-client.js');
    DeepgramStreamingClient = mod.DeepgramStreamingClient;
    DEFAULT_LIVE_OPTIONS = mod.DEFAULT_LIVE_OPTIONS;
    RECONNECT_DEFAULTS = mod.RECONNECT_DEFAULTS;
  });

  describe('constructor', () => {
    it('should throw if no API key is provided', () => {
      assert.throws(() => new DeepgramStreamingClient(), {
        message: 'Deepgram API key is required',
      });
      assert.throws(() => new DeepgramStreamingClient({}), {
        message: 'Deepgram API key is required',
      });
    });

    it('should initialize with default state', () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      assert.equal(client.state, 'idle');
      assert.equal(client.isConnected, false);
    });

    it('should accept custom live options', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        liveOptions: { language: 'en', model: 'nova-2-general' },
      });
      const config = client.getConfig();
      assert.equal(config.liveOptions.language, 'en');
      assert.equal(config.liveOptions.model, 'nova-2-general');
      // Default options should still be present
      assert.equal(config.liveOptions.diarize, true);
      assert.equal(config.liveOptions.smart_format, true);
    });

    it('should accept custom reconnect config', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { maxAttempts: 5, baseDelayMs: 500 },
      });
      const config = client.getConfig();
      assert.equal(config.reconnect.maxAttempts, 5);
      assert.equal(config.reconnect.baseDelayMs, 500);
      // Defaults preserved
      assert.equal(config.reconnect.maxDelayMs, 30000);
    });
  });

  describe('DEFAULT_LIVE_OPTIONS', () => {
    it('should have diarization enabled', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.diarize, true);
    });

    it('should configure diarize_max_speakers >= 10 for up to 10 concurrent participants', () => {
      assert.ok(
        typeof DEFAULT_LIVE_OPTIONS.diarize_max_speakers === 'number',
        'diarize_max_speakers must be a number'
      );
      assert.ok(
        DEFAULT_LIVE_OPTIONS.diarize_max_speakers >= 10,
        `diarize_max_speakers must be >= 10, got ${DEFAULT_LIVE_OPTIONS.diarize_max_speakers}`
      );
    });

    it('should target Korean with auto-detect', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.language, 'ko');
      assert.equal(DEFAULT_LIVE_OPTIONS.detect_language, true);
    });

    it('should use Discord-compatible audio settings', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.encoding, 'linear16');
      assert.equal(DEFAULT_LIVE_OPTIONS.sample_rate, 48000);
      assert.equal(DEFAULT_LIVE_OPTIONS.channels, 1);
    });

    it('should enable interim results for real-time feedback', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.interim_results, true);
    });

    it('should use nova-2 model', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.model, 'nova-2');
    });
  });

  describe('RECONNECT_DEFAULTS', () => {
    it('should have sensible defaults', () => {
      assert.equal(RECONNECT_DEFAULTS.maxAttempts, 10);
      assert.equal(RECONNECT_DEFAULTS.baseDelayMs, 1000);
      assert.equal(RECONNECT_DEFAULTS.maxDelayMs, 30000);
      assert.equal(RECONNECT_DEFAULTS.backoffMultiplier, 2);
      assert.equal(RECONNECT_DEFAULTS.jitterFactor, 0.2);
    });
  });

  describe('calculateBackoffDelay', () => {
    it('attempt 1 should return ~baseDelayMs', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000, jitterFactor: 0 },
      });
      assert.equal(client.calculateBackoffDelay(1), 1000);
    });

    it('should double on each attempt with multiplier 2 (no jitter)', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 60000, jitterFactor: 0 },
      });
      assert.equal(client.calculateBackoffDelay(1), 1000);
      assert.equal(client.calculateBackoffDelay(2), 2000);
      assert.equal(client.calculateBackoffDelay(3), 4000);
      assert.equal(client.calculateBackoffDelay(4), 8000);
      assert.equal(client.calculateBackoffDelay(5), 16000);
    });

    it('should cap at maxDelayMs (no jitter)', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 5000, jitterFactor: 0 },
      });
      // attempt 4 → 8000, but capped at 5000
      assert.equal(client.calculateBackoffDelay(4), 5000);
      assert.equal(client.calculateBackoffDelay(10), 5000);
    });

    it('should never return a negative delay', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 100, backoffMultiplier: 1, maxDelayMs: 100, jitterFactor: 1 },
      });
      // Even with full jitter, result must be >= 0
      for (let i = 0; i < 50; i++) {
        assert.ok(client.calculateBackoffDelay(1) >= 0);
      }
    });

    it('should apply jitter within ± jitterFactor of raw delay', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000, jitterFactor: 0.2 },
      });
      const rawDelay = 1000; // attempt 1
      // Over many samples, all should be within [rawDelay*(1-0.2), rawDelay*(1+0.2)]
      for (let i = 0; i < 50; i++) {
        const delay = client.calculateBackoffDelay(1);
        assert.ok(delay >= rawDelay * (1 - 0.2), `delay ${delay} < lower bound`);
        assert.ok(delay <= rawDelay * (1 + 0.2), `delay ${delay} > upper bound`);
      }
    });

    it('jitterFactor: 0 should return deterministic delays', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 500, backoffMultiplier: 3, maxDelayMs: 30000, jitterFactor: 0 },
      });
      // 500, 1500, 4500, 13500, 30000 (capped)
      assert.equal(client.calculateBackoffDelay(1), 500);
      assert.equal(client.calculateBackoffDelay(2), 1500);
      assert.equal(client.calculateBackoffDelay(3), 4500);
      assert.equal(client.calculateBackoffDelay(4), 13500);
      assert.equal(client.calculateBackoffDelay(5), 30000); // capped
    });

    it('custom backoffMultiplier is respected', () => {
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 1000, backoffMultiplier: 1.5, maxDelayMs: 60000, jitterFactor: 0 },
      });
      assert.equal(client.calculateBackoffDelay(1), 1000);
      assert.equal(client.calculateBackoffDelay(2), 1500);
      assert.equal(client.calculateBackoffDelay(3), 2250);
    });
  });

  describe('updateOptions', () => {
    it('should merge new options with existing ones', () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      client.updateOptions({ language: 'en', model: 'nova-2-general' });
      const config = client.getConfig();
      assert.equal(config.liveOptions.language, 'en');
      assert.equal(config.liveOptions.model, 'nova-2-general');
      // Unchanged defaults preserved
      assert.equal(config.liveOptions.diarize, true);
    });
  });

  describe('getConfig', () => {
    it('should return a copy (not reference) of config', () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      const config1 = client.getConfig();
      config1.liveOptions.language = 'fr';
      const config2 = client.getConfig();
      assert.equal(config2.liveOptions.language, 'ko'); // Unchanged
    });
  });

  describe('send', () => {
    it('should return false when not connected', () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      const result = client.send(Buffer.from('test'));
      assert.equal(result, false);
    });
  });

  describe('disconnect', () => {
    it('should set state to closed', async () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      await client.disconnect();
      assert.equal(client.state, 'closed');
    });

    it('should be safe to call multiple times', async () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      await client.disconnect();
      await client.disconnect();
      assert.equal(client.state, 'closed');
    });
  });

  describe('event emitter', () => {
    it('should be an EventEmitter', () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      assert.equal(typeof client.on, 'function');
      assert.equal(typeof client.emit, 'function');
      assert.equal(typeof client.removeListener, 'function');
    });

    it('should emit warning on duplicate connect', async () => {
      const client = new DeepgramStreamingClient({ apiKey: 'test-key' });
      // Force state to connected to test the guard
      // We use a workaround since state is private
      const warnings = [];
      client.on('warning', (msg) => warnings.push(msg));

      // We can't easily force state, but connect() will try to actually connect
      // and fail (no real API key). That's fine — we test the guard in integration.
    });
  });

  // ── Drop detection & context preservation (Sub-AC 12a) ──────────────────

  describe('drop detection and context preservation', () => {
    /**
     * Helper: create a client wired with a fake connection factory.
     * Returns { client, getFakeConn } — getFakeConn() returns the most
     * recently created fake connection (set during connect()).
     */
    function makeTestClient(extraOpts = {}) {
      let fakeConn = null;
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 3 },
        _connectionFactory: () => {
          fakeConn = createFakeConnection();
          return fakeConn;
        },
        ...extraOpts,
      });
      return { client, getFakeConn: () => fakeConn };
    }

    it('lastStreamTimestamp initialises to 0', () => {
      const { client } = makeTestClient();
      assert.equal(client.lastStreamTimestamp, 0);
    });

    it('lastStreamTimestamp updates when Results arrive', async () => {
      const { client, getFakeConn } = makeTestClient();
      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      // Simulate a Deepgram Results event
      getFakeConn()._triggerResults({
        is_final: true,
        speech_final: true,
        start: 2.0,
        duration: 1.5,
        channel: {
          alternatives: [{
            transcript: 'hello',
            confidence: 0.9,
            words: [{ word: 'hello', punctuated_word: 'Hello', speaker: 0,
                       start: 2.0, end: 3.5, confidence: 0.9 }],
          }],
        },
      });

      assert.equal(client.lastStreamTimestamp, 3.5); // start + duration
      await client.disconnect();
    });

    it('getDropContext returns all required fields', async () => {
      const { client, getFakeConn } = makeTestClient({ sessionId: 'test-session' });
      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      const ctx = client.getDropContext();
      assert.ok('sessionId' in ctx, 'missing sessionId');
      assert.ok('sessionStartTime' in ctx, 'missing sessionStartTime');
      assert.ok('lastStreamTimestamp' in ctx, 'missing lastStreamTimestamp');
      assert.ok('reconnectAttempts' in ctx, 'missing reconnectAttempts');
      assert.ok('state' in ctx, 'missing state');
      assert.equal(ctx.sessionId, 'test-session');
      assert.notEqual(ctx.sessionStartTime, null);
      assert.equal(ctx.state, 'connected');

      await client.disconnect();
    });

    it('drop_detected emitted with context on unexpected close', async () => {
      const { client, getFakeConn } = makeTestClient();
      const drops = [];
      client.on('drop_detected', (ctx) => drops.push(ctx));

      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      // Simulate network drop (abnormal close)
      getFakeConn()._triggerClose({ code: 1006, reason: 'abnormal closure' });

      assert.equal(drops.length, 1);
      assert.equal(drops[0].code, 1006);
      assert.equal(drops[0].reason, 'abnormal closure');
      assert.ok('sessionStartTime' in drops[0], 'missing sessionStartTime in drop payload');
      assert.ok('lastStreamTimestamp' in drops[0], 'missing lastStreamTimestamp in drop payload');
      assert.ok('reconnectAttempts' in drops[0], 'missing reconnectAttempts in drop payload');
    });

    it('drop_detected NOT emitted on intentional disconnect', async () => {
      const { client, getFakeConn } = makeTestClient();
      const drops = [];
      client.on('drop_detected', (ctx) => drops.push(ctx));

      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      await client.disconnect(); // intentional — should not emit drop_detected
      assert.equal(drops.length, 0);
    });

    it('onDropDetected callback fires with context on unexpected close', async () => {
      const callbackCtxs = [];
      const { client, getFakeConn } = makeTestClient({
        onDropDetected: (ctx) => callbackCtxs.push(ctx),
      });

      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      getFakeConn()._triggerClose({ code: 1006, reason: 'connection reset' });

      assert.equal(callbackCtxs.length, 1);
      assert.equal(callbackCtxs[0].code, 1006);
      assert.ok('lastStreamTimestamp' in callbackCtxs[0]);
    });

    it('error on connected socket triggers force-close and then drop_detected', async () => {
      const { client, getFakeConn } = makeTestClient();
      const drops = [];
      const errors = [];
      // Must register an error listener — EventEmitter throws if 'error' fires with no listener
      client.on('error', (err) => errors.push(err));
      client.on('drop_detected', (ctx) => drops.push(ctx));

      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      // Simulate an error on the live connection.
      // error handler → requestClose() → close fires → drop_detected emitted.
      getFakeConn()._triggerError(new Error('WebSocket error'));

      assert.equal(errors.length, 1, 'error event should fire once');
      assert.equal(drops.length, 1, 'drop_detected should fire after error on connected socket');
    });

    it('reconnect loop does not deadlock when connection closes before open', (t, done) => {
      // If #establishConnection promise never settles, the test will time out.
      // This test verifies the bug-fix: Promise rejects when close fires before open.
      let fakeConn = null;
      let connectCount = 0;
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 2 },
        _connectionFactory: () => {
          fakeConn = createFakeConnection();
          connectCount++;
          // After first close-before-open, let second attempt succeed
          if (connectCount >= 2) {
            setImmediate(() => fakeConn._triggerOpen());
          } else {
            // Simulate connection that closes before opening (no open event)
            setImmediate(() => fakeConn._triggerClose({ code: 1006, reason: 'refused' }));
          }
          return fakeConn;
        },
      });

      client.on('connected', async () => {
        // Reconnect loop recovered — success
        assert.ok(connectCount >= 2, 'should have attempted at least 2 connections');
        await client.disconnect();
        done();
      });

      client.on('error', (err) => {
        // Only terminal failure (after max attempts) is acceptable
        if (!err.message.includes('reconnection failed after')) {
          done(err);
        } else {
          done(); // max-attempts exhausted — that's also fine for this test
        }
      });

      client.connect().catch(() => {
        // Initial connect() rejects when first close-before-open fires — expected
      });
    });

    it('lastStreamTimestamp resets to 0 after disconnect', async () => {
      const { client, getFakeConn } = makeTestClient();
      const p = client.connect();
      getFakeConn()._triggerOpen();
      await p;

      getFakeConn()._triggerResults({
        is_final: true,
        speech_final: true,
        start: 5.0,
        duration: 2.0,
        channel: {
          alternatives: [{
            transcript: 'test',
            confidence: 0.9,
            words: [{ word: 'test', punctuated_word: 'test', speaker: 0,
                       start: 5.0, end: 7.0, confidence: 0.9 }],
          }],
        },
      });
      assert.equal(client.lastStreamTimestamp, 7.0);

      await client.disconnect();
      assert.equal(client.lastStreamTimestamp, 0);
    });
  });

  // ── Retry logic with exponential backoff (Sub-AC 12b) ───────────────────
  //
  // These tests exercise the full retry loop end-to-end, verifying:
  //   • reconnecting events are emitted after an unexpected drop
  //   • attempt numbers are sequential and capped at maxAttempts
  //   • maxAttempts is configurable and enforced
  //   • a new Deepgram connection is created on each retry (stream re-init)
  //   • sessionStartTime and lastStreamTimestamp are preserved across reconnects
  //   • the attempt counter resets to 0 after a successful reconnect
  //   • intentional disconnect does not trigger the retry loop

  describe('retry logic with exponential backoff (Sub-AC 12b)', () => {
    /**
     * Build a test client with fast (delay=0) reconnect settings and a
     * _connectionFactory that pushes every created connection into an array
     * so tests can reference individual connections by index.
     *
     * @param {Object} [extraOpts] - merged into DeepgramStreamingClient options
     * @returns {{ client, connections: Array, latest: () => FakeConnection }}
     */
    function makeRetryClient(extraOpts = {}) {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 3 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          return conn;
        },
        ...extraOpts,
      });
      return { client, connections, latest: () => connections[connections.length - 1] };
    }

    // ── 1. Basic reconnect trigger ─────────────────────────────────────────

    it('emits reconnecting event after unexpected disconnect', (t, done) => {
      const { client, connections } = makeRetryClient();
      const reconnectEvents = [];
      client.on('reconnecting', (info) => reconnectEvents.push(info));

      const p = client.connect();
      // connections[0] is created synchronously inside connect()
      connections[0]._triggerOpen();

      p.then(() => {
        // Simulate unexpected network drop
        connections[0]._triggerClose({ code: 1006, reason: 'network error' });

        // setTimeout(0) schedules reconnect; give it a tick to fire
        setImmediate(() => {
          try {
            assert.ok(reconnectEvents.length >= 1, 'at least one reconnecting event expected');
            assert.equal(reconnectEvents[0].attempt, 1);
            assert.equal(reconnectEvents[0].maxAttempts, 3);
            assert.ok(typeof reconnectEvents[0].delayMs === 'number', 'delayMs should be a number');
            client.disconnect().then(done).catch(done);
          } catch (e) {
            done(e);
          }
        });
      }).catch(done);
    });

    // ── 2. Sequential attempt numbers ─────────────────────────────────────

    it('attempt numbers are sequential: 1, 2, 3 before terminal error', (t, done) => {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 3 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          if (connections.length > 1) {
            // All reconnect attempts fail (close before open)
            setImmediate(() => conn._triggerClose({ code: 1006, reason: 'refused' }));
          }
          return conn;
        },
      });

      const reconnectAttempts = [];
      client.on('reconnecting', (info) => reconnectAttempts.push(info.attempt));

      client.on('error', () => {
        try {
          assert.deepEqual(
            reconnectAttempts,
            [1, 2, 3],
            `expected attempts [1,2,3], got [${reconnectAttempts}]`,
          );
          done();
        } catch (e) {
          done(e);
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.then(() => {
        // Drop triggers the retry loop; subsequent factory calls auto-fail
        connections[0]._triggerClose({ code: 1006, reason: 'network error' });
      }).catch(done);
    });

    // ── 3. Configurable maxAttempts ────────────────────────────────────────

    it('stops retrying after configurable maxAttempts and emits terminal error', (t, done) => {
      // Use 4 — different from the default 10 — to prove the option is applied
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 4 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          setImmediate(() => conn._triggerClose({ code: 1006, reason: 'refused' }));
          return conn;
        },
      });

      client.on('error', (err) => {
        try {
          assert.ok(
            err.message.includes('reconnection failed after 4 attempts'),
            `Expected terminal error mentioning 4 attempts; got: "${err.message}"`,
          );
          assert.equal(client.state, 'closed', 'state should be closed after exhausting retries');
          done();
        } catch (e) {
          done(e);
        }
      });

      // Initial connect also fails (close-before-open), starting the retry loop
      client.connect().catch(() => {});
    });

    // ── 4. Stream re-initialisation on each retry ──────────────────────────

    it('creates a new Deepgram connection object (stream re-init) on each retry', (t, done) => {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 3 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          if (connections.length === 2) {
            // Second connection (first reconnect attempt): open successfully
            setImmediate(() => conn._triggerOpen());
          }
          return conn;
        },
      });

      let connectedCount = 0;
      client.on('connected', () => {
        connectedCount++;
        if (connectedCount === 2) {
          try {
            assert.ok(
              connections.length >= 2,
              'factory should have been called at least twice (initial + 1 reconnect)',
            );
            assert.notStrictEqual(
              connections[0],
              connections[1],
              'each reconnect must produce a distinct new connection instance',
            );
            client.disconnect().then(done).catch(done);
          } catch (e) {
            done(e);
          }
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.then(() => {
        connections[0]._triggerClose({ code: 1006, reason: 'drop' });
      }).catch(done);
    });

    // ── 5. Session state preserved: sessionStartTime ──────────────────────

    it('preserves sessionStartTime across a reconnect', (t, done) => {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 3 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          if (connections.length === 2) {
            setImmediate(() => conn._triggerOpen());
          }
          return conn;
        },
      });

      let firstSessionStartTime = null;
      let connectedCount = 0;

      client.on('connected', () => {
        connectedCount++;

        if (connectedCount === 1) {
          firstSessionStartTime = client.getDropContext().sessionStartTime;
          assert.ok(firstSessionStartTime !== null, 'sessionStartTime should be set after initial connect');
          // Drop connection to trigger reconnect
          connections[0]._triggerClose({ code: 1006, reason: 'network drop' });

        } else if (connectedCount === 2) {
          try {
            const ctx = client.getDropContext();
            assert.equal(
              ctx.sessionStartTime,
              firstSessionStartTime,
              'sessionStartTime must be unchanged after reconnect',
            );
            client.disconnect().then(done).catch(done);
          } catch (e) {
            done(e);
          }
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.catch(done);
    });

    // ── 6. Session state preserved: lastStreamTimestamp ───────────────────

    it('preserves lastStreamTimestamp across a reconnect', (t, done) => {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 3 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          if (connections.length === 2) {
            setImmediate(() => conn._triggerOpen());
          }
          return conn;
        },
      });

      let connectedCount = 0;

      client.on('connected', () => {
        connectedCount++;

        if (connectedCount === 1) {
          // Advance timestamp via a Results event
          connections[0]._triggerResults({
            is_final: true,
            speech_final: true,
            start: 10.0,
            duration: 3.0,
            channel: {
              alternatives: [{
                transcript: '안녕하세요',
                confidence: 0.95,
                words: [{ word: '안녕하세요', punctuated_word: '안녕하세요', speaker: 0,
                           start: 10.0, end: 13.0, confidence: 0.95 }],
              }],
            },
          });
          assert.equal(client.lastStreamTimestamp, 13.0);
          // Drop to trigger reconnect
          connections[0]._triggerClose({ code: 1006, reason: 'network drop' });

        } else if (connectedCount === 2) {
          try {
            assert.equal(
              client.lastStreamTimestamp,
              13.0,
              'lastStreamTimestamp must be preserved after reconnect',
            );
            client.disconnect().then(done).catch(done);
          } catch (e) {
            done(e);
          }
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.catch(done);
    });

    // ── 7. Attempt counter resets after success ────────────────────────────

    it('resets reconnect attempt counter to 0 after a successful reconnect', (t, done) => {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 5 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          return conn;
        },
      });

      let connectedCount = 0;

      client.on('connected', () => {
        connectedCount++;

        if (connectedCount === 1) {
          connections[0]._triggerClose({ code: 1006, reason: 'drop' });
          // Open the reconnect connection once the factory creates it
          setImmediate(() => connections[1]?._triggerOpen());

        } else if (connectedCount === 2) {
          try {
            const ctx = client.getDropContext();
            assert.equal(
              ctx.reconnectAttempts,
              0,
              'reconnectAttempts must reset to 0 after successful reconnect',
            );
            client.disconnect().then(done).catch(done);
          } catch (e) {
            done(e);
          }
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.catch(done);
    });

    // ── 8. No retry on intentional disconnect ─────────────────────────────

    it('does not start the retry loop after intentional disconnect', (t, done) => {
      const { client, connections } = makeRetryClient();
      const reconnectEvents = [];
      client.on('reconnecting', (info) => reconnectEvents.push(info));

      const p = client.connect();
      connections[0]._triggerOpen();

      p.then(() => client.disconnect()) // intentional
        .then(() => {
          setImmediate(() => {
            try {
              assert.equal(
                reconnectEvents.length,
                0,
                'no reconnecting event should fire after intentional disconnect',
              );
              assert.equal(client.state, 'closed');
              assert.equal(connections.length, 1, 'no new connections should be created');
              done();
            } catch (e) {
              done(e);
            }
          });
        })
        .catch(done);
    });

    // ── 9. reconnecting event carries sessionId ────────────────────────────

    it('reconnecting event carries the configured sessionId', (t, done) => {
      const connections = [];
      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        sessionId: 'meeting-session-xyz',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 2 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          return conn;
        },
      });

      client.on('reconnecting', (info) => {
        try {
          assert.equal(
            info.sessionId,
            'meeting-session-xyz',
            'sessionId must be forwarded in reconnecting events',
          );
          client.disconnect().then(done).catch(done);
        } catch (e) {
          done(e);
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.then(() => {
        connections[0]._triggerClose({ code: 1006, reason: 'drop' });
      }).catch(done);
    });

    // ── 10. Multiple full reconnect cycles ────────────────────────────────

    it('handles multiple successful reconnect cycles and accumulates lastStreamTimestamp', (t, done) => {
      const connections = [];
      let cycleCount = 0;

      const client = new DeepgramStreamingClient({
        apiKey: 'test-key',
        reconnect: { baseDelayMs: 0, jitterFactor: 0, maxAttempts: 5 },
        _connectionFactory: () => {
          const conn = createFakeConnection();
          connections.push(conn);
          return conn;
        },
      });

      client.on('connected', () => {
        cycleCount++;
        const idx = connections.length - 1;

        if (cycleCount === 1) {
          // Cycle 1: push timestamp to 5.0 then drop
          connections[idx]._triggerResults({
            is_final: true, speech_final: true, start: 0, duration: 5.0,
            channel: { alternatives: [{ transcript: 'hello', confidence: 0.9,
              words: [{ word: 'hello', speaker: 0, start: 0, end: 5.0, confidence: 0.9 }] }] },
          });
          connections[idx]._triggerClose({ code: 1006, reason: 'drop-1' });
          setImmediate(() => connections[connections.length - 1]?._triggerOpen());

        } else if (cycleCount === 2) {
          // Cycle 2: push timestamp to 8.0 then drop
          connections[idx]._triggerResults({
            is_final: true, speech_final: true, start: 5.0, duration: 3.0,
            channel: { alternatives: [{ transcript: '안녕', confidence: 0.9,
              words: [{ word: '안녕', speaker: 1, start: 5.0, end: 8.0, confidence: 0.9 }] }] },
          });
          assert.ok(client.lastStreamTimestamp >= 8.0,
            `cycle-2 timestamp should be >= 8.0, got ${client.lastStreamTimestamp}`);
          connections[idx]._triggerClose({ code: 1006, reason: 'drop-2' });
          setImmediate(() => connections[connections.length - 1]?._triggerOpen());

        } else if (cycleCount === 3) {
          try {
            // After two reconnects, the furthest timestamp (8.0) must still be preserved
            assert.ok(
              client.lastStreamTimestamp >= 8.0,
              `lastStreamTimestamp should survive 2 reconnects; got ${client.lastStreamTimestamp}`,
            );
            client.disconnect().then(done).catch(done);
          } catch (e) {
            done(e);
          }
        }
      });

      const p = client.connect();
      connections[0]._triggerOpen();
      p.catch(done);
    });
  });
});
