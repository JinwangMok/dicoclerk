import { cleanupSession, formatCleanupMessage } from '../session/session-cleanup.js';
import { generateAndDeliverMinutes } from '../minutes/generator.js';

/**
 * Handle /stop slash command — end recording and trigger minutes generation.
 * Uses shared cleanupSession() for teardown, then triggers minutes generation.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('../voice/session-manager.js').SessionManager} sessionManager
 */
export async function handleStop(interaction, sessionManager) {
  if (!sessionManager.hasSession(interaction.guildId)) {
    await interaction.reply({
      content: '❌ No active recording session in this server.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  try {
    // Capture session reference before cleanup (needed for minutes generation)
    const session = sessionManager.getSession(interaction.guildId);

    if (!session) {
      await interaction.editReply({
        content: '❌ Session was already stopped.',
      });
      return;
    }

    // Shared cleanup: stop Deepgram, finalize transcript, disconnect voice
    const result = await cleanupSession({
      sessionManager,
      guildId: interaction.guildId,
      reason: 'manual_stop',
    });

    // Report status to user
    const message = formatCleanupMessage(result);
    await interaction.editReply({ content: message });

    console.log(
      `[Command] /stop executed: guild=${interaction.guildId} duration=${result.durationMinutes}m${result.durationSeconds}s participants=${result.participantCount} entries=${result.transcriptCount}`
    );

    // Fire-and-forget: trigger minutes generation pipeline
    generateAndDeliverMinutes({
      transcript: result.transcript,
      session,
      transcriptResult: {
        transcript: result.transcript,
        filePath: result.transcriptFilePath,
      },
      client: interaction.client,
      reason: 'manual_stop',
      duration: result.duration,
    }).then((minutesResult) => {
      if (minutesResult.success) {
        console.log(`[Command] /stop minutes generated in ${minutesResult.generationTimeMs}ms: ${minutesResult.filePath}`);
      } else {
        console.error(`[Command] /stop minutes generation failed: ${minutesResult.error}`);
      }
    }).catch((err) => {
      console.error('[Command] /stop minutes pipeline unexpected error:', err);
    });
  } catch (error) {
    console.error('[Command] /stop failed:', error);
    await interaction.editReply({
      content: '❌ Failed to stop the session. The connection may have already been lost.',
    });
  }
}
