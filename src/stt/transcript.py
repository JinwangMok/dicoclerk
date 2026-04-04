"""
Transcript accumulation with speaker attribution.

Processes Deepgram diarization responses, maps speaker indices to Discord
users, and maintains an ordered, speaker-attributed transcript data structure
in memory.

Key responsibilities:
- Parse Deepgram real-time streaming responses (with diarization metadata)
- Maintain a bidirectional mapping between Deepgram speaker indices and
  Discord user identities (user ID + display name)
- Accumulate transcript entries in chronological order
- Integrate with UtteranceDeduplicator to filter duplicates before storing
- Support concurrent speakers (5-10 participants)
- Provide export-ready transcript data for minutes generation
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Optional

from .dedup import (
    DeduplicationConfig,
    Utterance,
    UtteranceDeduplicator,
)


class Language(str, Enum):
    """Supported languages for STT."""
    KOREAN = "ko"
    ENGLISH = "en"
    UNKNOWN = "unknown"


@dataclass
class DiscordUser:
    """A Discord user identity."""
    user_id: str          # Discord snowflake ID
    display_name: str     # Nickname or username shown in the guild
    discriminator: str = ""  # Legacy discriminator (optional)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, DiscordUser):
            return NotImplemented
        return self.user_id == other.user_id

    def __hash__(self) -> int:
        return hash(self.user_id)


@dataclass
class TranscriptEntry:
    """A single entry in the transcript with full attribution."""
    speaker: DiscordUser           # Resolved Discord user
    text: str                      # Transcribed text
    timestamp: float               # Seconds from session start
    duration: float = 0.0          # Duration of the utterance in seconds
    language: Language = Language.UNKNOWN
    confidence: float = 0.0        # Deepgram confidence score (0.0-1.0)
    is_final: bool = True          # Whether this is a final result
    deepgram_speaker_index: int = -1  # Original Deepgram speaker index
    raw_words: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class SpeakerMapping:
    """
    Maps a Deepgram speaker index to a Discord user.

    The mapping can be established through:
    - SSRC-based: Discord audio SSRC -> user (most reliable)
    - Manual: Explicit assignment by a user or admin
    - Heuristic: Voice activity timing correlation (fallback)
    """
    deepgram_index: int
    discord_user: DiscordUser
    confidence: float = 1.0       # How confident we are in this mapping
    source: str = "ssrc"          # "ssrc", "manual", "heuristic"
    ssrc: Optional[int] = None    # Discord audio SSRC if known

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, SpeakerMapping):
            return NotImplemented
        return (self.deepgram_index == other.deepgram_index
                and self.discord_user == other.discord_user)

    def __hash__(self) -> int:
        return hash((self.deepgram_index, self.discord_user.user_id))


class SpeakerMap:
    """
    Bidirectional mapping between Deepgram speaker indices and Discord users.

    Thread-safe: all mutations are guarded by a lock since audio callbacks
    and Discord events may arrive on different threads.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Deepgram speaker index -> SpeakerMapping
        self._by_index: dict[int, SpeakerMapping] = {}
        # Discord user ID -> SpeakerMapping
        self._by_user_id: dict[str, SpeakerMapping] = {}
        # SSRC -> Discord user ID (populated from Discord voice state)
        self._ssrc_to_user_id: dict[int, str] = {}
        # Unknown speaker counter for unresolved indices
        self._unknown_counter: int = 0

    def register_ssrc(self, ssrc: int, user_id: str, display_name: str) -> None:
        """
        Register a Discord SSRC -> user mapping.

        Called when Discord reports which SSRC belongs to which user
        (from voice connection speaking events).
        """
        with self._lock:
            self._ssrc_to_user_id[ssrc] = user_id
            # If we already have a mapping that uses this SSRC, update it
            for mapping in self._by_index.values():
                if mapping.ssrc == ssrc:
                    mapping.discord_user = DiscordUser(
                        user_id=user_id,
                        display_name=display_name,
                    )
                    self._by_user_id[user_id] = mapping
                    break

    def map_speaker(
        self,
        deepgram_index: int,
        discord_user: DiscordUser,
        source: str = "ssrc",
        ssrc: Optional[int] = None,
        confidence: float = 1.0,
    ) -> SpeakerMapping:
        """
        Establish or update a mapping between a Deepgram speaker index
        and a Discord user.
        """
        with self._lock:
            mapping = SpeakerMapping(
                deepgram_index=deepgram_index,
                discord_user=discord_user,
                confidence=confidence,
                source=source,
                ssrc=ssrc,
            )
            self._by_index[deepgram_index] = mapping
            self._by_user_id[discord_user.user_id] = mapping
            return mapping

    def resolve(self, deepgram_index: int) -> DiscordUser:
        """
        Resolve a Deepgram speaker index to a Discord user.

        Returns the mapped user if known, otherwise returns a placeholder
        DiscordUser with a generated name like "Speaker 1".
        """
        with self._lock:
            mapping = self._by_index.get(deepgram_index)
            if mapping is not None:
                return mapping.discord_user
            # Create a placeholder for unknown speakers
            return self._create_placeholder(deepgram_index)

    def resolve_by_ssrc(self, ssrc: int, deepgram_index: int) -> DiscordUser:
        """
        Resolve using SSRC first (most reliable), falling back to index.
        """
        with self._lock:
            user_id = self._ssrc_to_user_id.get(ssrc)
            if user_id is not None:
                # Check if we already have a mapping for this user
                existing = self._by_user_id.get(user_id)
                if existing is not None:
                    return existing.discord_user
                # We know the user_id but don't have a full mapping yet
                # This shouldn't normally happen if register_ssrc was called
                # with display_name, but handle gracefully
                return DiscordUser(
                    user_id=user_id,
                    display_name=f"User {user_id[:8]}",
                )
            # Fall back to index-based resolution
            mapping = self._by_index.get(deepgram_index)
            if mapping is not None:
                return mapping.discord_user
            return self._create_placeholder(deepgram_index)

    def _create_placeholder(self, deepgram_index: int) -> DiscordUser:
        """Create a placeholder user for an unresolved speaker index."""
        return DiscordUser(
            user_id=f"unknown_{deepgram_index}",
            display_name=f"Speaker {deepgram_index + 1}",
        )

    def get_all_mappings(self) -> list[SpeakerMapping]:
        """Return all current speaker mappings."""
        with self._lock:
            return list(self._by_index.values())

    def get_mapping_by_index(self, deepgram_index: int) -> Optional[SpeakerMapping]:
        """Get mapping for a specific Deepgram speaker index."""
        with self._lock:
            return self._by_index.get(deepgram_index)

    def clear(self) -> None:
        """Clear all mappings. Call when starting a new session."""
        with self._lock:
            self._by_index.clear()
            self._by_user_id.clear()
            self._ssrc_to_user_id.clear()
            self._unknown_counter = 0

    @property
    def mapped_count(self) -> int:
        """Number of Deepgram speaker indices with known Discord users."""
        with self._lock:
            return sum(
                1 for m in self._by_index.values()
                if not m.discord_user.user_id.startswith("unknown_")
            )

    @property
    def total_count(self) -> int:
        """Total number of speaker index entries (including placeholders)."""
        with self._lock:
            return len(self._by_index)


def parse_deepgram_response(
    response: dict[str, Any],
    session_start_time: float,
) -> list[Utterance]:
    """
    Parse a Deepgram real-time streaming response into Utterance objects.

    Deepgram response structure (simplified):
    {
        "type": "Results",
        "channel_index": [0, 1],
        "duration": 1.5,
        "start": 0.0,
        "is_final": true,
        "channel": {
            "alternatives": [{
                "transcript": "hello world",
                "confidence": 0.95,
                "words": [
                    {"word": "hello", "start": 0.1, "end": 0.3,
                     "confidence": 0.95, "speaker": 0, "punctuated_word": "Hello"},
                    {"word": "world", "start": 0.4, "end": 0.6,
                     "confidence": 0.92, "speaker": 0, "punctuated_word": "world"}
                ]
            }]
        }
    }

    With diarization, each word has a `speaker` field (integer index).
    We group consecutive words by speaker to form per-speaker utterances.
    """
    utterances: list[Utterance] = []

    result_type = response.get("type", "")
    if result_type != "Results":
        return utterances

    channel = response.get("channel", {})
    alternatives = channel.get("alternatives", [])
    if not alternatives:
        return utterances

    best = alternatives[0]
    words = best.get("words", [])
    is_final = response.get("is_final", False)

    if not words:
        # No word-level data; fall back to full transcript
        transcript = best.get("transcript", "").strip()
        if transcript:
            start_offset = response.get("start", 0.0)
            utterances.append(Utterance(
                speaker="speaker_0",
                text=transcript,
                timestamp=start_offset,
                is_final=is_final,
            ))
        return utterances

    # Group consecutive words by speaker index
    groups = _group_words_by_speaker(words)

    for speaker_index, group_words in groups:
        text_parts = []
        for w in group_words:
            # Prefer punctuated_word for natural text
            text_parts.append(w.get("punctuated_word", w.get("word", "")))

        text = " ".join(text_parts).strip()
        if not text:
            continue

        start_time = group_words[0].get("start", 0.0)

        utterances.append(Utterance(
            speaker=f"speaker_{speaker_index}",
            text=text,
            timestamp=start_time,
            is_final=is_final,
            channel=speaker_index,
        ))

    return utterances


def _group_words_by_speaker(
    words: list[dict[str, Any]],
) -> list[tuple[int, list[dict[str, Any]]]]:
    """
    Group consecutive words by their speaker index.

    Returns list of (speaker_index, [word_dicts]) tuples.
    """
    if not words:
        return []

    groups: list[tuple[int, list[dict[str, Any]]]] = []
    current_speaker = words[0].get("speaker", 0)
    current_group: list[dict[str, Any]] = [words[0]]

    for word in words[1:]:
        speaker = word.get("speaker", 0)
        if speaker == current_speaker:
            current_group.append(word)
        else:
            groups.append((current_speaker, current_group))
            current_speaker = speaker
            current_group = [word]

    groups.append((current_speaker, current_group))
    return groups


def _extract_word_metadata(
    words: list[dict[str, Any]],
) -> tuple[float, float, Language]:
    """Extract duration, average confidence, and detected language from words."""
    if not words:
        return 0.0, 0.0, Language.UNKNOWN

    start = words[0].get("start", 0.0)
    end = words[-1].get("end", start)
    duration = end - start

    confidences = [w.get("confidence", 0.0) for w in words]
    avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

    # Simple language detection heuristic based on character ranges
    all_text = " ".join(w.get("word", "") for w in words)
    language = _detect_language(all_text)

    return duration, avg_confidence, language


def _detect_language(text: str) -> Language:
    """
    Simple heuristic language detection for Korean vs English.

    Checks for presence of Hangul characters.
    """
    korean_chars = sum(1 for c in text if '\uAC00' <= c <= '\uD7AF' or '\u3130' <= c <= '\u318F')
    total_alpha = sum(1 for c in text if c.isalpha())
    if total_alpha == 0:
        return Language.UNKNOWN
    if korean_chars / total_alpha > 0.3:
        return Language.KOREAN
    return Language.ENGLISH


class SessionTranscript:
    """
    Accumulates an ordered, speaker-attributed transcript for a voice session.

    Thread-safe: audio callbacks and Discord events may arrive concurrently.

    Usage:
        transcript = SessionTranscript(session_id="abc123")

        # Register Discord users as they speak
        transcript.speaker_map.register_ssrc(ssrc=12345, user_id="111", display_name="Alice")
        transcript.speaker_map.map_speaker(0, DiscordUser("111", "Alice"), ssrc=12345)

        # Process incoming Deepgram responses
        transcript.process_deepgram_response(response_dict)

        # Export for minutes generation
        entries = transcript.entries
    """

    def __init__(
        self,
        session_id: str,
        dedup_config: Optional[DeduplicationConfig] = None,
        session_start_time: Optional[float] = None,
    ):
        self.session_id = session_id
        self.speaker_map = SpeakerMap()
        self._dedup = UtteranceDeduplicator(dedup_config)
        self._entries: list[TranscriptEntry] = []
        self._lock = threading.Lock()
        self._session_start_time = session_start_time or time.time()
        self._entry_count = 0  # Total processed (including duplicates)
        self._duplicate_count = 0

    def process_deepgram_response(
        self,
        response: dict[str, Any],
        ssrc: Optional[int] = None,
    ) -> list[TranscriptEntry]:
        """
        Process a Deepgram streaming response and accumulate non-duplicate
        entries into the transcript.

        Args:
            response: Raw Deepgram response dict
            ssrc: Discord audio SSRC if available (for speaker resolution)

        Returns:
            List of newly added TranscriptEntry objects (empty if all duplicates)
        """
        utterances = parse_deepgram_response(response, self._session_start_time)
        new_entries: list[TranscriptEntry] = []

        channel = response.get("channel", {})
        alternatives = channel.get("alternatives", [])
        best_words = alternatives[0].get("words", []) if alternatives else []

        for utterance in utterances:
            self._entry_count += 1

            # Deduplication check
            dedup_result = self._dedup.check(utterance)
            if dedup_result.is_duplicate:
                self._duplicate_count += 1
                continue

            # Resolve speaker identity
            speaker_index = int(utterance.speaker.split("_")[-1])
            if ssrc is not None:
                discord_user = self.speaker_map.resolve_by_ssrc(ssrc, speaker_index)
            else:
                discord_user = self.speaker_map.resolve(speaker_index)

            # Extract word-level metadata for this utterance's words
            utterance_words = _get_words_for_speaker(best_words, speaker_index)
            duration, confidence, language = _extract_word_metadata(utterance_words)

            entry = TranscriptEntry(
                speaker=discord_user,
                text=utterance.text,
                timestamp=utterance.timestamp,
                duration=duration,
                language=language,
                confidence=confidence,
                is_final=utterance.is_final,
                deepgram_speaker_index=speaker_index,
                raw_words=utterance_words,
            )

            with self._lock:
                self._entries.append(entry)
            new_entries.append(entry)

        return new_entries

    @property
    def entries(self) -> list[TranscriptEntry]:
        """Return a copy of all transcript entries in chronological order."""
        with self._lock:
            return list(self._entries)

    @property
    def entry_count(self) -> int:
        """Total entries in the transcript."""
        with self._lock:
            return len(self._entries)

    @property
    def total_processed(self) -> int:
        """Total utterances processed (including duplicates)."""
        return self._entry_count

    @property
    def duplicate_count(self) -> int:
        """Total duplicates filtered."""
        return self._duplicate_count

    def get_entries_by_speaker(self, user_id: str) -> list[TranscriptEntry]:
        """Get all entries for a specific Discord user."""
        with self._lock:
            return [e for e in self._entries if e.speaker.user_id == user_id]

    def get_speaker_stats(self) -> dict[str, dict[str, Any]]:
        """
        Get per-speaker statistics.

        Returns dict of user_id -> {display_name, entry_count, total_duration, word_count}
        """
        with self._lock:
            stats: dict[str, dict[str, Any]] = {}
            for entry in self._entries:
                uid = entry.speaker.user_id
                if uid not in stats:
                    stats[uid] = {
                        "display_name": entry.speaker.display_name,
                        "entry_count": 0,
                        "total_duration": 0.0,
                        "word_count": 0,
                    }
                stats[uid]["entry_count"] += 1
                stats[uid]["total_duration"] += entry.duration
                stats[uid]["word_count"] += len(entry.text.split())
            return stats

    def to_plain_text(self) -> str:
        """Export transcript as plain text with speaker labels and timestamps."""
        with self._lock:
            lines: list[str] = []
            for entry in self._entries:
                minutes = int(entry.timestamp // 60)
                seconds = int(entry.timestamp % 60)
                ts = f"[{minutes:02d}:{seconds:02d}]"
                lines.append(f"{ts} {entry.speaker.display_name}: {entry.text}")
            return "\n".join(lines)

    def to_structured_data(self) -> list[dict[str, Any]]:
        """Export transcript as structured dicts for JSON serialization."""
        with self._lock:
            return [
                {
                    "speaker_id": entry.speaker.user_id,
                    "speaker_name": entry.speaker.display_name,
                    "text": entry.text,
                    "timestamp": entry.timestamp,
                    "duration": entry.duration,
                    "language": entry.language.value,
                    "confidence": entry.confidence,
                    "is_final": entry.is_final,
                }
                for entry in self._entries
            ]

    def reset(self) -> None:
        """Clear all transcript data. Call when starting a new session."""
        with self._lock:
            self._entries.clear()
        self.speaker_map.clear()
        self._dedup.reset()
        self._entry_count = 0
        self._duplicate_count = 0


def _get_words_for_speaker(
    all_words: list[dict[str, Any]],
    speaker_index: int,
) -> list[dict[str, Any]]:
    """Extract words belonging to a specific speaker from the word list."""
    return [w for w in all_words if w.get("speaker", 0) == speaker_index]
