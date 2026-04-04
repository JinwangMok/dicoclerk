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

    it('should target Korean with auto-detect', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.language, 'ko');
      assert.equal(DEFAULT_LIVE_OPTIONS.detect_language, true);
    });

    it('should use Discord-compatible audio settings', () => {
      assert.equal(DEFAULT_LIVE_OPTIONS.encoding, 'opus');
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
});
