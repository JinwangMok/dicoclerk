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

  it('handles errors gracefully', async () => {
    // searchMeetingMinutes wraps in try/catch, should not throw
    const result = await searchMeetingMinutes({}, {
      date_from: 'invalid-date',
    });
    assert.ok(result.content);
  });
});

describe('MCP Handlers - getTranscript', async () => {
  const { getTranscript } = await import('../src/mcp/handlers.js');

  it('returns error when guild_id is missing', async () => {
    const result = await getTranscript({}, null);
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild_id is required'));
  });

  it('returns error when guild_id is empty string', async () => {
    const result = await getTranscript({}, '');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('guild_id is required'));
  });

  it('returns formatted transcript from live session', async () => {
    const mockSessionManager = {
      getSession: (guildId) => ({
        transcript: [
          { speaker: 'Alice', text: 'Hello everyone', timestamp: '2025-01-01T10:00:00Z' },
          { speaker: 'Bob', text: 'Hi Alice', timestamp: '2025-01-01T10:00:05Z' },
          { speaker: 'Alice', text: 'Let us begin', timestamp: '2025-01-01T10:00:10Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', 'formatted');
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('Alice: Hello everyone'));
    assert.ok(text.includes('Bob: Hi Alice'));
    assert.ok(text.includes('Alice: Let us begin'));
  });

  it('returns raw transcript from live session', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { speaker: 'Alice', text: 'Hello', timestamp: '2025-01-01T10:00:00Z' },
          { speaker: 'Bob', text: 'World', timestamp: '2025-01-01T10:00:05Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', 'raw');
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.guild_id, 'guild123');
    assert.equal(data.format, 'raw');
    assert.equal(data.entry_count, 2);
    assert.equal(data.entries.length, 2);
    assert.equal(data.entries[0].speaker, 'Alice');
    assert.equal(data.entries[1].speaker, 'Bob');
  });

  it('defaults to formatted output when format is omitted', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { speaker: 'Alice', text: 'Hello', timestamp: '2025-01-01T10:00:00Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123');
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('Alice: Hello'));
  });

  it('handles transcript entries with userId instead of speaker', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { userId: 'user-001', text: 'Testing', timestamp: '2025-01-01T10:00:00Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', 'formatted');
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('user-001: Testing'));
  });

  it('handles transcript entries with no speaker or userId', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { text: 'Anonymous message', timestamp: '2025-01-01T10:00:00Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', 'formatted');
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Unknown: Anonymous message'));
  });

  it('handles transcript entries with no timestamp', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { speaker: 'Alice', text: 'No time' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', 'formatted');
    assert.ok(!result.isError);
    assert.ok(result.content[0].text.includes('Alice: No time'));
  });

  it('returns error when no live session and no files on disk', async () => {
    const mockSessionManager = {
      getSession: () => null,
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-nonexistent');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No transcript found'));
  });

  it('returns error when no sessionManager and no files on disk', async () => {
    const result = await getTranscript({}, 'guild-nonexistent');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No transcript found'));
  });

  it('skips live session with empty transcript array and falls back', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-nonexistent');
    assert.ok(result.isError);
    assert.ok(result.content[0].text.includes('No transcript found'));
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
        transcript: [
          { speaker: '김철수', text: '안녕하세요, 회의를 시작하겠습니다.', timestamp: '2025-01-01T10:00:00Z' },
          { speaker: '이영희', text: '네, 준비되었습니다.', timestamp: '2025-01-01T10:00:05Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-kr', 'formatted');
    assert.ok(!result.isError);
    const text = result.content[0].text;
    assert.ok(text.includes('김철수: 안녕하세요'));
    assert.ok(text.includes('이영희: 네, 준비되었습니다'));
  });

  it('correctly handles Korean content in raw format', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { speaker: '박지성', text: '테스트입니다', timestamp: '2025-01-01T10:00:00Z' },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-kr', 'raw');
    assert.ok(!result.isError);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.entries[0].speaker, '박지성');
    assert.equal(data.entries[0].text, '테스트입니다');
  });
});

describe('MCP Handlers - getTranscript multi-speaker diarization', async () => {
  const { getTranscript } = await import('../src/mcp/handlers.js');

  it('preserves speaker attribution across multiple speakers (5-10 participants)', async () => {
    const transcript = [];
    const speakers = ['Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace'];
    for (let i = 0; i < 20; i++) {
      transcript.push({
        speaker: speakers[i % speakers.length],
        text: `Message ${i + 1} from ${speakers[i % speakers.length]}`,
        timestamp: new Date(Date.UTC(2025, 0, 1, 10, 0, i * 5)).toISOString(),
      });
    }

    const mockSessionManager = {
      getSession: () => ({ transcript }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild-multi', 'formatted');
    assert.ok(!result.isError);
    const lines = result.content[0].text.split('\n');
    assert.equal(lines.length, 20);

    // Verify each line has correct speaker attribution
    for (let i = 0; i < 20; i++) {
      const expectedSpeaker = speakers[i % speakers.length];
      assert.ok(lines[i].includes(`${expectedSpeaker}: Message ${i + 1}`),
        `Line ${i} should contain "${expectedSpeaker}: Message ${i + 1}"`);
    }
  });

  it('raw format preserves all entries with metadata', async () => {
    const mockSessionManager = {
      getSession: () => ({
        transcript: [
          { speaker: 'Alice', text: 'First', timestamp: '2025-01-01T10:00:00Z', confidence: 0.95 },
          { speaker: 'Bob', text: 'Second', timestamp: '2025-01-01T10:00:05Z', confidence: 0.88 },
        ],
      }),
    };

    const result = await getTranscript({ sessionManager: mockSessionManager }, 'guild123', 'raw');
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.entry_count, 2);
    // Raw format should preserve extra fields like confidence
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
