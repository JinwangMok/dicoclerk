/**
 * Tests for TranscriptBuffer
 *
 * Covers:
 * - groupWordsBySpeaker: word grouping logic
 * - detectLanguage: Korean / English / unknown detection
 * - parseDeepgramResponse: full response parsing
 * - TranscriptBuffer: core processing (interim, final, dedup, speaker resolution)
 * - Per-speaker buffer queries
 * - Export helpers (toPlainText, toStructuredData)
 * - Concurrent-participant scenarios (5-10 speakers)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  TranscriptBuffer,
  groupWordsBySpeaker,
  detectLanguage,
  parseDeepgramResponse,
} from '../src/stt/transcript-buffer.js';

// ──────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────

/** Build a minimal Deepgram word object */
function mkWord(word, { speaker = 0, start = 0.0, end = 0.1, confidence = 0.95 } = {}) {
  return {
    word: word.toLowerCase().replace(/[.,!?]$/, ''),
    punctuated_word: word,
    speaker,
    start,
    end,
    confidence,
  };
}

/** Build a minimal Deepgram Results response */
function mkResponse(words, { isFinal = true, start = 0.0, duration = 1.0, speechFinal = false } = {}) {
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

// ──────────────────────────────────────────────────────────────────
// detectLanguage
// ──────────────────────────────────────────────────────────────────

describe('detectLanguage', () => {
  it('identifies Korean text', () => {
    assert.equal(detectLanguage('안녕하세요 반갑습니다'), 'ko');
  });

  it('identifies English text', () => {
    assert.equal(detectLanguage('hello world good morning'), 'en');
  });

  it('returns unknown for empty string', () => {
    assert.equal(detectLanguage(''), 'unknown');
  });

  it('returns unknown for numbers only', () => {
    assert.equal(detectLanguage('12345 6789'), 'unknown');
  });

  it('identifies mixed text as Korean when >30% Korean chars', () => {
    assert.equal(detectLanguage('안녕하세요 hello 반갑습니다 world'), 'ko');
  });

  it('identifies mixed text as English when Korean chars are sparse', () => {
    assert.equal(detectLanguage('hello world this is mostly english 한'), 'en');
  });
});

// ──────────────────────────────────────────────────────────────────
// groupWordsBySpeaker
// ──────────────────────────────────────────────────────────────────

describe('groupWordsBySpeaker', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(groupWordsBySpeaker([]), []);
  });

  it('returns single group for one speaker', () => {
    const words = [
      mkWord('Hello', { speaker: 0, start: 0.0, end: 0.2 }),
      mkWord('world', { speaker: 0, start: 0.2, end: 0.4 }),
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].speakerLabel, 0);
    assert.equal(groups[0].words.length, 2);
  });

  it('splits on speaker change', () => {
    const words = [
      mkWord('Hi',   { speaker: 0, start: 0.0, end: 0.2 }),
      mkWord('there',{ speaker: 1, start: 0.3, end: 0.5 }),
      mkWord('how',  { speaker: 1, start: 0.6, end: 0.8 }),
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].speakerLabel, 0);
    assert.equal(groups[0].words.length, 1);
    assert.equal(groups[1].speakerLabel, 1);
    assert.equal(groups[1].words.length, 2);
  });

  it('handles alternating speakers (A-B-A creates 3 groups)', () => {
    const words = [
      mkWord('A', { speaker: 0 }),
      mkWord('B', { speaker: 1 }),
      mkWord('C', { speaker: 0 }),
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].speakerLabel, 0);
    assert.equal(groups[1].speakerLabel, 1);
    assert.equal(groups[2].speakerLabel, 0);
  });

  it('defaults missing speaker field to 0', () => {
    const words = [{ word: 'test', punctuated_word: 'Test', start: 0, end: 0.2 }];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups[0].speakerLabel, 0);
  });
});

// ──────────────────────────────────────────────────────────────────
// parseDeepgramResponse
// ──────────────────────────────────────────────────────────────────

describe('parseDeepgramResponse', () => {
  it('returns empty array for non-Results type', () => {
    const segments = parseDeepgramResponse({ type: 'Metadata' });
    assert.deepEqual(segments, []);
  });

  it('returns empty array when no alternatives', () => {
    const segments = parseDeepgramResponse({
      type: 'Results',
      is_final: true,
      channel: { alternatives: [] },
    });
    assert.deepEqual(segments, []);
  });

  it('parses single speaker response', () => {
    const words = [
      mkWord('Hello', { speaker: 0, start: 0.1, end: 0.3 }),
      mkWord('world', { speaker: 0, start: 0.4, end: 0.6 }),
    ];
    const [seg] = parseDeepgramResponse(mkResponse(words, { isFinal: true }));

    assert.equal(seg.speakerLabel, 0);
    assert.equal(seg.text, 'Hello world');
    assert.equal(seg.isFinal, true);
    assert.equal(seg.start, 0.1);
  });

  it('produces two segments for two speakers in one response', () => {
    const words = [
      mkWord('I agree.',  { speaker: 0, start: 0.0, end: 0.4 }),
      mkWord('Me too.',   { speaker: 1, start: 0.5, end: 0.8 }),
    ];
    const segments = parseDeepgramResponse(mkResponse(words));

    assert.equal(segments.length, 2);
    assert.equal(segments[0].speakerLabel, 0);
    assert.equal(segments[0].text, 'I agree.');
    assert.equal(segments[1].speakerLabel, 1);
    assert.equal(segments[1].text, 'Me too.');
  });

  it('falls back to full transcript when words array is empty', () => {
    const resp = {
      type: 'Results',
      is_final: true,
      start: 2.0,
      duration: 1.5,
      channel: {
        alternatives: [{
          transcript: 'fallback text',
          confidence: 0.8,
          words: [],
        }],
      },
    };
    const [seg] = parseDeepgramResponse(resp);
    assert.equal(seg.speakerLabel, 0);
    assert.equal(seg.text, 'fallback text');
    assert.equal(seg.start, 2.0);
  });

  it('marks interim results with isFinal=false', () => {
    const words = [mkWord('hello', { speaker: 0 })];
    const [seg] = parseDeepgramResponse(mkResponse(words, { isFinal: false }));
    assert.equal(seg.isFinal, false);
  });

  it('computes average confidence from words', () => {
    const words = [
      mkWord('A', { speaker: 0, confidence: 0.8 }),
      mkWord('B', { speaker: 0, confidence: 0.6 }),
    ];
    const [seg] = parseDeepgramResponse(mkResponse(words));
    assert.ok(Math.abs(seg.confidence - 0.7) < 0.001);
  });

  it('detects Korean language in segment', () => {
    const words = [
      mkWord('안녕하세요', { speaker: 0 }),
      mkWord('반갑습니다', { speaker: 0 }),
    ];
    const [seg] = parseDeepgramResponse(mkResponse(words));
    assert.equal(seg.language, 'ko');
  });

  it('processes response without explicit type field', () => {
    const words = [mkWord('Test', { speaker: 0 })];
    const resp = mkResponse(words);
    delete resp.type;
    const segments = parseDeepgramResponse(resp);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, 'Test');
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — construction and speaker resolution
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — construction', () => {
  it('starts empty', () => {
    const buf = new TranscriptBuffer();
    assert.equal(buf.entryCount, 0);
    assert.equal(buf.totalProcessed, 0);
    assert.equal(buf.duplicateCount, 0);
    assert.equal(buf.hasInterim, false);
    assert.deepEqual(buf.entries, []);
  });

  it('accepts sessionStartTime option', () => {
    const t = Date.now() - 60_000;
    const buf = new TranscriptBuffer({ sessionStartTime: t });
    assert.ok(buf instanceof TranscriptBuffer);
  });
});

describe('TranscriptBuffer — speaker resolution', () => {
  it('returns placeholder for unresolved label', () => {
    const buf = new TranscriptBuffer();
    const res = buf.getSpeakerResolution(5);
    assert.equal(res.userId, null);
    assert.equal(res.displayName, 'Speaker 5');
  });

  it('resolveSpeaker updates the mapping', () => {
    const buf = new TranscriptBuffer();
    buf.resolveSpeaker(0, 'user-111', 'Alice');
    const res = buf.getSpeakerResolution(0);
    assert.equal(res.userId, 'user-111');
    assert.equal(res.displayName, 'Alice');
  });

  it('allows null userId for unresolved Discord user', () => {
    const buf = new TranscriptBuffer();
    buf.resolveSpeaker(0, null, 'Unknown speaker');
    const res = buf.getSpeakerResolution(0);
    assert.equal(res.userId, null);
    assert.equal(res.displayName, 'Unknown speaker');
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — final result handling
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — final results', () => {
  let buf;
  beforeEach(() => {
    buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'uid-0', 'Alice');
    buf.resolveSpeaker(1, 'uid-1', 'Bob');
  });

  it('accumulates a single final entry', () => {
    const words = [mkWord('Hello', { speaker: 0, start: 1.0, end: 1.3 })];
    const newEntries = buf.processResponse(mkResponse(words));

    assert.equal(newEntries.length, 1);
    assert.equal(buf.entryCount, 1);
    assert.equal(newEntries[0].displayName, 'Alice');
    assert.equal(newEntries[0].text, 'Hello');
    assert.equal(newEntries[0].isFinal, true);
    assert.equal(newEntries[0].timestamp, 1.0);
  });

  it('accumulates entries from two speakers', () => {
    const words = [
      mkWord('I agree.', { speaker: 0, start: 0.0, end: 0.4 }),
      mkWord('Me too.', { speaker: 1, start: 0.5, end: 0.8 }),
    ];
    const newEntries = buf.processResponse(mkResponse(words));

    assert.equal(newEntries.length, 2);
    assert.equal(buf.entryCount, 2);
    assert.equal(newEntries[0].displayName, 'Alice');
    assert.equal(newEntries[1].displayName, 'Bob');
  });

  it('accumulates entries across multiple processResponse calls', () => {
    buf.processResponse(mkResponse([mkWord('First', { speaker: 0, start: 0.0 })]));
    buf.processResponse(mkResponse([mkWord('Second', { speaker: 1, start: 2.0 })]));

    assert.equal(buf.entryCount, 2);
    const entries = buf.entries;
    assert.equal(entries[0].displayName, 'Alice');
    assert.equal(entries[1].displayName, 'Bob');
  });

  it('entries returns a copy, not the internal array', () => {
    buf.processResponse(mkResponse([mkWord('Hi', { speaker: 0 })]));
    const a = buf.entries;
    const b = buf.entries;
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  it('assigns placeholder name to unresolved speaker', () => {
    const words = [mkWord('Mystery', { speaker: 7, start: 0.0 })];
    const [entry] = buf.processResponse(mkResponse(words));
    assert.equal(entry.displayName, 'Speaker 7');
    assert.equal(entry.userId, null);
  });

  it('emits "entry" event for each new final entry', () => {
    const emitted = [];
    buf.on('entry', ({ entry }) => emitted.push(entry));

    const words = [mkWord('Hello', { speaker: 0 })];
    buf.processResponse(mkResponse(words));

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].displayName, 'Alice');
  });

  it('applies streamOffset to timestamps', () => {
    const words = [mkWord('Hi', { speaker: 0, start: 0.5 })];
    const [entry] = buf.processResponse(mkResponse(words), 10.0);
    assert.equal(entry.timestamp, 10.5);
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — interim result handling
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — interim results', () => {
  let buf;
  beforeEach(() => {
    buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'uid-0', 'Alice');
  });

  it('stores interim entry but does not add to final list', () => {
    const words = [mkWord('hello', { speaker: 0, start: 0.0 })];
    const newFinal = buf.processResponse(mkResponse(words, { isFinal: false }));

    assert.equal(newFinal.length, 0);
    assert.equal(buf.entryCount, 0);
    assert.equal(buf.hasInterim, true);
  });

  it('getInterim returns the latest interim for a speaker', () => {
    const words = [mkWord('hello wor', { speaker: 0 })];
    buf.processResponse(mkResponse(words, { isFinal: false }));

    const interim = buf.getInterim(0);
    assert.ok(interim !== null);
    assert.equal(interim.displayName, 'Alice');
    assert.equal(interim.text, 'hello wor');
    assert.equal(interim.isFinal, false);
  });

  it('replaces interim with updated partial result', () => {
    buf.processResponse(mkResponse([mkWord('hell', { speaker: 0 })], { isFinal: false }));
    buf.processResponse(mkResponse([mkWord('hello world', { speaker: 0 })], { isFinal: false }));

    assert.equal(buf.getInterim(0)?.text, 'hello world');
    assert.equal(buf.entryCount, 0); // still no finals
  });

  it('clears interim when final result arrives', () => {
    buf.processResponse(mkResponse([mkWord('hello', { speaker: 0 })], { isFinal: false }));
    assert.ok(buf.getInterim(0) !== null);

    buf.processResponse(mkResponse([mkWord('hello world', { speaker: 0 })], { isFinal: true }));
    assert.equal(buf.getInterim(0), null);
    assert.equal(buf.entryCount, 1);
  });

  it('emits "interim" event for interim results', () => {
    const events = [];
    buf.on('interim', ({ entry }) => events.push(entry));

    buf.processResponse(mkResponse([mkWord('hi', { speaker: 0 })], { isFinal: false }));
    assert.equal(events.length, 1);
    assert.equal(events[0].isFinal, false);
  });

  it('emits "interim_cleared" when final clears interim', () => {
    const cleared = [];
    buf.on('interim_cleared', ({ speakerLabel }) => cleared.push(speakerLabel));

    buf.processResponse(mkResponse([mkWord('hi', { speaker: 0 })], { isFinal: false }));
    buf.processResponse(mkResponse([mkWord('hi there', { speaker: 0 })], { isFinal: true }));

    assert.deepEqual(cleared, [0]);
  });

  it('getAllInterim returns all current interims', () => {
    buf.resolveSpeaker(1, 'uid-1', 'Bob');
    buf.processResponse(mkResponse([mkWord('partial A', { speaker: 0 })], { isFinal: false }));
    buf.processResponse(mkResponse([mkWord('partial B', { speaker: 1 })], { isFinal: false }));

    const all = buf.getAllInterim();
    assert.equal(all.size, 2);
    assert.ok(all.has(0));
    assert.ok(all.has(1));
  });

  it('getInterim returns null when no interim exists', () => {
    assert.equal(buf.getInterim(0), null);
    assert.equal(buf.getInterim(99), null);
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — deduplication
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — deduplication', () => {
  let buf;
  beforeEach(() => {
    buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'uid-0', 'Alice');
  });

  it('suppresses exact duplicate final results from the same speaker', () => {
    const words = [mkWord('Hello world', { speaker: 0, start: 0.0 })];
    const resp = mkResponse(words);

    buf.processResponse(resp);
    buf.processResponse(resp); // same text + speaker → duplicate

    assert.equal(buf.entryCount, 1);
    assert.equal(buf.duplicateCount, 1);
  });

  it('emits "duplicate" event when suppressing', () => {
    const dupes = [];
    buf.on('duplicate', (info) => dupes.push(info));

    const resp = mkResponse([mkWord('Hello world', { speaker: 0, start: 0.0 })]);
    buf.processResponse(resp);
    buf.processResponse(resp);

    assert.equal(dupes.length, 1);
    assert.equal(dupes[0].speakerLabel, 0);
  });

  it('does NOT deduplicate identical text from different speakers', () => {
    buf.resolveSpeaker(1, 'uid-1', 'Bob');
    buf.processResponse(mkResponse([mkWord('Hello world', { speaker: 0, start: 0.0 })]));
    buf.processResponse(mkResponse([mkWord('Hello world', { speaker: 1, start: 0.1 })]));

    assert.equal(buf.entryCount, 2);
    assert.equal(buf.duplicateCount, 0);
  });

  it('does NOT deduplicate distinct utterances from same speaker', () => {
    buf.processResponse(mkResponse([mkWord('Hello world', { speaker: 0, start: 0.0 })]));
    buf.processResponse(mkResponse([mkWord('Good morning', { speaker: 0, start: 5.0 })]));

    assert.equal(buf.entryCount, 2);
    assert.equal(buf.duplicateCount, 0);
  });

  it('tracks totalProcessed correctly', () => {
    const resp = mkResponse([mkWord('Dup', { speaker: 0, start: 0.0 })]);
    buf.processResponse(resp); // processed=1
    buf.processResponse(resp); // processed=2, dup=1

    assert.equal(buf.totalProcessed, 2);
    assert.equal(buf.duplicateCount, 1);
    assert.equal(buf.entryCount, 1);
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — per-speaker queries
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — per-speaker queries', () => {
  let buf;
  beforeEach(() => {
    buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'uid-0', 'Alice');
    buf.resolveSpeaker(1, 'uid-1', 'Bob');

    buf.processResponse(mkResponse([mkWord('Alice says hi', { speaker: 0, start: 0.0 })]));
    buf.processResponse(mkResponse([mkWord('Bob says hi', { speaker: 1, start: 1.0 })]));
    buf.processResponse(mkResponse([mkWord('Alice again', { speaker: 0, start: 2.0 })]));
  });

  it('getEntriesBySpeaker returns all entries for a label', () => {
    const alice = buf.getEntriesBySpeaker(0);
    assert.equal(alice.length, 2);
    assert.equal(alice[0].text, 'Alice says hi');
    assert.equal(alice[1].text, 'Alice again');
  });

  it('getEntriesBySpeaker returns empty for unknown label', () => {
    assert.deepEqual(buf.getEntriesBySpeaker(99), []);
  });

  it('getEntriesByUserId returns all entries for a userId', () => {
    const bobEntries = buf.getEntriesByUserId('uid-1');
    assert.equal(bobEntries.length, 1);
    assert.equal(bobEntries[0].text, 'Bob says hi');
  });

  it('getSpeakerLabels lists all seen labels', () => {
    const labels = buf.getSpeakerLabels();
    assert.ok(labels.includes(0));
    assert.ok(labels.includes(1));
    assert.equal(labels.length, 2);
  });

  it('getSpeakerStats returns per-speaker aggregates', () => {
    const stats = buf.getSpeakerStats();

    assert.equal(stats.size, 2);
    const aliceStat = stats.get(0);
    assert.equal(aliceStat.userId, 'uid-0');
    assert.equal(aliceStat.displayName, 'Alice');
    assert.equal(aliceStat.entryCount, 2);
    assert.ok(aliceStat.wordCount > 0);

    const bobStat = stats.get(1);
    assert.equal(bobStat.entryCount, 1);
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — export helpers
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — export helpers', () => {
  let buf;
  beforeEach(() => {
    buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'uid-0', 'Alice');
    buf.resolveSpeaker(1, 'uid-1', 'Bob');
  });

  it('toPlainText formats entries with timestamps and names', () => {
    buf.processResponse(mkResponse([mkWord('Hello', { speaker: 0, start: 65.0 })]));
    buf.processResponse(mkResponse([mkWord('Hi', { speaker: 1, start: 130.0 })]));

    const text = buf.toPlainText();
    assert.ok(text.includes('[01:05] Alice: Hello'), `Missing Alice line. Got:\n${text}`);
    assert.ok(text.includes('[02:10] Bob: Hi'), `Missing Bob line. Got:\n${text}`);
  });

  it('toPlainText returns empty string when no entries', () => {
    assert.equal(buf.toPlainText(), '');
  });

  it('toStructuredData returns JSON-serializable entries', () => {
    buf.processResponse(mkResponse([mkWord('Test', { speaker: 0, start: 1.5 })]));

    const data = buf.toStructuredData();
    assert.equal(data.length, 1);
    assert.equal(data[0].speaker_id, 'uid-0');
    assert.equal(data[0].speaker_name, 'Alice');
    assert.equal(data[0].speaker_label, 0);
    assert.equal(data[0].text, 'Test');
    assert.equal(data[0].timestamp, 1.5);
    assert.equal(data[0].is_final, true);
    assert.ok('language' in data[0]);
    assert.ok('confidence' in data[0]);
    assert.ok('duration' in data[0]);
  });

  it('toStructuredData entries are serialisable to JSON without errors', () => {
    buf.processResponse(mkResponse([mkWord('Test', { speaker: 0 })]));
    assert.doesNotThrow(() => JSON.stringify(buf.toStructuredData()));
  });
});

// ──────────────────────────────────────────────────────────────────
// TranscriptBuffer — reset
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — reset', () => {
  it('clears all state on reset', () => {
    const buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'uid-0', 'Alice');

    buf.processResponse(mkResponse([mkWord('Hello', { speaker: 0 })], { isFinal: false }));
    buf.processResponse(mkResponse([mkWord('Hello world', { speaker: 0 })]));

    buf.reset();

    assert.equal(buf.entryCount, 0);
    assert.equal(buf.totalProcessed, 0);
    assert.equal(buf.duplicateCount, 0);
    assert.equal(buf.hasInterim, false);
    assert.deepEqual(buf.entries, []);
    // Speaker resolutions cleared too
    assert.equal(buf.getSpeakerResolution(0).displayName, 'Speaker 0');
  });
});

// ──────────────────────────────────────────────────────────────────
// Concurrent participants (5-10 speakers)
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — concurrent participants', () => {
  it('handles 10 speakers accumulating without collision', () => {
    const buf = new TranscriptBuffer({ sessionStartTime: 0 });
    for (let i = 0; i < 10; i++) {
      buf.resolveSpeaker(i, `uid-${i}`, `User${i}`);
    }

    for (let i = 0; i < 10; i++) {
      const words = [mkWord(`Message from user ${i}`, { speaker: i, start: i * 1.0 })];
      buf.processResponse(mkResponse(words));
    }

    assert.equal(buf.entryCount, 10);
    const stats = buf.getSpeakerStats();
    assert.equal(stats.size, 10);
    for (let i = 0; i < 10; i++) {
      assert.equal(stats.get(i)?.entryCount, 1);
    }
  });

  it('handles interleaved speakers across multiple responses', () => {
    const buf = new TranscriptBuffer({ sessionStartTime: 0 });
    for (let i = 0; i < 5; i++) {
      buf.resolveSpeaker(i, `uid-${i}`, `Speaker${i}`);
    }

    // Simulate round-robin interleaved speech in a single response
    const words = [];
    for (let turn = 0; turn < 3; turn++) {
      for (let spk = 0; spk < 5; spk++) {
        const t = turn * 5.0 + spk * 1.0;
        words.push(mkWord(`Turn${turn}S${spk}`, { speaker: spk, start: t, end: t + 0.5 }));
      }
    }
    const newEntries = buf.processResponse(mkResponse(words));

    // 3 turns × 5 speakers = 15 groups; some may be deduplicated but all 5 speakers must appear
    assert.ok(newEntries.length >= 5);
    const speakerIds = new Set(newEntries.map(e => e.speakerLabel));
    assert.equal(speakerIds.size, 5);
  });

  it('correctly partitions entries by speaker when querying', () => {
    const buf = new TranscriptBuffer({ sessionStartTime: 0 });
    for (let i = 0; i < 5; i++) {
      buf.resolveSpeaker(i, `uid-${i}`, `Speaker${i}`);
    }

    // 3 unique utterances per speaker at well-separated timestamps
    for (let round = 0; round < 3; round++) {
      for (let spk = 0; spk < 5; spk++) {
        const start = round * 30.0 + spk * 1.0;
        buf.processResponse(
          mkResponse([mkWord(`Round${round} utterance`, { speaker: spk, start })]),
        );
      }
    }

    for (let spk = 0; spk < 5; spk++) {
      const entries = buf.getEntriesBySpeaker(spk);
      assert.equal(entries.length, 3, `Speaker ${spk} should have 3 entries`);
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// Korean language support
// ──────────────────────────────────────────────────────────────────

describe('TranscriptBuffer — Korean language support', () => {
  it('correctly accumulates Korean utterances', () => {
    const buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'k1', '김철수');
    buf.resolveSpeaker(1, 'k2', '이영희');

    buf.processResponse(mkResponse([
      mkWord('회의를', { speaker: 0, start: 0.0 }),
      mkWord('시작하겠습니다', { speaker: 0, start: 0.3 }),
    ]));
    buf.processResponse(mkResponse([
      mkWord('네', { speaker: 1, start: 1.0 }),
      mkWord('알겠습니다', { speaker: 1, start: 1.2 }),
    ]));

    assert.equal(buf.entryCount, 2);
    const text = buf.toPlainText();
    assert.ok(text.includes('김철수'));
    assert.ok(text.includes('이영희'));
    assert.ok(text.includes('회의를 시작하겠습니다'));
  });

  it('detects Korean language on entries', () => {
    const buf = new TranscriptBuffer({ sessionStartTime: 0 });
    buf.resolveSpeaker(0, 'k1', '김철수');

    const [entry] = buf.processResponse(
      mkResponse([mkWord('안녕하세요', { speaker: 0, start: 0.0 })]),
    );
    assert.equal(entry.language, 'ko');
  });
});
