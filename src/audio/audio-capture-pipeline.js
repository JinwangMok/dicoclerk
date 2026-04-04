/**
 * Audio Capture Pipeline
 *
 * Bridges Discord voice audio streams and the Deepgram streaming STT client.
 * Supports two operating modes:
 *
 * 1. **Direct mode**: Attaches to a VoiceConnection's receiver, subscribes to
 *    per-user Opus streams on speaking events, and forwards packets to Deepgram.
 *
 * 2. **Consumer mode**: Accepts externally-provided Opus streams (e.g. from
 *    SessionManager's audioStream events) via `addStream(userId, stream)`.
 *
 * In both modes, Opus packets are forwarded directly to Deepgram (which natively
 * supports Opus decoding), and a userId-to-username map is maintained for
 * correlating Deepgram diarization with Discord user identities.
 */

import { EventEmitter } from 'node:events';
import { EndBehaviorType } from '@discordjs/voice';
import { SpeakerIdentifier } from '../stt/speaker-identifier.js';

/** How long (ms) to keep a user's stream open after they stop speaking */
const SILENCE_TIMEOUT_MS = 200;

/** Max concurrent user streams to prevent resource exhaustion */
const MAX_CONCURRENT_STREAMS = 15;

/**
 * @typedef {Object} AudioPipelineOptions
 * @property {import('../stt/deepgram-client.js').DeepgramStreamingClient} deepgramClient - Deepgram streaming client
 * @property {import('@discordjs/voice').VoiceConnection} [connection] - Discord voice connection (for direct mode)
 * @property {Function} [resolveUsername] - Async function to resolve userId -> display name
 */

/**
 * @typedef {Object} UserStreamInfo
 * @property {string} userId - Discord user ID
 * @property {string} username - Display name
 * @property {import('stream').Readable} stream - Opus audio receive stream
 * @property {number} packetCount - Number of packets forwarded
 * @property {number} startedAt - Timestamp when stream was created
 */

/**
 * Events emitted:
 * - 'user_speaking'    : { userId, username } - user started speaking
 * - 'user_silent'      : { userId, username } - user stopped speaking
 * - 'audio_forwarded'  : { userId, byteLength } - audio packet sent to Deepgram
 * - 'audio_dropped'    : { userId, reason } - audio packet dropped
 * - 'error'            : Error - pipeline error
 * - 'warning'          : string - non-fatal issue
 */
export class AudioCapturePipeline extends EventEmitter {
  /** @type {import('@discordjs/voice').VoiceConnection|null} */
  #connection;

  /** @type {import('@discordjs/voice').VoiceReceiver|null} */
  #receiver;

  /** @type {import('../stt/deepgram-client.js').DeepgramStreamingClient} */
  #deepgramClient;

  /** @type {Map<string, UserStreamInfo>} userId -> stream info */
  #activeStreams;

  /** @type {Map<string, string>} userId -> username */
  #userMap;

  /** @type {Function} */
  #resolveUsername;

  /** @type {boolean} */
  #running;

  /** @type {number} total packets forwarded across all users */
  #totalPackets;

  /** @type {Function|null} bound handler for speaking start */
  #onSpeakingStart;

  /** @type {Function|null} bound handler for speaking end */
  #onSpeakingEnd;

  /** @type {SpeakerIdentifier} speaker identification tracker */
  #speakerIdentifier;

  /**
   * @param {AudioPipelineOptions} options
   */
  constructor({ connection, deepgramClient, resolveUsername, speakerIdentifier } = {}) {
    super();

    if (!deepgramClient) throw new Error('DeepgramStreamingClient is required');

    this.#connection = connection || null;
    this.#receiver = connection?.receiver || null;
    this.#deepgramClient = deepgramClient;
    this.#resolveUsername = resolveUsername || (async (id) => `User-${id.slice(-4)}`);
    this.#activeStreams = new Map();
    this.#userMap = new Map();
    this.#running = false;
    this.#totalPackets = 0;
    this.#onSpeakingStart = null;
    this.#onSpeakingEnd = null;
    this.#speakerIdentifier = speakerIdentifier || new SpeakerIdentifier();
  }

  /** The speaker identifier instance for mapping Deepgram labels to Discord users */
  get speakerIdentifier() {
    return this.#speakerIdentifier;
  }

  /** Whether the pipeline is actively capturing audio */
  get isRunning() {
    return this.#running;
  }

  /** Number of currently active user streams */
  get activeStreamCount() {
    return this.#activeStreams.size;
  }

  /** Map of userId -> username for all known participants */
  get userMap() {
    return new Map(this.#userMap);
  }

  /** Total packets forwarded to Deepgram */
  get totalPackets() {
    return this.#totalPackets;
  }

  /**
   * Start capturing audio.
   * In direct mode (with connection), subscribes to speaking events.
   * In consumer mode, just marks the pipeline as ready to receive streams.
   */
  start() {
    if (this.#running) {
      this.emit('warning', 'AudioCapturePipeline.start() called while already running');
      return;
    }

    this.#running = true;

    // Direct mode: listen for speaking events on the VoiceReceiver
    if (this.#receiver) {
      this.#onSpeakingStart = (userId) => this.#handleSpeakingStart(userId);
      this.#onSpeakingEnd = (userId) => this.#handleSpeakingEnd(userId);

      this.#receiver.speaking.on('start', this.#onSpeakingStart);
      this.#receiver.speaking.on('end', this.#onSpeakingEnd);
    }

    console.log(`[AudioPipeline] Started — mode=${this.#receiver ? 'direct' : 'consumer'}`);
  }

  /**
   * Stop capturing audio, clean up all streams and listeners.
   */
  stop() {
    if (!this.#running) return;

    this.#running = false;

    // Remove speaking event listeners (direct mode)
    if (this.#receiver && this.#onSpeakingStart) {
      this.#receiver.speaking.removeListener('start', this.#onSpeakingStart);
      this.#onSpeakingStart = null;
    }
    if (this.#receiver && this.#onSpeakingEnd) {
      this.#receiver.speaking.removeListener('end', this.#onSpeakingEnd);
      this.#onSpeakingEnd = null;
    }

    // Destroy all active streams
    for (const [userId] of this.#activeStreams) {
      this.#destroyUserStream(userId, 'pipeline_stopped');
    }
    this.#activeStreams.clear();

    console.log(`[AudioPipeline] Stopped — total packets forwarded: ${this.#totalPackets}`);
  }

  /**
   * Add an externally-provided Opus stream for a user (consumer mode).
   * Can also be used in direct mode to manually add a stream.
   * @param {string} userId - Discord user ID
   * @param {import('stream').Readable} stream - Opus audio stream
   * @param {string} [username] - Optional display name
   */
  addStream(userId, stream, username) {
    if (!this.#running) {
      this.emit('warning', `addStream called while pipeline is not running (user=${userId})`);
      return;
    }

    if (this.#activeStreams.has(userId)) {
      // Already tracking this user — ignore duplicate
      return;
    }

    if (this.#activeStreams.size >= MAX_CONCURRENT_STREAMS) {
      this.emit('warning', `Max concurrent streams (${MAX_CONCURRENT_STREAMS}) reached, ignoring user ${userId}`);
      return;
    }

    const resolvedName = username || this.#userMap.get(userId) || `User-${userId.slice(-4)}`;
    this.#userMap.set(userId, resolvedName);

    const streamInfo = {
      userId,
      username: resolvedName,
      stream,
      packetCount: 0,
      startedAt: Date.now(),
    };

    this.#activeStreams.set(userId, streamInfo);
    this.emit('user_speaking', { userId, username: resolvedName });

    // Wire up the stream
    this.#wireStream(userId, stream);

    // Resolve username async if we used a placeholder
    if (resolvedName.startsWith('User-')) {
      this.#resolveUsername(userId)
        .then((resolved) => {
          if (resolved && resolved !== resolvedName) {
            streamInfo.username = resolved;
            this.#userMap.set(userId, resolved);
          }
        })
        .catch(() => {});
    }
  }

  /**
   * Handle a user starting to speak (direct mode) — subscribe and wire stream.
   * @param {string} userId
   */
  #handleSpeakingStart(userId) {
    if (!this.#running) return;
    if (this.#activeStreams.has(userId)) return;

    if (this.#activeStreams.size >= MAX_CONCURRENT_STREAMS) {
      this.emit('warning', `Max concurrent streams (${MAX_CONCURRENT_STREAMS}) reached, ignoring user ${userId}`);
      return;
    }

    // Use cached username or placeholder
    let username = this.#userMap.get(userId) || `User-${userId.slice(-4)}`;

    // Subscribe to Opus audio (synchronous — must not delay)
    const opusStream = this.#receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: SILENCE_TIMEOUT_MS,
      },
    });

    const streamInfo = {
      userId,
      username,
      stream: opusStream,
      packetCount: 0,
      startedAt: Date.now(),
    };

    this.#activeStreams.set(userId, streamInfo);
    this.#userMap.set(userId, username);
    this.emit('user_speaking', { userId, username });

    // Resolve username async
    if (username.startsWith('User-')) {
      this.#resolveUsername(userId)
        .then((resolved) => {
          if (resolved && resolved !== username) {
            streamInfo.username = resolved;
            this.#userMap.set(userId, resolved);
          }
        })
        .catch(() => {});
    }

    this.#wireStream(userId, opusStream);
  }

  /**
   * Wire data/end/error/close handlers on a stream to forward audio to Deepgram.
   * @param {string} userId
   * @param {import('stream').Readable} stream
   */
  #wireStream(userId, stream) {
    stream.on('data', (opusPacket) => {
      this.#forwardAudio(userId, opusPacket);
    });

    stream.on('end', () => {
      this.#cleanupUserStream(userId);
    });

    stream.on('error', (err) => {
      this.emit('error', new Error(`Audio stream error for user ${userId}: ${err.message}`));
      this.#cleanupUserStream(userId);
    });

    stream.on('close', () => {
      this.#cleanupUserStream(userId);
    });
  }

  /**
   * Handle a user stopping to speak.
   * @param {string} userId
   */
  #handleSpeakingEnd(userId) {
    const info = this.#activeStreams.get(userId);
    if (!info) return;

    const username = this.#userMap.get(userId) || userId;
    this.emit('user_silent', { userId, username });
  }

  /**
   * Forward an Opus audio packet from a user to Deepgram.
   * @param {string} userId
   * @param {Buffer} opusPacket - Raw Opus packet from Discord
   */
  #forwardAudio(userId, opusPacket) {
    if (!this.#running) return;

    if (!this.#deepgramClient.isConnected) {
      this.emit('audio_dropped', { userId, reason: 'deepgram_not_connected' });
      return;
    }

    const sent = this.#deepgramClient.send(opusPacket);

    if (sent) {
      this.#totalPackets++;
      const info = this.#activeStreams.get(userId);
      if (info) info.packetCount++;

      // Record activity for speaker identification — correlates Discord user
      // with the audio time window so Deepgram speaker labels can be mapped back
      this.#speakerIdentifier.recordActivity(userId);

      this.emit('audio_forwarded', { userId, byteLength: opusPacket.length });
    } else {
      this.emit('audio_dropped', { userId, reason: 'send_failed' });
    }
  }

  /**
   * Clean up a user's audio stream after it ends.
   * @param {string} userId
   */
  #cleanupUserStream(userId) {
    const info = this.#activeStreams.get(userId);
    if (!info) return;

    this.#activeStreams.delete(userId);

    const duration = Date.now() - info.startedAt;
    console.log(
      `[AudioPipeline] Stream ended: user=${info.username} packets=${info.packetCount} duration=${duration}ms`
    );
  }

  /**
   * Forcefully destroy a user's audio stream.
   * @param {string} userId
   * @param {string} reason
   */
  #destroyUserStream(userId, reason) {
    const info = this.#activeStreams.get(userId);
    if (!info) return;

    try {
      if (!info.stream.destroyed) {
        info.stream.destroy();
      }
    } catch (err) {
      this.emit('error', new Error(`Failed to destroy stream for ${userId}: ${err.message}`));
    }

    console.log(
      `[AudioPipeline] Stream destroyed: user=${info.username} reason=${reason} packets=${info.packetCount}`
    );
  }

  /**
   * Get current pipeline statistics.
   * @returns {{ running: boolean, activeStreams: number, totalPackets: number, participants: number, users: Array }}
   */
  getStats() {
    const users = [];
    for (const [userId, info] of this.#activeStreams) {
      users.push({
        userId,
        username: info.username,
        packetCount: info.packetCount,
        duration: Date.now() - info.startedAt,
      });
    }

    return {
      running: this.#running,
      activeStreams: this.#activeStreams.size,
      totalPackets: this.#totalPackets,
      participants: this.#userMap.size,
      users,
    };
  }

  /**
   * Register a known user mapping (e.g., from guild member cache).
   * @param {string} userId
   * @param {string} username
   */
  registerUser(userId, username) {
    this.#userMap.set(userId, username);
    this.#speakerIdentifier.registerUser(userId, username);
  }
}

export { SILENCE_TIMEOUT_MS, MAX_CONCURRENT_STREAMS };
