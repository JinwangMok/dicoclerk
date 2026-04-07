/**
 * Meeting Minutes Formatter
 *
 * Converts raw transcript data (speakers, timestamps, utterances) into
 * structured meeting minutes as a Markdown document. Sections:
 *   1. Header (title, date/time, duration, channel)
 *   2. Attendees
 *   3. Summary
 *   4. Key Discussion Points
 *   5. Action Items
 *   6. Full Transcript
 *
 * The formatter works entirely offline — no LLM calls. Summary, key points,
 * and action items are extracted heuristically from transcript content.
 */

/**
 * @typedef {Object} TranscriptEntry
 * @property {string} text          - Transcribed utterance
 * @property {number|string} speaker - Speaker identifier (Deepgram speaker ID or Discord user tag)
 * @property {number} start         - Start time in seconds from session start
 * @property {number} end           - End time in seconds from session start
 * @property {number} confidence    - Confidence score 0-1
 * @property {boolean} isFinal      - Whether the transcript was a final result
 */

/**
 * @typedef {Object} SessionMetadata
 * @property {string} guildName           - Discord server name
 * @property {string} channelName         - Voice channel name
 * @property {Date} startedAt             - Session start time
 * @property {number} durationSeconds     - Total session duration in seconds
 * @property {string} startedBy           - User who started the session
 * @property {string} language            - Primary language code (e.g. 'ko', 'en')
 * @property {Map<number|string, string>} speakerMap - Maps speaker IDs to display names
 */

/**
 * @typedef {Object} MinutesOptions
 * @property {boolean} [includeTranscript=true]     - Include full transcript section
 * @property {boolean} [includeTimestamps=true]      - Show timestamps in transcript
 * @property {boolean} [includeConfidence=false]      - Show confidence scores
 * @property {number}  [maxSummaryPoints=5]           - Max auto-generated summary bullets
 * @property {number}  [maxActionItems=10]            - Max auto-extracted action items
 * @property {string}  [title]                         - Custom meeting title
 */

/** Default formatting options */
const DEFAULT_OPTIONS = {
  includeTranscript: true,
  includeTimestamps: true,
  includeConfidence: false,
  maxSummaryPoints: 5,
  maxActionItems: 10,
  title: null,
};

// --- Action-item detection patterns ---

/** Korean action-item signal patterns */
const ACTION_PATTERNS_KO = [
  /(.+(?:해\s*주세요|해\s*줘|하세요|합시다|해야\s*합니다|해야\s*돼|해야\s*해|할\s*게|하겠습니다|할게요))/u,
  /(.+(?:부탁합니다|부탁해요|부탁드립니다))/u,
  /(.+(?:확인\s*(?:해|하|바랍니다|부탁)))/u,
  /(.+(?:준비\s*(?:해|하|바랍니다|부탁)))/u,
  /(.+(?:까지|마감|데드라인|deadline))/iu,
];

/** English action-item signal patterns */
const ACTION_PATTERNS_EN = [
  /(?:please|pls)\s+(.+)/i,
  /(?:we need to|we should|we must|let's|let us)\s+(.+)/i,
  /(?:action item|todo|to-do|task)[:\s]+(.+)/i,
  /(?:i will|i'll|i'm going to)\s+(.+)/i,
  /(?:can you|could you|would you)\s+(.+)/i,
  /(?:make sure|ensure|don't forget)\s+(.+)/i,
  /(?:by|before|deadline|due)\s+(?:end of|next|this|tomorrow|monday|tuesday|wednesday|thursday|friday).*/i,
  /(?:assign|assigned to|responsible)\s+(.+)/i,
];

// --- Deadline detection patterns ---

/** Korean deadline patterns — capture the deadline phrase */
const DEADLINE_PATTERNS_KO = [
  /(?:(\d{1,2}월\s*\d{1,2}일)\s*까지)/u,
  /(내일|모레|오늘|이번\s*주|다음\s*주|다다음\s*주|이번\s*달|다음\s*달)\s*까지/u,
  /(월요일|화요일|수요일|목요일|금요일|토요일|일요일)\s*까지/u,
  /(\d{1,2}시)\s*까지/u,
  /(마감|데드라인)[:\s]*(.+?)(?:입니다|이에요|까지|$)/u,
  /(이번\s*주\s*(?:내|안)(?:에|으로)?)/u,
  /(다음\s*주\s*(?:내|안|초|중|말)?(?:에|으로)?)/u,
];

/** English deadline patterns — capture the deadline phrase */
const DEADLINE_PATTERNS_EN = [
  /(?:by|before|until|due(?:\s+by)?)\s+((?:end of\s+)?(?:today|tomorrow|tonight|(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:next|this)\s+week|(?:next|this)\s+month|eod|eow|end of (?:day|week|month|year)))/i,
  /(?:by|before|until|due(?:\s+by)?)\s+((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s*,?\s*\d{4})?)/i,
  /(?:by|before|until|due(?:\s+by)?)\s+(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i,
  /(?:deadline|due\s*date)[:\s]+(.+?)(?:\.|,|$)/i,
  /((?:within|in)\s+\d+\s+(?:days?|weeks?|hours?|business\s+days?))/i,
];

// --- Assignee detection patterns ---

/** Korean assignee patterns — capture the person name */
const ASSIGNEE_PATTERNS_KO = [
  /(.+?)\s*(?:씨|님|선생님|과장|대리|부장|팀장|사원)(?:이|가|께서)?\s*(?:해|하|맡|담당|진행|처리|확인|준비)/u,
  /(.+?)(?:에게|한테)\s*(?:맡기|부탁|할당|배정)/u,
  /(.+?)(?:이|가)\s*(?:담당|책임|맡|진행)/u,
  /(?:담당자|책임자)[:\s]*(.+?)(?:입니다|이에요|$)/u,
];

/** English assignee patterns — capture the person name/reference */
const ASSIGNEE_PATTERNS_EN = [
  /(?:assign(?:ed)?\s+(?:to|for))\s+(\w+(?:\s+\w+)?)/i,
  /(\w+(?:\s+\w+)?)\s+(?:will|should|needs? to|is going to|is responsible|owns?|handles?)\s+/i,
  /(?:responsible|owner|lead)[:\s]+(\w+(?:\s+\w+)?)/i,
  /(?:@(\w+))/i,
];

// --- Decision detection patterns ---

/** Korean decision signal patterns */
const DECISION_PATTERNS_KO = [
  /(.+(?:(?:으로|로)\s*(?:결정|확정)(?:합니다|했습니다|하겠습니다|됐습니다|되었습니다|했어요|할게요)))/u,
  /(.+(?:(?:하기로|하는\s*것으로)\s*(?:했습니다|합의|결정|합니다|하겠습니다)))/u,
  /(.+(?:합의(?:했습니다|합니다|되었습니다|됐습니다)))/u,
  /(?:결론(?:은|이|적으로)?)\s*(.+)/u,
  /(?:결정\s*사항|결정된\s*내용)[:\s]*(.+)/u,
  /(.+(?:으로|로)\s*(?:가겠습니다|가죠|갑시다|진행합니다|진행하겠습니다))/u,
  /(.+(?:채택|선택|선정)(?:합니다|했습니다|하겠습니다|되었습니다))/u,
  /(?:그러면|그럼)\s+(.+(?:으로|로)\s*(?:하죠|합시다|하겠습니다|할게요))/u,
];

/** English decision signal patterns */
const DECISION_PATTERNS_EN = [
  /(?:we(?:'ve)?\s+)?(?:decided|agreed|resolved)\s+(?:to\s+|that\s+)?(.+)/i,
  /(?:the\s+)?decision\s+(?:is|was)\s+(?:to\s+)?(.+)/i,
  /(?:let's\s+)?go\s+(?:with|ahead\s+with|for)\s+(.+)/i,
  /(?:we(?:'ll|\s+will))\s+(?:go\s+with|proceed\s+with|use|adopt|choose|pick)\s+(.+)/i,
  /(?:it(?:'s|\s+is|'s\s+been)?\s+)?(?:settled|confirmed|finalized)[:\s]+(.+)/i,
  /(?:consensus|agreement)\s+(?:is|was)\s+(?:to\s+|that\s+)?(.+)/i,
  /(?:final\s+)?(?:decision|verdict|conclusion)[:\s]+(.+)/i,
  /(?:approved|ratified|endorsed)\s+(.+)/i,
  /(?:we're\s+going\s+(?:to|with))\s+(.+)/i,
];

// --- Topic / key-point signal patterns ---

const TOPIC_PATTERNS_KO = [
  /(.+에\s*대해(?:서)?)/u,
  /(.+관련(?:해서|하여)?)/u,
  /(.+이슈|.+문제|.+건)/u,
  /(.+안건|.+주제|.+의제)/u,
];

const TOPIC_PATTERNS_EN = [
  /(?:regarding|about|concerning)\s+(.+)/i,
  /(?:the issue|the problem|the topic|the question)\s+(?:of|is|about)\s+(.+)/i,
  /(?:let's talk about|let's discuss|moving on to)\s+(.+)/i,
  /(?:next item|next topic|next agenda)\s*[:\s]+(.+)/i,
];


/**
 * Format seconds into HH:MM:SS or MM:SS string.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  if (h > 0) {
    return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Format seconds into [MM:SS] timestamp label.
 * @param {number} seconds
 * @returns {string}
 */
function formatTimestamp(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}

/**
 * Resolve a speaker identifier to a display name.
 * @param {number|string} speakerId
 * @param {Map<number|string, string>} [speakerMap]
 * @returns {string}
 */
function resolveSpeakerName(speakerId, speakerMap) {
  if (speakerMap && speakerMap.has(speakerId)) {
    return speakerMap.get(speakerId);
  }
  if (speakerId === -1 || speakerId === undefined || speakerId === null) {
    return 'Unknown';
  }
  return `Speaker ${speakerId}`;
}

/**
 * Extract attendee list from transcript entries.
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number|string, string>} [speakerMap]
 * @returns {{ id: number|string, name: string, utteranceCount: number, speakingTime: number }[]}
 */
function extractAttendees(transcript, speakerMap) {
  /** @type {Map<number|string, { count: number, time: number }>} */
  const stats = new Map();

  for (const entry of transcript) {
    const id = entry.speaker;
    if (!stats.has(id)) {
      stats.set(id, { count: 0, time: 0 });
    }
    const s = stats.get(id);
    s.count++;
    s.time += (entry.end - entry.start);
  }

  return Array.from(stats.entries())
    .map(([id, { count, time }]) => ({
      id,
      name: resolveSpeakerName(id, speakerMap),
      utteranceCount: count,
      speakingTime: Math.round(time * 10) / 10,
    }))
    .sort((a, b) => b.utteranceCount - a.utteranceCount);
}

/**
 * Extract a deadline phrase from an utterance text.
 * Returns the matched deadline string, or null if none found.
 *
 * @param {string} text - The utterance text to scan
 * @param {string} [language='ko'] - Language code
 * @returns {string|null} - Extracted deadline phrase
 */
function extractDeadline(text, language = 'ko') {
  const patterns = language === 'en'
    ? DEADLINE_PATTERNS_EN
    : [...DEADLINE_PATTERNS_KO, ...DEADLINE_PATTERNS_EN];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Return the first captured group, or the full match minus the keyword prefix
      const captured = match[2] || match[1];
      if (captured) return captured.trim();
    }
  }
  return null;
}

/**
 * Extract an assignee from an utterance text and surrounding context.
 *
 * Resolution strategy (in priority order):
 * 1. Explicit assignee pattern match in the text (e.g., "assigned to Alice")
 * 2. Self-assignment patterns (e.g., "I will", "제가 하겠습니다") → returns speaker name
 * 3. Next-speaker heuristic: if the response is an acknowledgement, the responder is the assignee
 * 4. Falls back to null (unassigned)
 *
 * @param {string} text - The utterance text
 * @param {string} speakerName - Name of the person who spoke this utterance
 * @param {string} [language='ko'] - Language code
 * @param {TranscriptEntry[]} [transcript] - Full transcript for context lookups
 * @param {number} [entryIndex] - Index of this entry in the transcript
 * @param {Map<number|string, string>} [speakerMap] - Speaker ID to name map
 * @returns {string|null} - Extracted assignee name, or null
 */
function extractAssignee(text, speakerName, language = 'ko', transcript = [], entryIndex = -1, speakerMap) {
  // 1. Self-assignment detection first (highest priority)
  // "I will...", "I'll...", "제가...", "할게요", "하겠습니다"
  const selfAssignKo = /(?:제가|내가)\s*.+(?:하겠습니다|할게요|할게|해볼게|맡겠습니다|맡을게요|처리하겠습니다|진행하겠습니다)/u;
  const selfAssignEn = /(?:^|\s)i(?:'ll|\s+will|\s+am\s+going\s+to|\s+can|\s+shall)\s+/i;

  if (selfAssignKo.test(text) || selfAssignEn.test(text)) {
    return speakerName;
  }

  // 2. Check for explicit assignee patterns in the text
  const patterns = language === 'en'
    ? ASSIGNEE_PATTERNS_EN
    : [...ASSIGNEE_PATTERNS_KO, ...ASSIGNEE_PATTERNS_EN];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      const candidate = (match[1] || '').trim();
      // Validate: must be a real name (2+ chars, not a common verb/pronoun)
      if (candidate.length >= 2 && !isCommonWord(candidate, language)) {
        // Check if the candidate matches a known speaker name
        if (speakerMap) {
          for (const name of speakerMap.values()) {
            if (name.toLowerCase() === candidate.toLowerCase() ||
                candidate.toLowerCase().includes(name.toLowerCase())) {
              return name;
            }
          }
        }
        return candidate;
      }
    }
  }

  // 3. Next-speaker acknowledgement heuristic
  // If the next utterance from a different speaker is a short acknowledgement,
  // that speaker is likely accepting the action item
  if (transcript.length > 0 && entryIndex >= 0 && entryIndex < transcript.length - 1) {
    const nextEntry = transcript[entryIndex + 1];
    if (nextEntry && nextEntry.isFinal && nextEntry.speaker !== transcript[entryIndex].speaker) {
      const ackText = nextEntry.text.trim().toLowerCase();
      const ackPatternsKo = ['네', '알겠습니다', '네 알겠습니다', '넵', '확인했습니다', '알겠어요', '그렇게 하겠습니다', '좋습니다'];
      const ackPatternsEn = ['ok', 'okay', 'sure', 'got it', 'will do', 'on it', 'understood', 'sounds good', 'i\'ll do it', 'yes', 'alright'];
      const ackPatterns = language === 'en' ? ackPatternsEn : [...ackPatternsKo, ...ackPatternsEn];

      if (ackPatterns.some(ack => ackText === ack || ackText.startsWith(ack + ' ') || ackText.startsWith(ack + '.'))) {
        return resolveSpeakerName(nextEntry.speaker, speakerMap);
      }
    }
  }

  return null;
}

/**
 * Check if a word is a common word (not a person's name).
 * @param {string} word
 * @param {string} language
 * @returns {boolean}
 */
function isCommonWord(word, language) {
  const commonEn = new Set([
    'i', 'me', 'we', 'us', 'you', 'he', 'she', 'they', 'it', 'the', 'this', 'that',
    'will', 'should', 'needs', 'need', 'must', 'can', 'could', 'would', 'shall',
    'someone', 'everyone', 'anybody', 'nobody', 'team', 'all',
  ]);
  const commonKo = new Set([
    '누구', '누가', '모두', '전부', '다들', '여러분', '우리', '저희',
  ]);
  const w = word.toLowerCase();
  return commonEn.has(w) || commonKo.has(w);
}

/**
 * Heuristically extract action items from transcript entries.
 *
 * Each action item includes:
 * - text: The action item utterance
 * - speaker: Who said it
 * - assignee: Who is responsible (extracted or inferred), or null
 * - deadline: Deadline phrase if mentioned, or null
 * - timestamp: Start time in seconds
 *
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number|string, string>} [speakerMap]
 * @param {string} [language='ko']
 * @param {number} [maxItems=10]
 * @returns {{ text: string, speaker: string, assignee: string|null, deadline: string|null, timestamp: number }[]}
 */
function extractActionItems(transcript, speakerMap, language = 'ko', maxItems = 10) {
  const patterns = language === 'en' ? ACTION_PATTERNS_EN
    : [...ACTION_PATTERNS_KO, ...ACTION_PATTERNS_EN]; // Korean mode also checks English

  /** @type {{ text: string, speaker: string, assignee: string|null, deadline: string|null, timestamp: number }[]} */
  const items = [];
  const seen = new Set();

  for (let i = 0; i < transcript.length; i++) {
    const entry = transcript[i];
    if (!entry.isFinal) continue;

    for (const pattern of patterns) {
      const match = entry.text.match(pattern);
      if (match) {
        const actionText = entry.text.trim();
        // Deduplicate by normalized lowercase
        const key = actionText.toLowerCase().replace(/\s+/g, ' ');
        if (!seen.has(key)) {
          seen.add(key);
          const speakerName = resolveSpeakerName(entry.speaker, speakerMap);
          items.push({
            text: actionText,
            speaker: speakerName,
            assignee: extractAssignee(actionText, speakerName, language, transcript, i, speakerMap),
            deadline: extractDeadline(actionText, language),
            timestamp: entry.start,
          });
        }
        break; // Only match first pattern per entry
      }
    }

    if (items.length >= maxItems) break;
  }

  return items;
}

/**
 * Heuristically extract key decisions from transcript entries.
 *
 * Scans each utterance for decision-signal language (Korean and English)
 * and returns a deduplicated list of decisions with attribution.
 *
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number|string, string>} [speakerMap]
 * @param {string} [language='ko']
 * @param {number} [maxItems=10]
 * @returns {{ text: string, speaker: string, timestamp: number }[]}
 */
function extractDecisions(transcript, speakerMap, language = 'ko', maxItems = 10) {
  const patterns = language === 'en' ? DECISION_PATTERNS_EN
    : [...DECISION_PATTERNS_KO, ...DECISION_PATTERNS_EN]; // Korean mode also checks English

  /** @type {{ text: string, speaker: string, timestamp: number }[]} */
  const items = [];
  const seen = new Set();

  for (const entry of transcript) {
    if (!entry.isFinal) continue;

    // Skip very short utterances (< 5 chars) — unlikely to be a real decision
    const trimmed = entry.text.trim();
    if (trimmed.length < 5) continue;

    for (const pattern of patterns) {
      const match = trimmed.match(pattern);
      if (match) {
        const decisionText = trimmed;
        // Deduplicate by normalized lowercase
        const key = decisionText.toLowerCase().replace(/\s+/g, ' ');
        if (!seen.has(key)) {
          seen.add(key);
          items.push({
            text: decisionText,
            speaker: resolveSpeakerName(entry.speaker, speakerMap),
            timestamp: entry.start,
          });
        }
        break; // Only match first pattern per entry
      }
    }

    if (items.length >= maxItems) break;
  }

  return items;
}

/**
 * Heuristically extract key discussion points / topics from transcript.
 * Groups consecutive utterances into discussion blocks and identifies topic shifts.
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number|string, string>} [speakerMap]
 * @param {string} [language='ko']
 * @param {number} [maxPoints=5]
 * @returns {{ topic: string, speakers: string[], startTime: number, summary: string }[]}
 */
function extractKeyPoints(transcript, speakerMap, language = 'ko', maxPoints = 5) {
  if (transcript.length === 0) return [];

  const patterns = language === 'en' ? TOPIC_PATTERNS_EN
    : [...TOPIC_PATTERNS_KO, ...TOPIC_PATTERNS_EN];

  // Strategy: divide transcript into time-based segments and pick representative utterances
  const finalEntries = transcript.filter(e => e.isFinal);
  if (finalEntries.length === 0) return [];

  const totalDuration = finalEntries[finalEntries.length - 1].end - finalEntries[0].start;
  const segmentDuration = Math.max(totalDuration / maxPoints, 30); // min 30s segments

  /** @type {{ topic: string, speakers: string[], startTime: number, summary: string }[]} */
  const points = [];
  let segStart = finalEntries[0].start;

  while (segStart < finalEntries[finalEntries.length - 1].end && points.length < maxPoints) {
    const segEnd = segStart + segmentDuration;
    const segEntries = finalEntries.filter(e => e.start >= segStart && e.start < segEnd);

    if (segEntries.length > 0) {
      // Find topic-signaling utterances or use the longest utterance as representative
      let topicEntry = null;
      for (const entry of segEntries) {
        for (const pattern of patterns) {
          if (pattern.test(entry.text)) {
            topicEntry = entry;
            break;
          }
        }
        if (topicEntry) break;
      }

      // Fallback: longest utterance in the segment
      if (!topicEntry) {
        topicEntry = segEntries.reduce((a, b) => a.text.length > b.text.length ? a : b);
      }

      // Collect unique speakers in segment
      const speakers = [...new Set(segEntries.map(e => resolveSpeakerName(e.speaker, speakerMap)))];

      // Build a brief summary: first 100 chars of the representative utterance
      const topic = topicEntry.text.length > 80
        ? topicEntry.text.slice(0, 77) + '...'
        : topicEntry.text;

      // Combine top utterances for a summary snippet
      const summaryTexts = segEntries
        .slice(0, 3)
        .map(e => e.text)
        .join(' ');
      const summary = summaryTexts.length > 200
        ? summaryTexts.slice(0, 197) + '...'
        : summaryTexts;

      points.push({
        topic,
        speakers,
        startTime: segEntries[0].start,
        summary,
      });
    }

    segStart = segEnd;
  }

  return points;
}

/**
 * Extract the most frequently mentioned significant words/phrases from transcript.
 * Filters out common stop words and returns top N terms by frequency.
 * @param {TranscriptEntry[]} transcript
 * @param {string} [language='ko']
 * @param {number} [topN=5]
 * @returns {string[]}
 */
function extractTopTopics(transcript, language = 'ko', topN = 5) {
  const finalEntries = transcript.filter(e => e.isFinal);
  if (finalEntries.length === 0) return [];

  // Common stop words to filter out
  const STOP_WORDS_KO = new Set([
    '그', '이', '저', '것', '수', '등', '네', '예', '아', '음', '좀',
    '거', '때', '더', '또', '안', '잘', '제', '다', '대', '중', '후',
    '그래서', '그러면', '그리고', '하지만', '그런데', '그래', '근데',
    '어떻게', '무엇', '어디', '언제', '왜', '어떤', '합니다', '있습니다',
    '됩니다', '입니다', '습니다', '니다', '해요', '하는', '있는', '되는',
    '알겠습니다', '감사합니다', '안녕하세요',
  ]);

  const STOP_WORDS_EN = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than', 'too',
    'very', 'just', 'because', 'if', 'when', 'where', 'how', 'what',
    'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'it', 'its',
    'i', 'me', 'my', 'we', 'us', 'our', 'you', 'your', 'he', 'she',
    'they', 'them', 'their', 'him', 'her', 'ok', 'okay', 'yeah', 'yes',
    'no', 'like', 'think', 'know', 'right', 'well', 'going', 'get', 'got',
    'also', 'about', 'up', 'out', 'then', 'there', 'here', 'now',
  ]);

  const stopWords = language === 'en' ? STOP_WORDS_EN : new Set([...STOP_WORDS_KO, ...STOP_WORDS_EN]);

  // Common Korean particles/suffixes to strip for better word frequency matching.
  // Korean is agglutinative — '문제입니다' and '문제는' should both count as '문제'.
  const KO_SUFFIXES = [
    '입니다', '습니다', '합니다', '됩니다', '겠습니다', '했습니다',
    '에서', '으로', '부터', '까지', '에게', '한테', '처럼', '만큼',
    '이라', '라는', '라서', '이라서', '해서', '인가요', '인데',
    '은', '는', '이', '가', '을', '를', '에', '의', '도', '로',
    '와', '과', '나', '며', '고',
  ];

  /**
   * Strip common Korean particles from a word to get the stem.
   * Tries longest suffix first (KO_SUFFIXES is ordered long→short).
   * Only strips if the remaining stem is >= 2 characters.
   */
  function stripKoParticles(word) {
    if (language === 'en') return word;
    for (const suffix of KO_SUFFIXES) {
      if (word.endsWith(suffix) && word.length - suffix.length >= 2) {
        return word.slice(0, -suffix.length);
      }
    }
    return word;
  }

  /** @type {Map<string, number>} */
  const freq = new Map();

  for (const entry of finalEntries) {
    // Split into words, normalize, strip Korean particles for better frequency matching
    const words = entry.text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, '')
      .split(/\s+/)
      .map(w => stripKoParticles(w))
      .filter(w => w.length >= 2 && !stopWords.has(w));

    for (const word of words) {
      freq.set(word, (freq.get(word) || 0) + 1);
    }

    // Also extract bigrams for better topic detection
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i + 1]}`;
      if (bigram.length >= 5) {
        freq.set(bigram, (freq.get(bigram) || 0) + 1);
      }
    }
  }

  // Adaptive minimum frequency: for short transcripts (< 10 entries) allow freq=1
  const minFreq = finalEntries.length < 10 ? 1 : 2;

  // Filter by min frequency, prefer multi-word terms and longer words, sort by frequency
  return Array.from(freq.entries())
    .filter(([, count]) => count >= minFreq)
    .sort((a, b) => {
      // Primary: frequency descending
      if (b[1] !== a[1]) return b[1] - a[1];
      // Secondary: prefer bigrams (multi-word) over single words
      const aWords = a[0].split(' ').length;
      const bWords = b[0].split(' ').length;
      if (bWords !== aWords) return bWords - aWords;
      // Tertiary: prefer longer terms
      return b[0].length - a[0].length;
    })
    .slice(0, topN)
    .map(([term]) => term);
}

/**
 * Identify the opening, main discussion, and closing phases of the meeting.
 * Returns representative text snippets for each phase.
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number|string, string>} [speakerMap]
 * @returns {{ opening: string|null, closing: string|null }}
 */
function extractMeetingPhases(transcript, speakerMap) {
  const finalEntries = transcript.filter(e => e.isFinal);
  if (finalEntries.length === 0) return { opening: null, closing: null };

  // Opening: first meaningful utterance (>5 chars)
  const openingEntry = finalEntries.find(e => e.text.trim().length > 5);
  const opening = openingEntry
    ? `${resolveSpeakerName(openingEntry.speaker, speakerMap)}: "${truncateText(openingEntry.text, 60)}"`
    : null;

  // Closing: last meaningful utterance (>5 chars)
  const closingEntry = [...finalEntries].reverse().find(e => e.text.trim().length > 5);
  const closing = (closingEntry && closingEntry !== openingEntry)
    ? `${resolveSpeakerName(closingEntry.speaker, speakerMap)}: "${truncateText(closingEntry.text, 60)}"`
    : null;

  return { opening, closing };
}

/**
 * Truncate text to maxLen, appending '...' if truncated.
 * @param {string} text
 * @param {number} maxLen
 * @returns {string}
 */
function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

/**
 * Compute per-speaker contribution percentages.
 * @param {{ name: string, utteranceCount: number }[]} attendees
 * @returns {{ name: string, percentage: number }[]}
 */
function computeSpeakerContributions(attendees) {
  const total = attendees.reduce((sum, a) => sum + a.utteranceCount, 0);
  if (total === 0) return [];
  return attendees.map(a => ({
    name: a.name,
    percentage: Math.round((a.utteranceCount / total) * 100),
  }));
}

/**
 * Generate a concise meeting summary from transcript content.
 *
 * Produces a multi-line summary containing:
 * - Basic stats (duration, participants, utterance count)
 * - Top discussed topics (heuristic keyword extraction)
 * - Speaker contribution breakdown
 * - Opening and closing context
 *
 * Works entirely offline with no LLM dependency.
 *
 * @param {TranscriptEntry[]} transcript
 * @param {{ id: number|string, name: string, utteranceCount: number }[]} attendees
 * @param {number} durationSeconds
 * @param {string} [language='ko']
 * @param {Map<number|string, string>} [speakerMap]
 * @returns {string}
 */
function generateSummary(transcript, attendees, durationSeconds, language = 'ko', speakerMap) {
  const finalCount = transcript.filter(e => e.isFinal).length;
  const participantNames = attendees.map(a => a.name).join(', ');
  const duration = formatDuration(durationSeconds);
  const lines = [];

  // --- 1. Basic statistics ---
  if (language === 'en') {
    lines.push(
      `Meeting lasted **${duration}** with **${attendees.length}** participant(s): ${participantNames}. ` +
      `A total of **${finalCount}** utterances were recorded.`
    );
  } else {
    lines.push(
      `회의 시간: **${duration}**, 참석자 **${attendees.length}**명: ${participantNames}. ` +
      `총 **${finalCount}**건의 발화가 기록되었습니다.`
    );
  }

  // For very short transcripts, return stats only
  if (finalCount < 3) return lines.join('\n');

  lines.push('');

  // --- 2. Top topics ---
  const topics = extractTopTopics(transcript, language, 5);
  if (topics.length > 0) {
    const topicLabel = language === 'en' ? 'Main topics' : '주요 주제';
    lines.push(`**${topicLabel}:** ${topics.map(t => `\`${t}\``).join(', ')}`);
  }

  // --- 3. Speaker contributions ---
  const contributions = computeSpeakerContributions(attendees);
  if (contributions.length > 1) {
    const contribLabel = language === 'en' ? 'Participation' : '참여도';
    const contribParts = contributions.map(c => `${c.name} ${c.percentage}%`);
    lines.push(`**${contribLabel}:** ${contribParts.join(' · ')}`);
  }

  // --- 4. Meeting opening and closing context ---
  const phases = extractMeetingPhases(transcript, speakerMap);
  if (phases.opening) {
    const openLabel = language === 'en' ? 'Opening' : '시작';
    lines.push(`**${openLabel}:** ${phases.opening}`);
  }
  if (phases.closing) {
    const closeLabel = language === 'en' ? 'Closing' : '마무리';
    lines.push(`**${closeLabel}:** ${phases.closing}`);
  }

  return lines.join('\n');
}

/**
 * Format the full transcript section.
 * @param {TranscriptEntry[]} transcript
 * @param {Map<number|string, string>} [speakerMap]
 * @param {MinutesOptions} options
 * @returns {string}
 */
function formatTranscript(transcript, speakerMap, options) {
  const finalEntries = transcript.filter(e => e.isFinal);
  if (finalEntries.length === 0) return '_No transcript entries recorded._';

  const lines = [];
  let prevSpeaker = null;

  for (const entry of finalEntries) {
    const name = resolveSpeakerName(entry.speaker, speakerMap);
    const ts = options.includeTimestamps ? `${formatTimestamp(entry.start)} ` : '';
    const conf = options.includeConfidence ? ` _(${(entry.confidence * 100).toFixed(0)}%)_` : '';

    // Group consecutive utterances by same speaker
    if (entry.speaker !== prevSpeaker) {
      if (lines.length > 0) lines.push(''); // blank line between speaker blocks
      lines.push(`**${name}** ${ts}${conf}`);
      lines.push(`> ${entry.text}`);
    } else {
      lines.push(`> ${ts}${entry.text}${conf}`);
    }

    prevSpeaker = entry.speaker;
  }

  return lines.join('\n');
}


/**
 * Generate structured meeting minutes as a Markdown string.
 *
 * @param {TranscriptEntry[]} transcript  - Array of transcript entries
 * @param {SessionMetadata} metadata       - Session metadata
 * @param {Partial<MinutesOptions>} [opts] - Formatting options
 * @returns {string} - Complete Markdown meeting minutes
 */
export function formatMeetingMinutes(transcript, metadata, opts = {}, aiContent = null) {
  const options = { ...DEFAULT_OPTIONS, ...opts };

  const {
    guildName = 'Unknown Server',
    channelName = 'Unknown Channel',
    startedAt = new Date(),
    durationSeconds = 0,
    startedBy = 'Unknown',
    language = 'ko',
    speakerMap = new Map(),
  } = metadata;

  // --- Extract structured data (heuristic) ---
  const attendees = extractAttendees(transcript, speakerMap);
  const actionItems = extractActionItems(transcript, speakerMap, language, options.maxActionItems);
  const decisions = extractDecisions(transcript, speakerMap, language, options.maxActionItems);
  const keyPoints = extractKeyPoints(transcript, speakerMap, language, options.maxSummaryPoints);
  const summary = generateSummary(transcript, attendees, durationSeconds, language, speakerMap);

  // --- Apply AI-generated overrides when available ---
  // aiContent is produced by llm-processor.js; null fields fall back to heuristic output.
  const finalSummary     = aiContent?.summary     ?? summary;
  const aiDecisions      = aiContent?.decisions   ?? null;   // null → use heuristic
  const aiActionItems    = aiContent?.actionItems ?? null;   // null → use heuristic

  // --- Build Markdown ---
  const title = options.title || (language === 'en' ? 'Meeting Minutes' : '회의록');
  const dateStr = startedAt.toISOString().split('T')[0];
  const timeStr = startedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const sections = [];

  // === Header ===
  sections.push(`# ${title}`);
  sections.push('');
  sections.push(`| | |`);
  sections.push(`|---|---|`);
  sections.push(`| **${language === 'en' ? 'Date' : '날짜'}** | ${dateStr} |`);
  sections.push(`| **${language === 'en' ? 'Time' : '시간'}** | ${timeStr} |`);
  sections.push(`| **${language === 'en' ? 'Duration' : '소요시간'}** | ${formatDuration(durationSeconds)} |`);
  sections.push(`| **${language === 'en' ? 'Server' : '서버'}** | ${guildName} |`);
  sections.push(`| **${language === 'en' ? 'Channel' : '채널'}** | ${channelName} |`);
  sections.push(`| **${language === 'en' ? 'Started by' : '시작'}** | ${startedBy} |`);
  sections.push('');

  // === Attendees / Participants ===
  const attendeesHeader = language === 'en' ? 'Attendees' : '참석자';
  sections.push(`## ${attendeesHeader}`);
  sections.push('');
  if (attendees.length === 0) {
    sections.push(language === 'en' ? '_No participants detected._' : '_참석자가 감지되지 않았습니다._');
  } else {
    sections.push(`| ${language === 'en' ? 'Name' : '이름'} | ${language === 'en' ? 'Utterances' : '발화 수'} | ${language === 'en' ? 'Speaking Time' : '발화 시간'} |`);
    sections.push('|---|---|---|');
    for (const a of attendees) {
      sections.push(`| ${a.name} | ${a.utteranceCount} | ${formatDuration(a.speakingTime)} |`);
    }
  }
  sections.push('');

  // === Full Transcript ===
  // Template order: date/participants → full transcript → summary → decisions → action items
  if (options.includeTranscript) {
    const transcriptHeader = language === 'en' ? 'Full Transcript' : '전체 녹취록';
    sections.push(`## ${transcriptHeader}`);
    sections.push('');
    sections.push('<details>');
    sections.push(`<summary>${language === 'en' ? 'Click to expand' : '펼치기'}</summary>`);
    sections.push('');
    sections.push(formatTranscript(transcript, speakerMap, options));
    sections.push('');
    sections.push('</details>');
    sections.push('');
  }

  // === Summary ===
  const summaryHeader = language === 'en' ? 'Summary' : '요약';
  sections.push(`## ${summaryHeader}`);
  sections.push('');
  if (aiContent?.summary) {
    sections.push('> 🤖 _AI-generated summary_');
    sections.push('');
  }
  sections.push(finalSummary);
  sections.push('');

  // === Key Discussion Points ===
  const keyPointsHeader = language === 'en' ? 'Key Discussion Points' : '주요 논의 사항';
  sections.push(`## ${keyPointsHeader}`);
  sections.push('');
  if (keyPoints.length === 0) {
    sections.push(language === 'en' ? '_No key discussion points identified._' : '_주요 논의 사항이 식별되지 않았습니다._');
  } else {
    for (let i = 0; i < keyPoints.length; i++) {
      const kp = keyPoints[i];
      const ts = formatTimestamp(kp.startTime);
      sections.push(`### ${i + 1}. ${kp.topic}`);
      sections.push('');
      sections.push(`- ${language === 'en' ? 'Time' : '시간'}: ${ts}`);
      sections.push(`- ${language === 'en' ? 'Speakers' : '발화자'}: ${kp.speakers.join(', ')}`);
      sections.push(`- ${kp.summary}`);
      sections.push('');
    }
  }

  // === Decisions ===
  const decisionsHeader = language === 'en' ? 'Decisions' : '결정 사항';
  sections.push(`## ${decisionsHeader}`);
  sections.push('');
  if (aiDecisions !== null) {
    // AI-generated decisions (plain strings, no timestamps)
    if (aiDecisions.length === 0) {
      sections.push(language === 'en' ? '_No decisions identified._' : '_결정 사항이 식별되지 않았습니다._');
    } else {
      for (const decision of aiDecisions) {
        sections.push(`- ✅ ${decision}`);
      }
    }
  } else {
    // Heuristic decisions (include speaker attribution and timestamp)
    if (decisions.length === 0) {
      sections.push(language === 'en' ? '_No decisions identified._' : '_결정 사항이 식별되지 않았습니다._');
    } else {
      for (const decision of decisions) {
        const ts = formatTimestamp(decision.timestamp);
        sections.push(`- ✅ ${decision.text} — _${decision.speaker}_ ${ts}`);
      }
    }
  }
  sections.push('');

  // === Action Items ===
  const actionHeader = language === 'en' ? 'Action Items' : '액션 아이템';
  sections.push(`## ${actionHeader}`);
  sections.push('');
  const assigneeLabel = language === 'en' ? 'Assignee' : '담당';
  const deadlineLabel = language === 'en' ? 'Deadline' : '기한';
  if (aiActionItems !== null) {
    // AI-generated action items (task / assignee / deadline, no timestamps)
    if (aiActionItems.length === 0) {
      sections.push(language === 'en' ? '_No action items identified._' : '_액션 아이템이 식별되지 않았습니다._');
    } else {
      for (const item of aiActionItems) {
        let line = `- [ ] ${item.task}`;
        const meta = [];
        if (item.assignee) meta.push(`**${assigneeLabel}:** ${item.assignee}`);
        if (item.deadline) meta.push(`**${deadlineLabel}:** ${item.deadline}`);
        if (meta.length > 0) {
          line += `\n  - ${meta.join(' | ')}`;
        }
        sections.push(line);
      }
    }
  } else {
    // Heuristic action items (include speaker attribution and timestamp)
    if (actionItems.length === 0) {
      sections.push(language === 'en' ? '_No action items identified._' : '_액션 아이템이 식별되지 않았습니다._');
    } else {
      for (const item of actionItems) {
        const ts = formatTimestamp(item.timestamp);

        let line = `- [ ] ${item.text} — _${item.speaker}_ ${ts}`;
        const meta = [];
        if (item.assignee) meta.push(`**${assigneeLabel}:** ${item.assignee}`);
        if (item.deadline) meta.push(`**${deadlineLabel}:** ${item.deadline}`);
        if (meta.length > 0) {
          line += `\n  - ${meta.join(' | ')}`;
        }
        sections.push(line);
      }
    }
  }
  sections.push('');

  // === Footer ===
  sections.push('---');
  sections.push(`_Generated by dicoclerk at ${new Date().toISOString()}_`);
  sections.push('');

  return sections.join('\n');
}

/**
 * Generate a filename for the meeting minutes.
 * @param {SessionMetadata} metadata
 * @returns {string}
 */
export function generateMinutesFilename(metadata) {
  const date = (metadata.startedAt ?? new Date()).toISOString().split('T')[0];
  const time = (metadata.startedAt ?? new Date())
    .toTimeString()
    .split(' ')[0]
    .replace(/:/g, '');
  const channel = (metadata.channelName ?? 'meeting')
    .replace(/[^a-zA-Z0-9가-힣_-]/g, '_')
    .slice(0, 30);
  return `minutes_${date}_${time}_${channel}.md`;
}

/**
 * Render meeting minutes directly from a structured SessionMinutesData object.
 *
 * This is the primary entry point when the caller has the aggregated session
 * data object (produced by aggregator.js). It extracts the transcript and
 * builds the SessionMetadata shape internally, then delegates to
 * formatMeetingMinutes for template rendering.
 *
 * Required SessionMinutesData fields:
 *   - transcript        {TranscriptEntry[]}        Full chronological transcript
 *   - guildName         {string}                   Discord server name
 *   - channelName       {string}                   Voice channel name
 *   - startedAt         {Date}                     Session start timestamp
 *   - durationSeconds   {number}                   Total session duration
 *   - startedBy         {string}                   User who started the session
 *   - language          {string}                   Language code ('ko' | 'en')
 *   - speakerMap        {Map<number, string>}       Speaker label → display name
 *
 * @param {import('../minutes/aggregator.js').SessionMinutesData} sessionData
 * @param {Partial<MinutesOptions>} [opts] - Optional formatting overrides
 * @returns {string} Rendered Markdown meeting minutes
 */
export function renderMinutesFromSession(sessionData, opts = {}) {
  if (!sessionData || typeof sessionData !== 'object') {
    throw new TypeError('[Formatter] renderMinutesFromSession: sessionData must be a non-null object');
  }

  const {
    transcript = [],
    guildName = 'Unknown Server',
    channelName = 'Unknown Channel',
    startedAt = new Date(),
    durationSeconds = 0,
    startedBy = 'Unknown',
    language = 'ko',
    speakerMap = new Map(),
  } = sessionData;

  /** @type {SessionMetadata} */
  const metadata = {
    guildName,
    channelName,
    startedAt: startedAt instanceof Date ? startedAt : new Date(startedAt),
    durationSeconds,
    startedBy,
    language,
    speakerMap: speakerMap instanceof Map
      ? speakerMap
      : new Map(
          Object.entries(speakerMap).map(([k, v]) => {
            const num = Number(k);
            return [isNaN(num) ? k : num, v];
          })
        ),
  };

  return formatMeetingMinutes(transcript, metadata, opts);
}

export {
  DEFAULT_OPTIONS,
  formatDuration,
  formatTimestamp,
  resolveSpeakerName,
  extractAttendees,
  extractActionItems,
  extractDeadline,
  extractAssignee,
  isCommonWord,
  extractDecisions,
  extractKeyPoints,
  generateSummary,
  extractTopTopics,
  extractMeetingPhases,
  computeSpeakerContributions,
  truncateText,
  formatTranscript,
};
