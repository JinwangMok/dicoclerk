/**
 * Tests for the Minutes Data Aggregator
 *
 * Covers:
 * - aggregateSessionData() core behaviour
 * - Transcript normalisation (sorting, field defaults, invalid entry filtering)
 * - Speaker map resolution (priority order, Map vs plain-object inputs)
 * - Per-speaker statistics computation
 * - Participant ID extraction from Set / array
 * - Guild / channel name resolution
 * - aggregateFromCleanupResult() convenience wrapper
 * - toSerializable() JSON conversion
 * - toFormatterMetadata() shape conversion
 * - Edge cases: empty transcript, missing guild, zero duration, bad inputs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateSessionData,
  aggregateFromCleanupResult,
  toSerializable,
  toFormatterMetadata,
} from '../src/minutes/aggregator.js';

// ---------------------------------------------------------------------------
// Shared factories
// ---------------------------------------------------------------------------

function makeSession(overrides = {}) {
  return {
    guildId: 'guild-001',
    voiceChannelId: 'vc-001',
    textChannelId: 'tc-001',
    language: 'en',
    startedBy: 'TestUser#0001',
    startedAt: new Date('2025-06-01T09:00:00Z'),
    participants: new Set(['uid-a', 'uid-b']),
    transcript: [],
    status: 'stopped',
    sessionId: 'session-abc-123',
    ...overrides,
  };
}

function makeTranscriptEntry(overrides = {}) {
  return {
    speaker: 0,
    speakerName: 'Alice',
    userId: 'uid-a',
    text: 'Hello world.',
    confidence: 0.95,
    speakerConfidence: 0.87,
    start: 0,
    end: 2,
    timestamp: Date.now(),
    isFinal: true,
    ...overrides,
  };
}

function makeGuild(channelName = 'General Voice') {
  const channelsCache = new Map();
  channelsCache.set('vc-001', { id: 'vc-001', name: channelName });
  return {
    id: 'guild-001',
    name: 'Test Server',
    channels: { cache: channelsCache },
  };
}

function makeCleanupResult(overrides = {}) {
  return {
    success: true,
    reason: 'manual_stop',
    duration: 300,
    durationMinutes: 5,
    durationSeconds: 0,
    participantCount: 2,
    transcriptCount: 3,
    transcript: [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'First.', start: 0, end: 2 }),
      makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'Second.', userId: 'uid-b', start: 3, end: 5 }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Third.', start: 6, end: 8 }),
    ],
    transcriptFilePath: '/data/transcripts/test.json',
    warnings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// aggregateSessionData — core shape
// ---------------------------------------------------------------------------

describe('aggregateSessionData — required fields and shape', () => {
  it('should return a SessionMinutesData with all required top-level fields', () => {
    const session = makeSession();
    const data = aggregateSessionData({
      session,
      durationSeconds: 300,
      reason: 'manual_stop',
    });

    // Identity
    assert.equal(typeof data.sessionId, 'string', 'sessionId must be a string');
    assert.ok(data.sessionId.length > 0, 'sessionId must not be empty');

    // Discord IDs
    assert.equal(data.guildId, 'guild-001');
    assert.equal(data.channelId, 'vc-001');
    assert.equal(data.textChannelId, 'tc-001');

    // Names (no guild supplied → unknowns)
    assert.equal(data.guildName, 'Unknown Server');
    assert.equal(data.channelName, 'Unknown Channel');

    // Session meta
    assert.equal(data.language, 'en');
    assert.equal(data.startedBy, 'TestUser#0001');
    assert.ok(data.startedAt instanceof Date, 'startedAt must be a Date');
    assert.ok(data.endedAt instanceof Date, 'endedAt must be a Date');
    assert.equal(data.durationSeconds, 300);
    assert.equal(data.reason, 'manual_stop');

    // Participants
    assert.ok(Array.isArray(data.participantIds));
    assert.deepEqual(new Set(data.participantIds), new Set(['uid-a', 'uid-b']));

    // Speaker map
    assert.ok(data.speakerMap instanceof Map, 'speakerMap must be a Map');

    // Speakers array
    assert.ok(Array.isArray(data.speakers));

    // Transcript
    assert.ok(Array.isArray(data.transcript));
    assert.equal(typeof data.transcriptCount, 'number');

    // Audit
    assert.equal(data.transcriptFilePath, null);
    assert.ok(Array.isArray(data.warnings));
    assert.equal(typeof data.aggregatedAt, 'string');
  });

  it('should use sessionId from session when provided', () => {
    const session = makeSession({ sessionId: 'my-session-id' });
    const data = aggregateSessionData({ session, durationSeconds: 60, reason: 'manual_stop' });
    assert.equal(data.sessionId, 'my-session-id');
  });

  it('should compute endedAt = startedAt + durationSeconds', () => {
    const startedAt = new Date('2025-01-01T10:00:00Z');
    const session = makeSession({ startedAt });
    const data = aggregateSessionData({ session, durationSeconds: 3600, reason: 'manual_stop' });

    const expectedEnd = new Date(startedAt.getTime() + 3600 * 1000);
    assert.equal(data.endedAt.toISOString(), expectedEnd.toISOString());
  });

  it('should resolve guild and channel names when guild is supplied', () => {
    const session = makeSession();
    const guild = makeGuild('Design Review');
    const data = aggregateSessionData({ session, guild, durationSeconds: 60, reason: 'manual_stop' });

    assert.equal(data.guildName, 'Test Server');
    assert.equal(data.channelName, 'Design Review');
  });

  it('should store transcriptFilePath from coordinatorResult', () => {
    const session = makeSession();
    const coordinatorResult = { transcript: [], filePath: '/data/transcripts/foo.json' };
    const data = aggregateSessionData({
      session,
      coordinatorResult,
      durationSeconds: 60,
      reason: 'manual_stop',
    });
    assert.equal(data.transcriptFilePath, '/data/transcripts/foo.json');
  });

  it('should propagate pre-existing warnings', () => {
    const session = makeSession();
    const data = aggregateSessionData({
      session,
      durationSeconds: 60,
      reason: 'manual_stop',
      warnings: ['audio coordinator was not running'],
    });
    assert.ok(data.warnings.includes('audio coordinator was not running'));
  });

  it('should throw when session is not provided', () => {
    assert.throws(
      () => aggregateSessionData({ session: null, durationSeconds: 60, reason: 'manual_stop' }),
      /session is required/
    );
  });
});

// ---------------------------------------------------------------------------
// Transcript normalisation
// ---------------------------------------------------------------------------

describe('aggregateSessionData — transcript normalisation', () => {
  it('should use coordinatorResult.transcript over session.transcript', () => {
    const session = makeSession({
      transcript: [makeTranscriptEntry({ text: 'Session fallback.' })],
    });
    const coordinatorResult = {
      transcript: [makeTranscriptEntry({ text: 'Coordinator transcript.' })],
      filePath: null,
    };
    const data = aggregateSessionData({
      session,
      coordinatorResult,
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.transcript.length, 1);
    assert.equal(data.transcript[0].text, 'Coordinator transcript.');
  });

  it('should fall back to session.transcript when coordinator has none', () => {
    const session = makeSession({
      transcript: [makeTranscriptEntry({ text: 'Fallback entry.' })],
    });
    const data = aggregateSessionData({
      session,
      coordinatorResult: { transcript: [], filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.transcript.length, 1);
    assert.equal(data.transcript[0].text, 'Fallback entry.');
  });

  it('should sort transcript entries by start time', () => {
    const entries = [
      makeTranscriptEntry({ text: 'Third.', start: 20, end: 25 }),
      makeTranscriptEntry({ text: 'First.', start: 0, end: 5 }),
      makeTranscriptEntry({ text: 'Second.', start: 10, end: 15 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 30,
      reason: 'manual_stop',
    });
    assert.equal(data.transcript[0].text, 'First.');
    assert.equal(data.transcript[1].text, 'Second.');
    assert.equal(data.transcript[2].text, 'Third.');
  });

  it('should skip entries with empty or missing text and add a warning', () => {
    const entries = [
      makeTranscriptEntry({ text: 'Valid.' }),
      makeTranscriptEntry({ text: '' }),           // empty string
      makeTranscriptEntry({ text: '   ' }),         // whitespace only
      null,                                          // null entry
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.transcript.length, 1);
    assert.equal(data.transcript[0].text, 'Valid.');
    assert.ok(data.warnings.length > 0, 'Should add warnings for skipped entries');
  });

  it('should fill missing optional fields with sensible defaults', () => {
    const minimalEntry = { text: 'Minimal entry.' };
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: [minimalEntry], filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    const entry = data.transcript[0];
    assert.equal(entry.text, 'Minimal entry.');
    assert.equal(entry.speaker, -1);
    assert.equal(typeof entry.speakerName, 'string');
    assert.equal(entry.userId, null);
    assert.equal(entry.confidence, 0);
    assert.equal(entry.start, 0);
    assert.equal(entry.end, 0);
    assert.equal(typeof entry.timestamp, 'number');
    assert.equal(entry.isFinal, true);
  });

  it('should set transcriptCount to match transcript array length', () => {
    const entries = [
      makeTranscriptEntry({ text: 'One.', start: 0 }),
      makeTranscriptEntry({ text: 'Two.', start: 5 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.transcriptCount, 2);
    assert.equal(data.transcript.length, data.transcriptCount);
  });

  it('should add a warning for empty transcript', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.ok(data.warnings.some(w => w.includes('No transcript')));
  });
});

// ---------------------------------------------------------------------------
// Speaker map resolution
// ---------------------------------------------------------------------------

describe('aggregateSessionData — speaker map resolution', () => {
  it('should build speakerMap from transcript speakerName fields when no explicit map given', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Hi.' }),
      makeTranscriptEntry({ speaker: 1, speakerName: 'Bob', text: 'Hello.' }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
  });

  it('should prefer externalSpeakerMap over transcript-inferred names', () => {
    const entries = [makeTranscriptEntry({ speaker: 0, speakerName: 'Generic Speaker 0', text: 'Hi.' })];
    const externalMap = new Map([[0, 'Alice']]);
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      speakerMap: externalMap,
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.speakerMap.get(0), 'Alice');
  });

  it('should accept a plain object as externalSpeakerMap', () => {
    const entries = [makeTranscriptEntry({ speaker: 0, speakerName: 'X', text: 'Test.' })];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: {
        transcript: entries,
        filePath: null,
        speakerMap: { '0': 'Alice', '1': 'Bob' },
      },
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.speakerMap.get(0), 'Alice');
    assert.equal(data.speakerMap.get(1), 'Bob');
  });

  it('should merge both coordinatorResult.speakerMap and externalSpeakerMap, with external winning', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'OldAlice', text: 'A.' }),
      makeTranscriptEntry({ speaker: 1, speakerName: 'OldBob',   text: 'B.' }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: {
        transcript: entries,
        filePath: null,
        speakerMap: { '0': 'CoordAlice', '1': 'CoordBob' },  // priority 2
      },
      speakerMap: new Map([[0, 'ExternalAlice']]),              // priority 1 (wins for 0)
      durationSeconds: 10,
      reason: 'manual_stop',
    });
    assert.equal(data.speakerMap.get(0), 'ExternalAlice', 'External should win for label 0');
    assert.equal(data.speakerMap.get(1), 'CoordBob',      'Coordinator value kept for label 1');
  });
});

// ---------------------------------------------------------------------------
// Speaker statistics
// ---------------------------------------------------------------------------

describe('aggregateSessionData — per-speaker statistics', () => {
  it('should compute correct utterance counts per speaker', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'One.', start: 0, end: 2 }),
      makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'Two.', start: 3, end: 5 }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Three.', start: 6, end: 8 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });

    const alice = data.speakers.find(s => s.speakerLabel === 0);
    const bob   = data.speakers.find(s => s.speakerLabel === 1);

    assert.ok(alice, 'Alice speaker info should exist');
    assert.ok(bob,   'Bob speaker info should exist');
    assert.equal(alice.utteranceCount, 2);
    assert.equal(bob.utteranceCount, 1);
  });

  it('should compute total speaking time correctly', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Hi.', start: 0, end: 3 }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Bye.', start: 10, end: 14 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 15,
      reason: 'manual_stop',
    });

    const alice = data.speakers.find(s => s.speakerLabel === 0);
    // 3 + 4 = 7 seconds
    assert.equal(alice.totalSpeakingSeconds, 7);
  });

  it('should compute average confidence correctly', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'A.', confidence: 0.9, start: 0, end: 1 }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'B.', confidence: 0.8, start: 2, end: 3 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 5,
      reason: 'manual_stop',
    });

    const alice = data.speakers.find(s => s.speakerLabel === 0);
    assert.ok(Math.abs(alice.avgConfidence - 0.85) < 0.001, `Expected ~0.85, got ${alice.avgConfidence}`);
  });

  it('should attach userId to speaker info from first identified utterance', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', userId: 'uid-alice', text: 'Hello.', start: 0, end: 1 }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', userId: null, text: 'More.', start: 2, end: 3 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 5,
      reason: 'manual_stop',
    });

    const alice = data.speakers.find(s => s.speakerLabel === 0);
    assert.equal(alice.userId, 'uid-alice');
  });

  it('should sort speakers by speaker label ascending', () => {
    const entries = [
      makeTranscriptEntry({ speaker: 2, speakerName: 'Carol', text: 'C.', start: 0 }),
      makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'A.', start: 1 }),
      makeTranscriptEntry({ speaker: 1, speakerName: 'Bob',   text: 'B.', start: 2 }),
    ];
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: { transcript: entries, filePath: null },
      durationSeconds: 10,
      reason: 'manual_stop',
    });

    assert.equal(data.speakers[0].speakerLabel, 0);
    assert.equal(data.speakers[1].speakerLabel, 1);
    assert.equal(data.speakers[2].speakerLabel, 2);
  });
});

// ---------------------------------------------------------------------------
// Participants
// ---------------------------------------------------------------------------

describe('aggregateSessionData — participant IDs', () => {
  it('should extract participant IDs from a Set', () => {
    const session = makeSession({ participants: new Set(['uid-1', 'uid-2', 'uid-3']) });
    const data = aggregateSessionData({ session, durationSeconds: 30, reason: 'manual_stop' });
    assert.deepEqual(new Set(data.participantIds), new Set(['uid-1', 'uid-2', 'uid-3']));
  });

  it('should extract participant IDs from an array', () => {
    const session = makeSession({ participants: ['uid-a', 'uid-b'] });
    const data = aggregateSessionData({ session, durationSeconds: 30, reason: 'manual_stop' });
    assert.deepEqual(new Set(data.participantIds), new Set(['uid-a', 'uid-b']));
  });

  it('should return empty array when participants is null/undefined', () => {
    const session = makeSession({ participants: null });
    const data = aggregateSessionData({ session, durationSeconds: 30, reason: 'manual_stop' });
    assert.deepEqual(data.participantIds, []);
  });

  it('should return empty array when participants is an empty Set', () => {
    const session = makeSession({ participants: new Set() });
    const data = aggregateSessionData({ session, durationSeconds: 30, reason: 'manual_stop' });
    assert.deepEqual(data.participantIds, []);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('aggregateSessionData — edge cases', () => {
  it('should handle zero durationSeconds', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      durationSeconds: 0,
      reason: 'manual_stop',
    });
    assert.equal(data.durationSeconds, 0);
    assert.equal(data.endedAt.getTime(), data.startedAt.getTime());
  });

  it('should handle negative durationSeconds with a warning and default to 0', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      durationSeconds: -5,
      reason: 'manual_stop',
    });
    assert.equal(data.durationSeconds, 0);
    assert.ok(data.warnings.some(w => w.includes('Invalid durationSeconds')));
  });

  it('should handle missing guild gracefully', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      guild: null,
      durationSeconds: 60,
      reason: 'manual_stop',
    });
    assert.equal(data.guildName, 'Unknown Server');
    assert.equal(data.channelName, 'Unknown Channel');
  });

  it('should handle session with string startedAt (not a Date)', () => {
    const session = makeSession({ startedAt: '2025-03-15T08:30:00Z' });
    const data = aggregateSessionData({ session, durationSeconds: 120, reason: 'channel_empty' });
    assert.ok(data.startedAt instanceof Date);
    assert.equal(data.startedAt.toISOString(), '2025-03-15T08:30:00.000Z');
  });

  it('should handle all session end reasons', () => {
    const reasons = ['manual_stop', 'channel_empty', 'connection_destroyed', 'shutdown'];
    for (const reason of reasons) {
      const data = aggregateSessionData({ session: makeSession(), durationSeconds: 10, reason });
      assert.equal(data.reason, reason);
    }
  });

  it('should default reason to "unknown" when not provided', () => {
    const data = aggregateSessionData({ session: makeSession(), durationSeconds: 10 });
    assert.equal(data.reason, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// aggregateFromCleanupResult
// ---------------------------------------------------------------------------

describe('aggregateFromCleanupResult', () => {
  it('should produce the same shape as aggregateSessionData', () => {
    const session = makeSession();
    const cleanupResult = makeCleanupResult();

    const data = aggregateFromCleanupResult({ cleanupResult, session, guild: makeGuild() });

    assert.equal(data.guildId, 'guild-001');
    assert.equal(data.channelName, 'General Voice');
    assert.equal(data.durationSeconds, 300);
    assert.equal(data.reason, 'manual_stop');
    assert.equal(data.transcriptCount, 3);
    assert.ok(data.speakers.length > 0);
  });

  it('should carry through warnings from cleanupResult', () => {
    const session = makeSession();
    const cleanupResult = makeCleanupResult({ warnings: ['Audio coordinator was not running'] });

    const data = aggregateFromCleanupResult({ cleanupResult, session });
    assert.ok(data.warnings.includes('Audio coordinator was not running'));
  });

  it('should use speakerMap when provided', () => {
    const session = makeSession();
    const cleanupResult = makeCleanupResult();
    const speakerMap = new Map([[0, 'Alice Resolved'], [1, 'Bob Resolved']]);

    const data = aggregateFromCleanupResult({ cleanupResult, session, speakerMap });
    assert.equal(data.speakerMap.get(0), 'Alice Resolved');
    assert.equal(data.speakerMap.get(1), 'Bob Resolved');
  });

  it('should set transcriptFilePath from cleanupResult.transcriptFilePath', () => {
    const session = makeSession();
    const cleanupResult = makeCleanupResult({ transcriptFilePath: '/data/transcripts/cleanup.json' });

    const data = aggregateFromCleanupResult({ cleanupResult, session });
    assert.equal(data.transcriptFilePath, '/data/transcripts/cleanup.json');
  });

  it('should handle cleanupResult with empty transcript', () => {
    const session = makeSession();
    const cleanupResult = makeCleanupResult({ transcript: [], transcriptCount: 0 });

    const data = aggregateFromCleanupResult({ cleanupResult, session });
    assert.equal(data.transcriptCount, 0);
    assert.deepEqual(data.transcript, []);
  });
});

// ---------------------------------------------------------------------------
// toSerializable
// ---------------------------------------------------------------------------

describe('toSerializable', () => {
  it('should convert speakerMap Map to a plain object', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: {
        transcript: [makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Hi.' })],
        filePath: null,
      },
      durationSeconds: 30,
      reason: 'manual_stop',
    });

    const serializable = toSerializable(data);
    assert.ok(!(serializable.speakerMap instanceof Map), 'speakerMap should not be a Map');
    assert.equal(typeof serializable.speakerMap, 'object');
    assert.equal(serializable.speakerMap['0'], 'Alice');
  });

  it('should convert Date objects to ISO strings', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      durationSeconds: 60,
      reason: 'manual_stop',
    });

    const serializable = toSerializable(data);
    assert.equal(typeof serializable.startedAt, 'string', 'startedAt should be an ISO string');
    assert.equal(typeof serializable.endedAt,   'string', 'endedAt should be an ISO string');
    assert.doesNotThrow(() => new Date(serializable.startedAt));
    assert.doesNotThrow(() => new Date(serializable.endedAt));
  });

  it('should be JSON-serializable without errors', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      coordinatorResult: {
        transcript: [makeTranscriptEntry()],
        filePath: '/tmp/transcript.json',
      },
      durationSeconds: 120,
      reason: 'channel_empty',
    });

    assert.doesNotThrow(() => JSON.stringify(toSerializable(data)));
  });
});

// ---------------------------------------------------------------------------
// toFormatterMetadata
// ---------------------------------------------------------------------------

describe('toFormatterMetadata', () => {
  it('should return an object matching the SessionMetadata shape for formatter.js', () => {
    const session = makeSession();
    const guild   = makeGuild('Voice Lounge');
    const data = aggregateSessionData({
      session,
      guild,
      coordinatorResult: {
        transcript: [
          makeTranscriptEntry({ speaker: 0, speakerName: 'Alice', text: 'Agenda item one.' }),
        ],
        filePath: null,
      },
      durationSeconds: 450,
      reason: 'manual_stop',
    });

    const meta = toFormatterMetadata(data);

    assert.equal(meta.guildName, 'Test Server');
    assert.equal(meta.channelName, 'Voice Lounge');
    assert.ok(meta.startedAt instanceof Date);
    assert.equal(meta.durationSeconds, 450);
    assert.equal(meta.startedBy, 'TestUser#0001');
    assert.equal(meta.language, 'en');
    assert.ok(meta.speakerMap instanceof Map, 'speakerMap must be a Map');
    assert.equal(meta.speakerMap.get(0), 'Alice');
  });

  it('should return a defensive copy of speakerMap', () => {
    const data = aggregateSessionData({
      session: makeSession(),
      durationSeconds: 60,
      reason: 'manual_stop',
    });

    const meta = toFormatterMetadata(data);
    meta.speakerMap.set(99, 'Injected');

    // Original data's map should be unaffected
    assert.ok(!data.speakerMap.has(99), 'Original speakerMap should not be mutated');
  });
});
