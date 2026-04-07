/**
 * Deepgram Diarization Configuration
 *
 * Centralises all speaker-diarization parameters for the Deepgram live
 * transcription API.  Exported constants are consumed by DeepgramStreamingClient
 * and DeepgramConnectionPool so that every connection in the pool uses identical
 * diarization settings.
 *
 * Design notes
 * ─────────────
 * • dicoclerk feeds Deepgram a single mono PCM stream that already contains
 *   the mixed audio of all channel participants.  Multichannel mode is therefore
 *   NOT used; Deepgram's server-side diarization separates speakers from the
 *   single mixed stream.
 *
 * • nova-2 is the model that best handles Korean/English code-switching and
 *   supports diarize_max_speakers up to 10 for the "general" tier.
 *
 * • utterance_end_ms + endpointing together gate how aggressively Deepgram
 *   finalises segments, which directly affects diarization granularity.
 *   Longer endpointing windows give the diarizer more context but increase
 *   transcript latency.  1 500 ms has been empirically good for meeting audio.
 *
 * • When a single Deepgram Results event contains words attributed to more than
 *   one speaker (mid-segment speaker transitions), the client must split the
 *   result into per-speaker sub-events before passing to the transcript store.
 *   See DeepgramStreamingClient.#handleTranscriptResult for that logic.
 */

// ──────────────────────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Maximum number of concurrent Discord voice channel participants dicoclerk is
 * designed to support.  Used as the upper bound for diarize_max_speakers.
 */
export const MAX_SPEAKERS = 10;

/**
 * Deepgram STT model used for all live transcription connections.
 * nova-2 is required for:
 *   - Multilingual diarization (Korean + English code-switching)
 *   - diarize_max_speakers up to 10
 *   - Best word-error-rate on Korean conversational audio
 */
export const DIARIZATION_MODEL = 'nova-2';

/**
 * Deepgram live transcription options focused on speaker diarization.
 *
 * These options are MERGED (not overridden) with DEFAULT_LIVE_OPTIONS in
 * DeepgramStreamingClient so that audio encoding settings remain in one place.
 *
 * @type {Object}
 */
export const DIARIZATION_OPTIONS = {
  // ── Model ──────────────────────────────────────────────────────────────────
  model: DIARIZATION_MODEL,

  // ── Language ────────────────────────────────────────────────────────────────
  /**
   * Primary language hint.  Korean is the dominant language in meetings but
   * participants may switch to English mid-sentence.  detect_language=true
   * lets Deepgram handle per-utterance language detection automatically.
   *
   * Supported values for nova-2: 'ko', 'en', 'multi', etc.
   * Setting 'ko' with detect_language=true is the recommended pattern for
   * Korean-primary bilingual audio per Deepgram's multilingual guide.
   */
  language: 'ko',
  detect_language: true,

  // ── Diarization ─────────────────────────────────────────────────────────────
  /**
   * Enable speaker diarization.  Deepgram assigns each word a `speaker` field
   * (0-indexed integer) that identifies the speaker.
   */
  diarize: true,

  /**
   * Maximum number of distinct speakers the diarizer will track per session.
   * Must be >= MAX_SPEAKERS (10) to handle full channel capacity.
   *
   * Deepgram's nova-2 model supports up to 64 speakers per session but
   * setting a tight upper bound improves accuracy by constraining the model.
   * 10 matches the maximum Discord voice channel participant count we support.
   */
  diarize_max_speakers: MAX_SPEAKERS,

  // ── Segmentation ────────────────────────────────────────────────────────────
  /**
   * Endpointing (ms): how long Deepgram waits after the last voiced frame
   * before it finalises a segment with is_final=true.
   *
   * 300 ms is a good trade-off for meeting audio:
   *   - Short enough not to merge utterances from different speakers
   *   - Long enough to avoid splitting fast speech into micro-segments
   *
   * Note: This is distinct from utterance_end_ms (which triggers the
   * UtteranceEnd VAD event); both gates are active simultaneously.
   */
  endpointing: 300,

  /**
   * How long (ms) of trailing silence Deepgram waits before emitting an
   * UtteranceEnd event.  1 500 ms works well for Korean meeting speech where
   * natural pauses between sentences can exceed 500 ms.
   */
  utterance_end_ms: 1500,

  // ── Quality ─────────────────────────────────────────────────────────────────
  smart_format: true,   // Add punctuation, capitalisation, paragraphs
  punctuate: true,       // Sentence-ending punctuation
  interim_results: true, // Stream partial results for low-latency display
  vad_events: true,      // Emit SpeechStarted / UtteranceEnd VAD events

  // ── Multichannel ─────────────────────────────────────────────────────────────
  /**
   * multichannel is intentionally NOT set (defaults to false).
   *
   * dicoclerk mixes all participant audio into a single mono PCM stream before
   * forwarding to Deepgram.  Enabling multichannel mode would require sending
   * separate audio channels per speaker which is incompatible with Discord's
   * per-user Opus stream architecture (each user's stream is decoded and mixed
   * downstream at the OpusDecoderPool level).
   *
   * Speaker separation is handled entirely by Deepgram's server-side diarizer
   * operating on the mono mix.
   */
};

// ──────────────────────────────────────────────────────────────────────────────
// Factory & validation helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a validated set of Deepgram live transcription options for diarization.
 *
 * Merges DIARIZATION_OPTIONS with caller-supplied overrides.  Validates that
 * diarization invariants (diarize=true, diarize_max_speakers>=MAX_SPEAKERS,
 * correct model) are preserved after the merge.
 *
 * @param {Object} [overrides={}] - Caller-supplied option overrides.
 *   Any key valid in the Deepgram live transcription API is accepted.
 *   Attempting to disable diarize or set diarize_max_speakers < MAX_SPEAKERS
 *   will throw a TypeError.
 * @returns {Object} Merged, validated live options.
 * @throws {TypeError} If diarization invariants are violated.
 *
 * @example
 * // Use default diarization options
 * const opts = buildDiarizationOptions();
 *
 * @example
 * // Override language but keep all diarization settings
 * const opts = buildDiarizationOptions({ language: 'en' });
 */
export function buildDiarizationOptions(overrides = {}) {
  const merged = { ...DIARIZATION_OPTIONS, ...overrides };
  validateDiarizationOptions(merged);
  return merged;
}

/**
 * Validate that a Deepgram live options object meets diarization requirements.
 *
 * Rules:
 *  1. diarize must be true
 *  2. diarize_max_speakers must be a number >= MAX_SPEAKERS
 *  3. model must be set (non-empty string)
 *
 * @param {Object} options - Deepgram live options to validate.
 * @throws {TypeError} If any rule is violated.
 */
export function validateDiarizationOptions(options) {
  if (options.diarize !== true) {
    throw new TypeError(
      `[diarization-config] diarize must be true for speaker identification; ` +
      `got ${JSON.stringify(options.diarize)}`
    );
  }

  if (
    typeof options.diarize_max_speakers !== 'number' ||
    options.diarize_max_speakers < MAX_SPEAKERS
  ) {
    throw new TypeError(
      `[diarization-config] diarize_max_speakers must be a number >= ${MAX_SPEAKERS} ` +
      `to support up to ${MAX_SPEAKERS} concurrent participants; ` +
      `got ${JSON.stringify(options.diarize_max_speakers)}`
    );
  }

  if (!options.model || typeof options.model !== 'string') {
    throw new TypeError(
      `[diarization-config] model must be a non-empty string; ` +
      `got ${JSON.stringify(options.model)}`
    );
  }
}

/**
 * Extract per-speaker word groups from a Deepgram transcript alternative.
 *
 * Deepgram assigns a `speaker` integer to each word when diarize=true.
 * A single Results event may contain words from multiple speakers when a
 * speaker transition occurs mid-segment.  This function groups consecutive
 * words by speaker so callers can emit one transcript event per speaker.
 *
 * Consecutive words with the same speaker are grouped together.  Each group
 * includes the aggregate text, speaker label, time range (start/end), and
 * per-word confidence average.
 *
 * @param {Array<Object>} words - Word objects from alternative.words.
 *   Each word: { word, punctuated_word?, speaker, start, end, confidence }
 * @returns {Array<SpeakerSegment>} Ordered list of per-speaker groups.
 *
 * @typedef {Object} SpeakerSegment
 * @property {number}   speaker    - Deepgram speaker label (0-indexed)
 * @property {string}   text       - Space-joined transcript for this segment
 * @property {number}   start      - Start time in seconds
 * @property {number}   end        - End time in seconds
 * @property {number}   confidence - Average word confidence
 * @property {Object[]} words      - Raw word objects in this segment
 *
 * @example
 * // Single speaker — returns one group
 * groupWordsBySpeaker([
 *   { word: 'hello', speaker: 0, start: 0, end: 0.4, confidence: 0.9 },
 *   { word: 'world', speaker: 0, start: 0.5, end: 0.9, confidence: 0.95 },
 * ]);
 * // → [{ speaker: 0, text: 'hello world', start: 0, end: 0.9, confidence: 0.925, words: [...] }]
 *
 * @example
 * // Two speakers mid-segment — returns two groups
 * groupWordsBySpeaker([
 *   { word: '안녕', speaker: 0, start: 0, end: 0.5, confidence: 0.9 },
 *   { word: 'yes', speaker: 1, start: 0.6, end: 0.9, confidence: 0.85 },
 * ]);
 * // → [{ speaker: 0, text: '안녕', ... }, { speaker: 1, text: 'yes', ... }]
 */
export function groupWordsBySpeaker(words) {
  if (!Array.isArray(words) || words.length === 0) return [];

  const groups = [];
  let currentGroup = null;

  for (const word of words) {
    const speaker = word.speaker ?? -1;
    const wordText = word.punctuated_word ?? word.word ?? '';

    if (!currentGroup || currentGroup.speaker !== speaker) {
      // Start a new speaker group
      currentGroup = {
        speaker,
        text: wordText,
        start: word.start ?? 0,
        end: word.end ?? 0,
        confidence: word.confidence ?? 0,
        words: [word],
        _confidenceSum: word.confidence ?? 0,
        _wordCount: 1,
      };
      groups.push(currentGroup);
    } else {
      // Extend the current group
      currentGroup.text += wordText ? ` ${wordText}` : '';
      currentGroup.end = word.end ?? currentGroup.end;
      currentGroup._confidenceSum += word.confidence ?? 0;
      currentGroup._wordCount += 1;
      currentGroup.confidence = currentGroup._confidenceSum / currentGroup._wordCount;
      currentGroup.words.push(word);
    }
  }

  // Clean up internal bookkeeping fields
  for (const g of groups) {
    delete g._confidenceSum;
    delete g._wordCount;
  }

  return groups;
}
