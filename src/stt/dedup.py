"""
Duplicate utterance detection for STT output.

Detects and filters duplicate utterances using a combination of:
1. Content fingerprinting (normalized text hashing)
2. Speaker identity matching
3. Timestamp proximity detection
4. Fuzzy content similarity (Levenshtein-based)

This handles common STT duplication scenarios:
- Deepgram sending the same interim result multiple times
- Overlapping audio chunks producing identical transcriptions
- Near-duplicate partial results from real-time streaming
"""

from __future__ import annotations

import hashlib
import re
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Utterance:
    """A single utterance from STT output."""
    speaker: str
    text: str
    timestamp: float  # seconds from session start
    is_final: bool = True
    channel: Optional[int] = None  # audio channel / SSRC identifier


@dataclass
class DeduplicationConfig:
    """Configuration for dedup behavior."""
    # Time window (seconds) within which similar utterances are considered duplicates
    time_window: float = 5.0
    # Similarity threshold (0.0–1.0); above this, utterances are considered duplicates
    similarity_threshold: float = 0.75
    # Max utterances to keep in the sliding window for comparison
    window_size: int = 100
    # Whether to treat interim (non-final) results as always replaceable
    deduplicate_interim: bool = True
    # Exact-match grace period: identical text from same speaker within this window
    # is always a duplicate regardless of similarity scoring
    exact_match_window: float = 10.0


def _normalize_text(text: str) -> str:
    """Normalize text for comparison: lowercase, strip punctuation/whitespace."""
    text = text.lower().strip()
    # Remove punctuation
    text = re.sub(r'[^\w\s]', '', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text)
    return text


def _fingerprint(speaker: str, text: str) -> str:
    """Create a deterministic fingerprint for a speaker+text pair."""
    normalized = _normalize_text(text)
    content = f"{speaker}::{normalized}"
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


def _levenshtein_distance(s1: str, s2: str) -> int:
    """Compute Levenshtein edit distance between two strings."""
    if len(s1) < len(s2):
        return _levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)

    prev_row = list(range(len(s2) + 1))
    for i, c1 in enumerate(s1):
        curr_row = [i + 1]
        for j, c2 in enumerate(s2):
            # Insertion, deletion, substitution
            cost = 0 if c1 == c2 else 1
            curr_row.append(min(
                curr_row[j] + 1,        # insertion
                prev_row[j + 1] + 1,    # deletion
                prev_row[j] + cost,      # substitution
            ))
        prev_row = curr_row
    return prev_row[-1]


def text_similarity(a: str, b: str) -> float:
    """
    Compute normalized similarity between two strings (0.0–1.0).
    Uses normalized Levenshtein distance.
    """
    na = _normalize_text(a)
    nb = _normalize_text(b)
    if na == nb:
        return 1.0
    if not na or not nb:
        return 0.0
    max_len = max(len(na), len(nb))
    dist = _levenshtein_distance(na, nb)
    return 1.0 - (dist / max_len)


def _is_substring_match(shorter: str, longer: str) -> bool:
    """Check if one normalized text is a substantial substring of another."""
    ns = _normalize_text(shorter)
    nl = _normalize_text(longer)
    if not ns or not nl:
        return False
    # The shorter must be at least 60% of the longer to count
    if len(ns) / len(nl) < 0.6:
        return False
    return ns in nl


@dataclass
class DeduplicationResult:
    """Result of a dedup check."""
    is_duplicate: bool
    reason: Optional[str] = None
    matched_utterance: Optional[Utterance] = None
    similarity_score: Optional[float] = None


class UtteranceDeduplicator:
    """
    Sliding-window deduplicator for real-time STT utterances.

    Maintains a bounded window of recent utterances and checks new ones
    against them using fingerprint, timestamp proximity, and fuzzy matching.
    """

    def __init__(self, config: Optional[DeduplicationConfig] = None):
        self.config = config or DeduplicationConfig()
        self._window: deque[Utterance] = deque(maxlen=self.config.window_size)
        self._fingerprints: dict[str, float] = {}  # fingerprint -> timestamp
        self._interim_cache: dict[str, Utterance] = {}  # speaker -> latest interim

    def check(self, utterance: Utterance) -> DeduplicationResult:
        """
        Check if an utterance is a duplicate.

        Returns DeduplicationResult indicating whether to discard.
        """
        # Skip empty utterances
        normalized = _normalize_text(utterance.text)
        if not normalized:
            return DeduplicationResult(
                is_duplicate=True,
                reason="empty_text",
            )

        # Handle interim results: they always replace previous interim from same speaker
        if not utterance.is_final and self.config.deduplicate_interim:
            return self._check_interim(utterance, normalized)

        # 1. Exact fingerprint match (same speaker + identical normalized text)
        fp = _fingerprint(utterance.speaker, utterance.text)
        if fp in self._fingerprints:
            prev_ts = self._fingerprints[fp]
            if abs(utterance.timestamp - prev_ts) <= self.config.exact_match_window:
                return DeduplicationResult(
                    is_duplicate=True,
                    reason="exact_fingerprint",
                    similarity_score=1.0,
                )

        # 2. Check against sliding window for fuzzy matches
        result = self._check_window(utterance, normalized)
        if result.is_duplicate:
            return result

        # Not a duplicate — accept it
        self._accept(utterance, fp)
        return DeduplicationResult(is_duplicate=False)

    def _check_interim(self, utterance: Utterance, normalized: str) -> DeduplicationResult:
        """Handle interim (non-final) utterance dedup."""
        key = utterance.speaker
        if key in self._interim_cache:
            prev = self._interim_cache[key]
            sim = text_similarity(prev.text, utterance.text)
            # For interim results, use a lower threshold since they are
            # progressive refinements of the same speech segment.
            # Also check substring containment (e.g. "the meet" → "the meeting").
            prev_norm = _normalize_text(prev.text)
            curr_norm = _normalize_text(utterance.text)
            is_continuation = (
                sim >= self.config.similarity_threshold
                or (prev_norm and curr_norm and (prev_norm in curr_norm or curr_norm in prev_norm))
            )
            if is_continuation:
                # Replace old interim with new one (it's an update)
                self._interim_cache[key] = utterance
                return DeduplicationResult(
                    is_duplicate=True,
                    reason="interim_update",
                    matched_utterance=prev,
                    similarity_score=sim,
                )
        # New interim for this speaker
        self._interim_cache[key] = utterance
        return DeduplicationResult(is_duplicate=False)

    def _check_window(self, utterance: Utterance, normalized: str) -> DeduplicationResult:
        """Check utterance against the sliding window for fuzzy duplicates."""
        for prev in reversed(self._window):
            # Only compare same speaker
            if prev.speaker != utterance.speaker:
                continue

            # Only within time window
            time_diff = abs(utterance.timestamp - prev.timestamp)
            if time_diff > self.config.time_window:
                continue

            # Fuzzy similarity check
            sim = text_similarity(prev.text, utterance.text)
            if sim >= self.config.similarity_threshold:
                return DeduplicationResult(
                    is_duplicate=True,
                    reason="fuzzy_match",
                    matched_utterance=prev,
                    similarity_score=sim,
                )

            # Substring containment check (handles partial → full result)
            shorter, longer = (utterance.text, prev.text) if len(utterance.text) < len(prev.text) else (prev.text, utterance.text)
            if _is_substring_match(shorter, longer):
                return DeduplicationResult(
                    is_duplicate=True,
                    reason="substring_match",
                    matched_utterance=prev,
                    similarity_score=sim,
                )

        return DeduplicationResult(is_duplicate=False)

    def _accept(self, utterance: Utterance, fingerprint: str) -> None:
        """Accept an utterance into the window and fingerprint cache."""
        self._window.append(utterance)
        self._fingerprints[fingerprint] = utterance.timestamp

        # Clear interim cache for this speaker when a final result arrives
        if utterance.is_final and utterance.speaker in self._interim_cache:
            del self._interim_cache[utterance.speaker]

        # Evict old fingerprints beyond the exact match window
        self._evict_stale_fingerprints(utterance.timestamp)

    def _evict_stale_fingerprints(self, current_time: float) -> None:
        """Remove fingerprints older than the exact match window."""
        cutoff = current_time - self.config.exact_match_window
        stale = [fp for fp, ts in self._fingerprints.items() if ts < cutoff]
        for fp in stale:
            del self._fingerprints[fp]

    def finalize_interim(self, speaker: str) -> Optional[Utterance]:
        """
        Retrieve and clear the latest interim utterance for a speaker.
        Call this when converting interim to final.
        """
        return self._interim_cache.pop(speaker, None)

    def reset(self) -> None:
        """Clear all state. Call when starting a new session."""
        self._window.clear()
        self._fingerprints.clear()
        self._interim_cache.clear()

    @property
    def window_size(self) -> int:
        """Current number of utterances in the sliding window."""
        return len(self._window)
