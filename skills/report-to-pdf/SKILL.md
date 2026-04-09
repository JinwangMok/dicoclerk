---
name: report-to-pdf
description: >-
  Convert a meeting report Markdown file to PDF.
  Reads from ~/.dicoclerk/reports/ and saves PDF alongside the source.
allowed-tools: Bash(pandoc:*), Bash(xelatex:*), Bash(weasyprint:*), Bash(ls:*), Bash(date:*), Bash(which:*), Read(*), Write(*)
metadata: >-
  {"openclaw":{"emoji":"📄","requires":{"bins":["pandoc"]}}}
---

# Report to PDF

You convert meeting report Markdown files to PDF format.

## Usage

```
/report-to-pdf <report_file_path>
```

If no file path is provided, find the most recently modified `.md` file in `~/.dicoclerk/reports/`.

## Instructions

1. **Locate the report file**. If not found, inform the user: "No report found at [path]. Run /transcript-to-report first."

2. **Check PDF engine availability** (in order of preference):
   - `which xelatex` — Best for Korean/CJK text. Use if available.
   - `which weasyprint` — Good alternative for CJK.
   - `which pandoc` — Fallback with default engine.

3. **Convert to PDF**:
   - If xelatex available:
     ```bash
     pandoc "<input.md>" -o "<output.pdf>" --pdf-engine=xelatex -V mainfont="Noto Sans CJK KR" -V geometry:margin=2.5cm
     ```
   - If weasyprint available:
     ```bash
     pandoc "<input.md>" -o "<output.pdf>" --pdf-engine=weasyprint
     ```
   - Fallback:
     ```bash
     pandoc "<input.md>" -o "<output.pdf>"
     ```

4. **Save PDF** alongside the report: `~/.dicoclerk/reports/report_YYYY-MM-DD_HH-MM.pdf`

5. **Trigger Discord delivery**: After saving, invoke: `/send-to-discord <path to PDF file>`

## Error Handling

- pandoc not installed: "pandoc is required for PDF conversion. Install it: `apt install pandoc` (Linux) or `brew install pandoc` (macOS). Alternatively, install weasyprint: `pip install weasyprint`."
- pandoc conversion fails: Show the stderr output. Common fixes: install texlive-xetex for xelatex engine, or install a CJK font (Noto Sans CJK).
- No report files found: "No reports in ~/.dicoclerk/reports/. Run /transcript-to-report first."
- If all PDF engines fail: Save the report as-is (.md) and inform the user that PDF conversion is not available, but the markdown report is ready.
