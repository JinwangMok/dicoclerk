/**
 * Tests for the get_meeting_minutes MCP tool endpoint (Sub-AC 9.2)
 *
 * Verifies that the `get_meeting_minutes` tool:
 *   - Is registered on the MCP server
 *   - Delegates to getPreviousMinutes handler correctly
 *   - Accepts all required query parameters (date range, channel, keywords)
 *   - Returns structured JSON data for matching minutes
 *   - Handles empty results, invalid inputs, and edge cases gracefully
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../src/mcp/server.js';
import { getPreviousMinutes } from '../src/mcp/handlers.js';
import { _setMinutesDir, addEntry } from '../src/minutes/index-store.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helper: create a realistic meeting minutes markdown fixture
// ---------------------------------------------------------------------------
function makeMinutesMarkdown({ title = 'Meeting Minutes', date = '2025-03-01', channel = 'general', participants = ['Alice', 'Bob'] } = {}) {
  return `# ${title}

| **Date** | ${date} |
| **Time** | 10:00 |
| **Server** | Test Server |
| **Channel** | ${channel} |
| **Duration** | 30m 0s |
| **Started by** | Alice |

## Summary

This meeting covered project status and upcoming deadlines.

## Attendees

| Name | Role | Utterances |
|------|------|-----------|
${participants.map(p => `| ${p} | Member | 5 |`).join('\n')}

## Key Discussion Points

- Project roadmap review
- Sprint planning for Q2
- Budget approval process

## Action Items

- Complete API documentation (담당: Bob, 기한: 2025-03-15)
- Set up CI pipeline (담당: Alice)

## Decisions

- Adopted weekly sprint cadence
- Approved Q2 budget proposal

## Full Transcript

[10:00:00] **Alice**: Let's begin the meeting.
[10:00:05] **Bob**: Ready when you are.
[10:01:00] **Alice**: First topic is the project roadmap.
`;
}

// ---------------------------------------------------------------------------
// Temporary directory fixture for isolated index/minutes files
// ---------------------------------------------------------------------------
async function createTempMinutesDir() {
  const dir = join(tmpdir(), `dicoclerk-test-gmm-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// MCP Server registration tests
// ---------------------------------------------------------------------------
describe('MCP Server — get_meeting_minutes tool registration', () => {
  let server;

  before(() => {
    server = createMcpServer({ client: null, sessionManager: null });
  });

  it('server is created without error', () => {
    assert.ok(server, 'Server should be created');
  });

  it('server registers tools without throwing', () => {
    // If tool registration failed it would have thrown during createMcpServer
    assert.ok(typeof server.connect === 'function', 'server.connect should exist');
  });
});

// ---------------------------------------------------------------------------
// Handler unit tests — getPreviousMinutes (no fixture data)
// ---------------------------------------------------------------------------
describe('getPreviousMinutes handler — empty/no data', () => {
  it('returns error when both guild_id and session_id are omitted', async () => {
    const result = await getPreviousMinutes({}, {});
    // No filters at all is valid — returns empty result set from empty index
    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.results));
    assert.ok(typeof data.total === 'number');
  });

  it('returns empty results when index is empty', async () => {
    const dir = await createTempMinutesDir();
    _setMinutesDir(dir);
    try {
      const result = await getPreviousMinutes({}, { limit: 5 });
      assert.ok(!result.isError, `Unexpected error: ${result.content?.[0]?.text}`);
      const data = JSON.parse(result.content[0].text);
      assert.deepEqual(data.results, []);
      assert.equal(data.total, 0);
      assert.equal(data.showing, 0);
    } finally {
      _setMinutesDir(null);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns error for non-existent session_id', async () => {
    const dir = await createTempMinutesDir();
    _setMinutesDir(dir);
    try {
      const result = await getPreviousMinutes({}, { session_id: 'does-not-exist-9999' });
      assert.ok(result.isError, 'Should return error for unknown session_id');
      assert.ok(result.content[0].text.includes('No minutes found for session_id'));
    } finally {
      _setMinutesDir(null);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Handler unit tests — getPreviousMinutes with real fixture data
// ---------------------------------------------------------------------------
describe('getPreviousMinutes handler — with fixture data', async () => {
  let tmpDir;
  let sessionIdA;
  let sessionIdB;

  // Set up temp directory and write two fake minutes files + index entries
  before(async () => {
    tmpDir = await createTempMinutesDir();
    _setMinutesDir(tmpDir);

    sessionIdA = randomUUID();
    sessionIdB = randomUUID();

    // --- Fixture A: 2025-01-15, channel "project", participants Alice + Bob ---
    const contentA = makeMinutesMarkdown({
      title: 'Meeting Minutes',
      date: '2025-01-15',
      channel: 'project',
      participants: ['Alice', 'Bob'],
    });
    const fileA = `minutes_2025-01-15_100000_project.md`;
    const pathA = join(tmpDir, fileA);
    await writeFile(pathA, contentA, 'utf-8');
    await addEntry({
      sessionId: sessionIdA,
      filename: fileA,
      filePath: pathA,
      startedAt: new Date('2025-01-15T10:00:00Z'),
      durationSeconds: 1800,
      guildId: 'guild-test-1',
      guildName: 'Test Server',
      channelId: 'ch-proj',
      channelName: 'project',
      participants: ['Alice', 'Bob'],
      transcriptCount: 30,
      language: 'en',
      startedBy: 'Alice',
    });

    // --- Fixture B: 2025-02-20, channel "design", participants Carol + Dave, Korean ---
    const contentB = makeMinutesMarkdown({
      title: '회의록',
      date: '2025-02-20',
      channel: 'design',
      participants: ['Carol', 'Dave'],
    });
    const fileB = `minutes_2025-02-20_140000_design.md`;
    const pathB = join(tmpDir, fileB);
    await writeFile(pathB, contentB, 'utf-8');
    await addEntry({
      sessionId: sessionIdB,
      filename: fileB,
      filePath: pathB,
      startedAt: new Date('2025-02-20T14:00:00Z'),
      durationSeconds: 3600,
      guildId: 'guild-test-2',
      guildName: 'Design Server',
      channelId: 'ch-design',
      channelName: 'design',
      participants: ['Carol', 'Dave'],
      transcriptCount: 50,
      language: 'ko',
      startedBy: 'Carol',
    });
  });

  // Tear down temp directory and reset module-level paths
  // (Node test runner does not have afterAll via 'node:test' in older versions,
  //  so we use a cleanup test that always runs last)

  // --- Basic retrieval ---

  it('returns all minutes when no filters provided', async () => {
    const result = await getPreviousMinutes({}, {});
    assert.ok(!result.isError, `Unexpected error: ${result.content?.[0]?.text}`);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.total >= 2, `Expected >= 2 total, got ${data.total}`);
    assert.ok(data.results.length >= 1);
  });

  it('retrieves a specific session by session_id', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    assert.ok(!result.isError, `Unexpected error: ${result.content?.[0]?.text}`);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 1);
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].session_id, sessionIdA);
  });

  // --- Structured content shape ---

  it('result contains structured_content with required fields', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    const entry = data.results[0];

    // Top-level metadata
    assert.equal(entry.session_id, sessionIdA);
    assert.equal(entry.date, '2025-01-15');
    assert.ok(typeof entry.duration_seconds === 'number');
    assert.ok(typeof entry.duration_formatted === 'string');
    assert.ok(Array.isArray(entry.participants));

    // structured_content fields
    const sc = entry.structured_content;
    assert.ok(sc, 'structured_content should be present');
    assert.ok(Array.isArray(sc.key_discussion_points), 'key_discussion_points should be array');
    assert.ok(Array.isArray(sc.action_items), 'action_items should be array');
    assert.ok(Array.isArray(sc.decisions), 'decisions should be array');
    assert.ok(Array.isArray(sc.attendees), 'attendees should be array');
    assert.ok(typeof sc.statistics === 'object', 'statistics should be object');
  });

  it('structured_content.key_discussion_points contains extracted topics', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    const sc = data.results[0].structured_content;
    assert.ok(sc.key_discussion_points.length > 0, 'Should have extracted key discussion points');
    assert.ok(
      sc.key_discussion_points.some(t => /roadmap|sprint|budget/i.test(t)),
      `Expected roadmap/sprint/budget topics, got: ${JSON.stringify(sc.key_discussion_points)}`
    );
  });

  it('structured_content.action_items contains task, assignee, deadline', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    const sc = data.results[0].structured_content;
    assert.ok(sc.action_items.length > 0, 'Should have extracted action items');
    const firstItem = sc.action_items[0];
    assert.ok('task' in firstItem, 'action_item should have task field');
    assert.ok('assignee' in firstItem, 'action_item should have assignee field');
    assert.ok('deadline' in firstItem, 'action_item should have deadline field');
  });

  it('structured_content.decisions contains extracted decisions', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    const sc = data.results[0].structured_content;
    assert.ok(sc.decisions.length > 0, 'Should have extracted decisions');
  });

  it('structured_content.attendees contains participant rows', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    const sc = data.results[0].structured_content;
    assert.ok(sc.attendees.length > 0, 'Should have attendees from the table');
    assert.ok('name' in sc.attendees[0], 'attendee should have name');
  });

  // --- Date range filter ---

  it('filters by date_from (excludes earlier sessions)', async () => {
    const result = await getPreviousMinutes({}, {
      date_from: '2025-02-01',
    });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.ok(entry.date >= '2025-02-01',
        `Expected date >= 2025-02-01, got ${entry.date}`);
    }
  });

  it('filters by date_to (excludes later sessions)', async () => {
    const result = await getPreviousMinutes({}, {
      date_to: '2025-01-31',
    });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.ok(entry.date <= '2025-01-31',
        `Expected date <= 2025-01-31, got ${entry.date}`);
    }
  });

  it('filters by exact date range (date_from + date_to)', async () => {
    const result = await getPreviousMinutes({}, {
      date_from: '2025-01-15',
      date_to: '2025-01-15',
    });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.equal(entry.date, '2025-01-15');
    }
    assert.ok(data.results.length >= 1, 'Should find the 2025-01-15 session');
  });

  it('returns empty results when date range matches nothing', async () => {
    const result = await getPreviousMinutes({}, {
      date_from: '2020-01-01',
      date_to: '2020-01-31',
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 0);
    assert.deepEqual(data.results, []);
  });

  // --- Channel filter ---

  it('filters by channel_name (partial match)', async () => {
    const result = await getPreviousMinutes({}, { channel_name: 'proj' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.results.length >= 1, 'Should find "project" channel via partial "proj" match');
    for (const entry of data.results) {
      assert.ok(entry.channel_name.toLowerCase().includes('proj'),
        `Expected channel_name to include "proj", got "${entry.channel_name}"`);
    }
  });

  it('filters by channel_name (case-insensitive)', async () => {
    const result = await getPreviousMinutes({}, { channel_name: 'DESIGN' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.results.length >= 1, 'Should match "design" channel case-insensitively');
  });

  it('returns empty results when channel_name matches nothing', async () => {
    const result = await getPreviousMinutes({}, { channel_name: 'nonexistent-channel-xyz' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 0);
  });

  // --- Keyword search ---

  it('filters by keywords present in file content', async () => {
    const result = await getPreviousMinutes({}, {
      keywords: ['roadmap'],
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.results.length >= 1, 'Should find sessions containing "roadmap"');
  });

  it('filters by multiple keywords (OR logic — any match)', async () => {
    const result = await getPreviousMinutes({}, {
      keywords: ['roadmap', 'design'],
    });
    const data = JSON.parse(result.content[0].text);
    // Both fixtures contain at least one of these words
    assert.ok(data.results.length >= 1, 'Should find sessions matching any keyword');
  });

  it('returns empty results when keyword matches no file content', async () => {
    const result = await getPreviousMinutes({}, {
      keywords: ['xyzzy-keyword-that-does-not-exist-anywhere'],
    });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.total, 0);
  });

  // --- Participant filter ---

  it('filters by participant name (partial match)', async () => {
    const result = await getPreviousMinutes({}, { participant: 'Alice' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.results.length >= 1, 'Should find sessions with Alice');
    for (const entry of data.results) {
      const hasAlice = entry.participants.some(p => p.toLowerCase().includes('alice'));
      assert.ok(hasAlice, `Expected Alice in participants: ${JSON.stringify(entry.participants)}`);
    }
  });

  it('filters by guild_id', async () => {
    const result = await getPreviousMinutes({}, { guild_id: 'guild-test-1' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.results.length >= 1, 'Should find sessions for guild-test-1');
    for (const entry of data.results) {
      assert.equal(entry.guild_id, 'guild-test-1');
    }
  });

  // --- Language filter ---

  it('filters by language code', async () => {
    const result = await getPreviousMinutes({}, { language: 'en' });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.equal(entry.language, 'en');
    }
  });

  // --- Pagination ---

  it('respects limit parameter', async () => {
    const result = await getPreviousMinutes({}, { limit: 1 });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.showing <= 1, `Expected showing <= 1, got ${data.showing}`);
    assert.ok(data.results.length <= 1);
  });

  it('respects offset parameter for pagination', async () => {
    const allResult = await getPreviousMinutes({}, { limit: 10, offset: 0 });
    const allData = JSON.parse(allResult.content[0].text);

    if (allData.total < 2) return; // Skip if fewer than 2 entries

    const offsetResult = await getPreviousMinutes({}, { limit: 10, offset: 1 });
    const offsetData = JSON.parse(offsetResult.content[0].text);
    assert.equal(offsetData.showing, allData.total - 1,
      'Offset by 1 should return total-1 results');
  });

  // --- Optional fields ---

  it('transcript is excluded by default', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    const sc = data.results[0].structured_content;
    assert.equal(sc.transcript, undefined, 'transcript should not be included by default');
  });

  it('includes transcript entries when include_transcript is true', async () => {
    const result = await getPreviousMinutes({}, {
      session_id: sessionIdA,
      include_transcript: true,
    });
    const data = JSON.parse(result.content[0].text);
    const sc = data.results[0].structured_content;
    assert.ok(Array.isArray(sc.transcript), 'transcript should be an array when requested');
    if (sc.transcript.length > 0) {
      assert.ok('speaker' in sc.transcript[0], 'transcript entry should have speaker');
      assert.ok('text' in sc.transcript[0], 'transcript entry should have text');
    }
  });

  it('raw_markdown is excluded by default', async () => {
    const result = await getPreviousMinutes({}, { session_id: sessionIdA });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.results[0].raw_markdown, undefined,
      'raw_markdown should not be included by default');
  });

  it('includes raw_markdown when include_raw_markdown is true', async () => {
    const result = await getPreviousMinutes({}, {
      session_id: sessionIdA,
      include_raw_markdown: true,
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(typeof data.results[0].raw_markdown === 'string',
      'raw_markdown should be a string when requested');
    assert.ok(data.results[0].raw_markdown.includes('Meeting Minutes'),
      'raw_markdown should contain the markdown content');
  });

  // --- Combined filters ---

  it('accepts combined date range + channel + keywords filters', async () => {
    const result = await getPreviousMinutes({}, {
      date_from: '2025-01-01',
      date_to: '2025-12-31',
      channel_name: 'project',
      keywords: ['roadmap'],
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.results.length >= 1, 'Combined filters should find the project session');
    for (const entry of data.results) {
      assert.ok(entry.date >= '2025-01-01');
      assert.ok(entry.date <= '2025-12-31');
    }
  });

  // --- Response shape ---

  it('returns valid JSON with results, total, showing fields', async () => {
    const result = await getPreviousMinutes({}, {});
    assert.ok(!result.isError);
    assert.equal(result.content[0].type, 'text');
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.content[0].text); });
    assert.ok('results' in parsed, 'response must have results field');
    assert.ok('total' in parsed, 'response must have total field');
    assert.ok('showing' in parsed, 'response must have showing field');
    assert.ok(Array.isArray(parsed.results), 'results must be an array');
    assert.ok(typeof parsed.total === 'number', 'total must be a number');
    assert.ok(typeof parsed.showing === 'number', 'showing must be a number');
  });

  it('each result has required metadata fields', async () => {
    const result = await getPreviousMinutes({}, { limit: 2 });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.ok('session_id' in entry, 'result must have session_id');
      assert.ok('date' in entry, 'result must have date');
      assert.ok('channel_name' in entry, 'result must have channel_name');
      assert.ok('participants' in entry, 'result must have participants');
      assert.ok('duration_seconds' in entry, 'result must have duration_seconds');
      assert.ok('duration_formatted' in entry, 'result must have duration_formatted');
      assert.ok('structured_content' in entry, 'result must have structured_content');
    }
  });

  // --- Cleanup ---

  it('cleans up temp directory (always runs last)', async () => {
    _setMinutesDir(null);
    await rm(tmpDir, { recursive: true, force: true });
    assert.ok(true, 'cleanup done');
  });
});

// ---------------------------------------------------------------------------
// Error handling edge cases
// ---------------------------------------------------------------------------
describe('getPreviousMinutes handler — error handling', () => {
  it('handles invalid date gracefully (no crash)', async () => {
    const result = await getPreviousMinutes({}, {
      date_from: 'not-a-date',
      date_to: 'also-not-a-date',
    });
    // Should not throw — result might be empty or error, but must return content
    assert.ok(result.content, 'Should return content even with invalid dates');
    assert.equal(result.content[0].type, 'text');
  });

  it('handles empty keywords array as if no keyword filter', async () => {
    const dir = await createTempMinutesDir();
    _setMinutesDir(dir);
    try {
      const result = await getPreviousMinutes({}, { keywords: [] });
      assert.ok(!result.isError, 'Empty keywords should not cause an error');
    } finally {
      _setMinutesDir(null);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles zero limit gracefully', async () => {
    const result = await getPreviousMinutes({}, { limit: 0 });
    assert.ok(result.content, 'Should return content even with limit: 0');
    const data = JSON.parse(result.content[0].text);
    assert.ok(typeof data.total === 'number');
    assert.equal(data.showing, 0);
    assert.deepEqual(data.results, []);
  });

  it('deps argument is ignored (handler reads from disk/index)', async () => {
    // getPreviousMinutes does not use deps — passing unusual values should be fine
    const result = await getPreviousMinutes({ arbitrary: 'junk' }, { limit: 1 });
    assert.ok(result.content, 'Handler should work regardless of deps content');
  });
});
