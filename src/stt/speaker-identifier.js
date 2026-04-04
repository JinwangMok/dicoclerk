/**
 * Speaker Identifier
 *
 * Maps Deepgram diarization speaker labels (0, 1, 2...) to Discord user IDs
 * by correlating audio activity timestamps. When we forward audio from a
 * specific Discord user to Deepgram, we record "who was speaking when."
 * When Deepgram returns a transcript with a speaker label and time range,
 * we find which Discord user was most active during that window.
 *
 * This enables accurate speaker attribution across all concurrent streams
 * in the merged transcript, even with 5-10 simultaneous participants.
 *
 * Approach:
 * - Each audio packet forwarded records a { userId, timestamp } activity entry
 * - Activities are bucketed into small time windows for efficient lookup
 * - When a Deepgram transcript arrives with speaker label + start/end time,
 *   we count which userId had the most activity in that window
 * - A confidence-weighted mapping is built and updated over time
 * - Once a mapping stabilizes (enough evidence), it becomes "confirmed"
 */

import { EventEmitter } from 'node:events';

/** Time bucket size in seconds for activity tracking */
const BUCKET_SIZE_SEC = 0.5;

/** Minimum activity entries needed to consider a mapping "confirmed" */
const CONFIRMATION_THRESHOLD = 5;

/** Maximum age of activity entries before eviction (seconds) */
const MAX_ACTIVITY_AGE_SEC = 300; // 5 minutes

/** How often to run eviction of stale entries (ms) */
const EVICTION_INTERVAL_MS = 60_000;

/**
 * @typedef {Object} SpeakerMapping
 * @property {number} speakerLabel - Deepgram speaker label
 * @property {string} userId - Discord user ID
 * @property {string} displayName - Resolved display name
 * @property {number} confidence - 0.0-1.0 mapping confidence
 * @property {number} evidenceCount - Number of transcript matches supporting this
 * @property {boolean} confirmed - Whether mapping has enough evidence
 */

/**
 * @typedef {Object} ActivityEntry
 * @property {string} userId - Discord user ID
 * @property {number} timestamp - Session-relative time in seconds
 */

/**
 * @typedef {Object} IdentificationResult
 * @property {string|null} userId - Matched Discord user ID (null if unknown)
 * @property {string} displayName - Display name (or "Speaker N" fallback)
 * @property {number} confidence - Match confidence 0.0-1.0
 * @property {boolean} isNewMapping - Whether this created a new mapping
 */

/**
 * Events emitted:
 * - 'mapping_created'   : SpeakerMapping - new speaker<->user mapping established
 * - 'mapping_confirmed' : SpeakerMapping - mapping reached confirmation threshold
 * - 'mapping_updated'   : SpeakerMapping - existing mapping confidence changed
 * - 'mapping_conflict'  : { speakerLabel, oldUserId, newUserId } - mapping reassigned
 */
export class SpeakerIdentifier extends EventEmitter {
  /**
   * Activity entries bucketed by time.
   * Key: bucket index (Math.floor(timestamp / BUCKET_SIZE_SEC))
   * Value: Map<userId, packetCount>
   * @type {Map<number, Map<string, number>>}
   */
  #activityBuckets = new Map();

  /**
   * Deepgram speaker label -> mapping info
   * @type {Map<number, SpeakerMapping>}
   */
  #speakerMappings = new Map();

  /**
   * Reverse mapping: userId -> speaker label
   * @type {Map<string, number>}
   */
  #userToSpeaker = new Map();

  /**
   * Display name registry: userId -> display name
   * @type {Map<string, string>}
   */
  #displayNames = new Map();

  /**
   * Evidence accumulator: tracks how many times a (speakerLabel, userId)
   * pair co-occurs in time windows.
   * Key: `${speakerLabel}:${userId}`, Value: count
   * @type {Map<string, number>}
   */
  #evidence = new Map();

  /** @type {number} session start timestamp (ms) */
  #sessionStartMs = 0;

  /** @type {NodeJS.Timeout|null} */
  #evictionTimer = null;

  /** @type {number} total activities recorded */
  #totalActivities = 0;

  /** @type {number} total identifications performed */
  #totalIdentifications = 0;

  constructor() {
    super();
    this.#sessionStartMs = Date.now();
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /**
   * Record that a Discord user sent an audio packet at a given time.
   * Called by AudioCapturePipeline each time it forwards audio.
   *
   * @param {string} userId - Discord user ID
   * @param {number} [timestampSec] - Session-relative time in seconds.
   *   If omitted, computed from session start time.
   */
  recordActivity(userId, timestampSec) {
    const ts = timestampSec ?? this.#currentTimeSec();
    const bucketIdx = Math.floor(ts / BUCKET_SIZE_SEC);

    let bucket = this.#activityBuckets.get(bucketIdx);
    if (!bucket) {
      bucket = new Map();
      this.#activityBuckets.set(bucketIdx, bucket);
    }

    bucket.set(userId, (bucket.get(userId) || 0) + 1);
    this.#totalActivities++;
  }

  /**
   * Identify which Discord user corresponds to a Deepgram speaker label
   * based on the transcript's time range.
   *
   * @param {number} speakerLabel - Deepgram's speaker diarization label
   * @param {number} startSec - Transcript segment start time (seconds)
   * @param {number} endSec - Transcript segment end time (seconds)
   * @returns {IdentificationResult}
   */
  identify(speakerLabel, startSec, endSec) {
    this.#totalIdentifications++;

    // If we already have a confirmed mapping, use it directly
    const existing = this.#speakerMappings.get(speakerLabel);
    if (existing?.confirmed) {
      return {
        userId: existing.userId,
        displayName: existing.displayName,
        confidence: existing.confidence,
        isNewMapping: false,
      };
    }

    // Find the most active user in the time range
    const candidates = this.#findActiveSpeakers(startSec, endSec);

    if (candidates.length === 0) {
      // No activity data — use existing mapping if any, otherwise fallback
      if (existing) {
        return {
          userId: existing.userId,
          displayName: existing.displayName,
          confidence: existing.confidence,
          isNewMapping: false,
        };
      }
      return {
        userId: null,
        displayName: `Speaker ${speakerLabel}`,
        confidence: 0,
        isNewMapping: false,
      };
    }

    // Filter out users already confirmed to other speaker labels
    const available = candidates.filter(c => {
      const assignedLabel = this.#userToSpeaker.get(c.userId);
      return assignedLabel === undefined || assignedLabel === speakerLabel;
    });

    const best = available.length > 0 ? available[0] : candidates[0];

    // Update evidence
    const evidenceKey = `${speakerLabel}:${best.userId}`;
    const newCount = (this.#evidence.get(evidenceKey) || 0) + 1;
    this.#evidence.set(evidenceKey, newCount);

    // Create or update mapping
    return this.#updateMapping(speakerLabel, best.userId, best.ratio, newCount);
  }

  /**
   * Register a display name for a Discord user.
   * @param {string} userId
   * @param {string} displayName
   */
  registerUser(userId, displayName) {
    this.#displayNames.set(userId, displayName);

    // Update any existing mapping that references this user
    const label = this.#userToSpeaker.get(userId);
    if (label !== undefined) {
      const mapping = this.#speakerMappings.get(label);
      if (mapping) {
        mapping.displayName = displayName;
        this.emit('mapping_updated', { ...mapping });
      }
    }
  }

  /**
   * Manually set a speaker mapping (e.g., from external correlation).
   * @param {number} speakerLabel
   * @param {string} userId
   * @param {string} [displayName]
   */
  setMapping(speakerLabel, userId, displayName) {
    const name = displayName || this.#displayNames.get(userId) || `User-${userId.slice(-4)}`;
    this.#displayNames.set(userId, name);

    const mapping = {
      speakerLabel,
      userId,
      displayName: name,
      confidence: 1.0,
      evidenceCount: CONFIRMATION_THRESHOLD,
      confirmed: true,
    };

    // Remove old reverse mappings
    const oldMapping = this.#speakerMappings.get(speakerLabel);
    if (oldMapping && oldMapping.userId !== userId) {
      this.#userToSpeaker.delete(oldMapping.userId);
    }

    this.#speakerMappings.set(speakerLabel, mapping);
    this.#userToSpeaker.set(userId, speakerLabel);
    this.emit('mapping_confirmed', { ...mapping });
  }

  /**
   * Get the current mapping for a speaker label.
   * @param {number} speakerLabel
   * @returns {SpeakerMapping|null}
   */
  getMapping(speakerLabel) {
    return this.#speakerMappings.get(speakerLabel) ?? null;
  }

  /**
   * Get the speaker label for a Discord user ID.
   * @param {string} userId
   * @returns {number|null}
   */
  getSpeakerLabel(userId) {
    return this.#userToSpeaker.get(userId) ?? null;
  }

  /**
   * Get all current speaker mappings.
   * @returns {Map<number, SpeakerMapping>}
   */
  getAllMappings() {
    return new Map(this.#speakerMappings);
  }

  /**
   * Resolve a speaker label to a display name.
   * Convenience method for use in transcript entries.
   * @param {number} speakerLabel
   * @returns {string}
   */
  resolveName(speakerLabel) {
    const mapping = this.#speakerMappings.get(speakerLabel);
    if (mapping) return mapping.displayName;
    return `Speaker ${speakerLabel}`;
  }

  /**
   * Get statistics about the identifier state.
   * @returns {Object}
   */
  getStats() {
    const mappings = [];
    for (const [label, m] of this.#speakerMappings) {
      mappings.push({
        speakerLabel: label,
        userId: m.userId,
        displayName: m.displayName,
        confidence: m.confidence,
        evidenceCount: m.evidenceCount,
        confirmed: m.confirmed,
      });
    }

    return {
      totalActivities: this.#totalActivities,
      totalIdentifications: this.#totalIdentifications,
      activityBuckets: this.#activityBuckets.size,
      mappingCount: this.#speakerMappings.size,
      confirmedCount: [...this.#speakerMappings.values()].filter(m => m.confirmed).length,
      registeredUsers: this.#displayNames.size,
      mappings,
    };
  }

  /**
   * Start periodic eviction of stale activity data.
   */
  startEviction() {
    this.stopEviction();
    this.#evictionTimer = setInterval(() => {
      this.#evictStaleEntries();
    }, EVICTION_INTERVAL_MS);
    if (this.#evictionTimer.unref) {
      this.#evictionTimer.unref();
    }
  }

  /**
   * Stop periodic eviction.
   */
  stopEviction() {
    if (this.#evictionTimer) {
      clearInterval(this.#evictionTimer);
      this.#evictionTimer = null;
    }
  }

  /**
   * Reset all state. Call when starting a new session.
   */
  reset() {
    this.stopEviction();
    this.#activityBuckets.clear();
    this.#speakerMappings.clear();
    this.#userToSpeaker.clear();
    this.#displayNames.clear();
    this.#evidence.clear();
    this.#sessionStartMs = Date.now();
    this.#totalActivities = 0;
    this.#totalIdentifications = 0;
  }

  // ──────────────────────────────────────────────
  // Private methods
  // ──────────────────────────────────────────────

  /**
   * Compute current session-relative time in seconds.
   * @returns {number}
   */
  #currentTimeSec() {
    return (Date.now() - this.#sessionStartMs) / 1000;
  }

  /**
   * Find which users were most active during a time range.
   * Returns candidates sorted by activity ratio (descending).
   *
   * @param {number} startSec
   * @param {number} endSec
   * @returns {Array<{ userId: string, packets: number, ratio: number }>}
   */
  #findActiveSpeakers(startSec, endSec) {
    const startBucket = Math.floor(startSec / BUCKET_SIZE_SEC);
    const endBucket = Math.floor(endSec / BUCKET_SIZE_SEC);

    /** @type {Map<string, number>} userId -> total packet count */
    const userPackets = new Map();
    let totalPackets = 0;

    for (let b = startBucket; b <= endBucket; b++) {
      const bucket = this.#activityBuckets.get(b);
      if (!bucket) continue;

      for (const [userId, count] of bucket) {
        userPackets.set(userId, (userPackets.get(userId) || 0) + count);
        totalPackets += count;
      }
    }

    if (totalPackets === 0) return [];

    // Sort by packet count descending
    const candidates = [...userPackets.entries()]
      .map(([userId, packets]) => ({
        userId,
        packets,
        ratio: packets / totalPackets,
      }))
      .sort((a, b) => b.packets - a.packets);

    return candidates;
  }

  /**
   * Create or update a speaker mapping based on new evidence.
   *
   * @param {number} speakerLabel
   * @param {string} userId
   * @param {number} activityRatio - How dominant this user was in the time window
   * @param {number} evidenceCount - Total co-occurrences
   * @returns {IdentificationResult}
   */
  #updateMapping(speakerLabel, userId, activityRatio, evidenceCount) {
    const displayName = this.#displayNames.get(userId) || `User-${userId.slice(-4)}`;
    const existing = this.#speakerMappings.get(speakerLabel);

    // Calculate confidence: combination of activity ratio and evidence count
    const evidenceFactor = Math.min(evidenceCount / CONFIRMATION_THRESHOLD, 1.0);
    const confidence = activityRatio * 0.4 + evidenceFactor * 0.6;
    const confirmed = evidenceCount >= CONFIRMATION_THRESHOLD && confidence >= 0.5;

    if (existing && existing.userId !== userId) {
      // Mapping conflict — the best candidate changed
      // Only switch if new evidence is stronger
      const oldEvidenceKey = `${speakerLabel}:${existing.userId}`;
      const oldCount = this.#evidence.get(oldEvidenceKey) || 0;

      if (evidenceCount > oldCount) {
        // Switch mapping
        this.#userToSpeaker.delete(existing.userId);
        this.emit('mapping_conflict', {
          speakerLabel,
          oldUserId: existing.userId,
          newUserId: userId,
        });
      } else {
        // Keep existing mapping
        return {
          userId: existing.userId,
          displayName: existing.displayName,
          confidence: existing.confidence,
          isNewMapping: false,
        };
      }
    }

    const isNew = !existing || existing.userId !== userId;
    const wasConfirmed = existing?.confirmed ?? false;

    const mapping = {
      speakerLabel,
      userId,
      displayName,
      confidence,
      evidenceCount,
      confirmed,
    };

    this.#speakerMappings.set(speakerLabel, mapping);
    this.#userToSpeaker.set(userId, speakerLabel);

    // Emit appropriate event
    if (isNew) {
      this.emit('mapping_created', { ...mapping });
    } else {
      this.emit('mapping_updated', { ...mapping });
    }

    if (confirmed && !wasConfirmed) {
      this.emit('mapping_confirmed', { ...mapping });
    }

    return {
      userId,
      displayName,
      confidence,
      isNewMapping: isNew,
    };
  }

  /**
   * Evict activity entries older than MAX_ACTIVITY_AGE_SEC.
   */
  #evictStaleEntries() {
    const currentSec = this.#currentTimeSec();
    const cutoffBucket = Math.floor((currentSec - MAX_ACTIVITY_AGE_SEC) / BUCKET_SIZE_SEC);

    let evicted = 0;
    for (const [bucketIdx] of this.#activityBuckets) {
      if (bucketIdx < cutoffBucket) {
        this.#activityBuckets.delete(bucketIdx);
        evicted++;
      }
    }

    if (evicted > 0) {
      console.log(`[SpeakerIdentifier] Evicted ${evicted} stale activity buckets`);
    }
  }
}

export {
  BUCKET_SIZE_SEC,
  CONFIRMATION_THRESHOLD,
  MAX_ACTIVITY_AGE_SEC,
  EVICTION_INTERVAL_MS,
};
