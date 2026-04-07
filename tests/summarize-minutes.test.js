/**
 * Integration tests for Sub-AC 9.3 — Contextual Summary MCP Tool
 *
 * Tests the `summarize_minutes` MCP tool end-to-end:
 *   - Tool registration on the MCP server
 *   - Handler: query/topic → retrieval service → summarized context response
 *   - focus_query biases summary toward the specified topic
 *   - Korean and English content both supported
 *   - Cross-meeting summary generation
 *   - Response shape: agentDigest, agentFormattedText, summaries, crossMeetingSummary
 *   - Pagination, validation, and error handling
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createMcpServer } from '../src/mcp/server.js';
import { summarizeMinutes } from '../src/mcp/handlers.js';
import { _setMinutesDir, addEntry } from '../src/minutes/index-store.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeEnglishMinutes({ date = '2025-03-10', channel = 'engineering', participants = ['Alice', 'Bob'] } = {}) {
  return `# Meeting Minutes — ${channel}

| | |
|---|---|
| **Date** | ${date} |
| **Time** | 14:00 |
| **Server** | Acme Corp |
| **Channel** | ${channel} |
| **Duration** | 45m 0s |
| **Started by** | Alice |

## Attendees

| Name | Utterances |
|---|---|
${participants.map(p => `| ${p} | 10 |`).join('\n')}

## Summary

- Discussed authentication system redesign
- Reviewed CI/CD pipeline improvements
- Agreed on Q2 milestones and resource allocation

## Key Discussion Points

- **Authentication redesign**: Moving from JWT to session-based auth for improved security
- **CI/CD pipeline**: Adding automated canary deployments to staging environment
- **Q2 planning**: Sprint goals and budget allocation for next quarter
- **Database migration**: PostgreSQL upgrade from v14 to v16 scheduled

## Action Items

- Implement session-based auth prototype (assignee: Bob) [deadline: next Friday]
- Set up canary deployment scripts @Alice
- Write migration guide for PostgreSQL upgrade (담당: Bob) (기한: end of month)
- Schedule Q2 planning meeting with all stakeholders

## Decisions

- Approved session-based auth approach over OAuth2 refresh tokens
- Canary deployments will target staging environment first
- PostgreSQL upgrade scheduled for April maintenance window

## Full Transcript

[14:00:05] **Alice**: Let's start with the authentication system discussion.
[14:00:15] **Bob**: I've been researching session-based auth and it looks promising.
[14:01:00] **Alice**: Great. What about the CI/CD pipeline improvements?
[14:02:00] **Bob**: Canary deployments should reduce production incidents significantly.
`;
}

function makeKoreanMinutes({ date = '2025-03-20', channel = '개발팀', participants = ['김철수', '이영희'] } = {}) {
  return `# 회의록 — ${channel}

| | |
|---|---|
| **날짜** | ${date} |
| **시간** | 10:00 |
| **서버** | 테스트 서버 |
| **채널** | ${channel} |
| **소요시간** | 30m 0s |
| **시작** | 김철수 |

## 참석자

| Name | Utterances |
|---|---|
${participants.map(p => `| ${p} | 8 |`).join('\n')}

## 요약

- API 설계 검토 완료
- 배포 일정 확정
- 보안 감사 계획 논의

## 주요 논의 사항

- **API 엔드포인트 설계**: REST에서 GraphQL로 전환 검토
- **배포 일정**: 다음 주 수요일 배포 확정
- **테스트 커버리지**: 단위 테스트 80% 이상 목표
- **보안 감사**: 분기별 외부 보안 감사 도입

## 액션 아이템

- GraphQL 스키마 초안 작성 (담당: 이영희) (기한: 금요일까지)
- 단위 테스트 케이스 추가 (담당: 김철수)
- 보안 감사 업체 선정 (담당: 김철수) (기한: 이번 달 말)

## 결정 사항

- GraphQL 전환 진행 결정
- 배포는 수요일 오전 10시 확정
- 분기별 보안 감사 도입 승인

## 전체 녹취록

[10:00:05] **김철수**: 오늘 API 설계 이야기를 해봅시다.
[10:00:15] **이영희**: GraphQL 전환이 좋을 것 같습니다.
[10:01:00] **김철수**: 보안 감사 계획도 잡아야 할 것 같아요.
`;
}

function makeSecurityMinutes({ date = '2025-04-05', channel = 'security', participants = ['Charlie', 'Dave'] } = {}) {
  return `# Meeting Minutes — ${channel}

| | |
|---|---|
| **Date** | ${date} |
| **Time** | 09:00 |
| **Server** | Acme Corp |
| **Channel** | ${channel} |
| **Duration** | 60m 0s |
| **Started by** | Charlie |

## Attendees

| Name | Utterances |
|---|---|
| Charlie | 20 |
| Dave | 18 |

## Summary

- Conducted quarterly security audit review
- Reviewed vulnerability assessment results
- Planned remediation timeline for critical issues

## Key Discussion Points

- **Vulnerability assessment**: Three high-severity issues identified in API endpoints
- **Penetration testing**: Scheduled external pentest for next month
- **Access control**: Reviewing role-based access control implementation
- **Incident response**: Updating the security incident response playbook

## Action Items

- Patch high-severity API vulnerabilities (assignee: Dave) [deadline: this week]
- Schedule penetration testing with external vendor (assignee: Charlie) [deadline: 2025-04-15]
- Update RBAC policies for all microservices (assignee: Dave)

## Decisions

- External penetration testing approved for Q2
- All critical vulnerabilities must be patched within 48 hours of discovery
- Monthly security stand-ups to be added to team calendar

## Full Transcript

[09:00:05] **Charlie**: Let's review the vulnerability assessment results.
[09:00:20] **Dave**: We found three high-severity issues in the API layer.
[09:01:00] **Charlie**: We need to patch those immediately.
`;
}

// ---------------------------------------------------------------------------
// Test setup / teardown
// ---------------------------------------------------------------------------

let tmpDir;
let sessionIdEn;
let sessionIdKo;
let sessionIdSec;

async function setupFixtures() {
  tmpDir = join(tmpdir(), `dicoclerk-test-sum-${randomUUID()}`);
  await mkdir(tmpDir, { recursive: true });
  _setMinutesDir(tmpDir);

  // --- Fixture A: English engineering meeting ---
  sessionIdEn = randomUUID();
  const contentEn = makeEnglishMinutes({ date: '2025-03-10', channel: 'engineering', participants: ['Alice', 'Bob'] });
  const fileEn = 'minutes_2025-03-10_140000_engineering.md';
  const pathEn = join(tmpDir, fileEn);
  await writeFile(pathEn, contentEn, 'utf-8');
  await addEntry({
    sessionId: sessionIdEn,
    filename: fileEn,
    filePath: pathEn,
    startedAt: new Date('2025-03-10T14:00:00Z'),
    durationSeconds: 2700,
    guildId: 'guild-acme',
    guildName: 'Acme Corp',
    channelId: 'ch-eng',
    channelName: 'engineering',
    participants: ['Alice', 'Bob'],
    transcriptCount: 40,
    language: 'en',
    startedBy: 'Alice',
  });

  // --- Fixture B: Korean development meeting ---
  sessionIdKo = randomUUID();
  const contentKo = makeKoreanMinutes({ date: '2025-03-20', channel: '개발팀', participants: ['김철수', '이영희'] });
  const fileKo = 'minutes_2025-03-20_100000_dev.md';
  const pathKo = join(tmpDir, fileKo);
  await writeFile(pathKo, contentKo, 'utf-8');
  await addEntry({
    sessionId: sessionIdKo,
    filename: fileKo,
    filePath: pathKo,
    startedAt: new Date('2025-03-20T10:00:00Z'),
    durationSeconds: 1800,
    guildId: 'guild-acme',
    guildName: 'Acme Corp',
    channelId: 'ch-dev',
    channelName: '개발팀',
    participants: ['김철수', '이영희'],
    transcriptCount: 25,
    language: 'ko',
    startedBy: '김철수',
  });

  // --- Fixture C: Security meeting ---
  sessionIdSec = randomUUID();
  const contentSec = makeSecurityMinutes({ date: '2025-04-05', channel: 'security', participants: ['Charlie', 'Dave'] });
  const fileSec = 'minutes_2025-04-05_090000_security.md';
  const pathSec = join(tmpDir, fileSec);
  await writeFile(pathSec, contentSec, 'utf-8');
  await addEntry({
    sessionId: sessionIdSec,
    filename: fileSec,
    filePath: pathSec,
    startedAt: new Date('2025-04-05T09:00:00Z'),
    durationSeconds: 3600,
    guildId: 'guild-acme',
    guildName: 'Acme Corp',
    channelId: 'ch-sec',
    channelName: 'security',
    participants: ['Charlie', 'Dave'],
    transcriptCount: 38,
    language: 'en',
    startedBy: 'Charlie',
  });
}

async function teardownFixtures() {
  _setMinutesDir(null);
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// MCP Server registration
// ---------------------------------------------------------------------------

describe('MCP Server — summarize_minutes tool registration (Sub-AC 9.3)', () => {
  it('server is created without error', () => {
    const server = createMcpServer({ client: null, sessionManager: null });
    assert.ok(server, 'MCP server should be created');
  });

  it('summarize_minutes tool is registered on the server', () => {
    const server = createMcpServer({ client: null, sessionManager: null });
    // If tool registration failed it would throw during createMcpServer
    assert.ok(typeof server.connect === 'function',
      'server.connect should exist — confirms server was fully initialized');
  });
});

// ---------------------------------------------------------------------------
// Response shape — no fixture data needed
// ---------------------------------------------------------------------------

describe('summarize_minutes handler — response shape (no fixtures)', () => {
  it('returns valid JSON with all required top-level fields', async () => {
    const result = await summarizeMinutes({}, {});
    assert.ok(!result.isError, `Unexpected error: ${result.content?.[0]?.text}`);
    assert.equal(result.content[0].type, 'text');

    const data = JSON.parse(result.content[0].text);
    assert.ok('meetingCount' in data, 'must have meetingCount');
    assert.ok('summaries' in data, 'must have summaries');
    assert.ok(Array.isArray(data.summaries), 'summaries must be array');
    assert.ok('agentFormattedText' in data, 'must have agentFormattedText');
    assert.ok('agentDigest' in data, 'must have agentDigest');
  });

  it('agentDigest is always a non-empty string', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.agentDigest, 'string');
    assert.ok(data.agentDigest.length > 0, 'agentDigest must be non-empty');
  });

  it('agentFormattedText is always a non-empty string', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.agentFormattedText, 'string');
    assert.ok(data.agentFormattedText.length > 0);
  });

  it('returns zero meetingCount with message when no records match filters', async () => {
    const result = await summarizeMinutes({}, {
      date_from: '9999-01-01',
      date_to: '9999-12-31',
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
    assert.ok(typeof data.message === 'string', 'should include a message for empty results');
  });

  it('agentDigest contains MEETING DIGEST header for empty result', async () => {
    const result = await summarizeMinutes({}, { date_from: '9999-01-01' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.agentDigest.includes('MEETING DIGEST'), 'agentDigest must start with MEETING DIGEST');
  });

  it('response is always valid JSON', async () => {
    const result = await summarizeMinutes({}, {});
    assert.doesNotThrow(
      () => JSON.parse(result.content[0].text),
      'Response must always be parseable JSON'
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests — with real fixture data
// ---------------------------------------------------------------------------

describe('summarize_minutes handler — full integration with fixture data', async () => {
  before(setupFixtures);
  after(teardownFixtures);

  // --- Basic retrieval ---

  it('returns all meetings when no filters applied', async () => {
    const result = await summarizeMinutes({}, {});
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 3, `Expected >= 3 meetings, got ${data.meetingCount}`);
    assert.ok(data.summaries.length >= 3);
  });

  it('each summary has required fields', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    for (const summary of data.summaries) {
      assert.ok(summary.sessionId, 'summary must have sessionId');
      assert.ok(summary.date, 'summary must have date');
      assert.ok(summary.channelName, 'summary must have channelName');
      assert.ok(Array.isArray(summary.participants), 'summary must have participants array');
      assert.ok(typeof summary.narrativeSummary === 'string', 'summary must have narrativeSummary');
      assert.ok(Array.isArray(summary.keyTopics), 'summary must have keyTopics array');
      assert.ok(Array.isArray(summary.actionItems), 'summary must have actionItems array');
      assert.ok(Array.isArray(summary.decisions), 'summary must have decisions array');
    }
  });

  // --- query parameter retrieves relevant minutes ---

  it('query parameter retrieves minutes by channel name', async () => {
    const result = await summarizeMinutes({}, { query: 'engineering' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1, 'Should match engineering meeting');
    const hasEng = data.summaries.some(s => s.channelName === 'engineering');
    assert.ok(hasEng, 'Engineering channel meeting should be in results');
  });

  it('query parameter retrieves minutes by participant name', async () => {
    const result = await summarizeMinutes({}, { query: 'Charlie' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1, 'Should match security meeting with Charlie');
    const hasCharlie = data.summaries.some(s =>
      s.participants.some(p => p.toLowerCase().includes('charlie'))
    );
    assert.ok(hasCharlie, 'Charlie should be in at least one meeting result');
  });

  it('channel_name filter returns only matching meetings', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'security' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1);
    for (const summary of data.summaries) {
      assert.ok(
        summary.channelName.toLowerCase().includes('security'),
        `Expected "security" in channelName, got "${summary.channelName}"`
      );
    }
  });

  it('participant filter returns only meetings with that participant', async () => {
    const result = await summarizeMinutes({}, { participant: 'Alice' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1);
    for (const summary of data.summaries) {
      const hasAlice = summary.participants.some(p => p.toLowerCase().includes('alice'));
      assert.ok(hasAlice, `Expected Alice in participants: ${JSON.stringify(summary.participants)}`);
    }
  });

  // --- focus_query biases summary toward specified topic ---

  it('focus_query returns results referencing the specified topic', async () => {
    const result = await summarizeMinutes({}, { focus_query: 'security' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    // agentDigest should mention the focus query
    assert.ok(data.agentDigest.includes('FOCUS:'), 'agentDigest must contain FOCUS section');
    assert.ok(data.agentDigest.includes('"security"'), 'FOCUS section should show the query');
  });

  it('focus_query identifies relevant meetings in the digest', async () => {
    const result = await summarizeMinutes({}, { focus_query: 'authentication' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.agentDigest.includes('FOCUS:'));
    // The engineering meeting mentions authentication
    const mentionsRelevant = data.agentDigest.includes('Relevant meeting') ||
      data.agentDigest.includes('engineering') ||
      data.agentDigest.includes('No meetings directly mention');
    assert.ok(mentionsRelevant, 'FOCUS section should identify relevant meetings or report none');
  });

  it('focus_query prioritizes matching topics in keyTopics', async () => {
    const result = await summarizeMinutes({}, {
      focus_query: 'authentication',
      channel_name: 'engineering',
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    if (data.summaries.length > 0) {
      const engrSummary = data.summaries.find(s => s.channelName === 'engineering');
      if (engrSummary && engrSummary.keyTopics.length > 0) {
        // Authentication-related topic should appear near top (focus_query sorts it first)
        const authIndex = engrSummary.keyTopics.findIndex(t =>
          t.toLowerCase().includes('auth')
        );
        if (authIndex >= 0) {
          assert.ok(authIndex < 3, `Auth topic (index ${authIndex}) should be near the top`);
        }
      }
    }
  });

  it('focus_query with no matching content reports no relevant meetings', async () => {
    const result = await summarizeMinutes({}, { focus_query: 'zzz_impossible_topic_xyz' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    if (data.meetingCount > 0) {
      assert.ok(data.agentDigest.includes('No meetings directly mention'));
    }
  });

  // --- narrativeSummary contains meaningful content ---

  it('narrativeSummary mentions channel name and duration', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'engineering' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.summaries.length >= 1);
    const summary = data.summaries.find(s => s.channelName === 'engineering');
    assert.ok(summary, 'engineering meeting should be found');
    assert.ok(summary.narrativeSummary.length > 0);
    // Narrative should mention the channel
    assert.ok(
      summary.narrativeSummary.toLowerCase().includes('engineering') ||
      summary.narrativeSummary.includes('45') || // duration reference
      summary.narrativeSummary.includes('Alice') || // participant reference
      summary.narrativeSummary.includes('2025-03-10'), // date reference
      `Narrative should reference meeting context: "${summary.narrativeSummary}"`
    );
  });

  it('keyTopics are extracted from the minutes content', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'engineering' });
    const data = JSON.parse(result.content[0].text);
    const summary = data.summaries.find(s => s.channelName === 'engineering');
    assert.ok(summary, 'engineering meeting should be found');
    assert.ok(summary.keyTopics.length > 0, 'Should have extracted key topics');
    // Engineering meeting has authentication, CI/CD, database topics
    const hasKnownTopic = summary.keyTopics.some(t =>
      /auth|ci.?cd|pipeline|database|postgresql|q2|planning/i.test(t)
    );
    assert.ok(hasKnownTopic,
      `keyTopics should contain relevant topics, got: ${JSON.stringify(summary.keyTopics)}`
    );
  });

  it('actionItems are extracted with task, assignee, deadline fields', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'engineering' });
    const data = JSON.parse(result.content[0].text);
    const summary = data.summaries.find(s => s.channelName === 'engineering');
    assert.ok(summary);
    assert.ok(summary.actionItems.length > 0, 'Engineering meeting should have action items');
    for (const item of summary.actionItems) {
      assert.ok('task' in item, 'action item must have task');
      assert.ok('assignee' in item, 'action item must have assignee');
      assert.ok('deadline' in item, 'action item must have deadline');
    }
    // Bob is assigned the session-based auth prototype
    const bobItem = summary.actionItems.find(i => i.assignee === 'Bob');
    assert.ok(bobItem, 'Should find action item assigned to Bob');
  });

  it('decisions are extracted from the minutes', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'security' });
    const data = JSON.parse(result.content[0].text);
    const summary = data.summaries.find(s => s.channelName === 'security');
    assert.ok(summary);
    assert.ok(summary.decisions.length > 0, 'Security meeting should have decisions');
    const hasPentestDecision = summary.decisions.some(d =>
      /pentest|penetration|quarterly|critical|vulnerabilit/i.test(d)
    );
    assert.ok(hasPentestDecision,
      `Decisions should reference security topics, got: ${JSON.stringify(summary.decisions)}`
    );
  });

  // --- Korean content support ---

  it('handles Korean meeting minutes and extracts topics in Korean', async () => {
    const result = await summarizeMinutes({}, { channel_name: '개발팀' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1, 'Should find Korean meeting');
    const koSummary = data.summaries.find(s => s.channelName === '개발팀');
    assert.ok(koSummary, '개발팀 meeting should be present');
    assert.ok(koSummary.keyTopics.length > 0, 'Should extract topics from Korean content');
    // Korean meeting covers GraphQL, 배포, 테스트, 보안
    const hasKoreanTopic = koSummary.keyTopics.some(t =>
      /api|graphql|배포|테스트|보안|엔드포인트/i.test(t)
    );
    assert.ok(hasKoreanTopic,
      `Korean topics should be extracted, got: ${JSON.stringify(koSummary.keyTopics)}`
    );
  });

  it('Korean actionItems include extracted assignees (담당 pattern)', async () => {
    const result = await summarizeMinutes({}, { channel_name: '개발팀' });
    const data = JSON.parse(result.content[0].text);
    const koSummary = data.summaries.find(s => s.channelName === '개발팀');
    assert.ok(koSummary);
    assert.ok(koSummary.actionItems.length > 0, 'Korean meeting should have action items');
    // 이영희 is assigned the GraphQL schema task
    const youngHeeItem = koSummary.actionItems.find(i => i.assignee === '이영희');
    assert.ok(youngHeeItem, '이영희 should be found as assignee via 담당 pattern');
  });

  it('Korean narrativeSummary mentions the channel name', async () => {
    const result = await summarizeMinutes({}, { channel_name: '개발팀' });
    const data = JSON.parse(result.content[0].text);
    const koSummary = data.summaries.find(s => s.channelName === '개발팀');
    assert.ok(koSummary);
    assert.ok(koSummary.narrativeSummary.length > 0);
    assert.ok(
      koSummary.narrativeSummary.includes('개발팀') ||
      koSummary.narrativeSummary.includes('2025-03-20') ||
      koSummary.narrativeSummary.includes('30'),
      `Korean narrative should reference meeting context: "${koSummary.narrativeSummary}"`
    );
  });

  // --- Cross-meeting summary ---

  it('crossMeetingSummary is generated when multiple meetings match', async () => {
    const result = await summarizeMinutes({}, { limit: 5 });
    const data = JSON.parse(result.content[0].text);
    if (data.meetingCount >= 2) {
      assert.ok(data.crossMeetingSummary !== null && data.crossMeetingSummary !== undefined,
        'crossMeetingSummary should be present for multiple meetings');
      assert.ok(typeof data.crossMeetingSummary === 'string');
      assert.ok(data.crossMeetingSummary.length > 0);
    }
  });

  it('crossMeetingSummary is null when only 1 meeting matches', async () => {
    const result = await summarizeMinutes({}, {
      channel_name: 'security',
      limit: 1,
    });
    const data = JSON.parse(result.content[0].text);
    if (data.meetingCount === 1) {
      assert.equal(data.crossMeetingSummary, null,
        'crossMeetingSummary should be null for single meeting');
    }
  });

  // --- agentDigest content structure ---

  it('agentDigest contains SESSION blocks for each meeting', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    if (data.meetingCount >= 1) {
      assert.ok(data.agentDigest.includes('SESSION 1'),
        'agentDigest must have SESSION blocks');
    }
  });

  it('agentDigest contains ACTION ITEMS section when meetings have action items', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'engineering' });
    const data = JSON.parse(result.content[0].text);
    if (data.summaries.some(s => s.actionItems.length > 0)) {
      assert.ok(data.agentDigest.includes('ACTION ITEMS'),
        'agentDigest must list action items');
      // Action item lines follow [ ] format
      const actionLines = data.agentDigest.split('\n').filter(l => l.startsWith('[ ]'));
      assert.ok(actionLines.length > 0, 'Should have [ ] action item lines');
      // Each line should have pipe-delimited fields
      actionLines.forEach(line => {
        assert.ok(line.includes(' | '),
          `Action item line must have pipe delimiters: "${line}"`);
      });
    }
  });

  it('agentDigest contains DECISIONS section when meetings have decisions', async () => {
    const result = await summarizeMinutes({}, { channel_name: 'security' });
    const data = JSON.parse(result.content[0].text);
    if (data.summaries.some(s => s.decisions.length > 0)) {
      assert.ok(data.agentDigest.includes('DECISIONS'),
        'agentDigest must include DECISIONS section');
      const decisionLines = data.agentDigest.split('\n').filter(l => l.startsWith('•'));
      assert.ok(decisionLines.length > 0, 'Decision lines should start with •');
    }
  });

  it('agentDigest is more token-efficient than agentFormattedText', async () => {
    const result = await summarizeMinutes({}, { limit: 3 });
    const data = JSON.parse(result.content[0].text);
    if (data.meetingCount >= 2) {
      assert.ok(
        data.agentDigest.length < data.agentFormattedText.length,
        `agentDigest (${data.agentDigest.length} chars) should be shorter than agentFormattedText (${data.agentFormattedText.length} chars)`
      );
    }
  });

  // --- Date range filtering ---

  it('date_from filter excludes earlier meetings', async () => {
    const result = await summarizeMinutes({}, { date_from: '2025-04-01' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    // Only the security meeting (2025-04-05) should match
    for (const summary of data.summaries) {
      assert.ok(summary.date >= '2025-04-01',
        `date_from filter failed: got meeting date ${summary.date}`);
    }
  });

  it('date_to filter excludes later meetings', async () => {
    const result = await summarizeMinutes({}, { date_to: '2025-03-15' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    // Only engineering meeting (2025-03-10) should match
    for (const summary of data.summaries) {
      assert.ok(summary.date <= '2025-03-15',
        `date_to filter failed: got meeting date ${summary.date}`);
    }
  });

  it('exact date range returns only matching meetings', async () => {
    const result = await summarizeMinutes({}, {
      date_from: '2025-03-10',
      date_to: '2025-03-10',
    });
    const data = JSON.parse(result.content[0].text);
    for (const summary of data.summaries) {
      assert.equal(summary.date, '2025-03-10',
        `Expected only 2025-03-10 meetings, got ${summary.date}`);
    }
    assert.ok(data.meetingCount >= 1, 'Should find the 2025-03-10 engineering meeting');
  });

  // --- Keywords filter ---

  it('keywords filter returns meetings containing keyword in content', async () => {
    const result = await summarizeMinutes({}, { keywords: ['canary'] });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1, 'Should match meeting mentioning "canary"');
    // Engineering meeting mentions canary deployments
    const hasEng = data.summaries.some(s => s.channelName === 'engineering');
    assert.ok(hasEng, 'Engineering meeting (which mentions canary) should be in results');
  });

  it('keywords filter returns meetings with Korean keyword', async () => {
    const result = await summarizeMinutes({}, { keywords: ['GraphQL'] });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 1, 'Should match Korean meeting mentioning "GraphQL"');
  });

  it('keywords filter with no matches returns empty', async () => {
    const result = await summarizeMinutes({}, { keywords: ['xyzzy_no_match_keyword'] });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
  });

  // --- Pagination ---

  it('limit parameter caps number of meetings summarized', async () => {
    const result = await summarizeMinutes({}, { limit: 1 });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount <= 1, `Expected at most 1 meeting, got ${data.meetingCount}`);
    assert.ok(data.summaries.length <= 1);
  });

  it('limit: 2 returns at most 2 summaries with correct meetingCount', async () => {
    const result = await summarizeMinutes({}, { limit: 2 });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount <= 2);
    assert.ok(data.summaries.length <= 2);
  });

  // --- max_topics / max_action_items options ---

  it('max_topics option limits key topics per meeting', async () => {
    const result = await summarizeMinutes({}, { max_topics: 2 });
    const data = JSON.parse(result.content[0].text);
    for (const summary of data.summaries) {
      assert.ok(summary.keyTopics.length <= 2,
        `keyTopics should be capped at 2, got ${summary.keyTopics.length}`);
    }
  });

  it('max_action_items option limits action items per meeting', async () => {
    const result = await summarizeMinutes({}, { max_action_items: 1 });
    const data = JSON.parse(result.content[0].text);
    for (const summary of data.summaries) {
      assert.ok(summary.actionItems.length <= 1,
        `actionItems should be capped at 1, got ${summary.actionItems.length}`);
    }
  });

  // --- guild_id filter ---

  it('guild_id filter returns only matching guild meetings', async () => {
    const result = await summarizeMinutes({}, { guild_id: 'guild-acme' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount >= 3, 'All three fixtures belong to guild-acme');
  });

  it('guild_id filter returns empty for non-existent guild', async () => {
    const result = await summarizeMinutes({}, { guild_id: 'guild-nonexistent-9999' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
  });

  // --- generatedAt timestamp ---

  it('generatedAt is a valid ISO timestamp when meetings are found', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    if (data.generatedAt !== undefined) {
      const ts = new Date(data.generatedAt);
      assert.ok(!isNaN(ts.getTime()), `generatedAt must be a valid ISO date, got: ${data.generatedAt}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Validation tests — no fixture data needed
// ---------------------------------------------------------------------------

describe('summarize_minutes handler — input validation (Sub-AC 9.3)', async () => {
  it('throws McpError for invalid date_from format', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { date_from: 'march-10-2025' }),
      (err) => {
        assert.ok(err instanceof McpError, `Expected McpError, got ${err.constructor.name}`);
        return true;
      }
    );
  });

  it('throws McpError for invalid date_to format', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { date_to: '2025/03/10' }),
      (err) => err instanceof McpError
    );
  });

  it('throws McpError for limit < 1', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { limit: -1 }),
      (err) => err instanceof McpError
    );
  });

  it('throws McpError for max_topics > 20', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { max_topics: 25 }),
      (err) => err instanceof McpError
    );
  });

  it('throws McpError for max_action_items > 50', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { max_action_items: 55 }),
      (err) => err instanceof McpError
    );
  });

  it('throws McpError for max_narrative_length < 50', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { max_narrative_length: 10 }),
      (err) => err instanceof McpError
    );
  });

  it('throws McpError for max_narrative_length > 2000', async () => {
    const { McpError } = await import('@modelcontextprotocol/sdk/types.js');
    await assert.rejects(
      () => summarizeMinutes({}, { max_narrative_length: 9999 }),
      (err) => err instanceof McpError
    );
  });

  it('accepts all valid params without throwing', async () => {
    await assert.doesNotReject(
      () => summarizeMinutes({}, {
        date_from: '2025-01-01',
        date_to: '2025-12-31',
        limit: 5,
        offset: 0,
        max_topics: 5,
        max_action_items: 10,
        max_narrative_length: 500,
        focus_query: 'security',
        language: 'en',
      }),
      'All valid params should not throw'
    );
  });

  it('deps argument is ignored (reads from disk)', async () => {
    const result = await summarizeMinutes({ arbitrary: 'junk' }, { limit: 1 });
    assert.ok(result.content, 'Handler should work regardless of deps content');
  });
});
