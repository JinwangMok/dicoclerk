/**
 * Opus Decoder Pool
 *
 * Manages per-user Opus→PCM/linear16 decoding for Discord voice audio.
 *
 * Discord's voice receiver emits raw Opus frames (RTP payloads) at:
 *   - 48 000 Hz sample rate
 *   - 2 channels (stereo)
 *   - 960 samples per frame (20 ms)
 *
 * Deepgram's live streaming WebSocket API expects:
 *   - encoding: 'linear16' (raw signed 16-bit PCM, little-endian)
 *   - sample_rate: 48000
 *   - channels: 1 (mono — better for STT accuracy and lower bandwidth)
 *
 * For each Discord user, a dedicated OpusScript decoder is maintained so that
 * the Opus codec state (packet-loss concealment, discontinuous transmission)
 * is kept consistent across that user's stream.
 *
 * Stereo→mono mixing:
 *   - Average left and right Int16 samples after decoding
 *   - Clamp result to [-32768, 32767] to prevent overflow
 */

import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

// opusscript is a CommonJS package; use createRequire for ESM compatibility
const require = createRequire(import.meta.url);

/** @type {typeof import('opusscript')} */
let OpusScript;
try {
  OpusScript = require('opusscript');
} catch {
  // opusscript is optional — callers must check isAvailable before using
  OpusScript = null;
}

/** Discord voice audio constants */
export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;     // stereo Opus from Discord
export const DISCORD_FRAME_SIZE = 960; // 20 ms @ 48 kHz

/** Output audio constants (for Deepgram linear16) */
export const OUTPUT_SAMPLE_RATE = 48_000;
export const OUTPUT_CHANNELS = 1; // mono for STT

/**
 * @typedef {Object} DecodeResult
 * @property {boolean} ok          - Whether decoding succeeded
 * @property {Buffer|null} pcm     - Decoded mono linear16 PCM, or null on failure
 * @property {string|null} error   - Error message on failure
 */

/**
 * Per-user Opus decoder pool.
 *
 * Events emitted:
 * - 'decode_error'  : { userId, error } — decoding failure (packet skipped)
 * - 'warning'       : string — non-fatal issue
 */
export class OpusDecoderPool extends EventEmitter {
  /** @type {Map<string, import('opusscript')>} userId -> OpusScript decoder instance */
  #decoders = new Map();

  /** @type {number} total successfully decoded packets */
  #decodedCount = 0;

  /** @type {number} total failed decode attempts */
  #errorCount = 0;

  /**
   * Whether opusscript is available in this environment.
   * If false, decode() will return the raw input unchanged (passthrough mode).
   * @type {boolean}
   */
  static get isAvailable() {
    return OpusScript !== null;
  }

  /**
   * Decode a raw Opus frame for the given user.
   *
   * Creates a per-user decoder on first call for that userId. Returns
   * decoded mono linear16 PCM as a Buffer, ready to send to Deepgram.
   *
   * On decode error, emits 'decode_error' and returns null (caller should
   * skip the packet).
   *
   * If opusscript is unavailable, returns the raw input buffer (passthrough).
   *
   * @param {string} userId      - Discord user ID (used to key the decoder)
   * @param {Buffer} opusPacket  - Raw Opus frame from @discordjs/voice
   * @returns {Buffer|null}      - Mono linear16 PCM buffer, or null on failure
   */
  decode(userId, opusPacket) {
    if (!OpusScript) {
      // Passthrough mode — opusscript not installed
      return opusPacket;
    }

    try {
      const decoder = this.#getOrCreateDecoder(userId);
      const stereoBuffer = decoder.decode(opusPacket, DISCORD_FRAME_SIZE);
      const monoBuffer = this.#stereoToMono(stereoBuffer);

      this.#decodedCount++;
      return monoBuffer;
    } catch (err) {
      this.#errorCount++;
      this.emit('decode_error', { userId, error: err.message });
      return null; // Caller should skip this packet
    }
  }

  /**
   * Release the decoder for a specific user.
   * Call when a user's audio stream ends to free memory.
   *
   * @param {string} userId
   */
  deleteDecoder(userId) {
    const decoder = this.#decoders.get(userId);
    if (decoder) {
      try {
        // opusscript allocates WebAssembly memory — delete cleans it up
        if (typeof decoder.delete === 'function') {
          decoder.delete();
        }
      } catch {
        // Ignore cleanup errors
      }
      this.#decoders.delete(userId);
    }
  }

  /**
   * Release all decoders. Call when the session ends.
   */
  destroy() {
    for (const userId of this.#decoders.keys()) {
      this.deleteDecoder(userId);
    }
    this.#decoders.clear();
    this.removeAllListeners();
  }

  /**
   * Number of active per-user decoder instances.
   * @type {number}
   */
  get activeDecoderCount() {
    return this.#decoders.size;
  }

  /**
   * Total packets successfully decoded.
   * @type {number}
   */
  get decodedCount() {
    return this.#decodedCount;
  }

  /**
   * Total decode failures.
   * @type {number}
   */
  get errorCount() {
    return this.#errorCount;
  }

  // ──────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────

  /**
   * Get or create an OpusScript decoder for the given user.
   * @param {string} userId
   * @returns {import('opusscript')}
   */
  #getOrCreateDecoder(userId) {
    if (this.#decoders.has(userId)) {
      return this.#decoders.get(userId);
    }

    const decoder = new OpusScript(
      DISCORD_SAMPLE_RATE,
      DISCORD_CHANNELS,
      OpusScript.Application.VOIP,
    );

    this.#decoders.set(userId, decoder);
    return decoder;
  }

  /**
   * Mix a stereo (2-channel) linear16 PCM Buffer to mono.
   *
   * Input: interleaved Int16LE samples [ L0, R0, L1, R1, ... ]
   * Output: Int16LE mono samples       [ M0, M1, ... ]
   *   where M_i = clamp( (L_i + R_i) / 2 )
   *
   * @param {Buffer} stereoBuffer - Decoded stereo PCM from opusscript
   * @returns {Buffer} Mono PCM buffer (half the byte length of input)
   */
  #stereoToMono(stereoBuffer) {
    // Each sample is 2 bytes; stereo frame has 2 samples per output sample
    const outputSamples = stereoBuffer.length / 4; // 4 bytes per stereo sample pair
    const mono = Buffer.allocUnsafe(outputSamples * 2); // 2 bytes per mono sample

    for (let i = 0; i < outputSamples; i++) {
      const left  = stereoBuffer.readInt16LE(i * 4);
      const right = stereoBuffer.readInt16LE(i * 4 + 2);

      // Average and clamp to Int16 range
      const mixed = Math.trunc((left + right) / 2);
      const clamped = Math.max(-32768, Math.min(32767, mixed));

      mono.writeInt16LE(clamped, i * 2);
    }

    return mono;
  }
}
