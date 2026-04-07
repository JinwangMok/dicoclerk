/**
 * Tests for Sub-AC 2.3: In-memory transcript store per voice session
 *
 * Covers:
 * - TranscriptSession lifecycle (create → accumulate → stop → export)
 * - TranscriptStore multi-session management
 * - Speaker registration with retroactive updates
 * - Structured data export for minutes generation
 * - Integration with AudioSessionCoordinator (via mocks)
 * - Session lifecycle: start triggers store creation, stop returns structured data
 * - 5-10 concurrent participants support
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  TranscriptSession,
  TranscriptStore,
} from '../src/stt/transcript-store.js';

// ---------------------------------------------------------------------------
// Helpers / fixtures
// ---------------------------------------------------------------------------

/** Build a minimal TranscriptEvent as emitted by DeepgramStreamingClient */
function makeTranscriptEvent({
  text = 'Hello world',
  speaker = 0,
  isFinal = true,
  speechFinal = false,
  confidence = 0.95,
  start = 0.0,
  end = 1.0,
  words = [],
} = {}) {
  return { text, speaker, isFinal, speechFinal, confidence, start, end, words };
}

/** Build a minimal Deepgram Results payload (for addFromPayload path) */
function makeDeepgramPayload(words, {
  isFinal = true,
  speechFinal = false,
  start = 0.0,
  duration = 2.0,
} = {}) {
  const transcript = words.map(w => w.punctuated_word ?? w.word ?? '').join(' ');
  return {
    type: 'Results',
    is_final: isFinal,
    speech_final: speechFinal,
    start,
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

function makeWord(word, { speaker = 0, start = 0, end = 0.3, confidence = 0.95 } = {}) {
  return {
    word: word.toLowerCase(),
    punctuated_word: word,
    speaker,
    start,
    end,
    confidence,
  };
}

// ---------------------------------------------------------------------------
// TranscriptSession — lifecycle
// ---------------------------------------------------------------------------

describe('TranscriptSession lifecycle', () => {
  let session;

  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 'guild-001-ts' });
  });

  it('creates with correct sessionId', () => {
    assert.equal(session.sessionId, 'guild-001-ts');
  });

  it('starts empty', () => {
    assert.equal(session.entryCount, 0);
    assert.equal(session.totalProcessed, 0);
    assert.equal(session.duplicateCount, 0);
    assert.deepEqual(session.entries, []);
  });

  it('throws when sessionId is missing', () => {
    assert.throws(() => new TranscriptSession({}), /sessionId is required/);
  });

  it('accumulates final transcript entries via addFromEvent', () => {
    const e1 = makeTranscriptEvent({ text: 'Hello', speaker: 0, start: 0, end: 1 });
    const e2 = makeTranscriptEvent({ text: 'World', speaker: 1, start: 1, end: 2 });

    session.addFromEvent(e1);
    session.addFromEvent(e2);

    assert.equal(session.entryCount, 2);
    assert.equal(session.entries[0].text, 'Hello');
    assert.equal(session.entries[1].text, 'World');
  });

  it('skips non-final events by default', () => {
    const interim = makeTranscriptEvent({ text: 'Hel', isFinal: false });
    const result = session.addFromEvent(interim);
    assert.equal(result, null);
    assert.equal(session.entryCount, 0);
  });

  it('stores non-final events when includePreliminary=true', () => {
    const interim = makeTranscriptEvent({ text: 'Hel', isFinal: false });
    const result = session.addFromEvent(interim, { includePreliminary: true });
    assert.notEqual(result, null);
    assert.equal(session.entryCount, 1);
  });

  it('skips empty-text events', () => {
    const empty = makeTranscriptEvent({ text: '  ' });
    const result = session.addFromEvent(empty);
    assert.equal(result, null);
    assert.equal(session.entryCount, 0);
  });

  it('populates required entry fields', () => {
    session.addFromEvent(makeTranscriptEvent({
      text: '안녕하세요',
      speaker: 0,
      isFinal: true,
      confidence: 0.88,
      start: 1.5,
      end: 2.5,
    }));

    const entry = session.entries[0];
    assert.equal(entry.sessionId, 'guild-001-ts');
    assert.equal(entry.text, '안녕하세요');
    assert.equal(entry.speakerLabel, 0);
    assert.equal(entry.confidence, 0.88);
    assert.equal(entry.start, 1.5);
    assert.equal(entry.end, 2.5);
    assert.equal(entry.isFinal, true);
    assert.ok(typeof entry.wallClockMs === 'number');
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — speaker registration
// ---------------------------------------------------------------------------

describe('TranscriptSession speaker registration', () => {
  let session;

  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 'guild-002-ts' });
  });

  it('uses "Speaker N" placeholder for unregistered speakers', () => {
    session.addFromEvent(makeTranscriptEvent({ speaker: 2, text: 'Hi' }));
    assert.equal(session.entries[0].speakerName, 'Speaker 2');
    assert.equal(session.entries[0].userId, null);
  });

  it('resolves speaker to display name after registerSpeaker', () => {
    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'Hello' }));
    session.registerSpeaker(0, 'user-alice', 'Alice');
    // Retroactive update
    assert.equal(session.entries[0].speakerName, 'Alice');
    assert.equal(session.entries[0].userId, 'user-alice');
  });

  it('registers speaker before adding entry and uses correct name immediately', () => {
    session.registerSpeaker(1, 'user-bob', 'Bob');
    session.addFromEvent(makeTranscriptEvent({ speaker: 1, text: 'Good morning' }));
    assert.equal(session.entries[0].speakerName, 'Bob');
    assert.equal(session.entries[0].userId, 'user-bob');
  });

  it('retroactively updates all existing entries for a speaker', () => {
    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'A', start: 0, end: 1 }));
    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'B', start: 1, end: 2 }));
    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'C', start: 2, end: 3 }));

    session.registerSpeaker(0, 'user-charlie', 'Charlie');
    for (const entry of session.entries) {
      assert.equal(entry.speakerName, 'Charlie');
      assert.equal(entry.userId, 'user-charlie');
    }
  });

  it('supports registering multiple speakers independently', () => {
    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'First' }));
    session.addFromEvent(makeTranscriptEvent({ speaker: 1, text: 'Second' }));
    session.addFromEvent(makeTranscriptEvent({ speaker: 2, text: 'Third' }));

    session.registerSpeaker(0, 'uid-0', 'Alice');
    session.registerSpeaker(1, 'uid-1', 'Bob');
    // Speaker 2 left unresolved

    assert.equal(session.entries[0].speakerName, 'Alice');
    assert.equal(session.entries[1].speakerName, 'Bob');
    assert.equal(session.entries[2].speakerName, 'Speaker 2');
    assert.equal(session.entries[2].userId, null);
  });

  it('supports resolveSpeaker() lookup', () => {
    session.registerSpeaker(3, 'uid-3', 'Dave');
    const { userId, speakerName } = session.resolveSpeaker(3);
    assert.equal(userId, 'uid-3');
    assert.equal(speakerName, 'Dave');
  });

  it('resolveSpeaker falls back gracefully for unknown labels', () => {
    const { userId, speakerName } = session.resolveSpeaker(99);
    assert.equal(userId, null);
    assert.equal(speakerName, 'Speaker 99');
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — 5-10 concurrent participants
// ---------------------------------------------------------------------------

describe('TranscriptSession concurrent participants (5-10 speakers)', () => {
  it('handles 10 simultaneous speakers without confusion', () => {
    const session = new TranscriptSession({ sessionId: 'guild-multi' });

    // Register all 10 speakers
    for (let i = 0; i < 10; i++) {
      session.registerSpeaker(i, `uid-${i}`, `Speaker_${i}`);
    }

    // Each speaker says something
    for (let i = 0; i < 10; i++) {
      session.addFromEvent(makeTranscriptEvent({
        speaker: i,
        text: `Hello from speaker ${i}`,
        start: i * 1.0,
        end: i * 1.0 + 0.9,
      }));
    }

    assert.equal(session.entryCount, 10);

    const stats = session.getSpeakerStats();
    assert.equal(stats.size, 10);

    for (let i = 0; i < 10; i++) {
      const key = `uid-${i}`;
      assert.ok(stats.has(key), `Missing speaker uid-${i}`);
      assert.equal(stats.get(key).speakerName, `Speaker_${i}`);
      assert.equal(stats.get(key).entryCount, 1);
    }
  });

  it('accumulates multiple turns per speaker correctly', () => {
    const session = new TranscriptSession({ sessionId: 'guild-turns' });
    session.registerSpeaker(0, 'uid-a', 'Alice');
    session.registerSpeaker(1, 'uid-b', 'Bob');

    // Simulate alternating dialogue
    const events = [
      { speaker: 0, text: 'Good morning', start: 0, end: 1 },
      { speaker: 1, text: 'Hey there', start: 1, end: 2 },
      { speaker: 0, text: 'How are you', start: 2, end: 3 },
      { speaker: 1, text: 'Im fine thanks', start: 3, end: 4 },
      { speaker: 0, text: 'Great', start: 4, end: 5 },
    ];

    for (const e of events) {
      session.addFromEvent(makeTranscriptEvent(e));
    }

    assert.equal(session.entryCount, 5);
    assert.equal(session.getEntriesBySpeaker(0).length, 3);
    assert.equal(session.getEntriesBySpeaker(1).length, 2);
    assert.equal(session.getEntriesByUser('uid-a').length, 3);
    assert.equal(session.getEntriesByUser('uid-b').length, 2);
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — export methods
// ---------------------------------------------------------------------------

describe('TranscriptSession export methods', () => {
  let session;

  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 'guild-003-ts' });
    session.registerSpeaker(0, 'uid-alice', 'Alice');
    session.registerSpeaker(1, 'uid-bob', 'Bob');

    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: '안녕하세요', start: 5, end: 6 }));
    session.addFromEvent(makeTranscriptEvent({ speaker: 1, text: 'Hello everyone', start: 7, end: 8 }));
    session.addFromEvent(makeTranscriptEvent({ speaker: 0, text: '반갑습니다', start: 9, end: 10 }));
  });

  it('toPlainText() produces readable timestamped lines', () => {
    const text = session.toPlainText();
    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.match(lines[0], /\[00:05\] Alice: 안녕하세요/);
    assert.match(lines[1], /\[00:07\] Bob: Hello everyone/);
    assert.match(lines[2], /\[00:09\] Alice: 반갑습니다/);
  });

  it('toStructuredData() returns JSON-serialisable array', () => {
    const data = session.toStructuredData();
    assert.equal(data.length, 3);

    const first = data[0];
    assert.equal(first.sessionId, 'guild-003-ts');
    assert.equal(first.speakerName, 'Alice');
    assert.equal(first.userId, 'uid-alice');
    assert.equal(first.text, '안녕하세요');
    assert.equal(first.speakerLabel, 0);
    assert.equal(first.isFinal, true);

    // Must be JSON-round-trippable
    const serialised = JSON.stringify(data);
    const parsed = JSON.parse(serialised);
    assert.equal(parsed[0].text, '안녕하세요');
  });

  it('getSummary() returns correct aggregate stats', () => {
    const summary = session.getSummary();
    assert.equal(summary.sessionId, 'guild-003-ts');
    assert.equal(summary.entryCount, 3);
    assert.equal(summary.participantCount, 2);
    assert.ok(summary.totalWords > 0);
    assert.ok(Array.isArray(summary.languages));
    assert.ok(summary.startedAt <= Date.now());
  });

  it('getSpeakerStats() returns per-speaker stats', () => {
    const stats = session.getSpeakerStats();
    assert.ok(stats.has('uid-alice'));
    assert.ok(stats.has('uid-bob'));

    const aliceStats = stats.get('uid-alice');
    assert.equal(aliceStats.entryCount, 2);
    assert.equal(aliceStats.speakerName, 'Alice');
    assert.ok(aliceStats.wordCount > 0);
    assert.ok(aliceStats.totalDuration > 0);
  });

  it('toPlainText() is empty string when no entries', () => {
    const empty = new TranscriptSession({ sessionId: 'empty' });
    assert.equal(empty.toPlainText(), '');
  });

  it('toStructuredData() is empty array when no entries', () => {
    const empty = new TranscriptSession({ sessionId: 'empty' });
    assert.deepEqual(empty.toStructuredData(), []);
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — reset
// ---------------------------------------------------------------------------

describe('TranscriptSession reset', () => {
  it('clears all accumulated data and speaker registry', () => {
    const session = new TranscriptSession({ sessionId: 'guild-reset' });
    session.registerSpeaker(0, 'uid-x', 'Xavier');
    session.addFromEvent(makeTranscriptEvent({ text: 'Test text', speaker: 0 }));

    assert.equal(session.entryCount, 1);

    session.reset();

    assert.equal(session.entryCount, 0);
    assert.equal(session.totalProcessed, 0);
    assert.equal(session.duplicateCount, 0);

    // Speaker registry cleared — unknown speaker returns placeholder
    const { speakerName } = session.resolveSpeaker(0);
    assert.equal(speakerName, 'Speaker 0');
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — addFromPayload (raw Deepgram payload path)
// ---------------------------------------------------------------------------

describe('TranscriptSession.addFromPayload', () => {
  it('parses and stores a single-speaker payload', () => {
    const session = new TranscriptSession({ sessionId: 'payload-test' });
    const words = [
      makeWord('Hello', { speaker: 0, start: 0, end: 0.3 }),
      makeWord('world', { speaker: 0, start: 0.4, end: 0.7 }),
    ];
    const payload = makeDeepgramPayload(words, { isFinal: true });

    const entries = session.addFromPayload(payload);
    assert.equal(entries.length, 1);
    assert.equal(session.entryCount, 1);
    assert.match(session.entries[0].text, /hello|Hello|world|World/i);
  });

  it('handles multi-speaker payload and splits into segments', () => {
    const session = new TranscriptSession({ sessionId: 'payload-multi' });
    const words = [
      makeWord('Good', { speaker: 0, start: 0, end: 0.3 }),
      makeWord('morning', { speaker: 0, start: 0.4, end: 0.8 }),
      makeWord('Hello', { speaker: 1, start: 1.0, end: 1.3 }),
      makeWord('there', { speaker: 1, start: 1.4, end: 1.7 }),
    ];
    const payload = makeDeepgramPayload(words, { isFinal: true });

    const entries = session.addFromPayload(payload);
    assert.equal(entries.length, 2);
    assert.equal(session.entryCount, 2);
    assert.equal(session.entries[0].speakerLabel, 0);
    assert.equal(session.entries[1].speakerLabel, 1);
  });

  it('ignores non-final payload by default', () => {
    const session = new TranscriptSession({ sessionId: 'payload-interim' });
    const words = [makeWord('Hi', { speaker: 0 })];
    const payload = makeDeepgramPayload(words, { isFinal: false });

    const entries = session.addFromPayload(payload);
    assert.equal(entries.length, 0);
    assert.equal(session.entryCount, 0);
  });

  it('stores interim payload when includePreliminary=true', () => {
    const session = new TranscriptSession({ sessionId: 'payload-interim-incl' });
    const words = [makeWord('Hi', { speaker: 0 })];
    const payload = makeDeepgramPayload(words, { isFinal: false });

    const entries = session.addFromPayload(payload, { includePreliminary: true });
    assert.equal(entries.length, 1);
  });

  it('deduplicates repeated payloads', () => {
    const session = new TranscriptSession({ sessionId: 'payload-dedup' });
    const words = [makeWord('Duplicate', { speaker: 0, start: 0, end: 0.5 })];
    const payload = makeDeepgramPayload(words, { isFinal: true, start: 0 });

    session.addFromPayload(payload);
    session.addFromPayload(payload); // Exact repeat → should be deduped

    // First should be stored, second should be deduplicated
    assert.ok(session.duplicateCount >= 1);
    assert.equal(session.entryCount, 1);
  });
});

// ---------------------------------------------------------------------------
// TranscriptStore — multi-session management
// ---------------------------------------------------------------------------

describe('TranscriptStore multi-session management', () => {
  let store;

  beforeEach(() => {
    store = new TranscriptStore();
  });

  it('starts with no sessions', () => {
    assert.equal(store.sessionCount, 0);
    assert.deepEqual(store.sessionIds, []);
  });

  it('createSession() adds a new TranscriptSession', () => {
    const session = store.createSession('session-A');
    assert.ok(session instanceof TranscriptSession);
    assert.equal(store.sessionCount, 1);
    assert.ok(store.hasSession('session-A'));
  });

  it('getSession() retrieves an existing session', () => {
    store.createSession('session-B');
    const session = store.getSession('session-B');
    assert.ok(session instanceof TranscriptSession);
    assert.equal(session.sessionId, 'session-B');
  });

  it('getSession() returns null for unknown session', () => {
    assert.equal(store.getSession('nonexistent'), null);
  });

  it('throws when creating a duplicate session ID', () => {
    store.createSession('dup-session');
    assert.throws(
      () => store.createSession('dup-session'),
      /already exists/,
    );
  });

  it('closeSession() removes session and returns it', () => {
    store.createSession('session-C');
    const closed = store.closeSession('session-C');
    assert.ok(closed instanceof TranscriptSession);
    assert.equal(store.sessionCount, 0);
    assert.equal(store.getSession('session-C'), null);
  });

  it('closeSession() returns null for unknown session', () => {
    assert.equal(store.closeSession('ghost'), null);
  });

  it('supports multiple concurrent sessions', () => {
    const ids = ['g1-ts', 'g2-ts', 'g3-ts', 'g4-ts', 'g5-ts'];
    for (const id of ids) {
      store.createSession(id);
    }

    assert.equal(store.sessionCount, 5);
    assert.deepEqual([...store.sessionIds].sort(), ids.sort());

    // Each session is independent
    for (const id of ids) {
      const s = store.getSession(id);
      assert.equal(s.sessionId, id);
      assert.equal(s.entryCount, 0);
    }
  });

  it('accumulates entries in the correct session', () => {
    const s1 = store.createSession('guild-1-ts');
    const s2 = store.createSession('guild-2-ts');

    s1.addFromEvent(makeTranscriptEvent({ text: 'Guild 1 message', speaker: 0 }));
    s2.addFromEvent(makeTranscriptEvent({ text: 'Guild 2 message', speaker: 0 }));
    s2.addFromEvent(makeTranscriptEvent({ text: 'Guild 2 second', speaker: 1, start: 1, end: 2 }));

    assert.equal(s1.entryCount, 1);
    assert.equal(s2.entryCount, 2);

    // Closing session returns accumulated data
    const closed = store.closeSession('guild-2-ts');
    assert.equal(closed.entryCount, 2);
    assert.equal(closed.entries[0].text, 'Guild 2 message');
  });

  it('clear() removes all sessions', () => {
    store.createSession('x1');
    store.createSession('x2');
    store.clear();
    assert.equal(store.sessionCount, 0);
  });
});

// ---------------------------------------------------------------------------
// TranscriptStore — session lifecycle matches voice session lifecycle
// ---------------------------------------------------------------------------

describe('TranscriptStore session lifecycle integration', () => {
  it('models start→accumulate→stop→export pipeline correctly', () => {
    const store = new TranscriptStore();

    // START: voice session begins → create transcript session
    const sessionId = 'guild-789-1700000000000';
    const txSession = store.createSession(sessionId);

    // Register participants (would come from SpeakerIdentifier)
    txSession.registerSpeaker(0, 'uid-alice', 'Alice');
    txSession.registerSpeaker(1, 'uid-bob', 'Bob');

    // ACCUMULATE: transcript events arrive from Deepgram
    const events = [
      { speaker: 0, text: '회의를 시작하겠습니다', start: 0, end: 2 },
      { speaker: 1, text: 'Sounds good', start: 2, end: 3 },
      { speaker: 0, text: '첫 번째 안건입니다', start: 3, end: 5 },
      { speaker: 1, text: 'I agree with that', start: 5, end: 7 },
      { speaker: 0, text: '다음으로 넘어가겠습니다', start: 7, end: 9 },
    ];

    for (const e of events) {
      txSession.addFromEvent(makeTranscriptEvent(e));
    }

    assert.equal(txSession.entryCount, 5);

    // STOP: voice session ends → close the transcript session
    const finalSession = store.closeSession(sessionId);
    assert.equal(store.sessionCount, 0); // Removed from active map

    // EXPORT: generate meeting minutes data
    const structured = finalSession.toStructuredData();
    assert.equal(structured.length, 5);

    const plainText = finalSession.toPlainText();
    assert.ok(plainText.includes('Alice'));
    assert.ok(plainText.includes('Bob'));
    assert.ok(plainText.includes('회의를 시작하겠습니다'));
    assert.ok(plainText.includes('Sounds good'));

    const summary = finalSession.getSummary();
    assert.equal(summary.entryCount, 5);
    assert.equal(summary.participantCount, 2);

    // Language detection (Korean + English mixed)
    assert.ok(summary.languages.length > 0);
  });

  it('provides data suitable for minutes generator (structured + plain text)', () => {
    const store = new TranscriptStore();
    const txSession = store.createSession('minutes-test');

    txSession.registerSpeaker(0, 'uid-host', 'Host');
    txSession.registerSpeaker(1, 'uid-guest', 'Guest');

    txSession.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'Welcome to the meeting', start: 0, end: 2 }));
    txSession.addFromEvent(makeTranscriptEvent({ speaker: 1, text: 'Thanks for having me', start: 2, end: 4 }));
    txSession.addFromEvent(makeTranscriptEvent({ speaker: 0, text: 'Lets discuss the agenda', start: 4, end: 6 }));

    const closed = store.closeSession('minutes-test');

    // Verify the data is suitable for downstream minutes generation
    const data = closed.toStructuredData();

    // Check all required fields are present for the minutes formatter/aggregator
    for (const entry of data) {
      assert.ok('sessionId' in entry);
      assert.ok('speakerName' in entry);
      assert.ok('userId' in entry);
      assert.ok('text' in entry);
      assert.ok('start' in entry);
      assert.ok('end' in entry);
      assert.ok('confidence' in entry);
      assert.ok('language' in entry);
      assert.ok('isFinal' in entry);
      assert.ok('wallClockMs' in entry);
    }

    // getSpeakerStats provides participant list for minutes header
    const stats = closed.getSpeakerStats();
    assert.ok(stats.has('uid-host'));
    assert.ok(stats.has('uid-guest'));
    assert.equal(stats.get('uid-host').entryCount, 2);
    assert.equal(stats.get('uid-guest').entryCount, 1);
  });
});

// ---------------------------------------------------------------------------
// AudioSessionCoordinator integration (mocked)
// ---------------------------------------------------------------------------

describe('AudioSessionCoordinator transcript store integration', () => {
  /**
   * Creates a minimal mock of AudioSessionCoordinator that exercises
   * the TranscriptSession integration without real Deepgram/Discord connections.
   */
  function createMockCoordinator(sessionId) {
    // Directly test TranscriptSession integration logic
    const txSession = new TranscriptSession({ sessionId });
    const transcriptEntries = [];

    // Simulate what #wireDeepgramEvents does on each final transcript event
    function onTranscriptEvent(event, { userId = null, displayName = null } = {}) {
      if (!event.isFinal || !event.text?.trim()) return null;

      // Register speaker if identified (simulates SpeakerIdentifier result)
      if (userId) {
        txSession.registerSpeaker(event.speaker, userId, displayName);
      }

      // Accumulate in the structured store
      const entry = txSession.addFromEvent(event);

      // Also push to the legacy plain array (for backward compat)
      const legacyEntry = {
        speaker: event.speaker,
        speakerName: entry?.speakerName ?? `Speaker ${event.speaker}`,
        userId,
        text: event.text.trim(),
        confidence: event.confidence,
        start: event.start,
        end: event.end,
        timestamp: Date.now(),
      };
      transcriptEntries.push(legacyEntry);

      return legacyEntry;
    }

    // Simulate stop(): resolves speakers, returns structured data
    function stop() {
      // Final speaker sync (simulates #resolveAllSpeakerNames)
      // (already done inline in onTranscriptEvent for this mock)
      return {
        transcript: transcriptEntries,
        filePath: null,
        transcriptSession: txSession,
      };
    }

    return { onTranscriptEvent, stop, transcriptSession: txSession };
  }

  it('coordinator creates TranscriptSession and accumulates events', () => {
    const coord = createMockCoordinator('guild-coord-test');

    coord.onTranscriptEvent(
      makeTranscriptEvent({ speaker: 0, text: 'First utterance', start: 0, end: 1 }),
      { userId: 'uid-1', displayName: 'Alice' }
    );
    coord.onTranscriptEvent(
      makeTranscriptEvent({ speaker: 1, text: 'Second utterance', start: 1, end: 2 }),
      { userId: 'uid-2', displayName: 'Bob' }
    );

    assert.equal(coord.transcriptSession.entryCount, 2);
  });

  it('stop() returns transcriptSession for minutes generation', () => {
    const coord = createMockCoordinator('guild-stop-test');

    coord.onTranscriptEvent(
      makeTranscriptEvent({ speaker: 0, text: '결론을 내립니다', start: 10, end: 12 }),
      { userId: 'uid-host', displayName: 'Host' }
    );

    const result = coord.stop();

    assert.ok('transcriptSession' in result);
    assert.ok(result.transcriptSession instanceof TranscriptSession);
    assert.equal(result.transcriptSession.entryCount, 1);

    const structured = result.transcriptSession.toStructuredData();
    assert.equal(structured[0].text, '결론을 내립니다');
    assert.equal(structured[0].speakerName, 'Host');
    assert.equal(structured[0].userId, 'uid-host');
  });

  it('stop() result contains all required fields for CleanupResult', () => {
    const coord = createMockCoordinator('guild-cleanup-test');

    coord.onTranscriptEvent(
      makeTranscriptEvent({ speaker: 0, text: 'Test', start: 0, end: 1 }),
      { userId: 'uid-x', displayName: 'Xavier' }
    );

    const result = coord.stop();

    // These fields are what cleanupSession expects
    assert.ok('transcript' in result);
    assert.ok('filePath' in result);
    assert.ok('transcriptSession' in result);
    assert.ok(Array.isArray(result.transcript));
    assert.equal(result.transcript.length, 1);
  });

  it('unresolved speakers fall back gracefully in stop() data', () => {
    const coord = createMockCoordinator('guild-unresolved');

    // Add event without userId (speaker not yet identified)
    coord.onTranscriptEvent(
      makeTranscriptEvent({ speaker: 3, text: 'Mystery speaker', start: 0, end: 1 })
    );

    const result = coord.stop();
    const structured = result.transcriptSession.toStructuredData();
    assert.equal(structured[0].speakerName, 'Speaker 3');
    assert.equal(structured[0].userId, null);
  });
});

// ---------------------------------------------------------------------------
// Language detection integration
// ---------------------------------------------------------------------------

describe('TranscriptSession language detection', () => {
  it('detects Korean entries as ko', () => {
    const session = new TranscriptSession({ sessionId: 'lang-ko' });
    session.addFromEvent(makeTranscriptEvent({ text: '안녕하세요 반갑습니다' }));
    const data = session.toStructuredData();
    assert.equal(data[0].language, 'ko');
  });

  it('detects English entries as en', () => {
    const session = new TranscriptSession({ sessionId: 'lang-en' });
    session.addFromEvent(makeTranscriptEvent({ text: 'Hello everyone good morning' }));
    const data = session.toStructuredData();
    assert.equal(data[0].language, 'en');
  });

  it('getSummary reports both ko and en in mixed session', () => {
    const session = new TranscriptSession({ sessionId: 'lang-mixed' });
    session.addFromEvent(makeTranscriptEvent({ text: '안녕하세요', start: 0, end: 1 }));
    session.addFromEvent(makeTranscriptEvent({ text: 'Hello everyone', speaker: 1, start: 1, end: 2 }));

    const summary = session.getSummary();
    assert.ok(summary.languages.includes('ko'));
    assert.ok(summary.languages.includes('en'));
  });
});
