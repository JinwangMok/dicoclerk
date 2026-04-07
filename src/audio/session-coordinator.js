/**
 * Audio Session Coordinator
 *
 * Ties together the full audio capture pipeline for a single recording session:
 * - Creates and manages a DeepgramStreamingClient
 * - Creates and manages an AudioCapturePipeline
 * - Stores transcript entries (final results) for later minutes generation
 * - Saves raw transcript to disk for archival
 * - Handles Deepgram reconnect events with fallback save and user notification
 *
 * One coordinator exists per active guild session.
 */

import { EventEmitter } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DeepgramStreamingClient } from '../stt/deepgram-client.js';
import { DeepgramConnectionPool } from '../stt/connection-pool.js';
import { AudioCapturePipeline } from './audio-capture-pipeline.js';
import { OpusDecoderPool } from './opus-decoder.js';
import { SpeakerIdentifier } from '../stt/speaker-identifier.js';
import { TranscriptSession } from '../stt/transcript-store.js';

/** Directory for storing transcripts and recordings */
const DATA_DIR = join(process.cwd(), 'data');
const TRANSCRIPTS_DIR = join(DATA_DIR, 'transcripts');

/**
 * @typedef {Object} TranscriptEntry
 * @property {number} speaker - Deepgram speaker label
 * @property {string} speakerName - Resolved display name (or placeholder)
 * @property {string} text - Final transcribed text
 * @property {number} confidence - Confidence score (0-1)
 * @property {number} start - Start time (seconds)
 * @property {number} end - End time (seconds)
 * @property {number} timestamp - Wall clock timestamp (ms since epoch)
 */

/**
 * Events emitted:
 * - 'transcript'            : TranscriptEntry - new final transcript entry
 * - 'transcript_interim'    : { speaker, text } - interim (live preview)
 * - 'deepgram_connected'    : void
 * - 'deepgram_disconnected' : { code, reason }
 * - 'deepgram_reconnecting' : { attempt, maxAttempts, delayMs }
 * - 'deepgram_failed'       : Error - gave up reconnecting
 * - 'pipeline_stats'        : object - periodic stats
 * - 'error'                 : Error
 * - 'warning'               : string
 */
export class AudioSessionCoordinator extends EventEmitter {
  /** @type {DeepgramStreamingClient|null} */
  #deepgramClient = null;

  /** @type {DeepgramConnectionPool|null} */
  #connectionPool = null;

  /** @type {AudioCapturePipeline|null} */
  #pipeline = null;

  /** @type {TranscriptEntry[]} */
  #transcript = [];

  /** @type {Map<number, string>} speaker label -> resolved name */
  #speakerMap = new Map();

  /** @type {Map<string, number>} userId -> speaker label */
  #userSpeakerMap = new Map();

  /** @type {SpeakerIdentifier} speaker identification tracker */
  #speakerIdentifier = new SpeakerIdentifier();

  /** @type {string} */
  #sessionId;

  /** @type {string} */
  #guildId;

  /** @type {string} */
  #language;

  /** @type {boolean} */
  #running = false;

  /** @type {boolean} */
  #usePool = false;

  /** @type {NodeJS.Timeout|null} */
  #statsInterval = null;

  /** @type {number} dropped audio packets during Deepgram outage */
  #droppedPackets = 0;

  /**
   * Per-user Opus→linear16 decoder pool.
   * Created during start() and destroyed during stop().
   * @type {OpusDecoderPool|null}
   */
  #opusDecoder = null;

  /** @type {TranscriptEntry[]} buffered entries saved during fallback */
  #fallbackBuffer = [];

  /**
   * Per-session in-memory transcript store.
   * Accumulates speaker-attributed, deduplicated transcript segments.
   * Created in start(), closed/returned in stop().
   * @type {TranscriptSession|null}
   */
  #transcriptSession = null;

  /**
   * @param {Object} options
   * @param {string} options.guildId
   * @param {string} options.language - 'ko', 'en', or 'multi'
   * @param {string} [options.sessionId] - Unique session identifier
   * @param {boolean} [options.usePool=false] - Use connection pool for multi-speaker support
   * @param {Object} [options.poolConfig] - Connection pool configuration overrides
   * @param {Function} [options.deepgramClientFactory] - Optional factory for creating DeepgramStreamingClient
   *   (used for testing/DI; signature: (options) => DeepgramStreamingClient)
   * @param {Function} [options.pipelineFactory] - Optional factory for creating AudioCapturePipeline
   *   (used for testing/DI; signature: (options) => AudioCapturePipeline)
   * @param {Function} [options.opusDecoderFactory] - Optional factory for creating OpusDecoderPool
   *   (used for testing/DI; signature: () => OpusDecoderPool)
   */
  constructor({
    guildId,
    language,
    sessionId,
    usePool = false,
    poolConfig = {},
    deepgramClientFactory = null,
    pipelineFactory = null,
    opusDecoderFactory = null,
  }) {
    super();
    this.#guildId = guildId;
    this.#language = language;
    this.#sessionId = sessionId || `${guildId}-${Date.now()}`;
    this.#usePool = usePool;
    this._poolConfig = poolConfig;
    this._deepgramClientFactory = deepgramClientFactory;
    this._pipelineFactory = pipelineFactory;
    this._opusDecoderFactory = opusDecoderFactory;
  }

  /** Whether the coordinator is actively capturing */
  get isRunning() {
    return this.#running;
  }

  /** The accumulated transcript entries (final results only) */
  get transcript() {
    return [...this.#transcript];
  }

  /** Session identifier */
  get sessionId() {
    return this.#sessionId;
  }

  /** Current speaker name mapping */
  get speakerMap() {
    return new Map(this.#speakerMap);
  }

  /** Pipeline stats (if running) */
  get stats() {
    const pipelineStats = this.#pipeline?.getStats() ?? null;
    const poolStats = this.#connectionPool?.getStats() ?? null;
    if (pipelineStats && poolStats) {
      return { ...pipelineStats, pool: poolStats };
    }
    return pipelineStats;
  }

  /** Connection pool reference (if using pool mode) */
  get connectionPool() {
    return this.#connectionPool;
  }

  /** Speaker identifier for mapping Deepgram labels to Discord users */
  get speakerIdentifier() {
    return this.#speakerIdentifier;
  }

  /**
   * The per-session in-memory transcript store.
   * Provides speaker-attributed, structured transcript data for minutes generation.
   * Available after start() is called; contains final session data after stop().
   * @returns {TranscriptSession|null}
   */
  get transcriptSession() {
    return this.#transcriptSession;
  }

  /**
   * Start audio capture: connect Deepgram, create pipeline, begin forwarding.
   *
   * Supports two modes:
   * 1. **Single-client mode** (default): One DeepgramStreamingClient handles all audio.
   * 2. **Pool mode** (usePool=true): A DeepgramConnectionPool manages multiple
   *    connections with auto-scaling, health monitoring, and speaker routing
   *    for 5-10 concurrent speakers.
   *
   * @param {import('@discordjs/voice').VoiceConnection} connection - Discord voice connection
   * @param {Function} [resolveUsername] - async (userId) => displayName
   * @returns {Promise<void>}
   */
  async start(connection, resolveUsername) {
    if (this.#running) {
      this.emit('warning', 'AudioSessionCoordinator already running');
      return;
    }

    // Ensure data directories exist
    await mkdir(TRANSCRIPTS_DIR, { recursive: true });

    // Create the per-session in-memory transcript store.
    // Resets if start() is somehow called again on the same coordinator instance.
    this.#transcriptSession = new TranscriptSession({ sessionId: this.#sessionId });

    // Build Deepgram live options based on language
    const liveOptions = this.#buildLiveOptions();

    if (this.#usePool) {
      // Pool mode: use DeepgramConnectionPool for multi-speaker support
      await this.#startWithPool(connection, resolveUsername, liveOptions);
    } else {
      // Single-client mode (original behavior)
      await this.#startWithSingleClient(connection, resolveUsername, liveOptions);
    }

    this.#running = true;

    // Periodic stats logging
    this.#statsInterval = setInterval(() => {
      const stats = this.#pipeline?.getStats();
      if (stats) {
        const poolInfo = this.#connectionPool
          ? ` pool_conns=${this.#connectionPool.connectionCount} pool_healthy=${this.#connectionPool.healthyConnectionCount}`
          : '';
        this.emit('pipeline_stats', stats);
        console.log(
          `[AudioCoordinator] Stats: streams=${stats.activeStreams} packets=${stats.totalPackets} participants=${stats.participants} transcript_entries=${this.#transcript.length}${poolInfo}`
        );
      }
    }, 30_000); // Every 30 seconds

    console.log(`[AudioCoordinator] Started session=${this.#sessionId} lang=${this.#language} mode=${this.#usePool ? 'pool' : 'single'}`);
  }

  /**
   * Start with a single Deepgram client (original behavior).
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {Function} [resolveUsername]
   * @param {Object} liveOptions
   * @returns {Promise<void>}
   */
  async #startWithSingleClient(connection, resolveUsername, liveOptions) {
    // Create Deepgram client — use injected factory if provided (enables testing/DI)
    if (this._deepgramClientFactory) {
      this.#deepgramClient = this._deepgramClientFactory({
        apiKey: process.env.DEEPGRAM_API_KEY,
        sessionId: this.#sessionId,
        liveOptions,
      });
    } else {
      this.#deepgramClient = new DeepgramStreamingClient({
        apiKey: process.env.DEEPGRAM_API_KEY,
        sessionId: this.#sessionId,
        liveOptions,
      });
    }

    this.#wireDeepgramEvents();

    // Connect to Deepgram
    try {
      await this.#deepgramClient.connect();
      console.log(`[AudioCoordinator] Deepgram connected for session=${this.#sessionId}`);
    } catch (err) {
      const wrappedErr = new Error(`Failed to connect to Deepgram: ${err.message}`);
      this.emit('error', wrappedErr);
      throw wrappedErr;
    }

    // Create per-user Opus→linear16 decoder pool — use injected factory if provided
    this.#opusDecoder = this._opusDecoderFactory
      ? this._opusDecoderFactory()
      : new OpusDecoderPool();
    this.#opusDecoder.on('decode_error', ({ userId, error }) => {
      this.emit('warning', `Opus decode error for user ${userId}: ${error}`);
    });

    // Create audio capture pipeline with speaker identifier for user attribution
    // Use injected factory if provided (enables testing/DI)
    const pipelineOptions = {
      connection,
      deepgramClient: this.#deepgramClient,
      resolveUsername: resolveUsername || undefined,
      speakerIdentifier: this.#speakerIdentifier,
      opusDecoder: this.#opusDecoder,
    };
    this.#pipeline = this._pipelineFactory
      ? this._pipelineFactory(pipelineOptions)
      : new AudioCapturePipeline(pipelineOptions);

    this.#wirePipelineEvents();
    this.#speakerIdentifier.startEviction();
    this.#pipeline.start();
  }

  /**
   * Start with a connection pool for multi-speaker support.
   * The pool manages multiple Deepgram connections with auto-scaling,
   * health monitoring, and speaker routing for 5-10 concurrent speakers.
   *
   * @param {import('@discordjs/voice').VoiceConnection} connection
   * @param {Function} [resolveUsername]
   * @param {Object} liveOptions
   * @returns {Promise<void>}
   */
  async #startWithPool(connection, resolveUsername, liveOptions) {
    // Create connection pool
    this.#connectionPool = new DeepgramConnectionPool({
      apiKey: process.env.DEEPGRAM_API_KEY,
      liveOptions,
      ...this._poolConfig,
    });

    this.#wirePoolEvents();

    // Start the pool (creates minimum connections)
    try {
      await this.#connectionPool.start();
      console.log(`[AudioCoordinator] Connection pool started for session=${this.#sessionId}`);
    } catch (err) {
      this.emit('error', new Error(`Failed to start connection pool: ${err.message}`));
      throw err;
    }

    // In pool mode, we still use AudioCapturePipeline but with a proxy client
    // that delegates to the pool's sendAudio with speaker routing.
    // We create a thin adapter that implements the DeepgramStreamingClient interface.
    const poolProxy = this.#createPoolProxy();

    // Create per-user Opus→linear16 decoder pool (shared across pool connections)
    this.#opusDecoder = new OpusDecoderPool();
    this.#opusDecoder.on('decode_error', ({ userId, error }) => {
      this.emit('warning', `Opus decode error for user ${userId}: ${error}`);
    });

    this.#pipeline = new AudioCapturePipeline({
      connection,
      deepgramClient: poolProxy,
      resolveUsername: resolveUsername || undefined,
      speakerIdentifier: this.#speakerIdentifier,
      opusDecoder: this.#opusDecoder,
    });

    this.#wirePipelineEvents();
    this.#speakerIdentifier.startEviction();

    // When pipeline detects a new speaker, register them with the pool
    this.#pipeline.on('user_speaking', ({ userId }) => {
      this.#connectionPool?.registerSpeaker(userId);
    });

    this.#pipeline.on('user_silent', ({ userId }) => {
      // Don't unregister on silence — speaker may resume.
      // Unregistration happens on stream end/cleanup.
    });

    this.#pipeline.start();
  }

  /**
   * Create a proxy object that adapts the DeepgramConnectionPool to the
   * DeepgramStreamingClient interface expected by AudioCapturePipeline.
   *
   * The proxy routes audio through the pool's speaker-aware routing,
   * while still appearing as a single client to the pipeline.
   *
   * @returns {Object} Proxy implementing DeepgramStreamingClient interface
   */
  #createPoolProxy() {
    const pool = this.#connectionPool;

    return {
      get isConnected() {
        return pool.healthyConnectionCount > 0;
      },
      get state() {
        return pool.isRunning ? 'connected' : 'closed';
      },
      send(audioData) {
        // The pipeline calls send() without userId context.
        // In pool mode, we use a default route (first available connection).
        // For proper per-speaker routing, the pipeline's #forwardAudio
        // is augmented by the user_speaking event handler above.
        return pool.sendAudio('_default', audioData);
      },
      keepAlive() {
        // Pool manages keep-alive internally per connection
      },
    };
  }

  /**
   * Stop audio capture, flush Deepgram, save transcript to disk.
   * @returns {Promise<{ transcript: TranscriptEntry[], filePath: string, transcriptSession: TranscriptSession|null }>}
   */
  async stop() {
    if (!this.#running) {
      return { transcript: this.#transcript, filePath: null, transcriptSession: this.#transcriptSession };
    }

    this.#running = false;

    // Stop stats interval
    if (this.#statsInterval) {
      clearInterval(this.#statsInterval);
      this.#statsInterval = null;
    }

    // Stop the audio pipeline (stops forwarding packets)
    if (this.#pipeline) {
      this.#pipeline.stop();
      this.#pipeline.removeAllListeners();
      this.#pipeline = null;
    }

    // Destroy Opus decoder pool — releases per-user WASM decoder instances
    if (this.#opusDecoder) {
      this.#opusDecoder.destroy();
      this.#opusDecoder = null;
    }

    // Disconnect Deepgram (closes WebSocket gracefully)
    if (this.#deepgramClient) {
      await this.#deepgramClient.disconnect();
      this.#deepgramClient.removeAllListeners();
      this.#deepgramClient = null;
    }

    // Shut down connection pool if used
    if (this.#connectionPool) {
      await this.#connectionPool.shutdown();
      this.#connectionPool.removeAllListeners();
      this.#connectionPool = null;
    }

    // Stop speaker identifier eviction
    this.#speakerIdentifier.stopEviction();

    // Resolve speaker names in transcript using the speaker identifier
    this.#resolveAllSpeakerNames();

    // Save transcript to disk
    const filePath = await this.#saveTranscript();

    console.log(
      `[AudioCoordinator] Stopped session=${this.#sessionId} entries=${this.#transcript.length} dropped=${this.#droppedPackets}`
    );

    return { transcript: this.#transcript, filePath, transcriptSession: this.#transcriptSession };
  }

  /**
   * Build Deepgram live options based on language setting.
   * @returns {Object}
   */
  #buildLiveOptions() {
    const base = {
      model: 'nova-2',
      smart_format: true,
      punctuate: true,
      diarize: true,
      diarize_max_speakers: 10,  // Support up to 10 concurrent Discord participants
      interim_results: true,
      utterance_end_ms: 1500,
      vad_events: true,
      encoding: 'linear16',  // Decoded mono PCM from OpusDecoderPool
      sample_rate: 48000,
      channels: 1,           // Mono after stereo→mono mix in decoder
    };

    switch (this.#language) {
      case 'ko':
        return { ...base, language: 'ko', detect_language: false };
      case 'en':
        return { ...base, language: 'en', detect_language: false };
      case 'multi':
      default:
        return { ...base, language: 'ko', detect_language: true };
    }
  }

  /**
   * Wire event handlers for Deepgram client.
   */
  #wireDeepgramEvents() {
    const dg = this.#deepgramClient;

    dg.on('connected', () => {
      this.emit('deepgram_connected');
    });

    dg.on('disconnected', (info) => {
      this.emit('deepgram_disconnected', info);
    });

    dg.on('reconnecting', (info) => {
      this.emit('deepgram_reconnecting', info);
      console.log(
        `[AudioCoordinator] Deepgram reconnecting: attempt ${info.attempt}/${info.maxAttempts} delay=${info.delayMs}ms`
      );
    });

    dg.on('error', (err) => {
      const msg = err?.message || String(err);

      // Check if this is a terminal reconnection failure
      if (msg.includes('reconnection failed after')) {
        this.emit('deepgram_failed', err);
        // Save what we have so far as fallback
        this.#saveFallbackTranscript().catch(console.error);
      }

      this.emit('error', err);
    });

    // Final and interim transcript results (already deduplicated by DeepgramStreamingClient)
    dg.on('transcript', (event) => {
      if (event.isFinal && event.text.trim()) {
        // Use SpeakerIdentifier to map Deepgram speaker label to Discord user
        const identification = this.#speakerIdentifier.identify(
          event.speaker,
          event.start,
          event.end
        );

        const speakerName = identification.userId
          ? identification.displayName
          : this.#resolveSpeakerName(event.speaker);

        // Update legacy speaker map for backward compatibility
        if (identification.userId) {
          this.#speakerMap.set(event.speaker, speakerName);
          this.#userSpeakerMap.set(identification.userId, event.speaker);
        }

        // Register speaker in the TranscriptSession so that the structured
        // store has Discord user identity linked to the Deepgram speaker label.
        // Unresolved speakers fall back to "Speaker N" inside TranscriptSession.
        if (this.#transcriptSession && identification.userId) {
          this.#transcriptSession.registerSpeaker(
            event.speaker,
            identification.userId,
            speakerName,
          );
        }

        const entry = {
          speaker: event.speaker,
          speakerName,
          userId: identification.userId,
          text: event.text.trim(),
          confidence: event.confidence,
          speakerConfidence: identification.confidence,
          start: event.start,
          end: event.end,
          timestamp: Date.now(),
        };

        this.#transcript.push(entry);

        // Accumulate in the structured per-session store (dedup already done by DG client)
        this.#transcriptSession?.addFromEvent(event);

        this.emit('transcript', entry);
      } else if (!event.isFinal && event.text.trim()) {
        this.emit('transcript_interim', {
          speaker: event.speaker,
          text: event.text.trim(),
        });
      }
    });

    dg.on('transcript_duplicate', (info) => {
      // Already suppressed; just log for debugging at verbose level
    });
  }

  /**
   * Wire event handlers for the connection pool.
   * In pool mode, transcript events come from the pool instead of a single client.
   */
  #wirePoolEvents() {
    const pool = this.#connectionPool;

    // Transcript events from any connection in the pool
    pool.on('transcript', (event) => {
      if (event.isFinal && event.text?.trim()) {
        // Use SpeakerIdentifier to map Deepgram speaker label to Discord user
        const identification = this.#speakerIdentifier.identify(
          event.speaker,
          event.start,
          event.end
        );

        const speakerName = identification.userId
          ? identification.displayName
          : this.#resolveSpeakerName(event.speaker);

        // Update legacy speaker map for backward compatibility
        if (identification.userId) {
          this.#speakerMap.set(event.speaker, speakerName);
          this.#userSpeakerMap.set(identification.userId, event.speaker);
        }

        // Register speaker in the TranscriptSession (pool mode)
        if (this.#transcriptSession && identification.userId) {
          this.#transcriptSession.registerSpeaker(
            event.speaker,
            identification.userId,
            speakerName,
          );
        }

        const entry = {
          speaker: event.speaker,
          speakerName,
          userId: identification.userId,
          text: event.text.trim(),
          confidence: event.confidence,
          speakerConfidence: identification.confidence,
          start: event.start,
          end: event.end,
          timestamp: Date.now(),
          connectionId: event.connectionId,
        };

        this.#transcript.push(entry);

        // Accumulate in the structured per-session store (pool mode)
        this.#transcriptSession?.addFromEvent(event);

        this.emit('transcript', entry);
      } else if (!event.isFinal && event.text?.trim()) {
        this.emit('transcript_interim', {
          speaker: event.speaker,
          text: event.text.trim(),
        });
      }
    });

    pool.on('connection_added', (info) => {
      console.log(`[AudioCoordinator] Pool connection added: ${info.id} (total: ${info.totalConnections})`);
      this.emit('deepgram_connected');
    });

    pool.on('connection_removed', (info) => {
      console.log(`[AudioCoordinator] Pool connection removed: ${info.id} reason=${info.reason} (total: ${info.totalConnections})`);
    });

    pool.on('connection_unhealthy', ({ id, reason }) => {
      console.warn(`[AudioCoordinator] Pool connection unhealthy: ${id} reason=${reason}`);
      if (pool.healthyConnectionCount === 0) {
        this.emit('deepgram_failed', new Error(`All pool connections unhealthy: ${reason}`));
        this.#saveFallbackTranscript().catch(console.error);
      }
    });

    pool.on('scaled_up', (info) => {
      console.log(`[AudioCoordinator] Pool scaled up: ${info.from} -> ${info.to} (${info.reason})`);
    });

    pool.on('scaled_down', (info) => {
      console.log(`[AudioCoordinator] Pool scaled down: ${info.from} -> ${info.to} (${info.reason})`);
    });

    pool.on('notification', (notification) => {
      this.emit('notification', notification);
    });

    pool.on('error', (err) => {
      this.emit('error', err);
    });

    pool.on('warning', (msg) => {
      this.emit('warning', msg);
    });
  }

  /**
   * Wire event handlers for the audio pipeline.
   */
  #wirePipelineEvents() {
    const pipeline = this.#pipeline;

    pipeline.on('user_speaking', ({ userId, username }) => {
      console.log(`[AudioCoordinator] Speaker: ${username} (${userId})`);
    });

    pipeline.on('audio_dropped', ({ userId, reason }) => {
      this.#droppedPackets++;
      if (this.#droppedPackets % 100 === 1) {
        this.emit('warning', `Audio packets being dropped (${reason}). Total dropped: ${this.#droppedPackets}`);
      }
    });

    pipeline.on('error', (err) => {
      this.emit('error', err);
    });

    pipeline.on('warning', (msg) => {
      this.emit('warning', msg);
    });
  }

  /**
   * Resolve a Deepgram speaker label to a display name.
   * @param {number} speakerLabel
   * @returns {string}
   */
  #resolveSpeakerName(speakerLabel) {
    if (this.#speakerMap.has(speakerLabel)) {
      return this.#speakerMap.get(speakerLabel);
    }
    return `Speaker ${speakerLabel}`;
  }

  /**
   * Register a mapping from Discord user ID to Deepgram speaker label.
   * This enables matching diarized speakers to Discord usernames.
   * @param {string} userId
   * @param {number} speakerLabel
   * @param {string} displayName
   */
  mapUserToSpeaker(userId, speakerLabel, displayName) {
    this.#userSpeakerMap.set(userId, speakerLabel);
    this.#speakerMap.set(speakerLabel, displayName);
    this.#speakerIdentifier.setMapping(speakerLabel, userId, displayName);
  }

  /**
   * Resolve speaker names in the transcript using the SpeakerIdentifier.
   * Performs a final pass over all transcript entries, updating any entries
   * that still have generic "Speaker N" names using the latest mappings.
   * Also synchronises resolved speaker identities into the TranscriptSession
   * so that toStructuredData() / toPlainText() exports have correct names.
   */
  #resolveAllSpeakerNames() {
    // Populate the speaker identifier with any known users from the pipeline
    if (this.#pipeline) {
      const userMap = this.#pipeline.userMap;
      for (const [userId, username] of userMap) {
        this.#speakerIdentifier.registerUser(userId, username);
      }
    }

    // Final pass: update transcript entries with the latest speaker name mappings
    for (const entry of this.#transcript) {
      const mapping = this.#speakerIdentifier.getMapping(entry.speaker);
      if (mapping) {
        entry.speakerName = mapping.displayName;
        entry.userId = mapping.userId;
        entry.speakerConfidence = mapping.confidence;

        // Also update legacy speaker map
        this.#speakerMap.set(entry.speaker, mapping.displayName);
        this.#userSpeakerMap.set(mapping.userId, entry.speaker);
      }
    }

    // Sync all resolved speaker mappings into the TranscriptSession so that
    // its export methods (toStructuredData, toPlainText, getSummary) reflect
    // the fully-resolved speaker identities after the final pass.
    if (this.#transcriptSession) {
      for (const [speakerLabel, displayName] of this.#speakerMap) {
        // Find the Discord userId for this speaker label
        const userId = [...this.#userSpeakerMap.entries()]
          .find(([, label]) => label === speakerLabel)?.[0] ?? null;
        this.#transcriptSession.registerSpeaker(speakerLabel, userId, displayName);
      }
    }
  }

  /**
   * Save the transcript to a JSON file on disk.
   * @returns {Promise<string>} file path
   */
  async #saveTranscript() {
    const fileName = `transcript-${this.#sessionId}.json`;
    const filePath = join(TRANSCRIPTS_DIR, fileName);

    const data = {
      sessionId: this.#sessionId,
      guildId: this.#guildId,
      language: this.#language,
      createdAt: new Date().toISOString(),
      totalEntries: this.#transcript.length,
      droppedPackets: this.#droppedPackets,
      speakerMap: Object.fromEntries(this.#speakerMap),
      speakerIdentification: this.#speakerIdentifier.getStats(),
      transcript: this.#transcript,
    };

    try {
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[AudioCoordinator] Transcript saved: ${filePath}`);
      return filePath;
    } catch (err) {
      console.error(`[AudioCoordinator] Failed to save transcript:`, err.message);
      this.emit('error', new Error(`Failed to save transcript: ${err.message}`));
      return null;
    }
  }

  /**
   * Emergency fallback save when Deepgram connection is permanently lost.
   * Saves whatever transcript we have so far.
   * @returns {Promise<string|null>}
   */
  async #saveFallbackTranscript() {
    if (this.#transcript.length === 0) return null;

    const fileName = `transcript-${this.#sessionId}-fallback.json`;
    const filePath = join(TRANSCRIPTS_DIR, fileName);

    const data = {
      sessionId: this.#sessionId,
      guildId: this.#guildId,
      language: this.#language,
      createdAt: new Date().toISOString(),
      isFallback: true,
      reason: 'Deepgram connection permanently lost',
      totalEntries: this.#transcript.length,
      droppedPackets: this.#droppedPackets,
      transcript: this.#transcript,
    };

    try {
      await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      console.log(`[AudioCoordinator] Fallback transcript saved: ${filePath}`);
      return filePath;
    } catch (err) {
      console.error(`[AudioCoordinator] Failed to save fallback transcript:`, err.message);
      return null;
    }
  }

  /**
   * Register a user in the pipeline's user map (for username resolution).
   * @param {string} userId
   * @param {string} username
   */
  registerUser(userId, username) {
    this.#speakerIdentifier.registerUser(userId, username);
    if (this.#pipeline) {
      this.#pipeline.registerUser(userId, username);
    }
  }
}
