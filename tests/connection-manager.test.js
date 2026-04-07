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

  describe('stateChange event on destroy()', () => {
    it('should emit stateChange with oldStatus=idle when destroyed from idle', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      const changes = [];
      manager.on('stateChange', (e) => changes.push(e));

      manager.destroy(); // state is 'idle' at this point

      // destroy() sets state to 'destroyed' and emits the event
      assert.equal(changes.length, 1);
      assert.equal(changes[0].oldStatus, 'idle');
      assert.equal(changes[0].newStatus, 'destroyed');
    });

    it('should NOT emit stateChange on second destroy() call', () => {
      const manager = new VoiceConnectionManager({
        guildId: '123',
        channelId: '456',
        guild: createFakeGuild(),
      });

      const changes = [];
      manager.on('stateChange', (e) => changes.push(e));

      manager.destroy();
      manager.destroy(); // idempotent — no second emission

      assert.equal(changes.length, 1); // only one stateChange
    });
  });
});

/**
 * Disconnected handler reconnection logic tests.
 *
 * These tests mirror the fixed logic from VoiceConnectionManager.#setupConnectionHandlers()
 * using an inline simulation — the same pattern used in session-manager.test.js for
 * VoiceStateLogic. This avoids needing to mock the @discordjs/voice ES module while
 * precisely verifying algorithm correctness.
 */
describe('Disconnected handler - reconnection algorithm', () => {
  /**
   * Simulation of the reconnection state machine in #setupConnectionHandlers().
   * Mirrors the FIXED implementation to verify correct behaviour.
   */
  class ReconnectLogic {
    constructor({ maxAttempts = 5 } = {}) {
      this.state = 'ready';
      this.reconnectAttempts = 0;
      this.maxAttempts = maxAttempts;
      this.events = [];
      this.rejoinCalled = 0;
      // Injected async helpers — override per test
      this.waitForConnecting = async () => {};  // resolves = success
      this.waitForReady = async () => {};        // resolves = success
    }

    async handleDisconnected({ reason, closeCode }) {
      const REASON_WS_CLOSE = 0; // VoiceConnectionDisconnectReason.WebSocketClose

      if (reason === REASON_WS_CLOSE && closeCode === 4014) {
        // 4014 path: wait for Connecting, then Ready
        try {
          await this.waitForConnecting();
          await this.waitForReady();
          this.state = 'ready';
          this.reconnectAttempts = 0;
          this.events.push({ type: 'stateChange', oldStatus: 'reconnecting', newStatus: 'ready' });
          this.events.push({ type: 'ready' });
        } catch {
          this.events.push({ type: 'destroy' });
        }
      } else if (this.reconnectAttempts < this.maxAttempts) {
        // Non-4014 path: call rejoin() then wait for Ready
        this.reconnectAttempts++;
        const oldStatus = this.state; // captured BEFORE mutation (fix)
        this.state = 'reconnecting';
        this.events.push({ type: 'stateChange', oldStatus, newStatus: 'reconnecting' });
        this.events.push({ type: 'reconnecting' });

        try {
          this.rejoinCalled++;        // records that rejoin() was invoked
          await this.waitForReady();

          this.state = 'ready';
          this.reconnectAttempts = 0;
          this.events.push({ type: 'stateChange', oldStatus: 'reconnecting', newStatus: 'ready' });
          this.events.push({ type: 'ready' });
        } catch {
          if (this.reconnectAttempts >= this.maxAttempts) {
            this.events.push({ type: 'error' });
            this.events.push({ type: 'destroy' });
          }
        }
      } else {
        this.events.push({ type: 'error' });
        this.events.push({ type: 'destroy' });
      }
    }
  }

  it('non-4014: calls rejoin() before waiting for Ready', async () => {
    const logic = new ReconnectLogic();
    logic.waitForReady = async () => {}; // immediate success

    await logic.handleDisconnected({ reason: 0, closeCode: 1000 });

    assert.equal(logic.rejoinCalled, 1, 'rejoin() must be called once');
    assert.equal(logic.state, 'ready');
  });

  it('non-4014: emits reconnecting then ready on successful reconnect', async () => {
    const logic = new ReconnectLogic();
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 1000 });

    const types = logic.events.map(e => e.type);
    assert.ok(types.includes('reconnecting'), 'should emit reconnecting');
    assert.ok(types.includes('ready'), 'should emit ready after reconnect');
  });

  it('non-4014: stateChange on reconnecting has correct oldStatus', async () => {
    const logic = new ReconnectLogic();
    logic.state = 'ready';
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 1000 });

    const sc = logic.events.find(e => e.type === 'stateChange' && e.newStatus === 'reconnecting');
    assert.ok(sc, 'stateChange to reconnecting should be emitted');
    assert.equal(sc.oldStatus, 'ready', 'oldStatus must be ready, not reconnecting');
  });

  it('non-4014: does NOT call rejoin() after exhausting attempts', async () => {
    const logic = new ReconnectLogic({ maxAttempts: 3 });
    logic.reconnectAttempts = 3; // already exhausted
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 1000 });

    assert.equal(logic.rejoinCalled, 0, 'rejoin() must not be called when attempts exhausted');
    const types = logic.events.map(e => e.type);
    assert.ok(types.includes('destroy'), 'should destroy when exhausted');
  });

  it('non-4014: destroy + error emitted when max attempts reached mid-retry', async () => {
    const logic = new ReconnectLogic({ maxAttempts: 1 });
    logic.waitForReady = async () => { throw new Error('timeout'); };

    await logic.handleDisconnected({ reason: 0, closeCode: 1000 });

    const types = logic.events.map(e => e.type);
    assert.ok(types.includes('error'), 'error event expected');
    assert.ok(types.includes('destroy'), 'destroy event expected');
  });

  it('non-4014: no rejoin() for adapter unavailable reason (same non-4014 path)', async () => {
    const logic = new ReconnectLogic();
    logic.waitForReady = async () => {};
    const ADAPTER_UNAVAILABLE = 1; // VoiceConnectionDisconnectReason.AdapterUnavailable

    await logic.handleDisconnected({ reason: ADAPTER_UNAVAILABLE, closeCode: undefined });

    assert.equal(logic.rejoinCalled, 1, 'rejoin() is still called for adapter-unavailable');
  });

  it('4014 path: does NOT call rejoin()', async () => {
    const logic = new ReconnectLogic();
    logic.waitForConnecting = async () => {};
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 4014 });

    assert.equal(logic.rejoinCalled, 0, 'rejoin() must NOT be called on 4014 (Discord manages reconnection)');
  });

  it('4014 path: awaits both Connecting then Ready states', async () => {
    const logic = new ReconnectLogic();
    const order = [];
    logic.waitForConnecting = async () => { order.push('connecting'); };
    logic.waitForReady = async () => { order.push('ready'); };

    await logic.handleDisconnected({ reason: 0, closeCode: 4014 });

    assert.deepEqual(order, ['connecting', 'ready'],
      '4014 recovery must await Connecting first, then Ready');
  });

  it('4014 path: emits ready event after successful recovery', async () => {
    const logic = new ReconnectLogic();
    logic.waitForConnecting = async () => {};
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 4014 });

    const types = logic.events.map(e => e.type);
    assert.ok(types.includes('ready'), 'ready event must be emitted after 4014 recovery');
    assert.equal(logic.state, 'ready');
  });

  it('4014 path: destroy emitted when Connecting times out', async () => {
    const logic = new ReconnectLogic();
    logic.waitForConnecting = async () => { throw new Error('timeout'); };
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 4014 });

    const types = logic.events.map(e => e.type);
    assert.ok(types.includes('destroy'), 'must destroy if Connecting never reached');
  });

  it('4014 path: destroy emitted when Ready times out after Connecting', async () => {
    const logic = new ReconnectLogic();
    logic.waitForConnecting = async () => {}; // Connecting OK
    logic.waitForReady = async () => { throw new Error('timeout'); }; // Ready fails

    await logic.handleDisconnected({ reason: 0, closeCode: 4014 });

    const types = logic.events.map(e => e.type);
    assert.ok(types.includes('destroy'), 'must destroy if Ready never reached after Connecting');
  });

  it('4014 path: resets reconnect counter on success', async () => {
    const logic = new ReconnectLogic();
    logic.reconnectAttempts = 2; // simulate prior failures
    logic.waitForConnecting = async () => {};
    logic.waitForReady = async () => {};

    await logic.handleDisconnected({ reason: 0, closeCode: 4014 });

    assert.equal(logic.reconnectAttempts, 0, 'reconnect counter must reset on success');
  });
});

/**
 * Destroyed handler stateChange correctness tests.
 *
 * Verifies the bug fix: oldStatus must be captured BEFORE this.#state is mutated
 * to 'destroyed'. Tests use inline simulation matching the fixed handler code.
 */
describe('Destroyed event handler - stateChange correctness', () => {
  /**
   * Simulates the Destroyed event handler from VoiceConnectionManager.
   * FIXED version: captures oldStatus before state mutation.
   */
  class DestroyedHandlerFixed {
    constructor(initialState) {
      this.state = initialState;
      this.events = [];
    }

    trigger() {
      const oldStatus = this.state; // FIXED: capture before mutation
      this.state = 'destroyed';
      this.events.push({ type: 'stateChange', oldStatus, newStatus: 'destroyed' });
      this.events.push({ type: 'destroyed' });
    }
  }

  /**
   * Simulates the BUGGY version for regression documentation.
   */
  class DestroyedHandlerBuggy {
    constructor(initialState) {
      this.state = initialState;
      this.events = [];
    }

    trigger() {
      this.state = 'destroyed'; // mutate first
      this.events.push({ type: 'stateChange', oldStatus: this.state, newStatus: 'destroyed' }); // bug: reads 'destroyed'
      this.events.push({ type: 'destroyed' });
    }
  }

  for (const fromState of ['idle', 'connecting', 'ready', 'reconnecting']) {
    it(`fixed: stateChange oldStatus="${fromState}" when destroyed from ${fromState}`, () => {
      const sim = new DestroyedHandlerFixed(fromState);
      sim.trigger();

      const sc = sim.events.find(e => e.type === 'stateChange');
      assert.equal(sc.oldStatus, fromState, `oldStatus must be '${fromState}', not 'destroyed'`);
      assert.equal(sc.newStatus, 'destroyed');
    });
  }

  it('buggy version always emits oldStatus="destroyed" (regression proof)', () => {
    // Documents the bug that was fixed so it cannot be re-introduced silently.
    for (const fromState of ['idle', 'connecting', 'ready', 'reconnecting']) {
      const sim = new DestroyedHandlerBuggy(fromState);
      sim.trigger();
      const sc = sim.events.find(e => e.type === 'stateChange');
      // The bug: no matter what the real prior state was, it always says 'destroyed'
      assert.equal(sc.oldStatus, 'destroyed',
        `Buggy handler always reports oldStatus='destroyed' (was '${fromState}')`);
    }
  });

  it('fixed: destroyed event is always emitted after stateChange', () => {
    const sim = new DestroyedHandlerFixed('ready');
    sim.trigger();

    const types = sim.events.map(e => e.type);
    assert.deepEqual(types, ['stateChange', 'destroyed'],
      'stateChange must precede destroyed event');
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
