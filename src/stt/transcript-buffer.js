/**
 * Transcript Buffer
 *
 * Parses Deepgram real-time streaming responses with speaker diarization and
 * maintains an in-memory transcript buffer keyed by speaker ID.
 *
 * Key responsibilities:
 * - Parse `channel.alternatives[0].words` arrays from Deepgram results
 * - Group consecutive words by speaker diarization label into per-speaker segments
 * - Track interim (is_final: false) results per speaker and replace on update
 * - Promote interim entries to final on is_final: true, clearing the interim slot
 * - Resolve Deepgram speaker labels (0, 1, 2 …) to Discord display names / user IDs
 * - Deduplicate via UtteranceDeduplicator before storing
 * - Emit events for consumers (entry, interim, interim_cleared)
 *
 * This module is the JavaScript counterpart of src/stt/transcript.py and
 * operates within the Node.js bot process that connects to Deepgram directly.
 */

import { EventEmitter } from 'node:events';
import { UtteranceDeduplicator } from './dedup.js';

// ──────────────────────────────────────────────────────────────────
// Language detection
// ──────────────────────────────────────────────────────────────────

/**
 * Detect whether text is primarily Korean, English, or unknown.
 * Uses Hangul codepoint ranges as the signal.
 *
 * @param {string} text
 * @returns {'ko' | 'en' | 'unknown'}
 */
function detectLanguage(text) {
  if (!text) return 'unknown';

  let koreanChars = 0;
  let alphaChars = 0;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    // Hangul syllables: U+AC00–U+D7AF  |  Hangul compatibility jamo: U+3130–U+318F
    if ((cp >= 0xAC00 && cp <= 0xD7AF) || (cp >= 0x3130 && cp <= 0x318F)) {
      koreanChars++;
      alphaChars++;
    } else if (/\p{L}/u.test(ch)) {
      alphaChars++;
    }
  }

  if (alphaChars === 0) return 'unknown';
  return koreanChars / alphaChars > 0.3 ? 'ko' : 'en';
}

// ──────────────────────────────────────────────────────────────────
// Word grouping
// ──────────────────────────────────────────────────────────────────

/**
 * Group consecutive words by their speaker diarization label.
 *
 * @param {Array<Object>} words - Deepgram word objects with a `speaker` field
 * @returns {Array<{ speakerLabel: number, words: Array<Object> }>}
 */
function groupWordsBySpeaker(words) {
  if (!words || words.length === 0) return [];

  const groups = [];
  let currentLabel = words[0].speaker ?? 0;
  let currentGroup = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const label = words[i].speaker ?? 0;
    if (label === currentLabel) {
      currentGroup.push(words[i]);
    } else {
      groups.push({ speakerLabel: currentLabel, words: currentGroup });
      currentLabel = label;
      currentGroup = [words[i]];
    }
  }
  groups.push({ speakerLabel: currentLabel, words: currentGroup });

  return groups;
}

// ──────────────────────────────────────────────────────────────────
// Deepgram response parsing
// ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ParsedSegment
 * @property {number}   speakerLabel - Deepgram diarization label (integer)
 * @property {string}   text         - Joined, punctuated transcript text
 * @property {number}   start        - Segment start time (seconds from stream start)
 * @property {number}   end          - Segment end time (seconds)
 * @property {number}   duration     - end - start
 * @property {number}   confidence   - Average word-level confidence
 * @property {boolean}  isFinal      - Whether this is a final (non-interim) result
 * @property {boolean}  speechFinal  - Deepgram's speech_final flag
 * @property {Array}    words        - Raw word objects for this segment
 * @property {string}   language     - Detected language ('ko' | 'en' | 'unknown')
 */

/**
 * Parse a single Deepgram live-transcription result into per-speaker segments.
 *
 * Deepgram result shape (abbreviated):
 * ```json
 * {
 *   "type": "Results",
 *   "is_final": true,
 *   "speech_final": true,
 *   "start": 0.0,
 *   "duration": 2.5,
 *   "channel": {
 *     "alternatives": [{
 *       "transcript": "...",
 *       "confidence": 0.95,
 *       "words": [{ "word": "hi", "punctuated_word": "Hi", "speaker": 0,
 *                   "start": 0.1, "end": 0.3, "confidence": 0.95 }, ...]
 *     }]
 *   }
 * }
 * ```
 *
 * @param {Object} data - Raw Deepgram result object
 * @returns {ParsedSegment[]}
 */
function parseDeepgramResponse(data) {
  // Only process Results events
  if (data.type && data.type !== 'Results') return [];

  const channel = data.channel;
  if (!channel?.alternatives?.length) return [];

  const alternative = channel.alternatives[0];
  const isFinal = data.is_final ?? false;
  const speechFinal = data.speech_final ?? false;
  const streamStart = data.start ?? 0;

  const words = alternative.words ?? [];

  // Fallback: no word-level data — return a single speaker_0 segment
  if (words.length === 0) {
    const transcript = (alternative.transcript ?? '').trim();
    if (!transcript) return [];
    return [{
      speakerLabel: 0,
      text: transcript,
      start: streamStart,
      end: streamStart + (data.duration ?? 0),
      duration: data.duration ?? 0,
      confidence: alternative.confidence ?? 0,
      isFinal,
      speechFinal,
      words: [],
      language: detectLanguage(transcript),
    }];
  }

  // Group words by speaker then build a segment per group
  const groups = groupWordsBySpeaker(words);
  const segments = [];

  for (const group of groups) {
    const groupWords = group.words;
    const textParts = groupWords.map(w => w.punctuated_word ?? w.word ?? '');
    const text = textParts.join(' ').trim();
    if (!text) continue;

    const start = groupWords[0].start ?? streamStart;
    const end = groupWords[groupWords.length - 1].end ?? (start + (data.duration ?? 0));
    const duration = end - start;

    const confidences = groupWords.map(w => w.confidence ?? 0);
    const confidence = confidences.length > 0
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : 0;

    segments.push({
      speakerLabel: group.speakerLabel,
      text,
      start,
      end,
      duration,
      confidence,
      isFinal,
      speechFinal,
      words: groupWords,
      language: detectLanguage(text),
    });
  }

  return segments;
}

// ──────────────────────────────────────────────────────────────────
// TranscriptEntry shape
// ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} TranscriptEntry
 * @property {number}   speakerLabel  - Deepgram speaker diarization label
 * @property {string}   userId        - Discord user ID (null if unresolved)
 * @property {string}   displayName   - Human-readable speaker name
 * @property {string}   text          - Transcribed utterance text
 * @property {number}   timestamp     - Session-relative start (seconds from sessionStartTime)
 * @property {number}   duration      - Utterance duration in seconds
 * @property {boolean}  isFinal       - Whether this is a finalized entry
 * @property {number}   confidence    - Average confidence (0–1)
 * @property {string}   language      - 'ko' | 'en' | 'unknown'
 * @property {Array}    words         - Raw Deepgram word objects
 */

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer
// ──────────────────────────────────────────────────────────────────

/**
 * In-memory transcript buffer with per-speaker partitioning.
 *
 * - Final entries are appended to `#entries` (chronological list) and to
 *   `#entriesBySpeaker` (per-speaker list keyed by speakerLabel).
 * - Interim entries are stored in `#interimBySpeaker` keyed by speakerLabel.
 *   Each new interim for the same speaker replaces the previous one.
 *   When a final result arrives the interim slot is cleared.
 *
 * Events emitted:
 *   'entry'           { entry: TranscriptEntry }   — new final entry added
 *   'interim'         { entry: TranscriptEntry }   — new/updated interim entry
 *   'interim_cleared' { speakerLabel: number }      — interim cleared by final result
 *   'duplicate'       { text, speakerLabel, reason } — duplicate suppressed
 */
export class TranscriptBuffer extends EventEmitter {
  // ── Internal state ───────────────────────────────────────────────

  /** @type {TranscriptEntry[]} All finalized entries in chronological order */
  #entries = [];

  /**
   * Per-speaker interim state.
   * Maps speakerLabel → latest interim TranscriptEntry (null = no interim).
   * @type {Map<number, TranscriptEntry>}
   */
  #interimBySpeaker = new Map();

  /**
   * Per-speaker finalized entry lists.
   * Maps speakerLabel → TranscriptEntry[]
   * @type {Map<number, TranscriptEntry[]}>}
   */
  #entriesBySpeaker = new Map();

  /**
   * Speaker label → { userId: string|null, displayName: string } resolution map.
   * @type {Map<number, { userId: string|null, displayName: string }>}
   */
  #speakerResolutions = new Map();

  /** @type {UtteranceDeduplicator} */
  #deduplicator;

  /** Session wall-clock start time (ms) used to compute session-relative timestamps */
  #sessionStartMs;

  /** Total utterances submitted (including duplicates and interims) */
  #totalProcessed = 0;

  /** Total duplicates suppressed */
  #duplicateCount = 0;

  /**
   * @param {Object} [options]
   * @param {Object} [options.dedup]              - UtteranceDeduplicator config overrides
   * @param {number} [options.sessionStartTime]   - Session start (ms since epoch).
   *   Defaults to Date.now() at construction.
   */
  constructor({ dedup = {}, sessionStartTime } = {}) {
    super();
    this.#deduplicator = new UtteranceDeduplicator(dedup);
    this.#sessionStartMs = sessionStartTime ?? Date.now();
  }

  // ── Speaker resolution ───────────────────────────────────────────

  /**
   * Register or update a mapping from a Deepgram speaker label to a Discord user.
   * Call this whenever voice activity or manual assignment lets you identify who is
   * behind a speaker label.
   *
   * @param {number}      speakerLabel  - Deepgram diarization integer
   * @param {string|null} userId        - Discord snowflake (null if unknown)
   * @param {string}      displayName   - Human-readable name shown in transcript
   */
  resolveSpeaker(speakerLabel, userId, displayName) {
    this.#speakerResolutions.set(speakerLabel, { userId: userId ?? null, displayName });
  }

  /**
   * Get the current resolution for a speaker label.
   * Falls back to a placeholder if no resolution has been registered.
   *
   * @param {number} speakerLabel
   * @returns {{ userId: string|null, displayName: string }}
   */
  getSpeakerResolution(speakerLabel) {
    return (
      this.#speakerResolutions.get(speakerLabel) ?? {
        userId: null,
        displayName: `Speaker ${speakerLabel}`,
      }
    );
  }

  // ── Core processing ──────────────────────────────────────────────

  /**
   * Process a raw Deepgram live-transcription result.
   *
   * For each per-speaker segment extracted from the response:
   * - Interim results (is_final: false) update the per-speaker interim slot.
   * - Final results (is_final: true) clear the interim slot and append to the
   *   ordered entry list after deduplication.
   *
   * @param {Object}  data         - Raw Deepgram result object
   * @param {number}  [streamOffset=0] - Additional offset (seconds) to add to
   *   word timestamps when Deepgram start times are stream-relative. Pass 0
   *   when timestamps are already session-relative.
   * @returns {TranscriptEntry[]} Newly added **final** entries (empty if all interims or dupes)
   */
  processResponse(data, streamOffset = 0) {
    const segments = parseDeepgramResponse(data);
    const newFinalEntries = [];

    for (const segment of segments) {
      this.#totalProcessed++;

      const sessionTimestamp = segment.start + streamOffset;
      const resolution = this.getSpeakerResolution(segment.speakerLabel);

      /** @type {TranscriptEntry} */
      const entry = {
        speakerLabel: segment.speakerLabel,
        userId: resolution.userId,
        displayName: resolution.displayName,
        text: segment.text,
        timestamp: sessionTimestamp,
        duration: segment.duration,
        isFinal: segment.isFinal,
        confidence: segment.confidence,
        language: segment.language,
        words: segment.words,
      };

      if (!segment.isFinal) {
        // ── Interim path ─────────────────────────────────────────
        // Replace previous interim for this speaker with the new one.
        this.#interimBySpeaker.set(segment.speakerLabel, entry);
        this.emit('interim', { entry });
      } else {
        // ── Final path ───────────────────────────────────────────
        // Clear the interim slot for this speaker first.
        if (this.#interimBySpeaker.has(segment.speakerLabel)) {
          this.#interimBySpeaker.delete(segment.speakerLabel);
          this.emit('interim_cleared', { speakerLabel: segment.speakerLabel });
        }

        // Deduplication check (using speaker label as the speaker key).
        const dedupResult = this.#deduplicator.check({
          speaker: segment.speakerLabel,
          text: segment.text,
          timestamp: sessionTimestamp,
          isFinal: true,
        });

        if (dedupResult.isDuplicate) {
          this.#duplicateCount++;
          this.emit('duplicate', {
            text: segment.text,
            speakerLabel: segment.speakerLabel,
            reason: dedupResult.reason,
          });
          continue;
        }

        // Append to ordered list and per-speaker list.
        this.#entries.push(entry);

        if (!this.#entriesBySpeaker.has(segment.speakerLabel)) {
          this.#entriesBySpeaker.set(segment.speakerLabel, []);
        }
        this.#entriesBySpeaker.get(segment.speakerLabel).push(entry);

        this.emit('entry', { entry });
        newFinalEntries.push(entry);
      }
    }

    return newFinalEntries;
  }

  // ── Accessors ────────────────────────────────────────────────────

  /**
   * All finalized transcript entries in chronological order (shallow copy).
   * @returns {TranscriptEntry[]}
   */
  get entries() {
    return [...this.#entries];
  }

  /**
   * Number of finalized entries in the buffer.
   * @returns {number}
   */
  get entryCount() {
    return this.#entries.length;
  }

  /**
   * Total utterances submitted for processing (includes duplicates and interims).
   * @returns {number}
   */
  get totalProcessed() {
    return this.#totalProcessed;
  }

  /**
   * Number of duplicate utterances suppressed.
   * @returns {number}
   */
  get duplicateCount() {
    return this.#duplicateCount;
  }

  /**
   * Finalized entries for a specific Deepgram speaker label (shallow copy).
   * @param {number} speakerLabel
   * @returns {TranscriptEntry[]}
   */
  getEntriesBySpeaker(speakerLabel) {
    return [...(this.#entriesBySpeaker.get(speakerLabel) ?? [])];
  }

  /**
   * Finalized entries for a specific Discord user ID (shallow copy).
   * @param {string} userId
   * @returns {TranscriptEntry[]}
   */
  getEntriesByUserId(userId) {
    return this.#entries.filter(e => e.userId === userId);
  }

  /**
   * The current (latest) interim entry for a speaker label.
   * Returns null if there is no pending interim.
   * @param {number} speakerLabel
   * @returns {TranscriptEntry|null}
   */
  getInterim(speakerLabel) {
    return this.#interimBySpeaker.get(speakerLabel) ?? null;
  }

  /**
   * All current interim entries keyed by speaker label.
   * @returns {Map<number, TranscriptEntry>}
   */
  getAllInterim() {
    return new Map(this.#interimBySpeaker);
  }

  /**
   * Whether there are any pending (unfinalized) interim entries.
   * @returns {boolean}
   */
  get hasInterim() {
    return this.#interimBySpeaker.size > 0;
  }

  // ── Speaker statistics ───────────────────────────────────────────

  /**
   * Per-speaker statistics aggregated from finalized entries.
   *
   * @returns {Map<number, { speakerLabel: number, userId: string|null, displayName: string,
   *                          entryCount: number, totalDuration: number, wordCount: number }>}
   */
  getSpeakerStats() {
    const stats = new Map();

    for (const entry of this.#entries) {
      if (!stats.has(entry.speakerLabel)) {
        stats.set(entry.speakerLabel, {
          speakerLabel: entry.speakerLabel,
          userId: entry.userId,
          displayName: entry.displayName,
          entryCount: 0,
          totalDuration: 0,
          wordCount: 0,
        });
      }
      const s = stats.get(entry.speakerLabel);
      s.entryCount++;
      s.totalDuration += entry.duration;
      s.wordCount += entry.text.split(/\s+/).filter(Boolean).length;
      // Refresh userId/displayName in case it was resolved after initial entry
      s.userId = entry.userId;
      s.displayName = entry.displayName;
    }

    return stats;
  }

  /**
   * Distinct speaker labels seen in finalized entries.
   * @returns {number[]}
   */
  getSpeakerLabels() {
    return [...this.#entriesBySpeaker.keys()];
  }

  // ── Export helpers ───────────────────────────────────────────────

  /**
   * Export finalized transcript as plain text with timestamps and speaker names.
   *
   * Example:
   *   [00:01] Alice: Hello everyone.
   *   [00:05] Bob: Good morning.
   *
   * @returns {string}
   */
  toPlainText() {
    return this.#entries
      .map(e => {
        const totalSecs = Math.round(e.timestamp);
        const mm = String(Math.floor(totalSecs / 60)).padStart(2, '0');
        const ss = String(totalSecs % 60).padStart(2, '0');
        return `[${mm}:${ss}] ${e.displayName}: ${e.text}`;
      })
      .join('\n');
  }

  /**
   * Export finalized transcript as a JSON-serializable array.
   * @returns {Object[]}
   */
  toStructuredData() {
    return this.#entries.map(e => ({
      speaker_label: e.speakerLabel,
      speaker_id:   e.userId,
      speaker_name: e.displayName,
      text:         e.text,
      timestamp:    e.timestamp,
      duration:     e.duration,
      confidence:   e.confidence,
      language:     e.language,
      is_final:     e.isFinal,
    }));
  }

  // ── Session lifecycle ────────────────────────────────────────────

  /**
   * Reset all buffer state. Call at the start of a new recording session.
   */
  reset() {
    this.#entries = [];
    this.#interimBySpeaker.clear();
    this.#entriesBySpeaker.clear();
    this.#speakerResolutions.clear();
    this.#deduplicator.reset();
    this.#sessionStartMs = Date.now();
    this.#totalProcessed = 0;
    this.#duplicateCount = 0;
  }
}

// ──────────────────────────────────────────────────────────────────
// Named exports
// ──────────────────────────────────────────────────────────────────

export {
  groupWordsBySpeaker,
  detectLanguage,
  parseDeepgramResponse,
};
