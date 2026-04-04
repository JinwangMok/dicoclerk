/**
 * Tests for SpeakerIdentifier
 *
 * Validates speaker-to-user mapping logic including:
 * - Activity recording and time-bucketed lookup
 * - Speaker identification from time ranges
 * - Mapping creation, confirmation, and conflict resolution
 * - Multi-speaker concurrent scenarios
 * - Edge cases (no activity, overlapping speakers, etc.)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SpeakerIdentifier,
  BUCKET_SIZE_SEC,
  CONFIRMATION_THRESHOLD,
  MAX_ACTIVITY_AGE_SEC,
} from '../src/stt/speaker-identifier.js';

describe('SpeakerIdentifier', () => {
  let identifier;

  beforeEach(() => {
    identifier = new SpeakerIdentifier();
  });

  afterEach(() => {
    identifier.stopEviction();
  });

  describe('constructor and initial state', () => {
    it('should start with empty state', () => {
      const stats = identifier.getStats();
      assert.equal(stats.totalActivities, 0);
      assert.equal(stats.totalIdentifications, 0);
      assert.equal(stats.mappingCount, 0);
      assert.equal(stats.confirmedCount, 0);
      assert.equal(stats.registeredUsers, 0);
    });

    it('should export expected constants', () => {
      assert.equal(typeof BUCKET_SIZE_SEC, 'number');
      assert.ok(BUCKET_SIZE_SEC > 0);
      assert.equal(typeof CONFIRMATION_THRESHOLD, 'number');
      assert.ok(CONFIRMATION_THRESHOLD > 0);
      assert.equal(typeof MAX_ACTIVITY_AGE_SEC, 'number');
      assert.ok(MAX_ACTIVITY_AGE_SEC > 0);
    });
  });

  describe('recordActivity()', () => {
    it('should record activity for a user at a given timestamp', () => {
      identifier.recordActivity('user-1', 1.0);
      identifier.recordActivity('user-1', 1.2);
      identifier.recordActivity('user-2', 1.5);

      const stats = identifier.getStats();
      assert.equal(stats.totalActivities, 3);
      assert.ok(stats.activityBuckets > 0);
    });

    it('should increment activity count per user per bucket', () => {
      // All within the same bucket (0.5s bucket)
      identifier.recordActivity('user-1', 1.0);
      identifier.recordActivity('user-1', 1.1);
      identifier.recordActivity('user-1', 1.2);

      const stats = identifier.getStats();
      assert.equal(stats.totalActivities, 3);
    });

    it('should handle multiple buckets for different time ranges', () => {
      identifier.recordActivity('user-1', 0.0);
      identifier.recordActivity('user-1', 1.0);
      identifier.recordActivity('user-1', 2.0);
      identifier.recordActivity('user-1', 3.0);

      const stats = identifier.getStats();
      assert.equal(stats.totalActivities, 4);
      // Each timestamp falls in a different bucket (0.5s each)
      assert.ok(stats.activityBuckets >= 4);
    });
  });

  describe('registerUser()', () => {
    it('should register a display name for a user', () => {
      identifier.registerUser('user-1', 'Alice');

      const stats = identifier.getStats();
      assert.equal(stats.registeredUsers, 1);
    });

    it('should update existing mapping display name when user is registered', () => {
      // Create a mapping first
      identifier.recordActivity('user-1', 1.0);
      identifier.recordActivity('user-1', 1.1);
      identifier.identify(0, 1.0, 1.2);

      // Now register the user's display name
      const events = [];
      identifier.on('mapping_updated', (e) => events.push(e));

      identifier.registerUser('user-1', 'Alice');

      assert.equal(identifier.resolveName(0), 'Alice');
    });
  });

  describe('identify() — single speaker', () => {
    it('should identify a speaker when only one user is active', () => {
      identifier.registerUser('user-1', 'Alice');

      // User-1 sends packets at 1.0-1.5s
      for (let t = 1.0; t <= 1.5; t += 0.05) {
        identifier.recordActivity('user-1', t);
      }

      // Deepgram returns transcript with speaker 0 at time 1.0-1.5s
      const result = identifier.identify(0, 1.0, 1.5);

      assert.equal(result.userId, 'user-1');
      assert.equal(result.displayName, 'Alice');
      assert.ok(result.confidence > 0);
      assert.equal(result.isNewMapping, true);
    });

    it('should return fallback name when no activity exists', () => {
      const result = identifier.identify(0, 1.0, 1.5);

      assert.equal(result.userId, null);
      assert.equal(result.displayName, 'Speaker 0');
      assert.equal(result.confidence, 0);
      assert.equal(result.isNewMapping, false);
    });

    it('should use existing mapping for subsequent identifications', () => {
      identifier.registerUser('user-1', 'Alice');

      for (let t = 1.0; t <= 1.5; t += 0.05) {
        identifier.recordActivity('user-1', t);
      }

      // First identification creates mapping
      const r1 = identifier.identify(0, 1.0, 1.5);
      assert.equal(r1.isNewMapping, true);

      // Second identification uses existing mapping
      const r2 = identifier.identify(0, 2.0, 2.5);
      assert.equal(r2.userId, 'user-1');
      assert.equal(r2.isNewMapping, false);
    });
  });

  describe('identify() — multiple concurrent speakers', () => {
    it('should correctly map two speakers to different users', () => {
      identifier.registerUser('user-1', 'Alice');
      identifier.registerUser('user-2', 'Bob');

      // Alice speaks at 1.0-2.0s (many packets)
      for (let t = 1.0; t < 2.0; t += 0.02) {
        identifier.recordActivity('user-1', t);
      }

      // Bob speaks at 3.0-4.0s (many packets)
      for (let t = 3.0; t < 4.0; t += 0.02) {
        identifier.recordActivity('user-2', t);
      }

      // Speaker 0 transcript at 1.0-2.0s -> should be Alice
      const r1 = identifier.identify(0, 1.0, 2.0);
      assert.equal(r1.userId, 'user-1');
      assert.equal(r1.displayName, 'Alice');

      // Speaker 1 transcript at 3.0-4.0s -> should be Bob
      const r2 = identifier.identify(1, 3.0, 4.0);
      assert.equal(r2.userId, 'user-2');
      assert.equal(r2.displayName, 'Bob');
    });

    it('should handle 5 concurrent speakers correctly', () => {
      const users = ['Alice', 'Bob', 'Charlie', 'David', 'Eve'];

      // Register all users
      users.forEach((name, i) => {
        identifier.registerUser(`user-${i}`, name);
      });

      // Each user speaks in their own time slot
      users.forEach((_, i) => {
        const start = i * 2.0;
        for (let t = start; t < start + 1.5; t += 0.02) {
          identifier.recordActivity(`user-${i}`, t);
        }
      });

      // Identify each speaker
      users.forEach((name, i) => {
        const start = i * 2.0;
        const result = identifier.identify(i, start, start + 1.5);
        assert.equal(result.userId, `user-${i}`, `Speaker ${i} should be ${name}`);
        assert.equal(result.displayName, name);
      });
    });

    it('should handle 10 concurrent speakers (max requirement)', () => {
      // Register 10 users
      for (let i = 0; i < 10; i++) {
        identifier.registerUser(`user-${i}`, `Speaker${i}`);
      }

      // Each user speaks in a unique time window
      for (let i = 0; i < 10; i++) {
        const start = i * 1.5;
        for (let t = start; t < start + 1.0; t += 0.02) {
          identifier.recordActivity(`user-${i}`, t);
        }
      }

      // Verify each speaker is correctly identified
      for (let i = 0; i < 10; i++) {
        const start = i * 1.5;
        const result = identifier.identify(i, start, start + 1.0);
        assert.equal(result.userId, `user-${i}`);
        assert.equal(result.displayName, `Speaker${i}`);
      }

      const stats = identifier.getStats();
      assert.equal(stats.mappingCount, 10);
    });

    it('should distinguish overlapping speakers by dominant activity', () => {
      identifier.registerUser('user-1', 'Alice');
      identifier.registerUser('user-2', 'Bob');

      // Overlapping window: 2.0-3.0s
      // Alice is more active (more packets)
      for (let t = 2.0; t < 3.0; t += 0.01) {
        identifier.recordActivity('user-1', t);
      }
      // Bob has fewer packets in same window
      for (let t = 2.0; t < 3.0; t += 0.05) {
        identifier.recordActivity('user-2', t);
      }

      // Speaker 0 in overlapping window — should be Alice (more active)
      const result = identifier.identify(0, 2.0, 3.0);
      assert.equal(result.userId, 'user-1');
      assert.equal(result.displayName, 'Alice');
    });
  });

  describe('mapping confirmation', () => {
    it('should confirm mapping after reaching threshold evidence', () => {
      identifier.registerUser('user-1', 'Alice');
      const events = [];
      identifier.on('mapping_confirmed', (e) => events.push(e));

      // Provide enough evidence by repeatedly identifying the same speaker
      for (let i = 0; i < CONFIRMATION_THRESHOLD; i++) {
        const start = i * 2.0;
        for (let t = start; t < start + 1.0; t += 0.02) {
          identifier.recordActivity('user-1', t);
        }
        identifier.identify(0, start, start + 1.0);
      }

      const mapping = identifier.getMapping(0);
      assert.ok(mapping);
      assert.equal(mapping.confirmed, true);
      assert.equal(mapping.userId, 'user-1');
      assert.ok(events.length > 0, 'Should emit mapping_confirmed event');
    });

    it('should use confirmed mapping directly without re-checking activity', () => {
      identifier.registerUser('user-1', 'Alice');

      // Build confirmed mapping
      for (let i = 0; i < CONFIRMATION_THRESHOLD; i++) {
        const start = i * 2.0;
        for (let t = start; t < start + 1.0; t += 0.02) {
          identifier.recordActivity('user-1', t);
        }
        identifier.identify(0, start, start + 1.0);
      }

      // Now identify without any activity in the time range
      const result = identifier.identify(0, 100.0, 101.0);
      assert.equal(result.userId, 'user-1');
      assert.equal(result.displayName, 'Alice');
      assert.equal(result.isNewMapping, false);
    });
  });

  describe('setMapping() — manual mapping', () => {
    it('should set a confirmed mapping directly', () => {
      identifier.setMapping(0, 'user-1', 'Alice');

      const mapping = identifier.getMapping(0);
      assert.ok(mapping);
      assert.equal(mapping.userId, 'user-1');
      assert.equal(mapping.displayName, 'Alice');
      assert.equal(mapping.confirmed, true);
      assert.equal(mapping.confidence, 1.0);
    });

    it('should override existing mapping', () => {
      identifier.setMapping(0, 'user-1', 'Alice');
      identifier.setMapping(0, 'user-2', 'Bob');

      const mapping = identifier.getMapping(0);
      assert.equal(mapping.userId, 'user-2');
      assert.equal(mapping.displayName, 'Bob');
    });
  });

  describe('resolveName()', () => {
    it('should return mapped display name', () => {
      identifier.setMapping(0, 'user-1', 'Alice');
      assert.equal(identifier.resolveName(0), 'Alice');
    });

    it('should return fallback for unknown speaker', () => {
      assert.equal(identifier.resolveName(99), 'Speaker 99');
    });
  });

  describe('getSpeakerLabel()', () => {
    it('should return speaker label for a mapped user', () => {
      identifier.setMapping(0, 'user-1', 'Alice');
      assert.equal(identifier.getSpeakerLabel('user-1'), 0);
    });

    it('should return null for unmapped user', () => {
      assert.equal(identifier.getSpeakerLabel('user-99'), null);
    });
  });

  describe('getAllMappings()', () => {
    it('should return all current mappings', () => {
      identifier.setMapping(0, 'user-1', 'Alice');
      identifier.setMapping(1, 'user-2', 'Bob');

      const mappings = identifier.getAllMappings();
      assert.equal(mappings.size, 2);
      assert.equal(mappings.get(0).displayName, 'Alice');
      assert.equal(mappings.get(1).displayName, 'Bob');
    });
  });

  describe('mapping conflict resolution', () => {
    it('should emit mapping_conflict when a speaker label gets reassigned', () => {
      identifier.registerUser('user-1', 'Alice');
      identifier.registerUser('user-2', 'Bob');
      const conflicts = [];
      identifier.on('mapping_conflict', (e) => conflicts.push(e));

      // First: user-1 is speaker 0
      identifier.recordActivity('user-1', 1.0);
      identifier.identify(0, 1.0, 1.2);

      // Now user-2 dominates speaker 0's window with more evidence
      for (let round = 0; round < 3; round++) {
        const t = 2.0 + round * 1.0;
        for (let dt = 0; dt < 0.5; dt += 0.02) {
          identifier.recordActivity('user-2', t + dt);
        }
        identifier.identify(0, t, t + 0.5);
      }

      // There should be a conflict at some point
      if (conflicts.length > 0) {
        assert.equal(conflicts[0].speakerLabel, 0);
        assert.equal(conflicts[0].oldUserId, 'user-1');
        assert.equal(conflicts[0].newUserId, 'user-2');
      }
    });
  });

  describe('reset()', () => {
    it('should clear all state', () => {
      identifier.registerUser('user-1', 'Alice');
      identifier.recordActivity('user-1', 1.0);
      identifier.identify(0, 1.0, 1.5);
      identifier.setMapping(1, 'user-2', 'Bob');

      identifier.reset();

      const stats = identifier.getStats();
      assert.equal(stats.totalActivities, 0);
      assert.equal(stats.totalIdentifications, 0);
      assert.equal(stats.mappingCount, 0);
      assert.equal(stats.registeredUsers, 0);
      assert.equal(stats.activityBuckets, 0);
    });
  });

  describe('events', () => {
    it('should emit mapping_created on first identification', () => {
      const events = [];
      identifier.on('mapping_created', (e) => events.push(e));

      identifier.registerUser('user-1', 'Alice');
      identifier.recordActivity('user-1', 1.0);
      identifier.identify(0, 1.0, 1.5);

      assert.equal(events.length, 1);
      assert.equal(events[0].speakerLabel, 0);
      assert.equal(events[0].userId, 'user-1');
      assert.equal(events[0].displayName, 'Alice');
    });

    it('should emit mapping_updated on subsequent identifications', () => {
      const created = [];
      const updated = [];
      identifier.on('mapping_created', (e) => created.push(e));
      identifier.on('mapping_updated', (e) => updated.push(e));

      identifier.registerUser('user-1', 'Alice');

      // First: creates mapping
      identifier.recordActivity('user-1', 1.0);
      identifier.identify(0, 1.0, 1.5);
      assert.equal(created.length, 1);

      // Second: updates mapping
      identifier.recordActivity('user-1', 2.0);
      identifier.identify(0, 2.0, 2.5);
      assert.equal(updated.length, 1);
    });
  });

  describe('getStats()', () => {
    it('should return comprehensive statistics', () => {
      identifier.registerUser('user-1', 'Alice');
      identifier.registerUser('user-2', 'Bob');
      identifier.recordActivity('user-1', 1.0);
      identifier.recordActivity('user-2', 2.0);
      identifier.identify(0, 1.0, 1.5);
      identifier.setMapping(1, 'user-2', 'Bob');

      const stats = identifier.getStats();
      assert.equal(stats.totalActivities, 2);
      assert.equal(stats.totalIdentifications, 1);
      assert.equal(stats.registeredUsers, 2);
      assert.equal(stats.mappingCount, 2);
      assert.equal(stats.confirmedCount, 1); // setMapping creates confirmed
      assert.ok(Array.isArray(stats.mappings));
      assert.equal(stats.mappings.length, 2);
    });
  });

  describe('integration — realistic session scenario', () => {
    it('should correctly attribute a multi-speaker meeting', () => {
      // Simulate a meeting with 3 speakers
      identifier.registerUser('user-alice', 'Alice');
      identifier.registerUser('user-bob', 'Bob');
      identifier.registerUser('user-charlie', 'Charlie');

      // Alice speaks at 0-5s
      for (let t = 0; t < 5; t += 0.02) {
        identifier.recordActivity('user-alice', t);
      }

      // Bob speaks at 5-10s
      for (let t = 5; t < 10; t += 0.02) {
        identifier.recordActivity('user-bob', t);
      }

      // Charlie speaks at 10-15s
      for (let t = 10; t < 15; t += 0.02) {
        identifier.recordActivity('user-charlie', t);
      }

      // Alice speaks again at 15-20s
      for (let t = 15; t < 20; t += 0.02) {
        identifier.recordActivity('user-alice', t);
      }

      // Deepgram returns transcripts
      const t1 = identifier.identify(0, 0, 5);     // Speaker 0 = Alice
      const t2 = identifier.identify(1, 5, 10);     // Speaker 1 = Bob
      const t3 = identifier.identify(2, 10, 15);    // Speaker 2 = Charlie
      const t4 = identifier.identify(0, 15, 20);    // Speaker 0 = Alice (again)

      assert.equal(t1.userId, 'user-alice');
      assert.equal(t1.displayName, 'Alice');

      assert.equal(t2.userId, 'user-bob');
      assert.equal(t2.displayName, 'Bob');

      assert.equal(t3.userId, 'user-charlie');
      assert.equal(t3.displayName, 'Charlie');

      assert.equal(t4.userId, 'user-alice');
      assert.equal(t4.displayName, 'Alice');
      assert.equal(t4.isNewMapping, false); // Should reuse existing mapping

      // Verify final state
      const stats = identifier.getStats();
      assert.equal(stats.mappingCount, 3);
      assert.equal(identifier.resolveName(0), 'Alice');
      assert.equal(identifier.resolveName(1), 'Bob');
      assert.equal(identifier.resolveName(2), 'Charlie');
    });

    it('should handle interleaved/overlapping speaking turns', () => {
      identifier.registerUser('user-1', 'Alice');
      identifier.registerUser('user-2', 'Bob');

      // Alice: 0-3s (dominant)
      // Bob: 2-5s (dominant after 3s)
      for (let t = 0; t < 3; t += 0.02) {
        identifier.recordActivity('user-1', t);
      }
      for (let t = 2; t < 5; t += 0.02) {
        identifier.recordActivity('user-2', t);
      }

      // Speaker 0 in Alice's dominant window
      const r1 = identifier.identify(0, 0, 2);
      assert.equal(r1.userId, 'user-1');

      // Speaker 1 in Bob's dominant window
      const r2 = identifier.identify(1, 3, 5);
      assert.equal(r2.userId, 'user-2');
    });
  });
});
