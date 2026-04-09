---
name: transcript-to-report
description: >-
  Convert a meeting transcript into a structured report with executive summary,
  discussion topics, action items, and decisions. Reads from ~/.dicoclerk/transcripts/
  and writes to ~/.dicoclerk/reports/.
allowed-tools: Bash(ls:*), Bash(date:*), Bash(wc:*), Bash(head:*), Bash(stat:*), Read(*), Write(*)
metadata: >-
  {"openclaw":{"emoji":"📝"}}
---

# Transcript to Report

You convert voice meeting transcripts into structured, professional meeting reports.

## Usage

```
/transcript-to-report <transcript_file_path>
```

If no file path is provided, find the most recently modified `.md` file in `~/.dicoclerk/transcripts/`.

## Instructions

1. **Read the transcript file**. If the file does not exist or is empty, inform the user: "No transcript found at [path]. Run `/recording-start` first to create a transcript."

2. **Analyze the transcript** and generate a structured meeting report with these sections:

```markdown
# Meeting Report

## Meeting Info
- **Date:** YYYY-MM-DD
- **Time:** HH:MM - HH:MM
- **Duration:** X minutes
- **Participants:** Name1, Name2, ...
- **Source transcript:** filename.md

## Executive Summary
(2-3 sentences summarizing the key outcomes of the meeting)

## Discussion Topics
### Topic 1: (topic title)
- **Time range:** HH:MM - HH:MM
- **Key points:**
  - point 1
  - point 2

### Topic 2: ...

## Action Items
| # | Task | Assignee | Deadline |
|---|------|----------|----------|
| 1 | task description | person | date if mentioned |

## Decisions Made
- Decision 1: ...
- Decision 2: ...

## Full Transcript
(include the complete transcript as an appendix)
```

3. **Save the report** to `~/.dicoclerk/reports/report_YYYY-MM-DD_HH-MM.md` using the same timestamp as the source transcript.

4. **Trigger PDF conversion**: After saving, invoke: `/report-to-pdf <path to report file>`

## Error Handling

- No transcript files found: "No transcripts in ~/.dicoclerk/transcripts/. Record a meeting first with /recording-start."
- Empty or malformed transcript: "Transcript file is empty or could not be parsed. Skipping report generation."
- Write failure: Show the OS error and suggest checking disk space and permissions.

## Guidelines

- Write the report in the same language as the transcript (Korean or English).
- If the transcript is in Korean, write all section headers in Korean as well.
- Keep the executive summary concise (2-3 sentences max).
- Only include action items that were explicitly discussed — do not invent tasks.
- If no decisions were made, write "No explicit decisions were recorded."
