/**
 * Transcript Store
 *
 * Parses Deepgram transcription response payloads to extract speaker-labeled
 * transcript segments and accumulates them in a per-session transcript store.
 *
 * Responsibilities:
 * - Parse raw Deepgram streaming response payloads (with diarization metadata)
 * - Group consecutive words by speaker index to form per-speaker segments
 * - Resolve Deepgram speaker labels to Discord user identities via SpeakerIdentifier
 * - Accumulate TranscriptEntry objects in chronological order per session
 * - Integrate with UtteranceDeduplicator to filter duplicates before storing
 * - Support 5-10 concurrent participants
 * - Provide export-ready data for minutes generation
 *
 * Two entry points:
 *   1. addFromEvent(event)   — accepts pre-parsed TranscriptEvent from DeepgramStreamingClient
 *   2. addFromPayload(data)  — accepts raw Deepgram Results payload for direct parsing
 */

import { UtteranceDeduplicator } from './dedup.js';

// ---------------------------------------------------------------------------
// Language detection helpers
// ---------------------------------------------------------------------------

/** Hangul syllable + jamo ranges */
const HANGUL_RE = /[\uAC00-\uD7AF\u3130-\u318F]/;

/**
 * Simple heuristic: count Hangul vs total alpha characters.
 * @param {string} text
 * @returns {'ko' | 'en' | 'unknown'}
 */
function detectLanguage(text) {
  if (!text) return 'unknown';
  const alphaChars = [...text].filter(c => /\p{L}/u.test(c));
  if (alphaChars.length === 0) return 'unknown';
  const koreanCount = [...text].filter(c => HANGUL_RE.test(c)).length;
  return koreanCount / alphaChars.length > 0.3 ? 'ko' : 'en';
}

// ---------------------------------------------------------------------------
// Word-grouping helpers
// ---------------------------------------------------------------------------

/**
 * Group consecutive words by their Deepgram speaker index.
 * Returns an array of [speakerLabel, words[]] tuples.
 *
 * @param {Array<Object>} words - Deepgram word objects (each has .speaker)
 * @returns {Array<[number, Array<Object>]>}
 */
function groupWordsBySpeaker(words) {
  if (!words || words.length === 0) return [];

  const groups = [];
  let currentSpeaker = words[0].speaker ?? 0;
  let currentGroup = [words[0]];

  for (let i = 1; i < words.length; i++) {
    const word = words[i];
    const speaker = word.speaker ?? 0;
    if (speaker === currentSpeaker) {
      currentGroup.push(word);
    } else {
      groups.push([currentSpeaker, currentGroup]);
      currentSpeaker = speaker;
      currentGroup = [word];
    }
  }
  groups.push([currentSpeaker, currentGroup]);
  return groups;
}

/**
 * Extract metadata (duration, avg confidence, language) from a word list.
 * @param {Array<Object>} words
 * @returns {{ duration: number, confidence: number, language: string }}
 */
function extractWordMetadata(words) {
  if (!words || words.length === 0) {
    return { duration: 0, confidence: 0, language: 'unknown' };
  }
  const start = words[0].start ?? 0;
  const end = words[words.length - 1].end ?? start;
  const duration = end - start;

  const totalConf = words.reduce((sum, w) => sum + (w.confidence ?? 0), 0);
  const confidence = words.length > 0 ? totalConf / words.length : 0;

  const allText = words.map(w => w.word ?? '').join(' ');
  const language = detectLanguage(allText);

  return { duration, confidence, language };
}

// ---------------------------------------------------------------------------
// Public: parseDeepgramPayload
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TranscriptSegment
 * @property {number} speakerLabel - Deepgram diarization speaker index
 * @property {string} text - Transcribed text (using punctuated_word where available)
 * @property {number} start - Start time in seconds (absolute, from Deepgram)
 * @property {number} end - End time in seconds
 * @property {number} duration - Duration in seconds
 * @property {number} confidence - Average word confidence (0-1)
 * @property {string} language - Detected language ('ko'|'en'|'unknown')
 * @property {boolean} isFinal - Whether this is a final result
 * @property {boolean} speechFinal - Whether speech_final flag is set
 * @property {Array<Object>} words - Raw word objects from Deepgram
 */

/**
 * Parse a raw Deepgram "Results" payload into speaker-labeled segments.
 *
 * Deepgram payload structure:
 * {
 *   type: "Results",
 *   is_final: true,
 *   speech_final: false,
 *   start: 0.0,
 *   duration: 1.5,
 *   channel: {
 *     alternatives: [{
 *       transcript: "hello world",
 *       confidence: 0.95,
 *       words: [
 *         { word: "hello", punctuated_word: "Hello", speaker: 0,
 *           start: 0.1, end: 0.3, confidence: 0.95 },
 *         ...
 *       ]
 *     }]
 *   }
 * }
 *
 * With diarization, each word carries a `speaker` integer.
 * We group consecutive words by speaker to produce per-speaker segments.
 *
 * @param {Object} payload - Raw Deepgram Results payload
 * @returns {TranscriptSegment[]} Parsed speaker-labeled segments (empty if non-Results)
 */
export function parseDeepgramPayload(payload) {
  if (!payload || payload.type !== 'Results') return [];

  const channel = payload.channel;
  if (!channel?.alternatives?.length) return [];

  const best = channel.alternatives[0];
  const words = best.words ?? [];
  const isFinal = payload.is_final ?? false;
  const speechFinal = payload.speech_final ?? false;

  if (words.length === 0) {
    // Fallback: no word-level data — use whole transcript as speaker_0
    const transcript = (best.transcript ?? '').trim();
    if (!transcript) return [];
    const start = payload.start ?? 0;
    return [{
      speakerLabel: 0,
      text: transcript,
      start,
      end: start + (payload.duration ?? 0),
      duration: payload.duration ?? 0,
      confidence: best.confidence ?? 0,
      language: detectLanguage(transcript),
      isFinal,
      speechFinal,
      words: [],
    }];
  }

  const groups = groupWordsBySpeaker(words);
  const segments = [];

  for (const [speakerLabel, groupWords] of groups) {
    // Build text from punctuated_word (natural casing/punctuation) if available
    const textParts = groupWords.map(w => w.punctuated_word ?? w.word ?? '');
    const text = textParts.join(' ').trim();
    if (!text) continue;

    const start = groupWords[0].start ?? 0;
    const end = groupWords[groupWords.length - 1].end ?? start;
    const { duration, confidence, language } = extractWordMetadata(groupWords);

    segments.push({
      speakerLabel,
      text,
      start,
      end,
      duration,
      confidence,
      language,
      isFinal,
      speechFinal,
      words: groupWords,
    });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// TranscriptEntry — accumulated store entry
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TranscriptEntry
 * @property {string}  sessionId     - Session identifier
 * @property {number}  speakerLabel  - Deepgram diarization speaker index
 * @property {string}  speakerName   - Resolved display name ("Alice" or "Speaker 0")
 * @property {string|null} userId    - Discord user ID if resolved, null otherwise
 * @property {string}  text          - Transcribed text
 * @property {number}  start         - Start time in seconds (Deepgram absolute)
 * @property {number}  end           - End time in seconds
 * @property {number}  duration      - Duration in seconds
 * @property {number}  confidence    - Confidence score (0-1)
 * @property {string}  language      - Detected language ('ko'|'en'|'unknown')
 * @property {boolean} isFinal       - Whether this is a final result
 * @property {number}  wallClockMs   - Wall-clock timestamp when entry was added (ms since epoch)
 */

// ---------------------------------------------------------------------------
// TranscriptSession — per-session accumulator
// ---------------------------------------------------------------------------

/**
 * Accumulates a chronological, speaker-attributed transcript for one voice session.
 *
 * Usage:
 *   const session = new TranscriptSession({ sessionId: 'guild-123-1234567890' });
 *
 *   // Register Discord users (from SpeakerIdentifier or manual mapping)
 *   session.registerSpeaker(0, 'alice-discord-id', 'Alice');
 *
 *   // Option A: feed pre-parsed events from DeepgramStreamingClient
 *   deepgramClient.on('transcript', event => session.addFromEvent(event));
 *
 *   // Option B: feed raw Deepgram payloads directly
 *   session.addFromPayload(rawDeepgramResultsPayload);
 *
 *   // Export
 *   const text = session.toPlainText();
 *   const data = session.toStructuredData();
 */
export class TranscriptSession {
  /** @type {string} */
  #sessionId;

  /** @type {TranscriptEntry[]} */
  #entries = [];

  /**
   * Deepgram speaker label → { userId, speakerName }
   * @type {Map<number, { userId: string, speakerName: string }>}
   */
  #speakerRegistry = new Map();

  /** @type {UtteranceDeduplicator} */
  #dedup;

  /** @type {number} total segments processed (including duplicates) */
  #totalProcessed = 0;

  /** @type {number} duplicates filtered out */
  #duplicateCount = 0;

  /** @type {number} session start wall-clock time (ms) */
  #startedAt;

  /**
   * @param {Object} options
   * @param {string} options.sessionId
   * @param {Object} [options.dedupConfig] - Overrides for UtteranceDeduplicator
   */
  constructor({ sessionId, dedupConfig = {} } = {}) {
    if (!sessionId) throw new Error('sessionId is required');
    this.#sessionId = sessionId;
    this.#dedup = new UtteranceDeduplicator(dedupConfig);
    this.#startedAt = Date.now();
  }

  // ── Identity ──────────────────────────────────────────────────

  /** @returns {string} */
  get sessionId() {
    return this.#sessionId;
  }

  // ── Speaker registry ──────────────────────────────────────────

  /**
   * Register a mapping from Deepgram speaker label to Discord user identity.
   * Call this whenever the SpeakerIdentifier confirms a mapping.
   *
   * @param {number} speakerLabel - Deepgram diarization index
   * @param {string} userId - Discord user snowflake ID
   * @param {string} speakerName - Display name
   */
  registerSpeaker(speakerLabel, userId, speakerName) {
    this.#speakerRegistry.set(speakerLabel, { userId, speakerName });

    // Retroactively update existing entries for this speaker
    for (const entry of this.#entries) {
      if (entry.speakerLabel === speakerLabel) {
        entry.userId = userId;
        entry.speakerName = speakerName;
      }
    }
  }

  /**
   * Resolve a Deepgram speaker label to display name and user ID.
   * Falls back to "Speaker N" if no mapping is registered.
   *
   * @param {number} speakerLabel
   * @returns {{ userId: string|null, speakerName: string }}
   */
  resolveSpeaker(speakerLabel) {
    const reg = this.#speakerRegistry.get(speakerLabel);
    if (reg) return { userId: reg.userId, speakerName: reg.speakerName };
    return { userId: null, speakerName: `Speaker ${speakerLabel}` };
  }

  // ── Accumulation from pre-parsed events ──────────────────────

  /**
   * Add a transcript entry from a pre-parsed TranscriptEvent emitted by
   * DeepgramStreamingClient.  The client already deduplicates, so this path
   * skips the dedup check (duplicates never reach listeners).
   *
   * Only final results are stored by default (set includePreliminary=true to
   * also store interim results — useful for live display).
   *
   * @param {Object} event - TranscriptEvent from DeepgramStreamingClient
   * @param {string}  event.text
   * @param {number}  event.speaker
   * @param {boolean} event.isFinal
   * @param {boolean} event.speechFinal
   * @param {number}  event.confidence
   * @param {number}  event.start
   * @param {number}  event.end
   * @param {Array}   [event.words]
   * @param {boolean} [includePreliminary=false] - also store interim results
   * @returns {TranscriptEntry|null} The new entry, or null if skipped
   */
  addFromEvent(event, { includePreliminary = false } = {}) {
    if (!event?.text?.trim()) return null;
    if (!event.isFinal && !includePreliminary) return null;

    this.#totalProcessed++;

    const { userId, speakerName } = this.resolveSpeaker(event.speaker ?? 0);
    const words = event.words ?? [];
    const language = words.length > 0
      ? detectLanguage(words.map(w => w.word ?? '').join(' '))
      : detectLanguage(event.text);

    /** @type {TranscriptEntry} */
    const entry = {
      sessionId: this.#sessionId,
      speakerLabel: event.speaker ?? 0,
      speakerName,
      userId,
      text: event.text.trim(),
      start: event.start ?? 0,
      end: event.end ?? 0,
      duration: (event.end ?? 0) - (event.start ?? 0),
      confidence: event.confidence ?? 0,
      language,
      isFinal: event.isFinal ?? true,
      wallClockMs: Date.now(),
    };

    this.#entries.push(entry);
    return entry;
  }

  // ── Accumulation from raw Deepgram payloads ───────────────────

  /**
   * Parse a raw Deepgram "Results" payload and accumulate non-duplicate
   * final segments into the transcript.
   *
   * This is the primary path when consuming raw WebSocket messages directly,
   * bypassing DeepgramStreamingClient.
   *
   * @param {Object} payload - Raw Deepgram Results payload
   * @param {Object} [options]
   * @param {boolean} [options.includePreliminary=false] - store interim segments
   * @returns {TranscriptEntry[]} Newly added entries (empty if all filtered)
   */
  addFromPayload(payload, { includePreliminary = false } = {}) {
    const segments = parseDeepgramPayload(payload);
    const newEntries = [];

    for (const seg of segments) {
      if (!seg.isFinal && !includePreliminary) continue;

      this.#totalProcessed++;

      // Deduplication check
      const dedupResult = this.#dedup.check({
        speaker: seg.speakerLabel,
        text: seg.text,
        timestamp: seg.start,
        isFinal: seg.isFinal,
      });

      if (dedupResult.isDuplicate) {
        this.#duplicateCount++;
        continue;
      }

      const { userId, speakerName } = this.resolveSpeaker(seg.speakerLabel);

      /** @type {TranscriptEntry} */
      const entry = {
        sessionId: this.#sessionId,
        speakerLabel: seg.speakerLabel,
        speakerName,
        userId,
        text: seg.text,
        start: seg.start,
        end: seg.end,
        duration: seg.duration,
        confidence: seg.confidence,
        language: seg.language,
        isFinal: seg.isFinal,
        wallClockMs: Date.now(),
      };

      this.#entries.push(entry);
      newEntries.push(entry);
    }

    return newEntries;
  }

  // ── Read API ─────────────────────────────────────────────────

  /**
   * All accumulated entries in chronological order (copy).
   * @returns {TranscriptEntry[]}
   */
  get entries() {
    return [...this.#entries];
  }

  /** Number of entries in the store. */
  get entryCount() {
    return this.#entries.length;
  }

  /** Total segments processed (including duplicates). */
  get totalProcessed() {
    return this.#totalProcessed;
  }

  /** Number of duplicate segments filtered out. */
  get duplicateCount() {
    return this.#duplicateCount;
  }

  /**
   * Get all entries for a specific Discord user.
   * @param {string} userId
   * @returns {TranscriptEntry[]}
   */
  getEntriesByUser(userId) {
    return this.#entries.filter(e => e.userId === userId);
  }

  /**
   * Get all entries attributed to a Deepgram speaker label.
   * @param {number} speakerLabel
   * @returns {TranscriptEntry[]}
   */
  getEntriesBySpeaker(speakerLabel) {
    return this.#entries.filter(e => e.speakerLabel === speakerLabel);
  }

  /**
   * Per-speaker participation statistics.
   * @returns {Map<string, { speakerName: string, entryCount: number, totalDuration: number, wordCount: number }>}
   *   Keyed by userId (or "speaker_N" for unresolved speakers)
   */
  getSpeakerStats() {
    const stats = new Map();

    for (const entry of this.#entries) {
      const key = entry.userId ?? `speaker_${entry.speakerLabel}`;
      if (!stats.has(key)) {
        stats.set(key, {
          speakerName: entry.speakerName,
          entryCount: 0,
          totalDuration: 0,
          wordCount: 0,
        });
      }
      const s = stats.get(key);
      s.entryCount++;
      s.totalDuration += entry.duration;
      s.wordCount += entry.text.split(/\s+/).filter(Boolean).length;
    }

    return stats;
  }

  // ── Export ────────────────────────────────────────────────────

  /**
   * Export transcript as plain text with speaker labels and timestamps.
   * Timestamps are formatted as [MM:SS] relative to session start.
   *
   * Example:
   *   [00:05] Alice: 안녕하세요 반갑습니다
   *   [00:12] Bob: Hello everyone
   *
   * @returns {string}
   */
  toPlainText() {
    return this.#entries.map(entry => {
      const elapsed = entry.start; // seconds from Deepgram session start
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(Math.floor(elapsed % 60)).padStart(2, '0');
      return `[${mm}:${ss}] ${entry.speakerName}: ${entry.text}`;
    }).join('\n');
  }

  /**
   * Export transcript as structured data (JSON-serialisable).
   * @returns {Array<Object>}
   */
  toStructuredData() {
    return this.#entries.map(entry => ({
      sessionId: entry.sessionId,
      speakerLabel: entry.speakerLabel,
      speakerName: entry.speakerName,
      userId: entry.userId,
      text: entry.text,
      start: entry.start,
      end: entry.end,
      duration: entry.duration,
      confidence: entry.confidence,
      language: entry.language,
      isFinal: entry.isFinal,
      wallClockMs: entry.wallClockMs,
    }));
  }

  /**
   * Summary metadata for this session.
   * @returns {Object}
   */
  getSummary() {
    const stats = this.getSpeakerStats();
    const totalWords = [...stats.values()].reduce((s, v) => s + v.wordCount, 0);
    const totalDuration = this.#entries.length > 0
      ? this.#entries[this.#entries.length - 1].end - this.#entries[0].start
      : 0;
    const languages = new Set(this.#entries.map(e => e.language));

    return {
      sessionId: this.#sessionId,
      entryCount: this.#entries.length,
      totalProcessed: this.#totalProcessed,
      duplicateCount: this.#duplicateCount,
      participantCount: stats.size,
      totalWords,
      totalDurationSec: totalDuration,
      languages: [...languages],
      speakerStats: Object.fromEntries(stats),
      startedAt: this.#startedAt,
    };
  }

  /**
   * Reset all accumulated data. Call when starting a new session.
   */
  reset() {
    this.#entries = [];
    this.#speakerRegistry.clear();
    this.#dedup.reset();
    this.#totalProcessed = 0;
    this.#duplicateCount = 0;
    this.#startedAt = Date.now();
  }
}

// ---------------------------------------------------------------------------
// TranscriptStore — multi-session manager
// ---------------------------------------------------------------------------

/**
 * Manages multiple TranscriptSession instances keyed by session ID.
 *
 * Typical usage:
 *   const store = new TranscriptStore();
 *
 *   // When a session starts
 *   store.createSession('guild-123-ts');
 *
 *   // When a transcript event arrives from DeepgramStreamingClient
 *   deepgramClient.on('transcript', event => {
 *     store.getSession('guild-123-ts')?.addFromEvent(event);
 *   });
 *
 *   // When a session ends
 *   const session = store.closeSession('guild-123-ts');
 *   const minutes = session.toStructuredData();
 */
export class TranscriptStore {
  /** @type {Map<string, TranscriptSession>} */
  #sessions = new Map();

  /**
   * Create a new session in the store.
   * @param {string} sessionId
   * @param {Object} [options] - Passed to TranscriptSession constructor
   * @returns {TranscriptSession}
   * @throws {Error} if a session with this ID already exists
   */
  createSession(sessionId, options = {}) {
    if (this.#sessions.has(sessionId)) {
      throw new Error(`TranscriptStore: session '${sessionId}' already exists`);
    }
    const session = new TranscriptSession({ sessionId, ...options });
    this.#sessions.set(sessionId, session);
    return session;
  }

  /**
   * Retrieve an existing session (or null if not found).
   * @param {string} sessionId
   * @returns {TranscriptSession|null}
   */
  getSession(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  /**
   * Remove a session from the store, returning it for final processing.
   * @param {string} sessionId
   * @returns {TranscriptSession|null}
   */
  closeSession(sessionId) {
    const session = this.#sessions.get(sessionId) ?? null;
    this.#sessions.delete(sessionId);
    return session;
  }

  /**
   * Whether a session with the given ID is currently active.
   * @param {string} sessionId
   * @returns {boolean}
   */
  hasSession(sessionId) {
    return this.#sessions.has(sessionId);
  }

  /**
   * All active session IDs.
   * @returns {string[]}
   */
  get sessionIds() {
    return [...this.#sessions.keys()];
  }

  /**
   * Number of active sessions.
   * @returns {number}
   */
  get sessionCount() {
    return this.#sessions.size;
  }

  /**
   * Remove all sessions.
   */
  clear() {
    this.#sessions.clear();
  }
}

// Re-export helpers for convenience
export { detectLanguage, groupWordsBySpeaker, extractWordMetadata };
