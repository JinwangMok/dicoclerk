"""Tests for transcript accumulation with speaker attribution."""

import threading
import time

import pytest

from src.stt.transcript import (
    DiscordUser,
    Language,
    SessionTranscript,
    SpeakerMap,
    SpeakerMapping,
    TranscriptEntry,
    parse_deepgram_response,
    _detect_language,
    _group_words_by_speaker,
)


# ── Helpers ──────────────────────────────────────────────────────


def _make_deepgram_response(
    words: list[dict],
    is_final: bool = True,
    start: float = 0.0,
    duration: float = 1.0,
) -> dict:
    """Build a minimal Deepgram-style response dict."""
    transcript = " ".join(w.get("punctuated_word", w.get("word", "")) for w in words)
    return {
        "type": "Results",
        "channel_index": [0, 1],
        "duration": duration,
        "start": start,
        "is_final": is_final,
        "channel": {
            "alternatives": [{
                "transcript": transcript,
                "confidence": 0.95,
                "words": words,
            }]
        },
    }


def _make_word(word: str, speaker: int = 0, start: float = 0.0, end: float = 0.1, confidence: float = 0.95) -> dict:
    """Build a minimal Deepgram word dict."""
    return {
        "word": word.lower().rstrip(".,!?"),
        "punctuated_word": word,
        "speaker": speaker,
        "start": start,
        "end": end,
        "confidence": confidence,
    }


# ── DiscordUser ──────────────────────────────────────────────────


class TestDiscordUser:
    def test_equality_by_user_id(self):
        u1 = DiscordUser(user_id="123", display_name="Alice")
        u2 = DiscordUser(user_id="123", display_name="Alice (nickname)")
        assert u1 == u2

    def test_inequality_different_id(self):
        u1 = DiscordUser(user_id="123", display_name="Alice")
        u2 = DiscordUser(user_id="456", display_name="Alice")
        assert u1 != u2

    def test_hashable(self):
        u1 = DiscordUser(user_id="123", display_name="Alice")
        u2 = DiscordUser(user_id="123", display_name="Alice v2")
        s = {u1, u2}
        assert len(s) == 1

    def test_not_equal_to_non_user(self):
        u = DiscordUser(user_id="123", display_name="Alice")
        assert u != "not a user"


# ── Language Detection ───────────────────────────────────────────


class TestLanguageDetection:
    def test_korean_text(self):
        assert _detect_language("안녕하세요 반갑습니다") == Language.KOREAN

    def test_english_text(self):
        assert _detect_language("hello world") == Language.ENGLISH

    def test_mixed_mostly_korean(self):
        assert _detect_language("안녕하세요 hello 반갑습니다 여러분") == Language.KOREAN

    def test_empty_text(self):
        assert _detect_language("") == Language.UNKNOWN

    def test_numbers_only(self):
        assert _detect_language("12345") == Language.UNKNOWN


# ── Word Grouping ────────────────────────────────────────────────


class TestWordGrouping:
    def test_single_speaker(self):
        words = [
            _make_word("Hello", speaker=0, start=0.0),
            _make_word("world", speaker=0, start=0.2),
        ]
        groups = _group_words_by_speaker(words)
        assert len(groups) == 1
        assert groups[0][0] == 0
        assert len(groups[0][1]) == 2

    def test_two_speakers_alternating(self):
        words = [
            _make_word("Hello", speaker=0, start=0.0),
            _make_word("Hi", speaker=1, start=0.3),
            _make_word("there", speaker=1, start=0.5),
        ]
        groups = _group_words_by_speaker(words)
        assert len(groups) == 2
        assert groups[0][0] == 0
        assert groups[1][0] == 1
        assert len(groups[1][1]) == 2

    def test_speaker_switch_back(self):
        words = [
            _make_word("A", speaker=0),
            _make_word("B", speaker=1),
            _make_word("C", speaker=0),
        ]
        groups = _group_words_by_speaker(words)
        assert len(groups) == 3

    def test_empty_words(self):
        assert _group_words_by_speaker([]) == []


# ── parse_deepgram_response ──────────────────────────────────────


class TestParseDeepgramResponse:
    def test_basic_single_speaker(self):
        words = [
            _make_word("Hello", speaker=0, start=0.1, end=0.3),
            _make_word("world", speaker=0, start=0.4, end=0.6),
        ]
        resp = _make_deepgram_response(words, is_final=True)
        utterances = parse_deepgram_response(resp, session_start_time=0.0)

        assert len(utterances) == 1
        assert utterances[0].speaker == "speaker_0"
        assert utterances[0].text == "Hello world"
        assert utterances[0].is_final is True
        assert utterances[0].timestamp == 0.1

    def test_two_speakers_in_one_response(self):
        words = [
            _make_word("I agree.", speaker=0, start=0.0, end=0.3),
            _make_word("Me too.", speaker=1, start=0.5, end=0.7),
        ]
        resp = _make_deepgram_response(words)
        utterances = parse_deepgram_response(resp, session_start_time=0.0)

        assert len(utterances) == 2
        assert utterances[0].speaker == "speaker_0"
        assert utterances[0].text == "I agree."
        assert utterances[1].speaker == "speaker_1"
        assert utterances[1].text == "Me too."

    def test_non_results_type_ignored(self):
        resp = {"type": "Metadata", "data": {}}
        utterances = parse_deepgram_response(resp, session_start_time=0.0)
        assert utterances == []

    def test_empty_alternatives(self):
        resp = {
            "type": "Results",
            "channel": {"alternatives": []},
            "is_final": True,
        }
        utterances = parse_deepgram_response(resp, session_start_time=0.0)
        assert utterances == []

    def test_no_words_fallback_to_transcript(self):
        resp = {
            "type": "Results",
            "start": 1.5,
            "is_final": True,
            "channel": {
                "alternatives": [{
                    "transcript": "fallback text",
                    "confidence": 0.8,
                    "words": [],
                }]
            },
        }
        utterances = parse_deepgram_response(resp, session_start_time=0.0)
        assert len(utterances) == 1
        assert utterances[0].text == "fallback text"
        assert utterances[0].speaker == "speaker_0"

    def test_interim_result(self):
        words = [_make_word("hello", speaker=0)]
        resp = _make_deepgram_response(words, is_final=False)
        utterances = parse_deepgram_response(resp, session_start_time=0.0)
        assert len(utterances) == 1
        assert utterances[0].is_final is False

    def test_korean_words(self):
        words = [
            _make_word("안녕하세요", speaker=0, start=0.0),
            _make_word("반갑습니다", speaker=0, start=0.5),
        ]
        resp = _make_deepgram_response(words)
        utterances = parse_deepgram_response(resp, session_start_time=0.0)
        assert len(utterances) == 1
        assert utterances[0].text == "안녕하세요 반갑습니다"


# ── SpeakerMap ───────────────────────────────────────────────────


class TestSpeakerMap:
    def setup_method(self):
        self.sm = SpeakerMap()

    def test_map_and_resolve(self):
        user = DiscordUser(user_id="111", display_name="Alice")
        self.sm.map_speaker(0, user)
        resolved = self.sm.resolve(0)
        assert resolved == user
        assert resolved.display_name == "Alice"

    def test_unresolved_returns_placeholder(self):
        resolved = self.sm.resolve(5)
        assert resolved.user_id == "unknown_5"
        assert resolved.display_name == "Speaker 6"

    def test_ssrc_based_resolution(self):
        user = DiscordUser(user_id="222", display_name="Bob")
        self.sm.register_ssrc(ssrc=99999, user_id="222", display_name="Bob")
        self.sm.map_speaker(0, user, source="ssrc", ssrc=99999)
        resolved = self.sm.resolve_by_ssrc(99999, deepgram_index=0)
        assert resolved == user

    def test_ssrc_fallback_to_index(self):
        user = DiscordUser(user_id="333", display_name="Charlie")
        self.sm.map_speaker(1, user)
        # Unknown SSRC falls back to index
        resolved = self.sm.resolve_by_ssrc(ssrc=77777, deepgram_index=1)
        assert resolved == user

    def test_ssrc_unknown_both(self):
        resolved = self.sm.resolve_by_ssrc(ssrc=88888, deepgram_index=99)
        assert resolved.user_id == "unknown_99"

    def test_register_ssrc_updates_existing_mapping(self):
        user_old = DiscordUser(user_id="unknown_0", display_name="Speaker 1")
        self.sm.map_speaker(0, user_old, ssrc=12345)
        self.sm.register_ssrc(ssrc=12345, user_id="444", display_name="Diana")
        resolved = self.sm.resolve(0)
        assert resolved.user_id == "444"
        assert resolved.display_name == "Diana"

    def test_multiple_speakers(self):
        users = [
            DiscordUser(user_id=str(i), display_name=f"User{i}")
            for i in range(10)
        ]
        for i, user in enumerate(users):
            self.sm.map_speaker(i, user)
        for i, user in enumerate(users):
            assert self.sm.resolve(i) == user

    def test_mapped_count(self):
        self.sm.map_speaker(0, DiscordUser("111", "Alice"))
        self.sm.map_speaker(1, DiscordUser("unknown_1", "Speaker 2"))
        assert self.sm.mapped_count == 1
        assert self.sm.total_count == 2

    def test_get_all_mappings(self):
        self.sm.map_speaker(0, DiscordUser("111", "Alice"))
        self.sm.map_speaker(1, DiscordUser("222", "Bob"))
        mappings = self.sm.get_all_mappings()
        assert len(mappings) == 2

    def test_clear(self):
        self.sm.map_speaker(0, DiscordUser("111", "Alice"))
        self.sm.clear()
        assert self.sm.total_count == 0
        resolved = self.sm.resolve(0)
        assert resolved.user_id == "unknown_0"

    def test_thread_safety(self):
        """Concurrent map_speaker and resolve calls should not crash."""
        errors = []

        def mapper():
            try:
                for i in range(50):
                    self.sm.map_speaker(
                        i % 10,
                        DiscordUser(str(i % 10), f"User{i % 10}"),
                    )
            except Exception as e:
                errors.append(e)

        def resolver():
            try:
                for i in range(50):
                    self.sm.resolve(i % 10)
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=mapper) for _ in range(4)]
        threads += [threading.Thread(target=resolver) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert errors == []


# ── SessionTranscript ────────────────────────────────────────────


class TestSessionTranscript:
    def setup_method(self):
        self.transcript = SessionTranscript(
            session_id="test-session",
            session_start_time=0.0,
        )
        # Register some speakers
        alice = DiscordUser(user_id="111", display_name="Alice")
        bob = DiscordUser(user_id="222", display_name="Bob")
        self.transcript.speaker_map.map_speaker(0, alice)
        self.transcript.speaker_map.map_speaker(1, bob)

    def _make_response(self, words, is_final=True):
        return _make_deepgram_response(words, is_final=is_final)

    def test_basic_accumulation(self):
        words = [
            _make_word("Hello", speaker=0, start=0.1, end=0.3),
            _make_word("everyone", speaker=0, start=0.4, end=0.6),
        ]
        resp = self._make_response(words)
        new_entries = self.transcript.process_deepgram_response(resp)

        assert len(new_entries) == 1
        assert new_entries[0].speaker.display_name == "Alice"
        assert new_entries[0].text == "Hello everyone"
        assert self.transcript.entry_count == 1

    def test_two_speakers_in_response(self):
        words = [
            _make_word("I agree.", speaker=0, start=0.0, end=0.3),
            _make_word("Me too.", speaker=1, start=0.5, end=0.7),
        ]
        resp = self._make_response(words)
        new_entries = self.transcript.process_deepgram_response(resp)

        assert len(new_entries) == 2
        assert new_entries[0].speaker.display_name == "Alice"
        assert new_entries[1].speaker.display_name == "Bob"

    def test_multiple_responses_accumulate(self):
        # First response
        words1 = [_make_word("First message", speaker=0, start=0.0)]
        self.transcript.process_deepgram_response(self._make_response(words1))

        # Second response
        words2 = [_make_word("Second message", speaker=1, start=2.0)]
        self.transcript.process_deepgram_response(self._make_response(words2))

        assert self.transcript.entry_count == 2
        entries = self.transcript.entries
        assert entries[0].speaker.display_name == "Alice"
        assert entries[1].speaker.display_name == "Bob"

    def test_duplicate_filtered(self):
        words = [_make_word("Hello world", speaker=0, start=0.0)]
        resp = self._make_response(words)

        self.transcript.process_deepgram_response(resp)
        self.transcript.process_deepgram_response(resp)

        assert self.transcript.entry_count == 1
        assert self.transcript.duplicate_count == 1
        assert self.transcript.total_processed == 2

    def test_unknown_speaker_gets_placeholder(self):
        words = [_make_word("Mystery voice", speaker=99, start=0.0)]
        resp = self._make_response(words)
        new_entries = self.transcript.process_deepgram_response(resp)

        assert len(new_entries) == 1
        assert new_entries[0].speaker.display_name == "Speaker 100"
        assert new_entries[0].speaker.user_id == "unknown_99"

    def test_ssrc_resolution(self):
        self.transcript.speaker_map.register_ssrc(
            ssrc=55555, user_id="111", display_name="Alice"
        )
        words = [_make_word("Via SSRC", speaker=0, start=0.0)]
        resp = self._make_response(words)
        new_entries = self.transcript.process_deepgram_response(resp, ssrc=55555)

        assert len(new_entries) == 1
        assert new_entries[0].speaker.user_id == "111"

    def test_entries_are_copy(self):
        """entries property returns a copy, not a reference."""
        words = [_make_word("Test", speaker=0, start=0.0)]
        self.transcript.process_deepgram_response(self._make_response(words))
        entries1 = self.transcript.entries
        entries2 = self.transcript.entries
        assert entries1 is not entries2
        assert entries1 == entries2

    def test_get_entries_by_speaker(self):
        words1 = [_make_word("Alice says hi", speaker=0, start=0.0)]
        words2 = [_make_word("Bob says hi", speaker=1, start=1.0)]
        words3 = [_make_word("Alice again", speaker=0, start=2.0)]
        self.transcript.process_deepgram_response(self._make_response(words1))
        self.transcript.process_deepgram_response(self._make_response(words2))
        self.transcript.process_deepgram_response(self._make_response(words3))

        alice_entries = self.transcript.get_entries_by_speaker("111")
        assert len(alice_entries) == 2
        bob_entries = self.transcript.get_entries_by_speaker("222")
        assert len(bob_entries) == 1

    def test_speaker_stats(self):
        words1 = [
            _make_word("Hello", speaker=0, start=0.0, end=0.3),
            _make_word("world", speaker=0, start=0.3, end=0.5),
        ]
        words2 = [_make_word("Hi", speaker=1, start=1.0, end=1.2)]
        self.transcript.process_deepgram_response(self._make_response(words1))
        self.transcript.process_deepgram_response(self._make_response(words2))

        stats = self.transcript.get_speaker_stats()
        assert "111" in stats
        assert stats["111"]["display_name"] == "Alice"
        assert stats["111"]["entry_count"] == 1
        assert "222" in stats
        assert stats["222"]["entry_count"] == 1

    def test_to_plain_text(self):
        words1 = [_make_word("Hello", speaker=0, start=65.0)]  # 01:05
        words2 = [_make_word("Hi", speaker=1, start=130.0)]    # 02:10
        self.transcript.process_deepgram_response(self._make_response(words1))
        self.transcript.process_deepgram_response(self._make_response(words2))

        text = self.transcript.to_plain_text()
        assert "[01:05] Alice: Hello" in text
        assert "[02:10] Bob: Hi" in text

    def test_to_structured_data(self):
        words = [_make_word("Test", speaker=0, start=1.5)]
        self.transcript.process_deepgram_response(self._make_response(words))

        data = self.transcript.to_structured_data()
        assert len(data) == 1
        assert data[0]["speaker_id"] == "111"
        assert data[0]["speaker_name"] == "Alice"
        assert data[0]["text"] == "Test"
        assert data[0]["timestamp"] == 1.5
        assert data[0]["is_final"] is True
        assert "language" in data[0]
        assert "confidence" in data[0]

    def test_reset(self):
        words = [_make_word("Hello", speaker=0, start=0.0)]
        self.transcript.process_deepgram_response(self._make_response(words))
        assert self.transcript.entry_count == 1

        self.transcript.reset()
        assert self.transcript.entry_count == 0
        assert self.transcript.total_processed == 0
        assert self.transcript.duplicate_count == 0
        assert self.transcript.speaker_map.total_count == 0


# ── SessionTranscript: Concurrent Participants ───────────────────


class TestConcurrentParticipants:
    """Simulate 5-10 concurrent speakers."""

    def test_ten_speakers_accumulation(self):
        transcript = SessionTranscript(session_id="multi", session_start_time=0.0)
        users = []
        for i in range(10):
            user = DiscordUser(user_id=str(100 + i), display_name=f"User{i}")
            transcript.speaker_map.map_speaker(i, user)
            users.append(user)

        # Each speaker says something unique at different times
        for i in range(10):
            words = [_make_word(f"Message from user {i}", speaker=i, start=float(i))]
            resp = _make_deepgram_response(words)
            transcript.process_deepgram_response(resp)

        assert transcript.entry_count == 10
        stats = transcript.get_speaker_stats()
        assert len(stats) == 10

    def test_interleaved_speakers(self):
        transcript = SessionTranscript(session_id="interleave", session_start_time=0.0)
        for i in range(5):
            transcript.speaker_map.map_speaker(
                i, DiscordUser(str(i), f"Speaker{i}")
            )

        # Simulate interleaved speech in a single response
        words = []
        for turn in range(3):
            for speaker in range(5):
                t = turn * 5.0 + speaker * 1.0
                words.append(_make_word(
                    f"Turn{turn}",
                    speaker=speaker,
                    start=t,
                    end=t + 0.5,
                ))

        resp = _make_deepgram_response(words)
        new_entries = transcript.process_deepgram_response(resp)

        # Each speaker switch creates a new group
        assert len(new_entries) > 5
        # Verify all 5 speakers appear
        speaker_ids = {e.speaker.user_id for e in new_entries}
        assert len(speaker_ids) == 5


# ── SessionTranscript: Korean Language ───────────────────────────


class TestKoreanTranscript:
    def test_korean_accumulation(self):
        transcript = SessionTranscript(session_id="kr", session_start_time=0.0)
        transcript.speaker_map.map_speaker(
            0, DiscordUser("k1", "김철수")
        )
        transcript.speaker_map.map_speaker(
            1, DiscordUser("k2", "이영희")
        )

        words1 = [
            _make_word("회의를", speaker=0, start=0.0),
            _make_word("시작하겠습니다", speaker=0, start=0.3),
        ]
        words2 = [
            _make_word("네", speaker=1, start=1.0),
            _make_word("알겠습니다", speaker=1, start=1.2),
        ]
        transcript.process_deepgram_response(_make_deepgram_response(words1))
        transcript.process_deepgram_response(_make_deepgram_response(words2))

        assert transcript.entry_count == 2
        text = transcript.to_plain_text()
        assert "김철수" in text
        assert "이영희" in text
        assert "회의를 시작하겠습니다" in text

    def test_korean_language_detection_in_entry(self):
        transcript = SessionTranscript(session_id="kr-lang", session_start_time=0.0)
        transcript.speaker_map.map_speaker(0, DiscordUser("k1", "김철수"))

        words = [_make_word("안녕하세요", speaker=0, start=0.0)]
        resp = _make_deepgram_response(words)
        entries = transcript.process_deepgram_response(resp)

        assert len(entries) == 1
        assert entries[0].language == Language.KOREAN


# ── SessionTranscript: Thread Safety ─────────────────────────────


class TestTranscriptThreadSafety:
    def test_concurrent_process_and_read(self):
        """Concurrent writes and reads should not crash."""
        transcript = SessionTranscript(session_id="threadsafe", session_start_time=0.0)
        for i in range(5):
            transcript.speaker_map.map_speaker(
                i, DiscordUser(str(i), f"User{i}")
            )

        errors = []

        def writer(speaker_id: int):
            try:
                for j in range(20):
                    words = [_make_word(
                        f"msg {speaker_id} {j}",
                        speaker=speaker_id,
                        start=float(j + speaker_id * 100),
                    )]
                    resp = _make_deepgram_response(words)
                    transcript.process_deepgram_response(resp)
            except Exception as e:
                errors.append(e)

        def reader():
            try:
                for _ in range(20):
                    _ = transcript.entries
                    _ = transcript.to_plain_text()
                    _ = transcript.get_speaker_stats()
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=writer, args=(i,)) for i in range(5)]
        threads += [threading.Thread(target=reader) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"Thread safety errors: {errors}"
        assert transcript.entry_count > 0
