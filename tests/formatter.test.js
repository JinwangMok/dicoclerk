/**
 * Tests for Meeting Minutes Formatter
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatMeetingMinutes,
  generateMinutesFilename,
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
  DEFAULT_OPTIONS,
} from '../src/minutes/formatter.js';

// --- Test Fixtures ---

function makeEntry(overrides = {}) {
  return {
    text: 'Hello world',
    speaker: 0,
    start: 0,
    end: 2,
    confidence: 0.95,
    isFinal: true,
    ...overrides,
  };
}

function makeSampleTranscript() {
  return [
    makeEntry({ text: '오늘 회의를 시작하겠습니다', speaker: 0, start: 0, end: 3 }),
    makeEntry({ text: '네 안녕하세요', speaker: 1, start: 4, end: 6 }),
    makeEntry({ text: '첫 번째 안건에 대해서 이야기합시다', speaker: 0, start: 7, end: 11 }),
    makeEntry({ text: '그 부분은 제가 확인해 보겠습니다', speaker: 1, start: 12, end: 15 }),
    makeEntry({ text: '다음 주까지 보고서 준비해 주세요', speaker: 0, start: 16, end: 20 }),
    makeEntry({ text: '네 알겠습니다 준비하겠습니다', speaker: 1, start: 21, end: 24 }),
    makeEntry({ text: 'API 관련해서 이슈가 있습니다', speaker: 2, start: 25, end: 29 }),
    makeEntry({ text: '어떤 이슈인가요', speaker: 0, start: 30, end: 32 }),
    makeEntry({ text: '응답 속도가 느려지는 문제입니다', speaker: 2, start: 33, end: 37 }),
    makeEntry({ text: '그 문제는 내일까지 수정 부탁합니다', speaker: 0, start: 38, end: 42 }),
  ];
}

function makeMetadata(overrides = {}) {
  return {
    guildName: 'Test Server',
    channelName: 'general-voice',
    startedAt: new Date('2026-04-03T10:00:00Z'),
    durationSeconds: 600,
    startedBy: 'TestUser',
    language: 'ko',
    speakerMap: new Map([[0, '김철수'], [1, '이영희'], [2, '박민수']]),
    ...overrides,
  };
}

// --- Unit tests ---

describe('formatDuration', () => {
  it('formats seconds only', () => {
    assert.equal(formatDuration(45), '0m 45s');
  });

  it('formats minutes and seconds', () => {
    assert.equal(formatDuration(125), '2m 05s');
  });

  it('formats hours', () => {
    assert.equal(formatDuration(3661), '1h 01m 01s');
  });

  it('handles zero', () => {
    assert.equal(formatDuration(0), '0m 00s');
  });
});

describe('formatTimestamp', () => {
  it('formats seconds into [MM:SS]', () => {
    assert.equal(formatTimestamp(65), '[01:05]');
  });

  it('handles zero', () => {
    assert.equal(formatTimestamp(0), '[00:00]');
  });

  it('handles large values', () => {
    assert.equal(formatTimestamp(3600), '[60:00]');
  });
});

describe('resolveSpeakerName', () => {
  it('returns name from speakerMap', () => {
    const map = new Map([[0, 'Alice']]);
    assert.equal(resolveSpeakerName(0, map), 'Alice');
  });

  it('returns Speaker N for unknown IDs', () => {
    assert.equal(resolveSpeakerName(3, new Map()), 'Speaker 3');
  });

  it('returns Unknown for speaker -1', () => {
    assert.equal(resolveSpeakerName(-1, new Map()), 'Unknown');
  });

  it('handles null/undefined speaker', () => {
    assert.equal(resolveSpeakerName(null, new Map()), 'Unknown');
    assert.equal(resolveSpeakerName(undefined, new Map()), 'Unknown');
  });

  it('handles no speakerMap', () => {
    assert.equal(resolveSpeakerName(1), 'Speaker 1');
  });
});

describe('extractAttendees', () => {
  it('extracts unique speakers with counts', () => {
    const transcript = [
      makeEntry({ speaker: 0, start: 0, end: 2 }),
      makeEntry({ speaker: 0, start: 3, end: 5 }),
      makeEntry({ speaker: 1, start: 6, end: 8 }),
    ];
    const attendees = extractAttendees(transcript, new Map([[0, 'Alice'], [1, 'Bob']]));
    assert.equal(attendees.length, 2);
    assert.equal(attendees[0].name, 'Alice'); // most utterances first
    assert.equal(attendees[0].utteranceCount, 2);
    assert.equal(attendees[1].name, 'Bob');
    assert.equal(attendees[1].utteranceCount, 1);
  });

  it('returns empty array for empty transcript', () => {
    assert.deepEqual(extractAttendees([], new Map()), []);
  });

  it('calculates speaking time', () => {
    const transcript = [makeEntry({ speaker: 0, start: 0, end: 10 })];
    const attendees = extractAttendees(transcript);
    assert.equal(attendees[0].speakingTime, 10);
  });
});

describe('extractActionItems', () => {
  it('detects Korean action items', () => {
    const transcript = [
      makeEntry({ text: '다음 주까지 보고서 준비해 주세요', speaker: 0, start: 10 }),
      makeEntry({ text: '네 알겠습니다', speaker: 1, start: 15 }),
    ];
    const items = extractActionItems(transcript, new Map([[0, 'Boss']]), 'ko');
    assert.ok(items.length >= 1);
    assert.ok(items[0].text.includes('준비해 주세요'));
  });

  it('detects English action items', () => {
    const transcript = [
      makeEntry({ text: 'We need to update the documentation', speaker: 0, start: 5 }),
      makeEntry({ text: "I'll handle the deployment", speaker: 1, start: 10 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
  });

  it('skips non-final entries', () => {
    const transcript = [
      makeEntry({ text: 'Please update the docs', speaker: 0, isFinal: false }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.equal(items.length, 0);
  });

  it('respects maxItems limit', () => {
    const transcript = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ text: `Please do task ${i}`, speaker: 0, start: i * 5, isFinal: true })
    );
    const items = extractActionItems(transcript, new Map(), 'en', 3);
    assert.ok(items.length <= 3);
  });

  it('deduplicates action items', () => {
    const transcript = [
      makeEntry({ text: 'Please update the docs', speaker: 0, start: 5 }),
      makeEntry({ text: 'please update the docs', speaker: 0, start: 10 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.equal(items.length, 1);
  });

  it('extracts deadline from Korean action item', () => {
    const transcript = [
      makeEntry({ text: '다음 주까지 보고서 준비해 주세요', speaker: 0, start: 10 }),
    ];
    const items = extractActionItems(transcript, new Map([[0, 'Boss']]), 'ko');
    assert.ok(items.length >= 1);
    assert.equal(items[0].deadline, '다음 주');
  });

  it('extracts deadline from English action item', () => {
    const transcript = [
      makeEntry({ text: 'Please finish the report by next Friday', speaker: 0, start: 5 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].deadline, 'next Friday');
  });

  it('extracts self-assignment from English "I will" pattern', () => {
    const transcript = [
      makeEntry({ text: "I'll handle the deployment by tomorrow", speaker: 1, start: 10 }),
    ];
    const speakerMap = new Map([[1, 'Bob']]);
    const items = extractActionItems(transcript, speakerMap, 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].assignee, 'Bob');
    assert.equal(items[0].deadline, 'tomorrow');
  });

  it('extracts self-assignment from Korean "제가 하겠습니다" pattern', () => {
    const transcript = [
      makeEntry({ text: '제가 내일까지 확인하겠습니다', speaker: 1, start: 10 }),
    ];
    const speakerMap = new Map([[1, '이영희']]);
    const items = extractActionItems(transcript, speakerMap, 'ko');
    assert.ok(items.length >= 1);
    assert.equal(items[0].assignee, '이영희');
    assert.equal(items[0].deadline, '내일');
  });

  it('infers assignee from next-speaker acknowledgement', () => {
    const transcript = [
      makeEntry({ text: '보고서 준비해 주세요', speaker: 0, start: 10 }),
      makeEntry({ text: '네 알겠습니다', speaker: 1, start: 15 }),
    ];
    const speakerMap = new Map([[0, 'Boss'], [1, '이영희']]);
    const items = extractActionItems(transcript, speakerMap, 'ko');
    assert.ok(items.length >= 1);
    assert.equal(items[0].assignee, '이영희');
  });

  it('returns null assignee when no assignee can be inferred', () => {
    const transcript = [
      makeEntry({ text: 'We need to update the documentation', speaker: 0, start: 5 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].assignee, null);
  });

  it('returns null deadline when no deadline is mentioned', () => {
    const transcript = [
      makeEntry({ text: 'Please update the docs', speaker: 0, start: 5 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].deadline, null);
  });

  it('extracts assignee from explicit English assignment', () => {
    const transcript = [
      makeEntry({ text: 'This task is assigned to Alice', speaker: 0, start: 5 }),
    ];
    const speakerMap = new Map([[0, 'Boss'], [1, 'Alice']]);
    const items = extractActionItems(transcript, speakerMap, 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].assignee, 'Alice');
  });

  it('extracts date-format deadline', () => {
    const transcript = [
      makeEntry({ text: 'Please complete the review by March 15th', speaker: 0, start: 5 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].deadline, 'March 15th');
  });

  it('extracts Korean date deadline (월/일)', () => {
    const transcript = [
      makeEntry({ text: '4월 10일까지 완료해 주세요', speaker: 0, start: 5 }),
    ];
    const items = extractActionItems(transcript, new Map(), 'ko');
    assert.ok(items.length >= 1);
    assert.equal(items[0].deadline, '4월 10일');
  });
});

describe('extractDeadline', () => {
  it('extracts Korean "다음 주까지"', () => {
    assert.equal(extractDeadline('다음 주까지 보고서 준비해 주세요', 'ko'), '다음 주');
  });

  it('extracts Korean "내일까지"', () => {
    assert.equal(extractDeadline('내일까지 수정 부탁합니다', 'ko'), '내일');
  });

  it('extracts Korean day-of-week deadline', () => {
    assert.equal(extractDeadline('금요일까지 제출해 주세요', 'ko'), '금요일');
  });

  it('extracts Korean date (월 일)', () => {
    assert.equal(extractDeadline('3월 15일까지 완료해 주세요', 'ko'), '3월 15일');
  });

  it('extracts English "by tomorrow"', () => {
    assert.equal(extractDeadline('Please finish by tomorrow', 'en'), 'tomorrow');
  });

  it('extracts English "by next Monday"', () => {
    assert.equal(extractDeadline('Complete the task by next Monday', 'en'), 'next Monday');
  });

  it('extracts English "by end of week"', () => {
    assert.equal(extractDeadline('Submit the report by end of week', 'en'), 'end of week');
  });

  it('extracts English date format', () => {
    assert.equal(extractDeadline('Due by March 15th', 'en'), 'March 15th');
  });

  it('extracts "within N days" deadline', () => {
    assert.equal(extractDeadline('Complete this within 3 days', 'en'), 'within 3 days');
  });

  it('returns null when no deadline found', () => {
    assert.equal(extractDeadline('Hello world', 'en'), null);
    assert.equal(extractDeadline('안녕하세요', 'ko'), null);
  });
});

describe('extractAssignee', () => {
  it('detects English self-assignment with "I will"', () => {
    assert.equal(extractAssignee("I'll handle the deployment", 'Bob', 'en'), 'Bob');
  });

  it('detects Korean self-assignment with "제가 하겠습니다"', () => {
    assert.equal(extractAssignee('제가 확인하겠습니다', '이영희', 'ko'), '이영희');
  });

  it('detects explicit English assignment "assigned to"', () => {
    const speakerMap = new Map([[0, 'Boss'], [1, 'Alice']]);
    assert.equal(extractAssignee('assigned to Alice for review', 'Boss', 'en', [], -1, speakerMap), 'Alice');
  });

  it('infers assignee from next-speaker acknowledgement', () => {
    const transcript = [
      makeEntry({ text: '보고서 준비해 주세요', speaker: 0, start: 10 }),
      makeEntry({ text: '네 알겠습니다', speaker: 1, start: 15 }),
    ];
    const speakerMap = new Map([[0, 'Boss'], [1, '이영희']]);
    const result = extractAssignee('보고서 준비해 주세요', 'Boss', 'ko', transcript, 0, speakerMap);
    assert.equal(result, '이영희');
  });

  it('returns null when no assignee pattern matches', () => {
    assert.equal(extractAssignee('The weather is nice today', 'Alice', 'en'), null);
  });

  it('returns null for empty text', () => {
    assert.equal(extractAssignee('', 'Alice', 'en'), null);
  });
});

describe('isCommonWord', () => {
  it('identifies English common words', () => {
    assert.equal(isCommonWord('we', 'en'), true);
    assert.equal(isCommonWord('someone', 'en'), true);
  });

  it('identifies Korean common words', () => {
    assert.equal(isCommonWord('우리', 'ko'), true);
    assert.equal(isCommonWord('모두', 'ko'), true);
  });

  it('does not flag real names as common', () => {
    assert.equal(isCommonWord('Alice', 'en'), false);
    assert.equal(isCommonWord('김철수', 'ko'), false);
  });
});

describe('extractDecisions', () => {
  it('detects Korean decisions with 결정 pattern', () => {
    const transcript = [
      makeEntry({ text: '새로운 API 버전으로 결정했습니다', speaker: 0, start: 10 }),
      makeEntry({ text: '네 알겠습니다', speaker: 1, start: 15 }),
    ];
    const items = extractDecisions(transcript, new Map([[0, 'Boss']]), 'ko');
    assert.ok(items.length >= 1, `Expected at least 1 decision, got ${items.length}`);
    assert.ok(items[0].text.includes('결정'));
    assert.equal(items[0].speaker, 'Boss');
  });

  it('detects Korean decisions with 합의 pattern', () => {
    const transcript = [
      makeEntry({ text: '이 방안으로 합의했습니다', speaker: 0, start: 10 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'ko');
    assert.ok(items.length >= 1);
    assert.ok(items[0].text.includes('합의'));
  });

  it('detects Korean decisions with 하기로 했습니다 pattern', () => {
    const transcript = [
      makeEntry({ text: '다음 주부터 새 프로세스를 적용하기로 했습니다', speaker: 0, start: 10 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'ko');
    assert.ok(items.length >= 1);
    assert.ok(items[0].text.includes('하기로'));
  });

  it('detects Korean decisions with 결론 pattern', () => {
    const transcript = [
      makeEntry({ text: '결론적으로 A안을 채택하겠습니다', speaker: 0, start: 10 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'ko');
    assert.ok(items.length >= 1);
  });

  it('detects Korean decisions with 진행 pattern', () => {
    const transcript = [
      makeEntry({ text: 'B 방식으로 진행하겠습니다', speaker: 0, start: 10 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'ko');
    assert.ok(items.length >= 1);
    assert.ok(items[0].text.includes('진행'));
  });

  it('detects English decisions with "decided" pattern', () => {
    const transcript = [
      makeEntry({ text: 'We decided to use the new framework', speaker: 0, start: 5 }),
      makeEntry({ text: 'Sounds good', speaker: 1, start: 10 }),
    ];
    const items = extractDecisions(transcript, new Map([[0, 'Alice']]), 'en');
    assert.ok(items.length >= 1, `Expected at least 1 decision, got ${items.length}`);
    assert.equal(items[0].speaker, 'Alice');
  });

  it('detects English decisions with "go with" pattern', () => {
    const transcript = [
      makeEntry({ text: "Let's go with option B for the deployment", speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
  });

  it('detects English decisions with "agreed" pattern', () => {
    const transcript = [
      makeEntry({ text: 'We agreed to postpone the release by one week', speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
  });

  it('detects English decisions with "consensus" pattern', () => {
    const transcript = [
      makeEntry({ text: 'The consensus is to migrate to the cloud platform', speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
  });

  it('detects English decisions with "we will proceed with" pattern', () => {
    const transcript = [
      makeEntry({ text: 'We will proceed with the microservices architecture', speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
  });

  it('detects English decisions with "final decision" pattern', () => {
    const transcript = [
      makeEntry({ text: 'Final decision: we launch on March 15th', speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
  });

  it('skips non-final entries', () => {
    const transcript = [
      makeEntry({ text: 'We decided to use React', speaker: 0, isFinal: false }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.equal(items.length, 0);
  });

  it('skips very short utterances', () => {
    const transcript = [
      makeEntry({ text: 'yes', speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.equal(items.length, 0);
  });

  it('deduplicates decisions', () => {
    const transcript = [
      makeEntry({ text: 'We decided to use the new framework', speaker: 0, start: 5 }),
      makeEntry({ text: 'we decided to use the new framework', speaker: 0, start: 10 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.equal(items.length, 1);
  });

  it('respects maxItems limit', () => {
    const transcript = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ text: `We decided to do task ${i}`, speaker: 0, start: i * 5, isFinal: true })
    );
    const items = extractDecisions(transcript, new Map(), 'en', 3);
    assert.ok(items.length <= 3);
  });

  it('returns empty array for empty transcript', () => {
    assert.deepEqual(extractDecisions([], new Map(), 'ko'), []);
  });

  it('Korean mode also detects English decision patterns', () => {
    const transcript = [
      makeEntry({ text: 'We decided to use Kubernetes', speaker: 0, start: 5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'ko');
    assert.ok(items.length >= 1, 'Korean mode should also detect English decisions');
  });

  it('includes timestamp in extracted decisions', () => {
    const transcript = [
      makeEntry({ text: 'We agreed to start next Monday', speaker: 0, start: 42.5 }),
    ];
    const items = extractDecisions(transcript, new Map(), 'en');
    assert.ok(items.length >= 1);
    assert.equal(items[0].timestamp, 42.5);
  });
});

describe('extractKeyPoints', () => {
  it('extracts key points from transcript', () => {
    const transcript = makeSampleTranscript();
    const points = extractKeyPoints(transcript, new Map(), 'ko', 3);
    assert.ok(points.length > 0);
    assert.ok(points.length <= 3);
    assert.ok(points[0].topic);
    assert.ok(points[0].speakers.length > 0);
  });

  it('returns empty for empty transcript', () => {
    assert.deepEqual(extractKeyPoints([], new Map(), 'ko'), []);
  });

  it('handles transcript with no final entries', () => {
    const transcript = [makeEntry({ isFinal: false })];
    assert.deepEqual(extractKeyPoints(transcript, new Map(), 'ko'), []);
  });
});

describe('truncateText', () => {
  it('returns text unchanged if within limit', () => {
    assert.equal(truncateText('short', 10), 'short');
  });

  it('truncates with ellipsis when over limit', () => {
    const result = truncateText('this is a very long sentence', 15);
    assert.ok(result.endsWith('...'));
    assert.ok(result.length <= 15);
  });

  it('handles exact boundary', () => {
    assert.equal(truncateText('hello', 5), 'hello');
  });
});

describe('extractTopTopics', () => {
  it('extracts repeated words from Korean transcript', () => {
    const transcript = makeSampleTranscript();
    const topics = extractTopTopics(transcript, 'ko', 5);
    assert.ok(Array.isArray(topics));
    // Should find some repeated terms from the sample transcript
  });

  it('extracts repeated words from English transcript', () => {
    const transcript = [
      makeEntry({ text: 'We need to update the API documentation', speaker: 0, start: 0, end: 3 }),
      makeEntry({ text: 'The API is slow and needs optimization', speaker: 1, start: 4, end: 7 }),
      makeEntry({ text: 'I will fix the API performance issue', speaker: 0, start: 8, end: 11 }),
      makeEntry({ text: 'The documentation also needs review', speaker: 1, start: 12, end: 15 }),
      makeEntry({ text: 'Let me update the API docs by Friday', speaker: 0, start: 16, end: 19 }),
    ];
    const topics = extractTopTopics(transcript, 'en', 5);
    assert.ok(topics.length > 0);
    // 'api' should be a top topic since it appears in most utterances
    assert.ok(topics.some(t => t.includes('api')), `Expected 'api' in topics: ${topics}`);
  });

  it('returns empty array for empty transcript', () => {
    assert.deepEqual(extractTopTopics([], 'ko'), []);
  });

  it('returns empty for transcript with no final entries', () => {
    const transcript = [makeEntry({ text: 'hello world', isFinal: false })];
    assert.deepEqual(extractTopTopics(transcript, 'en'), []);
  });

  it('filters out stop words', () => {
    const transcript = [
      makeEntry({ text: 'the the the is is are', speaker: 0, start: 0, end: 2 }),
      makeEntry({ text: 'the the the is is are', speaker: 0, start: 3, end: 5 }),
    ];
    const topics = extractTopTopics(transcript, 'en', 5);
    assert.ok(!topics.includes('the'));
    assert.ok(!topics.includes('is'));
  });

  it('respects topN limit', () => {
    const transcript = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ text: `topic${i} topic${i} keyword${i} keyword${i}`, speaker: 0, start: i * 3, end: i * 3 + 2 })
    );
    const topics = extractTopTopics(transcript, 'en', 3);
    assert.ok(topics.length <= 3);
  });
});

describe('extractMeetingPhases', () => {
  it('extracts opening and closing from transcript', () => {
    const transcript = makeSampleTranscript();
    const speakerMap = new Map([[0, '김철수'], [1, '이영희'], [2, '박민수']]);
    const phases = extractMeetingPhases(transcript, speakerMap);

    assert.ok(phases.opening !== null, 'Should have opening');
    assert.ok(phases.closing !== null, 'Should have closing');
    assert.ok(phases.opening.includes('김철수'), 'Opening should include first speaker name');
  });

  it('returns nulls for empty transcript', () => {
    const phases = extractMeetingPhases([], new Map());
    assert.equal(phases.opening, null);
    assert.equal(phases.closing, null);
  });

  it('returns null closing if only one entry', () => {
    const transcript = [makeEntry({ text: 'Only one statement here', speaker: 0, start: 0, end: 3 })];
    const phases = extractMeetingPhases(transcript, new Map([[0, 'Alice']]));
    assert.ok(phases.opening !== null);
    assert.equal(phases.closing, null); // same entry as opening, so null
  });
});

describe('computeSpeakerContributions', () => {
  it('computes percentage contributions', () => {
    const attendees = [
      { name: 'Alice', utteranceCount: 6 },
      { name: 'Bob', utteranceCount: 4 },
    ];
    const contributions = computeSpeakerContributions(attendees);
    assert.equal(contributions.length, 2);
    assert.equal(contributions[0].name, 'Alice');
    assert.equal(contributions[0].percentage, 60);
    assert.equal(contributions[1].percentage, 40);
  });

  it('handles single participant', () => {
    const attendees = [{ name: 'Solo', utteranceCount: 10 }];
    const contributions = computeSpeakerContributions(attendees);
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0].percentage, 100);
  });

  it('returns empty for empty attendees', () => {
    assert.deepEqual(computeSpeakerContributions([]), []);
  });

  it('returns empty when all counts are zero', () => {
    const attendees = [{ name: 'A', utteranceCount: 0 }];
    assert.deepEqual(computeSpeakerContributions(attendees), []);
  });
});

describe('generateSummary', () => {
  it('generates Korean summary with stats', () => {
    const transcript = makeSampleTranscript();
    const attendees = extractAttendees(transcript);
    const summary = generateSummary(transcript, attendees, 600, 'ko');
    assert.ok(summary.includes('회의 시간'));
    assert.ok(summary.includes('10m 00s'));
  });

  it('generates English summary with stats', () => {
    const transcript = makeSampleTranscript();
    const attendees = extractAttendees(transcript);
    const summary = generateSummary(transcript, attendees, 600, 'en');
    assert.ok(summary.includes('Meeting lasted'));
    assert.ok(summary.includes('10m 00s'));
  });

  it('includes topic keywords for substantial transcripts', () => {
    const transcript = makeSampleTranscript();
    const attendees = extractAttendees(transcript);
    const speakerMap = new Map([[0, '김철수'], [1, '이영희'], [2, '박민수']]);
    const summary = generateSummary(transcript, attendees, 600, 'ko', speakerMap);
    // Should contain topic section for 10-entry transcript
    assert.ok(summary.includes('주요 주제'), 'Korean summary should include topics label');
  });

  it('includes speaker contributions for multi-participant meetings', () => {
    const transcript = makeSampleTranscript();
    const attendees = extractAttendees(transcript);
    const summary = generateSummary(transcript, attendees, 600, 'ko');
    assert.ok(summary.includes('참여도'), 'Should include participation breakdown');
    assert.ok(summary.includes('%'), 'Should include percentage');
  });

  it('includes opening/closing context', () => {
    const transcript = makeSampleTranscript();
    const attendees = extractAttendees(transcript);
    const speakerMap = new Map([[0, '김철수'], [1, '이영희'], [2, '박민수']]);
    const summary = generateSummary(transcript, attendees, 600, 'ko', speakerMap);
    assert.ok(summary.includes('시작'), 'Should include opening label');
    assert.ok(summary.includes('마무리'), 'Should include closing label');
  });

  it('returns stats-only for very short transcripts (< 3 entries)', () => {
    const transcript = [
      makeEntry({ text: 'Hi', speaker: 0, start: 0, end: 1 }),
      makeEntry({ text: 'Bye', speaker: 1, start: 2, end: 3 }),
    ];
    const attendees = extractAttendees(transcript);
    const summary = generateSummary(transcript, attendees, 10, 'en');
    // Should just be the stats line, no topics/contributions
    assert.ok(summary.includes('Meeting lasted'));
    assert.ok(!summary.includes('Main topics'));
  });

  it('English summary includes English labels', () => {
    const transcript = [
      makeEntry({ text: 'We need to discuss the API changes', speaker: 0, start: 0, end: 3 }),
      makeEntry({ text: 'The API changes affect our deployment pipeline', speaker: 1, start: 4, end: 7 }),
      makeEntry({ text: 'Let me review the API documentation first', speaker: 0, start: 8, end: 11 }),
      makeEntry({ text: 'Good point about the deployment pipeline', speaker: 1, start: 12, end: 15 }),
      makeEntry({ text: 'I will update the API endpoints by tomorrow', speaker: 0, start: 16, end: 19 }),
    ];
    const attendees = extractAttendees(transcript);
    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob']]);
    const summary = generateSummary(transcript, attendees, 120, 'en', speakerMap);
    assert.ok(summary.includes('Main topics'), 'English should use "Main topics"');
    assert.ok(summary.includes('Participation'), 'English should use "Participation"');
  });
});

describe('formatTranscript', () => {
  it('formats transcript with timestamps and speaker names', () => {
    const transcript = [
      makeEntry({ text: 'Hello', speaker: 0, start: 0, end: 2 }),
      makeEntry({ text: 'Hi there', speaker: 1, start: 3, end: 5 }),
    ];
    const map = new Map([[0, 'Alice'], [1, 'Bob']]);
    const output = formatTranscript(transcript, map, { ...DEFAULT_OPTIONS });
    assert.ok(output.includes('**Alice**'));
    assert.ok(output.includes('**Bob**'));
    assert.ok(output.includes('> Hello'));
    assert.ok(output.includes('[00:00]'));
  });

  it('groups consecutive same-speaker utterances', () => {
    const transcript = [
      makeEntry({ text: 'First thing', speaker: 0, start: 0, end: 2 }),
      makeEntry({ text: 'Second thing', speaker: 0, start: 3, end: 5 }),
    ];
    const output = formatTranscript(transcript, new Map(), { ...DEFAULT_OPTIONS });
    // Should only have one speaker header
    const speakerHeaders = output.match(/\*\*Speaker 0\*\*/g);
    assert.equal(speakerHeaders.length, 1);
  });

  it('skips non-final entries', () => {
    const transcript = [
      makeEntry({ text: 'Final text', speaker: 0, isFinal: true }),
      makeEntry({ text: 'Interim text', speaker: 0, isFinal: false }),
    ];
    const output = formatTranscript(transcript, new Map(), { ...DEFAULT_OPTIONS });
    assert.ok(output.includes('Final text'));
    assert.ok(!output.includes('Interim text'));
  });

  it('returns placeholder for empty transcript', () => {
    const output = formatTranscript([], new Map(), { ...DEFAULT_OPTIONS });
    assert.ok(output.includes('No transcript'));
  });
});

// --- Integration tests ---

describe('formatMeetingMinutes', () => {
  it('generates complete meeting minutes with all sections', () => {
    const transcript = makeSampleTranscript();
    const metadata = makeMetadata();
    const output = formatMeetingMinutes(transcript, metadata);

    // Check all required sections
    assert.ok(output.includes('# 회의록'), 'Has title');
    assert.ok(output.includes('## 참석자'), 'Has attendees section');
    assert.ok(output.includes('## 요약'), 'Has summary section');
    assert.ok(output.includes('## 주요 논의 사항'), 'Has key points section');
    assert.ok(output.includes('## 결정 사항'), 'Has decisions section');
    assert.ok(output.includes('## 액션 아이템'), 'Has action items section');
    assert.ok(output.includes('## 전체 녹취록'), 'Has transcript section');

    // Check metadata
    assert.ok(output.includes('2026-04-03'), 'Has date');
    assert.ok(output.includes('Test Server'), 'Has server name');
    assert.ok(output.includes('general-voice'), 'Has channel name');
    assert.ok(output.includes('TestUser'), 'Has started by');

    // Check attendees resolved
    assert.ok(output.includes('김철수'), 'Has speaker name');
    assert.ok(output.includes('이영희'), 'Has speaker name');
    assert.ok(output.includes('박민수'), 'Has speaker name');

    // Check footer
    assert.ok(output.includes('Generated by dicoclerk'), 'Has footer');

    // Check action items include assignee/deadline metadata when present
    // The sample transcript has "다음 주까지 보고서 준비해 주세요" which should have a deadline
    if (output.includes('다음 주까지')) {
      assert.ok(output.includes('기한'), 'Action items should render deadline label for Korean');
    }
  });

  it('generates English minutes when language=en', () => {
    const transcript = [
      makeEntry({ text: 'Let us begin the meeting', speaker: 0, start: 0, end: 3 }),
      makeEntry({ text: 'We need to review the proposal', speaker: 1, start: 4, end: 8 }),
    ];
    const metadata = makeMetadata({ language: 'en', speakerMap: new Map([[0, 'Alice'], [1, 'Bob']]) });
    const output = formatMeetingMinutes(transcript, metadata);

    assert.ok(output.includes('# Meeting Minutes'));
    assert.ok(output.includes('## Attendees'));
    assert.ok(output.includes('## Summary'));
    assert.ok(output.includes('## Key Discussion Points'));
    assert.ok(output.includes('## Decisions'));
    assert.ok(output.includes('## Action Items'));
    assert.ok(output.includes('## Full Transcript'));
  });

  it('handles empty transcript gracefully', () => {
    const output = formatMeetingMinutes([], makeMetadata());
    assert.ok(output.includes('# 회의록'));
    assert.ok(output.includes('참석자가 감지되지 않았습니다'));
  });

  it('respects includeTranscript=false', () => {
    const output = formatMeetingMinutes(makeSampleTranscript(), makeMetadata(), {
      includeTranscript: false,
    });
    assert.ok(!output.includes('## 전체 녹취록'));
  });

  it('supports custom title', () => {
    const output = formatMeetingMinutes([], makeMetadata(), { title: 'Sprint Planning' });
    assert.ok(output.includes('# Sprint Planning'));
  });

  it('wraps transcript in collapsible details tag', () => {
    const output = formatMeetingMinutes(makeSampleTranscript(), makeMetadata());
    assert.ok(output.includes('<details>'));
    assert.ok(output.includes('</details>'));
  });

  it('uses default metadata when fields are missing', () => {
    const output = formatMeetingMinutes([makeEntry()], {});
    assert.ok(output.includes('Unknown Server'));
    assert.ok(output.includes('Unknown Channel'));
  });
});

describe('generateMinutesFilename', () => {
  it('generates filename with date and channel', () => {
    const metadata = makeMetadata();
    const filename = generateMinutesFilename(metadata);
    assert.ok(filename.startsWith('minutes_2026-04-03_'));
    assert.ok(filename.includes('general-voice'));
    assert.ok(filename.endsWith('.md'));
  });

  it('sanitizes channel name', () => {
    const metadata = makeMetadata({ channelName: 'voice/channel #1 @test' });
    const filename = generateMinutesFilename(metadata);
    assert.ok(!filename.includes('/'));
    assert.ok(!filename.includes('#'));
    assert.ok(!filename.includes('@'));
  });

  it('handles missing metadata', () => {
    const filename = generateMinutesFilename({});
    assert.ok(filename.startsWith('minutes_'));
    assert.ok(filename.includes('meeting'));
    assert.ok(filename.endsWith('.md'));
  });
});
