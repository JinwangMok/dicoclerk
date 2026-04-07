/**
 * Minutes Data Aggregator
 *
 * Collects and structures all session data into a single in-memory object
 * upon session end. This object serves as the canonical source of truth for:
 *   - Meeting minutes generation (formatter.js)
 *   - Disk archival (generator.js)
 *   - MCP tool exposure (mcp/tools.js)
 *   - Index storage (index-store.js)
 *
 * Inputs gathered from:
 *   - SessionManager SessionInfo: guildId, channelIds, language, participants, startedBy, startedAt
 *   - AudioSessionCoordinator.stop() result: transcript entries, transcript file path
 *   - AudioSessionCoordinator.speakerMap: Deepgram speaker label -> display name
 *   - Discord Guild object: guild name, channel name resolution
 *   - Session end context: duration, reason, endedAt
 *
 * The resulting SessionMinutesData object is fully self-contained —
 * no further Discord API calls or file I/O are needed to generate minutes.
 */

import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TranscriptEntry
 * @property {number} speaker          - Deepgram diarization speaker label (0, 1, 2…)
 * @property {string} speakerName      - Resolved display name ("Alice" or "Speaker 0")
 * @property {string|null} userId      - Discord user ID if identified, otherwise null
 * @property {string} text             - Final transcribed utterance
 * @property {number} confidence       - ASR confidence score (0–1)
 * @property {number} [speakerConfidence] - Speaker identification confidence (0–1)
 * @property {number} start            - Utterance start offset (seconds from session start)
 * @property {number} end              - Utterance end offset (seconds from session start)
 * @property {number} timestamp        - Wall-clock epoch ms when the entry was recorded
 * @property {boolean} [isFinal]       - Whether the entry was a Deepgram final result
 */

/**
 * @typedef {Object} SpeakerInfo
 * @property {number} speakerLabel     - Deepgram diarization speaker label
 * @property {string} displayName      - Resolved display name
 * @property {string|null} userId      - Discord user ID if identified
 * @property {number} utteranceCount   - Total number of final utterances
 * @property {number} totalSpeakingSeconds - Cumulative speaking time across all utterances
 * @property {number} avgConfidence    - Average ASR confidence across utterances
 */

/**
 * @typedef {Object} SessionMinutesData
 * @property {string}   sessionId            - Unique session identifier (UUID)
 * @property {string}   guildId              - Discord guild (server) ID
 * @property {string}   guildName            - Discord guild display name
 * @property {string}   channelId            - Voice channel ID
 * @property {string}   channelName          - Voice channel display name
 * @property {string}   textChannelId        - Text channel where minutes will be delivered
 * @property {string}   language             - Primary language code ('ko', 'en', 'multi')
 * @property {string}   startedBy            - Display name / tag of user who ran /start
 * @property {Date}     startedAt            - Session start timestamp
 * @property {Date}     endedAt              - Session end timestamp
 * @property {number}   durationSeconds      - Total session duration in seconds
 * @property {string}   reason               - Why the session ended ('manual_stop' | 'channel_empty' | 'connection_destroyed' | 'shutdown')
 * @property {string[]} participantIds       - Discord user IDs who were in the channel (from SessionInfo.participants)
 * @property {Map<number, string>} speakerMap - Deepgram speaker label -> resolved display name
 * @property {SpeakerInfo[]} speakers        - Per-speaker enriched statistics
 * @property {TranscriptEntry[]} transcript  - Full chronological transcript
 * @property {number}   transcriptCount      - Total number of transcript entries
 * @property {string|null} transcriptFilePath - Local disk path to the raw JSON transcript
 * @property {string[]} warnings             - Non-fatal issues encountered during aggregation
 * @property {string}   aggregatedAt         - ISO 8601 timestamp when this object was created
 */

// ---------------------------------------------------------------------------
// Core aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregate all session data into a single structured in-memory object.
 *
 * This function is called once per session, immediately after the audio
 * coordinator has been stopped and the raw transcript has been saved.
 * It is synchronous-safe: all async operations (coordinator stop, disk saves)
 * must be completed before calling this function.
 *
 * @param {Object} params
 * @param {Object}             params.session              - SessionInfo from SessionManager
 * @param {string}             params.session.guildId
 * @param {string}             params.session.voiceChannelId
 * @param {string}             params.session.textChannelId
 * @param {string}             params.session.language
 * @param {string}             params.session.startedBy
 * @param {Date}               params.session.startedAt
 * @param {Set<string>}        [params.session.participants] - Discord user IDs
 * @param {Array}              [params.session.transcript]   - Fallback transcript if coordinator absent
 * @param {Object}             [params.coordinatorResult]   - Return value of AudioSessionCoordinator.stop()
 * @param {TranscriptEntry[]}  [params.coordinatorResult.transcript]
 * @param {string|null}        [params.coordinatorResult.filePath]
 * @param {Map<number,string>} [params.coordinatorResult.speakerMap] - May be provided separately
 * @param {Map<number,string>} [params.speakerMap]          - Speaker map from coordinator (overrides coordinatorResult.speakerMap)
 * @param {import('discord.js').Guild} [params.guild]       - Discord guild object for name resolution
 * @param {number}             params.durationSeconds       - Session duration in seconds
 * @param {string}             params.reason                - Session end reason
 * @param {string[]}           [params.warnings]            - Pre-existing warnings (e.g., from cleanupSession)
 * @returns {SessionMinutesData}
 */
export function aggregateSessionData({
  session,
  coordinatorResult = null,
  speakerMap: externalSpeakerMap = null,
  guild = null,
  durationSeconds,
  reason,
  warnings: preWarnings = [],
}) {
  const aggregationWarnings = [...preWarnings];
  const now = new Date();

  // --- Validate required inputs ---
  if (!session) {
    throw new Error('[Aggregator] session is required');
  }
  if (typeof durationSeconds !== 'number' || durationSeconds < 0) {
    aggregationWarnings.push(`Invalid durationSeconds (${durationSeconds}), defaulting to 0`);
    durationSeconds = 0;
  }

  // --- Resolve transcript ---
  // Prefer coordinator result, fall back to session.transcript
  const rawTranscript =
    coordinatorResult?.transcript?.length > 0
      ? coordinatorResult.transcript
      : (session.transcript?.length > 0 ? session.transcript : []);

  if (rawTranscript.length === 0) {
    aggregationWarnings.push('No transcript entries available');
  }

  // Ensure every entry is a plain object with required fields
  const transcript = normalizeTranscript(rawTranscript, aggregationWarnings);

  // --- Resolve speaker map ---
  // Priority: externalSpeakerMap > coordinatorResult.speakerMap > inferred from transcript
  const speakerMap = buildSpeakerMap(externalSpeakerMap, coordinatorResult, transcript, aggregationWarnings);

  // --- Resolve guild / channel names ---
  const guildName = guild?.name ?? 'Unknown Server';
  const channelName = resolveChannelName(guild, session.voiceChannelId);

  // --- Resolve participants ---
  const participantIds = resolveParticipantIds(session.participants);

  // --- Compute per-speaker statistics ---
  const speakers = computeSpeakerStats(transcript, speakerMap);

  // --- Compute timestamps ---
  const startedAt = session.startedAt instanceof Date ? session.startedAt : new Date(session.startedAt ?? 0);
  const endedAt = new Date(startedAt.getTime() + durationSeconds * 1000);

  // --- Build the structured object ---
  /** @type {SessionMinutesData} */
  const data = {
    sessionId: session.sessionId ?? coordinatorResult?.sessionId ?? randomUUID(),
    guildId: session.guildId ?? '',
    guildName,
    channelId: session.voiceChannelId ?? '',
    channelName,
    textChannelId: session.textChannelId ?? '',
    language: session.language ?? 'ko',
    startedBy: session.startedBy ?? 'Unknown',
    startedAt,
    endedAt,
    durationSeconds,
    reason: reason ?? 'unknown',
    participantIds,
    speakerMap,
    speakers,
    transcript,
    transcriptCount: transcript.length,
    transcriptFilePath: coordinatorResult?.filePath ?? null,
    warnings: aggregationWarnings,
    aggregatedAt: now.toISOString(),
  };

  console.log(
    `[Aggregator] Session data aggregated: sessionId=${data.sessionId} ` +
    `entries=${data.transcriptCount} speakers=${data.speakers.length} ` +
    `duration=${durationSeconds}s reason=${reason} warnings=${aggregationWarnings.length}`
  );

  return data;
}

/**
 * Convenience wrapper: build a SessionMinutesData from the output of
 * cleanupSession() plus contextual Discord data.
 *
 * This is the primary entry point when called from generator.js or the
 * /stop command handler. It adapts the CleanupResult shape to the
 * aggregator's parameter format.
 *
 * @param {Object} params
 * @param {import('../session/session-cleanup.js').CleanupResult} params.cleanupResult
 * @param {Object}             params.session      - SessionInfo (from event payload or lookup)
 * @param {Map<number,string>} [params.speakerMap] - From AudioSessionCoordinator.speakerMap getter
 * @param {import('discord.js').Guild} [params.guild]
 * @returns {SessionMinutesData}
 */
export function aggregateFromCleanupResult({ cleanupResult, session, speakerMap = null, guild = null }) {
  return aggregateSessionData({
    session,
    coordinatorResult: {
      transcript: cleanupResult.transcript,
      filePath: cleanupResult.transcriptFilePath,
    },
    speakerMap,
    guild,
    durationSeconds: cleanupResult.duration,
    reason: cleanupResult.reason,
    warnings: cleanupResult.warnings ?? [],
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize raw transcript entries to ensure consistent shape.
 * Missing optional fields are filled with sensible defaults.
 *
 * @param {Array} rawEntries
 * @param {string[]} warnings - Mutable warnings array to append issues to
 * @returns {TranscriptEntry[]}
 */
function normalizeTranscript(rawEntries, warnings) {
  const normalized = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const entry = rawEntries[i];

    if (!entry || typeof entry !== 'object') {
      warnings.push(`Transcript entry at index ${i} is not an object — skipped`);
      continue;
    }

    if (typeof entry.text !== 'string' || entry.text.trim() === '') {
      warnings.push(`Transcript entry at index ${i} has empty text — skipped`);
      continue;
    }

    normalized.push({
      speaker:           typeof entry.speaker === 'number' ? entry.speaker : -1,
      speakerName:       typeof entry.speakerName === 'string' ? entry.speakerName : `Speaker ${entry.speaker ?? '?'}`,
      userId:            entry.userId ?? null,
      text:              entry.text.trim(),
      confidence:        typeof entry.confidence === 'number' ? entry.confidence : 0,
      speakerConfidence: typeof entry.speakerConfidence === 'number' ? entry.speakerConfidence : null,
      start:             typeof entry.start === 'number' ? entry.start : 0,
      end:               typeof entry.end === 'number' ? entry.end : 0,
      timestamp:         typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
      isFinal:           entry.isFinal !== false, // default true for stored entries
    });
  }

  // Sort by start time to ensure chronological order
  normalized.sort((a, b) => a.start - b.start || a.timestamp - b.timestamp);

  return normalized;
}

/**
 * Build the canonical speaker map (speakerLabel -> displayName).
 *
 * Resolution order:
 * 1. externalSpeakerMap (from coordinator.speakerMap getter — most authoritative)
 * 2. coordinatorResult.speakerMap (if it was packed into the stop() result)
 * 3. Inferred from transcript speakerName fields (fallback)
 *
 * @param {Map<number,string>|Object|null} externalSpeakerMap
 * @param {Object|null} coordinatorResult
 * @param {TranscriptEntry[]} transcript
 * @param {string[]} warnings
 * @returns {Map<number, string>}
 */
function buildSpeakerMap(externalSpeakerMap, coordinatorResult, transcript, warnings) {
  const result = new Map();

  // Helper: merge a source (Map or plain object) into result
  function mergeSource(src, label) {
    if (!src) return;
    try {
      if (src instanceof Map) {
        for (const [k, v] of src) {
          const numKey = typeof k === 'number' ? k : Number(k);
          if (!isNaN(numKey) && typeof v === 'string' && v.trim()) {
            result.set(numKey, v.trim());
          }
        }
      } else if (typeof src === 'object') {
        for (const [k, v] of Object.entries(src)) {
          const numKey = Number(k);
          if (!isNaN(numKey) && typeof v === 'string' && v.trim()) {
            result.set(numKey, v.trim());
          }
        }
      }
    } catch (err) {
      warnings.push(`Failed to merge ${label} speaker map: ${err.message}`);
    }
  }

  // Priority 3 (lowest): infer from transcript entries
  for (const entry of transcript) {
    if (typeof entry.speaker === 'number' && entry.speaker >= 0) {
      if (!result.has(entry.speaker) && typeof entry.speakerName === 'string' && entry.speakerName.trim()) {
        result.set(entry.speaker, entry.speakerName.trim());
      }
    }
  }

  // Priority 2: coordinator result's speakerMap field
  if (coordinatorResult?.speakerMap) {
    mergeSource(coordinatorResult.speakerMap, 'coordinatorResult');
  }

  // Priority 1 (highest): external speaker map (from coordinator.speakerMap getter)
  if (externalSpeakerMap) {
    mergeSource(externalSpeakerMap, 'external');
  }

  return result;
}

/**
 * Resolve Discord voice channel name from guild's channel cache.
 *
 * @param {import('discord.js').Guild|null} guild
 * @param {string} voiceChannelId
 * @returns {string}
 */
function resolveChannelName(guild, voiceChannelId) {
  if (!guild || !voiceChannelId) return 'Unknown Channel';
  try {
    const channel = guild.channels?.cache?.get(voiceChannelId);
    return channel?.name ?? 'Unknown Channel';
  } catch {
    return 'Unknown Channel';
  }
}

/**
 * Extract participant IDs from a Set<string> or array.
 *
 * @param {Set<string>|string[]|null|undefined} participants
 * @returns {string[]}
 */
function resolveParticipantIds(participants) {
  if (!participants) return [];
  if (participants instanceof Set) return [...participants];
  if (Array.isArray(participants)) return participants.filter(id => typeof id === 'string');
  return [];
}

/**
 * Compute per-speaker statistics from the normalized transcript.
 *
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number, string>} speakerMap
 * @returns {SpeakerInfo[]}
 */
function computeSpeakerStats(transcript, speakerMap) {
  /** @type {Map<number, { utterances: number, totalSecs: number, confidenceSum: number, userId: string|null }>} */
  const accumulators = new Map();

  for (const entry of transcript) {
    const label = typeof entry.speaker === 'number' ? entry.speaker : -1;

    if (!accumulators.has(label)) {
      accumulators.set(label, {
        utterances: 0,
        totalSecs: 0,
        confidenceSum: 0,
        userId: null,
      });
    }

    const acc = accumulators.get(label);
    acc.utterances++;
    acc.totalSecs += Math.max(0, (entry.end ?? 0) - (entry.start ?? 0));
    acc.confidenceSum += entry.confidence ?? 0;

    // Capture userId from the entry (first non-null wins)
    if (!acc.userId && entry.userId) {
      acc.userId = entry.userId;
    }
  }

  /** @type {SpeakerInfo[]} */
  const speakers = [];

  for (const [label, acc] of accumulators) {
    const displayName = speakerMap.get(label) ?? `Speaker ${label}`;
    speakers.push({
      speakerLabel: label,
      displayName,
      userId: acc.userId,
      utteranceCount: acc.utterances,
      totalSpeakingSeconds: Math.round(acc.totalSecs * 10) / 10,
      avgConfidence: acc.utterances > 0
        ? Math.round((acc.confidenceSum / acc.utterances) * 1000) / 1000
        : 0,
    });
  }

  // Sort by speaker label for deterministic output
  speakers.sort((a, b) => a.speakerLabel - b.speakerLabel);

  return speakers;
}

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

/**
 * Convert a SessionMinutesData object to a plain JSON-serializable object.
 * Useful for MCP tool responses, logging, and disk storage.
 * Converts the Map to a plain object for serialization.
 *
 * @param {SessionMinutesData} data
 * @returns {Object}
 */
export function toSerializable(data) {
  return {
    ...data,
    speakerMap: Object.fromEntries(data.speakerMap),
    startedAt: data.startedAt instanceof Date ? data.startedAt.toISOString() : data.startedAt,
    endedAt: data.endedAt instanceof Date ? data.endedAt.toISOString() : data.endedAt,
  };
}

/**
 * Build the SessionMetadata shape expected by formatter.js from a
 * SessionMinutesData object. This avoids duplicating the metadata
 * construction logic in generator.js.
 *
 * @param {SessionMinutesData} data
 * @returns {import('./formatter.js').SessionMetadata}
 */
export function toFormatterMetadata(data) {
  return {
    guildName:       data.guildName,
    channelName:     data.channelName,
    startedAt:       data.startedAt,
    durationSeconds: data.durationSeconds,
    startedBy:       data.startedBy,
    language:        data.language,
    speakerMap:      new Map(data.speakerMap), // defensive copy
  };
}
