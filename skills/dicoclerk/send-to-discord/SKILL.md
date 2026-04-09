---
name: send-to-discord
description: >-
  Send a meeting report PDF (or Markdown) to a configured Discord channel.
  Reads channel config from ~/.dicoclerk/config.json.
  On first use, asks the user which channel to use and remembers the choice.
allowed-tools: Bash(ls:*), Bash(cat:*), Bash(curl:*), Read(*), Write(*)
metadata: >-
  {"openclaw":{"emoji":"📨"}}
---

# Send Report to Discord

You send completed meeting reports to a Discord text channel.

## Usage

```
/send-to-discord <file_path>
```

If no file path is provided, find the most recently created `.pdf` file in `~/.dicoclerk/reports/`. If no PDF exists, use the most recent `.md` file instead.

## Instructions

1. **Read configuration**: Try to read `~/.dicoclerk/config.json` for `discord_channel_id` and `discord_channel_name`.

2. **If no config exists or channel not set**:
   - Ask the user: "Which Discord channel should I send meeting reports to? Please provide the channel name or ID (e.g., #meeting-reports or 1234567890)."
   - Once the user responds, save to `~/.dicoclerk/config.json`:
     ```json
     {
       "discord_channel_id": "<id>",
       "discord_channel_name": "<name>",
       "default_language": "ko"
     }
     ```
   - Confirm: "Got it! I'll send reports to #channel-name from now on. You can change this anytime by editing ~/.dicoclerk/config.json."

3. **Send the file**: Send the PDF (or markdown) file as an attachment to the configured Discord channel. Include a summary message:

   > **Meeting Report Ready**
   > Date: YYYY-MM-DD
   > Duration: X minutes
   > Participants: N
   > See attached PDF for the full report.

4. **Confirm delivery**: After sending, inform the user: "Report sent to #channel-name."

## Error Handling

- config.json missing or malformed: Create a fresh config by asking the user.
- File not found: "Could not find the report file at [path]. Check ~/.dicoclerk/reports/ for available reports."
- Discord send fails: "Failed to send the report to Discord. Check that the bot has Send Messages and Attach Files permissions in the target channel."
- Channel not accessible: "Cannot access channel [name/id]. Verify the channel exists and the bot has permission. Run `/send-to-discord` again to reconfigure."

## Notes

- The channel configuration is persistent. Once set, all future reports go to the same channel automatically.
- To change the target channel, either edit `~/.dicoclerk/config.json` directly or delete it and run this skill again.
