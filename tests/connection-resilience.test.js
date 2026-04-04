/**
 * Tests for DeepgramConnectionResilience
 *
 * Validates auto-reconnect behavior, audio buffering, user notifications,
 * and state transitions during Deepgram connection failures.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DeepgramConnectionResilience,
  ConnectionState,
  NOTIFICATION_DEFAULTS,
} from '../src/stt/connection-resilience.js';

// ── Fake DeepgramStreamingClient ──

function createFakeClient() {
  const client = new EventEmitter();
  client.send = (data) => {
    client._sentPackets = (client._sentPackets || 0) + 1;
    return true;
  };
  client.isConnected = false;
  client.state = 'idle';
  client._sentPackets = 0;
  return client;
}

describe('DeepgramConnectionResilience', () => {
  let client;
  let resilience;

  beforeEach(() => {
    client = createFakeClient();
    resilience = new DeepgramConnectionResilience(client, {
      debounceMs: 0, // disable debounce for testing
      maxBufferedPackets: 10,
    });
  });

  describe('constructor', () => {
    it('should throw if no client provided', () => {
      assert.throws(
        () => new DeepgramConnectionResilience(null),
        { message: 'DeepgramStreamingClient is required for ConnectionResilience' }
      );
    });

    it('should initialize in disconnected state', () => {
      assert.equal(resilience.state, ConnectionState.DISCONNECTED);
      assert.equal(resilience.isHealthy, false);
      assert.equal(resilience.hasFailed, false);
      assert.equal(resilience.shouldBuffer, false);
    });

    it('should merge config with defaults', () => {
      const r = new DeepgramConnectionResilience(client, { verboseReconnect: true });
      // Default values still available via behavior testing below
      assert.equal(r.bufferedPacketCount, 0);
    });
  });

  describe('state transitions', () => {
    it('should transition to HEALTHY on connected event', () => {
      const changes = [];
      resilience.on('state_change', (e) => changes.push(e));

      client.emit('connected');

      assert.equal(resilience.state, ConnectionState.HEALTHY);
      assert.equal(resilience.isHealthy, true);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].previous, ConnectionState.DISCONNECTED);
      assert.equal(changes[0].current, ConnectionState.HEALTHY);
    });

    it('should transition to DEGRADED on first reconnecting event', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      assert.equal(resilience.state, ConnectionState.DEGRADED);
      assert.equal(resilience.shouldBuffer, true);
      assert.equal(resilience.isHealthy, false);
    });

    it('should remain DEGRADED on subsequent reconnecting events', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      client.emit('reconnecting', { attempt: 2, maxAttempts: 10, delayMs: 2000 });

      assert.equal(resilience.state, ConnectionState.DEGRADED);
    });

    it('should transition DEGRADED -> HEALTHY on successful reconnect', () => {
      const changes = [];
      resilience.on('state_change', (e) => changes.push(e));

      client.emit('connected'); // initial
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      client.emit('connected'); // reconnected

      assert.equal(resilience.state, ConnectionState.HEALTHY);
      assert.equal(resilience.reconnectSuccessCount, 1);
    });

    it('should transition to FAILED on terminal error', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 3, delayMs: 1000 });
      client.emit('error', new Error('Deepgram reconnection failed after 3 attempts'));

      assert.equal(resilience.state, ConnectionState.FAILED);
      assert.equal(resilience.hasFailed, true);
      assert.equal(resilience.isHealthy, false);
    });

    it('should not double-transition same state', () => {
      const changes = [];
      resilience.on('state_change', (e) => changes.push(e));

      client.emit('connected');
      client.emit('connected'); // duplicate

      assert.equal(changes.length, 1);
    });
  });

  describe('audio buffering', () => {
    it('should not buffer when healthy', () => {
      client.emit('connected');
      const result = resilience.bufferAudio(Buffer.from('test'));
      assert.equal(result, false);
      assert.equal(resilience.bufferedPacketCount, 0);
    });

    it('should buffer when degraded', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      const result = resilience.bufferAudio(Buffer.from('audio-1'));
      assert.equal(result, true);
      assert.equal(resilience.bufferedPacketCount, 1);
    });

    it('should drop oldest packets when buffer is full', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      // Fill buffer (max 10)
      for (let i = 0; i < 10; i++) {
        resilience.bufferAudio(Buffer.from(`packet-${i}`));
      }
      assert.equal(resilience.bufferedPacketCount, 10);

      // One more should drop oldest
      const result = resilience.bufferAudio(Buffer.from('packet-overflow'));
      assert.equal(result, false);
      assert.equal(resilience.droppedPackets, 1);
      // Buffer still at max (dropped 1, added 1)
      assert.equal(resilience.bufferedPacketCount, 10);
    });

    it('should emit buffer_overflow on periodic drops', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      const overflowEvents = [];
      resilience.on('buffer_overflow', (e) => overflowEvents.push(e));

      // Fill buffer
      for (let i = 0; i < 10; i++) {
        resilience.bufferAudio(Buffer.from(`packet-${i}`));
      }

      // First overflow triggers event (droppedPackets % 100 === 1)
      resilience.bufferAudio(Buffer.from('overflow-1'));
      assert.equal(overflowEvents.length, 1);
      assert.equal(overflowEvents[0].dropped, 1);
    });

    it('should not buffer when in FAILED state', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 3, delayMs: 1000 });
      client.emit('error', new Error('Deepgram reconnection failed after 3 attempts'));

      const result = resilience.bufferAudio(Buffer.from('too-late'));
      assert.equal(result, false);
    });
  });

  describe('buffer replay', () => {
    it('should replay buffered packets on reconnect', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      // Buffer some audio
      resilience.bufferAudio(Buffer.from('audio-1'));
      resilience.bufferAudio(Buffer.from('audio-2'));
      resilience.bufferAudio(Buffer.from('audio-3'));
      assert.equal(resilience.bufferedPacketCount, 3);

      // Reconnect triggers replay
      client.emit('connected');

      assert.equal(resilience.bufferedPacketCount, 0);
      assert.equal(client._sentPackets, 3);
    });

    it('should emit buffer_replayed event', () => {
      const replayed = [];
      resilience.on('buffer_replayed', (e) => replayed.push(e));

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      resilience.bufferAudio(Buffer.from('audio-1'));
      resilience.bufferAudio(Buffer.from('audio-2'));

      client.emit('connected');

      assert.equal(replayed.length, 1);
      assert.equal(replayed[0].count, 2);
    });

    it('should handle replayBufferOnReconnect=false by clearing buffer', () => {
      const r = new DeepgramConnectionResilience(client, {
        debounceMs: 0,
        maxBufferedPackets: 10,
        replayBufferOnReconnect: false,
      });

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      r.bufferAudio(Buffer.from('audio-1'));
      assert.equal(r.bufferedPacketCount, 1);

      client.emit('connected');

      // Buffer cleared but not replayed
      assert.equal(r.bufferedPacketCount, 0);
      assert.equal(client._sentPackets, 0);
    });
  });

  describe('notifications', () => {
    it('should send warning notification on first disconnect', () => {
      const notifications = [];
      resilience.on('notification', (n) => notifications.push(n));

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0].level, 'warning');
      assert.ok(notifications[0].title.includes('Connection Lost'));
      assert.ok(notifications[0].body.includes('1/10'));
    });

    it('should send info notification on successful reconnect', () => {
      const notifications = [];
      resilience.on('notification', (n) => notifications.push(n));

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      client.emit('connected'); // reconnected

      // Should have warning + info
      assert.equal(notifications.length, 2);
      assert.equal(notifications[1].level, 'info');
      assert.ok(notifications[1].title.includes('Reconnected'));
    });

    it('should send error notification on final failure', () => {
      const notifications = [];
      resilience.on('notification', (n) => notifications.push(n));

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 3, delayMs: 1000 });
      client.emit('error', new Error('Deepgram reconnection failed after 3 attempts'));

      const errorNotifs = notifications.filter((n) => n.level === 'error');
      assert.equal(errorNotifs.length, 1);
      assert.ok(errorNotifs[0].title.includes('Failed'));
      assert.ok(errorNotifs[0].body.includes('Transcription has stopped'));
      assert.ok(errorNotifs[0].body.includes('/stop'));
    });

    it('should emit fallback_save_needed on final failure', () => {
      let fallbackNeeded = false;
      resilience.on('fallback_save_needed', () => { fallbackNeeded = true; });

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 3, delayMs: 1000 });
      client.emit('error', new Error('Deepgram reconnection failed after 3 attempts'));

      assert.equal(fallbackNeeded, true);
    });

    it('should debounce non-error notifications', () => {
      const r = new DeepgramConnectionResilience(client, {
        debounceMs: 60000, // 60s debounce
        verboseReconnect: true,
      });

      const notifications = [];
      r.on('notification', (n) => notifications.push(n));

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      // First notification goes through
      client.emit('reconnecting', { attempt: 2, maxAttempts: 10, delayMs: 2000 });
      // Second should be debounced (within 60s)

      assert.equal(notifications.length, 1); // only first warning
    });

    it('should always send error notifications regardless of debounce', () => {
      const r = new DeepgramConnectionResilience(client, {
        debounceMs: 60000,
      });

      const notifications = [];
      r.on('notification', (n) => notifications.push(n));

      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 3, delayMs: 1000 });
      // Warning notification sent (first one)
      client.emit('error', new Error('Deepgram reconnection failed after 3 attempts'));
      // Error should go through despite debounce

      const errorNotifs = notifications.filter((n) => n.level === 'error');
      assert.equal(errorNotifs.length, 1);
    });

    it('should notify at milestone reconnect attempts (non-verbose)', () => {
      const notifications = [];
      resilience.on('notification', (n) => notifications.push(n));

      client.emit('connected');

      // Simulate 10 reconnect attempts
      for (let i = 1; i <= 10; i++) {
        client.emit('reconnecting', { attempt: i, maxAttempts: 10, delayMs: 1000 * i });
      }

      // Should get: first (1), halfway (5), near-end (8, 9, 10)
      // First always triggers, rest depend on milestone logic
      assert.ok(notifications.length >= 2); // at minimum: first + some milestones
    });
  });

  describe('getMetrics', () => {
    it('should return current metrics snapshot', () => {
      const metrics = resilience.getMetrics();

      assert.equal(metrics.state, ConnectionState.DISCONNECTED);
      assert.equal(metrics.bufferedPackets, 0);
      assert.equal(metrics.droppedPackets, 0);
      assert.equal(metrics.reconnectSuccessCount, 0);
      assert.equal(metrics.reconnectInfo, null);
      assert.ok(metrics.uptimeMs >= 0);
    });

    it('should reflect reconnect info during degraded state', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 2, maxAttempts: 5, delayMs: 2000 });

      const metrics = resilience.getMetrics();
      assert.equal(metrics.state, ConnectionState.DEGRADED);
      assert.ok(metrics.reconnectInfo !== null);
      assert.equal(metrics.reconnectInfo.attempt, 2);
      assert.equal(metrics.reconnectInfo.maxAttempts, 5);
    });
  });

  describe('destroy', () => {
    it('should clean up state', () => {
      client.emit('connected');
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      resilience.bufferAudio(Buffer.from('test'));

      resilience.destroy();

      assert.equal(resilience.bufferedPacketCount, 0);
      assert.equal(resilience.droppedPackets, 0);
    });

    it('should remove all listeners', () => {
      resilience.on('notification', () => {});
      resilience.on('state_change', () => {});

      resilience.destroy();

      assert.equal(resilience.listenerCount('notification'), 0);
      assert.equal(resilience.listenerCount('state_change'), 0);
    });
  });

  describe('multiple reconnect cycles', () => {
    it('should track multiple successful reconnections', () => {
      client.emit('connected');

      // First disconnect/reconnect cycle
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      client.emit('connected');
      assert.equal(resilience.reconnectSuccessCount, 1);

      // Second disconnect/reconnect cycle
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      client.emit('connected');
      assert.equal(resilience.reconnectSuccessCount, 2);

      assert.equal(resilience.state, ConnectionState.HEALTHY);
    });

    it('should buffer and replay across multiple cycles', () => {
      client.emit('connected');

      // First cycle
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      resilience.bufferAudio(Buffer.from('cycle-1'));
      client.emit('connected');
      assert.equal(client._sentPackets, 1); // replayed

      // Second cycle
      client.emit('reconnecting', { attempt: 1, maxAttempts: 10, delayMs: 1000 });
      resilience.bufferAudio(Buffer.from('cycle-2-a'));
      resilience.bufferAudio(Buffer.from('cycle-2-b'));
      client.emit('connected');
      assert.equal(client._sentPackets, 3); // 1 + 2
    });
  });

  describe('NOTIFICATION_DEFAULTS', () => {
    it('should have sensible defaults', () => {
      assert.equal(NOTIFICATION_DEFAULTS.debounceMs, 5000);
      assert.equal(NOTIFICATION_DEFAULTS.verboseReconnect, false);
      assert.equal(NOTIFICATION_DEFAULTS.maxBufferedPackets, 500);
      assert.equal(NOTIFICATION_DEFAULTS.replayBufferOnReconnect, true);
    });
  });

  describe('ConnectionState', () => {
    it('should expose all states', () => {
      assert.equal(ConnectionState.HEALTHY, 'healthy');
      assert.equal(ConnectionState.DEGRADED, 'degraded');
      assert.equal(ConnectionState.FAILED, 'failed');
      assert.equal(ConnectionState.DISCONNECTED, 'disconnected');
    });
  });
});
