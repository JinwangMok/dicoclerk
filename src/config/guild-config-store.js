/**
 * GuildConfigStore
 *
 * Persistent per-guild configuration store backed by a JSON file on disk.
 * Stores settings such as the designated text channel for meeting minutes delivery.
 *
 * File location: <cwd>/data/guild-config.json
 *
 * Schema (per guild entry):
 * {
 *   "textChannelId": string | null   — target channel for minutes/notifications
 * }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

const CONFIG_PATH = join(process.cwd(), 'data', 'guild-config.json');

/**
 * @typedef {Object} GuildConfig
 * @property {string|null} textChannelId - Designated text channel for meeting minutes
 */

export class GuildConfigStore {
  /** @type {Map<string, GuildConfig>} in-memory cache */
  #cache = new Map();

  /** @type {boolean} whether cache has been loaded from disk */
  #loaded = false;

  /** @type {string} path to the config JSON file */
  #filePath;

  /**
   * @param {Object} [options]
   * @param {string} [options.filePath] - Override file path (for testing)
   */
  constructor({ filePath = CONFIG_PATH } = {}) {
    this.#filePath = filePath;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get the designated text channel ID for a guild.
   * Returns null if not configured.
   *
   * @param {string} guildId
   * @returns {Promise<string|null>}
   */
  async getTextChannelId(guildId) {
    await this.#ensureLoaded();
    return this.#cache.get(guildId)?.textChannelId ?? null;
  }

  /**
   * Set the designated text channel ID for a guild.
   * Persists to disk immediately.
   *
   * @param {string} guildId
   * @param {string} channelId
   * @returns {Promise<void>}
   */
  async setTextChannelId(guildId, channelId) {
    await this.#ensureLoaded();
    const existing = this.#cache.get(guildId) ?? {};
    this.#cache.set(guildId, { ...existing, textChannelId: channelId });
    await this.#persist();
  }

  /**
   * Clear the designated text channel for a guild.
   *
   * @param {string} guildId
   * @returns {Promise<void>}
   */
  async clearTextChannelId(guildId) {
    await this.#ensureLoaded();
    const existing = this.#cache.get(guildId) ?? {};
    this.#cache.set(guildId, { ...existing, textChannelId: null });
    await this.#persist();
  }

  /**
   * Get the full config object for a guild.
   * Returns defaults if not configured.
   *
   * @param {string} guildId
   * @returns {Promise<GuildConfig>}
   */
  async getConfig(guildId) {
    await this.#ensureLoaded();
    return this.#cache.get(guildId) ?? { textChannelId: null };
  }

  /**
   * Check whether a guild has a configured text channel.
   *
   * @param {string} guildId
   * @returns {Promise<boolean>}
   */
  async hasTextChannel(guildId) {
    const id = await this.getTextChannelId(guildId);
    return id !== null && id !== '';
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  /**
   * Load config from disk into cache if not already loaded.
   * Silently handles missing file (first-run).
   */
  async #ensureLoaded() {
    if (this.#loaded) return;
    await this.#load();
    this.#loaded = true;
  }

  async #load() {
    if (!existsSync(this.#filePath)) {
      // No config file yet — start with empty cache
      return;
    }

    try {
      const raw = await readFile(this.#filePath, 'utf-8');
      const data = JSON.parse(raw);

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [guildId, config] of Object.entries(data)) {
          this.#cache.set(guildId, {
            textChannelId: config.textChannelId ?? null,
          });
        }
      }
    } catch (err) {
      // Corrupt or unreadable file — log and start fresh
      console.warn('[GuildConfigStore] Failed to load config, starting fresh:', err.message);
    }
  }

  async #persist() {
    try {
      await mkdir(dirname(this.#filePath), { recursive: true });

      const data = {};
      for (const [guildId, config] of this.#cache) {
        data[guildId] = config;
      }

      await writeFile(this.#filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[GuildConfigStore] Failed to persist config:', err.message);
      throw err;
    }
  }

  /**
   * Reload from disk (useful after external changes).
   * @returns {Promise<void>}
   */
  async reload() {
    this.#cache.clear();
    this.#loaded = false;
    await this.#ensureLoaded();
  }
}

// Singleton instance for application-wide use
export const guildConfigStore = new GuildConfigStore();
