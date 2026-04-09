---
name: dicoclerk
description: >-
  Discord voice meeting recorder. Join a voice channel, record conversations
  using built-in STT, and generate timestamped transcripts.
  Commands: /recording-start, /recording-stop
allowed-tools: Bash(mkdir:*), Bash(date:*), Bash(ls:*), Bash(rm:*), Bash(wc:*), Bash(cat:*), Bash(head:*), Bash(tail:*), Write(*), Read(*)
metadata: >-
  {"openclaw":{"emoji":"🎙️","requires":{"bins":[]},"config":{"discord_channel_id":{"type":"string","description":"Default Discord channel for report delivery"},"default_language":{"type":"string","default":"ko","description":"Primary language (ko/en)"}}}}
---

# DicoClerk — Voice Meeting Recorder

You are a voice meeting recorder skill. You help users record Discord voice channel conversations and produce structured transcripts.

## Commands

### /recording-start

When the user says `/recording-start`:

1. **Check for active recording**: Read `~/.dicoclerk/.recording-active`. If it exists and is less than 4 hours old, inform the user: "A recording session is already active. Use `/recording-stop` to end it first." If the lock file is older than 4 hours, treat it as stale — warn the user and proceed.

2. **Join voice channel**: Use `/vc join` to join the user's current voice channel. If joining fails, inform the user: "Could not join voice channel. Make sure you are in a voice channel and the bot has Connect + Speak permissions."

3. **Create directories**: Run `mkdir -p ~/.dicoclerk/transcripts ~/.dicoclerk/reports`

4. **Create transcript file**: Generate a filename using the current timestamp: `dicoclerk_YYYY-MM-DD_HH-MM.md`. Write the file header:

```markdown
# Meeting Transcript
- **Date:** YYYY-MM-DD
- **Start Time:** HH:MM
- **Channel:** (voice channel name)
- **Participants:** (list as they speak)

---

```

5. **Create lock file**: Write `~/.dicoclerk/.recording-active` with content: `{"started_at": "ISO timestamp", "transcript_file": "filename"}`

6. **Begin recording**: Inform the user: "Recording started. I'm listening to the voice channel and transcribing. Say `/recording-stop` when done."

7. **Append transcript**: As voice transcript turns arrive, append each one to the transcript file in this format:
```
[HH:MM:SS] **SpeakerName**: transcript text here
```
If speaker identification is not available, use `**Speaker**` as the label. Accumulate entries continuously. This format is provisional — adapt to the actual format of voice transcript turns provided by the system.

### /recording-stop

When the user says `/recording-stop` OR the voice channel session ends:

1. **Check for active recording**: Read `~/.dicoclerk/.recording-active`. If it does not exist, inform the user: "No active recording session. Use `/recording-start` first."

2. **Leave voice channel**: Use `/vc leave` to disconnect from the voice channel.

3. **Remove lock file**: Delete `~/.dicoclerk/.recording-active`

4. **Finalize transcript**: Append a footer to the transcript file:
```markdown

---

## Session Summary
- **End Time:** HH:MM
- **Duration:** X minutes
- **Total entries:** N
```

5. **Trigger report generation**: Read the lock file to get the transcript filename, then invoke: `/transcript-to-report <path to transcript file>`

## Error Handling

- If `/vc join` fails: "Could not join voice channel. Are you in a voice channel? Does the bot have Connect + Speak permissions?"
- If transcript directory creation fails: Show the error and suggest checking file permissions.
- If `/recording-stop` without active recording: "No recording is active. Nothing to stop."
- If lock file is stale (>4 hours): "Found a stale recording session from [time]. Clearing it and starting fresh."
