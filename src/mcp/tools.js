/**
 * MCP Tool Registration for dicoclerk
 *
 * Registers all MCP tools that expose dicoclerk functionality
 * to external agents (e.g., Openclaw).
 *
 * All input shapes are imported from ./schemas.js — the single source
 * of truth for both tool registration and programmatic validation.
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
 *
 *   System:
 *   - get_status: Get system-wide bot status and active session health
 */
import {
  JOIN_VOICE_CHANNEL_SHAPE,
  LEAVE_VOICE_CHANNEL_SHAPE,
  START_SESSION_SHAPE,
  STOP_SESSION_SHAPE,
  LIST_SESSIONS_SHAPE,
  GET_SESSION_SHAPE,
  GET_STATUS_SHAPE,
  GET_TRANSCRIPT_SHAPE,
  GET_MINUTES_SHAPE,
  LIST_RECORDINGS_SHAPE,
  SEARCH_MINUTES_SHAPE,
  SEARCH_MEETING_MINUTES_SHAPE,
  SUMMARIZE_MINUTES_SHAPE,
  GET_MEETING_MINUTES_SHAPE,
  TRANSCRIBE_AUDIO_FILE_SHAPE,
} from './schemas.js';
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  startSession,
  stopSession,
  listSessions,
  getSession,
  getStatus,
  getTranscript,
  getMinutes,
  listRecordings,
  searchMinutes,
  searchMeetingMinutes,
  summarizeMinutes,
  getPreviousMinutes,
  transcribeAudioFile,
} from './handlers.js';

/**
 * Register all MCP tools on the server.
 *
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 * @param {object} deps - App dependencies
 */
export function registerTools(server, deps) {
  // --- Voice Channel Tools ---

  server.tool(
    'join_voice_channel',
    'Join a Discord voice channel and return connection status. Use this as a lightweight connectivity probe to verify the bot can reach a specific channel before starting a recording session. Returns the channel name, human member count, and a connection_state of "connected", "already_connected" (bot is already in that channel via an active session), "session_active" (bot is in a different channel), or "failed". Does NOT start STT or Deepgram processing.',
    JOIN_VOICE_CHANNEL_SHAPE,
    async ({ guild_id, channel_id }) => joinVoiceChannel(deps, guild_id, channel_id)
  );

  server.tool(
    'leave_voice_channel',
    'Disconnect the bot from the voice channel for a guild. If a recording session is active, it is stopped gracefully: the Deepgram STT stream is flushed, the transcript is saved to disk, and meeting minutes generation is triggered (delivered to the text channel within 1-2 minutes). Returns a session summary with duration, participant count, transcript count, and minutes generation status. Use this to cleanly end a session initiated by start_session or triggered via /start. Requires the Discord bot to be running.',
    LEAVE_VOICE_CHANNEL_SHAPE,
    async ({ guild_id }) => leaveVoiceChannel(deps, guild_id)
  );

  // --- Session Management Tools ---

  server.tool(
    'start_session',
    'Start a new voice recording session in a Discord voice channel. Joins the channel, begins STT via Deepgram with speaker diarization, and records a full transcript. Requires the bot to be running (not available in standalone MCP mode).',
    START_SESSION_SHAPE,
    async ({ guild_id, voice_channel_id, text_channel_id, language }) =>
      startSession(deps, guild_id, voice_channel_id, text_channel_id, language)
  );

  server.tool(
    'stop_session',
    'Stop an active recording session. Disconnects from voice, finalizes the transcript, and triggers meeting minutes generation. Minutes are delivered to the text channel as a markdown file within 1-2 minutes.',
    STOP_SESSION_SHAPE,
    async ({ guild_id }) => stopSession(deps, guild_id)
  );

  server.tool(
    'list_sessions',
    'List all active voice recording sessions across guilds',
    LIST_SESSIONS_SHAPE,
    async () => listSessions(deps)
  );

  server.tool(
    'get_session',
    'Get detailed information about a specific recording session',
    GET_SESSION_SHAPE,
    async ({ guild_id }) => getSession(deps, guild_id)
  );

  server.tool(
    'get_status',
    'Get the current system status of the dicoclerk bot. Returns bot mode (connected/standalone), all active recording sessions with their live stats (participants, transcript count, recording state, Deepgram connection health), and system info (version, uptime, Deepgram configuration). Use this to check if any sessions are active before issuing start_session or stop_session commands.',
    GET_STATUS_SHAPE,
    async ({ guild_id } = {}) => getStatus(deps, guild_id)
  );

  server.tool(
    'get_transcript',
    'Retrieve the full transcript for a recording session with speaker diarization. ' +
    'Supply guild_id to get the current active session, or session_id for a specific stored session ' +
    '(use "current" as session_id alias for the active session). ' +
    'format="raw" returns structured JSON with speaker_label, speaker_name, user_id, text, start/end ' +
    'timestamps, confidence, and language per entry. ' +
    'format="formatted" (default) returns a human-readable speaker-attributed text transcript.',
    GET_TRANSCRIPT_SHAPE,
    async ({ guild_id, session_id, format }) => getTranscript(deps, guild_id, session_id, format)
  );

  server.tool(
    'get_minutes',
    'Get generated meeting minutes for a completed session',
    GET_MINUTES_SHAPE,
    async ({ guild_id, session_id }) => getMinutes(deps, guild_id, session_id)
  );

  server.tool(
    'list_recordings',
    'List all stored recordings and transcripts on disk',
    LIST_RECORDINGS_SHAPE,
    async ({ limit, guild_id }) => listRecordings(deps, limit, guild_id)
  );

  server.tool(
    'search_minutes',
    'Search meeting minutes by date, channel, participant, or free-text query. Returns metadata index entries.',
    SEARCH_MINUTES_SHAPE,
    async (params) => searchMinutes(deps, params)
  );

  server.tool(
    'search_meeting_minutes',
    'Search and retrieve previous meeting minutes with full content. Accepts filters (date range, keywords, participants) and returns matching minutes with their complete markdown content. Use this to find and read past meeting records.',
    SEARCH_MEETING_MINUTES_SHAPE,
    async (params) => searchMeetingMinutes(deps, params)
  );

  // --- Contextual Summary Tool ---

  server.tool(
    'summarize_minutes',
    'Generate condensed contextual summaries from past meeting minutes. Retrieves minutes matching the given filters and returns structured summaries with key topics, action items, decisions, and a narrative overview. Supports an optional focus_query to bias the summary toward a specific topic. Ideal for agents that need a quick digest of one or more past meetings without reading full transcripts.',
    SUMMARIZE_MINUTES_SHAPE,
    async (params) => summarizeMinutes(deps, params)
  );

  // --- Structured Minutes Retrieval Tool ---

  server.tool(
    'get_meeting_minutes',
    'Retrieve stored meeting minutes as fully structured JSON data. Accepts optional filters for session ID, date range (date_from/date_to in YYYY-MM-DD format), channel name, participant, guild, keywords, and language. Returns each matching minutes file parsed into structured fields: summary, key_discussion_points, action_items (with task/assignee/deadline), decisions, attendees, and statistics. Optionally includes raw_markdown or full transcript entries. Results are ordered newest-first and support limit/offset pagination. Use this to programmatically access and analyse past meeting records without reading raw markdown.',
    GET_MEETING_MINUTES_SHAPE,
    async (params) => getPreviousMinutes(deps, params)
  );

  // --- Whisper Batch STT Tool ---

  server.tool(
    'transcribe_audio_file',
    'Transcribe an audio file using the Whisper API (batch mode). Accepts a file path to an audio file (wav, mp3, ogg, webm, m4a) and returns the transcribed text with language detection and timing info. Uses the external Whisper API configured via WHISPER_API_URL with Cloudflare Access authentication. Processing time is approximately 3x the audio duration.',
    TRANSCRIBE_AUDIO_FILE_SHAPE,
    async ({ file_path, language, model }) => transcribeAudioFile(deps, file_path, language, model)
  );
}
