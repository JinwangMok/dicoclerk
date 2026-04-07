/**
 * MCP Tool Manifests for dicoclerk
 *
 * Provides formal JSON Schema definitions for every MCP tool exposed by the
 * dicoclerk server.  These manifests serve two purposes:
 *
 *   1. **Openclaw agent discoverability** — the manifest is serialisable to
 *      plain JSON so that orchestration agents (e.g. Openclaw) can inspect
 *      tool capabilities, required parameters, and expected output shapes
 *      without running the bot.
 *
 *   2. **Internal validation** — the manifest is cross-validated against the
 *      Zod schemas in schemas.js via `tests/mcp-manifest.test.js`, ensuring
 *      the two sources of truth never diverge.
 *
 * JSON Schema version: draft-07 (widely supported, compatible with MCP SDK)
 *
 * Manifest structure per tool:
 *   {
 *     name        : string            — canonical tool name
 *     description : string            — human/agent-readable purpose
 *     inputSchema : JSONSchemaObject  — parameters the tool accepts
 *     outputSchema: JSONSchemaObject  — JSON shape inside content[0].text
 *     metadata    : {
 *       category      : string        — logical grouping
 *       requires_bot  : boolean       — needs Discord client (not standalone)
 *       side_effects  : string[]      — what the tool mutates/creates
 *       aliases       : string[]      — other tool names that do the same thing
 *       languages     : string[]      — supported language codes
 *     }
 *   }
 */

// ---------------------------------------------------------------------------
// Shared JSON Schema primitives (referenced by $ref in tool schemas)
// ---------------------------------------------------------------------------

export const SHARED_DEFINITIONS = {
  DiscordId: {
    type: 'string',
    minLength: 1,
    description: 'Discord snowflake / numeric ID string (non-empty)',
  },
  DateString: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Date in YYYY-MM-DD format, e.g. "2025-01-15"',
  },
  LanguageCode: {
    type: 'string',
    enum: ['ko', 'en', 'multi'],
    description: 'STT language: "ko" (Korean), "en" (English), "multi" (auto-detect both)',
  },
  Participant: {
    type: 'object',
    properties: {
      user_id:  { type: 'string', description: 'Discord user snowflake ID' },
      username: { type: 'string', description: 'Discord display name' },
    },
    required: ['user_id', 'username'],
    additionalProperties: false,
  },
  MinutesIndexEntry: {
    type: 'object',
    properties: {
      session_id:        { type: 'string' },
      date:              { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      time:              { type: 'string' },
      duration_seconds:  { type: 'number', minimum: 0 },
      guild_name:        { type: 'string' },
      channel_name:      { type: 'string' },
      participants:      { type: 'array', items: { type: 'string' } },
      participant_count: { type: 'integer', minimum: 0 },
      transcript_count:  { type: 'integer', minimum: 0 },
      language:          { type: 'string' },
      started_by:        { type: 'string' },
      filename:          { type: 'string' },
    },
    required: ['session_id', 'date', 'time', 'duration_seconds', 'participants',
               'participant_count', 'transcript_count', 'filename'],
    additionalProperties: true,
  },
  PaginationResult: {
    type: 'object',
    properties: {
      total:   { type: 'integer', minimum: 0, description: 'Total matching records' },
      showing: { type: 'integer', minimum: 0, description: 'Records included in this response' },
    },
    required: ['total', 'showing'],
  },
};

// ---------------------------------------------------------------------------
// Common search-filter input properties (reused across several tools)
// ---------------------------------------------------------------------------

const SEARCH_FILTER_PROPERTIES = {
  query: {
    type: 'string',
    description: 'Free-text search across metadata fields (channel name, guild, participants)',
  },
  guild_id: {
    type: 'string',
    description: 'Filter by Discord guild ID',
  },
  channel_name: {
    type: 'string',
    description: 'Partial, case-insensitive match on voice channel name',
  },
  participant: {
    type: 'string',
    description: 'Partial, case-insensitive match on any participant display name',
  },
  date_from: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Inclusive start date filter in YYYY-MM-DD format',
  },
  date_to: {
    type: 'string',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'Inclusive end date filter in YYYY-MM-DD format',
  },
  language: {
    type: 'string',
    description: 'Filter by language code: "ko" or "en"',
  },
  keywords: {
    type: 'array',
    items: { type: 'string' },
    description: 'Keywords to search within minutes file content. ' +
      'Results contain at least one of the provided keywords.',
  },
};

const PAGINATION_PROPERTIES = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    default: 20,
    description: 'Maximum number of results to return (1–100)',
  },
  offset: {
    type: 'integer',
    minimum: 0,
    default: 0,
    description: 'Number of results to skip (for pagination)',
  },
};

// ---------------------------------------------------------------------------
// Tool manifests
// ---------------------------------------------------------------------------

/**
 * Full manifest for every tool registered on the dicoclerk MCP server.
 * Keys are canonical tool names.
 *
 * @type {Record<string, import('./manifest-types.js').ToolManifest>}
 */
export const TOOL_MANIFESTS = {

  // -------------------------------------------------------------------------
  // join_voice_channel
  // -------------------------------------------------------------------------
  join_voice_channel: {
    name: 'join_voice_channel',
    description:
      'Join a Discord voice channel and return connection status. Use this as a ' +
      'lightweight connectivity probe to verify the bot can reach a specific channel ' +
      'before starting a recording session. Returns the channel name, human member ' +
      'count, and a connection_state of "connected" (successfully joined), ' +
      '"already_connected" (bot is already in that channel via an active session), ' +
      '"session_active" (bot is busy in a different channel), or "failed". ' +
      'Does NOT start STT or Deepgram processing. ' +
      'Requires the Discord bot to be running (not available in standalone MCP mode).',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID',
        },
        channel_id: {
          type: 'string',
          minLength: 1,
          description: 'Voice channel ID to join',
        },
      },
      required: ['guild_id', 'channel_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        connected:        { type: 'boolean', description: 'Whether the bot is/was connected to the channel' },
        guild_id:         { type: 'string' },
        channel_id:       { type: 'string' },
        channel_name:     { type: 'string', description: 'Human-readable channel name' },
        member_count:     { type: 'integer', minimum: 0, description: 'Number of non-bot members in the channel' },
        connection_state: {
          type: 'string',
          enum: ['connected', 'already_connected', 'session_active', 'failed'],
          description:
            '"connected" = bot joined successfully; ' +
            '"already_connected" = bot is already in this channel via an active session; ' +
            '"session_active" = bot is occupied in a different channel; ' +
            '"failed" = join attempt failed',
        },
        session_id: { type: 'string', description: 'Active session ID if connection_state is "already_connected"' },
        message:    { type: 'string', description: 'Human-readable status description' },
      },
      required: ['connected', 'guild_id', 'channel_id', 'member_count', 'connection_state', 'message'],
      additionalProperties: false,
    },
    metadata: {
      category: 'voice',
      requires_bot: true,
      side_effects: ['voice_channel_join', 'voice_channel_leave'],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // leave_voice_channel
  // -------------------------------------------------------------------------
  leave_voice_channel: {
    name: 'leave_voice_channel',
    description:
      'Disconnect the bot from the voice channel for a guild. If a recording session ' +
      'is active, it is stopped gracefully: the Deepgram STT stream is flushed, the ' +
      'transcript is saved to disk, and meeting minutes generation is triggered ' +
      '(delivered to the text channel within 1-2 minutes). Returns a session summary ' +
      'with duration, participant count, transcript count, and minutes generation status. ' +
      'Use this to cleanly end a session initiated by start_session or triggered via /start. ' +
      'Requires the Discord bot to be running (not available in standalone MCP mode).',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID to disconnect from',
        },
      },
      required: ['guild_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        disconnected:       { type: 'boolean', description: 'Whether the bot successfully disconnected' },
        guild_id:           { type: 'string' },
        had_session:        { type: 'boolean', description: 'Whether a recording session was active at disconnect time' },
        session_id:         { type: 'string', description: 'Session ID of the ended session (if had_session is true)' },
        duration_seconds:   { type: 'number', minimum: 0, description: 'Session duration in seconds' },
        duration_formatted: { type: 'string', description: 'Human-readable duration, e.g. "12m 34s"' },
        participant_count:  { type: 'integer', minimum: 0, description: 'Number of unique participants in the session' },
        transcript_count:   { type: 'integer', minimum: 0, description: 'Number of transcript entries recorded' },
        transcript_file:    { type: ['string', 'null'], description: 'Path to saved transcript file, or null' },
        minutes_generation: {
          type: 'string',
          enum: ['pending', 'skipped', 'not_applicable'],
          description:
            '"pending" = minutes generation triggered (transcript non-empty); ' +
            '"skipped" = no transcript entries to process; ' +
            '"not_applicable" = no session was active',
        },
        warnings: {
          type: 'array',
          items: { type: 'string' },
          description: 'Any non-fatal warnings encountered during cleanup',
        },
        message: { type: 'string', description: 'Human-readable status description' },
      },
      required: ['disconnected', 'guild_id', 'had_session', 'message'],
      additionalProperties: false,
    },
    metadata: {
      category: 'voice',
      requires_bot: true,
      side_effects: ['voice_channel_leave', 'transcript_save', 'minutes_generation'],
      aliases: ['disconnect', 'stop_and_leave'],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // start_session
  // -------------------------------------------------------------------------
  start_session: {
    name: 'start_session',
    description:
      'Start a new voice recording session in a Discord voice channel. ' +
      'Joins the channel, begins real-time STT via Deepgram with speaker ' +
      'diarization (Korean and English supported), and records a full ' +
      'transcript. Requires the Discord bot to be running (not available in ' +
      'standalone MCP mode). Use stop_session to end the session and ' +
      'generate meeting minutes.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID',
        },
        voice_channel_id: {
          type: 'string',
          minLength: 1,
          description: 'Voice channel ID to join and record',
        },
        text_channel_id: {
          type: 'string',
          minLength: 1,
          description: 'Text channel ID for status messages and minutes delivery',
        },
        language: {
          type: 'string',
          enum: ['ko', 'en', 'multi'],
          default: 'multi',
          description: 'STT language: "ko" (Korean), "en" (English), "multi" (auto-detect both)',
        },
      },
      required: ['guild_id', 'voice_channel_id', 'text_channel_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        success:          { type: 'boolean' },
        guild_id:         { type: 'string' },
        voice_channel_id: { type: 'string' },
        text_channel_id:  { type: 'string' },
        language:         { type: 'string' },
        session_id:       { type: 'string' },
        started_at:       { type: 'string', format: 'date-time' },
        started_by:       { type: 'string' },
        participants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              user_id:  { type: 'string' },
              username: { type: 'string' },
            },
            required: ['user_id', 'username'],
          },
        },
      },
      required: ['success', 'guild_id', 'voice_channel_id', 'text_channel_id',
                 'language', 'session_id', 'started_at', 'started_by', 'participants'],
    },
    metadata: {
      category: 'session_management',
      requires_bot: true,
      side_effects: ['joins_voice_channel', 'starts_deepgram_stream', 'starts_recording'],
      aliases: ['start_recording'],
      languages: ['ko', 'en', 'multi'],
    },
  },

  // -------------------------------------------------------------------------
  // start_recording (alias)
  // -------------------------------------------------------------------------
  start_recording: {
    name: 'start_recording',
    description:
      'Start a new voice recording session in a Discord voice channel. ' +
      'Joins the channel, begins real-time STT via Deepgram with speaker ' +
      'diarization (Korean and English supported), and records a full ' +
      'transcript. Requires the Discord bot to be running (not available in ' +
      'standalone MCP mode). Use stop_recording to end the session and ' +
      'generate meeting minutes.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID',
        },
        voice_channel_id: {
          type: 'string',
          minLength: 1,
          description: 'Voice channel ID to join and record',
        },
        text_channel_id: {
          type: 'string',
          minLength: 1,
          description: 'Text channel ID for status messages and minutes delivery',
        },
        language: {
          type: 'string',
          enum: ['ko', 'en', 'multi'],
          default: 'multi',
          description: 'STT language: "ko" (Korean), "en" (English), "multi" (auto-detect both)',
        },
      },
      required: ['guild_id', 'voice_channel_id', 'text_channel_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        success:          { type: 'boolean' },
        guild_id:         { type: 'string' },
        voice_channel_id: { type: 'string' },
        text_channel_id:  { type: 'string' },
        language:         { type: 'string' },
        session_id:       { type: 'string' },
        started_at:       { type: 'string', format: 'date-time' },
        started_by:       { type: 'string' },
        participants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              user_id:  { type: 'string' },
              username: { type: 'string' },
            },
            required: ['user_id', 'username'],
          },
        },
      },
      required: ['success', 'guild_id', 'voice_channel_id', 'text_channel_id',
                 'language', 'session_id', 'started_at', 'started_by', 'participants'],
    },
    metadata: {
      category: 'session_management',
      requires_bot: true,
      side_effects: ['joins_voice_channel', 'starts_deepgram_stream', 'starts_recording'],
      aliases: ['start_session'],
      languages: ['ko', 'en', 'multi'],
    },
  },

  // -------------------------------------------------------------------------
  // stop_session
  // -------------------------------------------------------------------------
  stop_session: {
    name: 'stop_session',
    description:
      'Stop an active recording session. Disconnects from voice, finalizes ' +
      'the transcript, and triggers meeting minutes generation. Minutes are ' +
      'delivered to the text channel as a markdown file within 1-2 minutes.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID with an active session',
        },
      },
      required: ['guild_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        success:             { type: 'boolean' },
        guild_id:            { type: 'string' },
        reason:              { type: 'string', description: 'Human-readable stop reason' },
        duration_seconds:    { type: 'number', minimum: 0 },
        duration_formatted:  { type: 'string', description: 'e.g. "12m 34s"' },
        participant_count:   { type: 'integer', minimum: 0 },
        transcript_count:    { type: 'integer', minimum: 0 },
        transcript_file:     { type: ['string', 'null'] },
        warnings:            { type: 'array', items: { type: 'string' } },
        minutes_generation:  { type: 'string', enum: ['pending', 'skipped'] },
      },
      required: ['success', 'guild_id', 'reason', 'duration_seconds',
                 'duration_formatted', 'participant_count', 'transcript_count',
                 'minutes_generation'],
    },
    metadata: {
      category: 'session_management',
      requires_bot: true,
      side_effects: ['leaves_voice_channel', 'saves_transcript', 'triggers_minutes_generation'],
      aliases: ['stop_recording'],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // stop_recording (alias)
  // -------------------------------------------------------------------------
  stop_recording: {
    name: 'stop_recording',
    description:
      'Stop an active voice recording session. Disconnects from the voice ' +
      'channel, finalizes the transcript, and triggers meeting minutes ' +
      'generation. Minutes are delivered to the configured text channel as a ' +
      'markdown file within 1-2 minutes.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID with an active recording session',
        },
      },
      required: ['guild_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        success:             { type: 'boolean' },
        guild_id:            { type: 'string' },
        reason:              { type: 'string' },
        duration_seconds:    { type: 'number', minimum: 0 },
        duration_formatted:  { type: 'string' },
        participant_count:   { type: 'integer', minimum: 0 },
        transcript_count:    { type: 'integer', minimum: 0 },
        transcript_file:     { type: ['string', 'null'] },
        warnings:            { type: 'array', items: { type: 'string' } },
        minutes_generation:  { type: 'string', enum: ['pending', 'skipped'] },
      },
      required: ['success', 'guild_id', 'reason', 'duration_seconds',
                 'duration_formatted', 'participant_count', 'transcript_count',
                 'minutes_generation'],
    },
    metadata: {
      category: 'session_management',
      requires_bot: true,
      side_effects: ['leaves_voice_channel', 'saves_transcript', 'triggers_minutes_generation'],
      aliases: ['stop_session'],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // list_sessions
  // -------------------------------------------------------------------------
  list_sessions: {
    name: 'list_sessions',
    description: 'List all active voice recording sessions across guilds.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              guild_id:         { type: 'string' },
              voice_channel_id: { type: ['string', 'null'] },
              text_channel_id:  { type: ['string', 'null'] },
              started_at:       { type: ['string', 'null'] },
              participant_count:{ type: 'integer', minimum: 0 },
              transcript_count: { type: 'integer', minimum: 0 },
            },
            required: ['guild_id', 'participant_count', 'transcript_count'],
          },
        },
        count: { type: 'integer', minimum: 0 },
        note:  { type: 'string', description: 'Present in standalone mode' },
      },
      required: ['sessions', 'count'],
    },
    metadata: {
      category: 'session_queries',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // get_session
  // -------------------------------------------------------------------------
  get_session: {
    name: 'get_session',
    description: 'Get detailed information about a specific recording session.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID',
        },
      },
      required: ['guild_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id:         { type: 'string' },
        voice_channel_id: { type: ['string', 'null'] },
        text_channel_id:  { type: ['string', 'null'] },
        started_at:       { type: ['string', 'null'] },
        language:         { type: 'string' },
        participant_count:{ type: 'integer', minimum: 0 },
        participants: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              user_id:  { type: 'string' },
              username: { type: 'string' },
            },
            required: ['user_id', 'username'],
          },
        },
        transcript_count: { type: 'integer', minimum: 0 },
        is_recording:     { type: 'boolean' },
      },
      required: ['guild_id', 'language', 'participant_count', 'participants',
                 'transcript_count', 'is_recording'],
    },
    metadata: {
      category: 'session_queries',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // get_status
  // -------------------------------------------------------------------------
  get_status: {
    name: 'get_status',
    description:
      'Get the current system status of the dicoclerk bot. Returns bot mode ' +
      '(connected/standalone), all active recording sessions with their live ' +
      'stats (participants, transcript count, recording state, Deepgram ' +
      'connection health), and system info (version, uptime, Deepgram ' +
      'configuration). Use this to check if any sessions are active before ' +
      'issuing start_session or stop_session commands.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          description: 'Filter status to a specific Discord guild ID (omit for all sessions)',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        bot_mode: {
          type: 'string',
          enum: ['connected', 'standalone'],
          description: '"connected" when Discord client is available, "standalone" otherwise',
        },
        active_session_count: { type: 'integer', minimum: 0 },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              guild_id:         { type: 'string' },
              voice_channel_id: { type: ['string', 'null'] },
              text_channel_id:  { type: ['string', 'null'] },
              language:         { type: 'string' },
              status:           { type: 'string' },
              started_at:       { type: ['string', 'null'] },
              duration_seconds: { type: 'number', minimum: 0 },
              participant_count:{ type: 'integer', minimum: 0 },
              transcript_count: { type: 'integer', minimum: 0 },
              is_recording:     { type: 'boolean' },
              deepgram_status: {
                type: 'string',
                enum: ['active', 'idle', 'error', 'unavailable'],
              },
            },
            required: ['guild_id', 'language', 'status', 'duration_seconds',
                       'participant_count', 'transcript_count', 'is_recording',
                       'deepgram_status'],
          },
        },
        system: {
          type: 'object',
          properties: {
            version:             { type: 'string' },
            uptime_seconds:      { type: 'number', minimum: 0 },
            deepgram_configured: { type: 'boolean' },
          },
          required: ['version', 'uptime_seconds', 'deepgram_configured'],
        },
        note: { type: 'string' },
      },
      required: ['bot_mode', 'active_session_count', 'sessions', 'system'],
    },
    metadata: {
      category: 'session_queries',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // get_transcript
  // -------------------------------------------------------------------------
  get_transcript: {
    name: 'get_transcript',
    description: 'Get the live or completed transcript for a recording session.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID',
        },
        format: {
          type: 'string',
          enum: ['raw', 'formatted'],
          default: 'formatted',
          description:
            '"raw" returns a JSON array of transcript entries; ' +
            '"formatted" returns a human-readable text block',
        },
      },
      required: ['guild_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      description:
        'When format="raw" the content[0].text is a JSON object with entry_count ' +
        'and entries array.  When format="formatted" the content is plain text.',
      oneOf: [
        {
          title: 'Raw format',
          type: 'object',
          properties: {
            guild_id:    { type: 'string' },
            format:      { type: 'string', const: 'raw' },
            entry_count: { type: 'integer', minimum: 0 },
            entries: {
              type: 'array',
              items: { type: 'object' },
            },
          },
          required: ['guild_id', 'format', 'entry_count', 'entries'],
        },
        {
          title: 'Formatted format',
          type: 'string',
          description: 'Plain text transcript',
        },
      ],
    },
    metadata: {
      category: 'session_queries',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // get_minutes
  // -------------------------------------------------------------------------
  get_minutes: {
    name: 'get_minutes',
    description: 'Get generated meeting minutes for a completed session.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        guild_id: {
          type: 'string',
          minLength: 1,
          description: 'Discord guild (server) ID',
        },
        session_id: {
          type: 'string',
          description: 'Specific session ID (defaults to latest completed session)',
        },
      },
      required: ['guild_id'],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      description: 'Returns the raw markdown content of the meeting minutes file',
      type: 'string',
    },
    metadata: {
      category: 'content_retrieval',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // list_recordings
  // -------------------------------------------------------------------------
  list_recordings: {
    name: 'list_recordings',
    description: 'List all stored recordings and transcripts on disk.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Maximum number of recordings to return',
        },
        guild_id: {
          type: 'string',
          description: 'Filter by guild ID (partial match on filename)',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        recordings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type:        { type: 'string', enum: ['transcript', 'minutes'] },
              filename:    { type: 'string' },
              size_bytes:  { type: 'integer', minimum: 0 },
              created_at:  { type: 'string' },
              modified_at: { type: 'string' },
            },
            required: ['type', 'filename', 'size_bytes', 'created_at', 'modified_at'],
          },
        },
        total:   { type: 'integer', minimum: 0 },
        showing: { type: 'integer', minimum: 0 },
      },
      required: ['recordings', 'total', 'showing'],
    },
    metadata: {
      category: 'storage_queries',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // search_minutes
  // -------------------------------------------------------------------------
  search_minutes: {
    name: 'search_minutes',
    description:
      'Search meeting minutes by date, channel, participant, or free-text ' +
      'query. Returns metadata index entries (no full content).',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        ...SEARCH_FILTER_PROPERTIES,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 20,
          description: 'Maximum results to return',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Skip first N results for pagination',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        minutes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              session_id:        { type: 'string' },
              date:              { type: 'string' },
              time:              { type: 'string' },
              duration_seconds:  { type: 'number' },
              guild_name:        { type: 'string' },
              channel_name:      { type: 'string' },
              participants:      { type: 'array', items: { type: 'string' } },
              participant_count: { type: 'integer' },
              transcript_count:  { type: 'integer' },
              language:          { type: 'string' },
              started_by:        { type: 'string' },
              filename:          { type: 'string' },
            },
            required: ['session_id', 'date', 'time', 'duration_seconds',
                       'participants', 'participant_count', 'transcript_count', 'filename'],
          },
        },
        total:   { type: 'integer', minimum: 0 },
        showing: { type: 'integer', minimum: 0 },
      },
      required: ['minutes', 'total', 'showing'],
    },
    metadata: {
      category: 'content_retrieval',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // search_meeting_minutes
  // -------------------------------------------------------------------------
  search_meeting_minutes: {
    name: 'search_meeting_minutes',
    description:
      'Search and retrieve previous meeting minutes with full content. ' +
      'Accepts filters (date range, keywords, participants) and returns ' +
      'matching minutes with their complete markdown content. Use this to ' +
      'find and read past meeting records.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        ...SEARCH_FILTER_PROPERTIES,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 5,
          description: 'Maximum results to return (default 5, lower due to content size)',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Skip first N results for pagination',
        },
        include_content: {
          type: 'boolean',
          default: true,
          description: 'Whether to include full markdown content in results (default true)',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              session_id:        { type: 'string' },
              date:              { type: 'string' },
              time:              { type: 'string' },
              duration_seconds:  { type: 'number' },
              guild_name:        { type: 'string' },
              channel_name:      { type: 'string' },
              participants:      { type: 'array', items: { type: 'string' } },
              participant_count: { type: 'integer' },
              transcript_count:  { type: 'integer' },
              language:          { type: 'string' },
              started_by:        { type: 'string' },
              filename:          { type: 'string' },
              matched_keywords:  { type: 'array', items: { type: 'string' } },
              content:           { type: 'string', description: 'Full markdown content of the minutes file' },
            },
            required: ['session_id', 'date', 'time', 'duration_seconds',
                       'participants', 'participant_count', 'transcript_count', 'filename'],
          },
        },
        total:   { type: 'integer', minimum: 0 },
        showing: { type: 'integer', minimum: 0 },
      },
      required: ['results', 'total', 'showing'],
    },
    metadata: {
      category: 'content_retrieval',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // summarize_minutes
  // -------------------------------------------------------------------------
  summarize_minutes: {
    name: 'summarize_minutes',
    description:
      'Generate condensed contextual summaries from past meeting minutes. ' +
      'Retrieves minutes matching the given filters and returns structured ' +
      'summaries with key topics, action items, decisions, and a narrative ' +
      'overview. Supports an optional focus_query to bias the summary toward ' +
      'a specific topic. Ideal for agents that need a quick digest of one or ' +
      'more past meetings without reading full transcripts.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        ...SEARCH_FILTER_PROPERTIES,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 5,
          description: 'Maximum number of meetings to summarize (default 5)',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Skip first N results for pagination',
        },
        focus_query: {
          type: 'string',
          description:
            'Focus the summary on a specific topic or keyword — ' +
            'relevant content is prioritised and highlighted',
        },
        max_topics: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 5,
          description: 'Maximum key topics per meeting summary',
        },
        max_action_items: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 10,
          description: 'Maximum action items per meeting summary',
        },
        max_narrative_length: {
          type: 'integer',
          minimum: 50,
          maximum: 2000,
          default: 500,
          description: 'Maximum character length for the narrative summary per meeting',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        meetingCount:        { type: 'integer', minimum: 0 },
        generatedAt:         { type: 'string', format: 'date-time' },
        summaries:           { type: 'array', items: { type: 'object' } },
        crossMeetingSummary: { type: 'object' },
        agentFormattedText:  { type: 'string', description: 'Pre-formatted digest text for agent display' },
      },
      required: ['meetingCount', 'generatedAt', 'summaries', 'agentFormattedText'],
    },
    metadata: {
      category: 'content_retrieval',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },

  // -------------------------------------------------------------------------
  // get_meeting_minutes
  // -------------------------------------------------------------------------
  get_meeting_minutes: {
    name: 'get_meeting_minutes',
    description:
      'Retrieve previous meeting minutes as fully structured JSON data. ' +
      'Accepts query parameters including date range (date_from / date_to), ' +
      'voice channel name, participant name, free-text query, and keyword ' +
      'list to filter which minutes are returned. Unlike search_meeting_minutes ' +
      '(which returns raw markdown), this tool parses each matching minutes ' +
      'file and returns structured content: summary text, key discussion ' +
      'points, action items (with assignee and deadline), decisions, ' +
      'attendees table, and statistics. Optionally include full transcript ' +
      'entries or raw markdown via include_transcript / include_raw_markdown. ' +
      'Ideal for agents that need to programmatically process meeting content ' +
      'rather than display it.',
    inputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description:
            'Retrieve a specific session by exact ID — bypasses all other filters',
        },
        ...SEARCH_FILTER_PROPERTIES,
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          default: 5,
          description: 'Maximum number of results to return (default 5)',
        },
        offset: {
          type: 'integer',
          minimum: 0,
          default: 0,
          description: 'Skip first N results for pagination (default 0)',
        },
        include_transcript: {
          type: 'boolean',
          default: false,
          description:
            'Include parsed transcript entries in structured_content.transcript ' +
            '(default false). Each entry has timestamp, speaker, and text fields.',
        },
        include_raw_markdown: {
          type: 'boolean',
          default: false,
          description:
            'Include the raw markdown source of the minutes file in raw_markdown (default false)',
        },
      },
      required: [],
      additionalProperties: false,
    },
    outputSchema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              session_id:       { type: 'string' },
              date:             { type: 'string' },
              time:             { type: 'string' },
              filename:         { type: 'string' },
              matched_keywords: { type: 'array', items: { type: 'string' } },
              structured_content: {
                type: 'object',
                description: 'Parsed, structured representation of the minutes',
                properties: {
                  summary:        { type: 'string' },
                  key_points:     { type: 'array', items: { type: 'string' } },
                  action_items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        text:     { type: 'string' },
                        assignee: { type: 'string' },
                        deadline: { type: 'string' },
                      },
                      required: ['text'],
                    },
                  },
                  decisions:  { type: 'array', items: { type: 'string' } },
                  attendees:  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name:         { type: 'string' },
                        utterances:   { type: 'integer' },
                        speaking_time:{ type: 'number' },
                      },
                      required: ['name'],
                    },
                  },
                  statistics: {
                    type: 'object',
                    properties: {
                      duration_seconds:  { type: 'number' },
                      total_utterances:  { type: 'integer' },
                      participant_count: { type: 'integer' },
                    },
                  },
                  transcript: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        timestamp: { type: 'string' },
                        speaker:   { type: 'string' },
                        text:      { type: 'string' },
                      },
                      required: ['text'],
                    },
                    description: 'Only present when include_transcript=true',
                  },
                },
              },
              raw_markdown: {
                type: 'string',
                description: 'Only present when include_raw_markdown=true',
              },
            },
            required: ['session_id', 'date', 'time', 'filename', 'structured_content'],
          },
        },
        total:   { type: 'integer', minimum: 0 },
        showing: { type: 'integer', minimum: 0 },
      },
      required: ['results', 'total', 'showing'],
    },
    metadata: {
      category: 'content_retrieval',
      requires_bot: false,
      side_effects: [],
      aliases: [],
      languages: [],
    },
  },
};

// ---------------------------------------------------------------------------
// Canonical tool list (all names registered on the server)
// ---------------------------------------------------------------------------

/**
 * All tool names registered on the MCP server, in declaration order.
 * Includes both canonical names and aliases.
 */
export const REGISTERED_TOOL_NAMES = Object.keys(TOOL_MANIFESTS);

/**
 * Tool names that are functional aliases of another tool.
 * Value is the canonical tool name they delegate to.
 */
export const TOOL_ALIASES = {
  start_recording: 'start_session',
  stop_recording:  'stop_session',
};

/**
 * Capability declarations for the server as a whole.
 * Consumed by Openclaw during MCP server registration.
 */
export const SERVER_CAPABILITIES = {
  name: 'dicoclerk',
  version: '1.0.0',
  description:
    'Discord voice meeting clerk — joins voice channels, performs real-time ' +
    'STT via Deepgram with speaker diarization, and generates structured ' +
    'meeting minutes. Supports Korean (ko) and English (en).',
  capabilities: {
    tools: true,
    resources: false,
    prompts: false,
  },
  categories: {
    voice: [
      'join_voice_channel',
      'leave_voice_channel',
    ],
    session_management: [
      'start_session', 'start_recording',
      'stop_session',  'stop_recording',
      'list_sessions',
    ],
    session_queries: [
      'get_session', 'get_status', 'get_transcript', 'get_minutes',
    ],
    content_retrieval: [
      'search_minutes', 'search_meeting_minutes',
      'summarize_minutes', 'get_meeting_minutes',
    ],
    storage_queries: [
      'list_recordings',
    ],
  },
  languages: ['ko', 'en', 'multi'],
  transport: ['stdio', 'sse'],
  standalone_mode: true,
};

// ---------------------------------------------------------------------------
// Utility: get manifest as plain JSON (for Openclaw discovery endpoint)
// ---------------------------------------------------------------------------

/**
 * Serialize the complete tool manifest registry to a plain JSON-compatible
 * object.  This is what an Openclaw agent or any MCP inspector would consume
 * to understand all available tools without running the server.
 *
 * @returns {{ server: object, tools: object[] }}
 */
export function getDiscoveryPayload() {
  return {
    server: SERVER_CAPABILITIES,
    tools: Object.values(TOOL_MANIFESTS).map(({ name, description, inputSchema, outputSchema, metadata }) => ({
      name,
      description,
      inputSchema,
      outputSchema,
      metadata,
    })),
  };
}
