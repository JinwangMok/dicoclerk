/**
 * Deepgram Connection Resilience Manager
 *
 * Wraps the DeepgramStreamingClient to provide:
 * - Audio packet buffering during reconnection attempts
 * - Discord text channel notifications on connection status changes
 * - Fallback transcript save on permanent connection loss
 * - Configurable reconnection behavior with exponential backoff
 * - Debounced user notifications to avoid message spam
 *
 * This module is consumed by AudioSessionCoordinator to bridge
 * Deepgram connection events with Discord user-facing feedback.
 */

import { EventEmitter } from 'node:events';

/** Default notification config */
const NOTIFICATION_DEFAULTS = {
  /** Minimum interval (ms) between status notifications to avoid spam */
  debounceMs: 5000,
  /** Whether to notify on each reconnect attempt or only on key events */
  verboseReconnect: false,
  /** Maximum buffered audio packets during reconnection */
  maxBufferedPackets: 500,
  /** Whether to replay buffered audio after successful reconnect */
  replayBufferOnReconnect: true,
};

/**
 * Connection state for tracking resilience lifecycle.
 * @enum {string}
 */
const ConnectionState = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',     // reconnecting — audio is being buffered
  FAILED: 'failed',         // all reconnect attempts exhausted
  DISCONNECTED: 'disconnected',
};

/**
 * @typedef {Object} NotificationMessage
 * @property {'info'|'warning'|'error'} level
 * @property {string} title
 * @property {string} body
 * @property {number} timestamp
 */

/**
 * Events emitted:
 * - 'notification'          : NotificationMessage — send this to Discord text channel
 * - 'state_change'          : { previous, current } — connection state transition
 * - 'buffer_overflow'       : { dropped, buffered } — buffer is full, packets dropped
 * - 'buffer_replayed'       : { count } — buffered packets replayed after reconnect
 * - 'fallback_save_needed'  : void — permanent failure, caller should save transcript
 */
export class DeepgramConnectionResilience extends EventEmitter {
  /** @type {import('./deepgram-client.js').DeepgramStreamingClient} */
  #client;

  /** @type {typeof NOTIFICATION_DEFAULTS} */
  #config;

  /** @type {ConnectionState} */
  #state = ConnectionState.DISCONNECTED;

  /** @type {Buffer[]} audio packets buffered during reconnection */
  #audioBuffer = [];

  /** @type {number} total packets dropped due to buffer overflow */
  #droppedPackets = 0;

  /** @type {number} timestamp of last notification sent */
  #lastNotificationAt = 0;

  /** @type {{ attempt: number, maxAttempts: number, startedAt: number }|null} */
  #reconnectInfo = null;

  /** @type {number} total successful reconnections in this session */
  #reconnectSuccessCount = 0;

  /** @type {number} session start timestamp */
  #sessionStartedAt = 0;

  /**
   * @param {import('./deepgram-client.js').DeepgramStreamingClient} deepgramClient
   * @param {Partial<typeof NOTIFICATION_DEFAULTS>} [config]
   */
  constructor(deepgramClient, config = {}) {
    super();

    if (!deepgramClient) {
      throw new Error('DeepgramStreamingClient is required for ConnectionResilience');
    }

    this.#client = deepgramClient;
    this.#config = { ...NOTIFICATION_DEFAULTS, ...config };
    this.#sessionStartedAt = Date.now();

    this.#wireClientEvents();
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /** Current resilience state */
  get state() {
    return this.#state;
  }

  /** Whether audio should be buffered (during reconnection) */
  get shouldBuffer() {
    return this.#state === ConnectionState.DEGRADED;
  }

  /** Whether the connection is healthy and audio can be sent directly */
  get isHealthy() {
    return this.#state === ConnectionState.HEALTHY;
  }

  /** Whether the connection has permanently failed */
  get hasFailed() {
    return this.#state === ConnectionState.FAILED;
  }

  /** Number of audio packets currently buffered */
  get bufferedPacketCount() {
    return this.#audioBuffer.length;
  }

  /** Number of successful reconnections in this session */
  get reconnectSuccessCount() {
    return this.#reconnectSuccessCount;
  }

  /** Total packets dropped due to buffer overflow */
  get droppedPackets() {
    return this.#droppedPackets;
  }

  /**
   * Buffer an audio packet during reconnection.
   * If the buffer is full, the oldest packets are dropped.
   *
   * @param {Buffer} audioData - Opus audio packet
   * @returns {boolean} true if buffered, false if dropped or not in buffer mode
   */
  bufferAudio(audioData) {
    if (this.#state !== ConnectionState.DEGRADED) {
      return false;
    }

    if (this.#audioBuffer.length >= this.#config.maxBufferedPackets) {
      // Drop oldest packet to make room for the new one
      this.#audioBuffer.shift();
      this.#droppedPackets++;

      // Notify periodically about buffer overflow
      if (this.#droppedPackets % 100 === 1) {
        this.emit('buffer_overflow', {
          dropped: this.#droppedPackets,
          buffered: this.#audioBuffer.length,
        });
      }

      // Still add the new packet (we made room)
      this.#audioBuffer.push(audioData);
      return false; // false indicates a drop occurred
    }

    this.#audioBuffer.push(audioData);
    return true;
  }

  /**
   * Replay buffered audio packets to the Deepgram client after reconnection.
   * @returns {number} number of packets replayed
   */
  replayBuffer() {
    if (!this.#config.replayBufferOnReconnect) {
      this.#audioBuffer = [];
      return 0;
    }

    const packets = this.#audioBuffer.splice(0);
    let replayed = 0;

    for (const packet of packets) {
      const sent = this.#client.send(packet);
      if (sent) {
        replayed++;
      }
    }

    if (replayed > 0) {
      this.emit('buffer_replayed', { count: replayed });
      console.log(`[ConnectionResilience] Replayed ${replayed}/${packets.length} buffered packets`);
    }

    return replayed;
  }

  /**
   * Get a snapshot of current resilience metrics.
   * @returns {Object}
   */
  getMetrics() {
    return {
      state: this.#state,
      bufferedPackets: this.#audioBuffer.length,
      droppedPackets: this.#droppedPackets,
      reconnectSuccessCount: this.#reconnectSuccessCount,
      reconnectInfo: this.#reconnectInfo ? { ...this.#reconnectInfo } : null,
      uptimeMs: Date.now() - this.#sessionStartedAt,
    };
  }

  /**
   * Clean up listeners and state.
   */
  destroy() {
    this.#audioBuffer = [];
    this.#droppedPackets = 0;
    this.#reconnectInfo = null;
    this.removeAllListeners();
  }

  // ──────────────────────────────────────────────
  // Private: Event wiring
  // ──────────────────────────────────────────────

  /**
   * Wire up event listeners on the DeepgramStreamingClient.
   */
  #wireClientEvents() {
    this.#client.on('connected', () => this.#handleConnected());
    this.#client.on('disconnected', (info) => this.#handleDisconnected(info));
    this.#client.on('reconnecting', (info) => this.#handleReconnecting(info));
    this.#client.on('error', (err) => this.#handleError(err));
  }

  // ──────────────────────────────────────────────
  // Private: Event handlers
  // ──────────────────────────────────────────────

  /**
   * Handle successful (re)connection to Deepgram.
   */
  #handleConnected() {
    const previous = this.#state;
    this.#setState(ConnectionState.HEALTHY);

    if (previous === ConnectionState.DEGRADED) {
      // Successful reconnection!
      this.#reconnectSuccessCount++;

      const duration = this.#reconnectInfo
        ? Math.round((Date.now() - this.#reconnectInfo.startedAt) / 1000)
        : 0;

      this.#sendNotification({
        level: 'info',
        title: ':white_check_mark: Deepgram Reconnected',
        body: `Transcription service restored after ${duration}s. ` +
              `${this.#audioBuffer.length} buffered packets will be replayed.`,
      });

      // Replay buffered audio
      this.replayBuffer();

      this.#reconnectInfo = null;

    } else if (previous === ConnectionState.DISCONNECTED) {
      // Initial connection
      console.log('[ConnectionResilience] Initial Deepgram connection established');
    }
  }

  /**
   * Handle Deepgram WebSocket disconnection.
   * @param {{ code?: number, reason?: string }} info
   */
  #handleDisconnected(info) {
    console.log(
      `[ConnectionResilience] Deepgram disconnected: code=${info?.code} reason=${info?.reason}`
    );

    // State transition is handled by #handleReconnecting if auto-reconnect kicks in.
    // If intentionally closed, state will be set to DISCONNECTED by the caller.
  }

  /**
   * Handle reconnection attempt notification from DeepgramStreamingClient.
   * @param {{ attempt: number, maxAttempts: number, delayMs: number }} info
   */
  #handleReconnecting(info) {
    const previous = this.#state;

    if (previous !== ConnectionState.DEGRADED) {
      // First reconnect attempt — start tracking
      this.#reconnectInfo = {
        attempt: info.attempt,
        maxAttempts: info.maxAttempts,
        startedAt: Date.now(),
      };
      this.#setState(ConnectionState.DEGRADED);

      // Always notify on first disconnect
      this.#sendNotification({
        level: 'warning',
        title: ':warning: Deepgram Connection Lost',
        body: `Transcription service disconnected. Attempting to reconnect ` +
              `(${info.attempt}/${info.maxAttempts})... Audio is being buffered.`,
      });
    } else {
      // Subsequent attempts
      this.#reconnectInfo.attempt = info.attempt;

      if (this.#config.verboseReconnect) {
        this.#sendNotification({
          level: 'warning',
          title: ':arrows_counterclockwise: Reconnecting to Deepgram',
          body: `Attempt ${info.attempt}/${info.maxAttempts} — next retry in ${Math.round(info.delayMs / 1000)}s`,
        });
      } else {
        // Non-verbose: only notify on milestone attempts (halfway, last few)
        const halfway = Math.floor(info.maxAttempts / 2);
        const nearEnd = info.maxAttempts - 2;
        if (info.attempt === halfway || info.attempt >= nearEnd) {
          this.#sendNotification({
            level: 'warning',
            title: ':arrows_counterclockwise: Still Reconnecting',
            body: `Attempt ${info.attempt}/${info.maxAttempts} — ` +
                  `transcription will resume once connected. ` +
                  `${this.#audioBuffer.length} packets buffered.`,
          });
        }
      }
    }

    console.log(
      `[ConnectionResilience] Reconnect attempt ${info.attempt}/${info.maxAttempts} ` +
      `(delay=${info.delayMs}ms, buffered=${this.#audioBuffer.length})`
    );
  }

  /**
   * Handle errors from the Deepgram client.
   * Detects terminal reconnection failure and triggers final notification.
   * @param {Error} err
   */
  #handleError(err) {
    const message = err?.message || String(err);

    if (message.includes('reconnection failed after')) {
      // Terminal failure — all reconnect attempts exhausted
      this.#setState(ConnectionState.FAILED);

      const totalBuffered = this.#audioBuffer.length;
      const totalDropped = this.#droppedPackets;

      this.#sendNotification({
        level: 'error',
        title: ':x: Deepgram Connection Failed',
        body: `Unable to reconnect to transcription service after all attempts. ` +
              `**Transcription has stopped.** ` +
              `${totalBuffered} audio packets were buffered and ${totalDropped} were dropped. ` +
              `The transcript recorded so far has been saved as a fallback. ` +
              `Use \`/stop\` to end the session and generate minutes from the available transcript.`,
      });

      // Signal to coordinator that fallback save is needed
      this.emit('fallback_save_needed');

      // Clear the buffer — no point keeping it
      this.#audioBuffer = [];

      console.error(
        `[ConnectionResilience] PERMANENT FAILURE: Deepgram connection lost. ` +
        `Buffered=${totalBuffered}, Dropped=${totalDropped}, Reconnects=${this.#reconnectSuccessCount}`
      );
    }
  }

  // ──────────────────────────────────────────────
  // Private: Helpers
  // ──────────────────────────────────────────────

  /**
   * Transition to a new state and emit event.
   * @param {ConnectionState} newState
   */
  #setState(newState) {
    if (newState === this.#state) return;

    const previous = this.#state;
    this.#state = newState;

    this.emit('state_change', { previous, current: newState });

    console.log(`[ConnectionResilience] State: ${previous} -> ${newState}`);
  }

  /**
   * Send a notification (debounced to avoid spam).
   * Emits 'notification' event with a structured message for Discord delivery.
   *
   * @param {Omit<NotificationMessage, 'timestamp'>} msg
   */
  #sendNotification(msg) {
    const now = Date.now();

    // Always allow error-level notifications through
    if (msg.level !== 'error' && (now - this.#lastNotificationAt) < this.#config.debounceMs) {
      return;
    }

    this.#lastNotificationAt = now;

    /** @type {NotificationMessage} */
    const notification = {
      ...msg,
      timestamp: now,
    };

    this.emit('notification', notification);
  }
}

export { NOTIFICATION_DEFAULTS, ConnectionState };
