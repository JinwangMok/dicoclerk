/**
 * Tests for the Meeting Minutes Summarizer
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateContextualSummary,
  formatSummaryForAgent,
  buildAgentDigest,
  parseMarkdownSections,
  extractKeyTopics,
  extractActionItems,
  extractDecisions,
  detectLanguage,
  findRelevantSnippets,
} from '../src/minutes/summarizer.js';

// --- Test fixtures ---

const SAMPLE_MINUTES_EN = `# Meeting Minutes — dev-chat

| | |
|---|---|
| **Date** | 2026-03-15 |
| **Time** | 14:30 |
| **Server** | Test Server |
| **Channel** | dev-chat |
| **Duration** | 45m 0s |
| **Started by** | Alice |

## Attendees

| Name | Utterances |
|---|---|
| Alice | 25 |
| Bob | 18 |
| Charlie | 12 |

## Summary

- Discussed the new authentication system design
- Reviewed deployment pipeline improvements
- Agreed on timeline for Q2 milestones

## Key Discussion Points

- **Auth system redesign**: Moving from JWT to session-based auth for improved security
- **CI/CD pipeline**: Adding automated canary deployments to staging
- **Q2 planning**: Sprint goals and resource allocation for the next quarter
- **Database migration**: PostgreSQL upgrade from v14 to v16

## Action Items

- Implement session-based auth prototype (assignee: Bob) [deadline: next Friday]
- Set up canary deployment scripts @Charlie
- Write migration guide for PostgreSQL upgrade (담당: Alice) (기한: end of month)
- Schedule Q2 planning meeting with stakeholders

## Decisions

- Approved session-based auth approach over OAuth2 refresh tokens
- Canary deployments will target staging first, then production
- PostgreSQL upgrade scheduled for April maintenance window

## Full Transcript

[14:30:05] Alice: Let's start with the auth system discussion
[14:30:15] Bob: I've been looking into session-based auth
[14:31:00] Charlie: What about the deployment pipeline?
`;

const SAMPLE_MINUTES_KO = `# 회의록 — 개발팀

| | |
|---|---|
| **날짜** | 2026-03-20 |
| **시간** | 10:00 |
| **서버** | 테스트 서버 |
| **채널** | 개발팀 |
| **소요시간** | 30m 0s |
| **시작** | 김철수 |

## 참석자

| Name | Utterances |
|---|---|
| 김철수 | 15 |
| 이영희 | 12 |

## 요약

- API 설계 검토 완료
- 배포 일정 확정

## 주요 논의 사항

- **API 엔드포인트 설계**: REST에서 GraphQL로 전환 검토
- **배포 일정**: 다음 주 수요일 배포 확정
- **테스트 커버리지**: 80% 이상 목표

## 액션 아이템

- GraphQL 스키마 초안 작성 (담당: 이영희) (기한: 금요일까지)
- 테스트 케이스 추가 (담당: 김철수)
- 배포 체크리스트 준비해 주세요

## 결정 사항

- GraphQL 전환 진행 결정
- 배포는 수요일 오전 10시

## 전체 녹취록

[10:00:05] 김철수: 오늘 API 설계 이야기를 해봅시다
[10:00:15] 이영희: GraphQL 전환이 좋을 것 같아요
`;

const SAMPLE_ENTRY_EN = {
  sessionId: 'session-001',
  date: '2026-03-15',
  time: '14:30',
  durationSeconds: 2700,
  channelName: 'dev-chat',
  guildName: 'Test Server',
  participants: ['Alice', 'Bob', 'Charlie'],
  participantCount: 3,
  transcriptCount: 55,
  language: 'en',
};

const SAMPLE_ENTRY_KO = {
  sessionId: 'session-002',
  date: '2026-03-20',
  time: '10:00',
  durationSeconds: 1800,
  channelName: '개발팀',
  guildName: '테스트 서버',
  participants: ['김철수', '이영희'],
  participantCount: 2,
  transcriptCount: 27,
  language: 'ko',
};

// --- Tests ---

describe('parseMarkdownSections', () => {
  it('should parse sections from English minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    assert.ok(sections.has('_header'));
    assert.ok(sections.has('Summary'));
    assert.ok(sections.has('Key Discussion Points'));
    assert.ok(sections.has('Action Items'));
    assert.ok(sections.has('Decisions'));
    assert.ok(sections.has('Full Transcript'));
  });

  it('should parse sections from Korean minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_KO);
    assert.ok(sections.has('요약'));
    assert.ok(sections.has('주요 논의 사항'));
    assert.ok(sections.has('액션 아이템'));
    assert.ok(sections.has('결정 사항'));
  });
});

describe('extractKeyTopics', () => {
  it('should extract topics from English minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const topics = extractKeyTopics(sections, 5, null);
    assert.ok(topics.length > 0, 'Should extract at least one topic');
    assert.ok(topics.some(t => t.includes('Auth system redesign') || t.includes('auth')),
      'Should include auth topic');
  });

  it('should extract topics from Korean minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_KO);
    const topics = extractKeyTopics(sections, 5, null);
    assert.ok(topics.length > 0);
    assert.ok(topics.some(t => t.includes('API') || t.includes('GraphQL')));
  });

  it('should prioritize topics matching focus query', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const topics = extractKeyTopics(sections, 5, 'database');
    // Database topic should be prioritized
    assert.ok(topics.length > 0);
    const dbIndex = topics.findIndex(t => t.toLowerCase().includes('database') || t.toLowerCase().includes('postgresql'));
    if (dbIndex >= 0) {
      assert.ok(dbIndex < 2, 'Database topic should be near the top when focused');
    }
  });

  it('should respect maxTopics limit', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const topics = extractKeyTopics(sections, 2, null);
    assert.ok(topics.length <= 2);
  });
});

describe('extractActionItems', () => {
  it('should extract action items from English minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const items = extractActionItems(sections, 10);
    assert.ok(items.length >= 3, `Expected at least 3 action items, got ${items.length}`);
  });

  it('should extract assignee from (assignee: Name) pattern', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const items = extractActionItems(sections, 10);
    const bobItem = items.find(i => i.assignee === 'Bob');
    assert.ok(bobItem, 'Should find item assigned to Bob');
  });

  it('should extract assignee from @mention pattern', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const items = extractActionItems(sections, 10);
    const charlieItem = items.find(i => i.assignee === 'Charlie');
    assert.ok(charlieItem, 'Should find item assigned to Charlie via @mention');
  });

  it('should extract Korean assignee patterns (담당)', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_KO);
    const items = extractActionItems(sections, 10);
    assert.ok(items.length >= 2);
    const youngHeeItem = items.find(i => i.assignee === '이영희');
    assert.ok(youngHeeItem, 'Should find item assigned to 이영희');
  });

  it('should extract deadline information', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const items = extractActionItems(sections, 10);
    const itemWithDeadline = items.find(i => i.deadline != null);
    assert.ok(itemWithDeadline, 'Should find at least one item with a deadline');
  });
});

describe('extractDecisions', () => {
  it('should extract decisions from English minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const decisions = extractDecisions(sections);
    assert.ok(decisions.length >= 2, `Expected at least 2 decisions, got ${decisions.length}`);
    assert.ok(decisions.some(d => d.includes('session-based auth')));
  });

  it('should extract decisions from Korean minutes', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_KO);
    const decisions = extractDecisions(sections);
    assert.ok(decisions.length >= 1);
    assert.ok(decisions.some(d => d.includes('GraphQL')));
  });
});

describe('detectLanguage', () => {
  it('should detect English', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    assert.equal(detectLanguage(sections), 'en');
  });

  it('should detect Korean', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_KO);
    assert.equal(detectLanguage(sections), 'ko');
  });
});

describe('findRelevantSnippets', () => {
  it('should find snippets matching a query', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const snippets = findRelevantSnippets(sections, 'auth', 3);
    assert.ok(snippets.length > 0, 'Should find auth-related snippets');
  });

  it('should return empty for unmatched query', () => {
    const sections = parseMarkdownSections(SAMPLE_MINUTES_EN);
    const snippets = findRelevantSnippets(sections, 'zzz_nonexistent_zzz', 3);
    assert.equal(snippets.length, 0);
  });
});

describe('generateContextualSummary', () => {
  it('should generate summary for a single English meeting', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
    ]);

    assert.equal(result.meetingCount, 1);
    assert.equal(result.summaries.length, 1);
    assert.ok(result.generatedAt);
    assert.equal(result.crossMeetingSummary, null); // only 1 meeting

    const summary = result.summaries[0];
    assert.equal(summary.sessionId, 'session-001');
    assert.equal(summary.date, '2026-03-15');
    assert.ok(summary.narrativeSummary.length > 0);
    assert.ok(summary.keyTopics.length > 0);
    assert.ok(summary.actionItems.length > 0);
    assert.ok(summary.decisions.length > 0);
  });

  it('should generate summary for a single Korean meeting', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);

    assert.equal(result.meetingCount, 1);
    const summary = result.summaries[0];
    assert.ok(summary.narrativeSummary.includes('개발팀') || summary.narrativeSummary.includes('회의'));
    assert.ok(summary.keyTopics.length > 0);
  });

  it('should generate cross-meeting summary for multiple meetings', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);

    assert.equal(result.meetingCount, 2);
    assert.equal(result.summaries.length, 2);
    assert.ok(result.crossMeetingSummary, 'Should have a cross-meeting summary');
    assert.ok(result.crossMeetingSummary.length > 0);
  });

  it('should apply focus_query to summaries', () => {
    const result = generateContextualSummary(
      [{ entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN }],
      { focusQuery: 'database' }
    );

    const summary = result.summaries[0];
    // Narrative should mention the focus query
    assert.ok(
      summary.narrativeSummary.toLowerCase().includes('database') ||
      summary.keyTopics.some(t => t.toLowerCase().includes('database') || t.toLowerCase().includes('postgresql')),
      'Summary should reference the focused topic'
    );
  });

  it('should respect maxTopics option', () => {
    const result = generateContextualSummary(
      [{ entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN }],
      { maxTopics: 2 }
    );
    assert.ok(result.summaries[0].keyTopics.length <= 2);
  });
});

describe('formatSummaryForAgent', () => {
  it('should produce readable agent-friendly text', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
    ]);
    const text = formatSummaryForAgent(result);

    assert.ok(text.includes('Meeting Minutes Summary'));
    assert.ok(text.includes('dev-chat'));
    assert.ok(text.includes('Topics:'));
    assert.ok(text.includes('Action Items:'));
    assert.ok(text.includes('Decisions:'));
  });

  it('should include cross-meeting summary when multiple meetings', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const text = formatSummaryForAgent(result);

    assert.ok(text.includes('2 meeting(s)'));
    assert.ok(text.includes('Cross-meeting summary') || text.includes('종합 요약'));
  });
});

describe('buildAgentDigest', () => {
  it('should return a no-records message for empty result', () => {
    const empty = { meetingCount: 0, summaries: [], crossMeetingSummary: null, generatedAt: new Date().toISOString() };
    const digest = buildAgentDigest(empty);
    assert.ok(digest.includes('0 meeting(s)'));
    assert.ok(digest.includes('No records found'));
  });

  it('should return a no-records message for null input', () => {
    const digest = buildAgentDigest(null);
    assert.ok(digest.includes('0 meeting(s)'));
  });

  it('should produce a compact digest for a single English meeting', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
    ]);
    const digest = buildAgentDigest(result);

    assert.ok(digest.includes('MEETING DIGEST'));
    assert.ok(digest.includes('1 meeting(s)'));
    assert.ok(digest.includes('SESSION 1'));
    assert.ok(digest.includes('dev-chat'));
    assert.ok(digest.includes('ACTION ITEMS'));
    assert.ok(digest.includes('DECISIONS'));
    assert.ok(digest.includes('KEY TOPICS'));
  });

  it('should aggregate action items across multiple meetings', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const digest = buildAgentDigest(result);

    assert.ok(digest.includes('SESSION 1'));
    assert.ok(digest.includes('SESSION 2'));
    // Action items from both meetings should appear
    assert.ok(digest.includes('ACTION ITEMS'));
    // Each action item line should follow the structured format
    const lines = digest.split('\n');
    const actionLines = lines.filter(l => l.startsWith('[ ]'));
    assert.ok(actionLines.length > 0, 'Should have action item lines starting with [ ]');
    // Verify each action item line has the pipe-delimited format
    actionLines.forEach(line => {
      assert.ok(line.includes(' | '), `Action line should have pipe delimiters: "${line}"`);
    });
  });

  it('should aggregate decisions from all meetings with date attribution', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const digest = buildAgentDigest(result);

    assert.ok(digest.includes('DECISIONS'));
    const lines = digest.split('\n');
    const decisionLines = lines.filter(l => l.startsWith('•') && l.includes('[2026-'));
    assert.ok(decisionLines.length > 0, 'Should have decision lines with date tags');
  });

  it('should deduplicate key topics across meetings', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const digest = buildAgentDigest(result);

    assert.ok(digest.includes('KEY TOPICS'));
    const lines = digest.split('\n');
    const topicLines = lines.filter(l => l.startsWith('•') && !l.includes('[2026-'));
    // All topic lines should be unique text
    const topics = topicLines.map(l => l.slice(2).trim());
    const unique = new Set(topics);
    assert.equal(topics.length, unique.size, 'Topics should not be duplicated in the digest');
  });

  it('should include FOCUS section when focusQuery is provided', () => {
    const result = generateContextualSummary(
      [{ entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN }],
      { focusQuery: 'database' }
    );
    const digest = buildAgentDigest(result, { focusQuery: 'database' });

    assert.ok(digest.includes('FOCUS:'));
    assert.ok(digest.includes('"database"'));
  });

  it('should report no relevant meetings when focus query has no matches', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
    ]);
    const digest = buildAgentDigest(result, { focusQuery: 'zzz_nonexistent_zzz' });

    assert.ok(digest.includes('FOCUS:'));
    assert.ok(digest.includes('No meetings directly mention'));
  });

  it('should include date range in header for multiple meetings', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const digest = buildAgentDigest(result);

    // Should include both dates in range
    assert.ok(digest.includes('2026-03-15'));
    assert.ok(digest.includes('2026-03-20'));
  });

  it('should respect maxActionItems cap with count indicator', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const digest = buildAgentDigest(result, { maxActionItems: 1 });
    const lines = digest.split('\n');
    const actionItemLines = lines.filter(l => l.startsWith('[ ]'));
    assert.ok(actionItemLines.length <= 1, `Should cap at 1 action item, got ${actionItemLines.length}`);
    // Should indicate truncation in the header
    const actionHeader = lines.find(l => l.startsWith('ACTION ITEMS'));
    assert.ok(actionHeader, 'Should have ACTION ITEMS header');
    assert.ok(actionHeader.includes('showing 1'), 'Should show cap indicator');
  });

  it('should produce narrower output than formatSummaryForAgent (token efficiency)', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_EN, content: SAMPLE_MINUTES_EN },
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const agentText = formatSummaryForAgent(result);
    const digest = buildAgentDigest(result);

    // The digest should be shorter (more token-efficient) than the full Markdown rendition
    assert.ok(
      digest.length < agentText.length,
      `Digest (${digest.length} chars) should be shorter than agentFormattedText (${agentText.length} chars)`
    );
  });

  it('should produce valid structured output for Korean meeting', () => {
    const result = generateContextualSummary([
      { entry: SAMPLE_ENTRY_KO, content: SAMPLE_MINUTES_KO },
    ]);
    const digest = buildAgentDigest(result);

    assert.ok(digest.includes('SESSION 1'));
    assert.ok(digest.includes('개발팀'));
    // Korean participants
    assert.ok(digest.includes('김철수') || digest.includes('이영희'));
  });
});
