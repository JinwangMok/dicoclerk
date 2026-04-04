/**
 * Voice Session Manager
 *
 * Coordinates a recording session lifecycle:
 * - Creates and manages VoiceConnectionManager
 * - Tracks participants and session metadata
 * - Handles auto-disconnect on empty channel
 * - Provides session state for commands and MCP tools
 */

import { EventEmitter } from 'node:events';
import { VoiceConnectionManager } from './connection-manager.js';

/**
 * @typedef {Object} SessionInfo
 * @property {string} guildId
 * @property {string} voiceChannelId
 * @property {string} textChannelId
 * @property {string} language
 * @property {Date} startedAt
 * @property {string} startedBy
 * @property {Set<string>} participants - user IDs that have spoken
 * @property {Array<Object>} transcript - accumulated transcript entries
 * @property {'active' | 'stopping' | 'stopped'} status
 */

/**
 * Events emitted:
 * - 'sessionStart'     : SessionInfo
 * - 'sessionEnd'       : { session: SessionInfo, reason: string, duration: number }
 * - 'audioStream'      : { userId: string, stream: Readable, session: SessionInfo }
 * - 'connectionLost'   : { guildId: string, error: Error }
 * - 'connectionRestore': { guildId: string }
 * - 'channelEmpty'     : { guildId: string }
 * - 'error'            : Error
 */
export class SessionManager extends EventEmitter {
  /** @type {Map<string, { connectionManager: VoiceConnectionManager, session: SessionInfo }>} */
  #sessions = new Map();

  /** Delay before auto-disconnect on empty channel (ms) */
  static EMPTY_CHANNEL_DELAY = 5000;

  /** @type {Map<string, NodeJS.Timeout>} pending empty-channel timers */
  #emptyTimers = new Map();

  /**
   * Start a new recording session.
   * @param {Object} options
   * @param {import('discord.js').VoiceBasedChannel} options.voiceChannel
   * @param {string} options.textChannelId
   * @param {import('discord.js').Guild} options.guild
   * @param {string} options.language
   * @param {string} options.startedBy - user tag
   * @returns {Promise<SessionInfo>}
   */
  async startSession({ voiceChannel, textChannelId, guild, language, startedBy }) {
    const guildId = guild.id;

    if (this.#sessions.has(guildId)) {
      throw new Error(`A session is already active in guild ${guildId}`);
    }

    // Create connection manager
    const connectionManager = new VoiceConnectionManager({
      guildId,
      channelId: voiceChannel.id,
      guild,
    });

    // Create session info
    /** @type {SessionInfo} */
    const session = {
      guildId,
      voiceChannelId: voiceChannel.id,
      textChannelId,
      language,
      startedAt: new Date(),
      startedBy,
      participants: new Set(),
      transcript: [],
      status: 'active',
    };

    // Store before connecting (to prevent race conditions)
    this.#sessions.set(guildId, { connectionManager, session });

    try {
      // Join the voice channel
      await connectionManager.join();

      // Set up auto-subscribe for new speakers.
      // In coordinator mode (AudioSessionCoordinator attached via session.audioCoordinator),
      // the AudioCapturePipeline subscribes to per-user Opus streams in direct mode.
      // enableAutoSubscribe still runs for participant tracking and for emitting
      // audioStream events that consumer-mode integrations can use.
      connectionManager.enableAutoSubscribe(({ userId, stream }) => {
        session.participants.add(userId);
        this.emit('audioStream', { userId, stream, session });
      });

      // Handle connection lifecycle events
      connectionManager.on('disconnected', ({ reason, closeCode }) => {
        console.log(`[SessionManager] Connection lost in guild=${guildId}: ${reason} (${closeCode})`);
        this.emit('connectionLost', {
          guildId,
          error: new Error(`Voice disconnected: ${reason} (code: ${closeCode})`),
        });
      });

      connectionManager.on('ready', () => {
        // Connection restored after a disconnect
        if (session.status === 'active') {
          console.log(`[SessionManager] Connection restored in guild=${guildId}`);
          this.emit('connectionRestore', { guildId });
        }
      });

      connectionManager.on('destroyed', () => {
        // Only auto-end if session is still active (not already stopping)
        if (session.status === 'active') {
          console.log(`[SessionManager] Connection destroyed unexpectedly in guild=${guildId}`);
          this.#endSession(guildId, 'connection_destroyed');
        }
      });

      connectionManager.on('error', (error) => {
        console.error(`[SessionManager] Connection error in guild=${guildId}:`, error.message);
        this.emit('error', error);
      });

      this.emit('sessionStart', session);
      console.log(`[SessionManager] Session started in guild=${guildId}`);

      return session;
    } catch (error) {
      // Clean up on failure
      this.#sessions.delete(guildId);
      connectionManager.destroy();
      throw error;
    }
  }

  /**
   * Stop a recording session manually.
   * @param {string} guildId
   * @returns {SessionInfo | null}
   */
  stopSession(guildId) {
    return this.#endSession(guildId, 'manual_stop');
  }

  /**
   * Internal session end handler.
   * @param {string} guildId
   * @param {string} reason - 'manual_stop' | 'channel_empty' | 'connection_destroyed'
   * @returns {SessionInfo | null}
   */
  #endSession(guildId, reason) {
    const entry = this.#sessions.get(guildId);
    if (!entry) return null;

    const { connectionManager, session } = entry;

    // Prevent double-stop
    if (session.status !== 'active') return session;

    session.status = 'stopping';

    // Clear any empty-channel timer
    const timer = this.#emptyTimers.get(guildId);
    if (timer) {
      clearTimeout(timer);
      this.#emptyTimers.delete(guildId);
    }

    // Calculate duration
    const duration = Math.round((Date.now() - session.startedAt.getTime()) / 1000);

    // Destroy voice connection
    connectionManager.destroy();

    // Remove from active sessions
    this.#sessions.delete(guildId);
    session.status = 'stopped';

    console.log(`[SessionManager] Session ended in guild=${guildId} reason=${reason} duration=${duration}s`);

    this.emit('sessionEnd', { session, reason, duration });

    return session;
  }

  /**
   * Handle a voice state update (user join/leave voice channel).
   * Used to detect when the channel becomes empty and to cancel
   * the empty-channel timer when a human user joins back.
   *
   * Cases handled:
   * 1. User leaves tracked channel (check if now empty)
   * 2. User moves from tracked channel to another (check if now empty)
   * 3. User joins tracked channel from nowhere (cancel empty timer)
   * 4. User moves from another channel to tracked channel (cancel empty timer)
   * 5. Bot users are always ignored for counting purposes
   *
   * @param {import('discord.js').VoiceState} oldState
   * @param {import('discord.js').VoiceState} newState
   */
  handleVoiceStateUpdate(oldState, newState) {
    const guildId = oldState.guild.id;
    const entry = this.#sessions.get(guildId);
    if (!entry) return;

    const { connectionManager, session } = entry;
    if (session.status !== 'active') return;

    const trackedChannelId = session.voiceChannelId;
    const leftTrackedChannel = oldState.channelId === trackedChannelId && newState.channelId !== trackedChannelId;
    const joinedTrackedChannel = newState.channelId === trackedChannelId && oldState.channelId !== trackedChannelId;
    const isBot = oldState.member?.user.bot || newState.member?.user.bot;

    // Ignore bot user movements entirely
    if (isBot) return;

    // --- Human user joined the tracked channel → cancel empty timer ---
    if (joinedTrackedChannel) {
      const timer = this.#emptyTimers.get(guildId);
      if (timer) {
        clearTimeout(timer);
        this.#emptyTimers.delete(guildId);
        console.log(`[SessionManager] Empty-channel timer cancelled in guild=${guildId} (user joined)`);
      }
      return;
    }

    // --- Human user left the tracked channel → check if empty ---
    if (leftTrackedChannel) {
      // Already have a timer pending — no need to start another
      if (this.#emptyTimers.has(guildId)) return;

      const humanCount = connectionManager.getHumanMemberCount();

      if (humanCount === 0) {
        console.log(`[SessionManager] Channel empty in guild=${guildId}, starting ${SessionManager.EMPTY_CHANNEL_DELAY}ms disconnect timer`);
        this.emit('channelEmpty', { guildId });

        // Delay before auto-disconnect to handle brief departures
        const timer = setTimeout(() => {
          this.#emptyTimers.delete(guildId);

          // Re-check — someone might have joined during the delay
          const currentEntry = this.#sessions.get(guildId);
          if (!currentEntry) return; // Session already ended

          const currentCount = currentEntry.connectionManager.getHumanMemberCount();
          if (currentCount === 0) {
            console.log(`[SessionManager] Auto-stopping session in guild=${guildId} (channel still empty)`);
            this.#endSession(guildId, 'channel_empty');
          } else {
            console.log(`[SessionManager] Channel no longer empty in guild=${guildId}, aborting auto-stop`);
          }
        }, SessionManager.EMPTY_CHANNEL_DELAY);

        this.#emptyTimers.set(guildId, timer);
      }
    }
  }

  /**
   * Check if a guild has an active session.
   * @param {string} guildId
   * @returns {boolean}
   */
  hasSession(guildId) {
    return this.#sessions.has(guildId);
  }

  /**
   * Get session info for a guild.
   * @param {string} guildId
   * @returns {SessionInfo | null}
   */
  getSession(guildId) {
    return this.#sessions.get(guildId)?.session ?? null;
  }

  /**
   * Get the connection manager for a guild.
   * @param {string} guildId
   * @returns {VoiceConnectionManager | null}
   */
  getConnectionManager(guildId) {
    return this.#sessions.get(guildId)?.connectionManager ?? null;
  }

  /**
   * Get all active sessions.
   * @returns {Map<string, SessionInfo>}
   */
  getAllSessions() {
    const result = new Map();
    for (const [guildId, { session }] of this.#sessions) {
      result.set(guildId, session);
    }
    return result;
  }

  /**
   * Destroy all sessions and clean up.
   */
  destroyAll() {
    for (const [guildId] of this.#sessions) {
      this.#endSession(guildId, 'shutdown');
    }

    for (const [, timer] of this.#emptyTimers) {
      clearTimeout(timer);
    }
    this.#emptyTimers.clear();
  }
}
