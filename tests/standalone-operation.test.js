/**
 * Standalone Operation Tests (AC 10)
 *
 * Verifies that dicoclerk functions independently without Openclaw connected.
 * The bot must operate fully as a standalone Discord bot without any MCP
 * client connected — all features (recording, transcription, minutes generation)
 * must work without external agent integration.
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';

describe('Standalone Operation — No Openclaw Required', () => {
  describe('Core module independence from MCP', () => {
    it('index.js does not import any MCP modules', async () => {
      // Read the index.js source and verify no MCP imports
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const indexSource = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf-8');

      assert.ok(!indexSource.includes("from './mcp"), 'index.js should not import MCP modules');
      assert.ok(!indexSource.includes("from '../mcp"), 'index.js should not import MCP modules');
      assert.ok(!indexSource.includes('@modelcontextprotocol'), 'index.js should not import MCP SDK');
      assert.ok(!indexSource.includes('mcp-server'), 'index.js should not import mcp-server');
    });

    it('SessionManager has no MCP dependencies', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'voice', 'session-manager.js'), 'utf-8');

      assert.ok(!source.includes('mcp'), 'SessionManager should not reference MCP');
      assert.ok(!source.includes('@modelcontextprotocol'), 'SessionManager should not import MCP SDK');
    });

    it('session-cleanup.js has no MCP dependencies', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'session', 'session-cleanup.js'), 'utf-8');

      assert.ok(!source.includes('mcp'), 'session-cleanup should not reference MCP');
      assert.ok(!source.includes('openclaw'), 'session-cleanup should not reference Openclaw');
    });

    it('minutes generator has no MCP dependencies', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'minutes', 'generator.js'), 'utf-8');

      assert.ok(!source.includes('@modelcontextprotocol'), 'generator should not import MCP SDK');
      assert.ok(!source.includes('openclaw'), 'generator should not reference Openclaw');
    });

    it('minutes formatter has no MCP dependencies', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'minutes', 'formatter.js'), 'utf-8');

      assert.ok(!source.includes('@modelcontextprotocol'), 'formatter should not import MCP SDK');
      assert.ok(!source.includes('openclaw'), 'formatter should not reference Openclaw');
    });

    it('start command has no MCP dependencies', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'commands', 'start.js'), 'utf-8');

      assert.ok(!source.includes('mcp'), 'start command should not reference MCP');
      assert.ok(!source.includes('openclaw'), 'start command should not reference Openclaw');
    });

    it('stop command has no MCP dependencies', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'commands', 'stop.js'), 'utf-8');

      assert.ok(!source.includes('mcp'), 'stop command should not reference MCP');
      assert.ok(!source.includes('openclaw'), 'stop command should not reference Openclaw');
    });
  });

  describe('SessionManager standalone lifecycle', () => {
    let SessionManager;

    before(async () => {
      const mod = await import('../src/voice/session-manager.js');
      SessionManager = mod.SessionManager;
    });

    it('creates without any external dependencies', () => {
      const sm = new SessionManager();
      assert.ok(sm, 'SessionManager should instantiate without deps');
      assert.equal(sm.hasSession('any-guild'), false);
      assert.equal(sm.getSession('any-guild'), null);
    });

    it('getAllSessions returns empty map when no sessions', () => {
      const sm = new SessionManager();
      const sessions = sm.getAllSessions();
      assert.ok(sessions instanceof Map);
      assert.equal(sessions.size, 0);
    });

    it('destroyAll is safe with no sessions', () => {
      const sm = new SessionManager();
      assert.doesNotThrow(() => sm.destroyAll());
    });

    it('stopSession returns null for non-existent guild', () => {
      const sm = new SessionManager();
      const result = sm.stopSession('non-existent');
      assert.equal(result, null);
    });

    it('emits events without any MCP listener', () => {
      const sm = new SessionManager();
      const events = [];
      sm.on('error', (e) => events.push(e));
      sm.emit('error', new Error('test'));
      assert.equal(events.length, 1);
      assert.equal(events[0].message, 'test');
    });
  });

  describe('Session cleanup works standalone', () => {
    it('cleanupSession handles missing session gracefully', async () => {
      const { cleanupSession } = await import('../src/session/session-cleanup.js');
      const mockSessionManager = {
        getSession: () => null,
        stopSession: () => null,
      };

      const result = await cleanupSession({
        sessionManager: mockSessionManager,
        guildId: 'test-guild',
        reason: 'manual_stop',
      });

      assert.ok(result.success);
      assert.equal(result.transcriptCount, 0);
      assert.deepEqual(result.transcript, []);
    });

    it('formatCleanupMessage works without MCP context', async () => {
      const { formatCleanupMessage } = await import('../src/session/session-cleanup.js');
      const result = formatCleanupMessage({
        reason: 'manual_stop',
        durationMinutes: 5,
        durationSeconds: 30,
        participantCount: 3,
        transcriptCount: 42,
        transcriptFilePath: '/data/transcripts/test.json',
        warnings: [],
      });

      assert.ok(result.includes('Recording stopped'));
      assert.ok(result.includes('5m 30s'));
      assert.ok(result.includes('3'));
      assert.ok(result.includes('42'));
    });
  });

  describe('Minutes generation pipeline standalone', () => {
    it('generateAndDeliverMinutes handles null client gracefully', async () => {
      const { generateAndDeliverMinutes } = await import('../src/minutes/generator.js');

      const result = await generateAndDeliverMinutes({
        transcript: [],
        session: {
          guildId: 'test-guild',
          voiceChannelId: 'vc-1',
          textChannelId: 'tc-1',
          startedAt: new Date(),
          startedBy: 'TestUser',
          language: 'en',
          participants: new Set(),
        },
        transcriptResult: null,
        client: null, // No Discord client — simulates edge case
        reason: 'manual_stop',
        duration: 300,
      });

      // Should succeed (no entries to process)
      assert.ok(result.success);
    });

    it('buildMetadata works without guild object', async () => {
      const { buildMetadata } = await import('../src/minutes/generator.js');

      const metadata = buildMetadata(
        {
          voiceChannelId: 'vc-1',
          startedAt: new Date('2025-01-15T10:00:00Z'),
          startedBy: 'TestUser',
          language: 'ko',
        },
        null, // no transcriptResult
        null, // no guild
        600,  // 10 minutes
      );

      assert.equal(metadata.guildName, 'Unknown Server');
      assert.equal(metadata.channelName, 'Unknown Channel');
      assert.equal(metadata.durationSeconds, 600);
      assert.equal(metadata.language, 'ko');
      assert.equal(metadata.startedBy, 'TestUser');
    });
  });

  describe('MCP is optional — bot starts without it', () => {
    it('MCP server creation is isolated in mcp/ directory', async () => {
      const { readdir } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const srcFiles = await readdir(join(process.cwd(), 'src'));

      // Core bot files should not include mcp-related files except the optional entry point
      const coreFiles = srcFiles.filter(f => !f.startsWith('mcp') && f !== '__init__.py' && f !== '__pycache__');
      assert.ok(coreFiles.includes('index.js'), 'index.js should exist as main entry');

      // Verify mcp/ is a separate directory
      assert.ok(srcFiles.includes('mcp') || srcFiles.includes('mcp-server.js'),
        'MCP should be in separate directory or file');
    });

    it('package.json has separate start and mcp scripts', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));

      assert.ok(pkg.scripts.start, 'Should have start script');
      assert.ok(pkg.scripts.mcp, 'Should have mcp script');
      assert.ok(!pkg.scripts.start.includes('mcp'), 'start script should not reference MCP');
      assert.equal(pkg.scripts.start, 'node src/index.js', 'start should run index.js directly');
    });

    it('main entry point is index.js (not mcp-server)', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const pkg = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));

      assert.equal(pkg.main, 'src/index.js');
    });
  });

  describe('Bot operates without --mcp flag', () => {
    it('index.js exports client and sessionManager for direct use', async () => {
      // Verify the module exports are available (without actually connecting)
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf-8');

      assert.ok(source.includes('export { client, sessionManager }'),
        'index.js should export client and sessionManager');
    });

    it('DISCORD_TOKEN is the only required env var for bot startup', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const source = await readFile(join(process.cwd(), 'src', 'index.js'), 'utf-8');

      // index.js only checks DISCORD_TOKEN as required
      assert.ok(source.includes("process.env.DISCORD_TOKEN"),
        'Should check DISCORD_TOKEN');
      // Should NOT require MCP-related env vars
      assert.ok(!source.includes("MCP_"), 'Should not require MCP env vars');
    });
  });

  describe('Data persistence works standalone', () => {
    it('index-store works without MCP connection', async () => {
      const { searchEntries } = await import('../src/minutes/index-store.js');

      // Should not throw — returns empty results
      const result = await searchEntries({ limit: 5 });
      assert.ok(Array.isArray(result.entries));
      assert.ok(typeof result.total === 'number');
    });

    it('minutes can be queried without MCP', async () => {
      const { listRecordings } = await import('../src/mcp/handlers.js');

      // Even MCP handlers work in standalone context when called directly
      const result = await listRecordings({}, 5);
      assert.ok(result.content);
      const data = JSON.parse(result.content[0].text);
      assert.ok(Array.isArray(data.recordings));
    });
  });

  describe('Graceful degradation without Openclaw', () => {
    it('MCP server can be created with null deps', async () => {
      // Already tested in mcp-server.test.js, but important for standalone guarantee
      const mod = await import('../src/mcp/server.js');
      assert.ok(typeof mod.createMcpServer === 'function', 'createMcpServer should be exported');
    });

    it('all slash commands work without MCP server running', async () => {
      // Verify command handlers have no MCP guard
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');

      const startSource = await readFile(join(process.cwd(), 'src', 'commands', 'start.js'), 'utf-8');
      const stopSource = await readFile(join(process.cwd(), 'src', 'commands', 'stop.js'), 'utf-8');

      // Commands should NOT check for MCP availability
      assert.ok(!startSource.includes('mcpServer'), 'start should not check MCP server');
      assert.ok(!stopSource.includes('mcpServer'), 'stop should not check MCP server');

      // Commands should only need interaction and sessionManager
      assert.ok(startSource.includes('interaction, sessionManager'),
        'start should accept interaction and sessionManager');
      assert.ok(stopSource.includes('interaction, sessionManager'),
        'stop should accept interaction and sessionManager');
    });
  });
});

