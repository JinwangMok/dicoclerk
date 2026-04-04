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
 * @param {Object} options
 * @param {import('../voice/session-manager.js').SessionManager} options.sessionManager
 * @param {string} options.guildId
 * @param {string} options.reason - 'manual_stop' | 'channel_empty' | 'connection_destroyed' | 'shutdown'
 * @returns {Promise<CleanupResult>}
 */
export async function cleanupSession({ sessionManager, guildId, reason }) {
  const warnings = [];

  // 1. Get session before any teardown
  const session = sessionManager.getSession(guildId);

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
      warnings: ['Session not found'],
    };
  }

  // 2. Stop audio coordinator (Deepgram stream + transcript finalization)
  let transcriptResult = null;

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
        };
        warnings.push('Audio coordinator was not running at cleanup time');
      }
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
  try {
    sessionManager.stopSession(guildId);
  } catch (err) {
    console.error(`[SessionCleanup] Session manager stop error (guild=${guildId}):`, err);
    warnings.push(`Session manager stop failed: ${err.message}`);
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
