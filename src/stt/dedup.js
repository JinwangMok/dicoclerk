/**
 * Duplicate utterance detection for STT output.
 *
 * Detects and filters duplicate utterances using a combination of:
 * 1. Content fingerprinting (normalized text hashing)
 * 2. Speaker identity matching
 * 3. Timestamp proximity detection
 * 4. Fuzzy content similarity (Levenshtein-based)
 *
 * Handles common STT duplication scenarios:
 * - Deepgram sending the same interim result multiple times
 * - Overlapping audio chunks producing identical transcriptions
 * - Near-duplicate partial results from real-time streaming
 */

import { createHash } from 'node:crypto';

/**
 * @typedef {Object} Utterance
 * @property {string|number} speaker - Speaker identifier
 * @property {string} text - Transcribed text
 * @property {number} timestamp - Seconds from session start
 * @property {boolean} isFinal - Whether this is a final result
 */

/**
 * @typedef {Object} DeduplicationConfig
 * @property {number} timeWindow - Seconds within which similar utterances are duplicates
 * @property {number} similarityThreshold - 0.0–1.0; above this = duplicate
 * @property {number} windowSize - Max utterances in sliding window
 * @property {boolean} deduplicateInterim - Treat interim results as replaceable
 * @property {number} exactMatchWindow - Seconds for exact-match grace period
 */

/** @type {DeduplicationConfig} */
const DEFAULT_DEDUP_CONFIG = {
  timeWindow: 5.0,
  similarityThreshold: 0.75,
  windowSize: 100,
  deduplicateInterim: true,
  exactMatchWindow: 10.0,
};

/**
 * @typedef {Object} DeduplicationResult
 * @property {boolean} isDuplicate
 * @property {string|null} reason
 * @property {Utterance|null} matchedUtterance
 * @property {number|null} similarityScore
 */

/**
 * Normalize text for comparison: lowercase, strip punctuation/whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  let t = text.toLowerCase().trim();
  // Remove punctuation but keep letters (including Unicode/Korean), digits, and whitespace
  t = t.replace(/[^\p{L}\p{N}\s]/gu, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Create a deterministic fingerprint for a speaker+text pair.
 * @param {string|number} speaker
 * @param {string} text
 * @returns {string}
 */
function fingerprint(speaker, text) {
  const normalized = normalizeText(text);
  const content = `${speaker}::${normalized}`;
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute Levenshtein edit distance between two strings.
 * @param {string} s1
 * @param {string} s2
 * @returns {number}
 */
function levenshteinDistance(s1, s2) {
  if (s1.length < s2.length) return levenshteinDistance(s2, s1);
  if (s2.length === 0) return s1.length;

  let prevRow = Array.from({ length: s2.length + 1 }, (_, i) => i);

  for (let i = 0; i < s1.length; i++) {
    const currRow = [i + 1];
    for (let j = 0; j < s2.length; j++) {
      const cost = s1[i] === s2[j] ? 0 : 1;
      currRow.push(Math.min(
        currRow[j] + 1,       // insertion
        prevRow[j + 1] + 1,   // deletion
        prevRow[j] + cost,     // substitution
      ));
    }
    prevRow = currRow;
  }
  return prevRow[s2.length];
}

/**
 * Compute normalized similarity between two strings (0.0–1.0).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function textSimilarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1.0;
  if (!na || !nb) return 0.0;
  const maxLen = Math.max(na.length, nb.length);
  const dist = levenshteinDistance(na, nb);
  return 1.0 - dist / maxLen;
}

/**
 * Check if shorter normalized text is a substantial substring of longer.
 * @param {string} shorter
 * @param {string} longer
 * @returns {boolean}
 */
function isSubstringMatch(shorter, longer) {
  const ns = normalizeText(shorter);
  const nl = normalizeText(longer);
  if (!ns || !nl) return false;
  // The shorter must be at least 60% of the longer to count
  if (ns.length / nl.length < 0.6) return false;
  return nl.includes(ns);
}

/**
 * Sliding-window deduplicator for real-time STT utterances.
 *
 * Maintains a bounded window of recent utterances and checks new ones
 * against them using fingerprint, timestamp proximity, and fuzzy matching.
 */
class UtteranceDeduplicator {
  /** @type {DeduplicationConfig} */
  #config;
  /** @type {Utterance[]} */
  #window;
  /** @type {Map<string, number>} fingerprint -> timestamp */
  #fingerprints;
  /** @type {Map<string, Utterance>} speaker -> latest interim */
  #interimCache;

  /**
   * @param {Partial<DeduplicationConfig>} [config]
   */
  constructor(config = {}) {
    this.#config = { ...DEFAULT_DEDUP_CONFIG, ...config };
    this.#window = [];
    this.#fingerprints = new Map();
    this.#interimCache = new Map();
  }

  /**
   * Check if an utterance is a duplicate.
   * @param {Utterance} utterance
   * @returns {DeduplicationResult}
   */
  check(utterance) {
    const normalized = normalizeText(utterance.text);

    // Skip empty utterances
    if (!normalized) {
      return { isDuplicate: true, reason: 'empty_text', matchedUtterance: null, similarityScore: null };
    }

    // Handle interim results
    if (!utterance.isFinal && this.#config.deduplicateInterim) {
      return this.#checkInterim(utterance, normalized);
    }

    // 1. Exact fingerprint match
    const fp = fingerprint(utterance.speaker, utterance.text);
    if (this.#fingerprints.has(fp)) {
      const prevTs = this.#fingerprints.get(fp);
      if (Math.abs(utterance.timestamp - prevTs) <= this.#config.exactMatchWindow) {
        return { isDuplicate: true, reason: 'exact_fingerprint', matchedUtterance: null, similarityScore: 1.0 };
      }
    }

    // 2. Check sliding window for fuzzy matches
    const result = this.#checkWindow(utterance, normalized);
    if (result.isDuplicate) return result;

    // Not a duplicate — accept
    this.#accept(utterance, fp);
    return { isDuplicate: false, reason: null, matchedUtterance: null, similarityScore: null };
  }

  /**
   * @param {Utterance} utterance
   * @param {string} _normalized
   * @returns {DeduplicationResult}
   */
  #checkInterim(utterance, _normalized) {
    const key = String(utterance.speaker);

    if (this.#interimCache.has(key)) {
      const prev = this.#interimCache.get(key);
      const sim = textSimilarity(prev.text, utterance.text);
      const prevNorm = normalizeText(prev.text);
      const currNorm = normalizeText(utterance.text);

      const isContinuation = (
        sim >= this.#config.similarityThreshold
        || (prevNorm && currNorm && (prevNorm.includes(currNorm) || currNorm.includes(prevNorm)))
      );

      if (isContinuation) {
        // Replace old interim with new one (it's an update)
        this.#interimCache.set(key, utterance);
        return { isDuplicate: true, reason: 'interim_update', matchedUtterance: prev, similarityScore: sim };
      }
    }

    // New interim for this speaker
    this.#interimCache.set(key, utterance);
    return { isDuplicate: false, reason: null, matchedUtterance: null, similarityScore: null };
  }

  /**
   * @param {Utterance} utterance
   * @param {string} _normalized
   * @returns {DeduplicationResult}
   */
  #checkWindow(utterance, _normalized) {
    for (let i = this.#window.length - 1; i >= 0; i--) {
      const prev = this.#window[i];

      // Only compare same speaker
      if (prev.speaker !== utterance.speaker) continue;

      // Only within time window
      const timeDiff = Math.abs(utterance.timestamp - prev.timestamp);
      if (timeDiff > this.#config.timeWindow) continue;

      // Fuzzy similarity check
      const sim = textSimilarity(prev.text, utterance.text);
      if (sim >= this.#config.similarityThreshold) {
        return { isDuplicate: true, reason: 'fuzzy_match', matchedUtterance: prev, similarityScore: sim };
      }

      // Substring containment check
      const [shorter, longer] = utterance.text.length < prev.text.length
        ? [utterance.text, prev.text]
        : [prev.text, utterance.text];
      if (isSubstringMatch(shorter, longer)) {
        return { isDuplicate: true, reason: 'substring_match', matchedUtterance: prev, similarityScore: sim };
      }
    }

    return { isDuplicate: false, reason: null, matchedUtterance: null, similarityScore: null };
  }

  /**
   * @param {Utterance} utterance
   * @param {string} fp
   */
  #accept(utterance, fp) {
    this.#window.push(utterance);
    // Enforce window size
    while (this.#window.length > this.#config.windowSize) {
      this.#window.shift();
    }

    this.#fingerprints.set(fp, utterance.timestamp);

    // Clear interim cache for this speaker when a final result arrives
    if (utterance.isFinal) {
      this.#interimCache.delete(String(utterance.speaker));
    }

    // Evict stale fingerprints
    this.#evictStaleFingerprints(utterance.timestamp);
  }

  /**
   * @param {number} currentTime
   */
  #evictStaleFingerprints(currentTime) {
    const cutoff = currentTime - this.#config.exactMatchWindow;
    for (const [fp, ts] of this.#fingerprints) {
      if (ts < cutoff) this.#fingerprints.delete(fp);
    }
  }

  /**
   * Retrieve and clear the latest interim utterance for a speaker.
   * @param {string|number} speaker
   * @returns {Utterance|null}
   */
  finalizeInterim(speaker) {
    const key = String(speaker);
    const utterance = this.#interimCache.get(key) ?? null;
    this.#interimCache.delete(key);
    return utterance;
  }

  /** Clear all state. Call when starting a new session. */
  reset() {
    this.#window = [];
    this.#fingerprints.clear();
    this.#interimCache.clear();
  }

  /** Current number of utterances in the sliding window. */
  get windowSize() {
    return this.#window.length;
  }
}

export {
  DEFAULT_DEDUP_CONFIG,
  UtteranceDeduplicator,
  normalizeText,
  textSimilarity,
  levenshteinDistance,
  isSubstringMatch,
  fingerprint,
};
