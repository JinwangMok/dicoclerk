/**
 * MCP Tool Handlers for dicoclerk
 *
 * Implements the business logic for each MCP tool.
 * Each handler returns MCP-compliant content responses.
 *
 * Tools are grouped into:
 * - Session management: start_session, stop_session, list_sessions
 * - Session queries: get_session, get_transcript, get_minutes
 * - Storage queries: list_recordings
 */
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { cleanupSession } from '../session/session-cleanup.js';
import { generateAndDeliverMinutes } from '../minutes/generator.js';
import { searchEntries, searchEntriesWithContent, getEntryBySessionId, getLatestEntry } from '../minutes/index-store.js';
import { generateContextualSummary, formatSummaryForAgent, buildAgentDigest, parseMinutesToStructuredData } from '../minutes/summarizer.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  errorContent,
  requireParam,
  validateDate,
  validatePositiveInt,
} from './validator.js';

import { createReadStream, existsSync } from 'fs';

const DATA_DIR = join(process.cwd(), 'data');
const TRANSCRIPTS_DIR = join(DATA_DIR, 'transcripts');
const MINUTES_DIR = join(DATA_DIR, 'minutes');

/**
 * Helper to create a text content response.
 */
function textContent(text) {
  return { content: [{ type: 'text', text }] };
}


/**
 * Join a Discord voice channel and return connection status.
 *
 * This is a lightweight connectivity tool that:
 *   - Returns 'already_connected' if the bot is already in the requested channel
 *     (via an active session).
 *   - Returns 'session_active' if the bot is in a *different* channel for the guild.
 *   - Otherwise joins the channel using VoiceConnectionManager, captures the
 *     connection state, then cleanly disconnects, returning the result.
 *
 * Unlike start_session, this tool does NOT start STT/Deepgram processing.
 * It is intended for agent diagnostics and pre-join connectivity checks.
 *
 * @param {object} deps - { client, sessionManager }
 * @param {string} guildId - Discord guild ID
 * @param {string} channelId - Voice channel ID to join
 */
export async function joinVoiceChannel(deps, guildId, channelId) {
  const { client, sessionManager } = deps;

  if (!client) {
    return errorContent(
      'Cannot join voice channels in standalone MCP mode. ' +
      'The Discord bot must be running (node src/index.js).'
    );
  }

  // Resolve guild
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return errorContent(
      `Guild ${guildId} not found. The bot may not be a member of this guild.`
    );
  }

  // Resolve channel
  const channel = guild.channels.cache.get(channelId);
  if (!channel) {
    return errorContent(
      `Channel ${channelId} not found in guild ${guildId}.`
    );
  }
  if (!channel.isVoiceBased?.()) {
    return errorContent(
      `Channel ${channelId} is not a voice channel.`
    );
  }

  const channelName = channel.name ?? channelId;
  const memberCount = channel.members.filter(m => !m.user.bot).size;

  // Check if there is already an active session for this guild
  if (sessionManager && sessionManager.hasSession(guildId)) {
    const existing = sessionManager.getSession(guildId);
    if (existing.voiceChannelId === channelId) {
      const result = {
        connected: true,
        guild_id: guildId,
        channel_id: channelId,
        channel_name: channelName,
        member_count: memberCount,
        connection_state: 'already_connected',
        session_id: existing.sessionId ?? undefined,
        message: `Bot is already connected to channel "${channelName}" via an active session.`,
      };
      console.log(`[MCP] join_voice_channel: already connected guild=${guildId} channel=${channelId}`);
      return textContent(JSON.stringify(result, null, 2));
    }

    // Active session in a different channel — cannot join
    const result = {
      connected: false,
      guild_id: guildId,
      channel_id: channelId,
      channel_name: channelName,
      member_count: memberCount,
      connection_state: 'session_active',
      message:
        `An active session is already running in channel "${existing.voiceChannelId}" for this guild. ` +
        `Stop it with stop_session before joining a different channel.`,
    };
    console.log(`[MCP] join_voice_channel: session_active in different channel guild=${guildId}`);
    return textContent(JSON.stringify(result, null, 2));
  }

  // No active session — attempt a fresh join for connectivity check
  const { VoiceConnectionManager } = await import('../voice/connection-manager.js');
  const manager = new VoiceConnectionManager({ guildId, channelId, guild });

  try {
    await manager.join();

    const result = {
      connected: true,
      guild_id: guildId,
      channel_id: channelId,
      channel_name: channelName,
      member_count: memberCount,
      connection_state: 'connected',
      message: `Successfully joined voice channel "${channelName}" (${memberCount} human member(s) present).`,
    };

    console.log(`[MCP] join_voice_channel: connected guild=${guildId} channel=${channelId}`);
    return textContent(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = {
      connected: false,
      guild_id: guildId,
      channel_id: channelId,
      channel_name: channelName,
      member_count: memberCount,
      connection_state: 'failed',
      message: `Failed to join voice channel "${channelName}": ${error.message}`,
    };

    console.error(`[MCP] join_voice_channel: failed guild=${guildId} channel=${channelId}:`, error.message);
    return textContent(JSON.stringify(result, null, 2));
  } finally {
    // Always clean up the temporary connection — this tool is a probe, not a session
    try {
      manager.destroy();
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Leave a Discord voice channel: disconnect the bot, finalize any active
 * recording session, and trigger meeting minutes generation.
 *
 * Behaviour matrix:
 *   - No Discord client (standalone MCP mode) → errorContent
 *   - No session and bot not in any voice channel → errorContent
 *   - Active session exists → cleanupSession (stops STT, saves transcript,
 *     disconnects voice) + fires minutes generation pipeline
 *   - Bot connected without a session → raw voice disconnect only
 *
 * Returns a session summary including duration, participant count,
 * transcript count, and minutes generation status.
 *
 * @param {object} deps - { client, sessionManager }
 * @param {string} guildId - Discord guild ID
 */
export async function leaveVoiceChannel(deps, guildId) {
  const { client, sessionManager } = deps;

  if (!client) {
    return errorContent(
      'Cannot leave voice channels in standalone MCP mode. ' +
      'The Discord bot must be running (node src/index.js).'
    );
  }

  if (!sessionManager) {
    return errorContent('Session manager not available.');
  }

  const hasSession = sessionManager.hasSession(guildId);

  // No active session — check if the bot is physically in a voice channel
  if (!hasSession) {
    // Resolve guild to check for bare voice connections
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return errorContent(
        `Guild ${guildId} not found. The bot may not be a member of this guild.`
      );
    }

    // Attempt to destroy any lingering voice connection via @discordjs/voice
    try {
      const { getVoiceConnection } = await import('@discordjs/voice');
      const conn = getVoiceConnection(guildId);
      if (conn) {
        conn.destroy();
        console.log(`[MCP] leave_voice_channel: destroyed bare voice connection guild=${guildId}`);
        const result = {
          disconnected: true,
          guild_id: guildId,
          had_session: false,
          minutes_generation: 'not_applicable',
          message: 'Bot disconnected from voice channel (no active recording session was running).',
        };
        return textContent(JSON.stringify(result, null, 2));
      }
    } catch {
      // @discordjs/voice may not be available in all environments — fall through
    }

    return errorContent(
      `No active session or voice connection found for guild ${guildId}. ` +
      'The bot is not currently in a voice channel for this guild.'
    );
  }

  // Active session — capture session info before cleanup
  const session = sessionManager.getSession(guildId);

  try {
    // Unified teardown: stops audio coordinator (flushes Deepgram buffer,
    // saves transcript to disk) then disconnects voice channel.
    const result = await cleanupSession({
      sessionManager,
      guildId,
      reason: 'manual_stop',
    });

    const response = {
      disconnected: true,
      guild_id: guildId,
      had_session: true,
      session_id: session?.audioCoordinator?.sessionId ?? undefined,
      duration_seconds: result.duration,
      duration_formatted: `${result.durationMinutes}m ${result.durationSeconds}s`,
      participant_count: result.participantCount,
      transcript_count: result.transcriptCount,
      transcript_file: result.transcriptFilePath ?? null,
      minutes_generation: result.transcriptCount > 0 ? 'pending' : 'skipped',
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
      message:
        result.transcriptCount > 0
          ? `Session ended. Transcript saved (${result.transcriptCount} entries). ` +
            'Meeting minutes will be delivered to the text channel within 1-2 minutes.'
          : 'Session ended. No transcript entries recorded — meeting minutes skipped.',
    };

    console.log(
      `[MCP] leave_voice_channel: guild=${guildId} duration=${result.durationMinutes}m${result.durationSeconds}s ` +
      `participants=${result.participantCount} entries=${result.transcriptCount}`
    );

    // Fire-and-forget minutes generation (same as stop_session)
    if (result.transcriptCount > 0 && session) {
      generateAndDeliverMinutes({
        transcript: result.transcript,
        session,
        transcriptResult: {
          transcript: result.transcript,
          filePath: result.transcriptFilePath,
        },
        client,
        reason: 'manual_stop',
        duration: result.duration,
      }).then((minutesResult) => {
        if (minutesResult.success) {
          console.log(
            `[MCP] leave_voice_channel minutes generated in ${minutesResult.generationTimeMs}ms: ${minutesResult.filePath}`
          );
        } else {
          console.error(`[MCP] leave_voice_channel minutes generation failed: ${minutesResult.error}`);
        }
      }).catch((err) => {
        console.error('[MCP] leave_voice_channel minutes pipeline error:', err);
      });
    }

    return textContent(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('[MCP] leave_voice_channel failed:', error);
    return errorContent(`Failed to leave voice channel: ${error.message}`);
  }
}

/**
 * List all active recording sessions.
 */
export async function listSessions(deps) {
  const { sessionManager } = deps;

  if (!sessionManager) {
    return textContent(JSON.stringify({
      sessions: [],
      note: 'No session manager available (standalone MCP mode)',
    }, null, 2));
  }

  const sessions = [];
  // SessionManager stores sessions by guildId
  if (typeof sessionManager.getAllSessions === 'function') {
    for (const [guildId, session] of sessionManager.getAllSessions()) {
      sessions.push({
        guild_id: guildId,
        voice_channel_id: session.voiceChannelId,
        text_channel_id: session.textChannelId,
        started_at: session.startedAt?.toISOString() ?? null,
        participant_count: session.participants?.size ?? 0,
        transcript_count: session.transcript?.length ?? 0,
      });
    }
  }

  return textContent(JSON.stringify({ sessions, count: sessions.length }, null, 2));
}

/**
 * Start a new recording session in a guild's voice channel.
 *
 * Requires the Discord client and session manager to be available.
 * In standalone MCP mode (no Discord client), returns an error.
 *
 * @param {object} deps - { client, sessionManager }
 * @param {string} guildId - Discord guild ID
 * @param {string} voiceChannelId - Voice channel ID to join
 * @param {string} textChannelId - Text channel ID for notifications
 * @param {string} [language='multi'] - Language setting: 'ko', 'en', or 'multi'
 */
export async function startSession(deps, guildId, voiceChannelId, textChannelId, language = 'multi') {
  const { client, sessionManager } = deps;

  if (!client) {
    return errorContent(
      'Cannot start sessions in standalone MCP mode. ' +
      'The Discord bot must be running for session management. ' +
      'Start dicoclerk with the bot enabled (node src/index.js).'
    );
  }

  if (!sessionManager) {
    return errorContent('Session manager not available.');
  }

  // Validate: no active session in this guild
  if (sessionManager.hasSession(guildId)) {
    const existing = sessionManager.getSession(guildId);
    return errorContent(
      `A session is already active in guild ${guildId} ` +
      `(voice channel: ${existing.voiceChannelId}, ` +
      `started at: ${existing.startedAt?.toISOString() ?? 'unknown'}). ` +
      `Use stop_session to end it first.`
    );
  }

  // Validate: Deepgram API key
  if (!process.env.DEEPGRAM_API_KEY) {
    return errorContent(
      'Deepgram API key is not configured. ' +
      'Set DEEPGRAM_API_KEY in the .env file.'
    );
  }

  // Resolve the guild and channels
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return errorContent(
      `Guild ${guildId} not found. ` +
      'The bot may not be a member of this guild.'
    );
  }

  const voiceChannel = guild.channels.cache.get(voiceChannelId);
  if (!voiceChannel) {
    return errorContent(
      `Voice channel ${voiceChannelId} not found in guild ${guildId}.`
    );
  }

  if (!voiceChannel.isVoiceBased?.()) {
    return errorContent(
      `Channel ${voiceChannelId} is not a voice channel.`
    );
  }

  // Validate text channel exists
  const textChannel = guild.channels.cache.get(textChannelId);
  if (!textChannel) {
    return errorContent(
      `Text channel ${textChannelId} not found in guild ${guildId}.`
    );
  }

  try {
    // Start session via session manager (joins voice channel)
    const session = await sessionManager.startSession({
      voiceChannel,
      textChannelId,
      guild,
      language,
      startedBy: 'MCP Agent',
    });

    // Dynamically import AudioSessionCoordinator to avoid circular deps
    const { AudioSessionCoordinator } = await import('../audio/session-coordinator.js');

    // Create audio coordinator for this session
    const coordinator = new AudioSessionCoordinator({
      guildId,
      language,
      sessionId: `${guildId}-${Date.now()}`,
    });

    // Store coordinator on the session
    session.audioCoordinator = coordinator;

    // Get the voice connection
    const connectionManager = sessionManager.getConnectionManager(guildId);
    const voiceConnection = connectionManager?.connection;

    if (!voiceConnection) {
      sessionManager.stopSession(guildId);
      return errorContent('Voice connection not available after joining channel.');
    }

    // Username resolver
    const resolveUsername = async (userId) => {
      try {
        const guildMember = await guild.members.fetch(userId);
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

    // Wire coordinator transcript event to session
    coordinator.on('transcript', (entry) => {
      session.transcript.push(entry);
    });

    // Start audio capture pipeline + Deepgram connection
    await coordinator.start(voiceConnection, resolveUsername);

    const result = {
      success: true,
      guild_id: guildId,
      voice_channel_id: voiceChannelId,
      text_channel_id: textChannelId,
      language,
      session_id: coordinator.sessionId,
      started_at: session.startedAt.toISOString(),
      started_by: 'MCP Agent',
      participants: voiceChannel.members
        .filter(m => !m.user.bot)
        .map(m => ({ user_id: m.id, username: m.displayName })),
    };

    console.log(`[MCP] start_session: guild=${guildId} channel=${voiceChannelId} lang=${language}`);

    return textContent(JSON.stringify(result, null, 2));
  } catch (error) {
    // Clean up on failure
    if (sessionManager.hasSession(guildId)) {
      sessionManager.stopSession(guildId);
    }

    console.error('[MCP] start_session failed:', error);
    return errorContent(`Failed to start session: ${error.message}`);
  }
}

/**
 * Stop an active recording session and trigger minutes generation.
 *
 * Requires the Discord client and session manager to be available.
 * In standalone MCP mode, returns an error.
 *
 * @param {object} deps - { client, sessionManager }
 * @param {string} guildId - Discord guild ID
 */
export async function stopSession(deps, guildId) {
  const { client, sessionManager } = deps;

  if (!client) {
    return errorContent(
      'Cannot stop sessions in standalone MCP mode. ' +
      'The Discord bot must be running for session management.'
    );
  }

  if (!sessionManager) {
    return errorContent('Session manager not available.');
  }

  if (!sessionManager.hasSession(guildId)) {
    return errorContent(`No active session found for guild ${guildId}.`);
  }

  try {
    // Capture session reference before cleanup (needed for minutes generation)
    const session = sessionManager.getSession(guildId);

    if (!session) {
      return errorContent('Session was already stopped.');
    }

    // Use shared cleanup logic (same as /stop command)
    const result = await cleanupSession({
      sessionManager,
      guildId,
      reason: 'manual_stop',
    });

    // Build response
    const response = {
      success: result.success,
      guild_id: guildId,
      reason: result.reason,
      duration_seconds: result.duration,
      duration_formatted: `${result.durationMinutes}m ${result.durationSeconds}s`,
      participant_count: result.participantCount,
      transcript_count: result.transcriptCount,
      transcript_file: result.transcriptFilePath,
      warnings: result.warnings,
      minutes_generation: result.transcriptCount > 0 ? 'pending' : 'skipped',
    };

    console.log(
      `[MCP] stop_session: guild=${guildId} duration=${result.durationMinutes}m${result.durationSeconds}s ` +
      `participants=${result.participantCount} entries=${result.transcriptCount}`
    );

    // Fire-and-forget: trigger minutes generation pipeline
    if (result.transcriptCount > 0) {
      generateAndDeliverMinutes({
        transcript: result.transcript,
        session,
        transcriptResult: {
          transcript: result.transcript,
          filePath: result.transcriptFilePath,
        },
        client,
        reason: 'manual_stop',
        duration: result.duration,
      }).then((minutesResult) => {
        if (minutesResult.success) {
          console.log(`[MCP] stop_session minutes generated in ${minutesResult.generationTimeMs}ms: ${minutesResult.filePath}`);
        } else {
          console.error(`[MCP] stop_session minutes generation failed: ${minutesResult.error}`);
        }
      }).catch((err) => {
        console.error('[MCP] stop_session minutes pipeline error:', err);
      });
    }

    return textContent(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error('[MCP] stop_session failed:', error);
    return errorContent(`Failed to stop session: ${error.message}`);
  }
}

/**
 * Get details of a specific session.
 */
export async function getSession(deps, guildId) {
  const { sessionManager } = deps;

  if (!sessionManager) {
    return errorContent('No session manager available (standalone MCP mode)');
  }

  const session = sessionManager.getSession(guildId);
  if (!session) {
    return errorContent(`No active session found for guild ${guildId}`);
  }

  const details = {
    guild_id: guildId,
    voice_channel_id: session.voiceChannelId,
    text_channel_id: session.textChannelId,
    started_at: session.startedAt?.toISOString() ?? null,
    language: session.language ?? 'multi',
    participant_count: session.participants?.size ?? 0,
    participants: session.participants
      ? Array.from(session.participants.entries()).map(([id, info]) => ({
          user_id: id,
          username: info.username ?? info.displayName ?? 'unknown',
        }))
      : [],
    transcript_count: session.transcript?.length ?? 0,
    is_recording: session.audioCoordinator?.isRunning ?? false,
  };

  return textContent(JSON.stringify(details, null, 2));
}

/**
 * Get system-wide status of the dicoclerk bot and all active sessions.
 *
 * Returns a health snapshot suitable for Openclaw agent consumption:
 *   - bot_mode: 'connected' (Discord bot running) or 'standalone' (MCP-only)
 *   - active_session_count: number of active recording sessions
 *   - sessions: per-guild session summaries with live stats
 *   - system: version, uptime, Deepgram configuration status
 *
 * @param {object} deps - { client, sessionManager }
 * @param {string} [guildId] - If provided, returns status only for that guild
 */
export async function getStatus(deps, guildId) {
  const { client, sessionManager } = deps;
  const botMode = client ? 'connected' : 'standalone';

  const sessions = [];

  if (sessionManager && typeof sessionManager.getAllSessions === 'function') {
    for (const [sid, session] of sessionManager.getAllSessions()) {
      // Filter by guild if requested
      if (guildId && sid !== guildId) continue;

      const audioCoordinator = session.audioCoordinator ?? null;
      const isRecording = audioCoordinator?.isRunning ?? false;

      // Determine Deepgram connection health from coordinator
      let deepgramStatus = 'unavailable';
      if (audioCoordinator) {
        if (audioCoordinator.isRunning) {
          deepgramStatus = 'active';
        } else if (audioCoordinator.hasError) {
          deepgramStatus = 'error';
        } else {
          deepgramStatus = 'idle';
        }
      }

      const startedAt = session.startedAt ? new Date(session.startedAt) : null;
      const durationSeconds = startedAt
        ? Math.round((Date.now() - startedAt.getTime()) / 1000)
        : 0;

      sessions.push({
        guild_id: sid,
        voice_channel_id: session.voiceChannelId ?? null,
        text_channel_id: session.textChannelId ?? null,
        language: session.language ?? 'multi',
        status: session.status ?? 'active',
        started_at: startedAt?.toISOString() ?? null,
        duration_seconds: durationSeconds,
        participant_count: session.participants?.size ?? 0,
        transcript_count: session.transcript?.length ?? 0,
        is_recording: isRecording,
        deepgram_status: deepgramStatus,
      });
    }
  }

  const result = {
    bot_mode: botMode,
    active_session_count: sessions.length,
    sessions,
    system: {
      version: '1.0.0',
      uptime_seconds: Math.round(process.uptime()),
      deepgram_configured: Boolean(process.env.DEEPGRAM_API_KEY),
    },
  };

  if (guildId && sessions.length === 0 && sessionManager) {
    result.note = `No active session found for guild ${guildId}`;
  }

  return textContent(JSON.stringify(result, null, 2));
}

/**
 * Normalize a raw transcript entry (from AudioSessionCoordinator.#transcript or
 * a stored JSON file) into the canonical MCP speaker-diarized entry shape.
 *
 * The coordinator stores entries with camelCase fields; the MCP API uses snake_case
 * to be consistent with other JSON-API consumers.
 *
 * @param {Object} entry - Raw entry from coordinator or disk
 * @param {string} sessionId
 * @returns {Object} MCP-canonical entry
 */
function normalizeEntry(entry, sessionId) {
  // Support both TranscriptSession entry shape (speakerLabel/speakerName/userId/wallClockMs)
  // and legacy coordinator shape (speaker/speakerName/timestamp)
  const speakerLabel = entry.speakerLabel ?? entry.speaker ?? 0;
  const speakerName = entry.speakerName ?? `Speaker ${speakerLabel}`;
  const userId = entry.userId ?? null;
  const wallClockMs = entry.wallClockMs ?? entry.timestamp ?? 0;

  return {
    session_id: entry.sessionId ?? sessionId,
    speaker_label: speakerLabel,
    speaker_name: speakerName,
    user_id: userId,
    text: entry.text ?? '',
    start: entry.start ?? 0,
    end: entry.end ?? 0,
    duration: entry.duration ?? ((entry.end ?? 0) - (entry.start ?? 0)),
    confidence: entry.confidence ?? 0,
    language: entry.language ?? 'unknown',
    is_final: entry.isFinal ?? true,
    wall_clock_ms: wallClockMs,
  };
}

/**
 * Build the raw structured JSON response for get_transcript.
 *
 * @param {string} sessionId
 * @param {string} guildId
 * @param {'live'|'stored'} status
 * @param {Object[]} rawEntries - Raw transcript entries (from coordinator or disk)
 * @returns {object} MCP text content response
 */
function buildRawResponse(sessionId, guildId, status, rawEntries) {
  const entries = rawEntries.map(e => normalizeEntry(e, sessionId));
  const uniqueSpeakers = new Set(entries.map(e => e.speaker_label));
  const langs = [...new Set(entries.map(e => e.language).filter(l => l !== 'unknown'))];

  const payload = {
    session_id: sessionId,
    guild_id: guildId,
    format: 'raw',
    status,
    entry_count: entries.length,
    speaker_count: uniqueSpeakers.size,
    language: langs.length === 1 ? langs[0] : langs.join('+') || 'unknown',
    entries,
  };
  return textContent(JSON.stringify(payload, null, 2));
}

/**
 * Build the formatted (human-readable) text response for get_transcript.
 * Reuses normalizeEntry for consistent speaker name resolution across both formats.
 *
 * @param {string} sessionId
 * @param {string} guildId
 * @param {'live'|'stored'} status
 * @param {Object[]} rawEntries
 * @returns {object} MCP text content response
 */
function buildFormattedResponse(sessionId, guildId, status, rawEntries) {
  if (rawEntries.length === 0) {
    return textContent(`# Transcript — ${sessionId}\nGuild: ${guildId} | Status: ${status}\n\n(No transcript entries yet)`);
  }

  const lines = rawEntries.map(entry => {
    // Reuse normalizeEntry for consistent speaker name resolution (handles all legacy shapes)
    const normalized = normalizeEntry(entry, sessionId);
    const mm = String(Math.floor(normalized.start / 60)).padStart(2, '0');
    const ss = String(Math.floor(normalized.start % 60)).padStart(2, '0');
    return `[${mm}:${ss}] ${normalized.speaker_name}: ${normalized.text}`;
  });

  const header = [
    `# Transcript — ${sessionId}`,
    `Guild: ${guildId} | Status: ${status} | Entries: ${rawEntries.length}`,
    '',
  ].join('\n');

  return textContent(header + lines.join('\n'));
}

/**
 * Get transcript for a session.
 *
 * Lookup order:
 *  1. If session_id is provided (and not "current"): find the stored JSON file on disk
 *     matching transcript-{session_id}.json, parse and return.
 *  2. If guild_id is provided and there is an active session: return live in-memory
 *     transcript from the AudioSessionCoordinator's TranscriptSession.
 *  3. Fallback: scan disk for any transcript file matching the guild_id and return
 *     the most recent one.
 *
 * @param {object} deps - { sessionManager }
 * @param {string} guildId - Discord guild (server) ID
 * @param {string|undefined} sessionId - Specific session ID, or "current" for active session
 * @param {'raw'|'formatted'} format - Output format
 */
export async function getTranscript(deps, guildId, sessionId, format = 'formatted') {
  if (!guildId && (!sessionId || sessionId === 'current')) {
    return errorContent('guild_id is required when session_id is omitted or "current".');
  }

  const { sessionManager } = deps;

  // Normalize "current" alias: treat as no session_id
  const lookupSessionId = (sessionId && sessionId !== 'current') ? sessionId : null;

  // ── Path 1: specific session_id → read from disk ────────────────────────────
  if (lookupSessionId) {
    const specificFile = join(TRANSCRIPTS_DIR, `transcript-${lookupSessionId}.json`);
    try {
      const raw = await readFile(specificFile, 'utf-8');
      const data = JSON.parse(raw);
      const entries = data.transcript ?? [];
      const storedGuildId = data.guildId ?? guildId;

      if (format === 'raw') {
        return buildRawResponse(lookupSessionId, storedGuildId, 'stored', entries);
      }
      return buildFormattedResponse(lookupSessionId, storedGuildId, 'stored', entries);
    } catch (err) {
      if (err.code === 'ENOENT') {
        // Try fallback file
        const fallbackFile = join(TRANSCRIPTS_DIR, `transcript-${lookupSessionId}-fallback.json`);
        try {
          const raw = await readFile(fallbackFile, 'utf-8');
          const data = JSON.parse(raw);
          const entries = data.transcript ?? [];
          const storedGuildId = data.guildId ?? guildId;
          if (format === 'raw') {
            return buildRawResponse(lookupSessionId, storedGuildId, 'stored', entries);
          }
          return buildFormattedResponse(lookupSessionId, storedGuildId, 'stored', entries);
        } catch {
          return errorContent(
            `No transcript found for session_id "${lookupSessionId}". ` +
            `Checked: transcript-${lookupSessionId}.json and transcript-${lookupSessionId}-fallback.json`
          );
        }
      }
      return errorContent(`Failed to read transcript for session "${lookupSessionId}": ${err.message}`);
    }
  }

  // ── Path 2: active in-memory session (guild_id, no session_id or session_id="current") ─
  if (sessionManager) {
    const session = sessionManager.getSession(guildId);
    if (session) {
      // Prefer the rich TranscriptSession from AudioSessionCoordinator (speaker-attributed, deduped)
      const transcriptSession = session.audioCoordinator?.transcriptSession;
      if (transcriptSession && transcriptSession.entryCount > 0) {
        const entries = transcriptSession.toStructuredData();
        const activeSessionId = session.audioCoordinator?.sessionId ?? `${guildId}-live`;
        if (format === 'raw') {
          return buildRawResponse(activeSessionId, guildId, 'live', entries);
        }
        return buildFormattedResponse(activeSessionId, guildId, 'live', entries);
      }

      // Fall back to coordinator's raw transcript array
      const coordinatorTranscript = session.audioCoordinator?.transcript ?? [];
      if (coordinatorTranscript.length > 0) {
        const activeSessionId = session.audioCoordinator?.sessionId ?? `${guildId}-live`;
        if (format === 'raw') {
          return buildRawResponse(activeSessionId, guildId, 'live', coordinatorTranscript);
        }
        return buildFormattedResponse(activeSessionId, guildId, 'live', coordinatorTranscript);
      }

      // Session exists but no transcript entries yet
      const activeSessionId = session.audioCoordinator?.sessionId ?? `${guildId}-live`;
      if (format === 'raw') {
        return textContent(JSON.stringify({
          session_id: activeSessionId,
          guild_id: guildId,
          format: 'raw',
          status: 'live',
          entry_count: 0,
          speaker_count: 0,
          language: 'unknown',
          entries: [],
        }, null, 2));
      }
      return textContent(
        `# Transcript — ${activeSessionId}\nGuild: ${guildId} | Status: live\n\n` +
        `(Session is active but no transcript entries yet — speaking may not have started)`
      );
    }
  }

  // ── Path 3: no active session → scan disk for most recent transcript for guild ─
  try {
    const files = await findTranscriptFiles(guildId);
    if (files.length === 0) {
      return errorContent(
        `No transcript found for guild ${guildId}. ` +
        `No active session is running and no stored transcripts exist.`
      );
    }
    // Use the most recent file
    const raw = await readFile(files[0], 'utf-8');
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // File exists but is not valid JSON — return raw text for formatted, error for raw
      if (format === 'formatted') return textContent(raw);
      return errorContent('Most recent transcript file is not valid JSON. Use format="formatted" to read it as plain text.');
    }

    const entries = data.transcript ?? [];
    const storedSessionId = data.sessionId ?? `${guildId}-unknown`;
    const storedGuildId = data.guildId ?? guildId;

    if (format === 'raw') {
      return buildRawResponse(storedSessionId, storedGuildId, 'stored', entries);
    }
    return buildFormattedResponse(storedSessionId, storedGuildId, 'stored', entries);
  } catch (err) {
    return errorContent(`Failed to retrieve transcript for guild ${guildId}: ${err.message}`);
  }
}

/**
 * Get meeting minutes for a session.
 * Uses the minutes index for fast lookup by session ID, falling back to
 * file-system scan if the index doesn't have a match.
 */
export async function getMinutes(deps, guildId, sessionId) {
  if (!guildId && !sessionId) {
    return errorContent('At least one of guild_id or session_id is required to retrieve minutes.');
  }

  try {
    // --- Try index-based lookup first ---
    if (sessionId) {
      const entry = await getEntryBySessionId(sessionId);
      if (entry) {
        try {
          const content = await readFile(entry.filePath, 'utf-8');
          return textContent(content);
        } catch {
          // File missing on disk — fall through to filesystem scan
        }
      }
    } else if (guildId) {
      // Get latest for guild via index
      const entry = await getLatestEntry(guildId);
      if (entry) {
        try {
          const content = await readFile(entry.filePath, 'utf-8');
          return textContent(content);
        } catch {
          // Fall through
        }
      }
    }

    // --- Fallback: filesystem scan ---
    const minutesDir = MINUTES_DIR;
    let files;
    try {
      files = await readdir(minutesDir);
    } catch {
      return errorContent('No minutes directory found. No meetings have been recorded yet.');
    }

    // Filter .md files (exclude index.json)
    let matching = files.filter(f => f.endsWith('.md'));

    // Filter by guild if provided
    if (guildId) {
      matching = matching.filter(f => f.includes(guildId));
    }

    // Filter by session ID if provided
    if (sessionId) {
      matching = matching.filter(f => f.includes(sessionId));
    }

    if (matching.length === 0) {
      return errorContent(`No minutes found${guildId ? ` for guild ${guildId}` : ''}${sessionId ? ` session ${sessionId}` : ''}`);
    }

    // Sort by name (which includes timestamp) descending to get latest
    matching.sort().reverse();
    const filePath = join(minutesDir, matching[0]);
    const content = await readFile(filePath, 'utf-8');

    return textContent(content);
  } catch (err) {
    return errorContent(`Failed to read minutes: ${err.message}`);
  }
}

/**
 * Search meeting minutes using the index.
 * Supports filtering by date range, channel, participant, guild, language,
 * and free-text query.
 */
export async function searchMinutes(deps, params) {
  // Semantic validation — throw McpError(InvalidParams) on bad inputs
  validateDate(params.date_from, 'date_from');
  validateDate(params.date_to, 'date_to');
  validatePositiveInt(params.limit, 'limit', { min: 1, max: 100 });
  validatePositiveInt(params.offset, 'offset', { min: 0, max: undefined });

  try {
    const result = await searchEntries({
      query: params.query,
      guildId: params.guild_id,
      channelName: params.channel_name,
      participant: params.participant,
      dateFrom: params.date_from,
      dateTo: params.date_to,
      language: params.language,
      limit: params.limit ?? 20,
      offset: params.offset ?? 0,
    });

    return textContent(JSON.stringify({
      minutes: result.entries.map(e => ({
        session_id: e.sessionId,
        date: e.date,
        time: e.time,
        duration_seconds: e.durationSeconds,
        guild_name: e.guildName,
        channel_name: e.channelName,
        participants: e.participants,
        participant_count: e.participantCount,
        transcript_count: e.transcriptCount,
        language: e.language,
        started_by: e.startedBy,
        filename: e.filename,
      })),
      total: result.total,
      showing: result.showing,
    }, null, 2));
  } catch (err) {
    if (err instanceof McpError) throw err; // re-propagate protocol-level errors
    return errorContent(`Failed to search minutes: ${err.message}`);
  }
}

/**
 * List all stored recordings/transcripts.
 */
export async function listRecordings(deps, limit = 20, guildId) {
  validatePositiveInt(limit, 'limit', { min: 1, max: 100 });
  const results = [];

  // Scan transcripts directory
  try {
    const files = await readdir(TRANSCRIPTS_DIR);
    for (const file of files) {
      if (guildId && !file.includes(guildId)) continue;

      const filePath = join(TRANSCRIPTS_DIR, file);
      try {
        const stats = await stat(filePath);
        results.push({
          type: 'transcript',
          filename: file,
          size_bytes: stats.size,
          created_at: stats.birthtime.toISOString(),
          modified_at: stats.mtime.toISOString(),
        });
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Transcripts dir may not exist yet
  }

  // Scan minutes directory
  try {
    const files = await readdir(MINUTES_DIR);
    for (const file of files) {
      if (guildId && !file.includes(guildId)) continue;

      const filePath = join(MINUTES_DIR, file);
      try {
        const stats = await stat(filePath);
        results.push({
          type: 'minutes',
          filename: file,
          size_bytes: stats.size,
          created_at: stats.birthtime.toISOString(),
          modified_at: stats.mtime.toISOString(),
        });
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Minutes dir may not exist yet
  }

  // Sort by modified_at descending
  results.sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));

  const limited = results.slice(0, limit);

  return textContent(JSON.stringify({
    recordings: limited,
    total: results.length,
    showing: limited.length,
  }, null, 2));
}

/**
 * Search meeting minutes with full content retrieval.
 * Accepts filters (date range, keywords, participants) and returns
 * matching minutes with their full markdown content.
 *
 * @param {object} deps - App dependencies
 * @param {object} params - Search parameters
 * @param {string} [params.query] - Free-text search across metadata and content
 * @param {string} [params.guild_id] - Filter by Discord guild ID
 * @param {string} [params.channel_name] - Partial match on voice channel name
 * @param {string} [params.participant] - Partial match on participant name
 * @param {string} [params.date_from] - Start date filter (YYYY-MM-DD, inclusive)
 * @param {string} [params.date_to] - End date filter (YYYY-MM-DD, inclusive)
 * @param {string[]} [params.keywords] - Keywords to search within minutes content
 * @param {string} [params.language] - Filter by language code (ko/en)
 * @param {number} [params.limit] - Maximum results to return (default 5)
 * @param {number} [params.offset] - Skip first N results for pagination
 * @param {boolean} [params.include_content] - Whether to include full content (default true)
 */
export async function searchMeetingMinutes(deps, params) {
  // Semantic validation — throw McpError(InvalidParams) on bad inputs
  validateDate(params.date_from, 'date_from');
  validateDate(params.date_to, 'date_to');
  validatePositiveInt(params.limit, 'limit', { min: 1, max: 50 });
  validatePositiveInt(params.offset, 'offset', { min: 0, max: undefined });

  try {
    const result = await searchEntriesWithContent({
      query: params.query,
      guildId: params.guild_id,
      channelName: params.channel_name,
      participant: params.participant,
      dateFrom: params.date_from,
      dateTo: params.date_to,
      keywords: params.keywords,
      language: params.language,
      limit: params.limit ?? 5,
      offset: params.offset ?? 0,
      includeContent: params.include_content !== false,
    });

    return textContent(JSON.stringify({
      results: result.entries.map(e => ({
        session_id: e.sessionId,
        date: e.date,
        time: e.time,
        duration_seconds: e.durationSeconds,
        guild_name: e.guildName,
        channel_name: e.channelName,
        participants: e.participants,
        participant_count: e.participantCount,
        transcript_count: e.transcriptCount,
        language: e.language,
        started_by: e.startedBy,
        filename: e.filename,
        ...(e.matchedKeywords ? { matched_keywords: e.matchedKeywords } : {}),
        ...(e.content ? { content: e.content } : {}),
      })),
      total: result.total,
      showing: result.showing,
    }, null, 2));
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorContent(`Failed to search meeting minutes: ${err.message}`);
  }
}

/**
 * Summarize meeting minutes — retrieve past minutes matching filters and
 * return condensed contextual summaries optimised for agent consumption.
 *
 * Supports the same search filters as searchMeetingMinutes, plus summary-
 * specific options (focus_query, max_topics, max_action_items).
 *
 * @param {object} deps - App dependencies
 * @param {object} params - Search + summary parameters
 */
export async function summarizeMinutes(deps, params) {
  // Semantic validation — throws McpError(-32602) for invalid params.
  // The MCP SDK converts this to a JSON-RPC error response for the caller.
  validateDate(params.date_from, 'date_from');
  validateDate(params.date_to, 'date_to');
  validatePositiveInt(params.limit, 'limit', { min: 1, max: 20 });
  validatePositiveInt(params.offset, 'offset', { min: 0, max: undefined });
  validatePositiveInt(params.max_topics, 'max_topics', { min: 1, max: 20 });
  validatePositiveInt(params.max_action_items, 'max_action_items', { min: 1, max: 50 });
  validatePositiveInt(params.max_narrative_length, 'max_narrative_length', { min: 50, max: 2000 });

  try {
    // 1. Retrieve matching minutes with content
    const searchResult = await searchEntriesWithContent({
      query: params.query,
      guildId: params.guild_id,
      channelName: params.channel_name,
      participant: params.participant,
      dateFrom: params.date_from,
      dateTo: params.date_to,
      keywords: params.keywords,
      language: params.language,
      limit: params.limit ?? 5,
      offset: params.offset ?? 0,
      includeContent: true, // always need content for summarisation
    });

    if (searchResult.entries.length === 0) {
      const emptyResult = { meetingCount: 0, summaries: [], crossMeetingSummary: null, generatedAt: new Date().toISOString() };
      return textContent(JSON.stringify({
        summaries: [],
        meetingCount: 0,
        message: 'No meeting minutes matched the given filters.',
        agentFormattedText: '# Meeting Minutes Summary (0 meeting(s))\n\nNo records found.',
        agentDigest: buildAgentDigest(emptyResult),
      }, null, 2));
    }

    // 2. Build input array for summariser
    const minutesWithContent = searchResult.entries
      .filter(e => e.content) // skip entries without content
      .map(e => ({ entry: e, content: e.content }));

    if (minutesWithContent.length === 0) {
      return errorContent('Matching minutes were found in the index but their files could not be read from disk.');
    }

    // 3. Generate contextual summaries
    const summaryResult = generateContextualSummary(minutesWithContent, {
      maxTopics: params.max_topics ?? 5,
      maxActionItems: params.max_action_items ?? 10,
      maxNarrativeLength: params.max_narrative_length ?? 500,
      includeCrossSummary: minutesWithContent.length > 1,
      focusQuery: params.focus_query ?? null,
    });

    // 4. Return structured JSON, a Markdown text rendition, and a compact agent digest
    const agentText = formatSummaryForAgent(summaryResult);
    const agentDigest = buildAgentDigest(summaryResult, {
      focusQuery: params.focus_query ?? null,
      maxActionItems: (params.max_action_items ?? 10) * 2,
      maxDecisions: 15,
      maxTopics: (params.max_topics ?? 5) * 2,
    });

    return textContent(JSON.stringify({
      meetingCount: summaryResult.meetingCount,
      generatedAt: summaryResult.generatedAt,
      summaries: summaryResult.summaries,
      crossMeetingSummary: summaryResult.crossMeetingSummary,
      // Full Markdown rendition — for human-readable display or verbose agent use.
      agentFormattedText: agentText,
      // Compact, token-efficient digest — preferred for Openclaw agent context windows.
      agentDigest,
    }, null, 2));
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorContent(`Failed to summarize minutes: ${err.message}`);
  }
}

/**
 * Retrieve stored meeting minutes as fully structured data.
 *
 * Accepts query parameters to filter by session ID, date range, guild,
 * channel, participant, and keywords.  Returns each matching minutes file
 * parsed into structured JSON — not raw markdown — making it suitable for
 * programmatic consumption by agents or APIs.
 *
 * Returned structure per result:
 *   - Meeting metadata (session_id, date, time, duration, guild, channel,
 *     participants, language, started_by, filename)
 *   - structured_content:
 *       summary            – text of the summary/overview section
 *       key_discussion_points – array of discussion topic strings
 *       action_items       – array of { task, assignee, deadline }
 *       decisions          – array of decision strings
 *       attendees          – array of { name, role, utterance_count }
 *       statistics         – utterance count, section count, duration, etc.
 *       transcript         – (optional) array of { timestamp, speaker, text }
 *   - raw_markdown         – (optional) full markdown source
 *
 * @param {object} deps - App dependencies (not used; reads from disk/index)
 * @param {object} params - Query parameters
 * @param {string} [params.session_id]   - Retrieve a specific session by ID
 * @param {string} [params.query]        - Free-text search across metadata/content
 * @param {string} [params.guild_id]     - Filter by Discord guild ID
 * @param {string} [params.channel_name] - Partial match on channel name
 * @param {string} [params.participant]  - Partial match on participant name
 * @param {string} [params.date_from]    - Start date (YYYY-MM-DD, inclusive)
 * @param {string} [params.date_to]      - End date (YYYY-MM-DD, inclusive)
 * @param {string[]} [params.keywords]   - Keywords to search in content
 * @param {string} [params.language]     - Language code filter (ko/en)
 * @param {number} [params.limit]        - Max results (default 5)
 * @param {number} [params.offset]       - Pagination offset (default 0)
 * @param {boolean} [params.include_transcript]   - Include transcript entries (default false)
 * @param {boolean} [params.include_raw_markdown] - Include raw markdown (default false)
 */
export async function getPreviousMinutes(deps, params) {
  try {
    // If a specific session_id is provided, try direct index lookup first
    if (params.session_id) {
      const entry = await getEntryBySessionId(params.session_id);
      if (entry) {
        try {
          const content = await readFile(entry.filePath, 'utf-8');
          const structured = parseMinutesToStructuredData(entry, content, {
            includeTranscript: params.include_transcript ?? false,
            includeRawMarkdown: params.include_raw_markdown ?? false,
          });
          return textContent(JSON.stringify({
            results: [structured],
            total: 1,
            showing: 1,
          }, null, 2));
        } catch {
          return errorContent(`Minutes file for session ${params.session_id} not found on disk.`);
        }
      }
      return errorContent(`No minutes found for session_id: ${params.session_id}`);
    }

    // General search using the index
    const result = await searchEntriesWithContent({
      query: params.query,
      guildId: params.guild_id,
      channelName: params.channel_name,
      participant: params.participant,
      dateFrom: params.date_from,
      dateTo: params.date_to,
      keywords: params.keywords,
      language: params.language,
      limit: params.limit ?? 5,
      offset: params.offset ?? 0,
      includeContent: true,
    });

    const structured = result.entries
      .filter(e => e.content)
      .map(e => parseMinutesToStructuredData(e, e.content, {
        includeTranscript: params.include_transcript ?? false,
        includeRawMarkdown: params.include_raw_markdown ?? false,
      }));

    return textContent(JSON.stringify({
      results: structured,
      total: result.total,
      showing: structured.length,
    }, null, 2));
  } catch (err) {
    return errorContent(`Failed to retrieve previous minutes: ${err.message}`);
  }
}

/**
 * Find transcript files for a guild, sorted by recency (newest first).
 */
async function findTranscriptFiles(guildId) {
  try {
    const files = await readdir(TRANSCRIPTS_DIR);
    const matching = files
      .filter(f => f.includes(guildId))
      .map(f => join(TRANSCRIPTS_DIR, f));

    // Sort by modification time descending
    const withStats = await Promise.all(
      matching.map(async f => {
        const stats = await stat(f);
        return { path: f, mtime: stats.mtime };
      })
    );
    withStats.sort((a, b) => b.mtime - a.mtime);
    return withStats.map(f => f.path);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Whisper batch STT
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio file using the Whisper API (batch mode).
 *
 * @param {object} _deps - App dependencies (unused for this tool)
 * @param {string} filePath - Absolute path to the audio file
 * @param {string} [language] - Language hint (ko, en, multi)
 * @param {string} [model] - Whisper model name
 */
export async function transcribeAudioFile(_deps, filePath, language, model) {
  const apiUrl = process.env.WHISPER_API_URL
    || 'https://stt.agentic-ai-gist.org/stt/v1/audio/transcriptions';
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: 'CF-Access credentials not configured. Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in .env',
      }) }],
    };
  }

  // Validate file exists
  const { existsSync } = await import('fs');
  const { stat: statAsync } = await import('fs/promises');

  if (!existsSync(filePath)) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        error: `File not found: ${filePath}`,
      }) }],
    };
  }

  const fileStats = await statAsync(filePath);
  const fileSizeMB = fileStats.size / (1024 * 1024);

  try {
    // Build multipart form data using Node.js built-in Blob/File
    const { readFile: readFileAsync } = await import('fs/promises');
    const fileBuffer = await readFileAsync(filePath);
    const { basename } = await import('path');
    const fileName = basename(filePath);

    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), fileName);
    formData.append('model', model || 'large-v3-turbo');
    if (language && language !== 'multi') {
      formData.append('language', language);
    }

    // Timeout: conservative 4x estimate based on ~3x processing time
    const estimatedDurationSec = fileSizeMB * 10; // rough: 1MB ≈ 10s audio
    const timeoutMs = Math.max(60_000, estimatedDurationSec * 4 * 1000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
        'User-Agent': 'dicoclerk/1.0',
      },
      body: formData,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: `Whisper API returned ${response.status}: ${body}`,
        }) }],
      };
    }

    const result = await response.json();

    return {
      content: [{ type: 'text', text: JSON.stringify({
        text: result.text || '',
        language: result.language || 'unknown',
        duration: result.duration || null,
        processing_time: result.processing_time || null,
        file_path: filePath,
        file_size_mb: Math.round(fileSizeMB * 100) / 100,
        model: model || 'large-v3-turbo',
      }) }],
    };
  } catch (err) {
    const message = err.name === 'AbortError'
      ? `Whisper API request timed out (file: ${fileSizeMB.toFixed(1)}MB)`
      : `Whisper API error: ${err.message}`;
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    };
  }
}
