import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GuildConfigStore } from '../src/config/guild-config-store.js';

/**
 * Create a temporary file path for a test config file.
 * Uses a unique name per test run to avoid collisions.
 */
function tempConfigPath(suffix = '') {
  return join(tmpdir(), `dicoclerk-test-guild-config-${Date.now()}${suffix}.json`);
}

describe('GuildConfigStore', () => {
  describe('fresh store (no config file)', () => {
    it('getTextChannelId returns null for unknown guild', async () => {
      const filePath = tempConfigPath('-fresh');
      const store = new GuildConfigStore({ filePath });
      const result = await store.getTextChannelId('guild-abc');
      assert.equal(result, null);
    });

    it('hasTextChannel returns false for unknown guild', async () => {
      const filePath = tempConfigPath('-fresh2');
      const store = new GuildConfigStore({ filePath });
      const result = await store.hasTextChannel('guild-abc');
      assert.equal(result, false);
    });

    it('getConfig returns default config for unknown guild', async () => {
      const filePath = tempConfigPath('-fresh3');
      const store = new GuildConfigStore({ filePath });
      const config = await store.getConfig('guild-abc');
      assert.deepEqual(config, { textChannelId: null });
    });
  });

  describe('setTextChannelId', () => {
    it('stores and retrieves a channel ID', async () => {
      const filePath = tempConfigPath('-set');
      const store = new GuildConfigStore({ filePath });

      await store.setTextChannelId('guild-123', 'channel-456');
      const result = await store.getTextChannelId('guild-123');
      assert.equal(result, 'channel-456');
    });

    it('persists to disk and loads in a new instance', async () => {
      const filePath = tempConfigPath('-persist');
      const store1 = new GuildConfigStore({ filePath });
      await store1.setTextChannelId('guild-999', 'channel-777');

      // New store instance pointing to same file
      const store2 = new GuildConfigStore({ filePath });
      const result = await store2.getTextChannelId('guild-999');
      assert.equal(result, 'channel-777');

      // Clean up
      await unlink(filePath).catch(() => {});
    });

    it('overwrites an existing channel ID', async () => {
      const filePath = tempConfigPath('-overwrite');
      const store = new GuildConfigStore({ filePath });

      await store.setTextChannelId('guild-123', 'channel-old');
      await store.setTextChannelId('guild-123', 'channel-new');

      const result = await store.getTextChannelId('guild-123');
      assert.equal(result, 'channel-new');

      await unlink(filePath).catch(() => {});
    });

    it('stores configs for multiple guilds independently', async () => {
      const filePath = tempConfigPath('-multi');
      const store = new GuildConfigStore({ filePath });

      await store.setTextChannelId('guild-A', 'channel-A');
      await store.setTextChannelId('guild-B', 'channel-B');

      assert.equal(await store.getTextChannelId('guild-A'), 'channel-A');
      assert.equal(await store.getTextChannelId('guild-B'), 'channel-B');
      assert.equal(await store.getTextChannelId('guild-C'), null);

      await unlink(filePath).catch(() => {});
    });
  });

  describe('clearTextChannelId', () => {
    it('sets textChannelId to null', async () => {
      const filePath = tempConfigPath('-clear');
      const store = new GuildConfigStore({ filePath });

      await store.setTextChannelId('guild-123', 'channel-456');
      await store.clearTextChannelId('guild-123');

      const result = await store.getTextChannelId('guild-123');
      assert.equal(result, null);

      await unlink(filePath).catch(() => {});
    });

    it('hasTextChannel returns false after clearing', async () => {
      const filePath = tempConfigPath('-clear2');
      const store = new GuildConfigStore({ filePath });

      await store.setTextChannelId('guild-123', 'channel-456');
      await store.clearTextChannelId('guild-123');

      const result = await store.hasTextChannel('guild-123');
      assert.equal(result, false);

      await unlink(filePath).catch(() => {});
    });
  });

  describe('hasTextChannel', () => {
    it('returns true when a channel ID is set', async () => {
      const filePath = tempConfigPath('-has');
      const store = new GuildConfigStore({ filePath });

      await store.setTextChannelId('guild-X', 'channel-Y');
      assert.equal(await store.hasTextChannel('guild-X'), true);

      await unlink(filePath).catch(() => {});
    });

    it('returns false when channel ID is null', async () => {
      const filePath = tempConfigPath('-has2');
      const store = new GuildConfigStore({ filePath });
      assert.equal(await store.hasTextChannel('guild-never-set'), false);
    });
  });

  describe('reload', () => {
    it('re-reads config from disk after external modification', async () => {
      const filePath = tempConfigPath('-reload');

      // Write initial config directly
      await mkdir(join(tmpdir()), { recursive: true });
      await writeFile(filePath, JSON.stringify({ 'guild-reload': { textChannelId: 'ch-initial' } }), 'utf-8');

      const store = new GuildConfigStore({ filePath });
      assert.equal(await store.getTextChannelId('guild-reload'), 'ch-initial');

      // Update config on disk externally
      await writeFile(filePath, JSON.stringify({ 'guild-reload': { textChannelId: 'ch-updated' } }), 'utf-8');

      // Without reload the cache still returns old value
      assert.equal(await store.getTextChannelId('guild-reload'), 'ch-initial');

      // After reload, picks up new value
      await store.reload();
      assert.equal(await store.getTextChannelId('guild-reload'), 'ch-updated');

      await unlink(filePath).catch(() => {});
    });
  });

  describe('corrupt config file', () => {
    it('starts fresh without throwing when config file is corrupt', async () => {
      const filePath = tempConfigPath('-corrupt');
      await writeFile(filePath, 'this is not valid json }{', 'utf-8');

      const store = new GuildConfigStore({ filePath });
      // Should not throw — falls back to empty state
      const result = await store.getTextChannelId('guild-abc');
      assert.equal(result, null);

      await unlink(filePath).catch(() => {});
    });
  });
});
