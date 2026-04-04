"""STT processing modules for dicoclerk."""

from .dedup import (
    DeduplicationConfig,
    DeduplicationResult,
    Utterance,
    UtteranceDeduplicator,
    text_similarity,
)
from .transcript import (
    DiscordUser,
    Language,
    SessionTranscript,
    SpeakerMap,
    SpeakerMapping,
    TranscriptEntry,
    parse_deepgram_response,
)

__all__ = [
    "DeduplicationConfig",
    "DeduplicationResult",
    "DiscordUser",
    "Language",
    "SessionTranscript",
    "SpeakerMap",
    "SpeakerMapping",
    "TranscriptEntry",
    "Utterance",
    "UtteranceDeduplicator",
    "parse_deepgram_response",
    "text_similarity",
]
