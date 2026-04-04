/**
 * Deepgram Connection Pool Manager
 *
 * Manages multiple simultaneous Deepgram STT connections (or a single
 * multiplexed connection) with proper resource pooling, connection lifecycle,
 * health monitoring, and cleanup for 5-10 concurrent speakers.
 *
 * Design decisions:
 * - Deepgram's nova-2 model handles diarization natively, so a single
 *   connection can process mixed audio from multiple speakers.
 * - The pool supports scaling to multiple connections when load demands it
 *   (e.g., high packet rates from many concurrent speakers).
 * - Each connection is wrapped with resilience (auto-reconnect, buffering).
 * - Connections are health-checked periodically and replaced if unhealthy.
 *
 * Usage modes:
 * 1. **Single-connection** (default): All audio routed to one connection.
 *    Deepgram diarization separates speakers. Simple and cost-effective.
 * 2. **Multi-connection**: Audio distributed across N connections for
 *    higher throughput. Results are merged with deduplication.
 */

import { EventEmitter } from 'node:events';
import { DeepgramStreamingClient } from './deepgram-client.js';
import { DeepgramConnectionResilience } from './connection-resilience.js';

/** Default pool configuration */
const POOL_DEFAULTS = {
  /** Minimum connections to keep alive */
  minConnections: 1,
  /** Maximum connections allowed */
  maxConnections: 3,
  /** Speakers-per-connection threshold to trigger scaling */
  speakersPerConnectionThreshold: 5,
  /** Health check interval (ms) */
  healthCheckIntervalMs: 15_000,
  /** Max idle time before a surplus connection is released (ms) */
  idleTimeoutMs: 60_000,
  /** Whether to auto-scale connections based on speaker count */
  autoScale: true,
  /** Deepgram API key */
  apiKey: null,
  /** Deepgram live options */
  liveOptions: {},
  /** Reconnection config */
  reconnect: {},
  /** Deduplication config */
  dedup: {},
};

/**
 * @typedef {Object} PooledConnection
 * @property {string} id - Unique connection identifier
 * @property {DeepgramStreamingClient} client - Deepgram streaming client
 * @property {DeepgramConnectionResilience} resilience - Resilience wrapper
 * @property {'idle'|'active'|'draining'|'closed'} status - Connection status
 * @property {Set<string>} assignedSpeakers - User IDs routed to this connection
 * @property {number} packetCount - Total packets sent through this connection
 * @property {number} createdAt - Creation timestamp
 * @property {number} lastActiveAt - Last packet timestamp
 * @property {number} errorCount - Cumulative errors on this connection
 */

/**
 * Events emitted:
 * - 'connection_added'    : { id, totalConnections }
 * - 'connection_removed'  : { id, reason, totalConnections }
 * - 'connection_healthy'  : { id }
 * - 'connection_unhealthy': { id, reason }
 * - 'scaled_up'           : { from, to, reason }
 * - 'scaled_down'         : { from, to, reason }
 * - 'transcript'          : TranscriptEvent (from any connection)
 * - 'transcript_duplicate': object (from any connection)
 * - 'utterance_end'       : void (from any connection)
 * - 'notification'        : NotificationMessage (from resilience)
 * - 'error'               : Error
 * - 'warning'             : string
 * - 'pool_stats'          : object - periodic stats snapshot
 */
export class DeepgramConnectionPool extends EventEmitter {
  /** @type {Map<string, PooledConnection>} */
  #connections = new Map();

  /** @type {typeof POOL_DEFAULTS} */
  #config;

  /** @type {NodeJS.Timeout|null} */
  #healthCheckTimer = null;

  /** @type {boolean} */
  #running = false;

  /** @type {number} */
  #connectionCounter = 0;

  /** @type {number} total speakers currently tracked across all connections */
  #totalSpeakers = 0;

  /** @type {Map<string, string>} userId -> connectionId routing table */
  #speakerRouting = new Map();

  /**
   * @param {Partial<typeof POOL_DEFAULTS>} config
   */
  constructor(config = {}) {
    super();

    this.#config = { ...POOL_DEFAULTS, ...config };

    if (!this.#config.apiKey) {
      throw new Error('Deepgram API key is required for connection pool');
    }

    if (this.#config.minConnections < 1) {
      throw new Error('minConnections must be at least 1');
    }

    if (this.#config.maxConnections < this.#config.minConnections) {
      throw new Error('maxConnections must be >= minConnections');
    }
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  /** Whether the pool is running */
  get isRunning() {
    return this.#running;
  }

  /** Number of active connections */
  get connectionCount() {
    return this.#connections.size;
  }

  /** Number of healthy (connected) connections */
  get healthyConnectionCount() {
    let count = 0;
    for (const conn of this.#connections.values()) {
      if (conn.client.isConnected && conn.status === 'active') {
        count++;
      }
    }
    return count;
  }

  /** Total speakers being tracked */
  get totalSpeakers() {
    return this.#speakerRouting.size;
  }

  /** Pool configuration (read-only copy) */
  get config() {
    return { ...this.#config };
  }

  /**
   * Initialize the pool: create minimum connections and start health checks.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#running) {
      this.emit('warning', 'Connection pool already running');
      return;
    }

    this.#running = true;

    // Create minimum connections in parallel
    const connectPromises = [];
    for (let i = 0; i < this.#config.minConnections; i++) {
      connectPromises.push(this.#createConnection());
    }

    const results = await Promise.allSettled(connectPromises);

    // Check that at least one connection succeeded
    const successes = results.filter(r => r.status === 'fulfilled');
    if (successes.length === 0) {
      this.#running = false;
      const firstError = results[0]?.reason ?? new Error('All connections failed');
      throw new Error(`Failed to establish any Deepgram connection: ${firstError.message}`);
    }

    if (successes.length < this.#config.minConnections) {
      this.emit('warning',
        `Only ${successes.length}/${this.#config.minConnections} initial connections established`
      );
    }

    // Start health monitoring
    this.#startHealthChecks();

    console.log(
      `[ConnectionPool] Started with ${this.#connections.size} connections ` +
      `(min=${this.#config.minConnections}, max=${this.#config.maxConnections})`
    );
  }

  /**
   * Send audio data from a specific speaker to the appropriate connection.
   * Routes to the speaker's assigned connection, or assigns one if new.
   *
   * @param {string} userId - Discord user ID of the speaker
   * @param {Buffer|Uint8Array} audioData - Opus audio packet
   * @returns {boolean} true if sent successfully
   */
  sendAudio(userId, audioData) {
    if (!this.#running) return false;

    // Get or assign a connection for this speaker
    const connId = this.#getOrAssignConnection(userId);
    if (!connId) {
      this.emit('warning', `No available connection for speaker ${userId}`);
      return false;
    }

    const pooled = this.#connections.get(connId);
    if (!pooled) return false;

    // If the connection is healthy, send directly
    if (pooled.client.isConnected) {
      const sent = pooled.client.send(audioData);
      if (sent) {
        pooled.packetCount++;
        pooled.lastActiveAt = Date.now();
        return true;
      }
    }

    // If connection is degraded, buffer via resilience
    if (pooled.resilience.shouldBuffer) {
      return pooled.resilience.bufferAudio(audioData);
    }

    // Connection is down and not buffering — try to reassign speaker
    return this.#reassignAndSend(userId, audioData, connId);
  }

  /**
   * Register a new speaker in the pool.
   * Triggers auto-scaling if speaker count exceeds threshold.
   *
   * @param {string} userId - Discord user ID
   */
  registerSpeaker(userId) {
    if (this.#speakerRouting.has(userId)) return;

    this.#getOrAssignConnection(userId);

    // Check if we should scale up
    if (this.#config.autoScale) {
      this.#checkScaleUp();
    }
  }

  /**
   * Unregister a speaker from the pool.
   * Triggers scale-down check if connections are underutilized.
   *
   * @param {string} userId - Discord user ID
   */
  unregisterSpeaker(userId) {
    const connId = this.#speakerRouting.get(userId);
    if (!connId) return;

    this.#speakerRouting.delete(userId);

    const pooled = this.#connections.get(connId);
    if (pooled) {
      pooled.assignedSpeakers.delete(userId);
    }

    // Check if we should scale down
    if (this.#config.autoScale) {
      this.#checkScaleDown();
    }
  }

  /**
   * Get pool statistics snapshot.
   * @returns {Object}
   */
  getStats() {
    const connections = [];
    for (const [id, conn] of this.#connections) {
      connections.push({
        id,
        status: conn.status,
        isConnected: conn.client.isConnected,
        clientState: conn.client.state,
        assignedSpeakers: conn.assignedSpeakers.size,
        packetCount: conn.packetCount,
        errorCount: conn.errorCount,
        resilienceState: conn.resilience.state,
        bufferedPackets: conn.resilience.bufferedPacketCount,
        droppedPackets: conn.resilience.droppedPackets,
        uptimeMs: Date.now() - conn.createdAt,
        idleMs: Date.now() - conn.lastActiveAt,
      });
    }

    return {
      running: this.#running,
      totalConnections: this.#connections.size,
      healthyConnections: this.healthyConnectionCount,
      totalSpeakers: this.#speakerRouting.size,
      speakerRouting: Object.fromEntries(this.#speakerRouting),
      connections,
      config: {
        minConnections: this.#config.minConnections,
        maxConnections: this.#config.maxConnections,
        speakersPerConnectionThreshold: this.#config.speakersPerConnectionThreshold,
        autoScale: this.#config.autoScale,
      },
    };
  }

  /**
   * Gracefully shut down the pool: drain and close all connections.
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (!this.#running) return;

    this.#running = false;

    // Stop health checks
    this.#stopHealthChecks();

    // Disconnect all connections in parallel
    const disconnectPromises = [];
    for (const [id, pooled] of this.#connections) {
      disconnectPromises.push(
        this.#removeConnection(id, 'pool_shutdown').catch(err => {
          console.error(`[ConnectionPool] Error shutting down connection ${id}:`, err.message);
        })
      );
    }

    await Promise.allSettled(disconnectPromises);

    this.#connections.clear();
    this.#speakerRouting.clear();

    console.log('[ConnectionPool] Shut down complete');
  }

  // ──────────────────────────────────────────────
  // Private: Connection lifecycle
  // ──────────────────────────────────────────────

  /**
   * Create a new pooled connection with resilience wrapper.
   * @returns {Promise<string>} connection ID
   */
  async #createConnection() {
    const id = `dg-conn-${++this.#connectionCounter}`;

    const client = new DeepgramStreamingClient({
      apiKey: this.#config.apiKey,
      liveOptions: this.#config.liveOptions,
      reconnect: this.#config.reconnect,
      dedup: this.#config.dedup,
    });

    const resilience = new DeepgramConnectionResilience(client);

    /** @type {PooledConnection} */
    const pooled = {
      id,
      client,
      resilience,
      status: 'idle',
      assignedSpeakers: new Set(),
      packetCount: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      errorCount: 0,
    };

    // Wire events from this connection
    this.#wireConnectionEvents(pooled);

    // Store before connecting (to handle events during connect)
    this.#connections.set(id, pooled);

    try {
      await client.connect();
      pooled.status = 'active';

      this.emit('connection_added', {
        id,
        totalConnections: this.#connections.size,
      });

      console.log(`[ConnectionPool] Connection ${id} established (total: ${this.#connections.size})`);
      return id;
    } catch (err) {
      // Remove failed connection
      this.#connections.delete(id);
      client.removeAllListeners();
      resilience.destroy();

      console.error(`[ConnectionPool] Failed to create connection ${id}:`, err.message);
      throw err;
    }
  }

  /**
   * Remove and clean up a pooled connection.
   * Reassigns its speakers to other connections before closing.
   *
   * @param {string} id - Connection ID
   * @param {string} reason - Why the connection is being removed
   * @returns {Promise<void>}
   */
  async #removeConnection(id, reason) {
    const pooled = this.#connections.get(id);
    if (!pooled) return;

    pooled.status = 'draining';

    // Reassign speakers to other connections
    for (const userId of pooled.assignedSpeakers) {
      this.#speakerRouting.delete(userId);
      // Will be reassigned on next sendAudio call
    }
    pooled.assignedSpeakers.clear();

    // Disconnect and clean up
    try {
      await pooled.client.disconnect();
    } catch {
      // Ignore disconnect errors
    }

    pooled.client.removeAllListeners();
    pooled.resilience.destroy();
    pooled.status = 'closed';

    this.#connections.delete(id);

    this.emit('connection_removed', {
      id,
      reason,
      totalConnections: this.#connections.size,
    });

    console.log(`[ConnectionPool] Connection ${id} removed (reason: ${reason}, remaining: ${this.#connections.size})`);
  }

  /**
   * Wire event handlers for a pooled connection.
   * Forwards transcript events and monitors health.
   *
   * @param {PooledConnection} pooled
   */
  #wireConnectionEvents(pooled) {
    const { client, resilience, id } = pooled;

    // Forward transcript events
    client.on('transcript', (event) => {
      this.emit('transcript', { ...event, connectionId: id });
    });

    client.on('transcript_duplicate', (info) => {
      this.emit('transcript_duplicate', { ...info, connectionId: id });
    });

    client.on('utterance_end', () => {
      this.emit('utterance_end', { connectionId: id });
    });

    // Track errors
    client.on('error', (err) => {
      pooled.errorCount++;
      this.emit('error', err);
    });

    client.on('warning', (msg) => {
      this.emit('warning', msg);
    });

    // Forward resilience notifications (for Discord text channel)
    resilience.on('notification', (notification) => {
      this.emit('notification', { ...notification, connectionId: id });
    });

    resilience.on('state_change', ({ previous, current }) => {
      if (current === 'healthy') {
        this.emit('connection_healthy', { id });
      } else if (current === 'failed') {
        this.emit('connection_unhealthy', { id, reason: 'permanent_failure' });
        // Replace the failed connection if we're below minimum
        this.#handleConnectionFailure(id);
      }
    });

    resilience.on('fallback_save_needed', () => {
      this.emit('connection_unhealthy', { id, reason: 'fallback_save_needed' });
    });
  }

  // ──────────────────────────────────────────────
  // Private: Speaker routing
  // ──────────────────────────────────────────────

  /**
   * Get the assigned connection for a speaker, or assign one.
   * Uses least-loaded strategy for new assignments.
   *
   * @param {string} userId
   * @returns {string|null} connection ID
   */
  #getOrAssignConnection(userId) {
    // Check existing assignment
    const existingId = this.#speakerRouting.get(userId);
    if (existingId) {
      const pooled = this.#connections.get(existingId);
      if (pooled && pooled.status === 'active') {
        return existingId;
      }
      // Connection no longer valid — reassign
      this.#speakerRouting.delete(userId);
    }

    // Find least-loaded active connection
    const connId = this.#findLeastLoadedConnection();
    if (!connId) return null;

    // Assign speaker to connection
    this.#speakerRouting.set(userId, connId);
    const pooled = this.#connections.get(connId);
    if (pooled) {
      pooled.assignedSpeakers.add(userId);
    }

    return connId;
  }

  /**
   * Find the active connection with the fewest assigned speakers.
   * @returns {string|null} connection ID
   */
  #findLeastLoadedConnection() {
    let bestId = null;
    let bestLoad = Infinity;

    for (const [id, pooled] of this.#connections) {
      if (pooled.status !== 'active') continue;
      if (pooled.client.state === 'closed') continue;

      const load = pooled.assignedSpeakers.size;
      if (load < bestLoad) {
        bestLoad = load;
        bestId = id;
      }
    }

    return bestId;
  }

  /**
   * Reassign a speaker to a different connection and send audio.
   * Used as fallback when the assigned connection is down.
   *
   * @param {string} userId
   * @param {Buffer|Uint8Array} audioData
   * @param {string} excludeConnId - Connection to exclude
   * @returns {boolean}
   */
  #reassignAndSend(userId, audioData, excludeConnId) {
    // Find another healthy connection
    for (const [id, pooled] of this.#connections) {
      if (id === excludeConnId) continue;
      if (pooled.status !== 'active') continue;
      if (!pooled.client.isConnected) continue;

      // Reassign
      this.#speakerRouting.set(userId, id);
      pooled.assignedSpeakers.add(userId);

      // Remove from old connection
      const oldPooled = this.#connections.get(excludeConnId);
      if (oldPooled) {
        oldPooled.assignedSpeakers.delete(userId);
      }

      // Send
      const sent = pooled.client.send(audioData);
      if (sent) {
        pooled.packetCount++;
        pooled.lastActiveAt = Date.now();
        return true;
      }
    }

    return false;
  }

  // ──────────────────────────────────────────────
  // Private: Auto-scaling
  // ──────────────────────────────────────────────

  /**
   * Check if we need more connections based on speaker count.
   */
  #checkScaleUp() {
    if (!this.#running) return;

    const currentConnections = this.#connections.size;
    if (currentConnections >= this.#config.maxConnections) return;

    const speakerCount = this.#speakerRouting.size;
    const threshold = this.#config.speakersPerConnectionThreshold;
    const neededConnections = Math.min(
      Math.ceil(speakerCount / threshold),
      this.#config.maxConnections
    );

    if (neededConnections > currentConnections) {
      console.log(
        `[ConnectionPool] Scale up: ${currentConnections} -> ${neededConnections} ` +
        `(${speakerCount} speakers, threshold=${threshold})`
      );

      // Create additional connections (fire-and-forget with error handling)
      const toCreate = neededConnections - currentConnections;
      for (let i = 0; i < toCreate; i++) {
        this.#createConnection()
          .then(() => {
            this.emit('scaled_up', {
              from: currentConnections,
              to: this.#connections.size,
              reason: `speaker_count_${speakerCount}`,
            });
          })
          .catch(err => {
            this.emit('warning', `Failed to scale up: ${err.message}`);
          });
      }
    }
  }

  /**
   * Check if we can release surplus idle connections.
   */
  #checkScaleDown() {
    if (!this.#running) return;

    const currentConnections = this.#connections.size;
    if (currentConnections <= this.#config.minConnections) return;

    const speakerCount = this.#speakerRouting.size;
    const threshold = this.#config.speakersPerConnectionThreshold;
    const neededConnections = Math.max(
      Math.ceil(speakerCount / threshold),
      this.#config.minConnections
    );

    if (neededConnections < currentConnections) {
      // Find idle connections to remove (those with no assigned speakers)
      const candidates = [];
      for (const [id, pooled] of this.#connections) {
        if (pooled.assignedSpeakers.size === 0) {
          const idleTime = Date.now() - pooled.lastActiveAt;
          if (idleTime >= this.#config.idleTimeoutMs) {
            candidates.push(id);
          }
        }
      }

      // Remove surplus idle connections
      const toRemove = Math.min(
        candidates.length,
        currentConnections - neededConnections
      );

      for (let i = 0; i < toRemove; i++) {
        const id = candidates[i];
        this.#removeConnection(id, 'scale_down').then(() => {
          this.emit('scaled_down', {
            from: currentConnections,
            to: this.#connections.size,
            reason: `speaker_count_${speakerCount}`,
          });
        }).catch(err => {
          this.emit('warning', `Failed to scale down: ${err.message}`);
        });
      }
    }
  }

  // ──────────────────────────────────────────────
  // Private: Health monitoring
  // ──────────────────────────────────────────────

  /**
   * Start periodic health checks.
   */
  #startHealthChecks() {
    this.#stopHealthChecks();

    this.#healthCheckTimer = setInterval(() => {
      this.#performHealthCheck();
    }, this.#config.healthCheckIntervalMs);

    // Don't prevent process exit
    if (this.#healthCheckTimer.unref) {
      this.#healthCheckTimer.unref();
    }
  }

  /**
   * Stop periodic health checks.
   */
  #stopHealthChecks() {
    if (this.#healthCheckTimer) {
      clearInterval(this.#healthCheckTimer);
      this.#healthCheckTimer = null;
    }
  }

  /**
   * Check health of all connections and take corrective actions.
   */
  #performHealthCheck() {
    if (!this.#running) return;

    const stats = this.getStats();
    this.emit('pool_stats', stats);

    for (const [id, pooled] of this.#connections) {
      // Check for zombie connections (idle status but should be active)
      if (pooled.status === 'idle' && pooled.client.isConnected) {
        pooled.status = 'active';
      }

      // Check for connections that have been in a bad state too long
      if (pooled.status === 'active' && pooled.client.state === 'closed') {
        this.emit('connection_unhealthy', { id, reason: 'client_closed_unexpectedly' });
        this.#handleConnectionFailure(id);
      }

      // Check for excessive errors
      if (pooled.errorCount > 50) {
        this.emit('connection_unhealthy', { id, reason: 'excessive_errors' });
        this.#handleConnectionFailure(id);
      }
    }

    // Ensure we have minimum connections
    const activeCount = [...this.#connections.values()]
      .filter(c => c.status === 'active' && c.client.isConnected).length;

    if (activeCount < this.#config.minConnections) {
      const deficit = this.#config.minConnections - activeCount;
      for (let i = 0; i < deficit; i++) {
        this.#createConnection().catch(err => {
          this.emit('warning', `Health check: failed to restore min connections: ${err.message}`);
        });
      }
    }

    // Auto-scale check
    if (this.#config.autoScale) {
      this.#checkScaleDown();
    }
  }

  /**
   * Handle a connection that has permanently failed.
   * Removes it and creates a replacement if needed.
   *
   * @param {string} id - Failed connection ID
   */
  async #handleConnectionFailure(id) {
    const pooled = this.#connections.get(id);
    if (!pooled || pooled.status === 'draining' || pooled.status === 'closed') return;

    console.log(`[ConnectionPool] Handling failure for connection ${id}`);

    // Remove the failed connection (reassigns speakers)
    await this.#removeConnection(id, 'connection_failure');

    // Create a replacement if we're below minimum
    if (this.#connections.size < this.#config.minConnections) {
      try {
        await this.#createConnection();
        console.log(`[ConnectionPool] Replacement connection created (total: ${this.#connections.size})`);
      } catch (err) {
        this.emit('error', new Error(`Failed to create replacement connection: ${err.message}`));
      }
    }
  }
}

export { POOL_DEFAULTS };
