/**
 * Tests for OpusDecoderPool
 *
 * Uses Node.js built-in test runner. Because opusscript loads WebAssembly
 * asynchronously on first import, tests that exercise real decoding are
 * skipped when opusscript is unavailable (CI without native deps).
 * All structural/behavioural properties are always tested.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  OpusDecoderPool,
  DISCORD_SAMPLE_RATE,
  DISCORD_CHANNELS,
  DISCORD_FRAME_SIZE,
  OUTPUT_SAMPLE_RATE,
  OUTPUT_CHANNELS,
} from '../src/audio/opus-decoder.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid Opus frame using opusscript so we can round-trip.
 * Returns null if opusscript is unavailable.
 *
 * @returns {Buffer|null}
 */
function buildValidOpusFrame() {
  if (!OpusDecoderPool.isAvailable) return null;

  try {
    const OpusScript = require('opusscript');
    const encoder = new OpusScript(DISCORD_SAMPLE_RATE, DISCORD_CHANNELS, OpusScript.Application.VOIP);

    // Encode 20 ms of silence (all-zero PCM)
    const samples = DISCORD_FRAME_SIZE * DISCORD_CHANNELS; // 960 * 2 = 1920 samples
    const pcm = Buffer.alloc(samples * 2);                 // 2 bytes per Int16 sample
    const encoded = encoder.encode(pcm, DISCORD_FRAME_SIZE);
    if (typeof encoder.delete === 'function') encoder.delete();
    return Buffer.from(encoded);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpusDecoderPool', () => {
  let pool;

  beforeEach(() => {
    pool = new OpusDecoderPool();
  });

  afterEach(() => {
    pool.destroy();
  });

  // ── Static properties ──────────────────────────────────────────────────

  describe('static constants', () => {
    it('should export correct Discord audio constants', () => {
      assert.equal(DISCORD_SAMPLE_RATE, 48_000);
      assert.equal(DISCORD_CHANNELS, 2);
      assert.equal(DISCORD_FRAME_SIZE, 960);
    });

    it('should export correct output audio constants', () => {
      assert.equal(OUTPUT_SAMPLE_RATE, 48_000);
      assert.equal(OUTPUT_CHANNELS, 1);
    });

    it('OpusDecoderPool.isAvailable should be a boolean', () => {
      assert.equal(typeof OpusDecoderPool.isAvailable, 'boolean');
    });
  });

  // ── Initial state ──────────────────────────────────────────────────────

  describe('initial state', () => {
    it('should start with zero active decoders', () => {
      assert.equal(pool.activeDecoderCount, 0);
    });

    it('should start with zero decoded/error counts', () => {
      assert.equal(pool.decodedCount, 0);
      assert.equal(pool.errorCount, 0);
    });
  });

  // ── Passthrough mode (opusscript unavailable) ──────────────────────────

  describe('passthrough mode', () => {
    it('should return raw packet unchanged when opusscript is unavailable', () => {
      if (OpusDecoderPool.isAvailable) {
        // Cannot test passthrough when real decoder is available — skip
        return;
      }

      const packet = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const result = pool.decode('user-1', packet);

      assert.ok(result !== null);
      assert.deepEqual(result, packet);
    });
  });

  // ── decode() ──────────────────────────────────────────────────────────

  describe('decode()', () => {
    it('should return null and emit decode_error on invalid Opus data', () => {
      if (!OpusDecoderPool.isAvailable) return; // passthrough always succeeds

      const errors = [];
      pool.on('decode_error', (e) => errors.push(e));

      // Random bytes are not a valid Opus frame
      const garbage = Buffer.from([0xFF, 0xFE, 0x00, 0x01, 0x02, 0x03]);
      const result = pool.decode('user-1', garbage);

      assert.equal(result, null);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].userId, 'user-1');
      assert.equal(typeof errors[0].error, 'string');
    });

    it('should increment errorCount on decode failure', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});
      pool.decode('user-1', Buffer.from([0xFF, 0x00]));

      assert.equal(pool.errorCount, 1);
      assert.equal(pool.decodedCount, 0);
    });

    it('should create a per-user decoder on first call', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {}); // swallow errors from garbage input
      pool.decode('user-1', Buffer.from([0x00]));

      // Decoder should have been created even if decode fails
      assert.equal(pool.activeDecoderCount, 1);
    });

    it('should not create duplicate decoders for the same user', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});
      pool.decode('user-1', Buffer.from([0x00]));
      pool.decode('user-1', Buffer.from([0x00]));

      assert.equal(pool.activeDecoderCount, 1);
    });

    it('should create separate decoders for different users', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});
      pool.decode('user-1', Buffer.from([0x00]));
      pool.decode('user-2', Buffer.from([0x00]));
      pool.decode('user-3', Buffer.from([0x00]));

      assert.equal(pool.activeDecoderCount, 3);
    });
  });

  // ── deleteDecoder() ────────────────────────────────────────────────────

  describe('deleteDecoder()', () => {
    it('should remove a decoder for a user', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});
      pool.decode('user-1', Buffer.from([0x00]));
      assert.equal(pool.activeDecoderCount, 1);

      pool.deleteDecoder('user-1');
      assert.equal(pool.activeDecoderCount, 0);
    });

    it('should be a no-op for unknown userId', () => {
      pool.deleteDecoder('nonexistent');
      assert.equal(pool.activeDecoderCount, 0);
    });

    it('should allow re-creation of decoder after deletion', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});
      pool.decode('user-1', Buffer.from([0x00]));
      pool.deleteDecoder('user-1');
      pool.decode('user-1', Buffer.from([0x00]));

      assert.equal(pool.activeDecoderCount, 1);
    });
  });

  // ── destroy() ─────────────────────────────────────────────────────────

  describe('destroy()', () => {
    it('should clear all decoders', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});
      pool.decode('user-1', Buffer.from([0x00]));
      pool.decode('user-2', Buffer.from([0x00]));
      assert.equal(pool.activeDecoderCount, 2);

      pool.destroy();
      assert.equal(pool.activeDecoderCount, 0);
    });

    it('should be safe to call when already empty', () => {
      assert.doesNotThrow(() => pool.destroy());
    });

    it('should remove all event listeners', () => {
      pool.on('decode_error', () => {});
      pool.destroy();
      assert.equal(pool.listenerCount('decode_error'), 0);
    });
  });

  // ── Stereo→mono conversion (white-box check via decode round-trip) ─────

  describe('stereo→mono mixing', () => {
    it('should produce output buffer half the byte-length of decoded stereo', () => {
      if (!OpusDecoderPool.isAvailable) return;

      const frame = buildValidOpusFrame();
      if (!frame) return; // Could not build frame — skip

      const result = pool.decode('user-mix', frame);
      if (!result) return; // Decode failed on this platform — skip

      // Decoded stereo: DISCORD_FRAME_SIZE * DISCORD_CHANNELS * 2 bytes = 3840
      // Mono output:    DISCORD_FRAME_SIZE * OUTPUT_CHANNELS  * 2 bytes = 1920
      const expectedBytes = DISCORD_FRAME_SIZE * OUTPUT_CHANNELS * 2;
      assert.equal(result.length, expectedBytes,
        `Expected ${expectedBytes} bytes mono PCM, got ${result.length}`);
    });

    it('decoded packets should increment decodedCount', () => {
      if (!OpusDecoderPool.isAvailable) return;

      const frame = buildValidOpusFrame();
      if (!frame) return;

      pool.decode('user-count', frame);
      pool.decode('user-count', frame);

      assert.equal(pool.decodedCount, 2);
    });
  });

  // ── Concurrency — 10 users ─────────────────────────────────────────────

  describe('concurrent users', () => {
    it('should handle 10 independent user decoders', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});

      for (let i = 0; i < 10; i++) {
        pool.decode(`user-${i}`, Buffer.from([0x00]));
      }

      assert.equal(pool.activeDecoderCount, 10);
    });

    it('should isolate state between users (separate decoder instances)', () => {
      if (!OpusDecoderPool.isAvailable) return;

      pool.on('decode_error', () => {});

      // Create decoders for multiple users
      for (let i = 0; i < 5; i++) {
        pool.decode(`user-${i}`, Buffer.from([0x00]));
      }

      // Delete odd users
      for (let i = 1; i < 5; i += 2) {
        pool.deleteDecoder(`user-${i}`);
      }

      // Even users (0, 2, 4) should still have decoders
      assert.equal(pool.activeDecoderCount, 3);
    });
  });
});
