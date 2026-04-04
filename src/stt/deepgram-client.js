/**
 * Deepgram Streaming Client Service
 *
 * Manages a persistent WebSocket connection to Deepgram's live transcription API
 * with speaker diarization enabled. Handles connection lifecycle (open, reconnect,
 * close) and emits transcription events.
 */

import { EventEmitter } from 'node:events';
import { createClient } from '@deepgram/sdk';
import { UtteranceDeduplicator } from './dedup.js';

/** Default Deepgram live transcription options */
const DEFAULT_LIVE_OPTIONS = {
  model: 'nova-2',
  language: 'ko',           // Primary: Korean
  detect_language: true,     // Auto-detect Korean/English
  smart_format: true,
  punctuate: true,
  diarize: true,             // Speaker diarization
  interim_results: true,
  utterance_end_ms: 1500,
  vad_events: true,
  encoding: 'opus',
  sample_rate: 48000,        // Discord voice channel default
  channels: 1,
};

/** Reconnection configuration */
const RECONNECT_DEFAULTS = {
  maxAttempts: 10,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * @typedef {Object} TranscriptEvent
 * @property {string} text - Transcribed text
 * @property {number} speaker - Speaker ID from diarization
 * @property {boolean} isFinal - Whether this is a final transcript
 * @property {number} confidence - Confidence score (0-1)
 * @property {number} start - Start time in seconds
 * @property {number} end - End time in seconds
 * @property {string} channel - Audio channel identifier
 */

/**
 * Events emitted:
 * - 'transcript'       : TranscriptEvent - a transcription result (interim or final)
 * - 'utterance_end'    : void - speaker finished an utterance
 * - 'connected'        : void - WebSocket connected
 * - 'disconnected'     : { code, reason } - WebSocket closed
 * - 'reconnecting'     : { attempt, maxAttempts, delayMs } - attempting reconnect
 * - 'error'            : Error - connection or processing error
 * - 'warning'          : string - non-fatal issue
 */
export class DeepgramStreamingClient extends EventEmitter {
  #deepgramClient;
  #connection;
  #liveOptions;
  #reconnectConfig;
  #reconnectAttempts;
  #reconnectTimer;
  #state; // 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
  #keepAliveInterval;
  #intentionallyClosed;
  #deduplicator;
  #sessionStartTime;

  /**
   * @param {Object} options
   * @param {string} options.apiKey - Deepgram API key
   * @param {Object} [options.liveOptions] - Override default live transcription options
   * @param {Object} [options.reconnect] - Override reconnection config
   * @param {Object} [options.dedup] - Override deduplication config
   */
  constructor({ apiKey, liveOptions = {}, reconnect = {}, dedup = {} } = {}) {
    super();

    if (!apiKey) {
      throw new Error('Deepgram API key is required');
    }

    this.#deepgramClient = createClient(apiKey);
    this.#liveOptions = { ...DEFAULT_LIVE_OPTIONS, ...liveOptions };
    this.#reconnectConfig = { ...RECONNECT_DEFAULTS, ...reconnect };
    this.#reconnectAttempts = 0;
    this.#reconnectTimer = null;
    this.#state = 'idle';
    this.#connection = null;
    this.#keepAliveInterval = null;
    this.#intentionallyClosed = false;
    this.#deduplicator = new UtteranceDeduplicator(dedup);
    this.#sessionStartTime = null;
  }

  /** Current connection state */
  get state() {
    return this.#state;
  }

  /** Whether the client is actively connected */
  get isConnected() {
    return this.#state === 'connected';
  }

  /**
   * Open a new live transcription connection to Deepgram.
   * Resolves once the WebSocket is open, rejects on initial connection failure.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') {
      this.emit('warning', `connect() called while already ${this.#state}`);
      return;
    }

    this.#intentionallyClosed = false;
    this.#state = 'connecting';

    return this.#establishConnection();
  }

  /**
   * Internal: create the WebSocket and wire event handlers.
   * @returns {Promise<void>}
   */
  #establishConnection() {
    return new Promise((resolve, reject) => {
      try {
        const connection = this.#deepgramClient.listen.live(this.#liveOptions);

        connection.on('open', () => {
          this.#state = 'connected';
          this.#reconnectAttempts = 0;
          this.#connection = connection;
          if (!this.#sessionStartTime) {
            this.#sessionStartTime = Date.now();
            this.#deduplicator.reset();
          }
          this.#startKeepAlive();
          this.emit('connected');
          resolve();
        });

        connection.on('Results', (data) => {
          this.#handleTranscriptResult(data);
        });

        connection.on('UtteranceEnd', () => {
          this.emit('utterance_end');
        });

        connection.on('Metadata', (metadata) => {
          // Metadata events can be logged if needed
        });

        connection.on('SpeechStarted', () => {
          // VAD detected speech start
        });

        connection.on('error', (err) => {
          this.emit('error', err);
          // If we never connected, reject the promise
          if (this.#state === 'connecting') {
            this.#state = 'idle';
            reject(err);
          }
        });

        connection.on('close', (event) => {
          this.#stopKeepAlive();
          const prevState = this.#state;
          this.#state = 'disconnected';
          this.#connection = null;

          this.emit('disconnected', {
            code: event?.code,
            reason: event?.reason ?? 'unknown',
          });

          // Auto-reconnect unless intentionally closed
          if (!this.#intentionallyClosed && prevState === 'connected') {
            this.#scheduleReconnect();
          }
        });
      } catch (err) {
        this.#state = 'idle';
        reject(err);
      }
    });
  }

  /**
   * Parse, deduplicate, and emit transcript events from Deepgram results.
   * Duplicates are suppressed before they reach any listener / transcript store.
   * @param {Object} data - Raw Deepgram result payload
   */
  #handleTranscriptResult(data) {
    const channel = data.channel;
    if (!channel?.alternatives?.length) return;

    const alternative = channel.alternatives[0];
    const transcript = alternative.transcript;
    if (!transcript) return;

    const isFinal = data.is_final ?? false;
    const speechFinal = data.speech_final ?? false;

    // Extract speaker from word-level diarization
    const words = alternative.words ?? [];
    const speaker = words.length > 0 ? (words[0].speaker ?? -1) : -1;

    // Compute timestamp relative to session start
    const sessionElapsed = this.#sessionStartTime
      ? (Date.now() - this.#sessionStartTime) / 1000
      : (data.start ?? 0);

    // --- Deduplication gate ---
    const dedupResult = this.#deduplicator.check({
      speaker,
      text: transcript,
      timestamp: sessionElapsed,
      isFinal,
    });

    if (dedupResult.isDuplicate) {
      // Emit a lightweight event for observability / debugging
      this.emit('transcript_duplicate', {
        text: transcript,
        speaker,
        reason: dedupResult.reason,
        similarityScore: dedupResult.similarityScore,
      });
      return; // suppress — do not propagate to transcript store
    }

    /** @type {TranscriptEvent} */
    const event = {
      text: transcript,
      speaker,
      isFinal,
      speechFinal,
      confidence: alternative.confidence ?? 0,
      start: data.start ?? 0,
      end: data.start + (data.duration ?? 0),
      words,
    };

    this.emit('transcript', event);
  }

  /**
   * Send audio data to Deepgram.
   * @param {Buffer|Uint8Array} audioData - Raw audio bytes
   */
  send(audioData) {
    if (this.#state !== 'connected' || !this.#connection) {
      // Silently drop audio when not connected — callers should check isConnected
      return false;
    }

    try {
      this.#connection.send(audioData);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  /**
   * Send a keep-alive message to prevent Deepgram from closing the connection.
   */
  #startKeepAlive() {
    this.#stopKeepAlive();
    // Send keep-alive every 8 seconds (Deepgram timeout is ~12s of silence)
    this.#keepAliveInterval = setInterval(() => {
      if (this.#connection) {
        try {
          this.#connection.keepAlive();
        } catch {
          // Ignore keep-alive errors; close event will trigger reconnect
        }
      }
    }, 8000);
  }

  #stopKeepAlive() {
    if (this.#keepAliveInterval) {
      clearInterval(this.#keepAliveInterval);
      this.#keepAliveInterval = null;
    }
  }

  /**
   * Schedule an automatic reconnection with exponential backoff.
   */
  #scheduleReconnect() {
    if (this.#reconnectAttempts >= this.#reconnectConfig.maxAttempts) {
      this.emit('error', new Error(
        `Deepgram reconnection failed after ${this.#reconnectConfig.maxAttempts} attempts`
      ));
      this.#state = 'closed';
      return;
    }

    this.#state = 'reconnecting';
    this.#reconnectAttempts++;

    const delayMs = Math.min(
      this.#reconnectConfig.baseDelayMs *
        Math.pow(this.#reconnectConfig.backoffMultiplier, this.#reconnectAttempts - 1),
      this.#reconnectConfig.maxDelayMs,
    );

    this.emit('reconnecting', {
      attempt: this.#reconnectAttempts,
      maxAttempts: this.#reconnectConfig.maxAttempts,
      delayMs,
    });

    this.#reconnectTimer = setTimeout(async () => {
      try {
        await this.#establishConnection();
      } catch {
        // establishConnection rejected — schedule another attempt
        this.#scheduleReconnect();
      }
    }, delayMs);
  }

  /**
   * Gracefully close the connection.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.#intentionallyClosed = true;

    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }

    this.#stopKeepAlive();

    if (this.#connection) {
      try {
        this.#connection.requestClose();
      } catch {
        // Already closed
      }
      this.#connection = null;
    }

    this.#state = 'closed';
    this.#reconnectAttempts = 0;
    this.#deduplicator.reset();
    this.#sessionStartTime = null;
  }

  /**
   * Update live transcription options (takes effect on next connection).
   * @param {Object} options - Partial options to merge
   */
  updateOptions(options) {
    this.#liveOptions = { ...this.#liveOptions, ...options };
  }

  /**
   * Get a snapshot of current configuration.
   * @returns {{ liveOptions: Object, reconnect: Object, state: string }}
   */
  getConfig() {
    return {
      liveOptions: { ...this.#liveOptions },
      reconnect: { ...this.#reconnectConfig },
      state: this.#state,
    };
  }
}

export { DEFAULT_LIVE_OPTIONS, RECONNECT_DEFAULTS };
