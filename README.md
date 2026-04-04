# dicoclerk

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Discord voice channel meeting clerk — Real-time speech-to-text with speaker diarization, automatic meeting minutes generation, and MCP server integration.

dicoclerk joins Discord voice channels, captures audio in real-time via Deepgram's STT engine with speaker identification, deduplicates utterances using four intelligent strategies, and generates structured meeting minutes with participant lists, summaries, and action items. Designed for teams using Korean/English bilingual meetings.

---

## Features

- **Slash Commands**: `/start` to begin recording, `/stop` to end and auto-generate minutes
- **Real-Time STT with Speaker Diarization**: Deepgram's nova-2 model identifies speakers in live audio (한국어/영어 지원)
- **4 Deduplication Strategies**: Content fingerprinting, speaker identity matching, timestamp proximity, and fuzzy similarity (Levenshtein distance)
- **Structured Meeting Minutes**: Auto-formatted markdown with date/time, participants, summary, key discussion points, action items, and full transcript
- **Auto-Disconnect**: Bot leaves voice channel when it becomes empty
- **Connection Resilience**: Deepgram auto-reconnect with exponential backoff (configurable max retries)
- **Connection Pool**: Supports 5-10 concurrent speakers via optional multi-connection pooling
- **MCP Server Mode**: 10 tools for external agent integration (session management, transcript/minutes queries, contextual search, summarization)
- **Meeting History Search**: Find and retrieve past minutes by date, participants, keywords, channel name
- **Standalone Operation**: Works without Openclaw or external agents — can run as pure Discord bot
- **Interactive Installer**: `setup.sh` guides you through Discord bot configuration and API key setup
- **Data Persistence**: Stores transcripts, minutes, and meeting index locally on disk

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Discord Client                              │
│  (/start, /stop slash commands + voice state events)            │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Session Manager                                 │
│  (Tracks active sessions per guild, voice connection lifecycle) │
└─────────────────────────────────────────────────────────────────┘
                            │
        ┌───────────────────┴───────────────────┐
        ▼                                       ▼
┌──────────────────────┐          ┌──────────────────────┐
│ Audio Capture &      │          │   Deepgram STT       │
│ Session Coordinator  │◄────────►│  (Connection Pool)   │
│ (per voice channel)  │          │  (nova-2, diarization)
└──────────────────────┘          └──────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Deduplication Engine                           │
│  (Fingerprint, Similarity, Timestamp, Fuzzy Matching)           │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│              Minutes Generator & Formatter                        │
│  (Markdown formatting, index storage, Discord delivery)          │
└──────────────────────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────────┐
│          Data Directory (./data by default)                      │
│  ├─ transcripts/  (raw STT output)                               │
│  ├─ minutes/      (formatted meeting minutes)                    │
│  └─ recordings/   (optional: Discord audio files)                │
└──────────────────────────────────────────────────────────────────┘

Optional: MCP Server Mode
┌──────────────────────────────────────────────────────────────────┐
│              MCP Server (npm run mcp)                             │
│  (10 tools: session control, queries, search, summarization)    │
│  (Integrates with Openclaw or other agents)                      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- **Node.js** 20.0 or later
- **Discord Bot Token** (from [Discord Developer Portal](https://discord.com/developers/applications))
  - Intents required: MESSAGE CONTENT, GUILD VOICE STATES, GUILD MEMBERS
  - Permissions needed: Connect to voice, Speak in voice, Send messages, Attach files, Use application commands
- **Deepgram API Key** (from [Deepgram Console](https://console.deepgram.com))
  - Free tier: $200 in monthly credits
- **Git** (for cloning the repository)

---

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/dicoclerk.git
cd dicoclerk
```

### 2. Run the Interactive Installer

```bash
bash setup.sh
```

The installer will:
- Prompt for your Discord bot token and client ID
- Ask for optional Discord guild/channel IDs (recommended for faster development)
- Request your Deepgram API key
- Let you choose language support (Korean, English, or multi-language)
- Create the `.env` configuration file
- Install Node.js dependencies
- Register `/start` and `/stop` slash commands

### 3. Start the Bot

```bash
npm start
```

The bot will log in and appear in your Discord server. You'll see:
```
✅ dicoclerk is online as YourBotName#1234
   Guilds: 1
```

### 4. Test in Discord

1. Join a voice channel in your server
2. Type `/start` to begin recording
3. Speak! The bot will transcribe in real-time
4. Type `/stop` to end the session and generate minutes
5. Minutes appear in the text channel as a markdown file within 1–2 minutes

---

## Configuration

Create a `.env` file or run `setup.sh` to populate it automatically. The file follows this structure:

```bash
# Discord Bot Configuration
DISCORD_TOKEN=your_discord_bot_token_here
DISCORD_CLIENT_ID=your_discord_client_id_here

# Optional: Guild ID for development (faster command registration)
DISCORD_GUILD_ID=your_guild_id

# Optional: Default text channel for posting meeting minutes
MINUTES_CHANNEL_ID=your_text_channel_id

# Deepgram API Configuration
DEEPGRAM_API_KEY=your_deepgram_api_key_here

# Language settings: ko (Korean only), en (English only), or multi (both)
STT_LANGUAGE=multi

# Data storage directory (transcripts, minutes, recordings)
DATA_DIR=./data
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot authentication token |
| `DISCORD_CLIENT_ID` | Yes | Application ID for OAuth2 and command registration |
| `DISCORD_GUILD_ID` | No | Server ID for dev mode (speeds up command registration from ~15min to ~1sec) |
| `MINUTES_CHANNEL_ID` | No | Default text channel for minutes (can override per session) |
| `DEEPGRAM_API_KEY` | Yes | Deepgram API key for STT |
| `STT_LANGUAGE` | No | Language code: `ko`, `en`, or `multi` (default: `multi`) |
| `DATA_DIR` | No | Local directory for transcripts/minutes (default: `./data`) |

---

## Usage

### Slash Commands

#### `/start`

Joins your current voice channel and begins recording.

**Options:**
- `language` (optional): Override default language for this session
  - `ko` — Korean only
  - `en` — English only
  - `multi` — Auto-detect Korean and English

**Response:**
```
✅ **Recording started** in #voice-channel
🎙️ Language: **Korean + English**
👤 Started by: **yourname#1234**
🔊 Speech recognition: **Active**

Use `/stop` to end the session and generate meeting minutes.
```

**Requirements:**
- You must be in a voice channel
- Only one active session per server
- Bot must have voice channel permissions

#### `/stop`

Ends the recording session, finalizes the transcript, and triggers minutes generation.

**Response:**
```
✅ **Session ended**
⏱️ Duration: **12m 34s**
👥 Participants: **4**
📝 Transcript entries: **156**

Meeting minutes will be generated and posted within 1–2 minutes.
```

### Live Status Messages

While recording, the bot sends status updates to the text channel:

- **Deepgram reconnection**: `⚠️ Speech recognition connection interrupted. Reconnecting... (attempt 1/5)`
- **Reconnection success**: `✅ Speech recognition reconnected. Transcription continues.`
- **Permanent failure**: `❌ **Speech recognition connection lost permanently.** Partial transcript has been saved...`
- **Channel empty**: `✅ Recording auto-stopped (channel emptied). Processing...`

### Meeting Minutes Format

Generated minutes are markdown files with this structure:

```markdown
# Meeting Minutes: Project Planning Session
**Date:** 2025-04-03 | **Time:** 14:30–14:42 (12m 34s)  
**Channel:** #team-standup  
**Language:** Korean, English  

## Attendees (4 participants)
- Alice (8 utterances, 2m 15s)
- Bob (6 utterances, 1m 42s)
- Charlie (5 utterances, 1m 08s)
- Diana (4 utterances, 0m 49s)

## Summary
Key topics discussed: Project timeline, resource allocation, Q2 roadmap updates.

## Key Discussion Points
- **Timeline**: Q2 launch target confirmed; engineering team needs 2 additional weeks.
- **Resources**: Budget approval for cloud infrastructure in progress.
- **Dependencies**: Marketing content needs finalization by April 10.

## Action Items
1. **Alice** — Update project charter by 2025-04-08
2. **Bob** — Prepare resource estimates by 2025-04-06
3. **Charlie** — Coordinate with marketing on content timeline

## Full Transcript
**Alice** [00:05–00:12] "Good afternoon everyone. Let's start with the Q2 roadmap."

**Bob** [00:15–00:28] "Yep, we reviewed the timeline yesterday. Engineering needs about two more weeks..."
...
```

Minutes are automatically:
- Saved to `./data/minutes/YYYY-MM-DD_HH-MM-SS_GuildName_ChannelName.md`
- Posted to the text channel as an attachment
- Indexed in `./data/minutes/index.jsonl` for search

---

## MCP Server Mode

dicoclerk includes an MCP (Model Context Protocol) server for integration with external agents like Openclaw.

### Starting the MCP Server

```bash
npm run mcp
```

Server listens on stdio (agent connection).

### Available Tools (10 total)

#### Session Management

**`start_session`**
Start a new recording session in a voice channel.

Parameters:
- `guild_id` (string, required): Discord guild ID
- `voice_channel_id` (string, required): Voice channel ID to record
- `text_channel_id` (string, required): Text channel for status/minutes
- `language` (enum: 'ko'|'en'|'multi', optional): STT language (default: 'multi')

Returns: `{ success, session_id, message }`

**`stop_session`**
Stop an active recording session.

Parameters:
- `guild_id` (string, required): Guild with active session

Returns: `{ success, duration, transcriptCount, minutesPath }`

**`list_sessions`**
List all active recording sessions across all guilds.

Returns: `{ sessions: [ { guild_id, channel_id, started_at, duration, participants } ] }`

#### Session Queries

**`get_session`**
Get details of a specific session.

Parameters:
- `guild_id` (string, required): Guild ID

Returns: `{ session: { guildId, channelId, startedAt, duration, participants, status } }`

**`get_transcript`**
Get the current or completed transcript.

Parameters:
- `guild_id` (string, required): Guild ID
- `format` (enum: 'raw'|'formatted', optional): Output format (default: 'formatted')

Returns: `{ transcript: [ { speaker, text, timestamp, confidence, isFinal } ] }`

**`get_minutes`**
Get generated meeting minutes for a session.

Parameters:
- `guild_id` (string, required): Guild ID
- `session_id` (string, optional): Specific session (defaults to latest)

Returns: `{ minutes: markdown_content }`

#### Storage & Search

**`list_recordings`**
List all stored transcripts and minutes on disk.

Parameters:
- `limit` (number, optional): Max results (default: 20)
- `guild_id` (string, optional): Filter by guild ID

Returns: `{ recordings: [ { date, guild_name, channel_name, participants, duration } ] }`

**`search_minutes`**
Search meeting minutes by date, channel, participants, or free-text.

Parameters:
- `query` (string, optional): Free-text search
- `guild_id` (string, optional): Filter by guild
- `channel_name` (string, optional): Partial channel name match
- `participant` (string, optional): Partial participant name match
- `date_from` (string, optional): Start date (YYYY-MM-DD)
- `date_to` (string, optional): End date (YYYY-MM-DD)
- `language` (string, optional): Language code (ko/en)
- `limit` (number, optional): Max results (default: 20)
- `offset` (number, optional): Pagination offset (default: 0)

Returns: `{ results: [ { date, guild_name, channel_name, participants, duration } ] }`

**`search_meeting_minutes`**
Search and retrieve previous minutes with full markdown content.

Parameters:
- `query` (string, optional): Free-text search across metadata and content
- `guild_id` (string, optional): Filter by guild
- `channel_name` (string, optional): Partial channel match
- `participant` (string, optional): Partial participant match
- `date_from` (string, optional): Start date (YYYY-MM-DD)
- `date_to` (string, optional): End date (YYYY-MM-DD)
- `keywords` (array of strings, optional): Search content for keywords
- `language` (string, optional): Language code
- `limit` (number, optional): Max results (default: 5)
- `offset` (number, optional): Pagination offset
- `include_content` (boolean, optional): Include full markdown (default: true)

Returns: `{ results: [ { date, guild_name, channel_name, participants, content } ] }`

**`summarize_minutes`**
Generate condensed contextual summaries from past minutes.

Parameters:
- `query` (string, optional): Search/filter criteria
- `guild_id` (string, optional): Filter by guild
- `date_from` (string, optional): Start date
- `date_to` (string, optional): End date
- `summarize_count` (number, optional): Number of meetings to summarize (default: 5)
- `context_type` (string, optional): Summary type ('executive', 'detailed', or 'quick')

Returns: `{ summary: contextual_narrative, references: [ { date, source } ] }`

---

## Project Structure

```
dicoclerk/
├── README.md                          # This file
├── LICENSE                            # MIT license
├── package.json                       # Dependencies & npm scripts
├── .env.example                       # Configuration template
├── setup.sh                           # Interactive installer
│
├── src/
│   ├── index.js                       # Main Discord bot entry point
│   ├── deploy-commands.js             # Register /start, /stop commands
│   ├── mcp-server.js                  # MCP server entry point
│   │
│   ├── commands/
│   │   ├── start.js                   # /start slash command handler
│   │   └── stop.js                    # /stop slash command handler
│   │
│   ├── voice/
│   │   ├── session-manager.js         # Session lifecycle & voice connection pool
│   │   └── connection-manager.js      # Discord voice connection wrapper
│   │
│   ├── audio/
│   │   ├── session-coordinator.js     # Orchestrates audio capture & Deepgram
│   │   └── audio-capture-pipeline.js  # Subscribes to voice receiver, forwards audio
│   │
│   ├── stt/
│   │   ├── deepgram-client.js         # Deepgram streaming client (nova-2 + diarization)
│   │   ├── connection-pool.js         # Multi-connection pooling for 5-10 speakers
│   │   ├── connection-resilience.js   # Auto-reconnect with exponential backoff
│   │   └── dedup.js                   # 4 deduplication strategies
│   │
│   ├── minutes/
│   │   ├── generator.js               # End-to-end minutes generation pipeline
│   │   ├── formatter.js               # Markdown formatting logic
│   │   ├── summarizer.js              # Heuristic summary extraction
│   │   └── index-store.js             # Meeting index (JSONL file storage)
│   │
│   ├── session/
│   │   └── session-cleanup.js         # Shared teardown (Deepgram, transcript, voice)
│   │
│   └── mcp/
│       ├── server.js                  # MCP server setup & lifecycle
│       ├── tools.js                   # Tool definitions (10 tools)
│       ├── handlers.js                # Tool implementation logic
│       ├── transport.js               # Stdio transport for MCP
│       └── index.js                   # MCP module exports
│
├── tests/
│   ├── *.test.js                      # Node.js test files (using built-in test runner)
│   └── *.py                           # Python test utilities
│
└── data/                              # (Auto-created by setup.sh)
    ├── transcripts/                   # Raw STT output (JSON)
    ├── minutes/                       # Formatted meeting minutes (Markdown)
    │   └── index.jsonl                # Meeting index for search
    └── recordings/                    # Optional: Discord audio files
```

---

## Deduplication Strategies

dicoclerk uses four complementary deduplication methods to clean up real-time STT output:

1. **Content Fingerprinting**: SHA-256 hash of normalized text + speaker ID. Fast exact-match detection.
2. **Speaker Identity Matching**: Only treats utterances as duplicates if from the same speaker.
3. **Timestamp Proximity**: Utterances within a configurable time window are checked; older utterances outside the window are safe.
4. **Fuzzy Similarity (Levenshtein)**: For near-duplicates (typos, partial repeats), calculates edit distance and matches if above a similarity threshold (default: 0.75).

Configuration (in dedup.js):
```javascript
const DEFAULT_DEDUP_CONFIG = {
  timeWindow: 5.0,           // Seconds
  similarityThreshold: 0.75, // 0.0–1.0
  windowSize: 100,           // Utterances
  deduplicateInterim: true,  // Treat interim results as replaceable
  exactMatchWindow: 10.0,    // Seconds for exact-match grace period
};
```

---

## Connection Resilience

Deepgram connections may fail due to network issues or API rate limiting. dicoclerk automatically:

1. **Detects** connection loss
2. **Waits** with exponential backoff (1s → 2s → 4s → 8s, configurable max 60s)
3. **Reconnects** up to 5 attempts (configurable)
4. **Notifies** the text channel on attempt and success/failure
5. **Falls back** to partial transcript if reconnection exhausts retries

Configuration (in connection-resilience.js):
```javascript
const RECONNECT_DEFAULTS = {
  maxAttempts: 5,           // Max reconnection attempts
  initialDelayMs: 1000,     // 1 second
  maxDelayMs: 60000,        // Cap at 60 seconds
  backoffMultiplier: 2.0,   // Exponential growth
};
```

---

## Auto-Disconnect

When the voice channel becomes empty (last participant leaves), the bot automatically:

1. Waits 2 seconds (configurable grace period to prevent false positives from switching channels)
2. Checks if the channel is still empty
3. Stops audio capture and Deepgram connection
4. Generates and delivers minutes
5. Leaves the voice channel
6. Posts a cleanup summary to the text channel

---

## Testing

Run the full test suite:

```bash
npm test
```

This executes all `.test.js` files in the `tests/` directory using Node.js's built-in test runner.

**Test coverage includes:**
- Audio capture pipeline and session coordination
- Connection pool management and resilience
- Deduplication strategies (all 4 variants)
- Formatter output and markdown structure
- Minutes generator and file I/O
- Index-store (JSONL queries)
- MCP server and tool handlers
- Slash command validation
- Session lifecycle and cleanup

---

## Development

### Auto-Reload Mode

For rapid iteration:

```bash
npm run dev
```

Uses Node.js `--watch` to restart on file changes.

### Reregister Slash Commands

If you modify command definitions:

```bash
npm run deploy-commands
```

Commands register globally (~15 minutes) or to your dev guild instantly (if `DISCORD_GUILD_ID` is set).

### Environment Debugging

Check your configuration:

```bash
cat .env
```

Ensure all required variables are set and non-empty.

---

## Troubleshooting

### Bot doesn't respond to `/start`

1. **Verify slash commands are registered**:
   - Right-click bot in Discord → Check for `/start` and `/stop` commands
   - If missing, run: `npm run deploy-commands`

2. **Check bot permissions**:
   - Right-click server → Server Settings → Roles → dicoclerk role
   - Ensure "Connect to voice", "Speak in voice", "Send messages", "Attach files" are enabled

3. **Confirm intents**:
   - Go to Discord Developer Portal → Your App → Bot
   - Enable: MESSAGE CONTENT, GUILD VOICE STATES, GUILD MEMBERS

### "Deepgram API key is not configured"

- Set `DEEPGRAM_API_KEY` in `.env`
- Restart the bot: `npm start`

### Bot joins voice but no transcript appears

1. **Check Deepgram API key validity**:
   - Visit https://console.deepgram.com and verify your key hasn't expired
   - Ensure your account has available credits

2. **Check bot audio permissions**:
   - Server Settings → Roles → dicoclerk → Voice Permissions
   - Enable: "Connect", "Speak", "Use Voice Activity"

3. **Check bot can see voice channel**:
   - Server Settings → Channels → voice-channel → Permissions
   - Ensure dicoclerk role has "Connect" and "View Channel" permissions

### Minutes not generated

1. **Check `/stop` was executed successfully**:
   - Look for cleanup message in text channel (transcript count, duration)

2. **Check file permissions**:
   - Ensure `./data/minutes/` directory is writable: `ls -la data/`

3. **Check logs**:
   - Look for `[MinutesGenerator]` messages in bot console output

### High Deepgram costs

- Use `STT_LANGUAGE=ko` or `STT_LANGUAGE=en` instead of `multi` to reduce processing
- Shorter sessions = lower costs
- Monitor real-time usage at https://console.deepgram.com/usage

---

## Performance Notes

- **Typical session**: 30 participants, 1 hour → ~2–3 MB transcript, 0.5–1 MB minutes, generates in <2 minutes
- **Connection pool**: Default single connection handles 5–10 speakers comfortably; auto-scales to 2–3 connections under load
- **Minutes storage**: ~1 KB per minute of meeting time (markdown)
- **Deduplication overhead**: <50ms per utterance (negligible)

---

## License

MIT. See [LICENSE](LICENSE) for details.

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit with clear messages: `git commit -m "Add feature X"`
4. Push: `git push origin feature/your-feature`
5. Open a Pull Request

---

## Support

- **Documentation**: See [README.md](README.md) and inline code comments
- **Issues**: Open a GitHub issue for bugs or feature requests
- **Discord Help**: Check the [Discord.js](https://discord.js.org) and [Deepgram](https://developers.deepgram.com) docs

---

## Acknowledgments

- [discord.js](https://discord.js.org) — Discord API client
- [Deepgram](https://deepgram.com) — Speech-to-text with speaker diarization
- [@discordjs/voice](https://github.com/discordjs/voice) — Voice channel audio capture
- [Model Context Protocol](https://modelcontextprotocol.io) — Agent integration framework
