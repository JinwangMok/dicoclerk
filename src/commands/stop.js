import { cleanupSession, formatCleanupMessage } from '../session/session-cleanup.js';
import { generateAndDeliverMinutes } from '../minutes/generator.js';

/**
 * Handle /stop slash command — end recording and trigger minutes generation.
 * Uses shared cleanupSession() for teardown, then triggers minutes generation.
 *
 * Only a participant currently in the active voice channel may stop the session.
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

  // Validate: invoker must be in the active voice channel.
  // Fetch the session early (before deferReply) so we can check the channel ID
  // without incurring a slow defer first.
  const activeSession = sessionManager.getSession(interaction.guildId);
  const memberVoiceChannelId = interaction.member?.voice?.channel?.id;

  if (!memberVoiceChannelId || memberVoiceChannelId !== activeSession?.voiceChannelId) {
    await interaction.reply({
      content: `❌ You must be in the active voice channel <#${activeSession?.voiceChannelId}> to stop the recording.`,
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
        // Pass the resolved speaker map from the coordinator (after #resolveAllSpeakerNames ran)
        // so that aggregateSessionData uses the fully-enriched speaker identities.
        speakerMap: result.speakerMap,
        // Pass the structured per-session transcript store for richer minutes generation
        transcriptSession: result.transcriptSession ?? null,
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
