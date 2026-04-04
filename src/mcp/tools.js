/**
 * MCP Tool Registration for dicoclerk
 *
 * Registers all MCP tools that expose dicoclerk functionality
 * to external agents (e.g., Openclaw).
 *
 * Tools:
 *   Session Management:
 *   - start_session: Start a new recording session in a voice channel
 *   - stop_session: Stop an active recording session
 *   - list_sessions: List all active recording sessions
 *
 *   Session Queries:
 *   - get_session: Get details of a specific session
 *   - get_transcript: Get the current transcript for a session
 *   - get_minutes: Get generated meeting minutes for a session
 *   - search_minutes: Search meeting minutes by various criteria
 *
 *   Content Retrieval:
 *   - search_meeting_minutes: Search and retrieve past minutes with full content
 *   - summarize_minutes: Generate condensed contextual summaries from past minutes
 *
 *   Storage Queries:
 *   - list_recordings: List all stored recordings/transcripts
 */
import { z } from 'zod';
import {
  startSession,
  stopSession,
  listSessions,
  getSession,
  getTranscript,
  getMinutes,
  listRecordings,
  searchMinutes,
  searchMeetingMinutes,
  summarizeMinutes,
} from './handlers.js';

/**
 * Register all MCP tools on the server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} deps - App dependencies
 */
export function registerTools(server, deps) {
  // --- Session Management Tools ---

  server.tool(
    'start_session',
    'Start a new voice recording session in a Discord voice channel. Joins the channel, begins STT via Deepgram with speaker diarization, and records a full transcript. Requires the bot to be running (not available in standalone MCP mode).',
    {
      guild_id: z.string().describe('Discord guild (server) ID'),
      voice_channel_id: z.string().describe('Voice channel ID to join and record'),
      text_channel_id: z.string().describe('Text channel ID for status messages and minutes delivery'),
      language: z.enum(['ko', 'en', 'multi']).default('multi').describe('Language for STT: ko (Korean), en (English), or multi (auto-detect Korean+English)'),
    },
    async ({ guild_id, voice_channel_id, text_channel_id, language }) =>
      startSession(deps, guild_id, voice_channel_id, text_channel_id, language)
  );

  server.tool(
    'stop_session',
    'Stop an active recording session. Disconnects from voice, finalizes the transcript, and triggers meeting minutes generation. Minutes are delivered to the text channel as a markdown file within 1-2 minutes.',
    {
      guild_id: z.string().describe('Discord guild (server) ID with an active session'),
    },
    async ({ guild_id }) => stopSession(deps, guild_id)
  );

  server.tool(
    'list_sessions',
    'List all active voice recording sessions across guilds',
    {},
    async () => listSessions(deps)
  );

  server.tool(
    'get_session',
    'Get detailed information about a specific recording session',
    {
      guild_id: z.string().describe('Discord guild (server) ID'),
    },
    async ({ guild_id }) => getSession(deps, guild_id)
  );

  server.tool(
    'get_transcript',
    'Get the live or completed transcript for a recording session',
    {
      guild_id: z.string().describe('Discord guild (server) ID'),
      format: z.enum(['raw', 'formatted']).default('formatted').describe('Transcript output format'),
    },
    async ({ guild_id, format }) => getTranscript(deps, guild_id, format)
  );

  server.tool(
    'get_minutes',
    'Get generated meeting minutes for a completed session',
    {
      guild_id: z.string().describe('Discord guild (server) ID'),
      session_id: z.string().optional().describe('Specific session ID (defaults to latest)'),
    },
    async ({ guild_id, session_id }) => getMinutes(deps, guild_id, session_id)
  );

  server.tool(
    'list_recordings',
    'List all stored recordings and transcripts on disk',
    {
      limit: z.number().default(20).describe('Maximum number of recordings to return'),
      guild_id: z.string().optional().describe('Filter by guild ID'),
    },
    async ({ limit, guild_id }) => listRecordings(deps, limit, guild_id)
  );

  server.tool(
    'search_minutes',
    'Search meeting minutes by date, channel, participant, or free-text query. Returns metadata index entries.',
    {
      query: z.string().optional().describe('Free-text search across channel name, guild, participants'),
      guild_id: z.string().optional().describe('Filter by Discord guild ID'),
      channel_name: z.string().optional().describe('Partial match on voice channel name'),
      participant: z.string().optional().describe('Partial match on participant name'),
      date_from: z.string().optional().describe('Start date filter (YYYY-MM-DD, inclusive)'),
      date_to: z.string().optional().describe('End date filter (YYYY-MM-DD, inclusive)'),
      language: z.string().optional().describe('Filter by language code (ko/en)'),
      limit: z.number().default(20).describe('Maximum results to return'),
      offset: z.number().default(0).describe('Skip first N results for pagination'),
    },
    async (params) => searchMinutes(deps, params)
  );

  server.tool(
    'search_meeting_minutes',
    'Search and retrieve previous meeting minutes with full content. Accepts filters (date range, keywords, participants) and returns matching minutes with their complete markdown content. Use this to find and read past meeting records.',
    {
      query: z.string().optional().describe('Free-text search across metadata fields and minutes content'),
      guild_id: z.string().optional().describe('Filter by Discord guild ID'),
      channel_name: z.string().optional().describe('Partial match on voice channel name'),
      participant: z.string().optional().describe('Partial match on participant name'),
      date_from: z.string().optional().describe('Start date filter (YYYY-MM-DD, inclusive)'),
      date_to: z.string().optional().describe('End date filter (YYYY-MM-DD, inclusive)'),
      keywords: z.array(z.string()).optional().describe('Keywords to search within minutes content (all matched entries contain at least one keyword)'),
      language: z.string().optional().describe('Filter by language code (ko/en)'),
      limit: z.number().default(5).describe('Maximum results to return (default 5, lower due to content size)'),
      offset: z.number().default(0).describe('Skip first N results for pagination'),
      include_content: z.boolean().default(true).describe('Whether to include full markdown content in results (default true)'),
    },
    async (params) => searchMeetingMinutes(deps, params)
  );

  // --- Contextual Summary Tool ---

  server.tool(
    'summarize_minutes',
    'Generate condensed contextual summaries from past meeting minutes. Retrieves minutes matching the given filters and returns structured summaries with key topics, action items, decisions, and a narrative overview. Supports an optional focus_query to bias the summary toward a specific topic. Ideal for agents that need a quick digest of one or more past meetings without reading full transcripts.',
    {
      query: z.string().optional().describe('Free-text search across metadata fields and minutes content'),
      guild_id: z.string().optional().describe('Filter by Discord guild ID'),
      channel_name: z.string().optional().describe('Partial match on voice channel name'),
      participant: z.string().optional().describe('Partial match on participant name'),
      date_from: z.string().optional().describe('Start date filter (YYYY-MM-DD, inclusive)'),
      date_to: z.string().optional().describe('End date filter (YYYY-MM-DD, inclusive)'),
      keywords: z.array(z.string()).optional().describe('Keywords to search within minutes content'),
      language: z.string().optional().describe('Filter by language code (ko/en)'),
      limit: z.number().default(5).describe('Maximum number of meetings to summarize (default 5)'),
      offset: z.number().default(0).describe('Skip first N results for pagination'),
      focus_query: z.string().optional().describe('Focus the summary on a specific topic or keyword — relevant content is prioritized and highlighted'),
      max_topics: z.number().default(5).describe('Maximum key topics per meeting summary'),
      max_action_items: z.number().default(10).describe('Maximum action items per meeting summary'),
      max_narrative_length: z.number().default(500).describe('Maximum character length for the narrative summary per meeting'),
    },
    async (params) => summarizeMinutes(deps, params)
  );
}
