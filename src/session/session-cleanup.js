/**
 * Shared Session Cleanup
 *
 * Provides a unified teardown flow used by both:
 * - /stop command (manual_stop)
 * - sessionEnd event handler (channel_empty, connection_destroyed)
 * - Graceful shutdown (shutdown)
 *
 * Steps:
 * 1. Stop the AudioSessionCoordinator (flushes Deepgram, saves transcript)
 * 2. Stop the session via SessionManager (disconnects voice)
 * 3. Return a structured result with duration, transcript, etc.
 */

/**
 * @typedef {Object} CleanupResult
 * @property {boolean} success              - Whether cleanup completed without critical errors
 * @property {string} reason                - Why the session ended
 * @property {number} duration              - Total duration in seconds
 * @property {number} durationMinutes       - Minutes component of duration
 * @property {number} durationSeconds       - Seconds component of duration
 * @property {number} participantCount      - Number of participants
 * @property {number} transcriptCount       - Number of transcript entries
 * @property {Array<Object>} transcript     - The transcript entries
 * @property {string|null} transcriptFilePath - Path to saved transcript file
 * @property {Map<number,string>|null} speakerMap - Deepgram speaker label -> resolved display name
 *   Captured from AudioSessionCoordinator after stop() so that #resolveAllSpeakerNames() has run.
 *   Null when no coordinator was attached or the map is empty.
 * @property {import('../stt/transcript-store.js').TranscriptSession|null} transcriptSession
 *   The structured per-session transcript store, with speaker-attributed entries and
 *   export helpers (toStructuredData, toPlainText, getSummary). Available after
 *   AudioSessionCoordinator.stop() runs #resolveAllSpeakerNames(). Null if no
 *   coordinator was attached or the coordinator did not yet start.
 * @property {string[]} warnings            - Any warnings during cleanup
 */

/**
 * Clean up a recording session: stop audio coordinator, finalize transcript,
 * disconnect from voice channel.
 *
 * This function is idempotent — calling it when no session exists returns
 * a safe empty result. It handles coordinator failures gracefully, falling
 * back to session transcript data.
 *
 * Two usage modes:
 * 1. **Lookup mode** (default): Pass only `sessionManager` + `guildId`.
 *    Used by the /stop command — the session is still in sessionManager at
 *    call time, so we look it up then stop it.
 *
 * 2. **Direct mode**: Pass `session` explicitly in addition to the above.
 *    Used by the auto-disconnect path (`sessionEnd` event handler) where
 *    SessionManager.#endSession() has already removed the session from its
 *    internal map before the event fires. The caller passes the session
 *    object received from the event payload.
 *    In this mode, `stopSession()` is still attempted but is a safe no-op
 *    (session not found → returns null, no error thrown).
 *
 * @param {Object} options
 * @param {import('../voice/session-manager.js').SessionManager} options.sessionManager
 * @param {string} options.guildId
 * @param {string} options.reason - 'manual_stop' | 'channel_empty' | 'connection_destroyed' | 'shutdown'
 * @param {import('../voice/session-manager.js').SessionInfo} [options.session] - Optional session object.
 *   If provided, skips the getSession() lookup (use for auto-disconnect path).
 * @returns {Promise<CleanupResult>}
 */
export async function cleanupSession({ sessionManager, guildId, reason, session: providedSession }) {
  const warnings = [];

  // 1. Get session before any teardown.
  //    Prefer the provided session (direct mode) over a live lookup (lookup mode).
  const session = providedSession ?? sessionManager.getSession(guildId);

  if (!session) {
    return {
      success: true,
      reason,
      duration: 0,
      durationMinutes: 0,
      durationSeconds: 0,
      participantCount: 0,
      transcriptCount: 0,
      transcript: [],
      transcriptFilePath: null,
      speakerMap: null,
      transcriptSession: null,
      warnings: ['Session not found'],
    };
  }

  // 2. Stop audio coordinator (Deepgram stream + transcript finalization)
  let transcriptResult = null;
  // speakerMap is captured AFTER stop() because AudioSessionCoordinator.stop() calls
  // #resolveAllSpeakerNames() which performs a final pass enriching the speaker map.
  // The coordinator's #speakerMap field is not cleared during teardown, so it remains
  // accessible via the getter after stop() returns.
  let speakerMap = null;
  // transcriptSession is the structured in-memory per-session store — contains
  // speaker-attributed, deduplicated entries with export helpers for minutes generation.
  let transcriptSession = null;

  if (session.audioCoordinator) {
    try {
      if (session.audioCoordinator.isRunning) {
        transcriptResult = await session.audioCoordinator.stop();
      } else {
        // Coordinator exists but isn't running — still grab its transcript
        const coordinatorTranscript = session.audioCoordinator.transcript;
        transcriptResult = {
          transcript: coordinatorTranscript?.length > 0 ? coordinatorTranscript : [],
          filePath: null,
          transcriptSession: session.audioCoordinator.transcriptSession ?? null,
        };
        warnings.push('Audio coordinator was not running at cleanup time');
      }
      // Capture speaker map after stop() so #resolveAllSpeakerNames() has already run.
      const rawMap = session.audioCoordinator.speakerMap;
      if (rawMap instanceof Map && rawMap.size > 0) {
        speakerMap = rawMap;
      }
      // Capture the structured transcript session (may be null if start() was never called)
      transcriptSession = transcriptResult?.transcriptSession ?? null;
    } catch (err) {
      console.error(`[SessionCleanup] Audio coordinator stop error (guild=${guildId}):`, err);
      warnings.push(`Audio coordinator stop failed: ${err.message}`);

      // Recover transcript: prefer coordinator's data if non-empty, else session's
      const coordinatorTranscript = session.audioCoordinator.transcript;
      const fallback =
        (coordinatorTranscript?.length > 0 ? coordinatorTranscript : null)
        ?? (session.transcript?.length > 0 ? session.transcript : null)
        ?? [];
      transcriptResult = { transcript: fallback, filePath: null };

      // Still try to capture the speaker map and transcript session even after a stop() error
      try {
        const rawMap = session.audioCoordinator.speakerMap;
        if (rawMap instanceof Map && rawMap.size > 0) {
          speakerMap = rawMap;
        }
        transcriptSession = session.audioCoordinator.transcriptSession ?? null;
      } catch (_) { /* non-fatal */ }
    }
  } else {
    warnings.push('No audio coordinator attached to session');
  }

  // 3. Compute session stats
  const duration = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
  const durationMinutes = Math.floor(duration / 60);
  const durationSeconds = duration % 60;
  const participantCount = session.participants?.size ?? 0;
  const transcript = transcriptResult?.transcript ?? session.transcript ?? [];
  const transcriptCount = transcript.length;
  const transcriptFilePath = transcriptResult?.filePath ?? null;

  // 4. Stop voice session (disconnects from voice channel)
  //    Must happen AFTER audio coordinator stop so Deepgram can flush its buffer.
  //
  //    Direct mode: when `providedSession` was supplied, SessionManager.#endSession()
  //    has already destroyed the voice connection before emitting `sessionEnd`.
  //    Calling stopSession() here would be a harmless no-op (session not in map),
  //    but we skip it intentionally to avoid confusing log noise and future issues.
  if (!providedSession) {
    try {
      sessionManager.stopSession(guildId);
    } catch (err) {
      console.error(`[SessionCleanup] Session manager stop error (guild=${guildId}):`, err);
      warnings.push(`Session manager stop failed: ${err.message}`);
    }
  }

  console.log(
    `[SessionCleanup] Complete: guild=${guildId} reason=${reason} ` +
    `duration=${durationMinutes}m${durationSeconds}s participants=${participantCount} ` +
    `entries=${transcriptCount} warnings=${warnings.length}`
  );

  return {
    success: !warnings.some(w => w.includes('stop failed')),
    reason,
    duration,
    durationMinutes,
    durationSeconds,
    participantCount,
    transcriptCount,
    transcript,
    transcriptFilePath,
    speakerMap,
    transcriptSession,
    warnings,
  };
}

/**
 * Format a CleanupResult into a human-readable Discord message.
 *
 * @param {CleanupResult} result
 * @param {Object} [options]
 * @param {boolean} [options.includeMinutesNotice=true] - Whether to show "generating minutes" notice
 * @returns {string}
 */
export function formatCleanupMessage(result, { includeMinutesNotice = true } = {}) {
  const reasonLabels = {
    manual_stop: 'Recording stopped',
    channel_empty: 'Recording auto-stopped (voice channel empty)',
    connection_destroyed: 'Recording auto-stopped (connection lost)',
    shutdown: 'Recording stopped (shutdown)',
  };

  const lines = [
    `⏹️ **${reasonLabels[result.reason] || 'Recording stopped'}**`,
    `⏱️ Duration: **${result.durationMinutes}m ${result.durationSeconds}s**`,
    `👥 Participants: **${result.participantCount}**`,
    `💬 Transcript entries: **${result.transcriptCount}**`,
  ];

  if (result.transcriptFilePath) {
    lines.push('💾 Transcript saved to disk');
  }

  if (includeMinutesNotice && result.transcriptCount > 0) {
    lines.push('📝 Generating meeting minutes... (this may take 1-2 minutes)');
  }

  if (result.warnings.length > 0) {
    lines.push(`⚠️ ${result.warnings.length} warning(s) during cleanup`);
  }

  return lines.filter(Boolean).join('\n');
}
