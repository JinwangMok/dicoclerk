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
import { generateContextualSummary, formatSummaryForAgent } from '../minutes/summarizer.js';

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
 * Helper to create an error response.
 */
function errorContent(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
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
 * Get transcript for a session.
 */
export async function getTranscript(deps, guildId, format = 'formatted') {
  if (!guildId) {
    return errorContent('guild_id is required to retrieve a transcript.');
  }

  const { sessionManager } = deps;

  // Try live session first
  if (sessionManager) {
    const session = sessionManager.getSession(guildId);
    if (session?.transcript?.length > 0) {
      if (format === 'raw') {
        return textContent(JSON.stringify({
          guild_id: guildId,
          format: 'raw',
          entry_count: session.transcript.length,
          entries: session.transcript,
        }, null, 2));
      }
      // Formatted: speaker-attributed lines
      const lines = session.transcript.map(entry => {
        const speaker = entry.speaker ?? entry.userId ?? 'Unknown';
        const timestamp = entry.timestamp
          ? new Date(entry.timestamp).toLocaleTimeString()
          : '';
        return `[${timestamp}] ${speaker}: ${entry.text}`;
      });
      return textContent(lines.join('\n'));
    }
  }

  // Fall back to disk
  try {
    const files = await findTranscriptFiles(guildId);
    if (files.length === 0) {
      return errorContent(`No transcript found for guild ${guildId}`);
    }
    // Return the most recent
    const content = await readFile(files[0], 'utf-8');
    return textContent(content);
  } catch (err) {
    return errorContent(`Failed to read transcript: ${err.message}`);
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
    return errorContent(`Failed to search minutes: ${err.message}`);
  }
}

/**
 * List all stored recordings/transcripts.
 */
export async function listRecordings(deps, limit = 20, guildId) {
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
      return textContent(JSON.stringify({
        summaries: [],
        meetingCount: 0,
        message: 'No meeting minutes matched the given filters.',
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

    // 4. Return both structured JSON and an agent-friendly text rendition
    const agentText = formatSummaryForAgent(summaryResult);

    return textContent(JSON.stringify({
      meetingCount: summaryResult.meetingCount,
      generatedAt: summaryResult.generatedAt,
      summaries: summaryResult.summaries,
      crossMeetingSummary: summaryResult.crossMeetingSummary,
      // Compact text rendition — handy when the consuming agent prefers a
      // single block of readable text over structured JSON.
      agentFormattedText: agentText,
    }, null, 2));
  } catch (err) {
    return errorContent(`Failed to summarize minutes: ${err.message}`);
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
