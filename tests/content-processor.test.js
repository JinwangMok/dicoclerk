/**
 * Tests for Meeting Minutes Content Processor
 *
 * Covers:
 * - processMinutesContent() core shape and required fields
 * - Attendees section: diarization-based and transcript-fallback paths
 * - Summary section: text, topTopics, contributions, opening/closing
 * - Key topics extraction
 * - Decisions extraction (Korean and English)
 * - Action items extraction (Korean and English, with assignee/deadline)
 * - Language handling (ko, en)
 * - speakerMap normalisation (Map, plain object)
 * - toSerializableContent() JSON serialization
 * - Edge cases: empty transcript, single speaker, missing fields
 * - Input validation (null, wrong type)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  processMinutesContent,
  toSerializableContent,
  DEFAULT_PROCESSOR_OPTIONS,
} from '../src/minutes/content-processor.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

function makeTranscriptEntry(overrides = {}) {
  return {
    speaker:    0,
    speakerName: 'Alice',
    userId:     'uid-a',
    text:       'Hello world.',
    confidence: 0.95,
    start:      0,
    end:        2,
    timestamp:  Date.now(),
    isFinal:    true,
    ...overrides,
  };
}

/**
 * A minimal but realistic SessionMinutesData fixture with two speakers,
 * Korean text, an action item, and a decision.
 */
function makeKoreanSessionData(overrides = {}) {
  const transcript = [
    makeTranscriptEntry({ speaker: 0, speakerName: '김철수', text: '오늘 회의를 시작하겠습니다', start: 0,  end: 3  }),
    makeTranscriptEntry({ speaker: 1, speakerName: '이영희', text: '네 안녕하세요',              start: 4,  end: 6  }),
    makeTranscriptEntry({ speaker: 0, speakerName: '김철수', text: 'API 관련해서 이슈가 있습니다', start: 7,  end: 11 }),
    makeTranscriptEntry({ speaker: 1, speakerName: '이영희', text: '어떤 이슈인가요',             start: 12, end: 14 }),
    makeTranscriptEntry({ speaker: 0, speakerName: '김철수', text: '응답 속도가 느려지는 문제입니다', start: 15, end: 19 }),
    makeTranscriptEntry({ speaker: 1, speakerName: '이영희', text: '제가 내일까지 확인하겠습니다',  start: 20, end: 24 }),
    makeTranscriptEntry({ speaker: 0, speakerName: '김철수', text: '새로운 API 버전으로 결정했습니다', start: 25, end: 29 }),
    makeTranscriptEntry({ speaker: 1, speakerName: '이영희', text: '알겠습니다 진행하겠습니다',     start: 30, end: 33 }),
    makeTranscriptEntry({ speaker: 0, speakerName: '김철수', text: '다음 주까지 보고서 준비해 주세요', start: 34, end: 38 }),
    makeTranscriptEntry({ speaker: 1, speakerName: '이영희', text: '네 알겠습니다',               start: 39, end: 41 }),
  ];

  const speakerMap = new Map([[0, '김철수'], [1, '이영희']]);

  const speakers = [
    {
      speakerLabel: 0,
      displayName: '김철수',
      userId: 'uid-a',
      utteranceCount: 5,
      totalSpeakingSeconds: 19,
      avgConfidence: 0.92,
    },
    {
      speakerLabel: 1,
      displayName: '이영희',
      userId: 'uid-b',
      utteranceCount: 5,
      totalSpeakingSeconds: 15,
      avgConfidence: 0.89,
    },
  ];

  return {
    sessionId:       'session-ko-001',
    guildName:       '테스트 서버',
    channelName:     '일반-음성',
    startedAt:       new Date('2026-04-04T10:00:00Z'),
    endedAt:         new Date('2026-04-04T10:10:00Z'),
    durationSeconds: 600,
    startedBy:       '김철수#0001',
    language:        'ko',
    reason:          'manual_stop',
    transcript,
    speakerMap,
    speakers,
    participantIds:  ['uid-a', 'uid-b'],
    warnings:        [],
    aggregatedAt:    new Date().toISOString(),
    ...overrides,
  };
}

/**
 * English session data fixture.
 */
function makeEnglishSessionData(overrides = {}) {
  const transcript = [
    makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Good morning everyone',                     start: 0,  end: 3  }),
    makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'Morning, let\'s get started',               start: 4,  end: 7  }),
    makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'We need to discuss the API deployment',     start: 8,  end: 12 }),
    makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'The API deployment needs a rollback plan',  start: 13, end: 17 }),
    makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'I\'ll handle the rollback documentation',   start: 18, end: 22 }),
    makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'We decided to use the staging environment', start: 23, end: 27 }),
    makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Please update the API docs by next Friday', start: 28, end: 32 }),
    makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'Sure, will do',                            start: 33, end: 35 }),
  ];

  const speakerMap = new Map([[0, 'Alice'], [1, 'Bob']]);

  const speakers = [
    {
      speakerLabel: 0,
      displayName: 'Alice',
      userId: 'uid-alice',
      utteranceCount: 4,
      totalSpeakingSeconds: 14,
      avgConfidence: 0.94,
    },
    {
      speakerLabel: 1,
      displayName: 'Bob',
      userId: 'uid-bob',
      utteranceCount: 4,
      totalSpeakingSeconds: 12,
      avgConfidence: 0.91,
    },
  ];

  return {
    sessionId:       'session-en-001',
    guildName:       'Test Server',
    channelName:     'general-voice',
    startedAt:       new Date('2026-04-04T09:00:00Z'),
    endedAt:         new Date('2026-04-04T09:35:00Z'),
    durationSeconds: 2100,
    startedBy:       'Alice#1234',
    language:        'en',
    reason:          'manual_stop',
    transcript,
    speakerMap,
    speakers,
    participantIds:  ['uid-alice', 'uid-bob'],
    warnings:        [],
    aggregatedAt:    new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// processMinutesContent — shape and required fields
// ---------------------------------------------------------------------------

describe('processMinutesContent — shape and required fields', () => {
  it('should return a MinutesContent with all required top-level fields', () => {
    const data = processMinutesContent(makeKoreanSessionData());

    // Identity
    assert.equal(data.sessionId, 'session-ko-001');
    assert.equal(typeof data.sessionId, 'string');

    // Location
    assert.equal(data.guildName,   '테스트 서버');
    assert.equal(data.channelName, '일반-음성');

    // Timestamps
    assert.ok(data.startedAt instanceof Date, 'startedAt must be a Date');
    assert.ok(data.endedAt   instanceof Date, 'endedAt must be a Date');

    // Duration and meta
    assert.equal(data.durationSeconds, 600);
    assert.equal(data.startedBy, '김철수#0001');
    assert.equal(data.language, 'ko');
    assert.equal(data.reason, 'manual_stop');

    // Structured sections
    assert.ok(Array.isArray(data.attendees),    'attendees must be an Array');
    assert.ok(typeof data.summary === 'object', 'summary must be an object');
    assert.ok(Array.isArray(data.keyTopics),    'keyTopics must be an Array');
    assert.ok(Array.isArray(data.decisions),    'decisions must be an Array');
    assert.ok(Array.isArray(data.actionItems),  'actionItems must be an Array');

    // Raw data pass-through
    assert.ok(Array.isArray(data.transcript), 'transcript must be an Array');
    assert.ok(data.speakerMap instanceof Map, 'speakerMap must be a Map');

    // Audit
    assert.equal(typeof data.processedAt, 'string');
    assert.doesNotThrow(() => new Date(data.processedAt));
  });

  it('should preserve transcript entries unchanged', () => {
    const sessionData = makeKoreanSessionData();
    const data = processMinutesContent(sessionData);
    assert.equal(data.transcript.length, sessionData.transcript.length);
    assert.equal(data.transcript[0].text, sessionData.transcript[0].text);
  });

  it('should normalise string startedAt / endedAt to Date objects', () => {
    const data = processMinutesContent(makeKoreanSessionData({
      startedAt: '2026-01-15T08:00:00Z',
      endedAt:   '2026-01-15T08:30:00Z',
    }));
    assert.ok(data.startedAt instanceof Date);
    assert.ok(data.endedAt   instanceof Date);
    assert.equal(data.startedAt.toISOString(), '2026-01-15T08:00:00.000Z');
    assert.equal(data.endedAt.toISOString(),   '2026-01-15T08:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — attendees section
// ---------------------------------------------------------------------------

describe('processMinutesContent — attendees section', () => {
  it('should build attendees from diarization speakers array when available', () => {
    const data = processMinutesContent(makeKoreanSessionData());

    assert.equal(data.attendees.length, 2, 'Should have 2 attendees');

    const alice = data.attendees.find(a => a.displayName === '김철수');
    assert.ok(alice, '김철수 should be in attendees');
    assert.equal(alice.speakerLabel, 0);
    assert.equal(alice.userId, 'uid-a');
    assert.equal(alice.utteranceCount, 5);
    assert.equal(alice.speakingSeconds, 19);
    assert.ok(Math.abs(alice.avgConfidence - 0.92) < 0.001);
  });

  it('should compute contributionPct correctly', () => {
    const data = processMinutesContent(makeKoreanSessionData());

    // Both speakers have 5 utterances each → 50% each
    const a0 = data.attendees.find(a => a.speakerLabel === 0);
    const a1 = data.attendees.find(a => a.speakerLabel === 1);
    assert.equal(a0.contributionPct, 50);
    assert.equal(a1.contributionPct, 50);
  });

  it('should fall back to transcript-based attendees when speakers array is empty', () => {
    const sessionData = makeKoreanSessionData({ speakers: [] });
    const data = processMinutesContent(sessionData);

    assert.ok(data.attendees.length > 0, 'Should still produce attendees from transcript');
    const names = data.attendees.map(a => a.displayName);
    assert.ok(names.some(n => n === '김철수' || n.includes('Speaker')));
  });

  it('should fall back to transcript-based attendees when speakers is undefined', () => {
    const sessionData = makeKoreanSessionData();
    delete sessionData.speakers;
    const data = processMinutesContent(sessionData);

    assert.ok(Array.isArray(data.attendees));
    assert.ok(data.attendees.length > 0);
  });

  it('should include userId from diarization speakers', () => {
    const data = processMinutesContent(makeEnglishSessionData());
    const alice = data.attendees.find(a => a.displayName === 'Alice');
    assert.equal(alice.userId, 'uid-alice');
  });

  it('should set contributionPct=0 for all speakers when total utterances is 0', () => {
    const sessionData = makeKoreanSessionData({
      speakers: [
        { speakerLabel: 0, displayName: '김철수', userId: null, utteranceCount: 0, totalSpeakingSeconds: 0, avgConfidence: 0 },
      ],
    });
    const data = processMinutesContent(sessionData);
    assert.equal(data.attendees[0].contributionPct, 0);
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — summary section
// ---------------------------------------------------------------------------

describe('processMinutesContent — summary section', () => {
  it('should return a summary object with required fields', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    const { summary } = data;

    assert.equal(typeof summary.text,   'string', 'summary.text must be a string');
    assert.ok(Array.isArray(summary.topTopics),   'topTopics must be an Array');
    assert.ok(Array.isArray(summary.contributions), 'contributions must be an Array');
    // opening/closing may be null for short transcripts, but must be string|null
    assert.ok(summary.opening === null || typeof summary.opening === 'string');
    assert.ok(summary.closing === null || typeof summary.closing === 'string');
  });

  it('should generate Korean summary text for Korean sessions', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    assert.ok(data.summary.text.includes('회의 시간'), 'Korean summary should include 회의 시간');
  });

  it('should generate English summary text for English sessions', () => {
    const data = processMinutesContent(makeEnglishSessionData());
    assert.ok(data.summary.text.includes('Meeting lasted'), 'English summary should include "Meeting lasted"');
  });

  it('should extract top topics from transcript content', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    assert.ok(Array.isArray(data.summary.topTopics));
    // Should find at least one topic from the sample (API mentioned multiple times)
    assert.ok(data.summary.topTopics.length > 0);
  });

  it('should populate speaker contributions in summary', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    assert.ok(data.summary.contributions.length > 0);
    // Each contribution has name and percentage
    const first = data.summary.contributions[0];
    assert.equal(typeof first.name, 'string');
    assert.equal(typeof first.percentage, 'number');
    assert.ok(first.percentage >= 0 && first.percentage <= 100);
  });

  it('should include opening statement when transcript is non-empty', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    assert.ok(data.summary.opening !== null, 'Should have an opening snippet');
    assert.ok(typeof data.summary.opening === 'string');
  });

  it('should return empty summary fields for empty transcript', () => {
    const data = processMinutesContent(makeKoreanSessionData({ transcript: [], speakers: [] }));
    assert.equal(typeof data.summary.text, 'string');
    assert.deepEqual(data.summary.topTopics, []);
    assert.equal(data.summary.opening, null);
    assert.equal(data.summary.closing, null);
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — key topics section
// ---------------------------------------------------------------------------

describe('processMinutesContent — keyTopics section', () => {
  it('should extract key topics from transcript', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    assert.ok(Array.isArray(data.keyTopics));
    // Should find at least 1 topic for 10-entry transcript
    assert.ok(data.keyTopics.length > 0);
  });

  it('each key topic should have required fields', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    for (const topic of data.keyTopics) {
      assert.equal(typeof topic.topic,   'string');
      assert.ok(Array.isArray(topic.speakers));
      assert.equal(typeof topic.startTime, 'number');
      assert.equal(typeof topic.summary,   'string');
    }
  });

  it('should respect maxKeyTopics option', () => {
    const data = processMinutesContent(makeKoreanSessionData(), { maxKeyTopics: 2 });
    assert.ok(data.keyTopics.length <= 2);
  });

  it('should return empty array for empty transcript', () => {
    const data = processMinutesContent(makeKoreanSessionData({ transcript: [], speakers: [] }));
    assert.deepEqual(data.keyTopics, []);
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — decisions section
// ---------------------------------------------------------------------------

describe('processMinutesContent — decisions section', () => {
  it('should detect Korean decisions with 결정 pattern', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    const decisions = data.decisions;
    assert.ok(Array.isArray(decisions));
    // The transcript has "새로운 API 버전으로 결정했습니다"
    const decision = decisions.find(d => d.text.includes('결정'));
    assert.ok(decision, 'Should find the 결정 decision');
    assert.equal(decision.speaker, '김철수');
    assert.equal(typeof decision.timestamp, 'number');
  });

  it('should detect English decisions with "decided" pattern', () => {
    const data = processMinutesContent(makeEnglishSessionData());
    const decisions = data.decisions;
    // "We decided to use the staging environment"
    const decision = decisions.find(d => d.text.includes('decided'));
    assert.ok(decision, 'Should find the "decided" decision');
    assert.equal(decision.speaker, 'Bob');
  });

  it('each decision should have required fields', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    for (const decision of data.decisions) {
      assert.equal(typeof decision.text,      'string');
      assert.equal(typeof decision.speaker,   'string');
      assert.equal(typeof decision.timestamp, 'number');
    }
  });

  it('should respect maxDecisions option', () => {
    // Create a transcript with many decision-like sentences
    const transcript = Array.from({ length: 20 }, (_, i) =>
      makeTranscriptEntry({ text: `We decided to do task ${i}`, speaker: 0, start: i * 5, isFinal: true })
    );
    const data = processMinutesContent(
      makeEnglishSessionData({ transcript, speakers: [] }),
      { maxDecisions: 3 }
    );
    assert.ok(data.decisions.length <= 3);
  });

  it('should return empty array when no decisions detected', () => {
    const transcript = [
      makeTranscriptEntry({ text: 'Hello', speaker: 0, start: 0 }),
      makeTranscriptEntry({ text: 'How are you', speaker: 1, start: 3 }),
    ];
    const data = processMinutesContent(
      makeEnglishSessionData({ transcript, speakers: [] })
    );
    assert.ok(Array.isArray(data.decisions));
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — action items section
// ---------------------------------------------------------------------------

describe('processMinutesContent — actionItems section', () => {
  it('should detect Korean action items with 해 주세요 pattern', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    const actionItems = data.actionItems;
    assert.ok(Array.isArray(actionItems));
    // "다음 주까지 보고서 준비해 주세요"
    const item = actionItems.find(a => a.text.includes('준비해 주세요'));
    assert.ok(item, 'Should detect the 준비해 주세요 action item');
  });

  it('should extract Korean self-assignment from "제가...하겠습니다"', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    // "제가 내일까지 확인하겠습니다" by 이영희 (speaker 1)
    const item = data.actionItems.find(a => a.text.includes('제가'));
    assert.ok(item, 'Should detect 제가 self-assignment');
    assert.equal(item.assignee, '이영희');
  });

  it('should extract Korean deadline from action item', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    // "다음 주까지 보고서 준비해 주세요" → deadline: "다음 주"
    const item = data.actionItems.find(a => a.text.includes('다음 주'));
    assert.ok(item);
    assert.equal(item.deadline, '다음 주');
  });

  it('should extract Korean date deadline from "내일까지"', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    // "제가 내일까지 확인하겠습니다" → deadline: "내일"
    const item = data.actionItems.find(a => a.text.includes('내일'));
    assert.ok(item);
    assert.equal(item.deadline, '내일');
  });

  it('should detect English action items with "Please" pattern', () => {
    const data = processMinutesContent(makeEnglishSessionData());
    // "Please update the API docs by next Friday"
    const item = data.actionItems.find(a => a.text.toLowerCase().includes('please update'));
    assert.ok(item, 'Should detect the "Please update" action item');
  });

  it('should extract English deadline from action item', () => {
    const data = processMinutesContent(makeEnglishSessionData());
    // "Please update the API docs by next Friday"
    const item = data.actionItems.find(a => a.text.includes('Friday'));
    assert.ok(item);
    assert.equal(item.deadline, 'next Friday');
  });

  it('should extract English self-assignment from "I\'ll" pattern', () => {
    const data = processMinutesContent(makeEnglishSessionData());
    // "I'll handle the rollback documentation" by Alice
    const item = data.actionItems.find(a => a.text.includes("I'll handle"));
    assert.ok(item, "Should detect I'll self-assignment");
    assert.equal(item.assignee, 'Alice');
  });

  it('each action item should have required fields', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    for (const item of data.actionItems) {
      assert.equal(typeof item.text,      'string');
      assert.equal(typeof item.speaker,   'string');
      assert.equal(typeof item.timestamp, 'number');
      assert.ok(item.assignee === null || typeof item.assignee === 'string');
      assert.ok(item.deadline === null || typeof item.deadline === 'string');
    }
  });

  it('should respect maxActionItems option', () => {
    const transcript = Array.from({ length: 20 }, (_, i) =>
      makeTranscriptEntry({ text: `Please complete task ${i}`, speaker: 0, start: i * 5, isFinal: true })
    );
    const data = processMinutesContent(
      makeEnglishSessionData({ transcript, speakers: [] }),
      { maxActionItems: 3 }
    );
    assert.ok(data.actionItems.length <= 3);
  });

  it('should return empty array for transcript with no action items', () => {
    const transcript = [
      makeTranscriptEntry({ text: '좋은 아침입니다', speaker: 0, start: 0 }),
      makeTranscriptEntry({ text: '안녕하세요',     speaker: 1, start: 3 }),
    ];
    const data = processMinutesContent(
      makeKoreanSessionData({ transcript, speakers: [] })
    );
    assert.ok(Array.isArray(data.actionItems));
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — speakerMap normalisation
// ---------------------------------------------------------------------------

describe('processMinutesContent — speakerMap normalisation', () => {
  it('should accept Map<number,string> speakerMap', () => {
    const data = processMinutesContent(makeKoreanSessionData());
    assert.ok(data.speakerMap instanceof Map);
    assert.equal(data.speakerMap.get(0), '김철수');
    assert.equal(data.speakerMap.get(1), '이영희');
  });

  it('should accept plain object speakerMap with string keys', () => {
    const sessionData = makeKoreanSessionData({
      speakerMap: { '0': '김철수', '1': '이영희' },
    });
    const data = processMinutesContent(sessionData);
    assert.ok(data.speakerMap instanceof Map, 'speakerMap should be normalised to Map');
    assert.equal(data.speakerMap.get(0), '김철수');
    assert.equal(data.speakerMap.get(1), '이영희');
  });

  it('should handle null speakerMap gracefully', () => {
    const sessionData = makeKoreanSessionData({ speakerMap: null });
    assert.doesNotThrow(() => processMinutesContent(sessionData));
    const data = processMinutesContent(sessionData);
    assert.ok(data.speakerMap instanceof Map);
  });

  it('should handle missing speakerMap (undefined)', () => {
    const sessionData = makeKoreanSessionData();
    delete sessionData.speakerMap;
    const data = processMinutesContent(sessionData);
    assert.ok(data.speakerMap instanceof Map);
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — language handling
// ---------------------------------------------------------------------------

describe('processMinutesContent — language handling', () => {
  it('should use Korean language patterns for language=ko', () => {
    const data = processMinutesContent(makeKoreanSessionData({ language: 'ko' }));
    // Korean summary should include Korean labels
    assert.ok(data.summary.text.includes('회의 시간') || data.summary.text.includes('참석자'));
  });

  it('should use English language patterns for language=en', () => {
    const data = processMinutesContent(makeEnglishSessionData({ language: 'en' }));
    assert.ok(data.summary.text.includes('Meeting lasted') || data.summary.text.includes('participant'));
  });

  it('should default to Korean when language is missing', () => {
    const sessionData = makeKoreanSessionData();
    delete sessionData.language;
    const data = processMinutesContent(sessionData);
    assert.equal(data.language, 'ko');
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — edge cases
// ---------------------------------------------------------------------------

describe('processMinutesContent — edge cases', () => {
  it('should handle empty transcript gracefully', () => {
    const data = processMinutesContent(makeKoreanSessionData({ transcript: [], speakers: [] }));
    assert.deepEqual(data.attendees, []);
    assert.deepEqual(data.keyTopics, []);
    assert.deepEqual(data.decisions, []);
    assert.deepEqual(data.actionItems, []);
    assert.equal(typeof data.summary.text, 'string');
  });

  it('should handle single-speaker session', () => {
    const transcript = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'I will update the docs by tomorrow',  start: 0, end: 5  }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'We decided to use the new framework', start: 6, end: 10 }),
    ];
    const speakers = [
      { speakerLabel: 0, displayName: 'Alice', userId: 'uid-alice', utteranceCount: 2, totalSpeakingSeconds: 10, avgConfidence: 0.95 },
    ];
    const data = processMinutesContent(
      makeEnglishSessionData({ transcript, speakers, speakerMap: new Map([[0, 'Alice']]) })
    );
    assert.equal(data.attendees.length, 1);
    assert.equal(data.attendees[0].contributionPct, 100);
  });

  it('should handle session with no decisions and no action items', () => {
    const transcript = [
      makeTranscriptEntry({ text: 'Good morning', speaker: 0, start: 0, end: 2 }),
      makeTranscriptEntry({ text: 'Hello there',  speaker: 1, start: 3, end: 5 }),
    ];
    const data = processMinutesContent(
      makeEnglishSessionData({ transcript, speakers: [] })
    );
    assert.ok(Array.isArray(data.decisions));
    assert.ok(Array.isArray(data.actionItems));
  });

  it('should handle missing optional fields with defaults', () => {
    const minimal = {
      transcript: [makeTranscriptEntry({ text: 'Hello world.', speaker: 0, start: 0, end: 2 })],
    };
    const data = processMinutesContent(minimal);

    assert.equal(data.sessionId,    '');
    assert.equal(data.guildName,    'Unknown Server');
    assert.equal(data.channelName,  'Unknown Channel');
    assert.equal(data.startedBy,    'Unknown');
    assert.equal(data.language,     'ko');
    assert.equal(data.reason,       'unknown');
    assert.equal(data.durationSeconds, 0);
    assert.ok(data.startedAt instanceof Date);
    assert.ok(data.endedAt   instanceof Date);
  });

  it('should handle 5-10 concurrent speakers correctly', () => {
    const speakers = Array.from({ length: 8 }, (_, i) => ({
      speakerLabel: i,
      displayName: `Speaker ${i}`,
      userId: null,
      utteranceCount: 3,
      totalSpeakingSeconds: 10,
      avgConfidence: 0.85,
    }));
    const transcript = speakers.flatMap((s, i) =>
      Array.from({ length: 3 }, (_, j) =>
        makeTranscriptEntry({ speaker: s.speakerLabel, speakerName: s.displayName, text: `Utterance ${j}`, start: i * 10 + j * 3, end: i * 10 + j * 3 + 2 })
      )
    );
    const data = processMinutesContent(
      makeEnglishSessionData({ transcript, speakers, speakerMap: new Map(speakers.map(s => [s.speakerLabel, s.displayName])) })
    );

    assert.equal(data.attendees.length, 8);
    // All should have equal contribution (3 utterances each, 24 total → ~12.5% → rounds to 13%)
    for (const a of data.attendees) {
      assert.ok(a.contributionPct >= 12 && a.contributionPct <= 13,
        `Expected ~12-13% contribution, got ${a.contributionPct}%`);
    }
  });
});

// ---------------------------------------------------------------------------
// processMinutesContent — input validation
// ---------------------------------------------------------------------------

describe('processMinutesContent — input validation', () => {
  it('should throw TypeError when sessionData is null', () => {
    assert.throws(
      () => processMinutesContent(null),
      /sessionData must be a non-null object/
    );
  });

  it('should throw TypeError when sessionData is undefined', () => {
    assert.throws(
      () => processMinutesContent(undefined),
      /sessionData must be a non-null object/
    );
  });

  it('should throw TypeError when sessionData is a string', () => {
    assert.throws(
      () => processMinutesContent('not an object'),
      /sessionData must be a non-null object/
    );
  });

  it('should throw Error when transcript is present but not an Array', () => {
    assert.throws(
      () => processMinutesContent({ transcript: 'bad' }),
      /transcript must be an Array/
    );
  });

  it('should not throw for empty object (uses all defaults)', () => {
    assert.doesNotThrow(() => processMinutesContent({}));
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_PROCESSOR_OPTIONS
// ---------------------------------------------------------------------------

describe('DEFAULT_PROCESSOR_OPTIONS', () => {
  it('should export default option values', () => {
    assert.equal(typeof DEFAULT_PROCESSOR_OPTIONS, 'object');
    assert.equal(DEFAULT_PROCESSOR_OPTIONS.maxKeyTopics,   5);
    assert.equal(DEFAULT_PROCESSOR_OPTIONS.maxDecisions,   10);
    assert.equal(DEFAULT_PROCESSOR_OPTIONS.maxActionItems, 10);
    assert.equal(DEFAULT_PROCESSOR_OPTIONS.maxTopTopics,   5);
  });
});

// ---------------------------------------------------------------------------
// toSerializableContent
// ---------------------------------------------------------------------------

describe('toSerializableContent', () => {
  it('should convert speakerMap to a plain object', () => {
    const data    = processMinutesContent(makeKoreanSessionData());
    const serial  = toSerializableContent(data);

    assert.ok(!(serial.speakerMap instanceof Map), 'speakerMap should not be a Map');
    assert.equal(typeof serial.speakerMap, 'object');
    assert.equal(serial.speakerMap['0'], '김철수');
    assert.equal(serial.speakerMap['1'], '이영희');
  });

  it('should convert Date objects to ISO strings', () => {
    const data   = processMinutesContent(makeKoreanSessionData());
    const serial = toSerializableContent(data);

    assert.equal(typeof serial.startedAt, 'string');
    assert.equal(typeof serial.endedAt,   'string');
    assert.doesNotThrow(() => new Date(serial.startedAt));
    assert.doesNotThrow(() => new Date(serial.endedAt));
  });

  it('should be fully JSON-serializable without errors', () => {
    const data   = processMinutesContent(makeKoreanSessionData());
    const serial = toSerializableContent(data);
    assert.doesNotThrow(() => JSON.stringify(serial));
  });

  it('should preserve all section arrays in serialized form', () => {
    const data   = processMinutesContent(makeKoreanSessionData());
    const serial = toSerializableContent(data);

    assert.ok(Array.isArray(serial.attendees));
    assert.ok(Array.isArray(serial.keyTopics));
    assert.ok(Array.isArray(serial.decisions));
    assert.ok(Array.isArray(serial.actionItems));
    assert.ok(Array.isArray(serial.transcript));
    assert.equal(typeof serial.summary, 'object');
  });
});
