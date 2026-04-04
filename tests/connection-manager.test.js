/**
 * Tests for VoiceConnectionManager
 */

import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

// We test VoiceConnectionManager by mocking the @discordjs/voice module
// Since it uses joinVoiceChannel internally, we test the public API behavior

describe('VoiceConnectionManager', () => {
  let VoiceConnectionManager;

  beforeEach(async () => {
    const mod = await import('../src/voice/connection-manager.js');
    VoiceConnectionManager = mod.VoiceConnectionManager;
  });

  describe('constructor', () => {
    it('should initialize with idle state', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      assert.equal(manager.state, 'idle');
      assert.equal(manager.isReady, false);
      assert.equal(manager.channelId, '456');
      assert.equal(manager.guildId, '123');
    });

    it('should start with empty subscriber set', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      assert.equal(manager.subscribedUsers.size, 0);
    });

    it('should be an EventEmitter', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      assert.equal(typeof manager.on, 'function');
      assert.equal(typeof manager.emit, 'function');
      assert.equal(typeof manager.removeListener, 'function');
    });
  });

  describe('subscribeToUser', () => {
    it('should return null when not ready', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      const result = manager.subscribeToUser('user-1');
      assert.equal(result, null);
    });
  });

  describe('destroy', () => {
    it('should set state to destroyed', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      manager.destroy();
      assert.equal(manager.state, 'destroyed');
    });

    it('should emit destroyed event', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      let emitted = false;
      manager.on('destroyed', () => { emitted = true; });

      manager.destroy();
      assert.equal(emitted, true);
    });

    it('should be safe to call multiple times', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      manager.destroy();
      manager.destroy(); // should not throw
      assert.equal(manager.state, 'destroyed');
    });

    it('should clear subscribed users', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      manager.destroy();
      assert.equal(manager.subscribedUsers.size, 0);
    });
  });

  describe('join', () => {
    it('should reject if already destroyed', async () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      manager.destroy();

      await assert.rejects(
        () => manager.join(),
        { message: 'Connection manager has been destroyed. Create a new instance.' }
      );
    });
  });

  describe('getHumanMemberCount', () => {
    it('should return 0 when channel not found', () => {
      const guild = createFakeGuild();
      guild.channels.cache.get = () => null;

      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild,
      });

      assert.equal(manager.getHumanMemberCount(), 0);
    });

    it('should count only non-bot members', () => {
      const guild = createFakeGuild({
        channelMembers: [
          { user: { bot: false } },
          { user: { bot: true } },
          { user: { bot: false } },
        ],
      });

      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild,
      });

      assert.equal(manager.getHumanMemberCount(), 2);
    });

    it('should return 0 when all members are bots', () => {
      const guild = createFakeGuild({
        channelMembers: [
          { user: { bot: true } },
          { user: { bot: true } },
        ],
      });

      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild,
      });

      assert.equal(manager.getHumanMemberCount(), 0);
    });
  });

  describe('static config', () => {
    it('should have sensible timeout defaults', () => {
      assert.equal(VoiceConnectionManager.MAX_RECONNECT_ATTEMPTS, 5);
      assert.equal(VoiceConnectionManager.CONNECTION_TIMEOUT, 15_000);
      assert.equal(VoiceConnectionManager.RECONNECT_TIMEOUT, 10_000);
    });
  });
});

// --- Helpers ---

function createFakeGuild({ channelMembers = [] } = {}) {
  const membersCollection = {
    filter: (fn) => {
      const filtered = channelMembers.filter(fn);
      return { size: filtered.length };
    },
  };

  return {
    id: '123',
    voiceAdapterCreator: {},
    channels: {
      cache: {
        get: (id) => ({
          members: membersCollection,
        }),
      },
    },
  };
}
