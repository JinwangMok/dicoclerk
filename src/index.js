import { Client, GatewayIntentBits, Events } from 'discord.js';
import dotenv from 'dotenv';
import { handleStart } from './commands/start.js';
import { handleStop } from './commands/stop.js';
import { SessionManager } from './voice/session-manager.js';
import { cleanupSession, formatCleanupMessage } from './session/session-cleanup.js';
import { generateAndDeliverMinutes } from './minutes/generator.js';

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

const sessionManager = new SessionManager();

// --- Session lifecycle events ---

sessionManager.on('sessionEnd', async ({ session, reason, duration }) => {
  // For auto-disconnect cases (channel_empty, connection_destroyed),
  // the SessionManager has already stopped the voice connection via #endSession.
  // We still need to stop the audio coordinator and generate minutes.
  //
  // Note: /stop command handles its own cleanup via cleanupSession() before
  // stopSession() is called, so audioCoordinator will already be stopped
  // for manual_stop. The guard below (isRunning check) prevents double-stop.

  if (reason === 'channel_empty' || reason === 'connection_destroyed') {
    // Stop audio coordinator if still running (auto-disconnect path)
    let transcriptResult = null;
    if (session.audioCoordinator?.isRunning) {
      try {
        transcriptResult = await session.audioCoordinator.stop();
      } catch (err) {
        console.error('[SessionEnd] Audio coordinator stop error:', err);
      }
    }

    const transcriptCount = transcriptResult?.transcript?.length ?? session.transcript?.length ?? 0;
    const transcript = transcriptResult?.transcript ?? session.transcript ?? [];

    // Notify the text channel
    const guild = client.guilds.cache.get(session.guildId);
    const textChannel = guild?.channels.cache.get(session.textChannelId);
    if (textChannel) {
      const minutes = Math.floor(duration / 60);
      const seconds = duration % 60;

      const result = {
        reason,
        durationMinutes: minutes,
        durationSeconds: seconds,
        participantCount: session.participants?.size ?? 0,
        transcriptCount,
        transcriptFilePath: transcriptResult?.filePath ?? null,
        warnings: [],
      };
      const message = formatCleanupMessage(result);
      textChannel.send({ content: message }).catch(console.error);
    }

    // Fire-and-forget: trigger minutes generation
    generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client,
      reason,
      duration,
    }).then((minutesResult) => {
      if (minutesResult.success) {
        console.log(`[SessionEnd] Minutes generated in ${minutesResult.generationTimeMs}ms: ${minutesResult.filePath}`);
      } else {
        console.error(`[SessionEnd] Minutes generation failed: ${minutesResult.error}`);
      }
    }).catch((err) => {
      console.error('[SessionEnd] Minutes pipeline unexpected error:', err);
    });
  }
});

sessionManager.on('connectionLost', ({ guildId, error }) => {
  const session = sessionManager.getSession(guildId);
  if (!session) return;

  const guild = client.guilds.cache.get(guildId);
  const textChannel = guild?.channels.cache.get(session.textChannelId);
  if (textChannel) {
    textChannel
      .send({
        content: `⚠️ Voice connection interrupted. Attempting to reconnect...`,
      })
      .catch(console.error);
  }
});

sessionManager.on('connectionRestore', ({ guildId }) => {
  const session = sessionManager.getSession(guildId);
  if (!session) return;

  const guild = client.guilds.cache.get(guildId);
  const textChannel = guild?.channels.cache.get(session.textChannelId);
  if (textChannel) {
    textChannel
      .send({
        content: `✅ Voice connection restored. Recording continues.`,
      })
      .catch(console.error);
  }
});

sessionManager.on('error', (error) => {
  console.error('[SessionManager] Error:', error.message);
});

// --- Bot ready ---

client.once(Events.ClientReady, (c) => {
  console.log(`✅ dicoclerk is online as ${c.user.tag}`);
  console.log(`   Guilds: ${c.guilds.cache.size}`);
});

// --- Slash command handler ---

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'start':
        await handleStart(interaction, sessionManager);
        break;
      case 'stop':
        await handleStop(interaction, sessionManager);
        break;
      default:
        await interaction.reply({ content: `Unknown command: ${commandName}`, ephemeral: true });
    }
  } catch (error) {
    console.error(`[Command] Error handling /${commandName}:`, error);
    const reply = { content: '❌ An unexpected error occurred.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// --- Auto-disconnect when voice channel becomes empty ---

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  sessionManager.handleVoiceStateUpdate(oldState, newState);
});

// --- Graceful shutdown ---

function shutdown() {
  console.log('[dicoclerk] Shutting down...');
  sessionManager.destroyAll();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Login ---

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is not set. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);

export { client, sessionManager };
