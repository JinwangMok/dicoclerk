/**
 * Transcript Aggregation Integration Tests (Sub-AC 3)
 *
 * Validates the full pipeline that:
 *   1. Maps Deepgram speaker IDs to Discord user identities
 *      (SpeakerIdentifier → TranscriptSession.registerSpeaker)
 *   2. Merges interleaved utterances from 5-10 speakers into a
 *      coherent, chronologically-ordered transcript
 *      (parseDeepgramPayload → normalizeTranscript / aggregateSessionData)
 *
 * No real Deepgram API or Discord connections are required.
 * All data is synthetic but structurally accurate.
 *
 * Coverage:
 *   A. SpeakerIdentifier + TranscriptSession integration (label → user → name)
 *   B. Interleaved payload ordering (multiple speakers, single Deepgram result)
 *   C. Retroactive speaker name resolution (mapping confirmed after early entries)
 *   D. 5-speaker and 10-speaker interleaved transcript scenarios
 *   E. Bilingual (Korean + English) multi-speaker transcripts
 *   F. aggregateSessionData ordering and speaker-stat correctness for 5-10 speakers
 *   G. Chronological coherence when entries arrive out of order
 *   H. speakerMap propagation: external > coordinator > transcript-inferred
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { SpeakerIdentifier, CONFIRMATION_THRESHOLD } from '../src/stt/speaker-identifier.js';
import {
  TranscriptSession,
  parseDeepgramPayload,
} from '../src/stt/transcript-store.js';
import {
  aggregateSessionData,
  aggregateFromCleanupResult,
  toSerializable,
} from '../src/minutes/aggregator.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create N fake Discord user IDs */
function makeUserIds(n) {
  return Array.from({ length: n }, (_, i) => `discord-user-${String(i + 1).padStart(4, '0')}`);
}

/** Create a fake display name for a user */
function displayName(userId) {
  return `User-${userId.slice(-4)}`;
}

/**
 * Build a Deepgram Results payload with words from multiple speakers.
 * Words are specified as { word, speaker, start, end, punctuated? }.
 */
function makeMultiSpeakerPayload(wordSpecs, {
  isFinal = true,
  speechFinal = false,
  streamStart = 0,
  duration = 5,
} = {}) {
  const words = wordSpecs.map(({ word, speaker, start, end, punctuated }) => ({
    word: word.toLowerCase().replace(/[.,!?]$/, ''),
    punctuated_word: punctuated ?? word,
    speaker,
    start,
    end,
    confidence: 0.95,
  }));

  const transcript = words.map(w => w.punctuated_word).join(' ');

  return {
    type: 'Results',
    is_final: isFinal,
    speech_final: speechFinal,
    start: streamStart,
    duration,
    channel: {
      alternatives: [{
        transcript,
        confidence: 0.95,
        words,
      }],
    },
  };
}

/**
 * Simulate N packets of audio activity for a user at a time range.
 * Used to set up SpeakerIdentifier state before calling identify().
 */
function simulateActivity(identifier, userId, startSec, endSec, packetCount = 10) {
  const step = (endSec - startSec) / packetCount;
  for (let i = 0; i < packetCount; i++) {
    identifier.recordActivity(userId, startSec + i * step);
  }
}

/** Build a minimal SessionInfo-like object for aggregateSessionData */
function makeSession(overrides = {}) {
  return {
    sessionId: 'test-session-001',
    guildId: 'guild-001',
    voiceChannelId: 'vc-001',
    textChannelId: 'tc-001',
    language: 'ko',
    startedBy: 'TestUser#0001',
    startedAt: new Date('2025-06-01T09:00:00Z'),
    participants: new Set(),
    transcript: [],
    ...overrides,
  };
}

/** Build a raw transcript entry (matches coordinator's #transcript shape) */
function makeEntry(overrides = {}) {
  return {
    speaker: 0,
    speakerName: 'Speaker 0',
    userId: null,
    text: 'Hello.',
    confidence: 0.95,
    start: 0,
    end: 2,
    timestamp: Date.now(),
    isFinal: true,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. SpeakerIdentifier + TranscriptSession integration
// ─────────────────────────────────────────────────────────────────────────────

describe('A. SpeakerIdentifier → TranscriptSession: label-to-Discord-user mapping', () => {
  let identifier;
  let session;

  beforeEach(() => {
    identifier = new SpeakerIdentifier();
    session = new TranscriptSession({ sessionId: 'sess-a' });
  });

  it('maps 5 Deepgram speaker labels to 5 distinct Discord users', () => {
    const userIds = makeUserIds(5);

    // Register all users with the identifier
    for (const uid of userIds) {
      identifier.registerUser(uid, displayName(uid));
    }

    // Each user speaks during exclusive, non-overlapping windows
    for (let i = 0; i < 5; i++) {
      const uid = userIds[i];
      const start = i * 3;
      const end = start + 2;

      // Simulate audio activity
      simulateActivity(identifier, uid, start, end, CONFIRMATION_THRESHOLD + 3);

      // Identify multiple times to build confidence
      for (let e = 0; e < CONFIRMATION_THRESHOLD; e++) {
        const result = identifier.identify(i, start, end);
        if (result.userId) {
          session.registerSpeaker(i, result.userId, result.displayName);
        }
      }
    }

    // All 5 speaker labels should now map to distinct Discord users
    const stats = identifier.getStats();
    assert.equal(stats.mappingCount, 5, '5 mappings created');

    const mappedUsers = new Set(stats.mappings.map(m => m.userId).filter(Boolean));
    assert.equal(mappedUsers.size, 5, 'All 5 mapped users are distinct');

    // TranscriptSession should resolve all 5 labels
    for (let i = 0; i < 5; i++) {
      const resolution = session.resolveSpeaker(i);
      assert.equal(
        resolution.userId,
        userIds[i],
        `Speaker ${i} should map to user ${userIds[i]}`
      );
      assert.equal(resolution.speakerName, displayName(userIds[i]));
    }
  });

  it('maps 10 Deepgram speaker labels to 10 distinct Discord users', () => {
    const userIds = makeUserIds(10);

    for (const uid of userIds) {
      identifier.registerUser(uid, displayName(uid));
    }

    for (let i = 0; i < 10; i++) {
      const uid = userIds[i];
      const start = i * 2;
      const end = start + 1.5;

      simulateActivity(identifier, uid, start, end, CONFIRMATION_THRESHOLD + 2);
      for (let e = 0; e < CONFIRMATION_THRESHOLD; e++) {
        identifier.identify(i, start, end);
      }

      // Use setMapping for confirmed assignment (simulating confirmed identities)
      identifier.setMapping(i, uid, displayName(uid));
      session.registerSpeaker(i, uid, displayName(uid));
    }

    const allMappings = identifier.getAllMappings();
    assert.equal(allMappings.size, 10, '10 confirmed mappings exist');

    for (let i = 0; i < 10; i++) {
      const res = session.resolveSpeaker(i);
      assert.equal(res.userId, userIds[i], `Speaker ${i} → ${userIds[i]}`);
    }
  });

  it('falls back to "Speaker N" for unidentified labels', () => {
    // No activity recorded, no mapping set
    const res = session.resolveSpeaker(7);
    assert.equal(res.userId, null);
    assert.equal(res.speakerName, 'Speaker 7');
  });

  it('retroactively updates entries when speaker identity is confirmed later', () => {
    const uid = 'discord-user-late-confirm';
    const session2 = new TranscriptSession({ sessionId: 'sess-retro' });

    // Add 3 entries BEFORE the speaker is identified
    const payload = makeMultiSpeakerPayload([
      { word: 'First', speaker: 0, start: 0.0, end: 0.3 },
      { word: 'Second', speaker: 0, start: 0.4, end: 0.7 },
      { word: 'Third', speaker: 0, start: 0.8, end: 1.1 },
    ]);
    session2.addFromPayload(payload);

    // Entry should have placeholder name before mapping
    const beforeEntries = session2.getEntriesBySpeaker(0);
    assert.ok(beforeEntries.length > 0, 'Entries should exist before mapping');
    assert.equal(beforeEntries[0].userId, null, 'userId should be null before mapping');
    assert.equal(beforeEntries[0].speakerName, 'Speaker 0', 'Should use placeholder before mapping');

    // Now confirm the speaker identity
    session2.registerSpeaker(0, uid, 'Alice');

    // All existing entries should be retroactively updated
    const afterEntries = session2.getEntriesBySpeaker(0);
    for (const entry of afterEntries) {
      assert.equal(entry.userId, uid, 'userId should be updated retroactively');
      assert.equal(entry.speakerName, 'Alice', 'speakerName should be updated retroactively');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Interleaved payload ordering
// ─────────────────────────────────────────────────────────────────────────────

describe('B. Interleaved utterance merging within a single Deepgram payload', () => {
  it('correctly splits a 2-speaker interleaved payload into 2 segments', () => {
    const payload = makeMultiSpeakerPayload([
      { word: 'Hello',    speaker: 0, start: 0.0, end: 0.3, punctuated: 'Hello' },
      { word: 'everyone', speaker: 0, start: 0.3, end: 0.6, punctuated: 'everyone,' },
      { word: 'Hi',       speaker: 1, start: 0.7, end: 0.9, punctuated: 'Hi' },
      { word: 'there',    speaker: 1, start: 1.0, end: 1.2, punctuated: 'there.' },
    ]);

    const segments = parseDeepgramPayload(payload);
    assert.equal(segments.length, 2, 'Two segments for two speakers');
    assert.equal(segments[0].speakerLabel, 0);
    assert.ok(segments[0].text.includes('Hello'));
    assert.equal(segments[1].speakerLabel, 1);
    assert.ok(segments[1].text.includes('Hi'));
  });

  it('splits A-B-A-B alternating speakers into 4 segments', () => {
    const payload = makeMultiSpeakerPayload([
      { word: 'Yes',   speaker: 0, start: 0.0, end: 0.2 },
      { word: 'Right', speaker: 1, start: 0.3, end: 0.5 },
      { word: 'Okay',  speaker: 0, start: 0.6, end: 0.8 },
      { word: 'Sure',  speaker: 1, start: 0.9, end: 1.1 },
    ]);

    const segments = parseDeepgramPayload(payload);
    assert.equal(segments.length, 4, '4 segments for A-B-A-B pattern');
    assert.equal(segments[0].speakerLabel, 0);
    assert.equal(segments[1].speakerLabel, 1);
    assert.equal(segments[2].speakerLabel, 0);
    assert.equal(segments[3].speakerLabel, 1);
  });

  it('accumulates interleaved 5-speaker payload into ordered TranscriptSession', () => {
    const session = new TranscriptSession({ sessionId: 'sess-interleaved-5' });

    // Simulate a single Deepgram payload where all 5 speakers contribute words
    // in chronological order (as Deepgram would return them after diarization)
    const payload = makeMultiSpeakerPayload([
      { word: '안녕',     speaker: 0, start: 0.0,  end: 0.4,  punctuated: '안녕하세요.' },
      { word: 'Hello',   speaker: 1, start: 0.5,  end: 0.8,  punctuated: 'Hello.' },
      { word: '좋아요',   speaker: 2, start: 1.0,  end: 1.4,  punctuated: '좋아요.' },
      { word: 'Agreed',  speaker: 3, start: 1.5,  end: 1.9,  punctuated: 'Agreed.' },
      { word: '감사합니다', speaker: 4, start: 2.0, end: 2.5,  punctuated: '감사합니다.' },
    ]);

    const entries = session.addFromPayload(payload);
    assert.equal(entries.length, 5, '5 segments from 5 different speakers');

    // Entries should be in start-time order
    const sessionEntries = session.entries;
    assert.equal(sessionEntries.length, 5);
    for (let i = 1; i < sessionEntries.length; i++) {
      assert.ok(
        sessionEntries[i].start >= sessionEntries[i - 1].start,
        `Entry ${i} start (${sessionEntries[i].start}) should be >= entry ${i-1} start (${sessionEntries[i - 1].start})`
      );
    }
  });

  it('merges 10 distinct speakers from sequential payloads into ordered transcript', () => {
    const session = new TranscriptSession({ sessionId: 'sess-10-speakers' });
    const userIds = makeUserIds(10);

    // Register all 10 users
    for (let i = 0; i < 10; i++) {
      session.registerSpeaker(i, userIds[i], `User-${i}`);
    }

    // Simulate sequential payloads (one per speaker, in time order)
    for (let i = 0; i < 10; i++) {
      const start = i * 3;
      const end = start + 2;
      const payload = makeMultiSpeakerPayload(
        [{ word: `Utterance${i}`, speaker: i, start, end, punctuated: `Utterance ${i}.` }],
        { streamStart: start, duration: 2 }
      );
      session.addFromPayload(payload);
    }

    const entries = session.entries;
    assert.equal(entries.length, 10, '10 entries from 10 speakers');

    // Verify all 10 speakers have correct Discord user IDs
    for (const entry of entries) {
      assert.ok(entry.userId !== null, `Entry for speaker ${entry.speakerLabel} should have userId`);
      assert.equal(entry.userId, userIds[entry.speakerLabel]);
    }

    // Verify chronological ordering
    for (let i = 1; i < entries.length; i++) {
      assert.ok(
        entries[i].start >= entries[i - 1].start,
        `Entries should be chronologically ordered`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Retroactive speaker name resolution (late mapping confirmation)
// ─────────────────────────────────────────────────────────────────────────────

describe('C. Retroactive speaker name resolution in TranscriptSession', () => {
  it('updates all prior entries when a mapping is confirmed mid-session (5 speakers)', () => {
    const session = new TranscriptSession({ sessionId: 'sess-retro-5' });
    const userIds = makeUserIds(5);

    // Add initial entries WITHOUT registered names (simulating early session)
    for (let i = 0; i < 5; i++) {
      const payload = makeMultiSpeakerPayload([
        { word: 'Hi', speaker: i, start: i * 2, end: i * 2 + 1, punctuated: 'Hi.' },
      ], { streamStart: i * 2 });
      session.addFromPayload(payload);
    }

    // Verify entries have placeholder names initially
    for (let i = 0; i < 5; i++) {
      const entries = session.getEntriesBySpeaker(i);
      assert.ok(entries.length > 0, `Speaker ${i} should have entries`);
      assert.equal(entries[0].userId, null, `Speaker ${i} userId should be null initially`);
      assert.equal(entries[0].speakerName, `Speaker ${i}`, `Speaker ${i} should use placeholder`);
    }

    // Now confirm all 5 mappings (simulating delayed identification)
    for (let i = 0; i < 5; i++) {
      session.registerSpeaker(i, userIds[i], `Confirmed-${i}`);
    }

    // All entries should now have confirmed names retroactively
    for (let i = 0; i < 5; i++) {
      const entries = session.getEntriesBySpeaker(i);
      for (const entry of entries) {
        assert.equal(entry.userId, userIds[i], `Speaker ${i} entry userId should be updated`);
        assert.equal(entry.speakerName, `Confirmed-${i}`, `Speaker ${i} name should be updated`);
      }
    }
  });

  it('stats after retroactive updates reflect correct speaker names', () => {
    const session = new TranscriptSession({ sessionId: 'sess-stats-retro' });

    // Add entries with placeholder names
    const payload = makeMultiSpeakerPayload([
      { word: 'One',   speaker: 0, start: 0, end: 1 },
      { word: 'Two',   speaker: 1, start: 1, end: 2 },
      { word: 'Three', speaker: 0, start: 2, end: 3 },
    ]);
    session.addFromPayload(payload);

    // Confirm identities
    session.registerSpeaker(0, 'uid-alice', 'Alice');
    session.registerSpeaker(1, 'uid-bob', 'Bob');

    const stats = session.getSpeakerStats();
    const aliceStats = stats.get('uid-alice');
    const bobStats = stats.get('uid-bob');

    assert.ok(aliceStats, 'Alice stats should exist');
    assert.equal(aliceStats.speakerName, 'Alice');
    assert.equal(aliceStats.entryCount, 2, 'Alice has 2 utterances');

    assert.ok(bobStats, 'Bob stats should exist');
    assert.equal(bobStats.speakerName, 'Bob');
    assert.equal(bobStats.entryCount, 1, 'Bob has 1 utterance');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. 5-speaker and 10-speaker scenarios with aggregateSessionData
// ─────────────────────────────────────────────────────────────────────────────

describe('D. aggregateSessionData with 5 and 10 interleaved speakers', () => {
  function makeInterleaved5Transcript() {
    const userIds = makeUserIds(5);
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];
    // Deliberately out of order to test sorting
    return [
      makeEntry({ speaker: 2, speakerName: names[2], userId: userIds[2], text: 'C speaks.',     start: 10, end: 12 }),
      makeEntry({ speaker: 0, speakerName: names[0], userId: userIds[0], text: 'A speaks.',     start: 0,  end: 2  }),
      makeEntry({ speaker: 4, speakerName: names[4], userId: userIds[4], text: 'E speaks.',     start: 20, end: 22 }),
      makeEntry({ speaker: 1, speakerName: names[1], userId: userIds[1], text: 'B speaks.',     start: 5,  end: 7  }),
      makeEntry({ speaker: 3, speakerName: names[3], userId: userIds[3], text: 'D speaks.',     start: 15, end: 17 }),
      makeEntry({ speaker: 0, speakerName: names[0], userId: userIds[0], text: 'A again.',      start: 25, end: 27 }),
      makeEntry({ speaker: 2, speakerName: names[2], userId: userIds[2], text: 'C again.',      start: 30, end: 32 }),
    ];
  }

  it('produces 5-speaker stats and chronologically ordered transcript', () => {
    const transcript = makeInterleaved5Transcript();
    const session = makeSession({ participants: new Set(makeUserIds(5)) });

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null },
      durationSeconds: 35,
      reason: 'manual_stop',
    });

    // Chronological ordering
    assert.equal(data.transcriptCount, 7);
    const starts = data.transcript.map(e => e.start);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] >= starts[i - 1], `Transcript[${i}] start (${starts[i]}) should be >= Transcript[${i-1}] start (${starts[i-1]})`);
    }
    assert.equal(data.transcript[0].text, 'A speaks.', 'First entry should be A speaks.');
    assert.equal(data.transcript[data.transcriptCount - 1].text, 'C again.', 'Last entry should be C again.');

    // Speaker stats
    assert.equal(data.speakers.length, 5, '5 distinct speakers');
    const alice = data.speakers.find(s => s.speakerLabel === 0);
    assert.equal(alice.utteranceCount, 2, 'Alice has 2 utterances');
    assert.equal(alice.displayName, 'Alice');
  });

  it('produces 10-speaker stats and ordered transcript for maximum capacity', () => {
    const userIds = makeUserIds(10);
    const transcript = userIds.map((uid, i) =>
      makeEntry({
        speaker: i,
        speakerName: `User-${i}`,
        userId: uid,
        text: `Speaker ${i} utterance.`,
        start: i * 5,
        end: i * 5 + 3,
        confidence: 0.9,
      })
    );

    // Add some interleaved follow-up utterances
    for (let i = 0; i < 5; i++) {
      transcript.push(makeEntry({
        speaker: i,
        speakerName: `User-${i}`,
        userId: userIds[i],
        text: `Speaker ${i} follow-up.`,
        start: 55 + i * 2,
        end: 57 + i * 2,
        confidence: 0.88,
      }));
    }

    const session = makeSession({ participants: new Set(userIds) });

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null },
      durationSeconds: 70,
      reason: 'manual_stop',
    });

    assert.equal(data.transcriptCount, 15, '15 total entries (10 initial + 5 follow-ups)');
    assert.equal(data.speakers.length, 10, '10 distinct speakers');

    // All entries chronologically sorted
    for (let i = 1; i < data.transcript.length; i++) {
      assert.ok(
        data.transcript[i].start >= data.transcript[i - 1].start,
        `Entry ${i} must not precede entry ${i - 1}`
      );
    }

    // First 5 speakers have 2 utterances each; last 5 have 1 each
    for (let i = 0; i < 10; i++) {
      const speaker = data.speakers.find(s => s.speakerLabel === i);
      assert.ok(speaker, `Speaker ${i} should have stats`);
      const expectedCount = i < 5 ? 2 : 1;
      assert.equal(speaker.utteranceCount, expectedCount, `Speaker ${i} utterance count`);
    }
  });

  it('handles out-of-order arrivals from 5 speakers and sorts them correctly', () => {
    // Simulate pool mode where multiple connections return results out of order
    const transcript = [
      makeEntry({ speaker: 2, text: 'C at 15s', start: 15, end: 17 }),
      makeEntry({ speaker: 0, text: 'A at 0s',  start: 0,  end: 2  }),
      makeEntry({ speaker: 3, text: 'D at 20s', start: 20, end: 22 }),
      makeEntry({ speaker: 1, text: 'B at 8s',  start: 8,  end: 10 }),
      makeEntry({ speaker: 4, text: 'E at 12s', start: 12, end: 14 }),
      makeEntry({ speaker: 0, text: 'A at 5s',  start: 5,  end: 7  }),
      makeEntry({ speaker: 2, text: 'C at 25s', start: 25, end: 27 }),
    ];

    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript, filePath: null },
      durationSeconds: 30,
      reason: 'manual_stop',
    });

    const expectedOrder = [
      'A at 0s', 'A at 5s', 'B at 8s', 'E at 12s', 'C at 15s', 'D at 20s', 'C at 25s',
    ];
    assert.deepEqual(
      data.transcript.map(e => e.text),
      expectedOrder,
      'Transcript should be sorted by start time'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Bilingual (Korean + English) multi-speaker transcript
// ─────────────────────────────────────────────────────────────────────────────

describe('E. Bilingual multi-speaker transcript (Korean + English)', () => {
  it('correctly accumulates Korean and English utterances from 5 speakers', () => {
    const session = new TranscriptSession({ sessionId: 'sess-bilingual' });

    // Register 5 users (mix of Korean and English speakers)
    session.registerSpeaker(0, 'uid-ko-1', '홍길동');
    session.registerSpeaker(1, 'uid-en-1', 'Alice');
    session.registerSpeaker(2, 'uid-ko-2', '김철수');
    session.registerSpeaker(3, 'uid-en-2', 'Bob');
    session.registerSpeaker(4, 'uid-ko-3', '이영희');

    // Korean speakers
    session.addFromPayload(makeMultiSpeakerPayload([
      { word: '안녕하세요', speaker: 0, start: 0, end: 1, punctuated: '안녕하세요.' },
    ]));
    session.addFromPayload(makeMultiSpeakerPayload([
      { word: '감사합니다', speaker: 2, start: 3, end: 4, punctuated: '감사합니다.' },
    ], { streamStart: 3 }));
    session.addFromPayload(makeMultiSpeakerPayload([
      { word: '좋아요', speaker: 4, start: 7, end: 8, punctuated: '좋아요.' },
    ], { streamStart: 7 }));

    // English speakers
    session.addFromPayload(makeMultiSpeakerPayload([
      { word: 'Hello', speaker: 1, start: 2, end: 2.5, punctuated: 'Hello.' },
    ], { streamStart: 2 }));
    session.addFromPayload(makeMultiSpeakerPayload([
      { word: 'Agreed', speaker: 3, start: 5, end: 5.8, punctuated: 'Agreed.' },
    ], { streamStart: 5 }));

    const entries = session.entries;
    assert.equal(entries.length, 5, '5 entries from 5 speakers');

    // Verify language detection
    const koEntries = entries.filter(e => e.language === 'ko');
    const enEntries = entries.filter(e => e.language === 'en');
    assert.equal(koEntries.length, 3, '3 Korean entries');
    assert.equal(enEntries.length, 2, '2 English entries');

    // Verify speaker attribution
    const koNames = koEntries.map(e => e.speakerName).sort();
    assert.deepEqual(koNames, ['김철수', '이영희', '홍길동'], 'Korean speaker names correct');
  });

  it('aggregateSessionData with bilingual 5-speaker transcript preserves language info', () => {
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Alice',  userId: 'uid-a', text: '안녕하세요 반갑습니다.', start: 0,  end: 2,  confidence: 0.97 }),
      makeEntry({ speaker: 1, speakerName: 'Bob',    userId: 'uid-b', text: 'Hello everyone.',        start: 4,  end: 6,  confidence: 0.93 }),
      makeEntry({ speaker: 0, speakerName: 'Alice',  userId: 'uid-a', text: '오늘 의제를 시작합니다.', start: 7,  end: 11, confidence: 0.96 }),
      makeEntry({ speaker: 2, speakerName: 'Carol',  userId: 'uid-c', text: 'Sounds good.',           start: 12, end: 14, confidence: 0.91 }),
      makeEntry({ speaker: 3, speakerName: '홍길동', userId: 'uid-d', text: '좋습니다.',              start: 15, end: 17, confidence: 0.94 }),
    ];

    const session = makeSession({
      language: 'multi',
      participants: new Set(['uid-a', 'uid-b', 'uid-c', 'uid-d']),
    });

    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob'], [2, 'Carol'], [3, '홍길동']]);

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null },
      speakerMap,
      durationSeconds: 20,
      reason: 'manual_stop',
    });

    assert.equal(data.transcriptCount, 5);
    assert.equal(data.speakers.length, 4);

    // Verify speaker names from the external map
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(3), '홍길동');

    // Alice has 2 utterances
    const alice = data.speakers.find(s => s.speakerLabel === 0);
    assert.equal(alice.utteranceCount, 2);
    assert.equal(alice.userId, 'uid-a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. speakerMap priority: external > coordinator > transcript-inferred
// ─────────────────────────────────────────────────────────────────────────────

describe('F. speakerMap priority resolution for 5-10 speakers', () => {
  it('external speakerMap wins over coordinator and transcript-inferred for all 5 speakers', () => {
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Generic 0', text: 'A.', start: 0 }),
      makeEntry({ speaker: 1, speakerName: 'Generic 1', text: 'B.', start: 1 }),
      makeEntry({ speaker: 2, speakerName: 'Generic 2', text: 'C.', start: 2 }),
      makeEntry({ speaker: 3, speakerName: 'Generic 3', text: 'D.', start: 3 }),
      makeEntry({ speaker: 4, speakerName: 'Generic 4', text: 'E.', start: 4 }),
    ];

    const coordinatorMap = { '0': 'CoordAlice', '1': 'CoordBob', '2': 'CoordCarol', '3': 'CoordDave', '4': 'CoordEve' };
    const externalMap = new Map([
      [0, 'RealAlice'], [1, 'RealBob'], [2, 'RealCarol'], [3, 'RealDave'], [4, 'RealEve'],
    ]);

    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript, filePath: null, speakerMap: coordinatorMap },
      speakerMap: externalMap,
      durationSeconds: 10,
      reason: 'manual_stop',
    });

    // External map wins for all 5 labels
    assert.equal(data.speakerMap.get(0), 'RealAlice', 'External map wins for speaker 0');
    assert.equal(data.speakerMap.get(1), 'RealBob',   'External map wins for speaker 1');
    assert.equal(data.speakerMap.get(2), 'RealCarol', 'External map wins for speaker 2');
    assert.equal(data.speakerMap.get(3), 'RealDave',  'External map wins for speaker 3');
    assert.equal(data.speakerMap.get(4), 'RealEve',   'External map wins for speaker 4');
  });

  it('coordinator map wins over transcript-inferred when no external map', () => {
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Old Name 0', text: 'Hello.', start: 0 }),
      makeEntry({ speaker: 1, speakerName: 'Old Name 1', text: 'World.',  start: 1 }),
    ];

    const coordinatorMap = new Map([[0, 'CoordAlice'], [1, 'CoordBob']]);

    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript, filePath: null, speakerMap: coordinatorMap },
      speakerMap: null, // no external map
      durationSeconds: 5,
      reason: 'manual_stop',
    });

    assert.equal(data.speakerMap.get(0), 'CoordAlice', 'Coordinator map wins when no external');
    assert.equal(data.speakerMap.get(1), 'CoordBob');
  });

  it('falls back to transcript-inferred names when no maps provided (5 speakers)', () => {
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Alice', text: 'A.', start: 0 }),
      makeEntry({ speaker: 1, speakerName: 'Bob',   text: 'B.', start: 1 }),
      makeEntry({ speaker: 2, speakerName: 'Carol', text: 'C.', start: 2 }),
      makeEntry({ speaker: 3, speakerName: 'Dave',  text: 'D.', start: 3 }),
      makeEntry({ speaker: 4, speakerName: 'Eve',   text: 'E.', start: 4 }),
    ];

    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript, filePath: null, speakerMap: null },
      speakerMap: null,
      durationSeconds: 10,
      reason: 'manual_stop',
    });

    // Should infer from transcript speakerName fields
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
    assert.equal(data.speakerMap.get(2), 'Carol');
    assert.equal(data.speakerMap.get(3), 'Dave');
    assert.equal(data.speakerMap.get(4), 'Eve');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. aggregateFromCleanupResult with multi-speaker interleaved data
// ─────────────────────────────────────────────────────────────────────────────

describe('G. aggregateFromCleanupResult: full pipeline for 5-10 speakers', () => {
  it('produces well-formed data from a 5-speaker bilingual session cleanup result', () => {
    const userIds = makeUserIds(5);
    const speakerMap = new Map([
      [0, 'Alice'], [1, 'Bob'], [2, 'Carol'], [3, '홍길동'], [4, 'Eve'],
    ]);

    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Alice',  userId: userIds[0], text: '안녕하세요.',          start: 0,  end: 2  }),
      makeEntry({ speaker: 1, speakerName: 'Bob',    userId: userIds[1], text: 'Good morning.',        start: 3,  end: 5  }),
      makeEntry({ speaker: 2, speakerName: 'Carol',  userId: userIds[2], text: '오늘 주제는.',          start: 6,  end: 9  }),
      makeEntry({ speaker: 3, speakerName: '홍길동', userId: userIds[3], text: '동의합니다.',           start: 10, end: 12 }),
      makeEntry({ speaker: 4, speakerName: 'Eve',    userId: userIds[4], text: 'Sounds good.',         start: 13, end: 15 }),
      makeEntry({ speaker: 0, speakerName: 'Alice',  userId: userIds[0], text: '시작하겠습니다.',      start: 16, end: 18 }),
    ];

    const cleanupResult = {
      success: true,
      reason: 'manual_stop',
      duration: 300,
      durationMinutes: 5,
      durationSeconds: 0,
      participantCount: 5,
      transcriptCount: 6,
      transcript,
      transcriptFilePath: '/data/transcripts/test-5speaker.json',
      speakerMap,
      warnings: [],
    };

    const session = makeSession({ participants: new Set(userIds) });

    const data = aggregateFromCleanupResult({
      cleanupResult,
      session,
      speakerMap: cleanupResult.speakerMap,
    });

    // Shape validation
    assert.equal(data.transcriptCount, 6);
    assert.equal(data.speakers.length, 5);
    assert.equal(data.reason, 'manual_stop');
    assert.ok(data.speakerMap instanceof Map);

    // Speaker map correctness
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(3), '홍길동');

    // Alice has 2 utterances (speaker 0 appears twice)
    const alice = data.speakers.find(s => s.speakerLabel === 0);
    assert.equal(alice.utteranceCount, 2);
    assert.equal(alice.userId, userIds[0]);

    // Chronological order preserved
    const starts = data.transcript.map(e => e.start);
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] >= starts[i - 1], 'Transcript must be chronologically ordered');
    }

    // JSON-serializable
    const serializable = toSerializable(data);
    assert.doesNotThrow(() => JSON.stringify(serializable));
    assert.equal(typeof serializable.speakerMap, 'object');
    assert.equal(serializable.speakerMap['0'], 'Alice');
    assert.equal(serializable.speakerMap['3'], '홍길동');
  });

  it('correctly counts speaking time per speaker in a 10-speaker session', () => {
    const userIds = makeUserIds(10);
    const transcript = userIds.map((uid, i) =>
      makeEntry({
        speaker: i,
        speakerName: `User-${i}`,
        userId: uid,
        text: `User ${i} speaks.`,
        // Each speaker talks for exactly (i+1) seconds
        start: i * 10,
        end: i * 10 + (i + 1),
        confidence: 0.9,
      })
    );

    const session = makeSession({ participants: new Set(userIds) });

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null },
      durationSeconds: 100,
      reason: 'manual_stop',
    });

    // Verify speaking time for each of the 10 speakers
    for (let i = 0; i < 10; i++) {
      const speaker = data.speakers.find(s => s.speakerLabel === i);
      assert.ok(speaker, `Speaker ${i} must have stats`);
      assert.equal(
        speaker.totalSpeakingSeconds,
        i + 1,
        `Speaker ${i} should have ${i + 1}s speaking time`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Coherence: getSummary and toPlainText for 5-10 speaker sessions
// ─────────────────────────────────────────────────────────────────────────────

describe('H. Transcript coherence: export helpers for 5-10 speaker sessions', () => {
  it('toPlainText produces correctly labelled, ordered lines for 5 speakers', () => {
    const session = new TranscriptSession({ sessionId: 'sess-plain-5' });

    for (let i = 0; i < 5; i++) {
      session.registerSpeaker(i, `uid-${i}`, `User${i}`);
    }

    // Add entries in random order; TranscriptSession adds them in arrival order
    // (We test aggregateSessionData for sorting, not TranscriptSession itself)
    for (let i = 0; i < 5; i++) {
      const payload = makeMultiSpeakerPayload([
        { word: `utterance${i}`, speaker: i, start: i * 5, end: i * 5 + 3,
          punctuated: `Utterance ${i}.` },
      ], { streamStart: i * 5 });
      session.addFromPayload(payload);
    }

    const plainText = session.toPlainText();
    const lines = plainText.split('\n').filter(Boolean);

    assert.equal(lines.length, 5, '5 lines in plain text');

    // Each line should have format [MM:SS] Name: text
    for (const line of lines) {
      assert.match(line, /^\[\d{2}:\d{2}\] User\d: Utterance \d\.$/, `Line format correct: ${line}`);
    }

    // Verify all 5 user names appear
    for (let i = 0; i < 5; i++) {
      assert.ok(plainText.includes(`User${i}:`), `User${i} should appear in plain text`);
    }
  });

  it('getSummary reports correct counts for 8-speaker session', () => {
    const session = new TranscriptSession({ sessionId: 'sess-summary-8' });

    for (let i = 0; i < 8; i++) {
      session.registerSpeaker(i, `uid-${i}`, `Speaker${i}`);
    }

    // 2 entries per speaker = 16 total.
    // Space the two entries per speaker 8 seconds apart (> 5s exactMatchWindow)
    // so the deduplicator cannot flag the second as a time-proximity duplicate.
    // Also use sufficiently different text (greeting vs. farewell) to avoid fuzzy match.
    const UTTERANCES = ['hello good morning everyone', 'goodbye see you later thanks'];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 2; j++) {
        const start = i * 20 + j * 8; // 8s gap between the two per-speaker entries
        const payload = makeMultiSpeakerPayload([
          { word: UTTERANCES[j], speaker: i, start, end: start + 2,
            punctuated: UTTERANCES[j] },
        ], { streamStart: start });
        session.addFromPayload(payload);
      }
    }

    const summary = session.getSummary();

    assert.equal(summary.entryCount, 16, '16 total entries (8 speakers × 2 each)');
    assert.equal(summary.participantCount, 8, '8 distinct participants');
    assert.ok(summary.totalWords > 0, 'Total word count should be > 0');
    assert.ok(summary.totalDurationSec > 0, 'Total duration should be > 0');
  });

  it('toStructuredData includes all required fields for 5-speaker session', () => {
    const session = new TranscriptSession({ sessionId: 'sess-structured-5' });
    const REQUIRED_FIELDS = [
      'sessionId', 'speakerLabel', 'speakerName', 'userId',
      'text', 'start', 'end', 'duration', 'confidence', 'language', 'isFinal', 'wallClockMs',
    ];

    for (let i = 0; i < 5; i++) {
      session.registerSpeaker(i, `uid-${i}`, `User${i}`);
      const payload = makeMultiSpeakerPayload([
        { word: 'Hello', speaker: i, start: i * 2, end: i * 2 + 1, punctuated: 'Hello.' },
      ], { streamStart: i * 2 });
      session.addFromPayload(payload);
    }

    const structured = session.toStructuredData();
    assert.equal(structured.length, 5);

    for (const entry of structured) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(
          field in entry,
          `Entry for speaker ${entry.speakerLabel} should have field '${field}'`
        );
      }
    }
  });
});
