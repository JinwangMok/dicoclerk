import { PermissionsBitField } from 'discord.js';
import { AudioSessionCoordinator } from '../audio/session-coordinator.js';
import { cleanupSession } from '../session/session-cleanup.js';
import { generateAndDeliverMinutes } from '../minutes/generator.js';

/**
 * Handle /start slash command — join the user's voice channel and begin recording.
 *
 * Text channel resolution order:
 * 1. Guild-configured channel (via /setup) — preferred
 * 2. The channel where /start was invoked — fallback
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('../voice/session-manager.js').SessionManager} sessionManager
 * @param {import('../config/guild-config-store.js').GuildConfigStore} [guildConfigStore]
 * @param {Object} [_deps] - Optional dependency overrides (used for testing / DI)
 * @param {typeof AudioSessionCoordinator} [_deps.AudioSessionCoordinator]
 * @param {typeof cleanupSession} [_deps.cleanupSession]
 * @param {typeof generateAndDeliverMinutes} [_deps.generateAndDeliverMinutes]
 */
export async function handleStart(interaction, sessionManager, guildConfigStore, _deps = {}) {
  const {
    AudioSessionCoordinator: CoordinatorClass = AudioSessionCoordinator,
    cleanupSession: _cleanupSession = cleanupSession,
    generateAndDeliverMinutes: _generateAndDeliverMinutes = generateAndDeliverMinutes,
  } = _deps;
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  // Validate: user must be in a voice channel
  if (!voiceChannel) {
    await interaction.reply({
      content: '❌ You must be in a voice channel to start recording.',
      ephemeral: true,
    });
    return;
  }

  // Validate: no active session in this guild
  if (sessionManager.hasSession(interaction.guildId)) {
    const existing = sessionManager.getSession(interaction.guildId);
    await interaction.reply({
      content: `❌ A recording session is already active in <#${existing.voiceChannelId}>. Use \`/stop\` to end it first.`,
      ephemeral: true,
    });
    return;
  }

  // Validate: bot has required permissions to join the voice channel
  const botMember = interaction.guild.members.me;
  if (botMember) {
    const permissions = voiceChannel.permissionsFor(botMember);
    if (!permissions?.has(PermissionsBitField.Flags.ViewChannel)) {
      await interaction.reply({
        content: `❌ I don't have permission to view <#${voiceChannel.id}>. Please grant me the **View Channel** permission.`,
        ephemeral: true,
      });
      return;
    }
    if (!permissions?.has(PermissionsBitField.Flags.Connect)) {
      await interaction.reply({
        content: `❌ I don't have permission to join <#${voiceChannel.id}>. Please grant me the **Connect** permission.`,
        ephemeral: true,
      });
      return;
    }
  }

  // Validate: Deepgram API key is configured
  if (!process.env.DEEPGRAM_API_KEY) {
    await interaction.reply({
      content: '❌ Deepgram API key is not configured. Set `DEEPGRAM_API_KEY` in your `.env` file.',
      ephemeral: true,
    });
    return;
  }

  const language = interaction.options.getString('language') || process.env.STT_LANGUAGE || 'multi';

  // Resolve target text channel for minutes delivery:
  // Prefer the guild-configured channel (set via /setup), fall back to the
  // channel where /start was invoked.
  let textChannelId = interaction.channelId;
  let usingConfiguredChannel = false;
  if (guildConfigStore) {
    const configuredChannelId = await guildConfigStore.getTextChannelId(interaction.guildId);
    if (configuredChannelId) {
      textChannelId = configuredChannelId;
      usingConfiguredChannel = true;
    }
  }

  // Defer reply since joining + Deepgram setup may take a moment
  await interaction.deferReply();

  try {
    // Start session via session manager (joins voice channel)
    const session = await sessionManager.startSession({
      voiceChannel,
      textChannelId,
      guild: interaction.guild,
      language,
      startedBy: member.user.tag,
    });

    // Create audio coordinator for this session
    const coordinator = new CoordinatorClass({
      guildId: interaction.guildId,
      language,
      sessionId: `${interaction.guildId}-${Date.now()}`,
    });

    // Store coordinator on the session for later retrieval
    session.audioCoordinator = coordinator;

    // Get the voice connection from the connection manager.
    // The AudioCapturePipeline in direct mode subscribes to the VoiceReceiver's
    // speaking events, so we do NOT need enableAutoSubscribe from the connection
    // manager — it would create duplicate per-user subscriptions.
    // SessionManager.startSession already calls enableAutoSubscribe for participant
    // tracking; the pipeline's own subscriptions handle actual audio forwarding.
    const connectionManager = sessionManager.getConnectionManager(interaction.guildId);
    const voiceConnection = connectionManager.connection;

    if (!voiceConnection) {
      throw new Error('Voice connection not available after joining channel');
    }

    // Username resolver using guild member cache
    const resolveUsername = async (userId) => {
      try {
        const guildMember = await interaction.guild.members.fetch(userId);
        return guildMember.displayName || guildMember.user.username;
      } catch {
        return `User-${userId.slice(-4)}`;
      }
    };

    // Pre-register users currently in the voice channel
    for (const [memberId, guildMember] of voiceChannel.members) {
      if (!guildMember.user.bot) {
        coordinator.registerUser(memberId, guildMember.displayName);
      }
    }

    // Wire coordinator events for user-facing notifications
    coordinator.on('deepgram_reconnecting', ({ attempt, maxAttempts }) => {
      const textChannel = interaction.guild.channels.cache.get(interaction.channelId);
      if (textChannel && attempt === 1) {
        textChannel.send({
          content: `⚠️ Speech recognition connection interrupted. Reconnecting... (attempt ${attempt}/${maxAttempts})`,
        }).catch(console.error);
      }
    });

    coordinator.on('deepgram_connected', () => {
      // Notify on reconnection (not initial connection)
      if (session.audioCoordinator?._hasNotifiedDisconnect) {
        const textChannel = interaction.guild.channels.cache.get(interaction.channelId);
        if (textChannel) {
          textChannel.send({
            content: '✅ Speech recognition reconnected. Transcription continues.',
          }).catch(console.error);
        }
        session.audioCoordinator._hasNotifiedDisconnect = false;
      }
    });

    coordinator.on('deepgram_disconnected', () => {
      session.audioCoordinator._hasNotifiedDisconnect = true;
    });

    coordinator.on('deepgram_failed', async () => {
      // Resolve the notification channel — prefer the configured textChannelId,
      // fall back to the channel where /start was invoked.
      const notifyChannel =
        interaction.guild.channels.cache.get(textChannelId) ??
        interaction.guild.channels.cache.get(interaction.channelId);

      // Step 1: Send an immediate, clear failure notification.
      if (notifyChannel) {
        notifyChannel.send({
          content: [
            '❌ **Speech recognition permanently disconnected.**',
            'All reconnect attempts to the transcription service have been exhausted and transcription has stopped.',
            'The partial transcript captured so far has been saved.',
            '**Automatically stopping the recording session and generating meeting minutes from the available transcript...**',
          ].join('\n'),
        }).catch(console.error);
      }

      // Guard: avoid double-cleanup if the user ran /stop at the same moment.
      if (!sessionManager.hasSession(interaction.guildId)) return;

      // Step 2: Graceful teardown — stops audio coordinator, saves transcript, disconnects voice.
      let result;
      try {
        result = await _cleanupSession({
          sessionManager,
          guildId: interaction.guildId,
          reason: 'deepgram_failed',
        });
      } catch (err) {
        console.error('[Command] deepgram_failed cleanup error:', err.message);
        if (notifyChannel) {
          notifyChannel.send({
            content: '⚠️ An error occurred while stopping the session. Please use `/stop` manually if the bot is still connected.',
          }).catch(console.error);
        }
        return;
      }

      // Step 3: Send a session-end summary to the text channel.
      if (notifyChannel) {
        const summaryLines = [
          '⏹️ **Session ended automatically** (transcription service permanently unavailable)',
          `⏱️ Duration: **${result.durationMinutes}m ${result.durationSeconds}s**`,
          `👥 Participants: **${result.participantCount}**`,
          `💬 Transcript entries captured: **${result.transcriptCount}**`,
        ];
        if (result.transcriptCount > 0) {
          summaryLines.push('📝 Generating meeting minutes from captured transcript... (this may take 1–2 minutes)');
        } else {
          summaryLines.push('⚠️ No transcript entries were captured — meeting minutes will not be generated.');
        }
        notifyChannel.send({ content: summaryLines.join('\n') }).catch(console.error);
      }

      console.log(
        `[Command] deepgram_failed auto-stop: guild=${interaction.guildId} ` +
        `duration=${result.durationMinutes}m${result.durationSeconds}s entries=${result.transcriptCount}`
      );

      // Step 4: Fire-and-forget minutes generation if there is anything to summarise.
      if (result.transcriptCount > 0) {
        _generateAndDeliverMinutes({
          transcript: result.transcript,
          session,
          transcriptResult: {
            transcript: result.transcript,
            filePath: result.transcriptFilePath,
            speakerMap: result.speakerMap,
            transcriptSession: result.transcriptSession ?? null,
          },
          client: interaction.client,
          reason: 'deepgram_failed',
          duration: result.duration,
        }).then((minutesResult) => {
          if (minutesResult.success) {
            console.log(
              `[Command] deepgram_failed minutes generated in ${minutesResult.generationTimeMs}ms: ${minutesResult.filePath}`
            );
          } else {
            console.error(`[Command] deepgram_failed minutes generation failed: ${minutesResult.error}`);
          }
        }).catch((err) => {
          console.error('[Command] deepgram_failed minutes pipeline unexpected error:', err);
        });
      }
    });

    coordinator.on('transcript', (entry) => {
      // Store transcript entries in the session for access by other systems
      session.transcript.push(entry);
    });

    // Start audio capture pipeline + Deepgram connection
    await coordinator.start(voiceConnection, resolveUsername);

    const minutesChannelLine = usingConfiguredChannel
      ? `📨 Minutes will be sent to: <#${textChannelId}>`
      : `📨 Minutes will be sent to: this channel`;

    await interaction.editReply({
      content: [
        `✅ **Recording started** in <#${voiceChannel.id}>`,
        `🎙️ Language: **${language === 'multi' ? 'Korean + English' : language === 'ko' ? 'Korean' : 'English'}**`,
        `👤 Started by: **${member.user.tag}**`,
        `🔊 Speech recognition: **Active**`,
        minutesChannelLine,
        `\nUse \`/stop\` to end the session and generate meeting minutes.`,
      ].join('\n'),
    });

    console.log(`[Command] /start executed: guild=${interaction.guildId} channel=${voiceChannel.id} lang=${language}`);
  } catch (error) {
    console.error('[Command] /start failed:', error);

    // Clean up session if it was partially created
    if (sessionManager.hasSession(interaction.guildId)) {
      sessionManager.stopSession(interaction.guildId);
    }

    // Classify known join error types for user-friendly messages
    let errorMessage = error.message;
    if (
      error.code === 50013 ||
      error.message?.toLowerCase().includes('missing permissions') ||
      error.message?.toLowerCase().includes('missing access')
    ) {
      errorMessage = `Missing permissions to join <#${voiceChannel.id}>. Ensure the bot has **Connect** and **View Channel** permissions.`;
    } else if (
      error.message?.toLowerCase().includes('timed out') ||
      error.message?.toLowerCase().includes('timeout')
    ) {
      errorMessage = `Timed out connecting to <#${voiceChannel.id}>. The voice server may be unavailable. Please try again.`;
    } else if (error.message?.includes('destroyed')) {
      errorMessage = `Voice connection was unexpectedly closed while joining <#${voiceChannel.id}>. Please try again.`;
    }

    await interaction.editReply({
      content: `❌ Failed to start recording: ${errorMessage}\nPlease check bot permissions and Deepgram configuration.`,
    });
  }
}
