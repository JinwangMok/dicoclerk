/**
 * Meeting Minutes Content Processor
 *
 * Transforms SessionMinutesData (from aggregator.js) into a structured
 * MinutesContent object with typed sections, using Deepgram diarization
 * output (speakerMap, speakers array) for speaker attribution.
 *
 * This module sits between the aggregator and the formatter in the pipeline:
 *
 *   aggregator.js  →  content-processor.js  →  formatter.js  →  generator.js
 *
 * The MinutesContent object provides a language-independent, structured
 * intermediate representation that can be:
 *   - Rendered to Markdown by formatter.js (renderMinutesFromContent)
 *   - Returned as JSON by MCP tools (mcp/tools.js)
 *   - Used by summarizer.js without disk I/O
 *
 * Sections produced:
 *   1. attendees    - Per-speaker records with diarization stats
 *   2. summary      - Narrative text + top topics + speaker contributions
 *   3. keyTopics    - Heuristically identified discussion points
 *   4. decisions    - Utterances matching decision signal patterns
 *   5. actionItems  - Utterances matching action-item patterns with
 *                     assignee and deadline extraction
 *
 * All extraction is done entirely offline (no LLM calls).
 */

import {
  extractAttendees,
  extractActionItems,
  extractDecisions,
  extractKeyPoints,
  generateSummary,
  extractTopTopics,
  extractMeetingPhases,
  computeSpeakerContributions,
} from './formatter.js';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AttendeeRecord
 * @property {number}      speakerLabel      - Deepgram speaker label (0, 1, 2…)
 * @property {string}      displayName       - Resolved display name ("Alice" or "Speaker 0")
 * @property {string|null} userId            - Discord user ID if identified, else null
 * @property {number}      utteranceCount    - Total number of final utterances
 * @property {number}      speakingSeconds   - Cumulative speaking time in seconds
 * @property {number}      avgConfidence     - Average ASR confidence (0–1)
 * @property {number}      contributionPct   - Participation share (0–100, integer)
 */

/**
 * @typedef {Object} SummarySection
 * @property {string}   text             - Markdown narrative summary text
 * @property {string[]} topTopics        - Top N keyword/bigram topics
 * @property {{ name: string, percentage: number }[]} contributions - Per-speaker share
 * @property {string|null} opening       - Opening statement snippet ("Name: text")
 * @property {string|null} closing       - Closing statement snippet ("Name: text")
 */

/**
 * @typedef {Object} KeyTopicRecord
 * @property {string}   topic       - Representative topic text (≤80 chars)
 * @property {string[]} speakers    - Names of speakers active in this segment
 * @property {number}   startTime   - Segment start offset in seconds
 * @property {string}   summary     - Brief snippet from the segment (≤200 chars)
 */

/**
 * @typedef {Object} DecisionRecord
 * @property {string} text        - Full utterance text that signals a decision
 * @property {string} speaker     - Resolved display name of the speaker
 * @property {number} timestamp   - Utterance start offset in seconds
 */

/**
 * @typedef {Object} ActionItemRecord
 * @property {string}      text       - Full utterance text that signals an action item
 * @property {string}      speaker    - Resolved display name of the speaker
 * @property {string|null} assignee   - Person responsible (extracted or inferred), or null
 * @property {string|null} deadline   - Deadline phrase (e.g. "내일", "next Friday"), or null
 * @property {number}      timestamp  - Utterance start offset in seconds
 */

/**
 * @typedef {Object} MinutesContent
 * @property {string}   sessionId         - Session identifier (UUID)
 * @property {string}   guildName         - Discord server display name
 * @property {string}   channelName       - Voice channel display name
 * @property {Date}     startedAt         - Session start timestamp
 * @property {Date}     endedAt           - Session end timestamp
 * @property {number}   durationSeconds   - Total session duration in seconds
 * @property {string}   startedBy         - Display name/tag of the user who ran /start
 * @property {string}   language          - Primary language code ('ko' | 'en' | 'multi')
 * @property {string}   reason            - Why the session ended
 * @property {AttendeeRecord[]}  attendees    - Per-speaker structured records
 * @property {SummarySection}   summary      - Meeting summary data
 * @property {KeyTopicRecord[]} keyTopics    - Identified discussion topics
 * @property {DecisionRecord[]} decisions    - Extracted decision utterances
 * @property {ActionItemRecord[]} actionItems - Extracted action items
 * @property {import('./aggregator.js').TranscriptEntry[]} transcript - Full transcript
 * @property {Map<number, string>} speakerMap - Deepgram speaker label → display name
 * @property {string}   processedAt       - ISO 8601 timestamp of when processing ran
 */

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

export const DEFAULT_PROCESSOR_OPTIONS = {
  /** Maximum number of key topic segments to extract */
  maxKeyTopics: 5,
  /** Maximum number of decisions to extract */
  maxDecisions: 10,
  /** Maximum number of action items to extract */
  maxActionItems: 10,
  /** Maximum number of top keyword topics for the summary section */
  maxTopTopics: 5,
};

// ---------------------------------------------------------------------------
// Primary export: processMinutesContent
// ---------------------------------------------------------------------------

/**
 * Transform a SessionMinutesData object into a structured MinutesContent.
 *
 * Uses Deepgram diarization output (speakerMap, speakers) for speaker
 * attribution. The resulting object is suitable for both Markdown rendering
 * and direct JSON serialization by MCP tools.
 *
 * @param {import('./aggregator.js').SessionMinutesData} sessionData
 *   The fully aggregated session data object produced by aggregator.js.
 * @param {Partial<typeof DEFAULT_PROCESSOR_OPTIONS>} [options]
 *   Optional overrides for extraction behaviour.
 * @returns {MinutesContent}
 *
 * @throws {TypeError} When sessionData is null/undefined or not an object.
 * @throws {Error}     When sessionData.transcript is present but not an Array.
 */
export function processMinutesContent(sessionData, options = {}) {
  // --- Validation ---
  if (!sessionData || typeof sessionData !== 'object') {
    throw new TypeError('[ContentProcessor] sessionData must be a non-null object');
  }

  if (sessionData.transcript !== undefined && !Array.isArray(sessionData.transcript)) {
    throw new Error('[ContentProcessor] sessionData.transcript must be an Array when present');
  }

  const opts = { ...DEFAULT_PROCESSOR_OPTIONS, ...options };

  const {
    sessionId = '',
    guildName = 'Unknown Server',
    channelName = 'Unknown Channel',
    startedAt = new Date(),
    endedAt = new Date(),
    durationSeconds = 0,
    startedBy = 'Unknown',
    language = 'ko',
    reason = 'unknown',
    transcript = [],
    speakerMap: rawSpeakerMap = new Map(),
    speakers: rawSpeakers = [],
  } = sessionData;

  // Normalise speakerMap — accept both Map<number,string> and plain objects
  const speakerMap = _normaliseSpeakerMap(rawSpeakerMap);

  // Normalise timestamps to Date objects
  const normalStartedAt = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const normalEndedAt   = endedAt   instanceof Date ? endedAt   : new Date(endedAt);

  // --- 1. Attendees section (enriched with diarization stats) ---
  const attendees = _buildAttendeesSection(rawSpeakers, transcript, speakerMap);

  // --- 2. Summary section ---
  const summary = _buildSummarySection(
    transcript, attendees, durationSeconds, language, speakerMap, opts.maxTopTopics
  );

  // --- 3. Key Topics ---
  const keyTopics = extractKeyPoints(
    transcript, speakerMap, language, opts.maxKeyTopics
  );

  // --- 4. Decisions ---
  const decisions = extractDecisions(
    transcript, speakerMap, language, opts.maxDecisions
  );

  // --- 5. Action Items ---
  const actionItems = extractActionItems(
    transcript, speakerMap, language, opts.maxActionItems
  );

  console.log(
    `[ContentProcessor] Processed session ${sessionId}: ` +
    `attendees=${attendees.length} topics=${keyTopics.length} ` +
    `decisions=${decisions.length} actionItems=${actionItems.length} ` +
    `lang=${language}`
  );

  return {
    sessionId,
    guildName,
    channelName,
    startedAt: normalStartedAt,
    endedAt: normalEndedAt,
    durationSeconds,
    startedBy,
    language,
    reason,
    attendees,
    summary,
    keyTopics,
    decisions,
    actionItems,
    transcript,
    speakerMap,
    processedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Build the attendees section, preferring the richer `speakers` array from
 * the aggregator (which includes diarization stats) over the raw transcript.
 *
 * When `speakers` is empty (e.g., testing with minimal fixtures), falls back
 * to deriving stats directly from the transcript via formatter's extractAttendees.
 *
 * @param {import('./aggregator.js').SpeakerInfo[]} speakers   - Aggregator speaker stats
 * @param {import('./aggregator.js').TranscriptEntry[]} transcript
 * @param {Map<number, string>} speakerMap
 * @returns {AttendeeRecord[]}
 */
function _buildAttendeesSection(speakers, transcript, speakerMap) {
  // When aggregator speakers are available, use them (more accurate diarization data)
  if (Array.isArray(speakers) && speakers.length > 0) {
    const totalUtterances = speakers.reduce((sum, s) => sum + (s.utteranceCount ?? 0), 0);

    return speakers.map((s) => {
      const utteranceCount  = s.utteranceCount    ?? 0;
      const speakingSeconds = s.totalSpeakingSeconds ?? 0;
      const avgConfidence   = s.avgConfidence     ?? 0;
      const contributionPct = totalUtterances > 0
        ? Math.round((utteranceCount / totalUtterances) * 100)
        : 0;

      return {
        speakerLabel:    s.speakerLabel  ?? -1,
        displayName:     s.displayName   ?? speakerMap.get(s.speakerLabel) ?? `Speaker ${s.speakerLabel}`,
        userId:          s.userId        ?? null,
        utteranceCount,
        speakingSeconds,
        avgConfidence,
        contributionPct,
      };
    });
  }

  // Fallback: derive from transcript via formatter helper
  const rawAttendees = extractAttendees(transcript, speakerMap);
  const totalUtterances = rawAttendees.reduce((sum, a) => sum + a.utteranceCount, 0);

  return rawAttendees.map((a) => ({
    speakerLabel:    typeof a.id === 'number' ? a.id : -1,
    displayName:     a.name,
    userId:          null,
    utteranceCount:  a.utteranceCount,
    speakingSeconds: a.speakingTime ?? 0,
    avgConfidence:   0,
    contributionPct: totalUtterances > 0
      ? Math.round((a.utteranceCount / totalUtterances) * 100)
      : 0,
  }));
}

/**
 * Build the summary section.
 *
 * Composes data from multiple formatter helpers into a single structured object:
 *  - narrative text  via generateSummary
 *  - top topics      via extractTopTopics
 *  - contributions   via computeSpeakerContributions (attendee data)
 *  - phases          via extractMeetingPhases
 *
 * @param {import('./aggregator.js').TranscriptEntry[]} transcript
 * @param {AttendeeRecord[]} attendees
 * @param {number} durationSeconds
 * @param {string} language
 * @param {Map<number, string>} speakerMap
 * @param {number} maxTopTopics
 * @returns {SummarySection}
 */
function _buildSummarySection(transcript, attendees, durationSeconds, language, speakerMap, maxTopTopics) {
  // Build the formatter-compatible attendees shape for generateSummary
  const formatterAttendees = attendees.map((a) => ({
    id:             a.speakerLabel,
    name:           a.displayName,
    utteranceCount: a.utteranceCount,
    speakingTime:   a.speakingSeconds,
  }));

  // Narrative text (Markdown)
  const text = generateSummary(
    transcript, formatterAttendees, durationSeconds, language, speakerMap
  );

  // Top N keywords / bigrams from transcript content
  const topTopics = extractTopTopics(transcript, language, maxTopTopics);

  // Per-speaker contribution breakdown
  const contributions = computeSpeakerContributions(formatterAttendees);

  // Opening / closing statement snippets
  const { opening, closing } = extractMeetingPhases(transcript, speakerMap);

  return { text, topTopics, contributions, opening, closing };
}

// ---------------------------------------------------------------------------
// Utility: normalise speakerMap input
// ---------------------------------------------------------------------------

/**
 * Normalise a speaker map to Map<number, string>.
 * Accepts Map<number,string>, Map<string,string>, or plain objects.
 *
 * @param {Map|Object} src
 * @returns {Map<number, string>}
 */
function _normaliseSpeakerMap(src) {
  if (!src) return new Map();
  if (src instanceof Map) {
    const result = new Map();
    for (const [k, v] of src) {
      const numKey = typeof k === 'number' ? k : Number(k);
      if (!isNaN(numKey) && typeof v === 'string') {
        result.set(numKey, v);
      }
    }
    return result;
  }
  if (typeof src === 'object') {
    const result = new Map();
    for (const [k, v] of Object.entries(src)) {
      const numKey = Number(k);
      if (!isNaN(numKey) && typeof v === 'string') {
        result.set(numKey, v);
      }
    }
    return result;
  }
  return new Map();
}

// ---------------------------------------------------------------------------
// Serialization helper
// ---------------------------------------------------------------------------

/**
 * Convert a MinutesContent object to a plain JSON-serializable object.
 * Converts Map → plain object and Date → ISO string.
 *
 * @param {MinutesContent} content
 * @returns {Object}
 */
export function toSerializableContent(content) {
  return {
    ...content,
    speakerMap: Object.fromEntries(content.speakerMap),
    startedAt:  content.startedAt instanceof Date ? content.startedAt.toISOString() : content.startedAt,
    endedAt:    content.endedAt   instanceof Date ? content.endedAt.toISOString()   : content.endedAt,
  };
}
