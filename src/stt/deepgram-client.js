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
import { DIARIZATION_OPTIONS, groupWordsBySpeaker } from './diarization-config.js';

/**
 * Default Deepgram live transcription options.
 *
 * Audio format: mono linear16 PCM decoded from Discord's Opus stream.
 *   - Discord emits stereo Opus at 48 kHz; OpusDecoderPool decodes and
 *     downmixes to mono before packets reach here.
 *   - 'linear16' (signed 16-bit PCM, little-endian) is the format that
 *     Deepgram accepts most reliably for real-time streaming.
 *
 * Diarization settings are imported from diarization-config.js so that all
 * connections in the pool share identical speaker segmentation parameters.
 * See that module for detailed rationale on each diarization parameter.
 */
const DEFAULT_LIVE_OPTIONS = {
  // Diarization: model, language, diarize, diarize_max_speakers, endpointing,
  // utterance_end_ms, smart_format, punctuate, interim_results, vad_events
  ...DIARIZATION_OPTIONS,

  // Audio encoding: Discord voice → OpusDecoderPool → mono linear16 PCM
  encoding: 'linear16',  // Decoded mono PCM from OpusDecoderPool
  sample_rate: 48000,    // Discord voice channel sample rate
  channels: 1,           // Mono after stereo→mono downmix in decoder
};

/**
 * Reconnection configuration defaults.
 *
 * Delay formula (with jitter):
 *   rawDelay = min(baseDelayMs * backoffMultiplier^(attempt-1), maxDelayMs)
 *   jitter   = rawDelay * jitterFactor * random(-1, 1)
 *   delay    = max(0, rawDelay + jitter)
 *
 * Jitter spreads reconnection attempts across clients to prevent
 * thundering-herd reconnects when a server recovers.
 */
const RECONNECT_DEFAULTS = {
  /** Maximum number of reconnection attempts before giving up */
  maxAttempts: 10,
  /** Initial delay before the first retry (ms) */
  baseDelayMs: 1000,
  /** Maximum delay cap — backoff will not exceed this value (ms) */
  maxDelayMs: 30000,
  /** Multiplier applied to delay on each subsequent attempt */
  backoffMultiplier: 2,
  /**
   * Fraction of the calculated delay added as random jitter (0–1).
   * 0.2 means ±20 % of the computed delay is added randomly.
   * Set to 0 to disable jitter.
   */
  jitterFactor: 0.2,
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
 * - 'transcript'         : TranscriptEvent - a transcription result (interim or final)
 * - 'utterance_end'      : void - speaker finished an utterance
 * - 'connected'          : void - WebSocket connected
 * - 'disconnected'       : { code, reason, sessionId, unexpected } - WebSocket closed
 * - 'reconnecting'       : { attempt, maxAttempts, delayMs, sessionId } - attempting reconnect
 * - 'drop_detected'      : { code, reason, sessionId, sessionStartTime, lastStreamTimestamp,
 *                            reconnectAttempts } - unexpected drop with full context snapshot
 * - 'error'              : Error - connection or processing error
 * - 'warning'            : string - non-fatal issue
 */
export class DeepgramStreamingClient extends EventEmitter {
  #deepgramClient;
  #connection;
  #liveOptions;
  #reconnectConfig;
  #reconnectAttempts;
  #reconnectTimer;
  /** Whether #reconnectTimer is a setImmediate handle (true) or setTimeout handle (false) */
  #reconnectIsImmediate;
  /** @type {'idle'|'connecting'|'connected'|'disconnected'|'reconnecting'|'closed'} */
  #state;
  #keepAliveInterval;
  #intentionallyClosed;
  #deduplicator;
  #sessionStartTime;
  /**
   * Tracks the end-time of the last received Deepgram audio segment (seconds).
   * Preserved across reconnects so downstream consumers can compute stream
   * offsets for new segments after a reconnection gap.
   * @type {number}
   */
  #lastStreamTimestamp;
  /** @type {string|null} Externally-provided session identifier, included in reconnect events */
  #sessionId;
  /**
   * Optional callback invoked synchronously when an unexpected connection drop
   * is detected.  Receives the same context object emitted via 'drop_detected'.
   * @type {((context: Object) => void) | null}
   */
  #onDropDetected;

  /**
   * @param {Object} options
   * @param {string} options.apiKey - Deepgram API key
   * @param {string} [options.sessionId] - Session identifier passed through in reconnect events
   * @param {Object} [options.liveOptions] - Override default live transcription options
   * @param {Object} [options.reconnect] - Override reconnection config
   * @param {Object} [options.dedup] - Override deduplication config
   * @param {Function} [options.onDropDetected] - Callback invoked synchronously on unexpected drop.
   *   Receives the same context object as the 'drop_detected' event.
   * @param {Function} [options._connectionFactory] - TEST ONLY: factory returning a fake
   *   connection object instead of calling deepgramClient.listen.live().
   *   Signature: () => { on, send, keepAlive, requestClose }
   */
  constructor({
    apiKey,
    sessionId = null,
    liveOptions = {},
    reconnect = {},
    dedup = {},
    onDropDetected = null,
    _connectionFactory = null,
  } = {}) {
    super();

    if (!apiKey) {
      throw new Error('Deepgram API key is required');
    }

    this.#deepgramClient = createClient(apiKey);
    this.#liveOptions = { ...DEFAULT_LIVE_OPTIONS, ...liveOptions };
    this.#reconnectConfig = { ...RECONNECT_DEFAULTS, ...reconnect };
    this.#reconnectAttempts = 0;
    this.#reconnectTimer = null;
    this.#reconnectIsImmediate = false;
    this.#state = 'idle';
    this.#connection = null;
    this.#keepAliveInterval = null;
    this.#intentionallyClosed = false;
    this.#deduplicator = new UtteranceDeduplicator(dedup);
    this.#sessionStartTime = null;
    this.#lastStreamTimestamp = 0;
    this.#sessionId = sessionId;
    this.#onDropDetected = typeof onDropDetected === 'function' ? onDropDetected : null;
    // TEST ONLY — stored as plain property so #establishConnection can reach it.
    this._connectionFactory = _connectionFactory ?? null;
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
   * The end-time (seconds) of the last audio segment received from Deepgram.
   * Preserved across reconnects.  Zero until the first Results event arrives.
   */
  get lastStreamTimestamp() {
    return this.#lastStreamTimestamp;
  }

  /**
   * Build a context snapshot suitable for passing to reconnect callbacks or
   * emitting via 'drop_detected'.  Contains all information needed for a
   * consumer to preserve transcript state and resume after a reconnect.
   *
   * @returns {{
   *   sessionId: string|null,
   *   sessionStartTime: number|null,
   *   lastStreamTimestamp: number,
   *   reconnectAttempts: number,
   *   state: string,
   * }}
   */
  getDropContext() {
    return {
      sessionId: this.#sessionId,
      sessionStartTime: this.#sessionStartTime,
      lastStreamTimestamp: this.#lastStreamTimestamp,
      reconnectAttempts: this.#reconnectAttempts,
      state: this.#state,
    };
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
   *
   * Bug-fix: tracks an `opened` flag so that if the connection closes *before*
   * the 'open' event fires (e.g. a failed reconnect attempt), the Promise is
   * rejected.  Without this the Promise would hang forever and the
   * `#scheduleReconnect` retry loop would deadlock.
   *
   * @returns {Promise<void>}
   */
  #establishConnection() {
    return new Promise((resolve, reject) => {
      try {
        // Use injected factory (test DI) or the real Deepgram SDK connection.
        const connection = this._connectionFactory
          ? this._connectionFactory()
          : this.#deepgramClient.listen.live(this.#liveOptions);

        // Track whether 'open' ever fired so we can reject on premature close.
        let opened = false;

        connection.on('open', () => {
          opened = true;
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

        connection.on('Metadata', (_metadata) => {
          // Metadata events can be logged if needed
        });

        connection.on('SpeechStarted', () => {
          // VAD detected speech start
        });

        connection.on('error', (err) => {
          this.emit('error', err);

          if (this.#state === 'connecting') {
            // Initial connection attempt failed before 'open' — reject immediately.
            this.#state = 'idle';
            reject(err);
          } else if (this.#state === 'connected') {
            // Error on an established connection — force the socket closed so the
            // 'close' handler runs, emits 'drop_detected', and schedules reconnect.
            // Some WebSocket implementations don't auto-close on error, so we
            // request it explicitly to guarantee the reconnect flow fires.
            try {
              connection.requestClose();
            } catch {
              // Already closing / closed — the 'close' event will still fire.
            }
          }
          // For state === 'reconnecting': the error is emitted above; the
          // Promise will be rejected via the 'close' handler's opened-guard below.
        });

        connection.on('close', (event) => {
          this.#stopKeepAlive();
          const prevState = this.#state;
          this.#state = 'disconnected';
          this.#connection = null;

          // If the connection closed before 'open' ever fired, reject the Promise
          // so the caller / #scheduleReconnect's catch handler is notified.
          if (!opened) {
            const closeErr = new Error(
              `Deepgram connection closed before open: code=${event?.code ?? 'unknown'} ` +
              `reason=${event?.reason ?? 'unknown'}`
            );
            reject(closeErr);

            // When the *initial* connect() attempt fails (prevState === 'connecting')
            // and the caller didn't request a close, kick off the retry loop.
            // For 'reconnecting' state, #scheduleReconnect's catch handler already
            // calls #scheduleReconnect() again after the Promise rejects.
            if (!this.#intentionallyClosed && prevState === 'connecting') {
              this.emit('disconnected', {
                code: event?.code,
                reason: event?.reason ?? 'unknown',
                sessionId: this.#sessionId,
                unexpected: true,
              });
              this.#scheduleReconnect();
              return; // disconnected already emitted below guard
            }
          }

          const wasUnexpected = !this.#intentionallyClosed && prevState === 'connected';

          this.emit('disconnected', {
            code: event?.code,
            reason: event?.reason ?? 'unknown',
            sessionId: this.#sessionId,
            unexpected: wasUnexpected,
          });

          // Emit drop_detected with full context on any unexpected drop so that
          // connection-resilience and the session coordinator can preserve state.
          if (wasUnexpected) {
            const dropContext = this.getDropContext();
            const dropPayload = {
              code: event?.code,
              reason: event?.reason ?? 'unknown',
              ...dropContext,
            };

            this.emit('drop_detected', dropPayload);

            if (this.#onDropDetected) {
              try {
                this.#onDropDetected(dropPayload);
              } catch (cbErr) {
                // Never let the callback crash the client
                this.emit('warning', `onDropDetected callback threw: ${cbErr?.message}`);
              }
            }

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
   *
   * Speaker transition handling
   * ───────────────────────────
   * When diarize=true, Deepgram attaches a `speaker` label to every word.
   * A single Results event may contain words from MULTIPLE speakers when a
   * speaker transition occurs mid-segment (e.g. speaker 0 says "okay" then
   * speaker 1 immediately replies "yes").  In that case we split the result
   * into per-speaker groups and emit one 'transcript' event per group so that
   * the transcript store can correctly attribute each utterance.
   *
   * For interim results (is_final=false), we still split by speaker but do
   * NOT run deduplication — interim results are ephemeral and the final result
   * for the same audio will pass through the dedup gate.
   *
   * Duplicates are suppressed before they reach any listener / transcript store.
   * Also updates `#lastStreamTimestamp` so reconnect context is accurate.
   *
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

    // Track the furthest stream timestamp seen — used in getDropContext().
    const segmentEnd = (data.start ?? 0) + (data.duration ?? 0);
    if (segmentEnd > this.#lastStreamTimestamp) {
      this.#lastStreamTimestamp = segmentEnd;
    }

    // Compute session-relative timestamp for deduplication
    const sessionElapsed = this.#sessionStartTime
      ? (Date.now() - this.#sessionStartTime) / 1000
      : (data.start ?? 0);

    const words = alternative.words ?? [];

    // ── Speaker segmentation ────────────────────────────────────────────────
    // Group words by consecutive speaker label to handle mid-segment speaker
    // transitions.  Each group becomes its own transcript event so downstream
    // consumers (transcript store, speaker identifier) receive correctly
    // attributed utterances even when two speakers appear in one Results event.
    const speakerGroups = groupWordsBySpeaker(words);

    if (speakerGroups.length === 0) {
      // No word-level diarization data — fall back to the aggregate transcript
      // with an unknown speaker label (-1).  This happens with very short
      // segments or when Deepgram omits word-level detail on interim results.
      const speaker = -1;

      if (isFinal) {
        const dedupResult = this.#deduplicator.check({
          speaker,
          text: transcript,
          timestamp: sessionElapsed,
          isFinal,
        });

        if (dedupResult.isDuplicate) {
          this.emit('transcript_duplicate', {
            text: transcript,
            speaker,
            reason: dedupResult.reason,
            similarityScore: dedupResult.similarityScore,
          });
          return;
        }
      }

      this.emit('transcript', {
        text: transcript,
        speaker,
        isFinal,
        speechFinal,
        confidence: alternative.confidence ?? 0,
        start: data.start ?? 0,
        end: segmentEnd,
        words: [],
      });
      return;
    }

    // ── Emit one event per speaker group ────────────────────────────────────
    for (const group of speakerGroups) {
      const { speaker, text, start, end, confidence, words: groupWords } = group;

      if (!text) continue; // skip empty groups

      // Deduplication gate — only apply to final results to avoid suppressing
      // useful interim updates.  Interim results for the same audio will be
      // superseded by their final counterpart which goes through the gate.
      if (isFinal) {
        const dedupResult = this.#deduplicator.check({
          speaker,
          text,
          timestamp: sessionElapsed,
          isFinal,
        });

        if (dedupResult.isDuplicate) {
          this.emit('transcript_duplicate', {
            text,
            speaker,
            reason: dedupResult.reason,
            similarityScore: dedupResult.similarityScore,
          });
          continue; // suppress this group — check the next one
        }
      }

      /** @type {TranscriptEvent} */
      const event = {
        text,
        speaker,
        isFinal,
        speechFinal: speakerGroups.indexOf(group) === speakerGroups.length - 1
          ? speechFinal
          : false, // speechFinal only applies to the last group in the segment
        confidence,
        start,
        end,
        words: groupWords,
      };

      this.emit('transcript', event);
    }
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
   * Compute the exponential-backoff delay with optional jitter for a given attempt.
   *
   * Formula:
   *   rawDelay = min(baseDelayMs * backoffMultiplier^(attempt-1), maxDelayMs)
   *   jitter   = rawDelay * jitterFactor * random in [-1, 1]
   *   delay    = max(0, rawDelay + jitter)
   *
   * Exposed as a public method so callers / tests can inspect computed values
   * without requiring a live connection.
   *
   * @param {number} attempt - 1-based attempt number
   * @returns {number} delay in milliseconds (≥ 0)
   */
  calculateBackoffDelay(attempt) {
    const { baseDelayMs, maxDelayMs, backoffMultiplier, jitterFactor } =
      this.#reconnectConfig;

    const rawDelay = Math.min(
      baseDelayMs * Math.pow(backoffMultiplier, attempt - 1),
      maxDelayMs,
    );

    const jitter = jitterFactor > 0
      ? rawDelay * jitterFactor * (Math.random() * 2 - 1)   // random in [-jitter, +jitter]
      : 0;

    return Math.max(0, rawDelay + jitter);
  }

  /**
   * Schedule an automatic reconnection with exponential backoff and jitter.
   */
  #scheduleReconnect() {
    if (this.#reconnectAttempts >= this.#reconnectConfig.maxAttempts) {
      // Set 'closed' BEFORE emitting so listeners see the final state.
      // emit() is synchronous — listeners run inline before the next statement.
      this.#state = 'closed';
      this.emit('error', new Error(
        `Deepgram reconnection failed after ${this.#reconnectConfig.maxAttempts} attempts`
      ));
      return;
    }

    this.#state = 'reconnecting';
    this.#reconnectAttempts++;

    const delayMs = this.calculateBackoffDelay(this.#reconnectAttempts);

    this.emit('reconnecting', {
      attempt: this.#reconnectAttempts,
      maxAttempts: this.#reconnectConfig.maxAttempts,
      delayMs,
      sessionId: this.#sessionId,
    });

    const doReconnect = async () => {
      try {
        await this.#establishConnection();
      } catch {
        // establishConnection rejected — schedule another attempt
        this.#scheduleReconnect();
      }
    };

    // When delayMs === 0, use setImmediate so the factory-created connection
    // object exists before any externally-queued setImmediate callbacks fire
    // (setImmediate callbacks run in FIFO order within the same check phase).
    // setTimeout(0) would fire *after* already-queued setImmediate callbacks,
    // causing a race in tests that trigger open from a setImmediate.
    if (delayMs === 0) {
      this.#reconnectIsImmediate = true;
      this.#reconnectTimer = setImmediate(doReconnect);
    } else {
      this.#reconnectIsImmediate = false;
      this.#reconnectTimer = setTimeout(doReconnect, delayMs);
    }
  }

  /**
   * Gracefully close the connection.
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.#intentionallyClosed = true;

    if (this.#reconnectTimer) {
      if (this.#reconnectIsImmediate) {
        clearImmediate(this.#reconnectTimer);
      } else {
        clearTimeout(this.#reconnectTimer);
      }
      this.#reconnectTimer = null;
      this.#reconnectIsImmediate = false;
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
    this.#lastStreamTimestamp = 0;
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
      sessionId: this.#sessionId,
    };
  }
}

export { DEFAULT_LIVE_OPTIONS, RECONNECT_DEFAULTS };
