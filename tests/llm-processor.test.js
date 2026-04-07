/**
 * Tests for LLM-based Meeting Minutes Processor
 *
 * Covers:
 * - _parseResponse: JSON parsing, markdown fence stripping, graceful fallback
 * - _buildPrompt: language-aware prompt generation, transcript serialization
 * - processWithLLM: no-key fallback, empty transcript, provider selection
 * - formatter.js aiContent injection: summary / decisions / actionItems override
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  processWithLLM,
  _buildPrompt,
  _parseResponse,
} from '../src/minutes/llm-processor.js';

import { formatMeetingMinutes } from '../src/minutes/formatter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTranscript(count = 4) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      speaker: i % 2,
      text: i % 2 === 0
        ? `Alice says something important about the project ${i}.`
        : `Bob responds with an update on task ${i}.`,
      start: i * 15,
      end: i * 15 + 12,
      confidence: 0.95,
      isFinal: true,
    });
  }
  return entries;
}

function makeMetadata(overrides = {}) {
  return {
    language: 'en',
    channelName: 'Team Meeting',
    guildName: 'Test Server',
    startedBy: 'Alice',
    durationSeconds: 300,
    speakerMap: new Map([[0, 'Alice'], [1, 'Bob']]),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// _parseResponse
// ---------------------------------------------------------------------------

describe('LLMProcessor - _parseResponse', () => {
  it('should parse a valid JSON string', () => {
    const json = JSON.stringify({
      summary: 'A productive meeting.',
      decisions: ['Use TypeScript', 'Deploy on Friday'],
      actionItems: [
        { task: 'Write tests', assignee: 'Alice', deadline: 'next Monday' },
        { task: 'Review PR', assignee: null, deadline: null },
      ],
    });

    const result = _parseResponse(json);
    assert.equal(result.summary, 'A productive meeting.');
    assert.deepEqual(result.decisions, ['Use TypeScript', 'Deploy on Friday']);
    assert.equal(result.actionItems.length, 2);
    assert.equal(result.actionItems[0].task, 'Write tests');
    assert.equal(result.actionItems[0].assignee, 'Alice');
    assert.equal(result.actionItems[0].deadline, 'next Monday');
    assert.equal(result.actionItems[1].assignee, null);
  });

  it('should strip markdown code fences', () => {
    const wrapped = '```json\n{"summary":"Short summary.","decisions":[],"actionItems":[]}\n```';
    const result = _parseResponse(wrapped);
    assert.equal(result.summary, 'Short summary.');
    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.actionItems, []);
  });

  it('should strip ``` fences without language tag', () => {
    const wrapped = '```\n{"summary":"Plain fence.","decisions":[],"actionItems":[]}\n```';
    const result = _parseResponse(wrapped);
    assert.equal(result.summary, 'Plain fence.');
  });

  it('should extract JSON from mixed text with leading explanation', () => {
    const mixed = 'Here is the structured output:\n{"summary":"Extracted.","decisions":["Ship it"],"actionItems":[]}';
    const result = _parseResponse(mixed);
    assert.equal(result.summary, 'Extracted.');
    assert.deepEqual(result.decisions, ['Ship it']);
  });

  it('should return null fields for malformed JSON', () => {
    const result = _parseResponse('not json at all }{');
    assert.equal(result.summary, null);
    assert.equal(result.decisions, null);
    assert.equal(result.actionItems, null);
  });

  it('should return null fields for empty string', () => {
    const result = _parseResponse('');
    assert.equal(result.summary, null);
    assert.equal(result.decisions, null);
    assert.equal(result.actionItems, null);
  });

  it('should return null fields for null input', () => {
    const result = _parseResponse(null);
    assert.equal(result.summary, null);
  });

  it('should treat empty summary string as null', () => {
    const json = JSON.stringify({ summary: '   ', decisions: [], actionItems: [] });
    const result = _parseResponse(json);
    assert.equal(result.summary, null);
  });

  it('should filter out non-string decision entries', () => {
    const json = JSON.stringify({
      summary: 'OK',
      decisions: ['Valid decision', 42, null, '', 'Another valid'],
      actionItems: [],
    });
    const result = _parseResponse(json);
    assert.deepEqual(result.decisions, ['Valid decision', 'Another valid']);
  });

  it('should filter out action items without a task string', () => {
    const json = JSON.stringify({
      summary: 'OK',
      decisions: [],
      actionItems: [
        { task: 'Valid task', assignee: null, deadline: null },
        { task: '', assignee: 'Bob', deadline: null },
        { assignee: 'Ghost' }, // no task
        null,
      ],
    });
    const result = _parseResponse(json);
    assert.equal(result.actionItems.length, 1);
    assert.equal(result.actionItems[0].task, 'Valid task');
  });

  it('should coerce non-string assignee/deadline to null', () => {
    const json = JSON.stringify({
      summary: 'OK',
      decisions: [],
      actionItems: [
        { task: 'Do something', assignee: 123, deadline: false },
      ],
    });
    const result = _parseResponse(json);
    assert.equal(result.actionItems[0].assignee, null);
    assert.equal(result.actionItems[0].deadline, null);
  });
});

// ---------------------------------------------------------------------------
// _buildPrompt
// ---------------------------------------------------------------------------

describe('LLMProcessor - _buildPrompt', () => {
  it('should build an English prompt for en language', () => {
    const entries = makeTranscript(3);
    const meta    = makeMetadata({ language: 'en' });
    const { systemPrompt, userPrompt } = _buildPrompt(entries, meta);

    assert.ok(systemPrompt.includes('meeting analyst'), 'system prompt should be English');
    assert.ok(userPrompt.includes('Team Meeting'), 'user prompt should include channel name');
    assert.ok(userPrompt.includes('Alice'), 'transcript should use resolved speaker names');
    assert.ok(userPrompt.includes('summary'), 'schema description should appear in prompt');
    assert.ok(userPrompt.includes('actionItems'), 'actionItems key should appear in schema');
  });

  it('should build a Korean prompt for ko language', () => {
    const entries = makeTranscript(3);
    const meta    = makeMetadata({ language: 'ko', channelName: '팀 회의' });
    const { systemPrompt, userPrompt } = _buildPrompt(entries, meta);

    assert.ok(systemPrompt.includes('비서'), 'system prompt should be Korean');
    assert.ok(userPrompt.includes('팀 회의'), 'channel name should appear in Korean prompt');
    assert.ok(userPrompt.includes('회의 녹취록'), 'transcript header should be in Korean');
  });

  it('should include formatted timestamps in transcript text', () => {
    const entries = [
      { speaker: 0, text: 'Hello', start: 65, end: 70, isFinal: true },
    ];
    const { userPrompt } = _buildPrompt(entries, makeMetadata());
    assert.ok(userPrompt.includes('[01:05]'), 'timestamp should be formatted MM:SS');
  });

  it('should use Speaker N fallback when speakerMap is empty', () => {
    const entries = makeTranscript(2);
    const meta    = makeMetadata({ speakerMap: new Map() });
    const { userPrompt } = _buildPrompt(entries, meta);
    assert.ok(userPrompt.includes('Speaker 0'), 'should fall back to Speaker N');
  });

  it('should include duration in the prompt', () => {
    const entries = makeTranscript(2);
    const meta    = makeMetadata({ durationSeconds: 600 });
    const { userPrompt } = _buildPrompt(entries, meta);
    assert.ok(userPrompt.includes('10'), 'duration in minutes should appear in prompt');
  });

  it('should truncate very long transcripts', () => {
    // Generate 200 entries (exceeds MAX_TRANSCRIPT_ENTRIES=150)
    const entries = [];
    for (let i = 0; i < 200; i++) {
      entries.push({ speaker: 0, text: `utterance ${i}`, start: i * 5, end: i * 5 + 4, isFinal: true });
    }
    const { userPrompt } = _buildPrompt(entries, makeMetadata());
    assert.ok(
      userPrompt.includes('omitted') || userPrompt.includes('truncated'),
      'long transcripts should show truncation notice'
    );
  });

  it('should handle null/undefined metadata gracefully', () => {
    const entries = makeTranscript(2);
    // Should not throw
    assert.doesNotThrow(() => _buildPrompt(entries, null));
    assert.doesNotThrow(() => _buildPrompt(entries, {}));
  });
});

// ---------------------------------------------------------------------------
// processWithLLM — no API key configured
// ---------------------------------------------------------------------------

describe('LLMProcessor - processWithLLM (no API key)', () => {
  let originalOpenAI;
  let originalAnthropic;

  beforeEach(() => {
    originalOpenAI    = process.env.OPENAI_API_KEY;
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalOpenAI !== undefined)    process.env.OPENAI_API_KEY    = originalOpenAI;
    if (originalAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropic;
  });

  it('should return null when no API key is configured', async () => {
    const result = await processWithLLM(makeTranscript(3), makeMetadata());
    assert.equal(result, null);
  });

  it('should return null for empty transcript even if key were present', async () => {
    // Empty transcript — no key needed to short-circuit
    const result = await processWithLLM([], makeMetadata());
    assert.equal(result, null);
  });

  it('should return null when transcript has only non-final entries', async () => {
    const entries = makeTranscript(3).map(e => ({ ...e, isFinal: false }));
    const result  = await processWithLLM(entries, makeMetadata());
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// processWithLLM — simulated API responses
// ---------------------------------------------------------------------------

describe('LLMProcessor - processWithLLM (mocked fetch)', () => {
  let originalOpenAI;
  let originalFetch;

  const MOCK_AI_RESPONSE = {
    summary: 'The team discussed project timelines and deliverables.',
    decisions: ['Ship version 2 by end of month'],
    actionItems: [
      { task: 'Write unit tests', assignee: 'Alice', deadline: 'next Monday' },
    ],
  };

  beforeEach(() => {
    originalOpenAI = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-test-key';

    // Mock global fetch
    originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(MOCK_AI_RESPONSE) } }],
      }),
    }));
  });

  afterEach(() => {
    if (originalOpenAI !== undefined) process.env.OPENAI_API_KEY = originalOpenAI;
    else delete process.env.OPENAI_API_KEY;
    global.fetch = originalFetch;
  });

  it('should call OpenAI API and return parsed content', async () => {
    const result = await processWithLLM(makeTranscript(4), makeMetadata());

    assert.ok(result !== null, 'should return AI content');
    assert.equal(result.provider, 'openai');
    assert.equal(result.summary, MOCK_AI_RESPONSE.summary);
    assert.deepEqual(result.decisions, MOCK_AI_RESPONSE.decisions);
    assert.equal(result.actionItems.length, 1);
    assert.equal(result.actionItems[0].task, 'Write unit tests');
    assert.equal(result.actionItems[0].assignee, 'Alice');
    assert.equal(result.actionItems[0].deadline, 'next Monday');

    // Verify fetch was called once
    assert.equal(global.fetch.mock.callCount(), 1);
    const [url, options] = global.fetch.mock.calls[0].arguments;
    assert.ok(url.includes('openai.com'), 'should call OpenAI endpoint');
    assert.ok(options.headers['Authorization'].startsWith('Bearer'), 'should include Bearer token');
  });

  it('should gracefully return null when API responds with an error status', async () => {
    global.fetch = mock.fn(async () => ({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    }));

    const result = await processWithLLM(makeTranscript(4), makeMetadata());
    assert.equal(result, null, 'should return null on API error');
  });

  it('should gracefully return null when fetch throws (network error)', async () => {
    global.fetch = mock.fn(async () => { throw new Error('Network failure'); });

    const result = await processWithLLM(makeTranscript(4), makeMetadata());
    assert.equal(result, null, 'should return null on network failure');
  });

  it('should prefer OpenAI over Anthropic when both keys are set', async () => {
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';

    const result = await processWithLLM(makeTranscript(4), makeMetadata());

    assert.ok(result !== null);
    assert.equal(result.provider, 'openai');

    const [url] = global.fetch.mock.calls[0].arguments;
    assert.ok(url.includes('openai.com'), 'OpenAI should take priority');

    delete process.env.ANTHROPIC_API_KEY;
  });
});

describe('LLMProcessor - processWithLLM (Anthropic provider)', () => {
  let originalOpenAI;
  let originalAnthropic;
  let originalFetch;

  const MOCK_AI_RESPONSE = {
    summary: 'Anthropic-generated summary.',
    decisions: [],
    actionItems: [],
  };

  beforeEach(() => {
    originalOpenAI    = process.env.OPENAI_API_KEY;
    originalAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'anthropic-test-key';

    originalFetch = global.fetch;
    global.fetch = mock.fn(async () => ({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: JSON.stringify(MOCK_AI_RESPONSE) }],
      }),
    }));
  });

  afterEach(() => {
    if (originalOpenAI !== undefined)    process.env.OPENAI_API_KEY    = originalOpenAI;
    else delete process.env.OPENAI_API_KEY;
    if (originalAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = originalAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
    global.fetch = originalFetch;
  });

  it('should use Anthropic API when only ANTHROPIC_API_KEY is set', async () => {
    const result = await processWithLLM(makeTranscript(3), makeMetadata());

    assert.ok(result !== null);
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.summary, 'Anthropic-generated summary.');

    const [url, options] = global.fetch.mock.calls[0].arguments;
    assert.ok(url.includes('anthropic.com'), 'should call Anthropic endpoint');
    assert.ok(options.headers['x-api-key'] === 'anthropic-test-key', 'should include x-api-key header');
    assert.ok(options.headers['anthropic-version'], 'should include anthropic-version header');
  });
});

// ---------------------------------------------------------------------------
// formatter.js — aiContent injection
// ---------------------------------------------------------------------------

describe('formatter.js - aiContent injection', () => {
  function makeFormatterTranscript() {
    return [
      { speaker: 0, text: 'Let us begin the meeting.', start: 0, end: 5, confidence: 0.95, isFinal: true },
      { speaker: 1, text: 'I agree, please start.', start: 6, end: 10, confidence: 0.93, isFinal: true },
      { speaker: 0, text: 'We decided to use React.', start: 11, end: 16, confidence: 0.97, isFinal: true },
    ];
  }

  const metadata = {
    guildName: 'Test Server',
    channelName: 'Meeting Room',
    startedAt: new Date('2025-06-01T10:00:00Z'),
    durationSeconds: 120,
    startedBy: 'Alice',
    language: 'en',
    speakerMap: new Map([[0, 'Alice'], [1, 'Bob']]),
  };

  it('should use heuristic content when aiContent is null (default behavior)', () => {
    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata);
    // Summary section should contain heuristic output (stats-based)
    assert.ok(markdown.includes('## Summary'), 'should have Summary section');
    assert.ok(markdown.includes('## Decisions'), 'should have Decisions section');
    assert.ok(markdown.includes('## Action Items'), 'should have Action Items section');
    // AI badge should NOT be present
    assert.ok(!markdown.includes('🤖'), 'should not show AI badge for heuristic output');
  });

  it('should inject AI summary and show AI badge', () => {
    const aiContent = {
      summary: 'AI-generated narrative summary of the meeting.',
      decisions: null,
      actionItems: null,
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata, {}, aiContent);

    assert.ok(markdown.includes('AI-generated narrative summary'), 'AI summary should appear');
    assert.ok(markdown.includes('🤖'), 'AI badge should be shown');
    // Heuristic summary phrase should NOT appear (replaced)
    assert.ok(!markdown.includes('utterances were recorded'), 'heuristic summary should be replaced');
  });

  it('should inject AI decisions replacing heuristic decisions', () => {
    const aiContent = {
      summary: null,
      decisions: ['Adopt microservices architecture', 'Release by Q3'],
      actionItems: null,
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata, {}, aiContent);

    assert.ok(markdown.includes('Adopt microservices architecture'), 'AI decision 1 should appear');
    assert.ok(markdown.includes('Release by Q3'), 'AI decision 2 should appear');
    // AI decisions are rendered as simple checkmarks with no speaker attribution appended
    assert.ok(
      !markdown.includes('- ✅ Adopt microservices architecture — _'),
      'AI decision 1 should not have speaker attribution'
    );
    assert.ok(
      !markdown.includes('- ✅ Release by Q3 — _'),
      'AI decision 2 should not have speaker attribution'
    );
  });

  it('should inject AI action items with assignee and deadline', () => {
    const aiContent = {
      summary: null,
      decisions: null,
      actionItems: [
        { task: 'Write migration guide', assignee: 'Bob', deadline: 'next Friday' },
        { task: 'Update CI pipeline', assignee: null, deadline: null },
      ],
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata, {}, aiContent);

    assert.ok(markdown.includes('Write migration guide'), 'AI action item 1 task should appear');
    assert.ok(markdown.includes('**Assignee:** Bob'), 'assignee should appear in action item');
    assert.ok(markdown.includes('**Deadline:** next Friday'), 'deadline should appear in action item');
    assert.ok(markdown.includes('Update CI pipeline'), 'AI action item 2 task should appear');
  });

  it('should render empty AI decisions with the no-decisions placeholder', () => {
    const aiContent = {
      summary: null,
      decisions: [],
      actionItems: null,
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata, {}, aiContent);
    assert.ok(markdown.includes('_No decisions identified._'), 'empty AI decisions should show placeholder');
  });

  it('should render empty AI actionItems with the no-action-items placeholder', () => {
    const aiContent = {
      summary: null,
      decisions: null,
      actionItems: [],
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata, {}, aiContent);
    assert.ok(markdown.includes('_No action items identified._'), 'empty AI actionItems should show placeholder');
  });

  it('should use all three AI overrides simultaneously', () => {
    const aiContent = {
      summary: 'Complete AI summary here.',
      decisions: ['Go live on Monday'],
      actionItems: [{ task: 'Deploy to production', assignee: 'Alice', deadline: 'Monday 9am' }],
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), metadata, {}, aiContent);

    assert.ok(markdown.includes('Complete AI summary here.'));
    assert.ok(markdown.includes('Go live on Monday'));
    assert.ok(markdown.includes('Deploy to production'));
    assert.ok(markdown.includes('🤖'));
  });

  it('should work with Korean language and AI content', () => {
    const koMetadata = { ...metadata, language: 'ko' };
    const aiContent = {
      summary: '회의에서 주요 안건이 논의되었습니다.',
      decisions: ['리액트 사용하기로 결정'],
      actionItems: [{ task: '문서 작성', assignee: '홍길동', deadline: '다음 주 금요일' }],
    };

    const markdown = formatMeetingMinutes(makeFormatterTranscript(), koMetadata, {}, aiContent);

    assert.ok(markdown.includes('회의에서 주요 안건이 논의되었습니다.'));
    assert.ok(markdown.includes('리액트 사용하기로 결정'));
    assert.ok(markdown.includes('문서 작성'));
    assert.ok(markdown.includes('**담당:** 홍길동'), 'Korean assignee label should be used');
    assert.ok(markdown.includes('**기한:** 다음 주 금요일'), 'Korean deadline label should be used');
  });
});
