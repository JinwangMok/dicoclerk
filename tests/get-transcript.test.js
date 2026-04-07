/**
 * Tests for MCP tool: get_transcript
 *
 * Covers:
 *   - Input schema validation (guild_id required, session_id optional, "current" alias)
 *   - Raw format: structured JSON with speaker-diarized entries
 *   - Formatted format: human-readable text with speaker labels and timestamps
 *   - Live session path: reads from AudioSessionCoordinator.transcriptSession
 *   - Live session fallback: uses coordinator.transcript array when transcriptSession is empty
 *   - Empty live session (no entries yet)
 *   - Stored session path: reads from transcript-{session_id}.json on disk
 *   - Stored session fallback file: transcript-{session_id}-fallback.json
 *   - Disk scan fallback: most recent transcript for guild when no session_id provided
 *   - "current" session_id alias treated as no session_id (active session lookup)
 *   - Error cases: missing guild_id, non-existent session, no transcripts at all
 *   - normalizeEntry: field mapping from both TranscriptSession shape and legacy shape
 *   - Output schema compliance: GetTranscriptRawOutputSchema
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getTranscript } from '../src/mcp/handlers.js';
import {
  GetTranscriptInputSchema,
  GetTranscriptRawOutputSchema,
  GET_TRANSCRIPT_SHAPE,
} from '../src/mcp/schemas.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_GUILD_ID = 'guild-test-999';
const TEST_SESSION_ID = `${TEST_GUILD_ID}-1714000000000`;
const TEST_DATA_DIR = join(process.cwd(), 'data', 'transcripts');

/** Minimal TranscriptSession-shaped entry (used by TranscriptSession.toStructuredData) */
function makeStructuredEntry(overrides = {}) {
  return {
    sessionId: TEST_SESSION_ID,
    speakerLabel: 0,
    speakerName: 'Alice',
    userId: 'user-alice-123',
    text: 'Hello everyone',
    start: 0.5,
    end: 1.8,
    duration: 1.3,
    confidence: 0.95,
    language: 'en',
    isFinal: true,
    wallClockMs: 1714000001000,
    ...overrides,
  };
}

/** Legacy coordinator-shaped entry (speaker / speakerName / timestamp) */
function makeLegacyEntry(overrides = {}) {
  return {
    speaker: 0,
    speakerName: 'Speaker 0',
    text: '안녕하세요',
    confidence: 0.88,
    start: 2.0,
    end: 3.5,
    timestamp: 1714000003000,
    ...overrides,
  };
}

/** Build a mock sessionManager that returns a session with a TranscriptSession */
function mockSessionManager({ entries = null, legacyEntries = null, sessionId = TEST_SESSION_ID } = {}) {
  const transcriptSession = entries !== null ? {
    entryCount: entries.length,
    toStructuredData: () => entries,
  } : null;

  const coordinatorTranscript = legacyEntries ?? [];

  const audioCoordinator = {
    sessionId,
    transcriptSession,
    get transcript() { return coordinatorTranscript; },
  };

  return {
    getSession: (guildId) => {
      if (guildId === TEST_GUILD_ID) {
        return { audioCoordinator };
      }
      return null;
    },
  };
}

/** Write a transcript JSON file to the test transcripts directory */
async function writeDiskTranscript(sessionId, transcriptEntries, extra = {}) {
  await mkdir(TEST_DATA_DIR, { recursive: true });
  const filePath = join(TEST_DATA_DIR, `transcript-${sessionId}.json`);
  const data = {
    sessionId,
    guildId: TEST_GUILD_ID,
    language: 'multi',
    createdAt: new Date().toISOString(),
    totalEntries: transcriptEntries.length,
    transcript: transcriptEntries,
    ...extra,
  };
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

/** Remove a test transcript file */
async function removeTranscriptFile(sessionId, suffix = '') {
  try {
    await rm(join(TEST_DATA_DIR, `transcript-${sessionId}${suffix}.json`));
  } catch { /* ignore missing files */ }
}

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

function parseContent(result) {
  assert.ok(result?.content, 'result must have content');
  assert.equal(result.content[0]?.type, 'text', 'content type must be text');
  return JSON.parse(result.content[0].text);
}

function getText(result) {
  assert.ok(result?.content, 'result must have content');
  assert.equal(result.content[0]?.type, 'text');
  return result.content[0].text;
}

// ---------------------------------------------------------------------------
// Input Schema Validation
// ---------------------------------------------------------------------------

describe('GET_TRANSCRIPT_SHAPE — input schema', () => {
  it('has guild_id, session_id, and format fields', () => {
    assert.ok('guild_id' in GET_TRANSCRIPT_SHAPE, 'must have guild_id');
    assert.ok('session_id' in GET_TRANSCRIPT_SHAPE, 'must have session_id');
    assert.ok('format' in GET_TRANSCRIPT_SHAPE, 'must have format');
  });

  it('validates valid input with guild_id only', () => {
    const result = GetTranscriptInputSchema.safeParse({ guild_id: '123456789' });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  it('defaults format to "formatted"', () => {
    const result = GetTranscriptInputSchema.safeParse({ guild_id: '123456789' });
    assert.ok(result.success);
    assert.equal(result.data.format, 'formatted');
  });

  it('accepts session_id as optional string', () => {
    const result = GetTranscriptInputSchema.safeParse({
      guild_id: '123456789',
      session_id: 'guild-123-1714000000000',
    });
    assert.ok(result.success, `Expected success, got: ${JSON.stringify(result.error?.issues)}`);
  });

  it('accepts "current" as session_id value', () => {
    const result = GetTranscriptInputSchema.safeParse({
      guild_id: '123456789',
      session_id: 'current',
    });
    assert.ok(result.success);
    assert.equal(result.data.session_id, 'current');
  });

  it('accepts format="raw"', () => {
    const result = GetTranscriptInputSchema.safeParse({
      guild_id: '123456789',
      format: 'raw',
    });
    assert.ok(result.success);
    assert.equal(result.data.format, 'raw');
  });

  it('rejects empty guild_id', () => {
    const result = GetTranscriptInputSchema.safeParse({ guild_id: '' });
    assert.ok(!result.success, 'Should reject empty guild_id');
  });

  it('rejects invalid format value', () => {
    const result = GetTranscriptInputSchema.safeParse({
      guild_id: '123',
      format: 'json',
    });
    assert.ok(!result.success, 'Should reject invalid format');
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('getTranscript — error cases', () => {
  it('returns error when no guild_id and no session_id', async () => {
    const result = await getTranscript({}, undefined, undefined, 'raw');
    const text = getText(result);
    assert.ok(text.toLowerCase().includes('guild_id') || text.toLowerCase().includes('required'),
      `Expected error about guild_id, got: ${text}`);
  });

  it('returns error when no guild_id and session_id="current"', async () => {
    const result = await getTranscript({}, undefined, 'current', 'raw');
    const text = getText(result);
    assert.ok(text.toLowerCase().includes('guild_id') || text.toLowerCase().includes('required'),
      `Expected error about guild_id, got: ${text}`);
  });

  it('returns error for non-existent session_id on disk', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, 'nonexistent-session-xyz', 'raw');
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('no transcript') ||
      text.toLowerCase().includes('not found') ||
      text.toLowerCase().includes('nonexistent-session-xyz'),
      `Expected not-found error, got: ${text}`
    );
  });

  it('returns error when no active session and no disk files', async () => {
    const deps = { sessionManager: { getSession: () => null } };
    const result = await getTranscript(deps, 'guild-nonexistent-xyz123', undefined, 'raw');
    const text = getText(result);
    assert.ok(
      text.toLowerCase().includes('no transcript') ||
      text.toLowerCase().includes('not found'),
      `Expected not-found message, got: ${text}`
    );
  });
});

// ---------------------------------------------------------------------------
// Live session — TranscriptSession path
// ---------------------------------------------------------------------------

describe('getTranscript — live session (TranscriptSession)', () => {
  const entries = [
    makeStructuredEntry({ speakerLabel: 0, speakerName: 'Alice', text: 'Hello everyone', start: 0.5, end: 1.8, language: 'en' }),
    makeStructuredEntry({ speakerLabel: 1, speakerName: 'Bob', text: '안녕하세요', start: 2.0, end: 3.5, language: 'ko', userId: 'user-bob-456' }),
    makeStructuredEntry({ speakerLabel: 0, speakerName: 'Alice', text: 'Let us begin', start: 4.0, end: 5.2, language: 'en' }),
  ];

  const deps = { sessionManager: mockSessionManager({ entries }) };

  it('raw format: returns structured JSON with correct shape', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    assert.equal(data.format, 'raw');
    assert.equal(data.status, 'live');
    assert.equal(data.guild_id, TEST_GUILD_ID);
    assert.equal(typeof data.session_id, 'string');
    assert.equal(data.entry_count, 3);
    assert.equal(data.speaker_count, 2);
    assert.ok(Array.isArray(data.entries));
    assert.equal(data.entries.length, 3);
  });

  it('raw format: entries conform to GetTranscriptRawOutputSchema', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);
    const validation = GetTranscriptRawOutputSchema.safeParse(data);
    assert.ok(validation.success, `Schema validation failed: ${JSON.stringify(validation.error?.issues)}`);
  });

  it('raw format: each entry has required speaker-diarized fields', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    for (const entry of data.entries) {
      assert.ok('speaker_label' in entry, 'entry must have speaker_label');
      assert.ok('speaker_name' in entry, 'entry must have speaker_name');
      assert.ok('user_id' in entry, 'entry must have user_id');
      assert.ok('text' in entry, 'entry must have text');
      assert.ok('start' in entry, 'entry must have start');
      assert.ok('end' in entry, 'entry must have end');
      assert.ok('duration' in entry, 'entry must have duration');
      assert.ok('confidence' in entry, 'entry must have confidence');
      assert.ok('language' in entry, 'entry must have language');
      assert.ok('is_final' in entry, 'entry must have is_final');
      assert.ok('wall_clock_ms' in entry, 'entry must have wall_clock_ms');
    }
  });

  it('raw format: speaker names are correctly attributed', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    const alice = data.entries.filter(e => e.speaker_label === 0);
    const bob = data.entries.filter(e => e.speaker_label === 1);

    assert.ok(alice.length > 0, 'Alice entries must be present');
    assert.ok(bob.length > 0, 'Bob entries must be present');
    assert.equal(alice[0].speaker_name, 'Alice');
    assert.equal(bob[0].speaker_name, 'Bob');
    assert.equal(alice[0].user_id, 'user-alice-123');
    assert.equal(bob[0].user_id, 'user-bob-456');
  });

  it('raw format: includes language detection results', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    const enEntries = data.entries.filter(e => e.language === 'en');
    const koEntries = data.entries.filter(e => e.language === 'ko');
    assert.ok(enEntries.length > 0, 'must have English entries');
    assert.ok(koEntries.length > 0, 'must have Korean entries');
  });

  it('formatted format: returns readable speaker-attributed text', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'formatted');
    const text = getText(result);

    assert.ok(text.includes('Alice'), 'must include Alice');
    assert.ok(text.includes('Bob'), 'must include Bob');
    assert.ok(text.includes('Hello everyone'), 'must include transcript text');
    assert.ok(text.includes('안녕하세요'), 'must include Korean text');
  });

  it('formatted format: includes [MM:SS] timestamps', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'formatted');
    const text = getText(result);
    assert.match(text, /\[\d{2}:\d{2}\]/, 'must contain [MM:SS] timestamp');
  });

  it('"current" session_id alias uses active session', async () => {
    const rawResult = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const currentResult = await getTranscript(deps, TEST_GUILD_ID, 'current', 'raw');

    const rawData = parseContent(rawResult);
    const currentData = parseContent(currentResult);

    assert.equal(currentData.entry_count, rawData.entry_count);
    assert.equal(currentData.status, 'live');
  });
});

// ---------------------------------------------------------------------------
// Live session — fallback to coordinator.transcript (legacy shape)
// ---------------------------------------------------------------------------

describe('getTranscript — live session (coordinator legacy transcript)', () => {
  const legacyEntries = [
    makeLegacyEntry({ speaker: 0, speakerName: 'Speaker 0', text: '회의를 시작하겠습니다', start: 1.0, end: 2.5 }),
    makeLegacyEntry({ speaker: 1, speakerName: 'Speaker 1', text: 'Sounds good', start: 3.0, end: 4.0 }),
  ];

  const deps = { sessionManager: mockSessionManager({ entries: null, legacyEntries }) };

  it('raw format: falls back to coordinator.transcript when transcriptSession is null', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    assert.equal(data.format, 'raw');
    assert.equal(data.status, 'live');
    assert.equal(data.entry_count, 2);
    assert.ok(data.entries.length === 2);
  });

  it('raw format: normalizes legacy entries to snake_case fields', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    const entry = data.entries[0];
    assert.ok('speaker_label' in entry, 'must have speaker_label (mapped from speaker)');
    assert.ok('speaker_name' in entry, 'must have speaker_name');
    assert.equal(entry.speaker_label, 0);
    assert.equal(entry.speaker_name, 'Speaker 0');
  });

  it('formatted format: works with legacy entries', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'formatted');
    const text = getText(result);
    assert.ok(text.includes('Speaker 0') || text.includes('회의를 시작하겠습니다'),
      `Expected speaker or text, got: ${text}`);
  });
});

// ---------------------------------------------------------------------------
// Live session — no entries yet
// ---------------------------------------------------------------------------

describe('getTranscript — live session (empty)', () => {
  const deps = { sessionManager: mockSessionManager({ entries: [], legacyEntries: [] }) };

  it('raw format: returns empty entries array with live status', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    assert.equal(data.entry_count, 0);
    assert.equal(data.status, 'live');
    assert.deepEqual(data.entries, []);
  });

  it('formatted format: returns informative message about empty session', async () => {
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'formatted');
    const text = getText(result);
    assert.ok(text.includes('live') || text.includes('active') || text.includes('no transcript'),
      `Expected informative message, got: ${text}`);
  });
});

// ---------------------------------------------------------------------------
// Stored session path (session_id provided)
// ---------------------------------------------------------------------------

describe('getTranscript — stored session (session_id on disk)', () => {
  const SESSION_ID = `${TEST_GUILD_ID}-stored-1714000000000`;

  const storedEntries = [
    {
      sessionId: SESSION_ID,
      speakerLabel: 0,
      speakerName: 'Charlie',
      userId: 'user-charlie-789',
      text: 'This was recorded earlier',
      start: 10.0,
      end: 12.5,
      duration: 2.5,
      confidence: 0.92,
      language: 'en',
      isFinal: true,
      wallClockMs: 1714000010000,
    },
    {
      sessionId: SESSION_ID,
      speakerLabel: 1,
      speakerName: 'Diana',
      userId: null,
      text: '네, 알겠습니다',
      start: 13.0,
      end: 14.0,
      duration: 1.0,
      confidence: 0.87,
      language: 'ko',
      isFinal: true,
      wallClockMs: 1714000013000,
    },
  ];

  beforeEach(async () => {
    await writeDiskTranscript(SESSION_ID, storedEntries);
  });

  afterEach(async () => {
    await removeTranscriptFile(SESSION_ID);
  });

  it('raw format: reads stored transcript from disk by session_id', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);

    assert.equal(data.format, 'raw');
    assert.equal(data.status, 'stored');
    assert.equal(data.session_id, SESSION_ID);
    assert.equal(data.entry_count, 2);
  });

  it('raw format: stored entries conform to GetTranscriptRawOutputSchema', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);
    const validation = GetTranscriptRawOutputSchema.safeParse(data);
    assert.ok(validation.success, `Schema validation failed: ${JSON.stringify(validation.error?.issues)}`);
  });

  it('raw format: speaker_name and user_id are correctly mapped', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);

    const charlie = data.entries.find(e => e.speaker_name === 'Charlie');
    const diana = data.entries.find(e => e.speaker_name === 'Diana');

    assert.ok(charlie, 'Charlie entry must be present');
    assert.ok(diana, 'Diana entry must be present');
    assert.equal(charlie.user_id, 'user-charlie-789');
    assert.equal(diana.user_id, null);
  });

  it('formatted format: returns readable text from disk', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'formatted');
    const text = getText(result);

    assert.ok(text.includes('Charlie'), 'must include Charlie');
    assert.ok(text.includes('This was recorded earlier'), 'must include text');
  });

  it('works even with no active sessionManager', async () => {
    const result = await getTranscript({ sessionManager: null }, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);
    assert.equal(data.status, 'stored');
    assert.equal(data.entry_count, 2);
  });

  it('status is "stored" for disk-based sessions', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);
    assert.equal(data.status, 'stored');
  });
});

// ---------------------------------------------------------------------------
// Fallback file path (transcript-{id}-fallback.json)
// ---------------------------------------------------------------------------

describe('getTranscript — fallback file on disk', () => {
  const SESSION_ID = `${TEST_GUILD_ID}-fallback-1714000000000`;

  const fallbackEntries = [
    {
      speaker: 0,
      speakerName: 'Speaker 0',
      text: 'Deepgram dropped mid-sentence',
      start: 5.0,
      end: 6.5,
      timestamp: 1714000005000,
    },
  ];

  beforeEach(async () => {
    await mkdir(TEST_DATA_DIR, { recursive: true });
    const filePath = join(TEST_DATA_DIR, `transcript-${SESSION_ID}-fallback.json`);
    const data = {
      sessionId: SESSION_ID,
      guildId: TEST_GUILD_ID,
      language: 'multi',
      createdAt: new Date().toISOString(),
      isFallback: true,
      reason: 'Deepgram connection permanently lost',
      totalEntries: fallbackEntries.length,
      transcript: fallbackEntries,
    };
    await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  });

  afterEach(async () => {
    await removeTranscriptFile(SESSION_ID, '-fallback');
  });

  it('reads fallback file when primary transcript file does not exist', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);

    assert.equal(data.status, 'stored');
    assert.equal(data.entry_count, 1);
    assert.ok(data.entries[0].text.includes('Deepgram dropped mid-sentence'));
  });

  it('fallback file entries are normalized to snake_case', async () => {
    const result = await getTranscript({}, TEST_GUILD_ID, SESSION_ID, 'raw');
    const data = parseContent(result);
    const entry = data.entries[0];

    assert.ok('speaker_label' in entry);
    assert.ok('speaker_name' in entry);
    assert.ok('wall_clock_ms' in entry);
  });
});

// ---------------------------------------------------------------------------
// Disk scan fallback (no session_id, no active session)
// ---------------------------------------------------------------------------

describe('getTranscript — disk scan fallback (no active session)', () => {
  const SESSION_ID = `${TEST_GUILD_ID}-disk-scan-1714099999999`;

  const diskEntries = [
    {
      sessionId: SESSION_ID,
      speakerLabel: 0,
      speakerName: 'Eve',
      userId: 'user-eve-000',
      text: 'This was the last meeting',
      start: 0.0,
      end: 2.0,
      duration: 2.0,
      confidence: 0.90,
      language: 'en',
      isFinal: true,
      wallClockMs: 1714099999000,
    },
  ];

  beforeEach(async () => {
    await writeDiskTranscript(SESSION_ID, diskEntries);
  });

  afterEach(async () => {
    await removeTranscriptFile(SESSION_ID);
  });

  it('raw format: falls back to disk scan for guild when no session is active', async () => {
    const deps = { sessionManager: { getSession: () => null } };
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'raw');
    const data = parseContent(result);

    assert.equal(data.status, 'stored');
    assert.ok(data.entry_count >= 1, 'must have at least 1 entry from disk');
  });

  it('formatted format: works for disk scan fallback', async () => {
    const deps = { sessionManager: { getSession: () => null } };
    const result = await getTranscript(deps, TEST_GUILD_ID, undefined, 'formatted');
    const text = getText(result);

    assert.ok(text.includes('Eve') || text.includes('This was the last meeting'),
      `Expected Eve or text in output, got: ${text}`);
  });
});

// ---------------------------------------------------------------------------
// Output schema: GetTranscriptRawOutputSchema structure
// ---------------------------------------------------------------------------

describe('GetTranscriptRawOutputSchema', () => {
  it('validates a complete raw output payload', () => {
    const payload = {
      session_id: 'guild-123-1714000000000',
      guild_id: 'guild-123',
      format: 'raw',
      status: 'live',
      entry_count: 1,
      speaker_count: 1,
      language: 'en',
      entries: [{
        session_id: 'guild-123-1714000000000',
        speaker_label: 0,
        speaker_name: 'Alice',
        user_id: 'user-alice',
        text: 'Hello',
        start: 0.5,
        end: 1.5,
        duration: 1.0,
        confidence: 0.95,
        language: 'en',
        is_final: true,
        wall_clock_ms: 1714000001000,
      }],
    };

    const result = GetTranscriptRawOutputSchema.safeParse(payload);
    assert.ok(result.success, `Schema validation failed: ${JSON.stringify(result.error?.issues)}`);
  });

  it('requires format to be "raw"', () => {
    const result = GetTranscriptRawOutputSchema.safeParse({
      session_id: 'sid',
      guild_id: 'gid',
      format: 'formatted',
      status: 'live',
      entry_count: 0,
      speaker_count: 0,
      entries: [],
    });
    assert.ok(!result.success, 'Should reject format != "raw"');
  });

  it('requires status to be "live" or "stored"', () => {
    const invalid = GetTranscriptRawOutputSchema.safeParse({
      session_id: 'sid',
      guild_id: 'gid',
      format: 'raw',
      status: 'pending',
      entry_count: 0,
      speaker_count: 0,
      entries: [],
    });
    assert.ok(!invalid.success, 'Should reject unknown status');
  });
});
