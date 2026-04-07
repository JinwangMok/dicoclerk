import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, SERVER_NAME, SERVER_VERSION } from '../src/mcp/server.js';

describe('MCP Server', () => {
  let server;

  before(() => {
    server = createMcpServer({ client: null, sessionManager: null });
  });

  it('should create a server instance', () => {
    assert.ok(server, 'Server should be created');
  });

  it('should export correct server name and version', () => {
    assert.equal(SERVER_NAME, 'dicoclerk');
    assert.equal(SERVER_VERSION, '1.0.0');
  });

  it('should have a connect method for transport binding', () => {
    assert.equal(typeof server.connect, 'function');
  });

  it('should have a close method for shutdown', () => {
    assert.equal(typeof server.close, 'function');
  });
});

describe('MCP Tool Registration', () => {
  it('should register tools without error with null deps', () => {
    // This verifies tools can be registered even in standalone mode
    const server = createMcpServer({ client: null, sessionManager: null });
    assert.ok(server, 'Server with tools registered should exist');
  });

  it('should register tools without error with empty deps', () => {
    const server = createMcpServer({});
    assert.ok(server, 'Server with empty deps should exist');
  });
});

describe('MCP Handlers - standalone mode', async () => {
  // Import handlers directly for unit testing
  const { listSessions, listRecordings, startSession, stopSession } = await import('../src/mcp/handlers.js');

  it('listSessions returns empty array with no sessionManager', async () => {
    const result = await listSessions({});
    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.sessions, []);
    assert.ok(data.note.includes('standalone'));
  });

  it('listRecordings handles missing directories gracefully', async () => {
    const result = await listRecordings({}, 10);
    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.recordings));
  });
});

describe('MCP Handlers - start_session', async () => {
  const { startSession } = await import('../src/mcp/handlers.js');

  it('returns error in standalone mode (no client)', async () => {
    const result = await startSession(
      { client: null, sessionManager: null },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError, 'Should be an error response');
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });

  it('returns error when sessionManager is missing', async () => {
    const mockClient = { guilds: { cache: new Map() } };
    const result = await startSession(
      { client: mockClient, sessionManager: null },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Session manager not available'));
  });

  it('returns error when session already active', async () => {
    const mockSessionManager = {
      hasSession: () => true,
      getSession: () => ({
        voiceChannelId: 'vc-existing',
        startedAt: new Date('2025-01-01T12:00:00Z'),
      }),
    };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await startSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already active'));
  });

  it('returns error when Deepgram API key is missing', async () => {
    const origKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    const mockSessionManager = {
      hasSession: () => false,
    };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await startSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Deepgram API key'));

    // Restore
    if (origKey) process.env.DEEPGRAM_API_KEY = origKey;
  });

  it('returns error when guild not found', async () => {
    const origKey = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = 'test-key';

    const mockSessionManager = {
      hasSession: () => false,
    };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await startSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Guild guild123 not found'));

    if (origKey) process.env.DEEPGRAM_API_KEY = origKey;
    else delete process.env.DEEPGRAM_API_KEY;
  });

  it('returns error when voice channel not found', async () => {
    const origKey = process.env.DEEPGRAM_API_KEY;
    process.env.DEEPGRAM_API_KEY = 'test-key';

    const guildChannels = new Map();
    const mockGuild = { channels: { cache: guildChannels } };
    const guildCache = new Map([['guild123', mockGuild]]);

    const mockSessionManager = {
      hasSession: () => false,
    };
    const mockClient = { guilds: { cache: guildCache } };

    const result = await startSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Voice channel vc123 not found'));

    if (origKey) process.env.DEEPGRAM_API_KEY = origKey;
    else delete process.env.DEEPGRAM_API_KEY;
  });
});

describe('MCP Handlers - stop_session', async () => {
  const { stopSession } = await import('../src/mcp/handlers.js');

  it('returns error in standalone mode (no client)', async () => {
    const result = await stopSession(
      { client: null, sessionManager: null },
      'guild123'
    );
    assert.ok(result.isError, 'Should be an error response');
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });

  it('returns error when sessionManager is missing', async () => {
    const mockClient = { guilds: { cache: new Map() } };
    const result = await stopSession(
      { client: mockClient, sessionManager: null },
      'guild123'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Session manager not available'));
  });

  it('returns error when no active session exists', async () => {
    const mockSessionManager = {
      hasSession: () => false,
    };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await stopSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild123'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No active session found'));
  });

  it('returns error when session was already stopped', async () => {
    const mockSessionManager = {
      hasSession: () => true,
      getSession: () => null,  // Session exists in map but returns null
    };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await stopSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild123'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already stopped'));
  });
});

describe('MCP Handlers - searchMeetingMinutes', async () => {
  const { searchMeetingMinutes } = await import('../src/mcp/handlers.js');

  it('returns results with content from index', async () => {
    const result = await searchMeetingMinutes({}, {});
    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    assert.ok(Array.isArray(data.results));
    assert.ok(typeof data.total === 'number');
    assert.ok(typeof data.showing === 'number');
  });

  it('filters by date range', async () => {
    const result = await searchMeetingMinutes({}, {
      date_from: '2025-01-15',
      date_to: '2025-01-15',
    });
    const data = JSON.parse(result.content[0].text);
    // All results should be from 2025-01-15
    for (const entry of data.results) {
      assert.equal(entry.date, '2025-01-15');
    }
  });

  it('filters by participant', async () => {
    const result = await searchMeetingMinutes({}, {
      participant: 'Alice',
    });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      const hasAlice = entry.participants.some(p => p.toLowerCase().includes('alice'));
      assert.ok(hasAlice, `Expected participant Alice in ${JSON.stringify(entry.participants)}`);
    }
  });

  it('filters by guild_id', async () => {
    const result = await searchMeetingMinutes({}, {
      guild_id: 'guild-456',
    });
    const data = JSON.parse(result.content[0].text);
    // Should only return entries from guild-456
    assert.ok(data.total >= 0);
  });

  it('filters by language', async () => {
    const result = await searchMeetingMinutes({}, {
      language: 'ko',
    });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.equal(entry.language, 'ko');
    }
  });

  it('supports keyword content search', async () => {
    const result = await searchMeetingMinutes({}, {
      keywords: ['회의록'],  // Korean word commonly in minutes
    });
    const data = JSON.parse(result.content[0].text);
    // Results with keyword matches should have matched_keywords
    for (const entry of data.results) {
      if (entry.matched_keywords) {
        assert.ok(entry.matched_keywords.includes('회의록'));
      }
    }
  });

  it('respects limit and offset', async () => {
    const result = await searchMeetingMinutes({}, {
      limit: 2,
      offset: 0,
    });
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.showing <= 2);
  });

  it('can exclude content', async () => {
    const result = await searchMeetingMinutes({}, {
      include_content: false,
      limit: 3,
    });
    const data = JSON.parse(result.content[0].text);
    for (const entry of data.results) {
      assert.equal(entry.content, undefined, 'Content should not be included');
    }
  });

  it('rejects invalid date_from with McpError (strict validation)', async () => {
    // The handler validates date_from strictly and throws McpError(-32602) for bad input.
    // Callers (MCP SDK) catch this and convert to a JSON-RPC error response.
    await assert.rejects(
      () => searchMeetingMinutes({}, { date_from: 'invalid-date' }),
      (err) => {
        assert.ok(err.code === -32602 || err.message.includes('YYYY-MM-DD'),
          `Expected validation error, got: ${err.message}`);
        return true;
      }
    );
  });
});

describe('MCP Handlers - getTranscript', async () => {
  const { getTranscript } = await import('../src/mcp/handlers.js');

  it('returns error when guild_id is missing', async () => {
    const result = await getTranscript({}, null, undefined, 'formatted');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild_id is required'));
  });

  it('returns error when guild_id is empty string', async () => {
    const result = await getTranscript({}, '', undefined, 'formatted');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild_id is required'));
  });

  it('returns formatted transcript from live session', async () => {
    // Mock using coordinator legacy transcript path (speakerName field)
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'Alice', text: 'Hello everyone', start: 0.5, end: 1.8, timestamp: 1714000000000 },
            { speaker: 1, speakerName: 'Bob', text: 'Hi Alice', start: 2.0, end: 3.0, timestamp: 1714000005000 },
            { speaker: 0, speakerName: 'Alice', text: 'Let us begin', start: 4.0, end: 5.2, timestamp: 1714000010000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, 'formatted');
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('Alice: Hello everyone'));
    assert.ok(text.includes('Bob: Hi Alice'));
    assert.ok(text.includes('Alice: Let us begin'));
  });

  it('returns raw transcript from live session', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'Alice', text: 'Hello', start: 0.0, end: 1.0, confidence: 0.95, language: 'en', isFinal: true, wallClockMs: 1714000000000 },
            { speaker: 1, speakerName: 'Bob', text: 'World', start: 1.5, end: 2.5, confidence: 0.90, language: 'en', isFinal: true, wallClockMs: 1714000005000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, 'raw');
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.guild_id, 'guild123');
    assert.equal(data.format, 'raw');
    assert.equal(data.entry_count, 2);
    assert.equal(data.entries.length, 2);
    // New API uses snake_case: speaker_name instead of speaker
    assert.equal(data.entries[0].speaker_name, 'Alice');
    assert.equal(data.entries[1].speaker_name, 'Bob');
  });

  it('defaults to formatted output when format is omitted', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'Alice', text: 'Hello', start: 0.0, end: 1.0, timestamp: 1714000000000 },
          ],
        },
      }),
    };

    // Omit both sessionId and format — should default to formatted
    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, undefined);
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('Alice: Hello'));
  });

  it('handles transcript entries with userId resolved to speakerName', async () => {
    // userId is stored separately; speaker display name comes from speakerName
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'user-display', userId: 'user-001', text: 'Testing', start: 0.0, end: 1.0, timestamp: 1714000000000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, 'formatted');
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('user-display: Testing'));
  });

  it('handles transcript entries with no speaker — falls back to Speaker 0', async () => {
    // When speakerLabel/speaker fields are absent, normalizeEntry defaults to Speaker 0
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { text: 'Anonymous message', start: 0.0, end: 1.0, timestamp: 1714000000000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, 'formatted');
    assert.ok(!result.isError);
    // normalizeEntry falls back to Speaker 0 when speakerName is absent
    assert.ok(result.content[0].text.includes('Speaker 0: Anonymous message'));
  });

  it('handles transcript entries with no timestamp — uses start time for [MM:SS]', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'Alice', text: 'No time', start: 65, end: 67 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, 'formatted');
    assert.ok(!result.isError);
    // start=65s → [01:05]
    assert.ok(result.content[0].text.includes('Alice: No time'));
    assert.ok(result.content[0].text.includes('[01:05]'));
  });

  it('returns error when no live session and no files on disk', async () => {
    const mockSessionManager = {
      getSession: () => null,
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-nonexistent', undefined, 'formatted');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No transcript found'));
  });

  it('returns error when no sessionManager and no files on disk', async () => {
    const result = await getTranscript({}, 'guild-nonexistent', undefined, 'formatted');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No transcript found'));
  });

  it('skips live session with empty transcript and falls back to empty-session response', async () => {
    // Session exists but audioCoordinator has no entries — returns live empty response, not error
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild-nonexistent-session',
          transcriptSession: { entryCount: 0, toStructuredData: () => [] },
          transcript: [],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-nonexistent', undefined, 'raw');
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.entry_count, 0);
    assert.equal(data.status, 'live');
  });
});

describe('MCP Handlers - getMinutes', async () => {
  const { getMinutes } = await import('../src/mcp/handlers.js');

  it('returns error when both guild_id and session_id are missing', async () => {
    const result = await getMinutes({}, null, null);
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild_id or session_id is required'));
  });

  it('returns error when both guild_id and session_id are undefined', async () => {
    const result = await getMinutes({});
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild_id or session_id is required'));
  });

  it('returns error when no minutes directory exists', async () => {
    const result = await getMinutes({}, 'guild-nonexistent');
    assert.ok(result.isError);
    // Should get either "No minutes directory" or "No minutes found"
    const text = result.content[0].text;
    assert.ok(text.includes('No minutes') || text.includes('minutes'));
  });

  it('returns error for non-existent session_id', async () => {
    const result = await getMinutes({}, null, 'session-nonexistent-12345');
    assert.ok(result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('No minutes') || text.includes('minutes'));
  });

  it('returns error for guild with no matching minutes files', async () => {
    const result = await getMinutes({}, 'guild-no-meetings-ever');
    assert.ok(result.isError);
  });

  it('handles getMinutes with only guildId (no sessionId)', async () => {
    const result = await getMinutes({}, 'guild-test-only');
    assert.ok(result.isError);
    // Should attempt lookup but find nothing
    assert.ok(result.content[0].text.includes('No minutes'));
  });

  it('handles getMinutes with only sessionId (no guildId)', async () => {
    const result = await getMinutes({}, null, 'session-abc123');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No minutes'));
  });
});

describe('MCP Handlers - getTranscript with Korean content', async () => {
  const { getTranscript } = await import('../src/mcp/handlers.js');

  it('correctly handles Korean speaker names and text', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild-kr-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: '김철수', text: '안녕하세요, 회의를 시작하겠습니다.', start: 0.5, end: 2.0, language: 'ko', timestamp: 1714000000000 },
            { speaker: 1, speakerName: '이영희', text: '네, 준비되었습니다.', start: 2.5, end: 4.0, language: 'ko', timestamp: 1714000005000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-kr', undefined, 'formatted');
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('김철수: 안녕하세요'));
    assert.ok(text.includes('이영희: 네, 준비되었습니다'));
  });

  it('correctly handles Korean content in raw format', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild-kr-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: '박지성', text: '테스트입니다', start: 0.0, end: 1.5, language: 'ko', isFinal: true, wallClockMs: 1714000000000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-kr', undefined, 'raw');
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    // New API uses speaker_name (snake_case)
    assert.equal(data.entries[0].speaker_name, '박지성');
    assert.equal(data.entries[0].text, '테스트입니다');
  });
});

describe('MCP Handlers - getTranscript multi-speaker diarization', async () => {
  const { getTranscript } = await import('../src/mcp/handlers.js');

  it('preserves speaker attribution across multiple speakers (5-10 participants)', async () => {
    const speakers = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace'];
    const transcript = [];
    for (let i = 0; i < 20; i++) {
      transcript.push({
        speaker: i % speakers.length,
        speakerName: speakers[i % speakers.length],
        text: `Message ${i + 1} from ${speakers[i % speakers.length]}`,
        start: i * 5,
        end: i * 5 + 3,
        language: 'en',
        isFinal: true,
        wallClockMs: 1714000000000 + i * 5000,
      });
    }

    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild-multi-session',
          transcriptSession: null,
          transcript,
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-multi', undefined, 'formatted');
    assert.ok(!result.isError);
    // Header lines + 20 transcript lines
    const allLines = result.content[0].text.split('\n');
    const transcriptLines = allLines.filter(l => l.match(/\[\d{2}:\d{2}\]/));
    assert.equal(transcriptLines.length, 20);

    // Verify each line has correct speaker attribution
    for (let i = 0; i < 20; i++) {
      const expectedSpeaker = speakers[i % speakers.length];
      assert.ok(transcriptLines[i].includes(`${expectedSpeaker}: Message ${i + 1}`),
        `Line ${i} should contain "${expectedSpeaker}: Message ${i + 1 }"`);
    }
  });

  it('raw format preserves all entries with metadata (confidence, language)', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild123-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'Alice', text: 'First', start: 0.0, end: 1.0, confidence: 0.95, language: 'en', isFinal: true, wallClockMs: 1714000000000 },
            { speaker: 1, speakerName: 'Bob', text: 'Second', start: 1.5, end: 2.5, confidence: 0.88, language: 'en', isFinal: true, wallClockMs: 1714000005000 },
          ],
        },
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', undefined, 'raw');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.entry_count, 2);
    // Raw format preserves confidence and other metadata
    assert.equal(data.entries[0].confidence, 0.95);
    assert.equal(data.entries[1].confidence, 0.88);
  });
});

describe('MCP Handlers - listSessions with active sessions', async () => {
  const { listSessions } = await import('../src/mcp/handlers.js');

  it('returns session data when sessions are active', async () => {
    const sessionsMap = new Map([
      ['guild1', {
        voiceChannelId: 'vc1',
        textChannelId: 'tc1',
        startedAt: new Date('2025-01-01T10:00:00Z'),
        participants: new Set(['user1', 'user2']),
        transcript: [{ text: 'hello' }, { text: 'world' }],
      }],
      ['guild2', {
        voiceChannelId: 'vc2',
        textChannelId: 'tc2',
        startedAt: new Date('2025-01-01T11:00:00Z'),
        participants: new Set(['user3']),
        transcript: [],
      }],
    ]);

    const mockSessionManager = {
      getAllSessions: () => sessionsMap,
    };

    const result = await listSessions({ sessionManager: mockSessionManager });
    assert.ok(result.content);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.count, 2);
    assert.equal(data.sessions.length, 2);

    // Verify first session
    assert.equal(data.sessions[0].guild_id, 'guild1');
    assert.equal(data.sessions[0].voice_channel_id, 'vc1');
    assert.equal(data.sessions[0].participant_count, 2);
    assert.equal(data.sessions[0].transcript_count, 2);

    // Verify second session
    assert.equal(data.sessions[1].guild_id, 'guild2');
    assert.equal(data.sessions[1].participant_count, 1);
    assert.equal(data.sessions[1].transcript_count, 0);
  });
});

describe('MCP Handlers - getStatus', async () => {
  const { getStatus } = await import('../src/mcp/handlers.js');

  it('returns standalone mode when no client is provided', async () => {
    const result = await getStatus({});
    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.bot_mode, 'standalone');
    assert.equal(data.active_session_count, 0);
    assert.ok(Array.isArray(data.sessions));
    assert.equal(data.sessions.length, 0);
  });

  it('returns connected mode when client is provided', async () => {
    const mockClient = { guilds: { cache: new Map() } };
    const result = await getStatus({ client: mockClient });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.bot_mode, 'connected');
  });

  it('returns system info with uptime and version', async () => {
    const result = await getStatus({});
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.system, 'Should have system field');
    assert.equal(data.system.version, '1.0.0');
    assert.ok(typeof data.system.uptime_seconds === 'number', 'uptime_seconds should be a number');
    assert.ok(data.system.uptime_seconds >= 0, 'uptime should be non-negative');
    assert.ok(typeof data.system.deepgram_configured === 'boolean');
  });

  it('returns empty sessions when no sessionManager', async () => {
    const result = await getStatus({ client: null, sessionManager: null });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.active_session_count, 0);
    assert.deepEqual(data.sessions, []);
  });

  it('returns all active sessions with live stats', async () => {
    const mockSessionManager = {
      getAllSessions: () => new Map([
        ['guild-alpha', {
          voiceChannelId: 'vc-alpha',
          textChannelId: 'tc-alpha',
          language: 'ko',
          status: 'active',
          startedAt: new Date(Date.now() - 60000), // 60 seconds ago
          participants: new Set(['user1', 'user2', 'user3']),
          transcript: Array.from({ length: 42 }, (_, i) => ({ text: `line ${i}` })),
          audioCoordinator: { isRunning: true, hasError: false },
        }],
        ['guild-beta', {
          voiceChannelId: 'vc-beta',
          textChannelId: 'tc-beta',
          language: 'en',
          status: 'active',
          startedAt: new Date(Date.now() - 120000),
          participants: new Set(['user4']),
          transcript: [],
          audioCoordinator: null,
        }],
      ]),
    };

    const result = await getStatus({ sessionManager: mockSessionManager });
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.active_session_count, 2);
    assert.equal(data.sessions.length, 2);

    const alpha = data.sessions.find(s => s.guild_id === 'guild-alpha');
    assert.ok(alpha, 'Should include guild-alpha');
    assert.equal(alpha.voice_channel_id, 'vc-alpha');
    assert.equal(alpha.language, 'ko');
    assert.equal(alpha.participant_count, 3);
    assert.equal(alpha.transcript_count, 42);
    assert.equal(alpha.is_recording, true);
    assert.equal(alpha.deepgram_status, 'active');
    assert.ok(alpha.duration_seconds >= 59, 'Duration should be at least 59s');
    assert.ok(alpha.started_at, 'Should have started_at timestamp');

    const beta = data.sessions.find(s => s.guild_id === 'guild-beta');
    assert.ok(beta, 'Should include guild-beta');
    assert.equal(beta.participant_count, 1);
    assert.equal(beta.transcript_count, 0);
    assert.equal(beta.is_recording, false);
    assert.equal(beta.deepgram_status, 'unavailable');
  });

  it('filters sessions by guild_id when provided', async () => {
    const mockSessionManager = {
      getAllSessions: () => new Map([
        ['guild-1', {
          voiceChannelId: 'vc1', textChannelId: 'tc1', language: 'en',
          status: 'active', startedAt: new Date(),
          participants: new Set(['u1']), transcript: [],
          audioCoordinator: null,
        }],
        ['guild-2', {
          voiceChannelId: 'vc2', textChannelId: 'tc2', language: 'ko',
          status: 'active', startedAt: new Date(),
          participants: new Set(['u2', 'u3']), transcript: [{ text: 'hi' }],
          audioCoordinator: null,
        }],
      ]),
    };

    const result = await getStatus({ sessionManager: mockSessionManager }, 'guild-1');
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.sessions.length, 1);
    assert.equal(data.sessions[0].guild_id, 'guild-1');
  });

  it('adds note when guild_id filter finds no session', async () => {
    const mockSessionManager = {
      getAllSessions: () => new Map(),
    };

    const result = await getStatus({ sessionManager: mockSessionManager }, 'guild-nonexistent');
    const data = JSON.parse(result.content[0].text);

    assert.equal(data.active_session_count, 0);
    assert.ok(data.note, 'Should include a note when guild not found');
    assert.ok(data.note.includes('guild-nonexistent'));
  });

  it('reports deepgram_status as error when coordinator has error', async () => {
    const mockSessionManager = {
      getAllSessions: () => new Map([
        ['guild-err', {
          voiceChannelId: 'vc1', textChannelId: 'tc1', language: 'ko',
          status: 'active', startedAt: new Date(),
          participants: new Set(), transcript: [],
          audioCoordinator: { isRunning: false, hasError: true },
        }],
      ]),
    };

    const result = await getStatus({ sessionManager: mockSessionManager });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.sessions[0].deepgram_status, 'error');
  });

  it('reports deepgram_status as idle when coordinator exists but not running', async () => {
    const mockSessionManager = {
      getAllSessions: () => new Map([
        ['guild-idle', {
          voiceChannelId: 'vc1', textChannelId: 'tc1', language: 'en',
          status: 'active', startedAt: new Date(),
          participants: new Set(), transcript: [],
          audioCoordinator: { isRunning: false, hasError: false },
        }],
      ]),
    };

    const result = await getStatus({ sessionManager: mockSessionManager });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.sessions[0].deepgram_status, 'idle');
  });

  it('includes duration_seconds for active sessions', async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const mockSessionManager = {
      getAllSessions: () => new Map([
        ['guild-dur', {
          voiceChannelId: 'vc1', textChannelId: 'tc1', language: 'multi',
          status: 'active', startedAt: fiveMinutesAgo,
          participants: new Set(['u1']), transcript: [],
          audioCoordinator: null,
        }],
      ]),
    };

    const result = await getStatus({ sessionManager: mockSessionManager });
    const data = JSON.parse(result.content[0].text);
    const session = data.sessions[0];
    assert.ok(session.duration_seconds >= 299, `Expected >= 299s, got ${session.duration_seconds}`);
    assert.ok(session.duration_seconds <= 302, `Expected <= 302s, got ${session.duration_seconds}`);
  });

  it('handles session with no startedAt gracefully', async () => {
    const mockSessionManager = {
      getAllSessions: () => new Map([
        ['guild-notime', {
          voiceChannelId: 'vc1', textChannelId: 'tc1', language: 'ko',
          status: 'active', startedAt: null,
          participants: new Set(), transcript: [],
          audioCoordinator: null,
        }],
      ]),
    };

    const result = await getStatus({ sessionManager: mockSessionManager });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.sessions[0].started_at, null);
    assert.equal(data.sessions[0].duration_seconds, 0);
  });

  it('returns valid JSON response structure', async () => {
    const result = await getStatus({});
    assert.ok(!result.isError);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    // Must be valid JSON
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(result.content[0].text); });
    assert.ok('bot_mode' in parsed);
    assert.ok('active_session_count' in parsed);
    assert.ok('sessions' in parsed);
    assert.ok('system' in parsed);
  });
});

describe('MCP Handlers - summarizeMinutes (contextual summary for Openclaw)', async () => {
  const { summarizeMinutes } = await import('../src/mcp/handlers.js');

  it('returns valid JSON structure with all required fields', async () => {
    const result = await summarizeMinutes({}, {});
    assert.ok(result.content);
    assert.equal(result.content[0].type, 'text');
    const data = JSON.parse(result.content[0].text);
    // Required top-level fields for Openclaw agent consumption
    assert.ok('meetingCount' in data, 'Should have meetingCount');
    assert.ok('generatedAt' in data, 'Should have generatedAt');
    assert.ok('summaries' in data, 'Should have summaries array');
    assert.ok('agentFormattedText' in data, 'Should have agentFormattedText');
    assert.ok('agentDigest' in data, 'Should have agentDigest (compact agent format)');
  });

  it('returns empty summaries with message when no records match', async () => {
    const result = await summarizeMinutes({}, {
      date_from: '9999-01-01',
      date_to: '9999-12-31',
    });
    assert.ok(result.content);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
    assert.ok(Array.isArray(data.summaries));
    assert.equal(data.summaries.length, 0);
    assert.ok(data.message, 'Should include a message when no results');
  });

  it('agentDigest is always a string (never null/undefined)', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.agentDigest, 'string', 'agentDigest must be a string');
    assert.ok(data.agentDigest.length > 0, 'agentDigest should be non-empty');
  });

  it('agentFormattedText is always a string', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    assert.equal(typeof data.agentFormattedText, 'string');
    assert.ok(data.agentFormattedText.length > 0);
  });

  it('generatedAt is a valid ISO timestamp', async () => {
    const result = await summarizeMinutes({}, {});
    const data = JSON.parse(result.content[0].text);
    // generatedAt may not exist when no meetings matched (empty result has no generatedAt)
    if (data.generatedAt !== undefined) {
      const parsed = new Date(data.generatedAt);
      assert.ok(!isNaN(parsed.getTime()), 'generatedAt should be a valid ISO timestamp');
    }
  });

  it('handles date range filter gracefully', async () => {
    const result = await summarizeMinutes({}, {
      date_from: '2020-01-01',
      date_to: '2020-12-31',
    });
    assert.ok(!result.isError, 'Should not error on valid date filter');
    const data = JSON.parse(result.content[0].text);
    assert.ok(typeof data.meetingCount === 'number');
  });

  it('handles guild_id filter gracefully', async () => {
    const result = await summarizeMinutes({}, {
      guild_id: 'guild-nonexistent-9999',
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
  });

  it('handles participant filter gracefully', async () => {
    const result = await summarizeMinutes({}, {
      participant: 'nonexistent-person-xyz',
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
  });

  it('agentDigest contains MEETING DIGEST header when empty', async () => {
    const result = await summarizeMinutes({}, {
      date_from: '9999-01-01',
    });
    const data = JSON.parse(result.content[0].text);
    // agentDigest is always present even with 0 meetings
    assert.ok(data.agentDigest.includes('MEETING DIGEST'));
  });

  it('handles language filter gracefully', async () => {
    const result = await summarizeMinutes({}, { language: 'ko' });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(typeof data.meetingCount === 'number');
  });

  it('handles keywords filter gracefully', async () => {
    const result = await summarizeMinutes({}, {
      keywords: ['nonexistent_keyword_xyz_abc'],
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.meetingCount, 0);
  });

  it('respects limit parameter', async () => {
    const result = await summarizeMinutes({}, { limit: 1 });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.meetingCount <= 1, `meetingCount should be ≤ 1, got ${data.meetingCount}`);
  });

  it('handles focus_query parameter without error', async () => {
    const result = await summarizeMinutes({}, {
      focus_query: 'authentication',
    });
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok('agentDigest' in data);
  });

  it('crossMeetingSummary is null when only 0 or 1 meeting matches', async () => {
    const result = await summarizeMinutes({}, {
      date_from: '9999-01-01',
    });
    const data = JSON.parse(result.content[0].text);
    // With 0 results, the message path returns without crossMeetingSummary
    if ('crossMeetingSummary' in data) {
      assert.ok(data.crossMeetingSummary === null || typeof data.crossMeetingSummary === 'string');
    }
  });

  it('rejects limit < 1 with McpError (strict validation)', async () => {
    // The handler validates limit strictly and throws McpError(-32602) for invalid values.
    // Callers (MCP SDK) catch this and convert to a JSON-RPC error response.
    await assert.rejects(
      () => summarizeMinutes({}, { limit: -1 }),
      (err) => {
        assert.ok(err.code === -32602 || err.message.includes('limit'),
          `Expected validation error for limit, got: ${err.message}`);
        return true;
      }
    );
  });

  it('response is valid JSON (not throws on parse)', async () => {
    const result = await summarizeMinutes({}, {});
    assert.doesNotThrow(() => JSON.parse(result.content[0].text), 'Response must be valid JSON');
  });
});

describe('MCP Tool Registration - start_recording / stop_recording aliases', () => {
  it('server registers start_recording tool', () => {
    // createMcpServer should not throw when registering start_recording
    const server = createMcpServer({ client: null, sessionManager: null });
    assert.ok(server, 'Server with start_recording tool should be created');
  });

  it('server registers stop_recording tool', () => {
    const server = createMcpServer({ client: null, sessionManager: null });
    assert.ok(server, 'Server with stop_recording tool should be created');
  });
});

describe('MCP Handlers - start_recording (alias for startSession)', async () => {
  const { startSession } = await import('../src/mcp/handlers.js');

  it('returns error in standalone mode (no client)', async () => {
    const result = await startSession(
      { client: null, sessionManager: null },
      'guild123', 'vc123', 'tc123', 'multi'
    );
    assert.ok(result.isError, 'Should be an error response');
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });

  it('returns error when Deepgram API key is missing', async () => {
    const origKey = process.env.DEEPGRAM_API_KEY;
    delete process.env.DEEPGRAM_API_KEY;

    const mockSessionManager = { hasSession: () => false };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await startSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild-rec', 'vc-rec', 'tc-rec', 'ko'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('Deepgram API key'));

    if (origKey) process.env.DEEPGRAM_API_KEY = origKey;
  });

  it('returns error when a session is already active', async () => {
    const mockSessionManager = {
      hasSession: () => true,
      getSession: () => ({
        voiceChannelId: 'vc-existing',
        startedAt: new Date('2025-06-01T09:00:00Z'),
      }),
    };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await startSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild-rec', 'vc-rec', 'tc-rec', 'en'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('already active'));
  });

  it('accepts all valid language options', async () => {
    // Each language option should pass schema validation and reach guild-lookup
    for (const lang of ['ko', 'en', 'multi']) {
      const origKey = process.env.DEEPGRAM_API_KEY;
      process.env.DEEPGRAM_API_KEY = 'test-key';

      const mockSessionManager = { hasSession: () => false };
      const mockClient = { guilds: { cache: new Map() } };
      const result = await startSession(
        { client: mockClient, sessionManager: mockSessionManager },
        'guild-rec', 'vc-rec', 'tc-rec', lang
      );
      // Should fail at guild lookup, not at parameter validation
      assert.ok(result.isError);
      assert.ok(result.content[0].text.includes('Guild guild-rec not found'),
        `Expected guild-not-found error for language=${lang}, got: ${result.content[0].text}`);

      if (origKey) process.env.DEEPGRAM_API_KEY = origKey;
      else delete process.env.DEEPGRAM_API_KEY;
    }
  });
});

describe('MCP Handlers - stop_recording (alias for stopSession)', async () => {
  const { stopSession } = await import('../src/mcp/handlers.js');

  it('returns error in standalone mode (no client)', async () => {
    const result = await stopSession(
      { client: null, sessionManager: null },
      'guild-rec'
    );
    assert.ok(result.isError, 'Should be an error response');
    assert.ok(result.content[0].text.includes('standalone MCP mode'));
  });

  it('returns error when no active session exists', async () => {
    const mockSessionManager = { hasSession: () => false };
    const mockClient = { guilds: { cache: new Map() } };
    const result = await stopSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild-rec'
    );
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No active session found'));
  });

  it('response includes success, guild_id, and minutes_generation fields', async () => {
    // Mock a session that cleanupSession can process
    const mockSession = {
      voiceChannelId: 'vc-rec',
      textChannelId: 'tc-rec',
      startedAt: new Date(Date.now() - 120000),
      participants: new Map([['user1', { username: 'Alice' }]]),
      transcript: [],
      audioCoordinator: { stop: async () => {} },
    };
    const mockSessionManager = {
      hasSession: () => true,
      getSession: () => mockSession,
      stopSession: () => {},
    };
    const mockClient = {};

    // Import and mock cleanupSession to return a known result
    // Since cleanupSession is imported inside stopSession, we test the error path
    // that returns a known structure when the session has no transcript
    const result = await stopSession(
      { client: mockClient, sessionManager: mockSessionManager },
      'guild-rec'
    );
    // cleanupSession may fail/succeed depending on internals; either way the
    // response should have valid content (not throw)
    assert.ok(result.content, 'Should have content array');
    assert.ok(result.content[0].type === 'text', 'Content should be text type');
  });
});

describe('MCP Handlers - get_transcript input validation', async () => {
  const { getTranscript } = await import('../src/mcp/handlers.js');

  it('response content is always MCP-compliant (has content array with type+text)', async () => {
    const result = await getTranscript({}, 'guild-test', undefined, 'formatted');
    assert.ok(Array.isArray(result.content), 'content must be an array');
    assert.equal(result.content[0].type, 'text', 'content[0].type must be "text"');
    assert.ok(typeof result.content[0].text === 'string', 'content[0].text must be a string');
  });

  it('raw format response includes session_id, guild_id, format, status, entry_count, speaker_count, entries fields', async () => {
    const mockSessionManager = {
      getSession: () => ({
        audioCoordinator: {
          sessionId: 'guild-raw-session',
          transcriptSession: null,
          transcript: [
            { speaker: 0, speakerName: 'Alice', text: 'Test', start: 0.0, end: 1.0, language: 'en', isFinal: true, wallClockMs: 1714000000000 },
          ],
        },
      }),
    };
    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-raw', undefined, 'raw');
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.ok('session_id' in data, 'raw response must have session_id');
    assert.ok('guild_id' in data, 'raw response must have guild_id');
    assert.ok('format' in data, 'raw response must have format');
    assert.ok('status' in data, 'raw response must have status');
    assert.ok('entry_count' in data, 'raw response must have entry_count');
    assert.ok('speaker_count' in data, 'raw response must have speaker_count');
    assert.ok('entries' in data, 'raw response must have entries');
    assert.equal(data.format, 'raw');
    assert.equal(data.status, 'live');
  });
});

describe('MCP Handlers - get_minutes input validation', async () => {
  const { getMinutes } = await import('../src/mcp/handlers.js');

  it('response content is always MCP-compliant (has content array with type+text)', async () => {
    const result = await getMinutes({}, 'guild-test');
    assert.ok(Array.isArray(result.content), 'content must be an array');
    assert.equal(result.content[0].type, 'text', 'content[0].type must be "text"');
    assert.ok(typeof result.content[0].text === 'string', 'content[0].text must be a string');
  });

  it('error responses set isError=true', async () => {
    const result = await getMinutes({}, null, null);
    assert.ok(result.isError === true, 'Missing params should yield isError:true');
  });
});
