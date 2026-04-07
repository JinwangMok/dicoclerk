/**
 * Tests for diarization-config.js
 *
 * Validates:
 *  1. DIARIZATION_OPTIONS exports required diarization parameters
 *  2. buildDiarizationOptions() merges and validates correctly
 *  3. validateDiarizationOptions() enforces invariants
 *  4. groupWordsBySpeaker() correctly segments words by speaker label,
 *     including mid-segment speaker transitions (the core of Sub-AC 2)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SPEAKERS,
  DIARIZATION_MODEL,
  DIARIZATION_OPTIONS,
  buildDiarizationOptions,
  validateDiarizationOptions,
  groupWordsBySpeaker,
} from '../src/stt/diarization-config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('diarization-config – constants', () => {
  it('MAX_SPEAKERS is 10', () => {
    assert.equal(MAX_SPEAKERS, 10);
  });

  it('DIARIZATION_MODEL is nova-2', () => {
    assert.equal(DIARIZATION_MODEL, 'nova-2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DIARIZATION_OPTIONS
// ─────────────────────────────────────────────────────────────────────────────

describe('DIARIZATION_OPTIONS – required diarization fields', () => {
  it('diarize is true', () => {
    assert.equal(DIARIZATION_OPTIONS.diarize, true,
      'diarize must be enabled for speaker identification');
  });

  it('diarize_max_speakers equals MAX_SPEAKERS (10)', () => {
    assert.equal(DIARIZATION_OPTIONS.diarize_max_speakers, MAX_SPEAKERS,
      'diarize_max_speakers must match MAX_SPEAKERS');
  });

  it('diarize_max_speakers is >= 10 to support full channel capacity', () => {
    assert.ok(
      DIARIZATION_OPTIONS.diarize_max_speakers >= 10,
      `diarize_max_speakers must be >= 10, got ${DIARIZATION_OPTIONS.diarize_max_speakers}`
    );
  });

  it('model is nova-2', () => {
    assert.equal(DIARIZATION_OPTIONS.model, 'nova-2',
      'nova-2 is required for multilingual diarization with up to 10 speakers');
  });

  it('language is ko (Korean primary)', () => {
    assert.equal(DIARIZATION_OPTIONS.language, 'ko');
  });

  it('detect_language is true for Korean/English code-switching', () => {
    assert.equal(DIARIZATION_OPTIONS.detect_language, true);
  });

  it('smart_format is true', () => {
    assert.equal(DIARIZATION_OPTIONS.smart_format, true);
  });

  it('punctuate is true', () => {
    assert.equal(DIARIZATION_OPTIONS.punctuate, true);
  });

  it('interim_results is true for real-time feedback', () => {
    assert.equal(DIARIZATION_OPTIONS.interim_results, true);
  });

  it('vad_events is true', () => {
    assert.equal(DIARIZATION_OPTIONS.vad_events, true);
  });

  it('endpointing is a positive number', () => {
    assert.ok(
      typeof DIARIZATION_OPTIONS.endpointing === 'number' &&
      DIARIZATION_OPTIONS.endpointing > 0,
      `endpointing must be a positive number, got ${DIARIZATION_OPTIONS.endpointing}`
    );
  });

  it('utterance_end_ms is a positive number', () => {
    assert.ok(
      typeof DIARIZATION_OPTIONS.utterance_end_ms === 'number' &&
      DIARIZATION_OPTIONS.utterance_end_ms > 0,
      `utterance_end_ms must be a positive number, got ${DIARIZATION_OPTIONS.utterance_end_ms}`
    );
  });

  it('multichannel is NOT set (mono mixed stream)', () => {
    assert.equal(
      DIARIZATION_OPTIONS.multichannel,
      undefined,
      'multichannel should not be set — dicoclerk sends a mono mixed stream'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateDiarizationOptions
// ─────────────────────────────────────────────────────────────────────────────

describe('validateDiarizationOptions', () => {
  it('accepts valid options without throwing', () => {
    assert.doesNotThrow(() =>
      validateDiarizationOptions({
        diarize: true,
        diarize_max_speakers: 10,
        model: 'nova-2',
      })
    );
  });

  it('accepts diarize_max_speakers > 10', () => {
    assert.doesNotThrow(() =>
      validateDiarizationOptions({
        diarize: true,
        diarize_max_speakers: 20,
        model: 'nova-2',
      })
    );
  });

  it('throws TypeError when diarize is false', () => {
    assert.throws(
      () => validateDiarizationOptions({ diarize: false, diarize_max_speakers: 10, model: 'nova-2' }),
      TypeError
    );
  });

  it('throws TypeError when diarize is missing', () => {
    assert.throws(
      () => validateDiarizationOptions({ diarize_max_speakers: 10, model: 'nova-2' }),
      TypeError
    );
  });

  it('throws TypeError when diarize_max_speakers < 10', () => {
    assert.throws(
      () => validateDiarizationOptions({ diarize: true, diarize_max_speakers: 5, model: 'nova-2' }),
      TypeError
    );
  });

  it('throws TypeError when diarize_max_speakers is not a number', () => {
    assert.throws(
      () => validateDiarizationOptions({ diarize: true, diarize_max_speakers: '10', model: 'nova-2' }),
      TypeError
    );
  });

  it('throws TypeError when model is empty string', () => {
    assert.throws(
      () => validateDiarizationOptions({ diarize: true, diarize_max_speakers: 10, model: '' }),
      TypeError
    );
  });

  it('throws TypeError when model is missing', () => {
    assert.throws(
      () => validateDiarizationOptions({ diarize: true, diarize_max_speakers: 10 }),
      TypeError
    );
  });

  it('error message mentions diarize_max_speakers constraint', () => {
    let message = '';
    try {
      validateDiarizationOptions({ diarize: true, diarize_max_speakers: 3, model: 'nova-2' });
    } catch (e) {
      message = e.message;
    }
    assert.ok(
      message.includes('diarize_max_speakers') && message.includes('10'),
      `Error message should mention diarize_max_speakers and 10: "${message}"`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildDiarizationOptions
// ─────────────────────────────────────────────────────────────────────────────

describe('buildDiarizationOptions', () => {
  it('returns DIARIZATION_OPTIONS when called with no overrides', () => {
    const opts = buildDiarizationOptions();
    assert.equal(opts.diarize, true);
    assert.equal(opts.diarize_max_speakers, MAX_SPEAKERS);
    assert.equal(opts.model, 'nova-2');
    assert.equal(opts.language, 'ko');
  });

  it('merges overrides with base DIARIZATION_OPTIONS', () => {
    const opts = buildDiarizationOptions({ language: 'en' });
    assert.equal(opts.language, 'en');
    // Other diarization settings preserved
    assert.equal(opts.diarize, true);
    assert.equal(opts.diarize_max_speakers, MAX_SPEAKERS);
    assert.equal(opts.model, 'nova-2');
  });

  it('allows higher diarize_max_speakers override', () => {
    const opts = buildDiarizationOptions({ diarize_max_speakers: 20 });
    assert.equal(opts.diarize_max_speakers, 20);
  });

  it('allows model override', () => {
    const opts = buildDiarizationOptions({ model: 'nova-2-general' });
    assert.equal(opts.model, 'nova-2-general');
  });

  it('returns a new object (does not mutate DIARIZATION_OPTIONS)', () => {
    const opts = buildDiarizationOptions({ language: 'en' });
    assert.equal(DIARIZATION_OPTIONS.language, 'ko', 'DIARIZATION_OPTIONS must not be mutated');
  });

  it('throws when overrides disable diarize', () => {
    assert.throws(
      () => buildDiarizationOptions({ diarize: false }),
      TypeError
    );
  });

  it('throws when overrides set diarize_max_speakers below 10', () => {
    assert.throws(
      () => buildDiarizationOptions({ diarize_max_speakers: 4 }),
      TypeError
    );
  });

  it('returns options object that passes validateDiarizationOptions', () => {
    const opts = buildDiarizationOptions({ language: 'en', endpointing: 500 });
    assert.doesNotThrow(() => validateDiarizationOptions(opts));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// groupWordsBySpeaker – core of Sub-AC 2 speaker segmentation
// ─────────────────────────────────────────────────────────────────────────────

describe('groupWordsBySpeaker – single speaker', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(groupWordsBySpeaker([]), []);
  });

  it('returns empty array for null/undefined', () => {
    assert.deepEqual(groupWordsBySpeaker(null), []);
    assert.deepEqual(groupWordsBySpeaker(undefined), []);
  });

  it('groups a single word into one segment', () => {
    const words = [
      { word: 'hello', speaker: 0, start: 0.0, end: 0.4, confidence: 0.9 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].speaker, 0);
    assert.equal(groups[0].text, 'hello');
    assert.equal(groups[0].start, 0.0);
    assert.equal(groups[0].end, 0.4);
    assert.equal(groups[0].confidence, 0.9);
    assert.equal(groups[0].words.length, 1);
  });

  it('groups multiple words from the same speaker into one segment', () => {
    const words = [
      { word: '안녕하세요', speaker: 0, start: 0.0, end: 0.5, confidence: 0.92 },
      { word: '반갑습니다', speaker: 0, start: 0.6, end: 1.1, confidence: 0.88 },
      { word: '저는', speaker: 0, start: 1.2, end: 1.5, confidence: 0.95 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 1, 'All words from speaker 0 should be one group');
    assert.equal(groups[0].speaker, 0);
    assert.equal(groups[0].start, 0.0);
    assert.equal(groups[0].end, 1.5);
    assert.equal(groups[0].words.length, 3);
    // Confidence should be average
    const expectedConf = (0.92 + 0.88 + 0.95) / 3;
    assert.ok(
      Math.abs(groups[0].confidence - expectedConf) < 0.001,
      `Expected avg confidence ~${expectedConf.toFixed(3)}, got ${groups[0].confidence}`
    );
  });

  it('joins words with spaces in text', () => {
    const words = [
      { word: 'good', punctuated_word: 'Good', speaker: 0, start: 0.0, end: 0.3, confidence: 0.9 },
      { word: 'morning', punctuated_word: 'morning.', speaker: 0, start: 0.4, end: 0.8, confidence: 0.9 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].text, 'Good morning.');
  });

  it('prefers punctuated_word over word for text', () => {
    const words = [
      { word: 'hello', punctuated_word: 'Hello,', speaker: 0, start: 0.0, end: 0.4, confidence: 0.9 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups[0].text, 'Hello,');
  });
});

describe('groupWordsBySpeaker – mid-segment speaker transitions (Sub-AC 2 core)', () => {
  it('splits words from two speakers into two groups', () => {
    const words = [
      { word: '알겠어요', speaker: 0, start: 0.0, end: 0.5, confidence: 0.9 },
      { word: 'yes', speaker: 1, start: 0.6, end: 0.9, confidence: 0.85 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2, 'Two speakers → two groups');
    assert.equal(groups[0].speaker, 0);
    assert.equal(groups[0].text, '알겠어요');
    assert.equal(groups[1].speaker, 1);
    assert.equal(groups[1].text, 'yes');
  });

  it('splits words from three speakers into three groups', () => {
    const words = [
      { word: '좋아요', speaker: 0, start: 0.0, end: 0.4, confidence: 0.9 },
      { word: 'okay', speaker: 1, start: 0.5, end: 0.8, confidence: 0.88 },
      { word: '감사합니다', speaker: 2, start: 0.9, end: 1.4, confidence: 0.92 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 3);
    assert.equal(groups[0].speaker, 0);
    assert.equal(groups[1].speaker, 1);
    assert.equal(groups[2].speaker, 2);
  });

  it('handles speaker returning after being interrupted (A-B-A pattern)', () => {
    // Speaker 0 speaks, speaker 1 interrupts, speaker 0 resumes
    const words = [
      { word: '그래서', speaker: 0, start: 0.0, end: 0.3, confidence: 0.9 },
      { word: '잠깐만요', speaker: 1, start: 0.4, end: 0.8, confidence: 0.88 },
      { word: '계속할게요', speaker: 0, start: 0.9, end: 1.3, confidence: 0.91 },
    ];
    const groups = groupWordsBySpeaker(words);
    // A-B-A yields 3 groups (not 2) because word-level grouping is sequential
    assert.equal(groups.length, 3,
      'A-B-A pattern creates 3 groups (consecutive grouping)');
    assert.equal(groups[0].speaker, 0);
    assert.equal(groups[1].speaker, 1);
    assert.equal(groups[2].speaker, 0);
  });

  it('correctly captures time range per group', () => {
    const words = [
      { word: '네', speaker: 0, start: 1.0, end: 1.2, confidence: 0.9 },
      { word: '맞아요', speaker: 0, start: 1.3, end: 1.7, confidence: 0.9 },
      { word: 'right', speaker: 1, start: 1.8, end: 2.1, confidence: 0.87 },
      { word: 'exactly', speaker: 1, start: 2.2, end: 2.6, confidence: 0.89 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].start, 1.0);
    assert.equal(groups[0].end, 1.7);
    assert.equal(groups[1].start, 1.8);
    assert.equal(groups[1].end, 2.6);
  });

  it('words array per group contains only that group\'s words', () => {
    const words = [
      { word: 'a', speaker: 0, start: 0.0, end: 0.2, confidence: 0.9 },
      { word: 'b', speaker: 0, start: 0.3, end: 0.5, confidence: 0.9 },
      { word: 'c', speaker: 1, start: 0.6, end: 0.8, confidence: 0.9 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups[0].words.length, 2, 'Speaker 0 group has 2 words');
    assert.equal(groups[1].words.length, 1, 'Speaker 1 group has 1 word');
    assert.equal(groups[0].words[0].word, 'a');
    assert.equal(groups[0].words[1].word, 'b');
    assert.equal(groups[1].words[0].word, 'c');
  });

  it('handles unknown speaker label (-1) as its own group', () => {
    const words = [
      { word: 'hello', speaker: -1, start: 0.0, end: 0.4, confidence: 0.7 },
      { word: '안녕', speaker: 0, start: 0.5, end: 0.8, confidence: 0.9 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].speaker, -1);
    assert.equal(groups[1].speaker, 0);
  });

  it('handles up to 10 distinct speakers in one result event', () => {
    // Simulate a pathological result with all 10 speakers appearing once
    const words = Array.from({ length: 10 }, (_, i) => ({
      word: `word${i}`,
      speaker: i,
      start: i * 0.5,
      end: i * 0.5 + 0.4,
      confidence: 0.9,
    }));
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 10, '10 distinct speakers → 10 groups');
    for (let i = 0; i < 10; i++) {
      assert.equal(groups[i].speaker, i, `Group ${i} should be speaker ${i}`);
    }
  });

  it('does not expose internal bookkeeping fields (_confidenceSum, _wordCount)', () => {
    const words = [
      { word: 'hello', speaker: 0, start: 0.0, end: 0.4, confidence: 0.9 },
      { word: 'world', speaker: 0, start: 0.5, end: 0.9, confidence: 0.8 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups[0]._confidenceSum, undefined, '_confidenceSum should be removed');
    assert.equal(groups[0]._wordCount, undefined, '_wordCount should be removed');
  });

  it('handles words missing optional fields gracefully', () => {
    const words = [
      { speaker: 0 },           // missing word/start/end/confidence
      { word: 'ok', speaker: 1 },
    ];
    assert.doesNotThrow(() => groupWordsBySpeaker(words));
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2);
  });
});

describe('groupWordsBySpeaker – Korean/English mixed content', () => {
  it('handles Korean-English code-switching across speakers', () => {
    const words = [
      { word: '안녕하세요', punctuated_word: '안녕하세요,', speaker: 0, start: 0.0, end: 0.6, confidence: 0.93 },
      { word: '저는', punctuated_word: '저는', speaker: 0, start: 0.7, end: 0.9, confidence: 0.91 },
      { word: 'hi', punctuated_word: 'Hi!', speaker: 1, start: 1.0, end: 1.2, confidence: 0.95 },
      { word: '반갑습니다', punctuated_word: '반갑습니다.', speaker: 1, start: 1.3, end: 1.8, confidence: 0.89 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].speaker, 0);
    assert.equal(groups[0].text, '안녕하세요, 저는');
    assert.equal(groups[1].speaker, 1);
    assert.equal(groups[1].text, 'Hi! 반갑습니다.');
  });

  it('handles all-Korean segment with no speaker transitions', () => {
    const words = [
      { word: '이번', speaker: 0, start: 0.0, end: 0.3, confidence: 0.95 },
      { word: '회의에서', speaker: 0, start: 0.4, end: 0.8, confidence: 0.93 },
      { word: '논의할', speaker: 0, start: 0.9, end: 1.2, confidence: 0.91 },
      { word: '주제는', speaker: 0, start: 1.3, end: 1.6, confidence: 0.90 },
    ];
    const groups = groupWordsBySpeaker(words);
    assert.equal(groups.length, 1, 'All Korean, same speaker → single group');
    assert.equal(groups[0].words.length, 4);
  });
});
