/**
 * Tests for Meeting Minutes Generator Pipeline
 *
 * Covers:
 * - Minutes generation from transcript + metadata
 * - File saving to disk
 * - Discord channel delivery
 * - Error handling and graceful degradation
 * - Empty transcript handling
 * - buildMetadata helper
 * - Session-end trigger integration (both /stop and empty channel)
 */

import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';

// We test the generator by importing its functions directly
import {
  generateAndDeliverMinutes,
  buildMetadata,
  sendMinutesToChannel,
  formatDurationSimple,
  MINUTES_DIR,
} from '../src/minutes/generator.js';

// --- Mock Factories ---

function createMockSession(overrides = {}) {
  return {
    guildId: 'guild-123',
    voiceChannelId: 'voice-ch-456',
    textChannelId: 'text-ch-789',
    language: 'en',
    startedAt: new Date('2025-01-15T10:00:00Z'),
    startedBy: 'TestUser#1234',
    participants: new Set(['user-1', 'user-2']),
    transcript: [],
    status: 'stopped',
    ...overrides,
  };
}

function createMockTranscript(count = 5) {
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      speaker: i % 2,
      speakerName: i % 2 === 0 ? 'Alice' : 'Bob',
      text: `Test utterance number ${i + 1}. This is a sample transcript entry.`,
      confidence: 0.92 + Math.random() * 0.08,
      start: i * 10,
      end: i * 10 + 8,
      timestamp: Date.now() - (count - i) * 10000,
      isFinal: true,
    });
  }
  return entries;
}

function createMockTranscriptResult(transcript = null) {
  const t = transcript || createMockTranscript();
  return {
    transcript: t,
    filePath: '/data/transcripts/test-transcript.json',
    speakerMap: new Map([[0, 'Alice'], [1, 'Bob']]),
  };
}

function createMockClient(overrides = {}) {
  const sendMock = mock.fn(async () => ({}));
  const textChannel = {
    id: 'text-ch-789',
    send: sendMock,
  };

  const voiceChannel = {
    id: 'voice-ch-456',
    name: 'General Voice',
  };

  const channelsCache = new Map();
  channelsCache.set('text-ch-789', textChannel);
  channelsCache.set('voice-ch-456', voiceChannel);

  const guild = {
    id: 'guild-123',
    name: 'Test Server',
    channels: { cache: channelsCache },
  };

  const guildsCache = new Map();
  guildsCache.set('guild-123', guild);

  return {
    guilds: { cache: guildsCache },
    _textChannel: textChannel,
    _sendMock: sendMock,
    ...overrides,
  };
}

// --- Tests ---

describe('MinutesGenerator - formatDurationSimple', () => {
  it('should format seconds-only duration', () => {
    assert.equal(formatDurationSimple(45), '0m 45s');
  });

  it('should format minutes and seconds', () => {
    assert.equal(formatDurationSimple(125), '2m 5s');
  });

  it('should format hours', () => {
    assert.equal(formatDurationSimple(3661), '1h 1m 1s');
  });

  it('should handle zero', () => {
    assert.equal(formatDurationSimple(0), '0m 0s');
  });
});

describe('MinutesGenerator - buildMetadata', () => {
  it('should build metadata from session and guild', () => {
    const session = createMockSession();
    const client = createMockClient();
    const guild = client.guilds.cache.get('guild-123');

    const metadata = buildMetadata(session, null, guild, 300);

    assert.equal(metadata.guildName, 'Test Server');
    assert.equal(metadata.channelName, 'General Voice');
    assert.equal(metadata.durationSeconds, 300);
    assert.equal(metadata.startedBy, 'TestUser#1234');
    assert.equal(metadata.language, 'en');
    assert.ok(metadata.startedAt instanceof Date);
    assert.ok(metadata.speakerMap instanceof Map);
  });

  it('should incorporate speaker map from transcript result', () => {
    const session = createMockSession();
    const transcriptResult = createMockTranscriptResult();
    const client = createMockClient();
    const guild = client.guilds.cache.get('guild-123');

    const metadata = buildMetadata(session, transcriptResult, guild, 300);

    assert.equal(metadata.speakerMap.get(0), 'Alice');
    assert.equal(metadata.speakerMap.get(1), 'Bob');
  });

  it('should handle speaker map as plain object', () => {
    const session = createMockSession();
    const transcriptResult = {
      transcript: [],
      filePath: null,
      speakerMap: { '0': 'Alice', '1': 'Bob' }, // Plain object instead of Map
    };
    const client = createMockClient();
    const guild = client.guilds.cache.get('guild-123');

    const metadata = buildMetadata(session, transcriptResult, guild, 300);

    assert.equal(metadata.speakerMap.get(0), 'Alice');
    assert.equal(metadata.speakerMap.get(1), 'Bob');
  });

  it('should use defaults when guild is not available', () => {
    const session = createMockSession();

    const metadata = buildMetadata(session, null, null, 60);

    assert.equal(metadata.guildName, 'Unknown Server');
    assert.equal(metadata.channelName, 'Unknown Channel');
    assert.equal(metadata.durationSeconds, 60);
  });
});

describe('MinutesGenerator - generateAndDeliverMinutes', () => {
  it('should handle empty transcript gracefully', async () => {
    const session = createMockSession({ transcript: [] });
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript: [],
      session,
      transcriptResult: { transcript: [], filePath: null },
      client,
      reason: 'manual_stop',
      duration: 60,
    });

    assert.equal(result.success, true);
    assert.equal(result.filePath, null);
    assert.ok(result.generationTimeMs >= 0);

    // Should notify channel about empty transcript
    assert.equal(client._sendMock.mock.callCount(), 1);
    const sentContent = client._sendMock.mock.calls[0].arguments[0].content;
    assert.ok(sentContent.includes('No transcript entries'));
  });

  it('should generate and save minutes for valid transcript', async () => {
    const transcript = createMockTranscript(3);
    const session = createMockSession({ transcript });
    const transcriptResult = createMockTranscriptResult(transcript);
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client,
      reason: 'manual_stop',
      duration: 30,
    });

    assert.equal(result.success, true);
    assert.ok(result.filePath !== null);
    assert.ok(result.filePath.endsWith('.md'));
    assert.ok(result.generationTimeMs >= 0);

    // Should send file to Discord channel
    assert.equal(client._sendMock.mock.callCount(), 1);
    const sendArg = client._sendMock.mock.calls[0].arguments[0];
    assert.ok(sendArg.content.includes('Meeting Minutes'));
    assert.ok(sendArg.files.length === 1);

    // Verify metadata in summary: session date, channel name, duration
    assert.ok(sendArg.content.includes('2025-01-15'), 'Summary should include session date');
    assert.ok(sendArg.content.includes('General Voice'), 'Summary should include channel name');
    assert.ok(sendArg.content.includes('Duration') || sendArg.content.includes('소요시간'), 'Summary should include duration label');

    // Cleanup: remove generated file
    try { await rm(result.filePath); } catch {}
  });

  it('should complete within reasonable time (< 5 seconds for small transcript)', async () => {
    const transcript = createMockTranscript(20);
    const session = createMockSession({ transcript });
    const transcriptResult = createMockTranscriptResult(transcript);
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client,
      reason: 'manual_stop',
      duration: 200,
    });

    assert.equal(result.success, true);
    assert.ok(result.generationTimeMs < 5000, `Generation took too long: ${result.generationTimeMs}ms`);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should handle missing client gracefully', async () => {
    const transcript = createMockTranscript(2);
    const session = createMockSession({ transcript });
    const transcriptResult = createMockTranscriptResult(transcript);

    const result = await generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client: null,
      reason: 'manual_stop',
      duration: 20,
    });

    // Should still succeed (save to disk) even without Discord client
    assert.equal(result.success, true);
    assert.ok(result.filePath !== null);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should handle missing text channel gracefully', async () => {
    const transcript = createMockTranscript(2);
    const session = createMockSession({ textChannelId: 'nonexistent-channel' });
    const transcriptResult = createMockTranscriptResult(transcript);
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client,
      reason: 'channel_empty',
      duration: 20,
    });

    // Should still save to disk
    assert.equal(result.success, true);
    assert.ok(result.filePath !== null);

    // Should NOT have sent to channel (channel not found)
    assert.equal(client._sendMock.mock.callCount(), 0);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should use session transcript when transcriptResult is null', async () => {
    const transcript = createMockTranscript(2);
    const session = createMockSession({ transcript });
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript: null,
      session,
      transcriptResult: null,
      client,
      reason: 'channel_empty',
      duration: 20,
    });

    assert.equal(result.success, true);
    assert.ok(result.filePath !== null);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should handle Discord send failure gracefully', async () => {
    const transcript = createMockTranscript(2);
    const session = createMockSession({ transcript });
    const transcriptResult = createMockTranscriptResult(transcript);
    const client = createMockClient();

    // Make send fail
    client._sendMock.mock.mockImplementation(async () => {
      throw new Error('Discord API error');
    });

    // Should still report as failed since send throws
    // But the file should be saved
    const result = await generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client,
      reason: 'manual_stop',
      duration: 20,
    });

    // The pipeline catches Discord send errors internally
    // It will fail because sendMinutesToChannel throws
    assert.equal(result.success, false);
    assert.ok(result.error.includes('Discord API error'));
  });

  it('should work for Korean language sessions', async () => {
    const transcript = createMockTranscript(3);
    const session = createMockSession({ language: 'ko', transcript });
    const transcriptResult = createMockTranscriptResult(transcript);
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript,
      session,
      transcriptResult,
      client,
      reason: 'manual_stop',
      duration: 30,
    });

    assert.equal(result.success, true);

    // Check Korean-language summary was sent
    const sendArg = client._sendMock.mock.calls[0].arguments[0];
    assert.ok(sendArg.content.includes('회의록'));

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });
});

describe('MinutesGenerator - sendMinutesToChannel metadata', () => {
  it('should include session date, channel name, and duration in the summary', async () => {
    const sendMock = mock.fn(async () => ({}));
    const channel = { id: 'text-ch-789', send: sendMock };

    const metadata = {
      guildName: 'Test Server',
      channelName: 'Design Review',
      startedAt: new Date('2025-03-20T14:30:00Z'),
      durationSeconds: 3661, // 1h 1m 1s
      startedBy: 'TestUser#1234',
      language: 'en',
      speakerMap: new Map([[0, 'Alice'], [1, 'Bob']]),
    };

    await sendMinutesToChannel(channel, '# Meeting Minutes\nContent here', 'minutes_2025-03-20.md', metadata, 42);

    assert.equal(sendMock.mock.callCount(), 1);
    const sendArg = sendMock.mock.calls[0].arguments[0];

    // Verify all required metadata fields
    assert.ok(sendArg.content.includes('2025-03-20'), 'Should include session date');
    assert.ok(sendArg.content.includes('Design Review'), 'Should include channel name');
    assert.ok(sendArg.content.includes('1h 1m 1s'), 'Should include formatted duration');
    assert.ok(sendArg.content.includes('42'), 'Should include transcript entry count');
    assert.ok(sendArg.content.includes('Participants'), 'Should include participant count');
    assert.ok(sendArg.content.includes('2'), 'Should show 2 participants from speakerMap');

    // Verify file attachment exists
    assert.ok(sendArg.files.length === 1, 'Should have exactly one file attachment');
  });

  it('should render Korean metadata labels for ko language', async () => {
    const sendMock = mock.fn(async () => ({}));
    const channel = { id: 'text-ch-789', send: sendMock };

    const metadata = {
      guildName: '테스트 서버',
      channelName: '회의실',
      startedAt: new Date('2025-06-15T09:00:00Z'),
      durationSeconds: 600,
      startedBy: '사용자',
      language: 'ko',
      speakerMap: new Map([[0, '홍길동']]),
    };

    await sendMinutesToChannel(channel, '# 회의록\n내용', 'minutes_2025-06-15.md', metadata, 10);

    const sendArg = sendMock.mock.calls[0].arguments[0];
    assert.ok(sendArg.content.includes('회의록'), 'Should use Korean header');
    assert.ok(sendArg.content.includes('날짜'), 'Should use Korean date label');
    assert.ok(sendArg.content.includes('소요시간'), 'Should use Korean duration label');
    assert.ok(sendArg.content.includes('채널'), 'Should use Korean channel label');
    assert.ok(sendArg.content.includes('2025-06-15'), 'Should include session date');
    assert.ok(sendArg.content.includes('회의실'), 'Should include channel name');
    assert.ok(sendArg.content.includes('첨부 파일'), 'Should use Korean download prompt');
  });

  it('should omit participants row when speakerMap is empty', async () => {
    const sendMock = mock.fn(async () => ({}));
    const channel = { id: 'text-ch-789', send: sendMock };

    const metadata = {
      guildName: 'Test Server',
      channelName: 'General',
      startedAt: new Date('2025-01-01T00:00:00Z'),
      durationSeconds: 120,
      startedBy: 'User',
      language: 'en',
      speakerMap: new Map(),
    };

    await sendMinutesToChannel(channel, '# Minutes', 'minutes.md', metadata, 5);

    const sendArg = sendMock.mock.calls[0].arguments[0];
    assert.ok(!sendArg.content.includes('Participants'), 'Should not include participants row when speakerMap is empty');
  });
});

describe('MinutesGenerator - Session-end trigger integration', () => {
  it('should be callable from /stop command flow', async () => {
    // Simulate what stop.js does: call generateAndDeliverMinutes after stopping session
    const transcript = createMockTranscript(5);
    const session = createMockSession({ transcript });
    const transcriptResult = createMockTranscriptResult(transcript);
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript: session.transcript,
      session,
      transcriptResult,
      client,
      reason: 'manual_stop',
      duration: 50,
    });

    assert.equal(result.success, true);
    assert.ok(result.filePath);
    assert.ok(result.generationTimeMs < 5000);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should be callable from sessionEnd event (channel_empty)', async () => {
    // Simulate what index.js sessionEnd handler does
    const transcript = createMockTranscript(3);
    const session = createMockSession({ transcript });
    const client = createMockClient();

    // In empty channel case, audioCoordinator.stop() might have been called already
    const transcriptResult = createMockTranscriptResult(transcript);

    const result = await generateAndDeliverMinutes({
      transcript: session.transcript,
      session,
      transcriptResult,
      client,
      reason: 'channel_empty',
      duration: 120,
    });

    assert.equal(result.success, true);
    assert.ok(result.filePath);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should be callable from sessionEnd event (connection_destroyed)', async () => {
    const transcript = createMockTranscript(2);
    const session = createMockSession({ transcript });
    const client = createMockClient();

    const result = await generateAndDeliverMinutes({
      transcript: session.transcript,
      session,
      transcriptResult: null, // Coordinator may not have been cleanly stopped
      client,
      reason: 'connection_destroyed',
      duration: 90,
    });

    assert.equal(result.success, true);
    assert.ok(result.filePath);

    // Cleanup
    try { await rm(result.filePath); } catch {}
  });

  it('should handle concurrent calls for different guilds', async () => {
    const client = createMockClient();

    // Add a second guild's channels
    const sendMock2 = mock.fn(async () => ({}));
    const textChannel2 = { id: 'text-ch-002', send: sendMock2 };
    const voiceChannel2 = { id: 'voice-ch-002', name: 'Voice Room 2' };
    const channelsCache2 = new Map();
    channelsCache2.set('text-ch-002', textChannel2);
    channelsCache2.set('voice-ch-002', voiceChannel2);
    const guild2 = { id: 'guild-456', name: 'Server 2', channels: { cache: channelsCache2 } };
    client.guilds.cache.set('guild-456', guild2);

    const session1 = createMockSession({ transcript: createMockTranscript(3) });
    const session2 = createMockSession({
      guildId: 'guild-456',
      voiceChannelId: 'voice-ch-002',
      textChannelId: 'text-ch-002',
      transcript: createMockTranscript(4),
    });

    // Run both concurrently
    const [result1, result2] = await Promise.all([
      generateAndDeliverMinutes({
        transcript: session1.transcript,
        session: session1,
        transcriptResult: createMockTranscriptResult(session1.transcript),
        client,
        reason: 'manual_stop',
        duration: 60,
      }),
      generateAndDeliverMinutes({
        transcript: session2.transcript,
        session: session2,
        transcriptResult: createMockTranscriptResult(session2.transcript),
        client,
        reason: 'channel_empty',
        duration: 120,
      }),
    ]);

    assert.equal(result1.success, true);
    assert.equal(result2.success, true);
    assert.notEqual(result1.filePath, result2.filePath);

    // Both channels should have received messages
    assert.equal(client._sendMock.mock.callCount(), 1); // guild-123 channel
    assert.equal(sendMock2.mock.callCount(), 1);          // guild-456 channel

    // Cleanup
    try { await rm(result1.filePath); } catch {}
    try { await rm(result2.filePath); } catch {}
  });
});
