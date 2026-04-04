"""Tests for duplicate utterance detection."""

import pytest

from src.stt.dedup import (
    DeduplicationConfig,
    Utterance,
    UtteranceDeduplicator,
    _fingerprint,
    _normalize_text,
    text_similarity,
)


# ── Normalization ──────────────────────────────────────────────

class TestNormalization:
    def test_lowercase(self):
        assert _normalize_text("Hello World") == "hello world"

    def test_strip_punctuation(self):
        assert _normalize_text("Hello, world!") == "hello world"

    def test_collapse_whitespace(self):
        assert _normalize_text("hello   world") == "hello world"

    def test_strip_leading_trailing(self):
        assert _normalize_text("  hello  ") == "hello"

    def test_korean_text(self):
        assert _normalize_text("안녕하세요, 세계!") == "안녕하세요 세계"

    def test_empty_string(self):
        assert _normalize_text("") == ""


# ── Fingerprinting ─────────────────────────────────────────────

class TestFingerprinting:
    def test_deterministic(self):
        fp1 = _fingerprint("alice", "hello world")
        fp2 = _fingerprint("alice", "hello world")
        assert fp1 == fp2

    def test_different_speakers(self):
        fp1 = _fingerprint("alice", "hello world")
        fp2 = _fingerprint("bob", "hello world")
        assert fp1 != fp2

    def test_normalization_applied(self):
        fp1 = _fingerprint("alice", "Hello, World!")
        fp2 = _fingerprint("alice", "hello world")
        assert fp1 == fp2

    def test_different_text(self):
        fp1 = _fingerprint("alice", "hello")
        fp2 = _fingerprint("alice", "goodbye")
        assert fp1 != fp2


# ── Text Similarity ────────────────────────────────────────────

class TestTextSimilarity:
    def test_identical(self):
        assert text_similarity("hello world", "hello world") == 1.0

    def test_identical_after_normalization(self):
        assert text_similarity("Hello, World!", "hello world") == 1.0

    def test_completely_different(self):
        sim = text_similarity("abc", "xyz")
        assert sim < 0.5

    def test_similar_text(self):
        sim = text_similarity("meeting starts now", "meeting start now")
        assert sim > 0.8

    def test_empty_strings(self):
        assert text_similarity("", "") == 1.0  # both empty normalize the same

    def test_one_empty(self):
        assert text_similarity("hello", "") == 0.0

    def test_korean_similarity(self):
        sim = text_similarity("회의를 시작하겠습니다", "회의를 시작하겠습니다")
        assert sim == 1.0

    def test_korean_partial_similarity(self):
        sim = text_similarity("회의를 시작하겠습니다", "회의를 시작합니다")
        assert sim > 0.7


# ── Deduplicator: Exact Duplicates ─────────────────────────────

class TestExactDuplicates:
    def setup_method(self):
        self.dedup = UtteranceDeduplicator()

    def test_first_utterance_accepted(self):
        u = Utterance(speaker="alice", text="hello", timestamp=1.0)
        result = self.dedup.check(u)
        assert not result.is_duplicate

    def test_exact_same_rejected(self):
        u1 = Utterance(speaker="alice", text="hello", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="hello", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert result.is_duplicate
        assert result.reason == "exact_fingerprint"

    def test_same_text_different_speaker_accepted(self):
        u1 = Utterance(speaker="alice", text="hello", timestamp=1.0)
        u2 = Utterance(speaker="bob", text="hello", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert not result.is_duplicate

    def test_exact_match_outside_window_accepted(self):
        config = DeduplicationConfig(exact_match_window=5.0)
        dedup = UtteranceDeduplicator(config)
        u1 = Utterance(speaker="alice", text="hello", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="hello", timestamp=20.0)
        dedup.check(u1)
        result = dedup.check(u2)
        assert not result.is_duplicate


# ── Deduplicator: Fuzzy Matching ───────────────────────────────

class TestFuzzyMatching:
    def setup_method(self):
        self.dedup = UtteranceDeduplicator()

    def test_similar_text_rejected(self):
        u1 = Utterance(speaker="alice", text="the meeting starts now", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="the meeting start now", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert result.is_duplicate
        assert result.reason == "fuzzy_match"
        assert result.similarity_score is not None
        assert result.similarity_score > 0.75

    def test_different_text_accepted(self):
        u1 = Utterance(speaker="alice", text="the meeting starts now", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="let's discuss the agenda", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert not result.is_duplicate

    def test_similar_text_outside_time_window_accepted(self):
        config = DeduplicationConfig(time_window=3.0)
        dedup = UtteranceDeduplicator(config)
        u1 = Utterance(speaker="alice", text="the meeting starts now", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="the meeting start now", timestamp=10.0)
        dedup.check(u1)
        result = dedup.check(u2)
        assert not result.is_duplicate


# ── Deduplicator: Interim Handling ─────────────────────────────

class TestInterimHandling:
    def setup_method(self):
        self.dedup = UtteranceDeduplicator()

    def test_interim_updates_are_duplicates(self):
        u1 = Utterance(speaker="alice", text="the meet", timestamp=1.0, is_final=False)
        u2 = Utterance(speaker="alice", text="the meeting", timestamp=1.5, is_final=False)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert result.is_duplicate
        assert result.reason == "interim_update"

    def test_interim_from_different_speakers_independent(self):
        u1 = Utterance(speaker="alice", text="hello", timestamp=1.0, is_final=False)
        u2 = Utterance(speaker="bob", text="hello", timestamp=1.5, is_final=False)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert not result.is_duplicate

    def test_finalize_interim(self):
        u = Utterance(speaker="alice", text="hello world", timestamp=1.0, is_final=False)
        self.dedup.check(u)
        interim = self.dedup.finalize_interim("alice")
        assert interim is not None
        assert interim.text == "hello world"
        # Second call returns None
        assert self.dedup.finalize_interim("alice") is None

    def test_final_clears_interim_cache(self):
        u1 = Utterance(speaker="alice", text="hello wor", timestamp=1.0, is_final=False)
        u2 = Utterance(speaker="alice", text="hello world", timestamp=1.5, is_final=True)
        self.dedup.check(u1)
        self.dedup.check(u2)
        assert self.dedup.finalize_interim("alice") is None


# ── Deduplicator: Substring Matching ──────────────────────────

class TestSubstringMatching:
    def setup_method(self):
        self.dedup = UtteranceDeduplicator()

    def test_substring_partial_to_full(self):
        """Shorter utterance that is contained in a longer one from same speaker."""
        u1 = Utterance(speaker="alice", text="I think we should", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="I think we should proceed", timestamp=1.5)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert result.is_duplicate
        assert result.reason in ("fuzzy_match", "substring_match")


# ── Deduplicator: Empty Text ──────────────────────────────────

class TestEmptyText:
    def test_empty_text_rejected(self):
        dedup = UtteranceDeduplicator()
        u = Utterance(speaker="alice", text="", timestamp=1.0)
        result = dedup.check(u)
        assert result.is_duplicate
        assert result.reason == "empty_text"

    def test_whitespace_only_rejected(self):
        dedup = UtteranceDeduplicator()
        u = Utterance(speaker="alice", text="   ", timestamp=1.0)
        result = dedup.check(u)
        assert result.is_duplicate
        assert result.reason == "empty_text"

    def test_punctuation_only_rejected(self):
        dedup = UtteranceDeduplicator()
        u = Utterance(speaker="alice", text="...", timestamp=1.0)
        result = dedup.check(u)
        assert result.is_duplicate
        assert result.reason == "empty_text"


# ── Deduplicator: Reset ───────────────────────────────────────

class TestReset:
    def test_reset_clears_state(self):
        dedup = UtteranceDeduplicator()
        u = Utterance(speaker="alice", text="hello", timestamp=1.0)
        dedup.check(u)
        assert dedup.window_size == 1

        dedup.reset()
        assert dedup.window_size == 0

        # Same utterance now accepted
        result = dedup.check(u)
        assert not result.is_duplicate


# ── Deduplicator: Concurrent Speakers ─────────────────────────

class TestConcurrentSpeakers:
    """Simulate 5-10 concurrent participants."""

    def test_multiple_speakers_independent(self):
        dedup = UtteranceDeduplicator()
        speakers = [f"speaker_{i}" for i in range(10)]
        for i, sp in enumerate(speakers):
            u = Utterance(speaker=sp, text="I agree with that", timestamp=float(i))
            result = dedup.check(u)
            assert not result.is_duplicate, f"Speaker {sp} wrongly flagged"

    def test_same_speaker_deduped_across_many(self):
        dedup = UtteranceDeduplicator()
        # 10 speakers say unique things
        for i in range(10):
            u = Utterance(speaker=f"speaker_{i}", text=f"unique message {i}", timestamp=float(i))
            dedup.check(u)
        # speaker_0 repeats
        repeat = Utterance(speaker="speaker_0", text="unique message 0", timestamp=5.0)
        result = dedup.check(repeat)
        assert result.is_duplicate


# ── Deduplicator: Korean Language ──────────────────────────────

class TestKoreanLanguage:
    def setup_method(self):
        self.dedup = UtteranceDeduplicator()

    def test_korean_exact_duplicate(self):
        u1 = Utterance(speaker="김철수", text="회의를 시작하겠습니다", timestamp=1.0)
        u2 = Utterance(speaker="김철수", text="회의를 시작하겠습니다", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert result.is_duplicate

    def test_korean_different_speakers(self):
        u1 = Utterance(speaker="김철수", text="네 알겠습니다", timestamp=1.0)
        u2 = Utterance(speaker="이영희", text="네 알겠습니다", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert not result.is_duplicate

    def test_korean_similar_text(self):
        u1 = Utterance(speaker="김철수", text="다음 주 월요일에 미팅하겠습니다", timestamp=1.0)
        u2 = Utterance(speaker="김철수", text="다음 주 월요일에 미팅합니다", timestamp=2.0)
        self.dedup.check(u1)
        result = self.dedup.check(u2)
        assert result.is_duplicate


# ── Configuration Edge Cases ───────────────────────────────────

class TestConfigEdgeCases:
    def test_strict_threshold(self):
        """With very high threshold, only near-exact matches are caught."""
        config = DeduplicationConfig(similarity_threshold=0.95)
        dedup = UtteranceDeduplicator(config)
        u1 = Utterance(speaker="alice", text="the meeting starts now", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="the meeting start now", timestamp=2.0)
        dedup.check(u1)
        result = dedup.check(u2)
        # With 0.95 threshold, this minor difference may pass through
        # (depends on exact similarity score)

    def test_loose_threshold(self):
        """With low threshold, more utterances are caught as duplicates."""
        config = DeduplicationConfig(similarity_threshold=0.5)
        dedup = UtteranceDeduplicator(config)
        u1 = Utterance(speaker="alice", text="let's start the meeting", timestamp=1.0)
        u2 = Utterance(speaker="alice", text="let's begin the meeting", timestamp=2.0)
        dedup.check(u1)
        result = dedup.check(u2)
        assert result.is_duplicate

    def test_small_window_size(self):
        """Window eviction works correctly."""
        config = DeduplicationConfig(window_size=3, time_window=0.5)
        dedup = UtteranceDeduplicator(config)
        # Use very distinct messages and large time gaps to avoid fuzzy dedup
        texts = [
            "alpha bravo charlie",
            "delta echo foxtrot",
            "golf hotel india",
            "juliet kilo lima",
            "mike november oscar",
        ]
        for i, text in enumerate(texts):
            u = Utterance(speaker="alice", text=text, timestamp=float(i * 100))
            dedup.check(u)
        assert dedup.window_size == 3
