/**
 * Meeting Minutes Summarizer
 *
 * Extracts and condenses meeting minutes content into structured
 * contextual summaries optimized for agent consumption.
 *
 * Produces a compact summary from one or more meeting minutes that includes:
 *   - Meeting metadata (date, channel, participants, duration)
 *   - Key discussion topics
 *   - Action items with owners and deadlines
 *   - Decisions made
 *   - A brief narrative summary
 *
 * Works entirely offline (no LLM calls) by parsing the structured
 * markdown format produced by the formatter.
 */

/**
 * @typedef {Object} MinutesSummary
 * @property {string} sessionId          - Session identifier
 * @property {string} date               - Meeting date (YYYY-MM-DD)
 * @property {string} time               - Meeting time (HH:MM)
 * @property {number} durationSeconds    - Duration in seconds
 * @property {string} channelName        - Voice channel name
 * @property {string} guildName          - Server name
 * @property {string[]} participants     - Participant names
 * @property {string} narrativeSummary   - Brief narrative overview
 * @property {string[]} keyTopics        - Main discussion topics
 * @property {ActionItemSummary[]} actionItems - Extracted action items
 * @property {string[]} decisions        - Key decisions made
 * @property {Object} stats              - Conversation statistics
 */

/**
 * @typedef {Object} ActionItemSummary
 * @property {string} task               - The action item description
 * @property {string|null} assignee      - Who is responsible
 * @property {string|null} deadline      - Deadline if mentioned
 */

/**
 * @typedef {Object} ContextualSummaryResult
 * @property {MinutesSummary[]} summaries      - Individual meeting summaries
 * @property {string|null} crossMeetingSummary  - Combined summary across meetings (when multiple)
 * @property {number} meetingCount              - Number of meetings summarized
 * @property {string} generatedAt               - ISO timestamp of summary generation
 */

/**
 * Generate contextual summaries from one or more meeting minutes.
 *
 * @param {Array<{ entry: Object, content: string }>} minutesWithContent - Minutes entries with their markdown content
 * @param {Object} [options]
 * @param {number} [options.maxTopics=5]          - Maximum key topics per meeting
 * @param {number} [options.maxActionItems=10]    - Maximum action items per meeting
 * @param {number} [options.maxNarrativeLength=500] - Max chars for narrative summary
 * @param {boolean} [options.includeCrossSummary=true] - Generate cross-meeting summary
 * @param {string} [options.focusQuery]           - Optional query to focus the summary on
 * @returns {ContextualSummaryResult}
 */
export function generateContextualSummary(minutesWithContent, options = {}) {
  const {
    maxTopics = 5,
    maxActionItems = 10,
    maxNarrativeLength = 500,
    includeCrossSummary = true,
    focusQuery = null,
  } = options;

  const summaries = minutesWithContent.map(({ entry, content }) =>
    summarizeSingleMinutes(entry, content, { maxTopics, maxActionItems, maxNarrativeLength, focusQuery })
  );

  let crossMeetingSummary = null;
  if (includeCrossSummary && summaries.length > 1) {
    crossMeetingSummary = generateCrossMeetingSummary(summaries, focusQuery);
  }

  return {
    summaries,
    crossMeetingSummary,
    meetingCount: summaries.length,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Summarize a single meeting's minutes.
 *
 * @param {Object} entry - Index entry metadata
 * @param {string} content - Full markdown content
 * @param {Object} options
 * @returns {MinutesSummary}
 */
function summarizeSingleMinutes(entry, content, options) {
  const sections = parseMarkdownSections(content);

  const keyTopics = extractKeyTopics(sections, options.maxTopics, options.focusQuery);
  const actionItems = extractActionItems(sections, options.maxActionItems);
  const decisions = extractDecisions(sections);
  const narrativeSummary = buildNarrativeSummary(entry, sections, keyTopics, actionItems, options.maxNarrativeLength, options.focusQuery);
  const stats = extractStats(sections, content);

  return {
    sessionId: entry.sessionId,
    date: entry.date,
    time: entry.time,
    durationSeconds: entry.durationSeconds,
    channelName: entry.channelName,
    guildName: entry.guildName,
    participants: entry.participants ?? [],
    narrativeSummary,
    keyTopics,
    actionItems,
    decisions,
    stats,
  };
}

/**
 * Parse a meeting minutes markdown into named sections.
 *
 * @param {string} markdown
 * @returns {Map<string, string>} Section name -> content
 */
function parseMarkdownSections(markdown) {
  const sections = new Map();
  const lines = markdown.split('\n');
  let currentSection = '_header';
  let currentContent = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)/);
    if (h2Match) {
      // Save previous section
      sections.set(currentSection, currentContent.join('\n').trim());
      currentSection = h2Match[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  // Save last section
  sections.set(currentSection, currentContent.join('\n').trim());

  return sections;
}

/**
 * Extract key discussion topics from the minutes.
 * Looks in "Key Discussion Points" / "주요 논의 사항" sections,
 * and falls back to analyzing the transcript for topic shifts.
 *
 * @param {Map<string, string>} sections
 * @param {number} maxTopics
 * @param {string|null} focusQuery
 * @returns {string[]}
 */
function extractKeyTopics(sections, maxTopics, focusQuery) {
  const topics = [];

  // Look for key discussion points section (English and Korean variants)
  const discussionKeys = [
    'Key Discussion Points',
    '주요 논의 사항',
    'Discussion',
    '논의 사항',
    'Topics',
    '주제',
  ];

  let discussionContent = null;
  for (const key of discussionKeys) {
    for (const [sectionName, content] of sections) {
      if (sectionName.includes(key)) {
        discussionContent = content;
        break;
      }
    }
    if (discussionContent) break;
  }

  if (discussionContent) {
    // Extract bullet points or numbered items
    const items = discussionContent.match(/^[\s]*[-*\d.]+\s+(.+)/gm);
    if (items) {
      for (const item of items) {
        const cleaned = item.replace(/^[\s]*[-*\d.]+\s+/, '').trim();
        if (cleaned.length > 0) {
          // Strip bold markers
          topics.push(cleaned.replace(/\*\*/g, ''));
        }
      }
    }
  }

  // Also check Summary section for additional context
  const summaryKeys = ['Summary', '요약', 'Overview', '개요'];
  for (const key of summaryKeys) {
    for (const [sectionName, content] of sections) {
      if (sectionName.includes(key) && content) {
        const items = content.match(/^[\s]*[-*\d.]+\s+(.+)/gm);
        if (items) {
          for (const item of items) {
            const cleaned = item.replace(/^[\s]*[-*\d.]+\s+/, '').replace(/\*\*/g, '').trim();
            if (cleaned.length > 0 && !topics.includes(cleaned)) {
              topics.push(cleaned);
            }
          }
        }
        break;
      }
    }
  }

  // If there's a focus query, prioritize topics matching the query
  if (focusQuery) {
    const q = focusQuery.toLowerCase();
    topics.sort((a, b) => {
      const aMatch = a.toLowerCase().includes(q) ? 0 : 1;
      const bMatch = b.toLowerCase().includes(q) ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  return topics.slice(0, maxTopics);
}

/**
 * Extract action items from the minutes.
 *
 * @param {Map<string, string>} sections
 * @param {number} maxItems
 * @returns {ActionItemSummary[]}
 */
function extractActionItems(sections, maxItems) {
  const actionItems = [];

  const actionKeys = [
    'Action Items',
    '액션 아이템',
    '실행 항목',
    'Tasks',
    '할 일',
    'TODO',
    'To-Do',
  ];

  let actionContent = null;
  for (const key of actionKeys) {
    for (const [sectionName, content] of sections) {
      if (sectionName.includes(key)) {
        actionContent = content;
        break;
      }
    }
    if (actionContent) break;
  }

  if (!actionContent) return actionItems;

  // Parse action items - look for list items, optionally with assignee and deadline
  const lines = actionContent.split('\n');
  for (const line of lines) {
    const itemMatch = line.match(/^[\s]*[-*\d.]+\s+(.+)/);
    if (!itemMatch) continue;

    const rawItem = itemMatch[1].trim();
    if (!rawItem || rawItem === '---') continue;

    // Try to extract assignee: "task (담당: Name)" or "(assignee: Name)" or "@Name"
    let assignee = null;
    let deadline = null;
    let task = rawItem;

    // Korean assignee pattern: 담당: Name, 담당자: Name
    const koAssigneeMatch = rawItem.match(/[(\[【]?\s*담당(?:자)?\s*[:：]\s*(.+?)\s*[)\]】]?(?:\s|$)/);
    if (koAssigneeMatch) {
      assignee = koAssigneeMatch[1].trim();
      task = task.replace(koAssigneeMatch[0], '').trim();
    }

    // English assignee pattern: (assignee: Name), @Name, (owner: Name)
    const enAssigneeMatch = rawItem.match(/[(\[]\s*(?:assignee|owner|assigned to)\s*[:：]\s*(.+?)\s*[)\]]/i);
    if (!assignee && enAssigneeMatch) {
      assignee = enAssigneeMatch[1].trim();
      task = task.replace(enAssigneeMatch[0], '').trim();
    }

    const atMentionMatch = rawItem.match(/@(\S+)/);
    if (!assignee && atMentionMatch) {
      assignee = atMentionMatch[1];
    }

    // Korean deadline pattern: 기한: date, 마감: date
    const koDeadlineMatch = rawItem.match(/[(\[【]?\s*(?:기한|마감|데드라인)\s*[:：]\s*(.+?)\s*[)\]】]?(?:\s|$)/);
    if (koDeadlineMatch) {
      deadline = koDeadlineMatch[1].trim();
      task = task.replace(koDeadlineMatch[0], '').trim();
    }

    // English deadline pattern: (by date), (due: date), (deadline: date)
    const enDeadlineMatch = rawItem.match(/[(\[]\s*(?:by|due|deadline)\s*[:：]?\s*(.+?)\s*[)\]]/i);
    if (!deadline && enDeadlineMatch) {
      deadline = enDeadlineMatch[1].trim();
      task = task.replace(enDeadlineMatch[0], '').trim();
    }

    // Clean up task text
    task = task.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (task.length > 0) {
      actionItems.push({ task, assignee, deadline });
    }
  }

  return actionItems.slice(0, maxItems);
}

/**
 * Extract decisions from the minutes.
 *
 * @param {Map<string, string>} sections
 * @returns {string[]}
 */
function extractDecisions(sections) {
  const decisions = [];

  const decisionKeys = [
    'Decisions',
    '결정 사항',
    '의결 사항',
    'Agreements',
    '합의 사항',
  ];

  let decisionContent = null;
  for (const key of decisionKeys) {
    for (const [sectionName, content] of sections) {
      if (sectionName.includes(key)) {
        decisionContent = content;
        break;
      }
    }
    if (decisionContent) break;
  }

  if (!decisionContent) return decisions;

  const items = decisionContent.match(/^[\s]*[-*\d.]+\s+(.+)/gm);
  if (items) {
    for (const item of items) {
      const cleaned = item.replace(/^[\s]*[-*\d.]+\s+/, '').replace(/\*\*/g, '').trim();
      if (cleaned.length > 0 && cleaned !== '---') {
        decisions.push(cleaned);
      }
    }
  }

  return decisions;
}

/**
 * Extract conversation statistics from the content.
 *
 * @param {Map<string, string>} sections
 * @param {string} fullContent
 * @returns {Object}
 */
function extractStats(sections, fullContent) {
  const stats = {};

  // Try to find utterance count from content
  const utteranceMatch = fullContent.match(/\*\*(\d+)\*\*\s*(?:건의 발화|utterances)/);
  if (utteranceMatch) {
    stats.utteranceCount = parseInt(utteranceMatch[1], 10);
  }

  // Count sections
  const sectionCount = [...sections.keys()].filter(k => k !== '_header').length;
  stats.sectionCount = sectionCount;

  // Estimate word count from transcript section
  const transcriptKeys = ['Full Transcript', '전체 녹취록', 'Transcript', '녹취록'];
  for (const key of transcriptKeys) {
    for (const [sectionName, content] of sections) {
      if (sectionName.includes(key) && content) {
        // Count non-empty, non-header lines
        const transcriptLines = content.split('\n').filter(l =>
          l.trim().length > 0 && !l.startsWith('|') && !l.startsWith('---')
        );
        stats.transcriptLineCount = transcriptLines.length;
        break;
      }
    }
  }

  return stats;
}

/**
 * Build a brief narrative summary of the meeting.
 *
 * @param {Object} entry - Index metadata
 * @param {Map<string, string>} sections
 * @param {string[]} keyTopics
 * @param {ActionItemSummary[]} actionItems
 * @param {number} maxLength
 * @param {string|null} focusQuery
 * @returns {string}
 */
function buildNarrativeSummary(entry, sections, keyTopics, actionItems, maxLength, focusQuery) {
  const parts = [];
  const lang = detectLanguage(sections);

  // Build opening sentence
  const dateStr = entry.date ?? 'unknown date';
  const channelStr = entry.channelName ?? 'unknown channel';
  const participantCount = entry.participants?.length ?? entry.participantCount ?? 0;
  const durationMin = Math.round((entry.durationSeconds ?? 0) / 60);

  if (lang === 'ko') {
    parts.push(`${dateStr}에 "${channelStr}" 채널에서 ${participantCount}명이 참여한 ${durationMin}분간의 회의.`);
  } else {
    parts.push(`Meeting in "${channelStr}" on ${dateStr} with ${participantCount} participants, lasting ${durationMin} minutes.`);
  }

  // Add key topics
  if (keyTopics.length > 0) {
    if (lang === 'ko') {
      parts.push(`주요 논의: ${keyTopics.slice(0, 3).join('; ')}.`);
    } else {
      parts.push(`Key topics discussed: ${keyTopics.slice(0, 3).join('; ')}.`);
    }
  }

  // Add action items count
  if (actionItems.length > 0) {
    if (lang === 'ko') {
      parts.push(`${actionItems.length}개의 액션 아이템이 도출됨.`);
    } else {
      parts.push(`${actionItems.length} action item(s) identified.`);
    }
  }

  // If there's a focus query, try to find relevant context
  if (focusQuery) {
    const q = focusQuery.toLowerCase();
    const relevantSnippets = findRelevantSnippets(sections, q, 2);
    if (relevantSnippets.length > 0) {
      if (lang === 'ko') {
        parts.push(`"${focusQuery}" 관련: ${relevantSnippets.join(' ')}`);
      } else {
        parts.push(`Regarding "${focusQuery}": ${relevantSnippets.join(' ')}`);
      }
    }
  }

  const narrative = parts.join(' ');
  return narrative.length > maxLength
    ? narrative.substring(0, maxLength - 3) + '...'
    : narrative;
}

/**
 * Find snippets in the minutes content that are relevant to a query.
 *
 * @param {Map<string, string>} sections
 * @param {string} query - Lowercase query string
 * @param {number} maxSnippets
 * @returns {string[]}
 */
function findRelevantSnippets(sections, query, maxSnippets) {
  const snippets = [];

  for (const [sectionName, content] of sections) {
    // Skip header and transcript sections (too verbose)
    if (sectionName === '_header') continue;
    const lowerSection = sectionName.toLowerCase();
    if (lowerSection.includes('transcript') || lowerSection.includes('녹취록')) continue;

    const lines = content.split('\n');
    for (const line of lines) {
      if (line.toLowerCase().includes(query)) {
        // Clean up the line
        const cleaned = line
          .replace(/^[\s]*[-*\d.|]+\s*/, '')
          .replace(/\*\*/g, '')
          .trim();
        if (cleaned.length > 10 && cleaned.length < 200) {
          snippets.push(cleaned);
          if (snippets.length >= maxSnippets) return snippets;
        }
      }
    }
  }

  return snippets;
}

/**
 * Detect language from sections content.
 *
 * @param {Map<string, string>} sections
 * @returns {'ko' | 'en'}
 */
function detectLanguage(sections) {
  for (const sectionName of sections.keys()) {
    // Korean section headers
    if (/[\uAC00-\uD7AF]/.test(sectionName)) return 'ko';
  }
  return 'en';
}

/**
 * Generate a combined summary across multiple meetings.
 *
 * @param {MinutesSummary[]} summaries
 * @param {string|null} focusQuery
 * @returns {string}
 */
function generateCrossMeetingSummary(summaries, focusQuery) {
  if (summaries.length === 0) return '';

  // Detect primary language from first meeting
  const hasKorean = summaries.some(s =>
    s.keyTopics.some(t => /[\uAC00-\uD7AF]/.test(t)) ||
    s.narrativeSummary.match(/[\uAC00-\uD7AF]/)
  );
  const lang = hasKorean ? 'ko' : 'en';

  const parts = [];

  // Date range
  const dates = summaries.map(s => s.date).filter(Boolean).sort();
  const dateRange = dates.length > 1
    ? `${dates[0]} ~ ${dates[dates.length - 1]}`
    : dates[0] ?? 'unknown';

  if (lang === 'ko') {
    parts.push(`## ${summaries.length}개 회의 종합 요약 (${dateRange})`);
  } else {
    parts.push(`## Cross-meeting summary for ${summaries.length} meetings (${dateRange})`);
  }
  parts.push('');

  // Aggregate all unique participants
  const allParticipants = new Set();
  summaries.forEach(s => s.participants.forEach(p => allParticipants.add(p)));
  if (allParticipants.size > 0) {
    if (lang === 'ko') {
      parts.push(`**참석자 (전체):** ${[...allParticipants].join(', ')}`);
    } else {
      parts.push(`**All participants:** ${[...allParticipants].join(', ')}`);
    }
    parts.push('');
  }

  // Aggregate key topics across meetings
  const allTopics = [];
  summaries.forEach(s => s.keyTopics.forEach(t => {
    if (!allTopics.includes(t)) allTopics.push(t);
  }));

  if (allTopics.length > 0) {
    if (lang === 'ko') {
      parts.push('**주요 주제:**');
    } else {
      parts.push('**Key topics across meetings:**');
    }
    allTopics.slice(0, 10).forEach(t => parts.push(`- ${t}`));
    parts.push('');
  }

  // Aggregate action items
  const allActions = [];
  summaries.forEach(s => s.actionItems.forEach(a => allActions.push({
    ...a,
    fromDate: s.date,
    fromChannel: s.channelName,
  })));

  if (allActions.length > 0) {
    if (lang === 'ko') {
      parts.push('**미완료 액션 아이템:**');
    } else {
      parts.push('**Outstanding action items:**');
    }
    allActions.slice(0, 15).forEach(a => {
      const assigneeStr = a.assignee ? ` (${a.assignee})` : '';
      const deadlineStr = a.deadline ? ` [${a.deadline}]` : '';
      parts.push(`- ${a.task}${assigneeStr}${deadlineStr} — from ${a.fromDate}`);
    });
    parts.push('');
  }

  // Focus query context
  if (focusQuery) {
    const relevantMeetings = summaries.filter(s =>
      s.narrativeSummary.toLowerCase().includes(focusQuery.toLowerCase()) ||
      s.keyTopics.some(t => t.toLowerCase().includes(focusQuery.toLowerCase()))
    );
    if (relevantMeetings.length > 0) {
      if (lang === 'ko') {
        parts.push(`**"${focusQuery}" 관련 회의:** ${relevantMeetings.map(s => `${s.date} (${s.channelName})`).join(', ')}`);
      } else {
        parts.push(`**Meetings mentioning "${focusQuery}":** ${relevantMeetings.map(s => `${s.date} (${s.channelName})`).join(', ')}`);
      }
    }
  }

  return parts.join('\n');
}

/**
 * Format a ContextualSummaryResult as a compact text representation
 * suitable for agent consumption (LLM-friendly).
 *
 * @param {ContextualSummaryResult} result
 * @returns {string}
 */
export function formatSummaryForAgent(result) {
  const parts = [];

  parts.push(`# Meeting Minutes Summary (${result.meetingCount} meeting(s))`);
  parts.push(`Generated: ${result.generatedAt}`);
  parts.push('');

  for (const summary of result.summaries) {
    parts.push(`---`);
    parts.push(`### ${summary.date} ${summary.time} — ${summary.channelName}`);
    parts.push(`Participants: ${summary.participants.join(', ') || 'N/A'}`);
    parts.push(`Duration: ${Math.round(summary.durationSeconds / 60)}min`);
    parts.push('');
    parts.push(summary.narrativeSummary);
    parts.push('');

    if (summary.keyTopics.length > 0) {
      parts.push('**Topics:**');
      summary.keyTopics.forEach(t => parts.push(`- ${t}`));
      parts.push('');
    }

    if (summary.actionItems.length > 0) {
      parts.push('**Action Items:**');
      summary.actionItems.forEach(a => {
        const extra = [a.assignee, a.deadline].filter(Boolean).join(', ');
        parts.push(`- ${a.task}${extra ? ` (${extra})` : ''}`);
      });
      parts.push('');
    }

    if (summary.decisions.length > 0) {
      parts.push('**Decisions:**');
      summary.decisions.forEach(d => parts.push(`- ${d}`));
      parts.push('');
    }
  }

  if (result.crossMeetingSummary) {
    parts.push('');
    parts.push(result.crossMeetingSummary);
  }

  return parts.join('\n');
}

export {
  parseMarkdownSections,
  extractKeyTopics,
  extractActionItems,
  extractDecisions,
  extractStats,
  buildNarrativeSummary,
  findRelevantSnippets,
  detectLanguage,
  generateCrossMeetingSummary,
  summarizeSingleMinutes,
};
