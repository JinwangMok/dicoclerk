/**
 * Audio Capture Pipeline
 *
 * Bridges Discord voice audio streams and the Deepgram streaming STT client.
 * Supports two operating modes:
 *
 * 1. **Direct mode**: Attaches to a VoiceConnection's receiver, subscribes to
 *    per-user Opus streams on speaking events, and forwards audio to Deepgram.
 *
 * 2. **Consumer mode**: Accepts externally-provided Opus streams (e.g. from
 *    SessionManager's audioStream events) via `addStream(userId, stream)`.
 *
 * Audio encoding pipeline:
 *   Discord → raw Opus frames → OpusDecoderPool (per-user) → linear16 PCM → Deepgram
 *
 * When an `opusDecoder` (OpusDecoderPool) is provided, each Opus frame is decoded
 * to mono linear16 PCM before being sent to Deepgram (encoding: 'linear16').
 * When no decoder is provided the raw packet is forwarded as-is (passthrough mode,
 * useful for unit tests or when Deepgram is configured for encoding: 'opus').
 *
 * A userId-to-username map is maintained for correlating Deepgram diarization
 * labels with Discord user identities.
 */

import { EventEmitter } from 'node:events';
import { EndBehaviorType } from '@discordjs/voice';
import { SpeakerIdentifier } from '../stt/speaker-identifier.js';

/** How long (ms) to keep a user's stream open after they stop speaking */
const SILENCE_TIMEOUT_MS = 200;

/** Max concurrent user streams to prevent resource exhaustion */
const MAX_CONCURRENT_STREAMS = 15;

/**
 * Per-user packet ring buffer capacity.
 * At 20 ms/frame, 200 packets ≈ 4 seconds of buffered audio per user.
 * When the buffer is full the oldest packet is evicted so new packets are
 * always captured (tail-drop policy).
 */
const MAX_USER_BUFFER_PACKETS = 200;

/**
 * @typedef {Object} AudioPipelineOptions
 * @property {import('../stt/deepgram-client.js').DeepgramStreamingClient} deepgramClient - Deepgram streaming client
 * @property {import('@discordjs/voice').VoiceConnection} [connection] - Discord voice connection (for direct mode)
 * @property {Function} [resolveUsername] - Async function to resolve userId -> display name
 * @property {import('./opus-decoder.js').OpusDecoderPool} [opusDecoder] - Per-user Opus→linear16 decoder pool
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
 * - 'decode_error'     : { userId, error } - Opus decoding failed (packet skipped)
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

  /** @type {import('./opus-decoder.js').OpusDecoderPool|null} */
  #opusDecoder;

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
   * Per-user ring buffers for decoded audio packets queued while Deepgram
   * is temporarily disconnected. Drained after reconnection.
   * @type {Map<string, Buffer[]>}
   */
  #userBuffers;

  /**
   * @param {AudioPipelineOptions} options
   */
  constructor({ connection, deepgramClient, resolveUsername, speakerIdentifier, opusDecoder } = {}) {
    super();

    if (!deepgramClient) throw new Error('DeepgramStreamingClient is required');

    this.#connection = connection || null;
    this.#receiver = connection?.receiver || null;
    this.#deepgramClient = deepgramClient;
    this.#opusDecoder = opusDecoder || null;
    this.#resolveUsername = resolveUsername || (async (id) => `User-${id.slice(-4)}`);
    this.#activeStreams = new Map();
    this.#userMap = new Map();
    this.#userBuffers = new Map();
    this.#running = false;
    this.#totalPackets = 0;
    this.#onSpeakingStart = null;
    this.#onSpeakingEnd = null;
    this.#speakerIdentifier = speakerIdentifier || new SpeakerIdentifier();

    // Forward decode errors from the pool as pipeline events
    if (this.#opusDecoder) {
      this.#opusDecoder.on('decode_error', ({ userId, error }) => {
        this.emit('decode_error', { userId, error });
      });
    }
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

  /** Whether Opus→PCM decoding is active */
  get isDecoding() {
    return this.#opusDecoder !== null;
  }

  /**
   * Total decoded audio packets currently held in per-user ring buffers.
   * Non-zero only during a Deepgram disconnection window.
   * @type {number}
   */
  get bufferedPacketCount() {
    let total = 0;
    for (const buf of this.#userBuffers.values()) total += buf.length;
    return total;
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

    const decoderMode = this.#opusDecoder ? 'opus→linear16' : 'passthrough';
    console.log(`[AudioPipeline] Started — mode=${this.#receiver ? 'direct' : 'consumer'} encoding=${decoderMode}`);
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

    // Destroy the Opus decoder pool to free WebAssembly memory
    if (this.#opusDecoder) {
      this.#opusDecoder.destroy();
      this.#opusDecoder = null;
    }

    // Discard all per-user packet buffers
    this.#userBuffers.clear();

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
   * Forward an audio packet from a user to Deepgram.
   *
   * Decoding always happens BEFORE the connectivity check so that the
   * per-user Opus codec state advances in step with the incoming stream.
   * This prevents desynchronisation when the connection is restored and
   * we replay buffered PCM frames.
   *
   * When Deepgram is connected:   decoded PCM is sent immediately.
   * When Deepgram is disconnected: decoded PCM is queued in a per-user
   *   ring buffer (capacity MAX_USER_BUFFER_PACKETS). The oldest packet
   *   is evicted when the buffer is full (tail-drop, with 'audio_dropped'
   *   emitted as reason 'buffer_overflow').
   *
   * In passthrough mode (no decoder), the raw packet is forwarded / buffered.
   *
   * @param {string} userId
   * @param {Buffer} opusPacket - Raw Opus packet from Discord's voice receiver
   */
  #forwardAudio(userId, opusPacket) {
    if (!this.#running) return;

    // --- Step 1: Decode Opus → linear16 PCM (always, to keep codec state current) ---
    let audioData = opusPacket;
    if (this.#opusDecoder) {
      const pcm = this.#opusDecoder.decode(userId, opusPacket);
      if (pcm === null) {
        // decode() already emitted 'decode_error'; drop the packet
        this.emit('audio_dropped', { userId, reason: 'decode_failed' });
        return;
      }
      audioData = pcm;
    }

    // --- Step 2: Send or buffer ---
    if (!this.#deepgramClient.isConnected) {
      // Buffer the decoded packet for replay after reconnection
      let buf = this.#userBuffers.get(userId);
      if (!buf) {
        buf = [];
        this.#userBuffers.set(userId, buf);
      }

      if (buf.length >= MAX_USER_BUFFER_PACKETS) {
        // Evict oldest to make room (tail-drop)
        buf.shift();
        this.emit('audio_dropped', { userId, reason: 'buffer_overflow' });
      }

      buf.push(audioData);
      this.emit('audio_buffered', { userId, bufferedCount: buf.length });
      return;
    }

    // Drain any buffered packets for this user before sending the new one
    this.#drainUserBuffer(userId);

    const sent = this.#deepgramClient.send(audioData);

    if (sent) {
      this.#totalPackets++;
      const info = this.#activeStreams.get(userId);
      if (info) info.packetCount++;

      // Record activity for speaker identification — correlates Discord user
      // with the audio time window so Deepgram speaker labels can be mapped back
      this.#speakerIdentifier.recordActivity(userId);

      this.emit('audio_forwarded', { userId, byteLength: audioData.length });
    } else {
      this.emit('audio_dropped', { userId, reason: 'send_failed' });
    }
  }

  /**
   * Drain the per-user buffer for one user, sending all queued packets.
   * @param {string} userId
   * @returns {number} packets successfully sent
   */
  #drainUserBuffer(userId) {
    const buf = this.#userBuffers.get(userId);
    if (!buf || buf.length === 0) return 0;

    let sent = 0;
    while (buf.length > 0 && this.#deepgramClient.isConnected) {
      const packet = buf.shift();
      if (this.#deepgramClient.send(packet)) {
        sent++;
        this.#totalPackets++;
        const info = this.#activeStreams.get(userId);
        if (info) info.packetCount++;
        this.#speakerIdentifier.recordActivity(userId);
      } else {
        // Send failed — put it back at the front and stop draining
        buf.unshift(packet);
        break;
      }
    }

    if (sent > 0) {
      this.emit('buffer_drained', { userId, drainedCount: sent });
    }

    return sent;
  }

  /**
   * Drain all per-user packet buffers by attempting to send each buffered
   * packet to Deepgram immediately.
   *
   * Call this after a Deepgram reconnection so that audio captured during
   * the outage is forwarded before new live packets arrive.
   *
   * @returns {number} Total packets successfully drained across all users.
   */
  drainAllUserBuffers() {
    if (!this.#running) return 0;
    if (!this.#deepgramClient.isConnected) return 0;

    let total = 0;
    for (const [userId] of this.#userBuffers) {
      total += this.#drainUserBuffer(userId);
    }

    if (total > 0) {
      console.log(`[AudioPipeline] Drained ${total} buffered packets across all users after reconnect`);
    }

    return total;
  }

  /**
   * Clean up a user's audio stream after it ends.
   * Also releases the per-user Opus decoder if one is held.
   * @param {string} userId
   */
  #cleanupUserStream(userId) {
    const info = this.#activeStreams.get(userId);
    if (!info) return;

    this.#activeStreams.delete(userId);

    // Release per-user Opus decoder to free WebAssembly memory
    if (this.#opusDecoder) {
      this.#opusDecoder.deleteDecoder(userId);
    }

    // Discard any buffered packets for this user
    this.#userBuffers.delete(userId);

    const duration = Date.now() - info.startedAt;
    console.log(
      `[AudioPipeline] Stream ended: user=${info.username} packets=${info.packetCount} duration=${duration}ms`
    );
  }

  /**
   * Forcefully destroy a user's audio stream.
   * Also releases the per-user Opus decoder if one is held.
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

    // Release per-user Opus decoder to free WebAssembly memory
    if (this.#opusDecoder) {
      this.#opusDecoder.deleteDecoder(userId);
    }

    console.log(
      `[AudioPipeline] Stream destroyed: user=${info.username} reason=${reason} packets=${info.packetCount}`
    );
  }

  /**
   * Get current pipeline statistics.
   * @returns {{ running: boolean, activeStreams: number, totalPackets: number, participants: number, users: Array, decoderStats: Object|null }}
   */
  getStats() {
    let totalBufferedPackets = 0;
    const users = [];

    for (const [userId, info] of this.#activeStreams) {
      const bufferedPackets = this.#userBuffers.get(userId)?.length ?? 0;
      totalBufferedPackets += bufferedPackets;
      users.push({
        userId,
        username: info.username,
        packetCount: info.packetCount,
        bufferedPackets,
        duration: Date.now() - info.startedAt,
      });
    }

    return {
      running: this.#running,
      activeStreams: this.#activeStreams.size,
      totalPackets: this.#totalPackets,
      totalBufferedPackets,
      participants: this.#userMap.size,
      users,
      decoderStats: this.#opusDecoder
        ? {
            activeDecoders: this.#opusDecoder.activeDecoderCount,
            decodedPackets: this.#opusDecoder.decodedCount,
            decodeErrors: this.#opusDecoder.errorCount,
          }
        : null,
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

export { SILENCE_TIMEOUT_MS, MAX_CONCURRENT_STREAMS, MAX_USER_BUFFER_PACKETS };
