import { Client, GatewayIntentBits, Events } from 'discord.js';
import dotenv from 'dotenv';
import { handleStart } from './commands/start.js';
import { handleStop } from './commands/stop.js';
import { handleSetup } from './commands/setup.js';
import { SessionManager } from './voice/session-manager.js';
import { cleanupSession, formatCleanupMessage } from './session/session-cleanup.js';
import { generateAndDeliverMinutes } from './minutes/generator.js';
import { guildConfigStore } from './config/guild-config-store.js';

dotenv.config();

// ---------------------------------------------------------------------------
// MCP server (optional — enable via env var or --mcp flag)
// ---------------------------------------------------------------------------
//
// MCP lifecycle is handled by src/mcp/bot-integration.js which is loaded via
// a dynamic import *after* the Discord client is ready.  This keeps all MCP
// SDK dependencies out of the core bot startup path so the bot works fully
// without any MCP configuration.
//
// Standalone MCP-only mode (no Discord bot) is handled by the dedicated
// src/mcp-entry.js entry point which uses the lighter stdio transport instead.

/**
 * Handle returned by startBotMcp — used in shutdown() to close the HTTP
 * server and all active SSE sessions cleanly.
 * @type {{ httpServer: import('node:http').Server, close: () => Promise<void> } | null}
 */
let mcpSseHandle = null;

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
  // The SessionManager has already removed the session from its internal map
  // and destroyed the voice connection before emitting this event.
  //
  // For auto-disconnect cases (channel_empty, connection_destroyed) we still
  // need to stop the audio coordinator and generate minutes.
  //
  // For manual_stop the /stop command already ran cleanupSession() before
  // calling stopSession(), so the audio coordinator is already stopped and
  // minutes generation is already in flight — nothing to do here.

  if (reason !== 'channel_empty' && reason !== 'connection_destroyed') return;

  // Shared teardown: stops audio coordinator (Deepgram flush + transcript save).
  // We pass `session` directly because it has already been removed from the
  // SessionManager's internal map by the time this event fires.
  // stopSession() inside cleanupSession() will be a safe no-op.
  const result = await cleanupSession({
    sessionManager,
    guildId: session.guildId,
    reason,
    session,
  });

  // Notify the text channel with a formatted summary
  const guild = client.guilds.cache.get(session.guildId);
  const textChannel = guild?.channels.cache.get(session.textChannelId);
  if (textChannel) {
    const message = formatCleanupMessage(result);
    textChannel.send({ content: message }).catch(console.error);
  }

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
    client,
    reason,
    duration: result.duration,
  }).then((minutesResult) => {
    if (minutesResult.success) {
      console.log(`[SessionEnd] Minutes generated in ${minutesResult.generationTimeMs}ms: ${minutesResult.filePath}`);
    } else {
      console.error(`[SessionEnd] Minutes generation failed: ${minutesResult.error}`);
    }
  }).catch((err) => {
    console.error('[SessionEnd] Minutes pipeline unexpected error:', err);
  });
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

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ dicoclerk is online as ${c.user.tag}`);
  console.log(`   Guilds: ${c.guilds.cache.size}`);

  // Dynamically import the MCP integration module and start the embedded
  // SSE server if enabled.  Dynamic import keeps all MCP SDK code out of the
  // core bot startup path — the bot works fully without any MCP env vars.
  try {
    const { startBotMcp } = await import('./mcp/bot-integration.js');
    mcpSseHandle = await startBotMcp(c, sessionManager);
  } catch (err) {
    console.error('[MCP] Failed to start MCP server:', err);
    // Non-fatal: the Discord bot continues even if MCP fails to bind.
  }
});

// --- Slash command handler ---

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case 'start':
        await handleStart(interaction, sessionManager, guildConfigStore);
        break;
      case 'stop':
        await handleStop(interaction, sessionManager);
        break;
      case 'setup':
        await handleSetup(interaction, guildConfigStore);
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

async function shutdown() {
  console.log('[dicoclerk] Shutting down...');

  // 1. Stop all active voice sessions (flushes transcripts)
  sessionManager.destroyAll();

  // 2. Close the embedded MCP SSE server (drains open HTTP connections)
  if (mcpSseHandle) {
    try {
      await mcpSseHandle.close();
      console.log('[dicoclerk] MCP SSE server closed.');
    } catch (err) {
      console.error('[dicoclerk] Error closing MCP server:', err);
    }
  }

  // 3. Disconnect from Discord
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
