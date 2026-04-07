/**
 * Voice Connection Manager
 *
 * Manages the Discord voice connection lifecycle including:
 * - Joining/leaving voice channels
 * - Connection state transitions and error recovery
 * - Auto-reconnect on network issues
 * - Audio stream subscription for each participant
 * - Graceful cleanup on disconnect
 */

import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  entersState,
  getVoiceConnection,
} from '@discordjs/voice';
import { EventEmitter } from 'node:events';

/**
 * Events emitted:
 * - 'ready'            : void — connection is ready for audio
 * - 'disconnected'     : { reason, closeCode } — connection lost
 * - 'reconnecting'     : void — attempting automatic reconnection
 * - 'destroyed'        : void — connection fully cleaned up
 * - 'error'            : Error — non-recoverable error
 * - 'userJoin'         : { userId, ssrc } — user started speaking / joined audio
 * - 'userLeave'        : { userId } — user left the voice channel
 * - 'audioStream'      : { userId, stream } — new audio stream from a user
 * - 'stateChange'      : { oldStatus, newStatus } — connection state changed
 */
export class VoiceConnectionManager extends EventEmitter {
  /** @type {import('@discordjs/voice').VoiceConnection | null} */
  #connection = null;

  /** @type {string} */
  #guildId;

  /** @type {string} */
  #channelId;

  /** @type {import('discord.js').Guild} */
  #guild;

  /** @type {Set<string>} user IDs currently being received */
  #subscribedUsers = new Set();

  /** @type {'idle' | 'connecting' | 'ready' | 'reconnecting' | 'destroyed'} */
  #state = 'idle';

  /** @type {number} */
  #reconnectAttempts = 0;

  /** Maximum reconnect attempts before giving up */
  static MAX_RECONNECT_ATTEMPTS = 5;

  /** Timeout for waiting for connection ready state (ms) */
  static CONNECTION_TIMEOUT = 15_000;

  /** Timeout for waiting for reconnection (ms) */
  static RECONNECT_TIMEOUT = 10_000;

  /**
   * @param {Object} options
   * @param {string} options.guildId
   * @param {string} options.channelId
   * @param {import('discord.js').Guild} options.guild
   */
  constructor({ guildId, channelId, guild }) {
    super();
    this.#guildId = guildId;
    this.#channelId = channelId;
    this.#guild = guild;
  }

  /** Current connection state */
  get state() {
    return this.#state;
  }

  /** Whether the connection is ready for audio */
  get isReady() {
    return this.#state === 'ready';
  }

  /** The voice channel ID */
  get channelId() {
    return this.#channelId;
  }

  /** The guild ID */
  get guildId() {
    return this.#guildId;
  }

  /** Set of user IDs currently subscribed for audio */
  get subscribedUsers() {
    return new Set(this.#subscribedUsers);
  }

  /** The underlying voice connection (if any) */
  get connection() {
    return this.#connection;
  }

  /**
   * Join the voice channel and establish a connection.
   * Resolves when the connection is ready.
   * @returns {Promise<void>}
   */
  async join() {
    if (this.#state === 'ready') {
      this.emit('warning', 'Already connected to voice channel');
      return;
    }

    if (this.#state === 'destroyed') {
      throw new Error('Connection manager has been destroyed. Create a new instance.');
    }

    this.#state = 'connecting';
    this.emit('stateChange', { oldStatus: 'idle', newStatus: 'connecting' });

    try {
      this.#connection = joinVoiceChannel({
        channelId: this.#channelId,
        guildId: this.#guildId,
        adapterCreator: this.#guild.voiceAdapterCreator,
        selfDeaf: false,  // Must not be deaf to receive audio
        selfMute: true,   // Bot doesn't need to speak
      });

      this.#setupConnectionHandlers();

      // Wait for the connection to be ready
      await entersState(
        this.#connection,
        VoiceConnectionStatus.Ready,
        VoiceConnectionManager.CONNECTION_TIMEOUT
      );

      this.#state = 'ready';
      this.#reconnectAttempts = 0;
      this.emit('stateChange', { oldStatus: 'connecting', newStatus: 'ready' });
      this.emit('ready');

      console.log(`[VoiceConnection] Ready in guild=${this.#guildId} channel=${this.#channelId}`);
    } catch (error) {
      this.#state = 'idle';
      this.emit('stateChange', { oldStatus: 'connecting', newStatus: 'idle' });
      this.emit('error', error);

      // Clean up partial connection
      if (this.#connection) {
        this.#connection.destroy();
        this.#connection = null;
      }

      throw error;
    }
  }

  /**
   * Set up event handlers on the voice connection for lifecycle management.
   */
  #setupConnectionHandlers() {
    if (!this.#connection) return;

    this.#connection.on(VoiceConnectionStatus.Disconnected, async (_, newState) => {
      const closeCode = newState?.closeCode;
      const reason = newState?.reason;

      console.log(`[VoiceConnection] Disconnected: code=${closeCode} reason=${reason}`);
      this.emit('disconnected', { reason, closeCode });

      /*
       * Discord.js voice connection disconnect handling:
       * - Close code 4014: bot was moved or disconnected by a moderator
       *   → We should try to reconnect (or the adapter may auto-recover)
       * - WebSocket close (reason = WebSocketClose): network issue
       *   → Try to reconnect with backoff
       * - Adapter unavailable: Discord adapter failed
       *   → Wait briefly, then try to reconnect
       */
      if (
        reason === VoiceConnectionDisconnectReason.WebSocketClose &&
        closeCode === 4014
      ) {
        // Bot was kicked or moved — wait for Discord adapter to attempt recovery.
        // If Discord reassigns the bot to a channel, the connection will transition
        // through Connecting → Ready automatically. We must NOT call rejoin() here,
        // as the server-side state is being managed by Discord.
        try {
          await entersState(
            this.#connection,
            VoiceConnectionStatus.Connecting,
            VoiceConnectionManager.RECONNECT_TIMEOUT
          );
          // Adapter is recovering — now wait for full Ready state
          await entersState(
            this.#connection,
            VoiceConnectionStatus.Ready,
            VoiceConnectionManager.RECONNECT_TIMEOUT
          );
          this.#state = 'ready';
          this.#reconnectAttempts = 0;
          this.emit('stateChange', { oldStatus: 'reconnecting', newStatus: 'ready' });
          this.emit('ready');
          console.log('[VoiceConnection] Reconnected successfully after 4014 recovery');
        } catch {
          // Adapter didn't recover — destroy cleanly
          console.log('[VoiceConnection] Adapter recovery failed after 4014, destroying');
          this.destroy();
        }
      } else if (this.#reconnectAttempts < VoiceConnectionManager.MAX_RECONNECT_ATTEMPTS) {
        // Network disconnection — actively attempt reconnection via rejoin()
        this.#reconnectAttempts++;
        const oldStatus = this.#state;
        this.#state = 'reconnecting';
        this.emit('stateChange', { oldStatus, newStatus: 'reconnecting' });
        this.emit('reconnecting');

        console.log(
          `[VoiceConnection] Reconnect attempt ${this.#reconnectAttempts}/${VoiceConnectionManager.MAX_RECONNECT_ATTEMPTS}`
        );

        try {
          // Actively signal the connection to rejoin the channel.
          // Without this, the connection stays stuck in Disconnected state —
          // @discordjs/voice does not auto-reconnect non-4014 disconnects.
          this.#connection.rejoin();

          await entersState(
            this.#connection,
            VoiceConnectionStatus.Ready,
            VoiceConnectionManager.RECONNECT_TIMEOUT
          );

          this.#state = 'ready';
          this.#reconnectAttempts = 0;
          this.emit('stateChange', { oldStatus: 'reconnecting', newStatus: 'ready' });
          this.emit('ready');
          console.log('[VoiceConnection] Reconnected successfully');
        } catch {
          // Connection didn't recover — try again or give up
          if (this.#reconnectAttempts >= VoiceConnectionManager.MAX_RECONNECT_ATTEMPTS) {
            console.log('[VoiceConnection] Max reconnect attempts reached, destroying');
            this.emit('error', new Error('Voice connection lost after maximum reconnect attempts'));
            this.destroy();
          }
          // Otherwise the Disconnected event will fire again on the next attempt
        }
      } else {
        // Exhausted reconnect attempts
        console.log('[VoiceConnection] Reconnection exhausted, destroying');
        this.emit('error', new Error('Voice connection lost after maximum reconnect attempts'));
        this.destroy();
      }
    });

    this.#connection.on(VoiceConnectionStatus.Destroyed, () => {
      // Capture previous state BEFORE mutating this.#state
      const oldStatus = this.#state;
      console.log(`[VoiceConnection] Connection destroyed (was: ${oldStatus})`);
      this.#state = 'destroyed';
      this.#subscribedUsers.clear();
      this.#connection = null;
      this.emit('stateChange', { oldStatus, newStatus: 'destroyed' });
      this.emit('destroyed');
    });

    // Handle errors on the connection
    this.#connection.on('error', (error) => {
      console.error('[VoiceConnection] Error:', error.message);
      this.emit('error', error);
    });
  }

  /**
   * Subscribe to a user's audio stream.
   * The receiver must be obtained AFTER the connection is ready.
   * @param {string} userId - Discord user ID
   * @returns {{ stream: import('stream').Readable, userId: string } | null}
   */
  subscribeToUser(userId) {
    if (!this.#connection || this.#state !== 'ready') {
      console.warn(`[VoiceConnection] Cannot subscribe to user ${userId}: not ready`);
      return null;
    }

    if (this.#subscribedUsers.has(userId)) {
      return null; // Already subscribed
    }

    try {
      const receiver = this.#connection.receiver;

      // Subscribe returns an Opus stream for the user
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: /** @type {any} */ ('afterSilence'),
          duration: 1000, // End stream after 1s of silence
        },
      });

      this.#subscribedUsers.add(userId);

      opusStream.on('close', () => {
        this.#subscribedUsers.delete(userId);
      });

      opusStream.on('error', (err) => {
        console.error(`[VoiceConnection] Audio stream error for user ${userId}:`, err.message);
        this.#subscribedUsers.delete(userId);
      });

      this.emit('audioStream', { userId, stream: opusStream });

      console.log(`[VoiceConnection] Subscribed to audio for user=${userId}`);
      return { stream: opusStream, userId };
    } catch (error) {
      console.error(`[VoiceConnection] Failed to subscribe to user ${userId}:`, error.message);
      return null;
    }
  }

  /**
   * Set up the speaking event listener to auto-subscribe to new speakers.
   * Call this after the connection is ready.
   * @param {Function} [onNewSpeaker] - Optional callback for new speaker audio streams
   */
  enableAutoSubscribe(onNewSpeaker) {
    if (!this.#connection) return;

    const receiver = this.#connection.receiver;

    receiver.speaking.on('start', (userId) => {
      if (this.#subscribedUsers.has(userId)) return;

      console.log(`[VoiceConnection] New speaker detected: ${userId}`);
      const result = this.subscribeToUser(userId);

      if (result && onNewSpeaker) {
        onNewSpeaker(result);
      }

      this.emit('userJoin', { userId });
    });

    receiver.speaking.on('end', (userId) => {
      // Note: This doesn't mean the user left — just that they stopped speaking
      // The audio stream's 'end' event handles actual stream cleanup
    });

    console.log('[VoiceConnection] Auto-subscribe enabled');
  }

  /**
   * Gracefully disconnect and clean up all resources.
   */
  destroy() {
    if (this.#state === 'destroyed') return;

    console.log(`[VoiceConnection] Destroying connection in guild=${this.#guildId}`);

    this.#subscribedUsers.clear();

    // Capture oldStatus BEFORE any mutation so stateChange reports the correct prior state
    const oldStatus = this.#state;

    if (this.#connection) {
      try {
        // connection.destroy() may fire VoiceConnectionStatus.Destroyed synchronously,
        // which would already set this.#state = 'destroyed' and emit stateChange/destroyed.
        this.#connection.destroy();
      } catch {
        // Already destroyed
      }
      this.#connection = null;
    }

    // Guard: if the VoiceConnectionStatus.Destroyed handler already ran (fired
    // synchronously from this.#connection.destroy() above), state is already
    // 'destroyed' and events were already emitted — avoid double-emitting.
    if (this.#state === 'destroyed') {
      this.removeAllListeners();
      return;
    }

    this.#state = 'destroyed';
    this.emit('stateChange', { oldStatus, newStatus: 'destroyed' });
    this.emit('destroyed');
    this.removeAllListeners();
  }

  /**
   * Check how many non-bot members are in the voice channel.
   * @returns {number}
   */
  getHumanMemberCount() {
    const channel = this.#guild.channels.cache.get(this.#channelId);
    if (!channel || !('members' in channel)) return 0;
    return channel.members.filter(m => !m.user.bot).size;
  }
}
