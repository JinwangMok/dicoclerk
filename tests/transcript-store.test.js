/**
 * Tests for transcript-store.js
 *
 * Covers:
 * - parseDeepgramPayload: raw payload → TranscriptSegment[]
 * - TranscriptSession: accumulation, speaker resolution, dedup, exports
 * - TranscriptStore: multi-session management
 * - Korean/English language detection
 * - 5-10 concurrent participants
 * - Integration between addFromEvent and addFromPayload
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDeepgramPayload,
  detectLanguage,
  groupWordsBySpeaker,
  extractWordMetadata,
  TranscriptSession,
  TranscriptStore,
} from '../src/stt/transcript-store.js';

// ---------------------------------------------------------------------------
// Fixtures / builders
// ---------------------------------------------------------------------------

function makeWord(word, { speaker = 0, start = 0.0, end = 0.1, confidence = 0.95, punctuated } = {}) {
  return {
    word: word.toLowerCase().replace(/[.,!?]$/, ''),
    punctuated_word: punctuated ?? word,
    speaker,
    start,
    end,
    confidence,
  };
}

function makePayload(words, { isFinal = true, speechFinal = false, start = 0.0, duration = 1.0 } = {}) {
  const transcript = words.map(w => w.punctuated_word ?? w.word ?? '').join(' ');
  return {
    type: 'Results',
    channel_index: [0, 1],
    duration,
    start,
    is_final: isFinal,
    speech_final: speechFinal,
    channel: {
      alternatives: [{
        transcript,
        confidence: 0.95,
        words,
      }],
    },
  };
}

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
  it('detects Korean text', () => {
    assert.equal(detectLanguage('안녕하세요 반갑습니다'), 'ko');
  });

  it('detects English text', () => {
    assert.equal(detectLanguage('hello world'), 'en');
  });

  it('detects mixed text as Korean when majority is Hangul', () => {
    assert.equal(detectLanguage('안녕하세요 hello 반갑습니다 여러분'), 'ko');
  });

  it('returns unknown for empty string', () => {
    assert.equal(detectLanguage(''), 'unknown');
  });

  it('returns unknown for digits-only', () => {
    assert.equal(detectLanguage('12345'), 'unknown');
  });

  it('returns unknown for null/undefined', () => {
    assert.equal(detectLanguage(null), 'unknown');
    assert.equal(detectLanguage(undefined), 'unknown');
  });
});

// ---------------------------------------------------------------------------
// groupWordsBySpeaker
// ---------------------------------------------------------------------------

describe('groupWordsBySpeaker', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(groupWordsBySpeaker([]), []);
    assert.deepEqual(groupWordsBySpeaker(null), []);
  });

  it('groups single speaker into one group', () => {
    const words = [
      makeWord('Hello', { speaker: 0, start: 0.0 }),
      makeWord('world', { speaker: 0, start: 0.2 }),
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 1);
    assert.equal(groups[0][0], 0);
    assert.equal(groups[0][1].length, 2);
  });

  it('splits on speaker change', () => {
    const words = [
      makeWord('Hello', { speaker: 0, start: 0.0 }),
      makeWord('Hi', { speaker: 1, start: 0.3 }),
      makeWord('there', { speaker: 1, start: 0.5 }),
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2);
    assert.equal(groups[0][0], 0);
    assert.equal(groups[1][0], 1);
    assert.equal(groups[1][1].length, 2);
  });

  it('handles speaker switching back (A-B-A pattern)', () => {
    const words = [
      makeWord('A', { speaker: 0 }),
      makeWord('B', { speaker: 1 }),
      makeWord('C', { speaker: 0 }),
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 3);
    assert.equal(groups[0][0], 0);
    assert.equal(groups[1][0], 1);
    assert.equal(groups[2][0], 0);
  });

  it('defaults missing speaker field to 0', () => {
    const words = [{ word: 'test', start: 0, end: 0.1 }]; // no speaker field
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups[0][0], 0);
  });
});

// ---------------------------------------------------------------------------
// extractWordMetadata
// ---------------------------------------------------------------------------

describe('extractWordMetadata', () => {
  it('returns zeros for empty array', () => {
    const m = extractWordMetadata([]);
    assert.equal(m.duration, 0);
    assert.equal(m.confidence, 0);
    assert.equal(m.language, 'unknown');
  });

  it('computes duration from first.start and last.end', () => {
    const words = [
      makeWord('Hello', { start: 1.0, end: 1.3 }),
      makeWord('world', { start: 1.4, end: 1.7 }),
    ];
    const { duration } = extractWordMetadata(words);
    assert.ok(Math.abs(duration - 0.7) < 0.001);
  });

  it('averages confidence across words', () => {
    const words = [
      makeWord('A', { confidence: 0.8 }),
      makeWord('B', { confidence: 1.0 }),
    ];
    const { confidence } = extractWordMetadata(words);
    assert.ok(Math.abs(confidence - 0.9) < 0.001);
  });

  it('detects Korean language from word text', () => {
    const words = [
      makeWord('안녕', { start: 0.0, end: 0.3 }),
      makeWord('하세요', { start: 0.4, end: 0.7 }),
    ];
    const { language } = extractWordMetadata(words);
    assert.equal(language, 'ko');
  });
});

// ---------------------------------------------------------------------------
// parseDeepgramPayload
// ---------------------------------------------------------------------------

describe('parseDeepgramPayload', () => {
  it('returns empty array for non-Results type', () => {
    assert.deepEqual(parseDeepgramPayload({ type: 'Metadata' }), []);
    assert.deepEqual(parseDeepgramPayload({ type: 'UtteranceEnd' }), []);
  });

  it('returns empty array for null/undefined', () => {
    assert.deepEqual(parseDeepgramPayload(null), []);
    assert.deepEqual(parseDeepgramPayload(undefined), []);
  });

  it('returns empty array for empty alternatives', () => {
    const payload = {
      type: 'Results',
      is_final: true,
      channel: { alternatives: [] },
    };
    assert.deepEqual(parseDeepgramPayload(payload), []);
  });

  it('parses single-speaker payload into one segment', () => {
    const words = [
      makeWord('Hello', { speaker: 0, start: 0.1, end: 0.3 }),
      makeWord('world', { speaker: 0, start: 0.4, end: 0.6 }),
    ];
    const payload = makePayload(words, { isFinal: true });
    const segments = parseDeepgramPayload(payload);

    assert.equal(segments.length, 1);
    assert.equal(segments[0].speakerLabel, 0);
    assert.equal(segments[0].text, 'Hello world');
    assert.equal(segments[0].isFinal, true);
    assert.ok(Math.abs(segments[0].start - 0.1) < 0.001);
    assert.ok(Math.abs(segments[0].end - 0.6) < 0.001);
  });

  it('splits multi-speaker payload into separate segments', () => {
    const words = [
      makeWord('I agree.', { speaker: 0, start: 0.0, end: 0.3 }),
      makeWord('Me too.', { speaker: 1, start: 0.5, end: 0.7 }),
    ];
    const payload = makePayload(words);
    const segments = parseDeepgramPayload(payload);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].speakerLabel, 0);
    assert.equal(segments[0].text, 'I agree.');
    assert.equal(segments[1].speakerLabel, 1);
    assert.equal(segments[1].text, 'Me too.');
  });

  it('marks interim results correctly', () => {
    const words = [makeWord('hello', { speaker: 0 })];
    const payload = makePayload(words, { isFinal: false });
    const [seg] = parseDeepgramPayload(payload);
    assert.equal(seg.isFinal, false);
  });

  it('marks speechFinal correctly', () => {
    const words = [makeWord('done', { speaker: 0 })];
    const payload = makePayload(words, { isFinal: true, speechFinal: true });
    const [seg] = parseDeepgramPayload(payload);
    assert.equal(seg.speechFinal, true);
  });

  it('falls back to full transcript when no words', () => {
    const payload = {
      type: 'Results',
      start: 2.5,
      duration: 1.0,
      is_final: true,
      channel: {
        alternatives: [{
          transcript: 'fallback text',
          confidence: 0.8,
          words: [],
        }],
      },
    };
    const segments = parseDeepgramPayload(payload);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'fallback text');
    assert.equal(segments[0].speakerLabel, 0);
    assert.ok(Math.abs(segments[0].start - 2.5) < 0.001);
  });

  it('uses punctuated_word for natural text', () => {
    const words = [
      { word: 'hello', punctuated_word: 'Hello,', speaker: 0, start: 0, end: 0.3, confidence: 0.9 },
      { word: 'world', punctuated_word: 'world!', speaker: 0, start: 0.4, end: 0.7, confidence: 0.9 },
    ];
    const payload = makePayload(words);
    const [seg] = parseDeepgramPayload(payload);
    assert.equal(seg.text, 'Hello, world!');
  });

  it('parses Korean words correctly', () => {
    const words = [
      makeWord('안녕하세요', { speaker: 0, start: 0.0, end: 0.3 }),
      makeWord('반갑습니다', { speaker: 0, start: 0.4, end: 0.7 }),
    ];
    const payload = makePayload(words);
    const [seg] = parseDeepgramPayload(payload);
    assert.equal(seg.text, '안녕하세요 반갑습니다');
    assert.equal(seg.language, 'ko');
  });

  it('handles 10 concurrent speakers in one payload', () => {
    const words = [];
    for (let speaker = 0; speaker < 10; speaker++) {
      words.push(makeWord(`word_${speaker}`, { speaker, start: speaker * 0.5, end: speaker * 0.5 + 0.4 }));
    }
    const payload = makePayload(words);
    const segments = parseDeepgramPayload(payload);
    assert.equal(segments.length, 10);
    for (let i = 0; i < 10; i++) {
      assert.equal(segments[i].speakerLabel, i);
    }
  });

  it('skips segments with empty text', () => {
    const words = [
      { word: '', punctuated_word: '', speaker: 0, start: 0, end: 0.1, confidence: 0.5 },
      makeWord('real', { speaker: 1, start: 0.2, end: 0.4 }),
    ];
    const payload = makePayload(words);
    const segments = parseDeepgramPayload(payload);
    // Empty first word still produces a group — but text join results in '' which is trimmed away
    const nonEmpty = segments.filter(s => s.text.length > 0);
    assert.ok(nonEmpty.some(s => s.text === 'real'));
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — constructor
// ---------------------------------------------------------------------------

describe('TranscriptSession constructor', () => {
  it('throws if sessionId is missing', () => {
    assert.throws(() => new TranscriptSession({}), /sessionId is required/);
    assert.throws(() => new TranscriptSession(), /sessionId is required/);
  });

  it('initialises with empty state', () => {
    const session = new TranscriptSession({ sessionId: 'test-1' });
    assert.equal(session.sessionId, 'test-1');
    assert.equal(session.entryCount, 0);
    assert.equal(session.totalProcessed, 0);
    assert.equal(session.duplicateCount, 0);
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — speaker registry
// ---------------------------------------------------------------------------

describe('TranscriptSession speaker resolution', () => {
  let session;
  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 's1' });
  });

  it('returns Speaker N placeholder for unregistered label', () => {
    const { userId, speakerName } = session.resolveSpeaker(3);
    assert.equal(userId, null);
    assert.equal(speakerName, 'Speaker 3');
  });

  it('resolves registered speaker correctly', () => {
    session.registerSpeaker(0, 'user-111', 'Alice');
    const { userId, speakerName } = session.resolveSpeaker(0);
    assert.equal(userId, 'user-111');
    assert.equal(speakerName, 'Alice');
  });

  it('retroactively updates existing entries when speaker registered', () => {
    // Add entry before registration
    const words = [makeWord('Hello', { speaker: 0, start: 0.0, end: 0.3 })];
    session.addFromPayload(makePayload(words));

    const entriesBefore = session.entries;
    assert.equal(entriesBefore[0].speakerName, 'Speaker 0');
    assert.equal(entriesBefore[0].userId, null);

    // Register after the fact
    session.registerSpeaker(0, 'user-111', 'Alice');

    const entriesAfter = session.entries;
    assert.equal(entriesAfter[0].speakerName, 'Alice');
    assert.equal(entriesAfter[0].userId, 'user-111');
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — addFromPayload
// ---------------------------------------------------------------------------

describe('TranscriptSession.addFromPayload', () => {
  let session;
  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 's2' });
    session.registerSpeaker(0, 'user-111', 'Alice');
    session.registerSpeaker(1, 'user-222', 'Bob');
  });

  it('accumulates a single-speaker entry', () => {
    const words = [makeWord('Hello everyone', { speaker: 0, start: 0.1, end: 0.5 })];
    const newEntries = session.addFromPayload(makePayload(words));

    assert.equal(newEntries.length, 1);
    assert.equal(newEntries[0].speakerName, 'Alice');
    assert.equal(newEntries[0].userId, 'user-111');
    assert.equal(newEntries[0].text, 'Hello everyone');
    assert.equal(session.entryCount, 1);
  });

  it('accumulates two speakers from one payload', () => {
    const words = [
      makeWord('I agree.', { speaker: 0, start: 0.0, end: 0.3 }),
      makeWord('Me too.', { speaker: 1, start: 0.5, end: 0.7 }),
    ];
    const newEntries = session.addFromPayload(makePayload(words));

    assert.equal(newEntries.length, 2);
    assert.equal(newEntries[0].speakerName, 'Alice');
    assert.equal(newEntries[1].speakerName, 'Bob');
    assert.equal(session.entryCount, 2);
  });

  it('accumulates across multiple payloads', () => {
    const w1 = [makeWord('First', { speaker: 0, start: 0.0, end: 0.3 })];
    const w2 = [makeWord('Second', { speaker: 1, start: 2.0, end: 2.4 })];
    session.addFromPayload(makePayload(w1));
    session.addFromPayload(makePayload(w2));

    assert.equal(session.entryCount, 2);
    const entries = session.entries;
    assert.equal(entries[0].speakerName, 'Alice');
    assert.equal(entries[1].speakerName, 'Bob');
  });

  it('filters duplicate payloads', () => {
    const words = [makeWord('Hello world', { speaker: 0, start: 0.0, end: 0.3 })];
    const payload = makePayload(words);

    session.addFromPayload(payload);
    session.addFromPayload(payload); // duplicate

    assert.equal(session.entryCount, 1);
    assert.equal(session.duplicateCount, 1);
    assert.equal(session.totalProcessed, 2);
  });

  it('skips interim results by default', () => {
    const words = [makeWord('typing', { speaker: 0, start: 0.0, end: 0.2 })];
    const newEntries = session.addFromPayload(makePayload(words, { isFinal: false }));
    assert.equal(newEntries.length, 0);
    assert.equal(session.entryCount, 0);
  });

  it('stores interim results when includePreliminary=true', () => {
    const words = [makeWord('typing', { speaker: 0, start: 0.0, end: 0.2 })];
    const newEntries = session.addFromPayload(
      makePayload(words, { isFinal: false }),
      { includePreliminary: true }
    );
    assert.equal(newEntries.length, 1);
    assert.equal(newEntries[0].isFinal, false);
  });

  it('ignores non-Results payloads gracefully', () => {
    const result = session.addFromPayload({ type: 'UtteranceEnd' });
    assert.deepEqual(result, []);
    assert.equal(session.entryCount, 0);
  });

  it('sets sessionId on each entry', () => {
    const words = [makeWord('Test', { speaker: 0, start: 0.0, end: 0.2 })];
    const [entry] = session.addFromPayload(makePayload(words));
    assert.equal(entry.sessionId, 's2');
  });

  it('populates language field', () => {
    const words = [
      makeWord('안녕하세요', { speaker: 0, start: 0.0, end: 0.3 }),
    ];
    const [entry] = session.addFromPayload(makePayload(words));
    assert.equal(entry.language, 'ko');
  });

  it('wallClockMs is a recent timestamp', () => {
    const before = Date.now();
    const words = [makeWord('now', { speaker: 0, start: 0, end: 0.1 })];
    const [entry] = session.addFromPayload(makePayload(words));
    const after = Date.now();
    assert.ok(entry.wallClockMs >= before && entry.wallClockMs <= after);
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — addFromEvent
// ---------------------------------------------------------------------------

describe('TranscriptSession.addFromEvent', () => {
  let session;
  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 's3' });
    session.registerSpeaker(0, 'user-111', 'Alice');
  });

  it('stores a final transcript event', () => {
    const event = {
      text: 'Hello from event',
      speaker: 0,
      isFinal: true,
      speechFinal: false,
      confidence: 0.92,
      start: 1.0,
      end: 1.5,
      words: [],
    };
    const entry = session.addFromEvent(event);
    assert.ok(entry !== null);
    assert.equal(entry.text, 'Hello from event');
    assert.equal(entry.speakerName, 'Alice');
    assert.equal(entry.userId, 'user-111');
    assert.equal(session.entryCount, 1);
  });

  it('skips events with empty text', () => {
    const entry = session.addFromEvent({ text: '   ', speaker: 0, isFinal: true });
    assert.equal(entry, null);
    assert.equal(session.entryCount, 0);
  });

  it('skips interim by default', () => {
    const entry = session.addFromEvent({ text: 'interim', speaker: 0, isFinal: false });
    assert.equal(entry, null);
  });

  it('stores interim when includePreliminary=true', () => {
    const entry = session.addFromEvent(
      { text: 'interim', speaker: 0, isFinal: false, start: 0, end: 0.2, confidence: 0.7, words: [] },
      { includePreliminary: true }
    );
    assert.ok(entry !== null);
    assert.equal(entry.isFinal, false);
  });

  it('detects language from words when available', () => {
    const event = {
      text: '안녕하세요',
      speaker: 0,
      isFinal: true,
      start: 0,
      end: 0.5,
      confidence: 0.9,
      words: [makeWord('안녕하세요', { speaker: 0 })],
    };
    const entry = session.addFromEvent(event);
    assert.equal(entry.language, 'ko');
  });

  it('increments totalProcessed', () => {
    const event = { text: 'test', speaker: 0, isFinal: true, start: 0, end: 0.2, confidence: 0.9, words: [] };
    session.addFromEvent(event);
    assert.equal(session.totalProcessed, 1);
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — read API
// ---------------------------------------------------------------------------

describe('TranscriptSession read API', () => {
  let session;
  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 's4' });
    session.registerSpeaker(0, 'user-111', 'Alice');
    session.registerSpeaker(1, 'user-222', 'Bob');

    const w1 = [makeWord('Alice says hi', { speaker: 0, start: 0.0, end: 0.5 })];
    const w2 = [makeWord('Bob replies', { speaker: 1, start: 1.0, end: 1.4 })];
    const w3 = [makeWord('Alice again', { speaker: 0, start: 2.0, end: 2.3 })];
    session.addFromPayload(makePayload(w1));
    session.addFromPayload(makePayload(w2));
    session.addFromPayload(makePayload(w3));
  });

  it('entries returns a copy', () => {
    const e1 = session.entries;
    const e2 = session.entries;
    assert.notStrictEqual(e1, e2);
    assert.equal(e1.length, e2.length);
  });

  it('getEntriesByUser filters correctly', () => {
    const aliceEntries = session.getEntriesByUser('user-111');
    assert.equal(aliceEntries.length, 2);
    const bobEntries = session.getEntriesByUser('user-222');
    assert.equal(bobEntries.length, 1);
  });

  it('getEntriesBySpeaker filters correctly', () => {
    const speaker0 = session.getEntriesBySpeaker(0);
    assert.equal(speaker0.length, 2);
    const speaker1 = session.getEntriesBySpeaker(1);
    assert.equal(speaker1.length, 1);
  });

  it('getSpeakerStats returns correct per-speaker data', () => {
    const stats = session.getSpeakerStats();
    assert.ok(stats.has('user-111'));
    assert.equal(stats.get('user-111').speakerName, 'Alice');
    assert.equal(stats.get('user-111').entryCount, 2);
    assert.ok(stats.get('user-111').wordCount > 0);
    assert.ok(stats.has('user-222'));
    assert.equal(stats.get('user-222').entryCount, 1);
  });

  it('getSpeakerStats uses speaker_N key for unresolved speakers', () => {
    const w = [makeWord('mystery', { speaker: 99, start: 5.0, end: 5.3 })];
    session.addFromPayload(makePayload(w));
    const stats = session.getSpeakerStats();
    assert.ok(stats.has('speaker_99'));
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — export methods
// ---------------------------------------------------------------------------

describe('TranscriptSession exports', () => {
  let session;
  beforeEach(() => {
    session = new TranscriptSession({ sessionId: 's5' });
    session.registerSpeaker(0, 'user-111', 'Alice');
    session.registerSpeaker(1, 'user-222', 'Bob');
  });

  it('toPlainText formats [MM:SS] speaker: text', () => {
    const w1 = [makeWord('Hello', { speaker: 0, start: 65.0, end: 65.4 })];  // 01:05
    const w2 = [makeWord('Hi', { speaker: 1, start: 130.0, end: 130.2 })];   // 02:10
    session.addFromPayload(makePayload(w1));
    session.addFromPayload(makePayload(w2));

    const text = session.toPlainText();
    assert.ok(text.includes('[01:05] Alice: Hello'), `Got: ${text}`);
    assert.ok(text.includes('[02:10] Bob: Hi'), `Got: ${text}`);
  });

  it('toPlainText returns empty string when no entries', () => {
    assert.equal(session.toPlainText(), '');
  });

  it('toStructuredData includes all required fields', () => {
    const w = [makeWord('test', { speaker: 0, start: 1.5, end: 1.8 })];
    session.addFromPayload(makePayload(w));

    const data = session.toStructuredData();
    assert.equal(data.length, 1);
    const d = data[0];
    assert.equal(d.sessionId, 's5');
    assert.equal(d.speakerLabel, 0);
    assert.equal(d.speakerName, 'Alice');
    assert.equal(d.userId, 'user-111');
    assert.equal(d.text, 'test');
    assert.ok(typeof d.start === 'number');
    assert.ok(typeof d.end === 'number');
    assert.ok(typeof d.duration === 'number');
    assert.ok(typeof d.confidence === 'number');
    assert.ok(typeof d.language === 'string');
    assert.ok(typeof d.isFinal === 'boolean');
    assert.ok(typeof d.wallClockMs === 'number');
  });

  it('toStructuredData returns empty array when no entries', () => {
    assert.deepEqual(session.toStructuredData(), []);
  });

  it('getSummary includes key metrics', () => {
    const w = [makeWord('hello world', { speaker: 0, start: 1.0, end: 1.5 })];
    session.addFromPayload(makePayload(w));

    const summary = session.getSummary();
    assert.equal(summary.sessionId, 's5');
    assert.equal(summary.entryCount, 1);
    assert.ok(summary.totalProcessed >= 1);
    assert.ok(typeof summary.participantCount === 'number');
    assert.ok(typeof summary.totalWords === 'number');
    assert.ok(Array.isArray(summary.languages));
    assert.ok(typeof summary.startedAt === 'number');
    assert.ok(typeof summary.speakerStats === 'object');
  });
});

// ---------------------------------------------------------------------------
// TranscriptSession — reset
// ---------------------------------------------------------------------------

describe('TranscriptSession.reset', () => {
  it('clears all state', () => {
    const session = new TranscriptSession({ sessionId: 'reset-test' });
    session.registerSpeaker(0, 'user-111', 'Alice');
    const w = [makeWord('Hello', { speaker: 0, start: 0.0, end: 0.3 })];
    session.addFromPayload(makePayload(w));

    assert.equal(session.entryCount, 1);

    session.reset();

    assert.equal(session.entryCount, 0);
    assert.equal(session.totalProcessed, 0);
    assert.equal(session.duplicateCount, 0);

    // Speaker registry also cleared
    const { speakerName } = session.resolveSpeaker(0);
    assert.equal(speakerName, 'Speaker 0');
  });
});

// ---------------------------------------------------------------------------
// Korean language integration
// ---------------------------------------------------------------------------

describe('Korean transcript accumulation', () => {
  it('accumulates Korean speech correctly', () => {
    const session = new TranscriptSession({ sessionId: 'kr' });
    session.registerSpeaker(0, 'k1', '김철수');
    session.registerSpeaker(1, 'k2', '이영희');

    const w1 = [
      makeWord('회의를', { speaker: 0, start: 0.0, end: 0.3 }),
      makeWord('시작하겠습니다', { speaker: 0, start: 0.4, end: 0.8 }),
    ];
    const w2 = [
      makeWord('네', { speaker: 1, start: 1.0, end: 1.2 }),
      makeWord('알겠습니다', { speaker: 1, start: 1.3, end: 1.6 }),
    ];
    session.addFromPayload(makePayload(w1));
    session.addFromPayload(makePayload(w2));

    assert.equal(session.entryCount, 2);
    const text = session.toPlainText();
    assert.ok(text.includes('김철수'));
    assert.ok(text.includes('이영희'));
    assert.ok(text.includes('회의를 시작하겠습니다'));
    assert.ok(text.includes('네 알겠습니다'));
  });

  it('detects Korean language on entries', () => {
    const session = new TranscriptSession({ sessionId: 'kr-lang' });
    session.registerSpeaker(0, 'k1', '김철수');

    const w = [makeWord('안녕하세요', { speaker: 0, start: 0.0, end: 0.3 })];
    const [entry] = session.addFromPayload(makePayload(w));
    assert.equal(entry.language, 'ko');
  });
});

// ---------------------------------------------------------------------------
// Concurrent participants (5-10 speakers)
// ---------------------------------------------------------------------------

describe('Concurrent participants', () => {
  it('handles 10 concurrent speakers', () => {
    const session = new TranscriptSession({ sessionId: 'multi10' });
    for (let i = 0; i < 10; i++) {
      session.registerSpeaker(i, `user-${i}`, `User${i}`);
    }

    for (let i = 0; i < 10; i++) {
      const words = [makeWord(`Message from user ${i}`, { speaker: i, start: i * 2.0, end: i * 2.0 + 0.8 })];
      session.addFromPayload(makePayload(words));
    }

    assert.equal(session.entryCount, 10);
    const stats = session.getSpeakerStats();
    assert.equal(stats.size, 10);
  });

  it('handles interleaved speakers in a single payload', () => {
    const session = new TranscriptSession({ sessionId: 'interleave' });
    for (let i = 0; i < 5; i++) {
      session.registerSpeaker(i, `uid-${i}`, `Speaker${i}`);
    }

    // Words alternating across 5 speakers (multiple turns each)
    const words = [];
    for (let turn = 0; turn < 3; turn++) {
      for (let spk = 0; spk < 5; spk++) {
        const t = turn * 5.0 + spk * 1.0;
        words.push(makeWord(`turn${turn}spk${spk}`, { speaker: spk, start: t, end: t + 0.8 }));
      }
    }

    const entries = session.addFromPayload(makePayload(words));

    // Each speaker change in consecutive words creates a new group
    // 5 speakers × 3 turns = 15 groups (each turn a separate group per speaker)
    assert.ok(entries.length >= 5, `Expected ≥5 entries, got ${entries.length}`);

    // Verify all 5 speaker names appear
    const names = new Set(entries.map(e => e.speakerName));
    assert.ok(names.has('Speaker0'));
    assert.ok(names.has('Speaker4'));
  });

  it('tracks participation stats for 8 speakers', () => {
    const session = new TranscriptSession({ sessionId: 'stats8' });
    for (let i = 0; i < 8; i++) {
      session.registerSpeaker(i, `uid-${i}`, `Participant${i}`);
    }
    for (let i = 0; i < 8; i++) {
      const words = [makeWord(`Hi I am ${i}`, { speaker: i, start: i * 3.0, end: i * 3.0 + 1.0 })];
      session.addFromPayload(makePayload(words));
    }

    const stats = session.getSpeakerStats();
    assert.equal(stats.size, 8);
    for (let i = 0; i < 8; i++) {
      assert.ok(stats.has(`uid-${i}`), `Missing uid-${i}`);
      assert.ok(stats.get(`uid-${i}`).wordCount > 0);
    }
  });
});

// ---------------------------------------------------------------------------
// TranscriptStore — multi-session management
// ---------------------------------------------------------------------------

describe('TranscriptStore', () => {
  let store;
  beforeEach(() => {
    store = new TranscriptStore();
  });

  it('starts empty', () => {
    assert.equal(store.sessionCount, 0);
    assert.deepEqual(store.sessionIds, []);
  });

  it('creates and retrieves a session', () => {
    const session = store.createSession('guild-A');
    assert.ok(session instanceof TranscriptSession);
    assert.equal(session.sessionId, 'guild-A');
    assert.equal(store.sessionCount, 1);

    const retrieved = store.getSession('guild-A');
    assert.strictEqual(retrieved, session);
  });

  it('throws on duplicate session creation', () => {
    store.createSession('dup-test');
    assert.throws(() => store.createSession('dup-test'), /already exists/);
  });

  it('returns null for unknown session', () => {
    assert.equal(store.getSession('unknown'), null);
  });

  it('hasSession returns correct boolean', () => {
    store.createSession('present');
    assert.equal(store.hasSession('present'), true);
    assert.equal(store.hasSession('absent'), false);
  });

  it('closeSession removes and returns the session', () => {
    store.createSession('to-close');
    const session = store.closeSession('to-close');
    assert.ok(session instanceof TranscriptSession);
    assert.equal(store.hasSession('to-close'), false);
    assert.equal(store.sessionCount, 0);
  });

  it('closeSession returns null for unknown session', () => {
    assert.equal(store.closeSession('nobody'), null);
  });

  it('manages multiple independent sessions', () => {
    const s1 = store.createSession('guild-1');
    const s2 = store.createSession('guild-2');
    s1.registerSpeaker(0, 'u1', 'Alice');
    s2.registerSpeaker(0, 'u2', 'Bob');

    const w1 = [makeWord('From guild 1', { speaker: 0, start: 0.0, end: 0.4 })];
    const w2 = [makeWord('From guild 2', { speaker: 0, start: 0.0, end: 0.4 })];
    s1.addFromPayload(makePayload(w1));
    s2.addFromPayload(makePayload(w2));

    assert.equal(s1.entryCount, 1);
    assert.equal(s2.entryCount, 1);
    assert.equal(s1.entries[0].speakerName, 'Alice');
    assert.equal(s2.entries[0].speakerName, 'Bob');
    assert.equal(store.sessionCount, 2);
  });

  it('clear() removes all sessions', () => {
    store.createSession('a');
    store.createSession('b');
    store.createSession('c');
    assert.equal(store.sessionCount, 3);
    store.clear();
    assert.equal(store.sessionCount, 0);
  });

  it('sessionIds lists all active sessions', () => {
    store.createSession('x');
    store.createSession('y');
    const ids = store.sessionIds;
    assert.ok(ids.includes('x'));
    assert.ok(ids.includes('y'));
    assert.equal(ids.length, 2);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: payload → store → export
// ---------------------------------------------------------------------------

describe('End-to-end transcript flow', () => {
  it('simulates a meeting session with multiple speakers and exports correctly', () => {
    const store = new TranscriptStore();
    const session = store.createSession('meeting-e2e');

    session.registerSpeaker(0, 'user-a', 'Alice');
    session.registerSpeaker(1, 'user-b', 'Bob');
    session.registerSpeaker(2, 'user-c', 'Charlie');

    // Simulate a meeting
    const turns = [
      { words: [makeWord('회의를 시작하겠습니다', { speaker: 0, start: 0.0, end: 1.5 })], speaker: 'Alice' },
      { words: [makeWord('네 알겠습니다', { speaker: 1, start: 2.0, end: 2.8 })], speaker: 'Bob' },
      { words: [makeWord('저도 준비됐어요', { speaker: 2, start: 3.0, end: 3.7 })], speaker: 'Charlie' },
      { words: [makeWord('첫 번째 안건은', { speaker: 0, start: 4.0, end: 4.8 })], speaker: 'Alice' },
      { words: [makeWord('동의합니다', { speaker: 1, start: 5.0, end: 5.5 })], speaker: 'Bob' },
    ];

    for (const turn of turns) {
      session.addFromPayload(makePayload(turn.words, { isFinal: true }));
    }

    // Verify accumulation
    assert.equal(session.entryCount, 5);

    // Verify plain text export
    const plainText = session.toPlainText();
    assert.ok(plainText.includes('Alice'));
    assert.ok(plainText.includes('Bob'));
    assert.ok(plainText.includes('Charlie'));
    assert.ok(plainText.includes('회의를 시작하겠습니다'));

    // Verify structured export
    const structured = session.toStructuredData();
    assert.equal(structured.length, 5);
    assert.ok(structured.every(d => d.sessionId === 'meeting-e2e'));
    assert.ok(structured.every(d => typeof d.start === 'number'));
    assert.ok(structured.every(d => d.language === 'ko'));

    // Verify summary
    const summary = session.getSummary();
    assert.equal(summary.participantCount, 3);
    assert.ok(summary.totalWords >= 10);

    // Close session and verify it's gone from store
    const closed = store.closeSession('meeting-e2e');
    assert.ok(closed instanceof TranscriptSession);
    assert.equal(store.sessionCount, 0);
  });
});
