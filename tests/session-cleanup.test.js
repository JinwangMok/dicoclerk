/**
 * Tests for Session Cleanup (shared teardown logic)
 *
 * Covers:
 * - cleanupSession for manual_stop, channel_empty, connection_destroyed
 * - Audio coordinator stop integration
 * - Graceful handling of missing sessions
 * - Graceful handling of coordinator failures
 * - formatCleanupMessage for all reason types
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupSession, formatCleanupMessage } from '../src/session/session-cleanup.js';

function createMockSessionManager(session = null) {
  let stopped = false;
  return {
    getSession: mock.fn(() => session),
    stopSession: mock.fn(() => {
      if (!session || stopped) return null;
      stopped = true;
      session.status = 'stopped';
      return session;
    }),
  };
}

function createMockSession(overrides = {}) {
  return {
    guildId: 'guild-123',
    voiceChannelId: 'voice-ch-456',
    textChannelId: 'text-ch-789',
    language: 'en',
    startedAt: new Date(Date.now() - 60000), // 1 minute ago
    startedBy: 'TestUser#1234',
    participants: new Set(['user-1', 'user-2']),
    transcript: [{ text: 'hello', isFinal: true }],
    status: 'active',
    ...overrides,
  };
}

describe('cleanupSession', () => {
  it('should return empty result when session not found', async () => {
    const sm = createMockSessionManager(null);
    const result = await cleanupSession({ sessionManager: sm, guildId: 'none', reason: 'manual_stop' });

    assert.equal(result.duration, 0);
    assert.equal(result.transcriptCount, 0);
    assert.deepEqual(result.transcript, []);
    assert.ok(result.warnings.some(w => w.includes('Session not found')));
  });

  it('should stop audio coordinator and session for manual_stop', async () => {
    const coordinatorStopMock = mock.fn(async () => ({
      transcript: [
        { speaker: 0, text: 'Hello', confidence: 0.95, start: 0, end: 1 },
        { speaker: 1, text: 'World', confidence: 0.9, start: 2, end: 3 },
      ],
      filePath: '/data/transcripts/test.json',
    }));

    const session = createMockSession({
      audioCoordinator: { isRunning: true, stop: coordinatorStopMock },
    });
    const sm = createMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-123', reason: 'manual_stop' });

    assert.equal(coordinatorStopMock.mock.callCount(), 1);
    assert.equal(sm.stopSession.mock.callCount(), 1);
    assert.equal(result.reason, 'manual_stop');
    assert.equal(result.transcriptCount, 2);
    assert.equal(result.transcriptFilePath, '/data/transcripts/test.json');
    assert.equal(result.participantCount, 2);
    assert.ok(result.duration >= 0);
    assert.equal(result.warnings.length, 0);
  });

  it('should handle coordinator stop failure gracefully', async () => {
    const session = createMockSession({
      audioCoordinator: {
        isRunning: true,
        stop: mock.fn(async () => { throw new Error('Deepgram closed'); }),
      },
    });
    const sm = createMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-123', reason: 'channel_empty' });

    // Should still stop session and return result with warnings
    assert.equal(sm.stopSession.mock.callCount(), 1);
    assert.equal(result.reason, 'channel_empty');
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes('Deepgram closed'));
    // Falls back to session transcript
    assert.equal(result.transcriptCount, 1);
  });

  it('should handle session without audio coordinator', async () => {
    const session = createMockSession({ audioCoordinator: null });
    const sm = createMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-123', reason: 'connection_destroyed' });

    assert.equal(sm.stopSession.mock.callCount(), 1);
    assert.equal(result.reason, 'connection_destroyed');
    assert.equal(result.transcriptCount, 1); // from session.transcript
    // Implementation adds a warning when no audio coordinator is attached
    assert.ok(result.warnings.some(w => w.includes('No audio coordinator')));
  });

  it('should skip coordinator stop when not running', async () => {
    const stopMock = mock.fn(async () => ({}));
    const session = createMockSession({
      audioCoordinator: { isRunning: false, stop: stopMock },
    });
    const sm = createMockSessionManager(session);

    const result = await cleanupSession({ sessionManager: sm, guildId: 'guild-123', reason: 'manual_stop' });

    assert.equal(stopMock.mock.callCount(), 0); // Should NOT call stop
    assert.equal(sm.stopSession.mock.callCount(), 1);
  });
});

describe('formatCleanupMessage', () => {
  it('should format manual_stop message', () => {
    const msg = formatCleanupMessage({
      reason: 'manual_stop',
      durationMinutes: 5,
      durationSeconds: 30,
      participantCount: 3,
      transcriptCount: 42,
      transcriptFilePath: '/data/test.json',
      warnings: [],
    });

    assert.ok(msg.includes('Recording stopped'));
    assert.ok(msg.includes('5m 30s'));
    assert.ok(msg.includes('Participants: **3**'));
    assert.ok(msg.includes('Transcript entries: **42**'));
    assert.ok(msg.includes('Transcript saved'));
    assert.ok(msg.includes('Generating meeting minutes'));
  });

  it('should format channel_empty message', () => {
    const msg = formatCleanupMessage({
      reason: 'channel_empty',
      durationMinutes: 10,
      durationSeconds: 0,
      participantCount: 2,
      transcriptCount: 100,
      transcriptFilePath: null,
      warnings: [],
    });

    assert.ok(msg.includes('auto-stopped'));
    assert.ok(msg.includes('voice channel empty'));
    assert.ok(!msg.includes('Transcript saved')); // no file path
  });

  it('should format connection_destroyed message', () => {
    const msg = formatCleanupMessage({
      reason: 'connection_destroyed',
      durationMinutes: 1,
      durationSeconds: 15,
      participantCount: 1,
      transcriptCount: 5,
      transcriptFilePath: null,
      warnings: [],
    });

    assert.ok(msg.includes('auto-stopped'));
    assert.ok(msg.includes('connection lost'));
  });

  it('should include warnings', () => {
    const msg = formatCleanupMessage({
      reason: 'manual_stop',
      durationMinutes: 0,
      durationSeconds: 10,
      participantCount: 0,
      transcriptCount: 0,
      transcriptFilePath: null,
      warnings: ['Audio coordinator error: timeout'],
    });

    // Implementation shows warning count summary, not individual warnings
    assert.ok(msg.includes('warning(s) during cleanup'));
  });

  it('should handle unknown reason gracefully', () => {
    const msg = formatCleanupMessage({
      reason: 'shutdown',
      durationMinutes: 0,
      durationSeconds: 5,
      participantCount: 0,
      transcriptCount: 0,
      transcriptFilePath: null,
      warnings: [],
    });

    // Implementation maps 'shutdown' to 'Recording stopped (bot shutting down)'
    assert.ok(msg.includes('shutting down') || msg.includes('Recording stopped'));
  });
});
