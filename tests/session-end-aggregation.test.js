/**
 * Session-End Trigger and Transcript Aggregation Tests (Sub-AC 1)
 *
 * Validates the full flow from session-end command through transcript collection
 * and consolidation into a structured SessionMinutesData object ready for summarization.
 *
 * Covers:
 * - /stop command triggers aggregation with full diarized transcript
 * - speakerMap captured after #resolveAllSpeakerNames is propagated through
 * - auto-disconnect (channel_empty, connection_destroyed) aggregation path
 * - aggregateSessionData produces a complete, well-formed SessionMinutesData
 * - Edge: empty transcript, single speaker, mixed Korean/English
 * - speakerMap priority order in the aggregator (external > coordinator > transcript-inferred)
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { cleanupSession } from '../src/session/session-cleanup.js';
import {
  aggregateSessionData,
  aggregateFromCleanupResult,
  toSerializable,
} from '../src/minutes/aggregator.js';

// ---------------------------------------------------------------------------
// Shared test factories
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    sessionId: 'sess-001',
    guildId: 'guild-001',
    voiceChannelId: 'vc-001',
    textChannelId: 'tc-001',
    language: 'ko',
    startedBy: 'TestUser#0001',
    startedAt: new Date('2025-06-01T09:00:00Z'),
    participants: new Set(['uid-a', 'uid-b', 'uid-c']),
    transcript: [],
    status: 'active',
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    speaker: 0,
    speakerName: 'Speaker 0',
    userId: null,
    text: '안녕하세요.',
    confidence: 0.95,
    start: 0,
    end: 2,
    timestamp: Date.now(),
    isFinal: true,
    ...overrides,
  };
}

/**
 * Create a realistic multi-speaker diarized transcript.
 * Simulates a 5-entry bilingual session (Korean + English).
 */
function makeDiarizedTranscript() {
  return [
    makeEntry({ speaker: 0, speakerName: 'Alice', userId: 'uid-a', text: '안녕하세요 반갑습니다.', start: 0,  end: 3,  confidence: 0.97 }),
    makeEntry({ speaker: 1, speakerName: 'Bob',   userId: 'uid-b', text: 'Hello everyone.',       start: 4,  end: 6,  confidence: 0.93 }),
    makeEntry({ speaker: 0, speakerName: 'Alice', userId: 'uid-a', text: '오늘 의제를 시작하겠습니다.', start: 7, end: 11, confidence: 0.96 }),
    makeEntry({ speaker: 2, speakerName: 'Carol', userId: 'uid-c', text: 'Sounds good to me.',    start: 12, end: 14, confidence: 0.91 }),
    makeEntry({ speaker: 1, speakerName: 'Bob',   userId: 'uid-b', text: '네 동의합니다.',         start: 15, end: 17, confidence: 0.94 }),
  ];
}

function makeMockSessionManager(session) {
  return {
    getSession: mock.fn(() => session),
    stopSession: mock.fn(() => {
      session.status = 'stopped';
      return session;
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. cleanupSession → produces transcript + speakerMap for aggregation
// ---------------------------------------------------------------------------

describe('Session-end trigger: cleanupSession produces aggregation-ready data', () => {
  it('should collect diarized transcript and speakerMap from coordinator on manual_stop', async () => {
    const transcript = makeDiarizedTranscript();
    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob'], [2, 'Carol']]);

    const session = makeSession({
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => ({ transcript, filePath: '/data/transcripts/sess-001.json' })),
        speakerMap,
      },
    });
    const sm = makeMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-001', reason: 'manual_stop' });

    // Transcript collected
    assert.equal(result.transcript.length, 5, 'All 5 diarized entries should be collected');
    assert.equal(result.transcriptCount, 5);
    assert.equal(result.reason, 'manual_stop');
    assert.ok(result.duration >= 0);
    assert.equal(result.participantCount, 3);

    // speakerMap captured after stop()
    assert.ok(result.speakerMap instanceof Map, 'speakerMap should be a Map');
    assert.equal(result.speakerMap.get(0), 'Alice');
    assert.equal(result.speakerMap.get(1), 'Bob');
    assert.equal(result.speakerMap.get(2), 'Carol');

    // Transcript file path preserved
    assert.equal(result.transcriptFilePath, '/data/transcripts/sess-001.json');
  });

  it('should collect transcript on channel_empty (auto-disconnect direct mode)', async () => {
    const transcript = makeDiarizedTranscript();
    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob'], [2, 'Carol']]);

    const session = makeSession({
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => ({ transcript, filePath: null })),
        speakerMap,
      },
    });

    // Direct mode — session provided, sessionManager is a dummy
    const sm = { getSession: mock.fn(() => null), stopSession: mock.fn() };

    const result = await cleanupSession({
      sessionManager: sm,
      guildId: 'guild-001',
      reason: 'channel_empty',
      session, // direct mode
    });

    assert.equal(result.transcript.length, 5);
    assert.equal(result.reason, 'channel_empty');
    assert.ok(result.speakerMap instanceof Map);
    // Direct mode skips stopSession
    assert.equal(sm.stopSession.mock.callCount(), 0);
    assert.equal(sm.getSession.mock.callCount(), 0);
  });

  it('should still produce transcript data when coordinator stop fails (fallback path)', async () => {
    const fallbackTranscript = [makeEntry({ text: 'Partial utterance.', speaker: 0 })];
    const partialSpeakerMap = new Map([[0, 'Alice']]);

    const session = makeSession({
      transcript: fallbackTranscript, // session-level fallback
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => { throw new Error('Deepgram WebSocket closed'); }),
        speakerMap: partialSpeakerMap,
        transcript: [],
      },
    });
    const sm = makeMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-001', reason: 'connection_destroyed' });

    assert.equal(result.success, false, 'success=false when coordinator.stop() throws');
    assert.ok(result.warnings.some(w => w.includes('Deepgram WebSocket closed')));
    // Falls back to session.transcript
    assert.equal(result.transcriptCount, 1);
    assert.equal(result.transcript[0].text, 'Partial utterance.');
    // speakerMap still captured from coordinator
    assert.ok(result.speakerMap instanceof Map);
    assert.equal(result.speakerMap.get(0), 'Alice');
  });
});

// ---------------------------------------------------------------------------
// 2. aggregateSessionData — produces well-formed SessionMinutesData
// ---------------------------------------------------------------------------

describe('Transcript aggregation: aggregateSessionData produces complete structured object', () => {
  it('should consolidate diarized transcript into SessionMinutesData with all required fields', () => {
    const transcript = makeDiarizedTranscript();
    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob'], [2, 'Carol']]);
    const session = makeSession();

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: '/data/transcripts/sess-001.json', speakerMap },
      speakerMap,
      durationSeconds: 30,
      reason: 'manual_stop',
    });

    // Identity
    assert.equal(data.sessionId, 'sess-001');
    assert.equal(data.guildId, 'guild-001');
    assert.equal(data.channelId, 'vc-001');
    assert.equal(data.textChannelId, 'tc-001');
    assert.equal(data.language, 'ko');
    assert.equal(data.startedBy, 'TestUser#0001');
    assert.equal(data.reason, 'manual_stop');

    // Timing
    assert.ok(data.startedAt instanceof Date);
    assert.ok(data.endedAt instanceof Date);
    assert.equal(data.durationSeconds, 30);
    const expectedEnd = new Date(data.startedAt.getTime() + 30_000);
    assert.equal(data.endedAt.toISOString(), expectedEnd.toISOString());

    // Participants
    assert.deepEqual(new Set(data.participantIds), new Set(['uid-a', 'uid-b', 'uid-c']));

    // Transcript
    assert.equal(data.transcriptCount, 5);
    assert.equal(data.transcript.length, 5);
    // Sorted chronologically
    assert.equal(data.transcript[0].text, '안녕하세요 반갑습니다.');
    assert.equal(data.transcript[4].text, '네 동의합니다.');

    // Speaker map
    assert.ok(data.speakerMap instanceof Map);
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
    assert.equal(data.speakerMap.get(2), 'Carol');

    // Per-speaker statistics
    assert.equal(data.speakers.length, 3);
    const alice = data.speakers.find(s => s.speakerLabel === 0);
    const bob   = data.speakers.find(s => s.speakerLabel === 1);
    const carol = data.speakers.find(s => s.speakerLabel === 2);
    assert.ok(alice, 'Alice stats should exist');
    assert.equal(alice.utteranceCount, 2);
    assert.equal(alice.userId, 'uid-a');
    assert.ok(bob, 'Bob stats should exist');
    assert.equal(bob.utteranceCount, 2);
    assert.ok(carol, 'Carol stats should exist');
    assert.equal(carol.utteranceCount, 1);

    // Serializable audit fields
    assert.equal(data.transcriptFilePath, '/data/transcripts/sess-001.json');
    assert.ok(Array.isArray(data.warnings));
    assert.equal(typeof data.aggregatedAt, 'string');
    assert.doesNotThrow(() => new Date(data.aggregatedAt));
  });

  it('should maintain chronological order for out-of-order transcript entries', () => {
    const unordered = [
      makeEntry({ text: 'Third.',  speaker: 0, start: 20, end: 22 }),
      makeEntry({ text: 'First.',  speaker: 1, start: 0,  end: 2  }),
      makeEntry({ text: 'Second.', speaker: 0, start: 10, end: 12 }),
    ];
    const session = makeSession();

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript: unordered, filePath: null },
      durationSeconds: 25,
      reason: 'manual_stop',
    });

    assert.equal(data.transcript[0].text, 'First.');
    assert.equal(data.transcript[1].text, 'Second.');
    assert.equal(data.transcript[2].text, 'Third.');
  });

  it('should resolve speaker names using externalSpeakerMap over transcript-inferred names', () => {
    // Transcript has generic "Speaker N" names, coordinator/external map has real names
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Speaker 0', text: 'Hello.', start: 0, end: 1 }),
      makeEntry({ speaker: 1, speakerName: 'Speaker 1', text: 'World.', start: 2, end: 3 }),
    ];
    const externalMap = new Map([[0, 'Alice'], [1, 'Bob']]);
    const session = makeSession();

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null },
      speakerMap: externalMap, // priority 1 — should override transcript names
      durationSeconds: 5,
      reason: 'manual_stop',
    });

    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
  });

  it('should include valid warnings for empty transcript without throwing', () => {
    const session = makeSession();
    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript: [], filePath: null },
      durationSeconds: 10,
      reason: 'channel_empty',
    });

    assert.equal(data.transcriptCount, 0);
    assert.ok(data.warnings.some(w => w.toLowerCase().includes('no transcript')));
  });

  it('should handle 5-10 concurrent speaker labels (diarize_max_speakers=10)', () => {
    // Simulate 8 speakers (up to Deepgram's diarize_max_speakers: 10)
    const transcript = [];
    for (let speaker = 0; speaker < 8; speaker++) {
      transcript.push(makeEntry({
        speaker,
        speakerName: `Speaker ${speaker}`,
        text: `Utterance from speaker ${speaker}.`,
        start: speaker * 5,
        end: speaker * 5 + 3,
        confidence: 0.9,
      }));
    }
    const session = makeSession({ participants: new Set(['u1','u2','u3','u4','u5','u6','u7','u8']) });

    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null },
      durationSeconds: 50,
      reason: 'manual_stop',
    });

    assert.equal(data.transcriptCount, 8);
    assert.equal(data.speakers.length, 8);
    // All speakers accounted for
    for (let i = 0; i < 8; i++) {
      assert.ok(data.speakers.find(s => s.speakerLabel === i), `Speaker ${i} should have stats`);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. aggregateFromCleanupResult — wires cleanupSession → aggregateSessionData
// ---------------------------------------------------------------------------

describe('aggregateFromCleanupResult: cleanupSession output → structured aggregation', () => {
  it('should produce valid SessionMinutesData from a full manual_stop cleanup result', async () => {
    const transcript = makeDiarizedTranscript();
    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob'], [2, 'Carol']]);

    const session = makeSession({
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => ({ transcript, filePath: '/data/transcripts/test.json' })),
        speakerMap,
      },
    });
    const sm = makeMockSessionManager(session);

    // Step 1: session-end trigger
    const cleanupResult = await cleanupSession({
      sessionManager: sm,
      guildId: 'guild-001',
      reason: 'manual_stop',
    });

    // Step 2: aggregate into structured object
    const data = aggregateFromCleanupResult({
      cleanupResult,
      session,
      speakerMap: cleanupResult.speakerMap, // pass through the resolved map
    });

    assert.equal(data.guildId, 'guild-001');
    assert.equal(data.reason, 'manual_stop');
    assert.equal(data.transcriptCount, 5);
    assert.ok(data.speakerMap instanceof Map);
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
    assert.equal(data.speakerMap.get(2), 'Carol');
    assert.equal(data.speakers.length, 3);

    // Serializable without errors (ready for LLM summarizer)
    const serializable = toSerializable(data);
    assert.doesNotThrow(() => JSON.stringify(serializable));
    assert.equal(typeof serializable.speakerMap, 'object');
    assert.equal(serializable.speakerMap['0'], 'Alice');
  });

  it('should produce valid data from channel_empty auto-disconnect (direct mode)', async () => {
    const transcript = makeDiarizedTranscript().slice(0, 3); // partial session
    const speakerMap = new Map([[0, 'Alice'], [1, 'Bob']]);

    const session = makeSession({
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => ({ transcript, filePath: null })),
        speakerMap,
      },
    });
    // Direct mode (session provided — already removed from manager map)
    const sm = { getSession: mock.fn(() => null), stopSession: mock.fn() };

    const cleanupResult = await cleanupSession({
      sessionManager: sm,
      guildId: 'guild-001',
      reason: 'channel_empty',
      session,
    });

    const data = aggregateFromCleanupResult({
      cleanupResult,
      session,
      speakerMap: cleanupResult.speakerMap,
    });

    assert.equal(data.reason, 'channel_empty');
    assert.equal(data.transcriptCount, 3);
    assert.ok(data.speakerMap.get(0) === 'Alice');
    assert.ok(data.speakerMap.get(1) === 'Bob');
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: speakerMap propagation through the stop command pathway
// ---------------------------------------------------------------------------

describe('speakerMap propagation: cleanupSession → generateAndDeliverMinutes input', () => {
  it('should have result.speakerMap available for transcriptResult construction', async () => {
    const speakerMap = new Map([[0, '홍길동'], [1, 'Jane']]);
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Speaker 0', text: '좋은 아침입니다.', start: 0, end: 2 }),
      makeEntry({ speaker: 1, speakerName: 'Speaker 1', text: 'Good morning!', start: 3, end: 5 }),
    ];

    const session = makeSession({
      language: 'multi',
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => ({ transcript, filePath: '/data/test.json' })),
        speakerMap,
      },
    });
    const sm = makeMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-001', reason: 'manual_stop' });

    // Verify the speakerMap that stop.js would include in transcriptResult
    const transcriptResult = {
      transcript: result.transcript,
      filePath: result.transcriptFilePath,
      speakerMap: result.speakerMap, // ← the key fix in stop.js and index.js
    };

    assert.ok(transcriptResult.speakerMap instanceof Map);
    assert.equal(transcriptResult.speakerMap.get(0), '홍길동');
    assert.equal(transcriptResult.speakerMap.get(1), 'Jane');

    // Verify this propagates correctly into aggregateSessionData
    const data = aggregateSessionData({
      session,
      coordinatorResult: {
        transcript: transcriptResult.transcript,
        filePath: transcriptResult.filePath,
        speakerMap: transcriptResult.speakerMap,
      },
      speakerMap: transcriptResult.speakerMap,
      durationSeconds: result.duration,
      reason: result.reason,
    });

    assert.equal(data.speakerMap.get(0), '홍길동');
    assert.equal(data.speakerMap.get(1), 'Jane');
    assert.equal(data.transcript[0].speakerName, 'Speaker 0'); // original name in entry
    // Speaker stats use the resolved names from the map
    const speaker0 = data.speakers.find(s => s.speakerLabel === 0);
    assert.equal(speaker0.displayName, '홍길동');
  });

  it('should gracefully aggregate when speakerMap is null (infers from transcript entries)', () => {
    const transcript = [
      makeEntry({ speaker: 0, speakerName: 'Alice', text: 'Hi.', start: 0, end: 1 }),
      makeEntry({ speaker: 1, speakerName: 'Bob',   text: 'Hello.', start: 2, end: 3 }),
    ];
    const session = makeSession();

    // No explicit speakerMap (result.speakerMap = null when coordinator has no mappings)
    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript, filePath: null, speakerMap: null },
      speakerMap: null,
      durationSeconds: 5,
      reason: 'manual_stop',
    });

    // Falls back to transcript-inferred speaker names
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
    assert.equal(data.speakers.find(s => s.speakerLabel === 0).displayName, 'Alice');
  });
});
