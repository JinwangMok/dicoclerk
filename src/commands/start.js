import { AudioSessionCoordinator } from '../audio/session-coordinator.js';

/**
 * Handle /start slash command — join the user's voice channel and begin recording.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('../voice/session-manager.js').SessionManager} sessionManager
 */
export async function handleStart(interaction, sessionManager) {
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

  // Validate: Deepgram API key is configured
  if (!process.env.DEEPGRAM_API_KEY) {
    await interaction.reply({
      content: '❌ Deepgram API key is not configured. Set `DEEPGRAM_API_KEY` in your `.env` file.',
      ephemeral: true,
    });
    return;
  }

  const language = interaction.options.getString('language') || process.env.STT_LANGUAGE || 'multi';

  // Defer reply since joining + Deepgram setup may take a moment
  await interaction.deferReply();

  try {
    // Start session via session manager (joins voice channel)
    const session = await sessionManager.startSession({
      voiceChannel,
      textChannelId: interaction.channelId,
      guild: interaction.guild,
      language,
      startedBy: member.user.tag,
    });

    // Create audio coordinator for this session
    const coordinator = new AudioSessionCoordinator({
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

    coordinator.on('deepgram_failed', () => {
      const textChannel = interaction.guild.channels.cache.get(interaction.channelId);
      if (textChannel) {
        textChannel.send({
          content: [
            '❌ **Speech recognition connection lost permanently.**',
            'Partial transcript has been saved. Voice recording continues but new speech will not be transcribed.',
            'Use `/stop` to end the session and generate minutes from what was captured.',
          ].join('\n'),
        }).catch(console.error);
      }
    });

    coordinator.on('transcript', (entry) => {
      // Store transcript entries in the session for access by other systems
      session.transcript.push(entry);
    });

    // Start audio capture pipeline + Deepgram connection
    await coordinator.start(voiceConnection, resolveUsername);

    await interaction.editReply({
      content: [
        `✅ **Recording started** in <#${voiceChannel.id}>`,
        `🎙️ Language: **${language === 'multi' ? 'Korean + English' : language === 'ko' ? 'Korean' : 'English'}**`,
        `👤 Started by: **${member.user.tag}**`,
        `🔊 Speech recognition: **Active**`,
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

    await interaction.editReply({
      content: `❌ Failed to start recording: ${error.message}\nPlease check bot permissions and Deepgram configuration.`,
    });
  }
}
