/**
 * Centralized JSON Schema definitions for all MCP tools in dicoclerk.
 *
 * Each tool has:
 *   - An INPUT_SHAPE: plain object of Zod field schemas, used directly in
 *     server.tool() registration AND for input validation.
 *   - An INPUT_SCHEMA: z.object(shape) for programmatic validation.
 *   - An OUTPUT_SCHEMA: z.object(…) describing the JSON payload returned
 *     inside content[0].text, used for output validation in tests and
 *     the validator utility.
 *
 * Stricter constraints vs the original inline schemas:
 *   - guild_id / channel IDs require min-length 1 (non-empty).
 *   - date_from / date_to require YYYY-MM-DD format.
 *   - limit values are bounded to sane maximums.
 *   - offset must be non-negative.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Non-empty Discord snowflake / ID string. */
export const GuildIdField = z.string().min(1, 'must be a non-empty string');

/**
 * Optional date string that, when provided, must be in YYYY-MM-DD format.
 * Keeps the strict format check while allowing omission.
 */
export const DateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be in YYYY-MM-DD format (e.g. 2025-01-15)')
  .optional();

/** Pagination limit: 1–100 integer. */
export const LimitField = z
  .number()
  .int('must be an integer')
  .min(1, 'must be at least 1')
  .max(100, 'must be at most 100')
  .default(20);

/** Pagination offset: non-negative integer. */
export const OffsetField = z
  .number()
  .int('must be an integer')
  .min(0, 'must be a non-negative integer')
  .default(0);

// ---------------------------------------------------------------------------
// Input shapes (plain Zod-field objects) — passed to server.tool()
// ---------------------------------------------------------------------------

export const JOIN_VOICE_CHANNEL_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID'),
  channel_id: z.string().min(1, 'must be a non-empty string').describe('Voice channel ID to join'),
};

export const LEAVE_VOICE_CHANNEL_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID to disconnect from'),
};

export const START_SESSION_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID'),
  voice_channel_id: z.string().min(1, 'must be a non-empty string').describe('Voice channel ID to join and record'),
  text_channel_id: z.string().min(1, 'must be a non-empty string').describe('Text channel ID for status messages and minutes delivery'),
  language: z.enum(['ko', 'en', 'multi']).default('multi').describe(
    'Language for STT: ko (Korean), en (English), or multi (auto-detect Korean+English)'
  ),
};

export const STOP_SESSION_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID with an active session'),
};

export const LIST_SESSIONS_SHAPE = {};

export const GET_SESSION_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID'),
};

export const GET_STATUS_SHAPE = {
  guild_id: z.string().optional().describe(
    'Filter status to a specific Discord guild ID (omit to get all sessions)'
  ),
};

export const GET_TRANSCRIPT_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID'),
  session_id: z.string().optional().describe(
    'Specific session ID to retrieve (e.g. "guild123-1714000000000"). ' +
    'Omit to get the current active session for the guild. ' +
    'Pass "current" as a special alias for the active session.'
  ),
  format: z.enum(['raw', 'formatted']).default('formatted').describe('Transcript output format: ' +
    '"raw" returns structured JSON with speaker-diarized entries; ' +
    '"formatted" returns a human-readable speaker-attributed text transcript.'
  ),
};

export const GET_MINUTES_SHAPE = {
  guild_id: GuildIdField.describe('Discord guild (server) ID'),
  session_id: z.string().optional().describe('Specific session ID (defaults to latest)'),
};

export const LIST_RECORDINGS_SHAPE = {
  limit: LimitField.describe('Maximum number of recordings to return'),
  guild_id: z.string().optional().describe('Filter by guild ID'),
};

export const SEARCH_MINUTES_SHAPE = {
  query: z.string().optional().describe('Free-text search across channel name, guild, participants'),
  guild_id: z.string().optional().describe('Filter by Discord guild ID'),
  channel_name: z.string().optional().describe('Partial match on voice channel name'),
  participant: z.string().optional().describe('Partial match on participant name'),
  date_from: DateField.describe('Start date filter (YYYY-MM-DD, inclusive)'),
  date_to: DateField.describe('End date filter (YYYY-MM-DD, inclusive)'),
  language: z.string().optional().describe('Filter by language code (ko/en)'),
  limit: LimitField.describe('Maximum results to return'),
  offset: OffsetField.describe('Skip first N results for pagination'),
};

export const SEARCH_MEETING_MINUTES_SHAPE = {
  query: z.string().optional().describe('Free-text search across metadata fields and minutes content'),
  guild_id: z.string().optional().describe('Filter by Discord guild ID'),
  channel_name: z.string().optional().describe('Partial match on voice channel name'),
  participant: z.string().optional().describe('Partial match on participant name'),
  date_from: DateField.describe('Start date filter (YYYY-MM-DD, inclusive)'),
  date_to: DateField.describe('End date filter (YYYY-MM-DD, inclusive)'),
  keywords: z.array(z.string()).optional().describe(
    'Keywords to search within minutes content (all matched entries contain at least one keyword)'
  ),
  language: z.string().optional().describe('Filter by language code (ko/en)'),
  limit: z
    .number()
    .int('must be an integer')
    .min(1, 'must be at least 1')
    .max(50, 'must be at most 50')
    .default(5)
    .describe('Maximum results to return (default 5, lower due to content size)'),
  offset: OffsetField.describe('Skip first N results for pagination'),
  include_content: z.boolean().default(true).describe(
    'Whether to include full markdown content in results (default true)'
  ),
};

export const GET_MEETING_MINUTES_SHAPE = {
  session_id: z.string().optional().describe(
    'Retrieve a specific meeting by session ID (takes precedence over other filters when provided)'
  ),
  query: z.string().optional().describe('Free-text search across metadata fields and minutes content'),
  guild_id: z.string().optional().describe('Filter by Discord guild ID'),
  channel_name: z.string().optional().describe('Partial match on voice channel name (case-insensitive)'),
  participant: z.string().optional().describe('Partial match on participant name (case-insensitive)'),
  date_from: DateField.describe('Start date filter (YYYY-MM-DD, inclusive)'),
  date_to: DateField.describe('End date filter (YYYY-MM-DD, inclusive)'),
  keywords: z.array(z.string()).optional().describe(
    'Keywords to search within minutes content (returns entries containing any of the keywords)'
  ),
  language: z.string().optional().describe('Filter by language code (ko/en)'),
  limit: z
    .number()
    .int('must be an integer')
    .min(0, 'must be a non-negative integer')
    .max(50, 'must be at most 50')
    .default(5)
    .describe('Maximum results to return (default 5)'),
  offset: OffsetField.describe('Skip first N results for pagination'),
  include_transcript: z.boolean().default(false).describe(
    'Include the full transcript entries in structured_content (default false)'
  ),
  include_raw_markdown: z.boolean().default(false).describe(
    'Include the raw markdown source of the minutes file (default false)'
  ),
};

export const SUMMARIZE_MINUTES_SHAPE = {
  query: z.string().optional().describe('Free-text search across metadata fields and minutes content'),
  guild_id: z.string().optional().describe('Filter by Discord guild ID'),
  channel_name: z.string().optional().describe('Partial match on voice channel name'),
  participant: z.string().optional().describe('Partial match on participant name'),
  date_from: DateField.describe('Start date filter (YYYY-MM-DD, inclusive)'),
  date_to: DateField.describe('End date filter (YYYY-MM-DD, inclusive)'),
  keywords: z.array(z.string()).optional().describe('Keywords to search within minutes content'),
  language: z.string().optional().describe('Filter by language code (ko/en)'),
  limit: z
    .number()
    .int('must be an integer')
    .min(1, 'must be at least 1')
    .max(20, 'must be at most 20')
    .default(5)
    .describe('Maximum number of meetings to summarize (default 5)'),
  offset: OffsetField.describe('Skip first N results for pagination'),
  focus_query: z.string().optional().describe(
    'Focus the summary on a specific topic or keyword — relevant content is prioritized and highlighted'
  ),
  max_topics: z
    .number()
    .int('must be an integer')
    .min(1, 'must be at least 1')
    .max(20, 'must be at most 20')
    .default(5)
    .describe('Maximum key topics per meeting summary'),
  max_action_items: z
    .number()
    .int('must be an integer')
    .min(1, 'must be at least 1')
    .max(50, 'must be at most 50')
    .default(10)
    .describe('Maximum action items per meeting summary'),
  max_narrative_length: z
    .number()
    .int('must be an integer')
    .min(50, 'must be at least 50')
    .max(2000, 'must be at most 2000')
    .default(500)
    .describe('Maximum character length for the narrative summary per meeting'),
};

// ---------------------------------------------------------------------------
// Input schemas — z.object(shape) for validation
// ---------------------------------------------------------------------------

export const JoinVoiceChannelInputSchema = z.object(JOIN_VOICE_CHANNEL_SHAPE);
export const LeaveVoiceChannelInputSchema = z.object(LEAVE_VOICE_CHANNEL_SHAPE);
export const StartSessionInputSchema = z.object(START_SESSION_SHAPE);
export const StopSessionInputSchema = z.object(STOP_SESSION_SHAPE);
export const ListSessionsInputSchema = z.object(LIST_SESSIONS_SHAPE);
export const GetSessionInputSchema = z.object(GET_SESSION_SHAPE);
export const GetStatusInputSchema = z.object(GET_STATUS_SHAPE);
export const GetTranscriptInputSchema = z.object(GET_TRANSCRIPT_SHAPE);
export const GetTranscriptInputRefinedSchema = GetTranscriptInputSchema.refine(
  (data) => data.guild_id || data.session_id,
  { message: 'At least one of guild_id or session_id must be provided' }
);
export const GetMinutesInputSchema = z.object(GET_MINUTES_SHAPE);
export const ListRecordingsInputSchema = z.object(LIST_RECORDINGS_SHAPE);
export const SearchMinutesInputSchema = z.object(SEARCH_MINUTES_SHAPE);
export const SearchMeetingMinutesInputSchema = z.object(SEARCH_MEETING_MINUTES_SHAPE);
export const SummarizeMinutesInputSchema = z.object(SUMMARIZE_MINUTES_SHAPE);
export const GetMeetingMinutesInputSchema = z.object(GET_MEETING_MINUTES_SHAPE);

// ---------------------------------------------------------------------------
// Whisper batch STT tool
// ---------------------------------------------------------------------------

export const TRANSCRIBE_AUDIO_FILE_SHAPE = {
  file_path: z.string().min(1, 'must be a non-empty file path').describe('Absolute path to the audio file to transcribe (wav, mp3, ogg, webm, m4a)'),
  language: z.enum(['ko', 'en', 'multi']).optional().describe('Language hint for transcription (default: auto-detect)'),
  model: z.string().optional().describe('Whisper model name (default: large-v3-turbo)'),
};

export const TranscribeAudioFileInputSchema = z.object(TRANSCRIBE_AUDIO_FILE_SHAPE);

// ---------------------------------------------------------------------------
// Output schemas — describe the JSON object inside content[0].text
// (used for response validation in tests and the validator utility)
// ---------------------------------------------------------------------------

const ParticipantSchema = z.object({
  user_id: z.string(),
  username: z.string(),
});

export const JoinVoiceChannelOutputSchema = z.object({
  connected: z.boolean(),
  guild_id: z.string(),
  channel_id: z.string(),
  channel_name: z.string().optional(),
  member_count: z.number().int().min(0),
  connection_state: z.enum(['connected', 'failed', 'already_connected', 'session_active']),
  session_id: z.string().optional(),
  message: z.string(),
});

export const LeaveVoiceChannelOutputSchema = z.object({
  disconnected: z.boolean(),
  guild_id: z.string(),
  had_session: z.boolean(),
  session_id: z.string().optional(),
  duration_seconds: z.number().optional(),
  duration_formatted: z.string().optional(),
  participant_count: z.number().int().min(0).optional(),
  transcript_count: z.number().int().min(0).optional(),
  transcript_file: z.string().nullable().optional(),
  minutes_generation: z.enum(['pending', 'skipped', 'not_applicable']).optional(),
  warnings: z.array(z.string()).optional(),
  message: z.string(),
});

export const StartSessionOutputSchema = z.object({
  success: z.boolean(),
  guild_id: z.string(),
  voice_channel_id: z.string(),
  text_channel_id: z.string(),
  language: z.string(),
  session_id: z.string(),
  started_at: z.string(),
  started_by: z.string(),
  participants: z.array(ParticipantSchema),
});

export const StopSessionOutputSchema = z.object({
  success: z.boolean(),
  guild_id: z.string(),
  reason: z.string(),
  duration_seconds: z.number(),
  duration_formatted: z.string(),
  participant_count: z.number(),
  transcript_count: z.number(),
  transcript_file: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional(),
  minutes_generation: z.enum(['pending', 'skipped']),
});

export const ListSessionsOutputSchema = z.object({
  sessions: z.array(
    z.object({
      guild_id: z.string(),
      voice_channel_id: z.string().nullable().optional(),
      text_channel_id: z.string().nullable().optional(),
      started_at: z.string().nullable(),
      participant_count: z.number(),
      transcript_count: z.number(),
    })
  ),
  count: z.number(),
});

export const GetSessionOutputSchema = z.object({
  guild_id: z.string(),
  voice_channel_id: z.string().nullable().optional(),
  text_channel_id: z.string().nullable().optional(),
  started_at: z.string().nullable(),
  language: z.string(),
  participant_count: z.number(),
  participants: z.array(ParticipantSchema),
  transcript_count: z.number(),
  is_recording: z.boolean(),
});

export const GetStatusOutputSchema = z.object({
  bot_mode: z.enum(['connected', 'standalone']),
  active_session_count: z.number(),
  sessions: z.array(
    z.object({
      guild_id: z.string(),
      voice_channel_id: z.string().nullable(),
      text_channel_id: z.string().nullable(),
      language: z.string(),
      status: z.string(),
      started_at: z.string().nullable(),
      duration_seconds: z.number(),
      participant_count: z.number(),
      transcript_count: z.number(),
      is_recording: z.boolean(),
      deepgram_status: z.enum(['active', 'idle', 'error', 'unavailable']),
    })
  ),
  system: z.object({
    version: z.string(),
    uptime_seconds: z.number(),
    deepgram_configured: z.boolean(),
  }),
  note: z.string().optional(),
});

/**
 * A single speaker-diarized transcript entry (raw format).
 */
export const TranscriptEntrySchema = z.object({
  session_id: z.string(),
  speaker_label: z.number().int().min(0),
  speaker_name: z.string(),
  user_id: z.string().nullable(),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  duration: z.number(),
  confidence: z.number(),
  language: z.enum(['ko', 'en', 'unknown']),
  is_final: z.boolean(),
  wall_clock_ms: z.number(),
});

/**
 * get_transcript raw format output schema.
 * Formatted text output is plain text and needs no JSON schema.
 */
export const GetTranscriptRawOutputSchema = z.object({
  session_id: z.string(),
  guild_id: z.string(),
  format: z.literal('raw'),
  status: z.enum(['live', 'stored']),
  entry_count: z.number(),
  speaker_count: z.number(),
  language: z.string().optional(),
  entries: z.array(TranscriptEntrySchema),
});

export const ListRecordingsOutputSchema = z.object({
  recordings: z.array(
    z.object({
      type: z.enum(['transcript', 'minutes']),
      filename: z.string(),
      size_bytes: z.number(),
      created_at: z.string(),
      modified_at: z.string(),
    })
  ),
  total: z.number(),
  showing: z.number(),
});

const MinutesIndexEntrySchema = z.object({
  session_id: z.string(),
  date: z.string(),
  time: z.string(),
  duration_seconds: z.number(),
  guild_name: z.string().optional(),
  channel_name: z.string().optional(),
  participants: z.array(z.string()),
  participant_count: z.number(),
  transcript_count: z.number(),
  language: z.string().optional(),
  started_by: z.string().optional(),
  filename: z.string(),
});

export const SearchMinutesOutputSchema = z.object({
  minutes: z.array(MinutesIndexEntrySchema),
  total: z.number(),
  showing: z.number(),
});

export const SearchMeetingMinutesOutputSchema = z.object({
  results: z.array(
    MinutesIndexEntrySchema.extend({
      matched_keywords: z.array(z.string()).optional(),
      content: z.string().optional(),
    })
  ),
  total: z.number(),
  showing: z.number(),
});

export const SummarizeMinutesOutputSchema = z.object({
  meetingCount: z.number(),
  generatedAt: z.string(),
  summaries: z.array(z.unknown()),
  crossMeetingSummary: z.unknown().optional(),
  agentFormattedText: z.string(),
});

const StructuredContentSchema = z.object({
  summary: z.string().nullable().optional(),
  key_discussion_points: z.array(z.string()),
  action_items: z.array(z.object({
    task: z.string(),
    assignee: z.string().nullable(),
    deadline: z.string().nullable(),
  })),
  decisions: z.array(z.string()),
  attendees: z.array(z.object({
    name: z.string(),
    role: z.string().nullable().optional(),
    utterance_count: z.number().nullable().optional(),
  })),
  statistics: z.record(z.unknown()),
  transcript: z.array(z.object({
    timestamp: z.string().nullable(),
    speaker: z.string(),
    text: z.string(),
  })).optional(),
});

const MeetingMinutesResultSchema = z.object({
  session_id: z.string(),
  date: z.string(),
  time: z.string().optional(),
  started_at: z.string().optional(),
  duration_seconds: z.number(),
  duration_formatted: z.string(),
  guild_id: z.string().optional(),
  guild_name: z.string().optional(),
  channel_id: z.string().optional(),
  channel_name: z.string().optional(),
  participants: z.array(z.string()),
  participant_count: z.number(),
  language: z.string().optional(),
  started_by: z.string().optional(),
  filename: z.string().optional(),
  structured_content: StructuredContentSchema,
  raw_markdown: z.string().optional(),
});

export const GetMeetingMinutesOutputSchema = z.object({
  results: z.array(MeetingMinutesResultSchema),
  total: z.number(),
  showing: z.number(),
});

// ---------------------------------------------------------------------------
// Schema registries — convenient lookup by tool name
// ---------------------------------------------------------------------------

/** Maps tool name → input shape (for server.tool() registration). */
export const INPUT_SHAPES = {
  join_voice_channel: JOIN_VOICE_CHANNEL_SHAPE,
  leave_voice_channel: LEAVE_VOICE_CHANNEL_SHAPE,
  start_session: START_SESSION_SHAPE,
  stop_session: STOP_SESSION_SHAPE,
  list_sessions: LIST_SESSIONS_SHAPE,
  get_session: GET_SESSION_SHAPE,
  get_status: GET_STATUS_SHAPE,
  get_transcript: GET_TRANSCRIPT_SHAPE,
  get_minutes: GET_MINUTES_SHAPE,
  list_recordings: LIST_RECORDINGS_SHAPE,
  search_minutes: SEARCH_MINUTES_SHAPE,
  search_meeting_minutes: SEARCH_MEETING_MINUTES_SHAPE,
  summarize_minutes: SUMMARIZE_MINUTES_SHAPE,
  get_meeting_minutes: GET_MEETING_MINUTES_SHAPE,
};

/** Maps tool name → full input Zod schema (for validation). */
export const INPUT_SCHEMAS = {
  join_voice_channel: JoinVoiceChannelInputSchema,
  leave_voice_channel: LeaveVoiceChannelInputSchema,
  start_session: StartSessionInputSchema,
  stop_session: StopSessionInputSchema,
  list_sessions: ListSessionsInputSchema,
  get_session: GetSessionInputSchema,
  get_status: GetStatusInputSchema,
  get_transcript: GetTranscriptInputSchema,
  get_minutes: GetMinutesInputSchema,
  list_recordings: ListRecordingsInputSchema,
  search_minutes: SearchMinutesInputSchema,
  search_meeting_minutes: SearchMeetingMinutesInputSchema,
  summarize_minutes: SummarizeMinutesInputSchema,
  get_meeting_minutes: GetMeetingMinutesInputSchema,
};

/** Maps tool name → output Zod schema (for validation of JSON content). */
export const OUTPUT_SCHEMAS = {
  join_voice_channel: JoinVoiceChannelOutputSchema,
  leave_voice_channel: LeaveVoiceChannelOutputSchema,
  start_session: StartSessionOutputSchema,
  stop_session: StopSessionOutputSchema,
  list_sessions: ListSessionsOutputSchema,
  get_session: GetSessionOutputSchema,
  get_status: GetStatusOutputSchema,
  get_transcript: GetTranscriptRawOutputSchema,
  get_transcript_raw: GetTranscriptRawOutputSchema,
  list_recordings: ListRecordingsOutputSchema,
  search_minutes: SearchMinutesOutputSchema,
  search_meeting_minutes: SearchMeetingMinutesOutputSchema,
  summarize_minutes: SummarizeMinutesOutputSchema,
  get_meeting_minutes: GetMeetingMinutesOutputSchema,
};
