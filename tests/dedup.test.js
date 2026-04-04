/**
 * Tests for UtteranceDeduplicator and helper functions.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  UtteranceDeduplicator,
  normalizeText,
  textSimilarity,
  levenshteinDistance,
  isSubstringMatch,
  fingerprint,
  DEFAULT_DEDUP_CONFIG,
} from '../src/stt/dedup.js';

// ── Helper utilities ──

describe('normalizeText', () => {
  it('should lowercase and trim', () => {
    assert.equal(normalizeText('  Hello World  '), 'hello world');
  });

  it('should remove punctuation', () => {
    assert.equal(normalizeText('Hello, World!'), 'hello world');
  });

  it('should collapse whitespace', () => {
    assert.equal(normalizeText('hello   world'), 'hello world');
  });

  it('should handle Korean text', () => {
    assert.equal(normalizeText('  안녕하세요!  '), '안녕하세요');
  });

  it('should return empty string for empty input', () => {
    assert.equal(normalizeText(''), '');
    assert.equal(normalizeText('   '), '');
  });
});

describe('levenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    assert.equal(levenshteinDistance('hello', 'hello'), 0);
  });

  it('should return length for empty vs non-empty', () => {
    assert.equal(levenshteinDistance('hello', ''), 5);
    assert.equal(levenshteinDistance('', 'world'), 5);
  });

  it('should compute correct distance', () => {
    assert.equal(levenshteinDistance('kitten', 'sitting'), 3);
    assert.equal(levenshteinDistance('abc', 'abd'), 1);
  });
});

describe('textSimilarity', () => {
  it('should return 1.0 for identical text', () => {
    assert.equal(textSimilarity('hello world', 'hello world'), 1.0);
  });

  it('should return 1.0 for text differing only in case/punctuation', () => {
    assert.equal(textSimilarity('Hello, World!', 'hello world'), 1.0);
  });

  it('should return 0.0 when one string is empty', () => {
    assert.equal(textSimilarity('hello', ''), 0.0);
  });

  it('should return a value between 0 and 1 for similar strings', () => {
    const sim = textSimilarity('the meeting starts now', 'the meeting started now');
    assert.ok(sim > 0.5 && sim < 1.0, `Expected between 0.5 and 1.0, got ${sim}`);
  });
});

describe('isSubstringMatch', () => {
  it('should detect substantial substring', () => {
    assert.equal(isSubstringMatch('the meeting', 'the meeting starts'), true);
  });

  it('should reject short substrings', () => {
    assert.equal(isSubstringMatch('hi', 'hi there how are you doing'), false);
  });

  it('should return false for empty strings', () => {
    assert.equal(isSubstringMatch('', 'hello'), false);
  });
});

describe('fingerprint', () => {
  it('should be deterministic', () => {
    const fp1 = fingerprint('speaker1', 'Hello World');
    const fp2 = fingerprint('speaker1', 'Hello World');
    assert.equal(fp1, fp2);
  });

  it('should differ for different speakers', () => {
    const fp1 = fingerprint('speaker1', 'Hello');
    const fp2 = fingerprint('speaker2', 'Hello');
    assert.notEqual(fp1, fp2);
  });

  it('should normalize text before hashing', () => {
    const fp1 = fingerprint('s1', 'Hello, World!');
    const fp2 = fingerprint('s1', 'hello world');
    assert.equal(fp1, fp2);
  });
});

// ── UtteranceDeduplicator ──

describe('UtteranceDeduplicator', () => {
  let dedup;

  beforeEach(() => {
    dedup = new UtteranceDeduplicator();
  });

  describe('empty text', () => {
    it('should mark empty text as duplicate', () => {
      const result = dedup.check({ speaker: 0, text: '', timestamp: 0, isFinal: true });
      assert.equal(result.isDuplicate, true);
      assert.equal(result.reason, 'empty_text');
    });

    it('should mark whitespace-only text as duplicate', () => {
      const result = dedup.check({ speaker: 0, text: '   ', timestamp: 0, isFinal: true });
      assert.equal(result.isDuplicate, true);
      assert.equal(result.reason, 'empty_text');
    });
  });

  describe('exact fingerprint match', () => {
    it('should detect exact duplicates from same speaker', () => {
      const u1 = { speaker: 0, text: 'hello world', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'hello world', timestamp: 3.0, isFinal: true };

      const r1 = dedup.check(u1);
      assert.equal(r1.isDuplicate, false);

      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint');
      assert.equal(r2.similarityScore, 1.0);
    });

    it('should not flag exact match from different speaker', () => {
      const u1 = { speaker: 0, text: 'hello world', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 1, text: 'hello world', timestamp: 3.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should allow exact match outside exact match window', () => {
      const dedup2 = new UtteranceDeduplicator({ exactMatchWindow: 2.0, timeWindow: 2.0 });
      const u1 = { speaker: 0, text: 'hello', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'hello', timestamp: 5.0, isFinal: true };

      dedup2.check(u1);
      const r2 = dedup2.check(u2);
      assert.equal(r2.isDuplicate, false);
    });
  });

  describe('fuzzy match', () => {
    it('should detect near-duplicate utterances', () => {
      const u1 = { speaker: 0, text: 'the meeting starts now', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the meeting starts  now.', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint'); // normalizes to same text
    });

    it('should detect fuzzy duplicates above threshold', () => {
      const u1 = { speaker: 0, text: 'the meeting will start soon', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the meeting will starts soon', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'fuzzy_match');
    });

    it('should allow sufficiently different utterances', () => {
      const u1 = { speaker: 0, text: 'good morning everyone', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'lets start the meeting', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should not match utterances outside time window', () => {
      const u1 = { speaker: 0, text: 'hello world', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'hello world!', timestamp: 100.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      // Outside 5s time window, fingerprint might still catch exact match within 10s window
      // but at 100s it's beyond exactMatchWindow too
      assert.equal(r2.isDuplicate, false);
    });
  });

  describe('substring match', () => {
    it('should detect partial-to-full progression as duplicate', () => {
      const u1 = { speaker: 0, text: 'the meeting agenda', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the meeting agenda today', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      // fuzzy_match or substring_match — both are valid dedup reasons
      assert.ok(['fuzzy_match', 'substring_match'].includes(r2.reason),
        `Expected fuzzy_match or substring_match, got ${r2.reason}`);
    });
  });

  describe('interim deduplication', () => {
    it('should accept first interim from a speaker', () => {
      const u = { speaker: 0, text: 'the meet', timestamp: 1.0, isFinal: false };
      const r = dedup.check(u);
      assert.equal(r.isDuplicate, false);
    });

    it('should mark interim update as duplicate (continuation)', () => {
      const u1 = { speaker: 0, text: 'the meet', timestamp: 1.0, isFinal: false };
      const u2 = { speaker: 0, text: 'the meeting', timestamp: 1.5, isFinal: false };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'interim_update');
    });

    it('should accept new interim from different speaker', () => {
      const u1 = { speaker: 0, text: 'hello', timestamp: 1.0, isFinal: false };
      const u2 = { speaker: 1, text: 'hello', timestamp: 1.5, isFinal: false };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should accept very different interim from same speaker', () => {
      const u1 = { speaker: 0, text: 'good morning', timestamp: 1.0, isFinal: false };
      const u2 = { speaker: 0, text: 'completely different topic', timestamp: 5.0, isFinal: false };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });
  });

  describe('finalizeInterim', () => {
    it('should return and clear interim cache for speaker', () => {
      const u = { speaker: 0, text: 'hello', timestamp: 1.0, isFinal: false };
      dedup.check(u);

      const finalized = dedup.finalizeInterim(0);
      assert.deepEqual(finalized, u);

      const again = dedup.finalizeInterim(0);
      assert.equal(again, null);
    });
  });

  describe('reset', () => {
    it('should clear all state', () => {
      dedup.check({ speaker: 0, text: 'hello', timestamp: 1.0, isFinal: true });
      dedup.check({ speaker: 0, text: 'world', timestamp: 2.0, isFinal: true });
      assert.equal(dedup.windowSize, 2);

      dedup.reset();
      assert.equal(dedup.windowSize, 0);

      // Previously duplicate should now be accepted
      const r = dedup.check({ speaker: 0, text: 'hello', timestamp: 3.0, isFinal: true });
      assert.equal(r.isDuplicate, false);
    });
  });

  describe('windowSize', () => {
    it('should track accepted utterances', () => {
      assert.equal(dedup.windowSize, 0);
      dedup.check({ speaker: 0, text: 'first', timestamp: 1.0, isFinal: true });
      assert.equal(dedup.windowSize, 1);
      dedup.check({ speaker: 0, text: 'second', timestamp: 2.0, isFinal: true });
      assert.equal(dedup.windowSize, 2);
    });

    it('should enforce max window size', () => {
      const smallDedup = new UtteranceDeduplicator({ windowSize: 3, timeWindow: 0.5 });
      const distinctTexts = [
        'alpha bravo charlie',
        'delta echo foxtrot',
        'golf hotel india',
        'juliet kilo lima',
        'mike november oscar',
      ];
      for (let i = 0; i < 5; i++) {
        smallDedup.check({ speaker: i, text: distinctTexts[i], timestamp: i * 10, isFinal: true });
      }
      assert.equal(smallDedup.windowSize, 3);
    });
  });

  // ── Comprehensive duplicate detection tests ──

  describe('exact duplicate detection', () => {
    it('should detect identical text repeated immediately', () => {
      const u1 = { speaker: 0, text: 'we need to discuss the budget', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'we need to discuss the budget', timestamp: 1.5, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint');
      assert.equal(r2.similarityScore, 1.0);
    });

    it('should detect exact duplicate that differs only in punctuation', () => {
      const u1 = { speaker: 0, text: 'let\'s begin.', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'let\'s begin', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint');
    });

    it('should detect exact duplicate that differs only in casing', () => {
      const u1 = { speaker: 0, text: 'Hello Everyone', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'hello everyone', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint');
    });

    it('should detect exact duplicate that differs only in whitespace', () => {
      const u1 = { speaker: 0, text: 'good  morning   everyone', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'good morning everyone', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint');
    });

    it('should detect exact duplicate Korean utterances', () => {
      const u1 = { speaker: 0, text: '다음 안건으로 넘어가겠습니다', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: '다음 안건으로 넘어가겠습니다', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'exact_fingerprint');
    });

    it('should detect exact duplicate with mixed Korean and English', () => {
      const u1 = { speaker: 0, text: 'API 서버 배포 완료', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'API 서버 배포 완료', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should detect triple-repeated utterance (only first accepted)', () => {
      const text = 'the quarterly report is ready';
      const r1 = dedup.check({ speaker: 0, text, timestamp: 1.0, isFinal: true });
      const r2 = dedup.check({ speaker: 0, text, timestamp: 2.0, isFinal: true });
      const r3 = dedup.check({ speaker: 0, text, timestamp: 3.0, isFinal: true });

      assert.equal(r1.isDuplicate, false);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r3.isDuplicate, true);
    });
  });

  describe('near-duplicate detection', () => {
    it('should detect STT stutter (minor word variation)', () => {
      const u1 = { speaker: 0, text: 'we should review the proposal', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'we should review the proposals', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.ok(['fuzzy_match', 'substring_match'].includes(r2.reason));
    });

    it('should detect near-duplicate with a single typo', () => {
      const u1 = { speaker: 0, text: 'the deployment pipeline is broken', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the deployment pipline is broken', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'fuzzy_match');
      assert.ok(r2.similarityScore >= 0.75, `Similarity ${r2.similarityScore} should be >= 0.75`);
    });

    it('should detect near-duplicate with extra filler word', () => {
      const u1 = { speaker: 0, text: 'I think we should proceed', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'I think we should just proceed', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should detect near-duplicate Korean with minor variation', () => {
      const u1 = { speaker: 0, text: '이번 분기 실적을 확인해봅시다', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: '이번 분기 실적을 확인해 봅시다', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should detect partial result growing into full result (substring)', () => {
      const u1 = { speaker: 0, text: 'next item on the agenda', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'next item on the agenda is budget', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
      assert.ok(['fuzzy_match', 'substring_match'].includes(r2.reason));
    });

    it('should detect overlapping audio chunk near-duplicates', () => {
      // Simulates overlapping audio chunks producing slightly different transcriptions
      const u1 = { speaker: 0, text: 'the server crashed at midnight', timestamp: 10.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the server crashed at midnight last', timestamp: 10.5, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should detect interim-to-interim near-duplicate updates', () => {
      const u1 = { speaker: 0, text: 'we need to', timestamp: 1.0, isFinal: false };
      const u2 = { speaker: 0, text: 'we need to talk', timestamp: 1.3, isFinal: false };
      const u3 = { speaker: 0, text: 'we need to talk about', timestamp: 1.6, isFinal: false };

      const r1 = dedup.check(u1);
      const r2 = dedup.check(u2);
      const r3 = dedup.check(u3);

      assert.equal(r1.isDuplicate, false);
      assert.equal(r2.isDuplicate, true);
      assert.equal(r2.reason, 'interim_update');
      assert.equal(r3.isDuplicate, true);
      assert.equal(r3.reason, 'interim_update');
    });
  });

  describe('legitimate repeated phrases (should NOT be flagged)', () => {
    it('should allow same phrase from different speakers', () => {
      const u1 = { speaker: 0, text: 'I agree with that', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 1, text: 'I agree with that', timestamp: 2.0, isFinal: true };
      const u3 = { speaker: 2, text: 'I agree with that', timestamp: 3.0, isFinal: true };

      const r1 = dedup.check(u1);
      const r2 = dedup.check(u2);
      const r3 = dedup.check(u3);

      assert.equal(r1.isDuplicate, false);
      assert.equal(r2.isDuplicate, false);
      assert.equal(r3.isDuplicate, false);
    });

    it('should allow same speaker repeating a phrase after time window expires', () => {
      const customDedup = new UtteranceDeduplicator({ timeWindow: 2.0, exactMatchWindow: 3.0 });
      const u1 = { speaker: 0, text: 'can you hear me', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'can you hear me', timestamp: 10.0, isFinal: true };

      customDedup.check(u1);
      const r2 = customDedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should allow genuinely different sentences from same speaker', () => {
      const u1 = { speaker: 0, text: 'the revenue increased by 10 percent', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the expenses decreased by 5 percent', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should allow sequential distinct Korean sentences from same speaker', () => {
      const u1 = { speaker: 0, text: '먼저 매출 현황을 보겠습니다', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: '다음으로 비용 절감 방안입니다', timestamp: 3.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should allow speaker repeating acknowledgment in a conversation flow', () => {
      // Speaker 0 says "yes", then speaker 1 says something, then speaker 0 says "yes" again
      // This is a legitimate repeated acknowledgment after reset context
      const customDedup = new UtteranceDeduplicator({ timeWindow: 2.0, exactMatchWindow: 3.0 });
      customDedup.check({ speaker: 0, text: 'yes I understand', timestamp: 1.0, isFinal: true });
      customDedup.check({ speaker: 1, text: 'so we will proceed with plan B', timestamp: 5.0, isFinal: true });
      const r3 = customDedup.check({ speaker: 0, text: 'yes I understand', timestamp: 10.0, isFinal: true });
      assert.equal(r3.isDuplicate, false);
    });

    it('should allow short but distinct utterances from same speaker', () => {
      const u1 = { speaker: 0, text: 'hello', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'world', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should allow mixed-language utterances that are different', () => {
      const u1 = { speaker: 0, text: 'deploy the API server', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'API 서버 모니터링 확인', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should allow different speakers saying similar things simultaneously', () => {
      // In meetings, multiple people might say similar things at once
      const u1 = { speaker: 0, text: 'sounds good to me', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 1, text: 'sounds good to me too', timestamp: 1.2, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false); // different speakers
    });

    it('should allow a phrase repeated after session reset', () => {
      dedup.check({ speaker: 0, text: 'meeting started', timestamp: 1.0, isFinal: true });
      dedup.reset();
      const r = dedup.check({ speaker: 0, text: 'meeting started', timestamp: 2.0, isFinal: true });
      assert.equal(r.isDuplicate, false);
    });
  });

  describe('edge cases for duplicate detection', () => {
    it('should handle very long utterances for exact match', () => {
      const longText = 'this is a very long sentence that goes on and on about various topics including the quarterly budget review and the upcoming product launch timeline and resource allocation';
      const u1 = { speaker: 0, text: longText, timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: longText, timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should handle single-word exact duplicates', () => {
      const u1 = { speaker: 0, text: 'okay', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'okay', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should handle numeric content duplicates', () => {
      const u1 = { speaker: 0, text: 'the value is 42000', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'the value is 42000', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, true);
    });

    it('should not false-positive on sentences sharing common prefix', () => {
      const u1 = { speaker: 0, text: 'we need to increase the marketing budget significantly', timestamp: 1.0, isFinal: true };
      const u2 = { speaker: 0, text: 'we need to decrease the engineering headcount immediately', timestamp: 2.0, isFinal: true };

      dedup.check(u1);
      const r2 = dedup.check(u2);
      assert.equal(r2.isDuplicate, false);
    });

    it('should handle rapid-fire from multiple concurrent speakers', () => {
      // 5 different speakers talking within a second
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(dedup.check({
          speaker: i,
          text: `speaker ${i} has a unique point to make`,
          timestamp: 1.0 + i * 0.2,
          isFinal: true,
        }));
      }
      assert.ok(results.every(r => !r.isDuplicate), 'All unique speakers should be accepted');
    });

    it('should handle interleaved interim and final from multiple speakers', () => {
      // Speaker 0 interim, Speaker 1 interim, Speaker 0 final, Speaker 1 final
      const r1 = dedup.check({ speaker: 0, text: 'first point', timestamp: 1.0, isFinal: false });
      const r2 = dedup.check({ speaker: 1, text: 'second point', timestamp: 1.2, isFinal: false });
      const r3 = dedup.check({ speaker: 0, text: 'first point is about budget', timestamp: 1.5, isFinal: true });
      const r4 = dedup.check({ speaker: 1, text: 'second point is about timeline', timestamp: 1.8, isFinal: true });

      assert.equal(r1.isDuplicate, false);
      assert.equal(r2.isDuplicate, false);
      assert.equal(r3.isDuplicate, false); // final result should be accepted
      assert.equal(r4.isDuplicate, false); // final result should be accepted
    });
  });

  describe('DEFAULT_DEDUP_CONFIG', () => {
    it('should have expected defaults', () => {
      assert.equal(DEFAULT_DEDUP_CONFIG.timeWindow, 5.0);
      assert.equal(DEFAULT_DEDUP_CONFIG.similarityThreshold, 0.75);
      assert.equal(DEFAULT_DEDUP_CONFIG.windowSize, 100);
      assert.equal(DEFAULT_DEDUP_CONFIG.deduplicateInterim, true);
      assert.equal(DEFAULT_DEDUP_CONFIG.exactMatchWindow, 10.0);
    });
  });

  describe('real-world STT scenarios', () => {
    it('should handle rapid identical Deepgram results', () => {
      // Deepgram sometimes sends identical results rapidly
      const text = '안녕하세요 회의를 시작하겠습니다';
      const results = [];
      for (let i = 0; i < 5; i++) {
        results.push(dedup.check({
          speaker: 0,
          text,
          timestamp: 1.0 + i * 0.1,
          isFinal: true,
        }));
      }
      // First should pass, rest should be duplicates
      assert.equal(results[0].isDuplicate, false);
      assert.ok(results.slice(1).every(r => r.isDuplicate));
    });

    it('should handle interim → final progression correctly', () => {
      // Interim updates should be suppressed; final should pass
      dedup.check({ speaker: 0, text: '안녕', timestamp: 1.0, isFinal: false });
      const r2 = dedup.check({ speaker: 0, text: '안녕하세요', timestamp: 1.5, isFinal: false });
      assert.equal(r2.isDuplicate, true); // interim update

      // Final result should pass (different enough or new context)
      const r3 = dedup.check({ speaker: 0, text: '안녕하세요 회의를 시작합니다', timestamp: 2.0, isFinal: true });
      assert.equal(r3.isDuplicate, false);
    });

    it('should allow same content from different speakers', () => {
      dedup.check({ speaker: 0, text: 'agree', timestamp: 1.0, isFinal: true });
      const r2 = dedup.check({ speaker: 1, text: 'agree', timestamp: 2.0, isFinal: true });
      assert.equal(r2.isDuplicate, false);
    });
  });
});
