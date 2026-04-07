/**
 * LLM-based Meeting Minutes Content Processor
 *
 * Sends the full meeting transcript to an LLM and returns structured
 * AI-generated content for the summary, decisions, and action items
 * sections. Results are injected into the minutes template in formatter.js,
 * replacing the heuristic-only output when an API key is available.
 *
 * Supported providers (checked in priority order):
 *   1. OpenAI-compatible API  → OPENAI_API_KEY  (+ optional LLM_BASE_URL)
 *   2. Anthropic Claude API   → ANTHROPIC_API_KEY
 *
 * Additional env variables:
 *   LLM_MODEL        - Override the default model for the chosen provider
 *   LLM_BASE_URL     - Override the base URL (e.g. for Azure / local proxies)
 *   LLM_TIMEOUT_MS   - API call timeout in ms (default: 60000)
 *
 * Graceful fallback: returns null when
 *   - No API key is configured
 *   - The network call fails or times out
 *   - The response JSON cannot be parsed
 * In all fallback cases the caller falls back to heuristic extraction.
 */

import { env } from 'node:process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-haiku-20240307',
};

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

/** Max transcript characters to send to the LLM (prevents huge token usage) */
const MAX_TRANSCRIPT_CHARS = 12_000;

/** Max transcript entries included before trimming */
const MAX_TRANSCRIPT_ENTRIES = 150;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AiActionItem
 * @property {string}      task      - Action item description
 * @property {string|null} assignee  - Responsible person (or null)
 * @property {string|null} deadline  - Deadline phrase (or null)
 */

/**
 * @typedef {Object} AiMinutesContent
 * @property {string|null}         summary     - AI-generated narrative summary
 * @property {string[]|null}       decisions   - List of decisions
 * @property {AiActionItem[]|null} actionItems - Structured action items
 * @property {string}              provider    - Which provider was used ('openai'|'anthropic')
 */

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Process transcript through an LLM to generate AI-enhanced meeting minutes
 * content (summary, decisions, action items).
 *
 * Returns null gracefully when no key is configured or the LLM call fails,
 * allowing the caller to fall back to heuristic extraction.
 *
 * @param {Array<{speaker: number|string, text: string, start: number, end: number, isFinal: boolean}>} transcript
 * @param {{ language?: string, channelName?: string, guildName?: string, startedBy?: string, durationSeconds?: number, speakerMap?: Map<number|string,string> }} metadata
 * @returns {Promise<AiMinutesContent|null>}
 */
export async function processWithLLM(transcript, metadata) {
  const openaiKey = env.OPENAI_API_KEY;
  const anthropicKey = env.ANTHROPIC_API_KEY;

  if (!openaiKey && !anthropicKey) {
    console.log('[LLMProcessor] No LLM API key configured — skipping AI-enhanced processing');
    return null;
  }

  const finalEntries = (transcript ?? []).filter(e => e.isFinal);
  if (finalEntries.length === 0) {
    console.log('[LLMProcessor] Empty transcript — skipping AI processing');
    return null;
  }

  const provider = openaiKey ? 'openai' : 'anthropic';
  const apiKey   = openaiKey ?? anthropicKey;

  console.log(`[LLMProcessor] Processing ${finalEntries.length} transcript entries with ${provider}…`);

  try {
    const result = provider === 'openai'
      ? await _callOpenAI(finalEntries, metadata, apiKey)
      : await _callAnthropic(finalEntries, metadata, apiKey);

    console.log(
      `[LLMProcessor] AI content generated — summary: ${result.summary ? 'yes' : 'no'}, ` +
      `decisions: ${result.decisions?.length ?? 0}, actionItems: ${result.actionItems?.length ?? 0}`
    );
    return result;
  } catch (err) {
    console.error('[LLMProcessor] LLM call failed — falling back to heuristic extraction:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

/**
 * Call OpenAI (or compatible) chat completions endpoint.
 *
 * @param {Object[]} entries
 * @param {Object} metadata
 * @param {string} apiKey
 * @returns {Promise<AiMinutesContent>}
 */
async function _callOpenAI(entries, metadata, apiKey) {
  const model   = env.LLM_MODEL ?? DEFAULT_MODELS.openai;
  const baseUrl = env.LLM_BASE_URL ?? OPENAI_BASE_URL;
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  const { systemPrompt, userPrompt } = _buildPrompt(entries, metadata);

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' },
  });

  const response = await _fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return { ..._parseResponse(content), provider: 'openai' };
}

/**
 * Call Anthropic Messages API.
 *
 * @param {Object[]} entries
 * @param {Object} metadata
 * @param {string} apiKey
 * @returns {Promise<AiMinutesContent>}
 */
async function _callAnthropic(entries, metadata, apiKey) {
  const model   = env.LLM_MODEL ?? DEFAULT_MODELS.anthropic;
  const baseUrl = env.LLM_BASE_URL ?? ANTHROPIC_BASE_URL;
  const timeoutMs = Number(env.LLM_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  const { systemPrompt, userPrompt } = _buildPrompt(entries, metadata);

  const body = JSON.stringify({
    model,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  });

  const response = await _fetchWithTimeout(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type':       'application/json',
      'x-api-key':          apiKey,
      'anthropic-version':  ANTHROPIC_VERSION,
    },
    body,
  }, timeoutMs);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data?.content?.[0]?.text ?? '';
  return { ..._parseResponse(content), provider: 'anthropic' };
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

/**
 * Build the system and user prompts for the LLM.
 *
 * @param {Object[]} entries  - Final transcript entries
 * @param {Object}   metadata - Session metadata
 * @returns {{ systemPrompt: string, userPrompt: string }}
 */
export function _buildPrompt(entries, metadata) {
  const language      = metadata?.language ?? 'ko';
  const channelName   = metadata?.channelName ?? 'Unknown Channel';
  const speakerMap    = metadata?.speakerMap ?? new Map();
  const durationSec   = metadata?.durationSeconds ?? 0;
  const durationMin   = Math.round(durationSec / 60);

  const isKo = language !== 'en';

  // Resolve speaker names for the transcript text
  const transcriptText = _buildTranscriptText(entries, speakerMap);

  // -----------------------------------------------------------------------
  // System prompt
  // -----------------------------------------------------------------------
  const systemPrompt = isKo
    ? [
        '당신은 회의 내용을 분석하는 전문 비서입니다.',
        '주어진 회의 녹취록을 바탕으로 구조화된 회의록 내용을 JSON 형식으로 생성합니다.',
        '반드시 유효한 JSON만 반환하고 다른 텍스트는 포함하지 마세요.',
        '내용은 간결하고 사실에 근거해야 합니다. 추측하지 마세요.',
      ].join('\n')
    : [
        'You are an expert meeting analyst assistant.',
        'You analyze meeting transcripts and produce structured meeting minutes content as JSON.',
        'Return only valid JSON, no other text.',
        'Be concise and factual. Do not infer or speculate beyond what was said.',
      ].join('\n');

  // -----------------------------------------------------------------------
  // User prompt
  // -----------------------------------------------------------------------
  const schemaDesc = isKo
    ? `다음 JSON 스키마로 응답하세요:
{
  "summary": "회의 전체 내용을 설명하는 2~4문장의 요약 (한국어)",
  "decisions": [
    "결정된 사항 1",
    "결정된 사항 2"
  ],
  "actionItems": [
    {
      "task": "수행해야 할 작업 내용",
      "assignee": "담당자 이름 또는 null",
      "deadline": "기한 표현 또는 null"
    }
  ]
}

지침:
- summary: 회의에서 논의된 내용, 주요 결과, 전반적인 방향을 요약하세요.
- decisions: 명확하게 결정된 사항만 포함하세요. 없으면 빈 배열 []로 반환하세요.
- actionItems: 명확한 실행 항목만 포함하세요. 없으면 빈 배열 []로 반환하세요.
- 담당자와 기한이 명시되지 않은 경우 null을 사용하세요.`
    : `Respond with this exact JSON schema:
{
  "summary": "2-4 sentence narrative summary of the entire meeting",
  "decisions": [
    "Decision made #1",
    "Decision made #2"
  ],
  "actionItems": [
    {
      "task": "Description of the action item",
      "assignee": "Person's name or null",
      "deadline": "Deadline phrase or null"
    }
  ]
}

Guidelines:
- summary: Describe what was discussed, key outcomes, and overall direction.
- decisions: Only include clearly stated decisions. Return [] if none.
- actionItems: Only include concrete next-step tasks. Return [] if none.
- Use null for assignee/deadline when not explicitly stated.`;

  const contextHeader = isKo
    ? `채널: ${channelName} | 회의 시간: ${durationMin}분\n\n회의 녹취록:\n`
    : `Channel: ${channelName} | Duration: ${durationMin} minutes\n\nMeeting transcript:\n`;

  const userPrompt = `${contextHeader}${transcriptText}\n\n${schemaDesc}`;

  return { systemPrompt, userPrompt };
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

/**
 * Parse LLM response text into structured AiMinutesContent.
 *
 * Handles:
 *   - Raw JSON string
 *   - JSON wrapped in markdown code fences (```json ... ```)
 *   - Partial/malformed JSON by returning safe defaults
 *
 * @param {string} text - Raw LLM response content
 * @returns {Omit<AiMinutesContent, 'provider'>}
 */
export function _parseResponse(text) {
  const empty = { summary: null, decisions: null, actionItems: null };

  if (!text || typeof text !== 'string') return empty;

  // Strip markdown code fences if present
  let jsonStr = text.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to extract JSON object from mixed text (e.g. leading explanation)
    const jsonObjMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!jsonObjMatch) return empty;
    try {
      parsed = JSON.parse(jsonObjMatch[0]);
    } catch {
      console.warn('[LLMProcessor] Failed to parse LLM response JSON');
      return empty;
    }
  }

  if (!parsed || typeof parsed !== 'object') return empty;

  return {
    summary:     typeof parsed.summary === 'string' && parsed.summary.trim()
                   ? parsed.summary.trim()
                   : null,
    decisions:   Array.isArray(parsed.decisions)
                   ? parsed.decisions
                       .filter(d => typeof d === 'string' && d.trim())
                       .map(d => d.trim())
                   : null,
    actionItems: Array.isArray(parsed.actionItems)
                   ? parsed.actionItems
                       .filter(a => a && typeof a === 'object' && typeof a.task === 'string' && a.task.trim())
                       .map(a => ({
                         task:     a.task.trim(),
                         assignee: (typeof a.assignee === 'string' && a.assignee.trim()) ? a.assignee.trim() : null,
                         deadline: (typeof a.deadline === 'string' && a.deadline.trim()) ? a.deadline.trim() : null,
                       }))
                   : null,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert transcript entries to a readable text for inclusion in the prompt.
 * Truncates to MAX_TRANSCRIPT_ENTRIES and MAX_TRANSCRIPT_CHARS.
 *
 * @param {Object[]} entries   - Final transcript entries
 * @param {Map}      speakerMap
 * @returns {string}
 */
function _buildTranscriptText(entries, speakerMap) {
  const limited = entries.slice(0, MAX_TRANSCRIPT_ENTRIES);
  const lines = [];

  for (const entry of limited) {
    const name = _resolveName(entry.speaker, speakerMap);
    const ts   = _formatTs(entry.start);
    lines.push(`[${ts}] ${name}: ${entry.text}`);
  }

  let text = lines.join('\n');

  // Hard character limit to stay within model context windows
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS);
    // Trim to last complete line
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline > MAX_TRANSCRIPT_CHARS * 0.8) {
      text = text.slice(0, lastNewline);
    }
    text += '\n[... transcript truncated ...]';
  }

  if (entries.length > MAX_TRANSCRIPT_ENTRIES) {
    text += `\n[... ${entries.length - MAX_TRANSCRIPT_ENTRIES} more entries omitted ...]`;
  }

  return text;
}

/**
 * Resolve a speaker ID to a display name.
 * @param {number|string} id
 * @param {Map}           speakerMap
 * @returns {string}
 */
function _resolveName(id, speakerMap) {
  if (speakerMap instanceof Map && speakerMap.has(id)) return speakerMap.get(id);
  if (id === null || id === undefined || id === -1) return 'Unknown';
  return `Speaker ${id}`;
}

/**
 * Format seconds as MM:SS string.
 * @param {number} seconds
 * @returns {string}
 */
function _formatTs(seconds) {
  const m = Math.floor((seconds ?? 0) / 60);
  const s = Math.floor((seconds ?? 0) % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Fetch with an AbortController-based timeout.
 *
 * @param {string}        url
 * @param {RequestInit}   options
 * @param {number}        timeoutMs
 * @returns {Promise<Response>}
 */
async function _fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`LLM API request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
