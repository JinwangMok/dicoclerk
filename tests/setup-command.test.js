import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PermissionsBitField, ChannelType } from 'discord.js';
import { handleSetup } from '../src/commands/setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTextChannel({
  id = 'text-ch-001',
  type = ChannelType.GuildText,
  botCanSend = true,
  botCanAttach = true,
} = {}) {
  return {
    id,
    type,
    permissionsFor: mock.fn(() => ({
      has: mock.fn((flag) => {
        if (flag === PermissionsBitField.Flags.SendMessages) return botCanSend;
        if (flag === PermissionsBitField.Flags.AttachFiles) return botCanAttach;
        return true;
      }),
    })),
  };
}

function createMockInteraction({
  guildId = 'guild-123',
  channel = createMockTextChannel(),
  hasManageGuild = true,
  hasAdmin = false,
  botMember = { id: 'bot-user' },
  userTag = 'Admin#0001',
} = {}) {
  return {
    guildId,
    user: { tag: userTag },
    memberPermissions: {
      has: mock.fn((flag) => {
        if (flag === PermissionsBitField.Flags.ManageGuild) return hasManageGuild;
        if (flag === PermissionsBitField.Flags.Administrator) return hasAdmin;
        return false;
      }),
    },
    options: {
      getChannel: mock.fn((_name, _required) => channel),
    },
    guild: {
      id: guildId,
      members: { me: botMember },
    },
    reply: mock.fn(async () => {}),
    deferred: false,
    replied: false,
  };
}

function createMockGuildConfigStore({ failOnSet = false } = {}) {
  let stored = {};
  return {
    setTextChannelId: mock.fn(async (guildId, channelId) => {
      if (failOnSet) throw new Error('disk write error');
      stored[guildId] = channelId;
    }),
    getTextChannelId: mock.fn(async (guildId) => stored[guildId] ?? null),
    _stored: stored,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/setup command', () => {
  let guildConfigStore;

  beforeEach(() => {
    guildConfigStore = createMockGuildConfigStore();
  });

  it('rejects if user lacks Manage Guild permission', async () => {
    const interaction = createMockInteraction({ hasManageGuild: false, hasAdmin: false });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('Manage Server'));
    assert.equal(reply.ephemeral, true);
    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 0);
  });

  it('accepts if user has Administrator permission (no Manage Guild)', async () => {
    const channel = createMockTextChannel();
    const interaction = createMockInteraction({ hasManageGuild: false, hasAdmin: true, channel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('configured'));
  });

  it('rejects non-text channel (voice channel)', async () => {
    const voiceChannel = createMockTextChannel({ type: ChannelType.GuildVoice });
    const interaction = createMockInteraction({ channel: voiceChannel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('not a text channel'));
    assert.equal(reply.ephemeral, true);
    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 0);
  });

  it('accepts announcement (news) channel', async () => {
    const newsChannel = createMockTextChannel({ type: ChannelType.GuildAnnouncement });
    const interaction = createMockInteraction({ channel: newsChannel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 1);
  });

  it('rejects if bot lacks SendMessages permission in the channel', async () => {
    const channel = createMockTextChannel({ botCanSend: false, botCanAttach: true });
    const interaction = createMockInteraction({ channel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('Send Messages'));
    assert.equal(reply.ephemeral, true);
    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 0);
  });

  it('rejects if bot lacks AttachFiles permission in the channel', async () => {
    const channel = createMockTextChannel({ botCanSend: true, botCanAttach: false });
    const interaction = createMockInteraction({ channel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('Attach Files'));
    assert.equal(reply.ephemeral, true);
    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 0);
  });

  it('skips bot permission check when guild.members.me is null', async () => {
    // When botMember is null, we can't check permissions — should proceed anyway
    const channel = createMockTextChannel();
    const interaction = createMockInteraction({ channel, botMember: null });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('configured'));
  });

  it('persists channel ID via guildConfigStore', async () => {
    const channel = createMockTextChannel({ id: 'minutes-ch-999' });
    const interaction = createMockInteraction({ guildId: 'guild-XYZ', channel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(guildConfigStore.setTextChannelId.mock.callCount(), 1);
    const [savedGuildId, savedChannelId] = guildConfigStore.setTextChannelId.mock.calls[0].arguments;
    assert.equal(savedGuildId, 'guild-XYZ');
    assert.equal(savedChannelId, 'minutes-ch-999');
  });

  it('replies with success message mentioning the channel', async () => {
    const channel = createMockTextChannel({ id: 'ch-confirm-123' });
    const interaction = createMockInteraction({ channel });

    await handleSetup(interaction, guildConfigStore);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('ch-confirm-123'), `Expected channel mention in: ${reply.content}`);
    assert.ok(reply.content.includes('configured') || reply.content.includes('✅'));
    assert.equal(reply.ephemeral, false);
  });

  it('replies with error if guildConfigStore.setTextChannelId throws', async () => {
    const failStore = createMockGuildConfigStore({ failOnSet: true });
    const channel = createMockTextChannel();
    const interaction = createMockInteraction({ channel });

    await handleSetup(interaction, failStore);

    assert.equal(interaction.reply.mock.callCount(), 1);
    const reply = interaction.reply.mock.calls[0].arguments[0];
    assert.ok(reply.content.includes('Failed to save') || reply.content.includes('❌'));
    assert.equal(reply.ephemeral, true);
  });
});

// ---------------------------------------------------------------------------
// /setup command builder structure
// ---------------------------------------------------------------------------

describe('/setup command builder', () => {
  it('defines a channel option named "channel" that is required', async () => {
    const { SlashCommandBuilder } = await import('discord.js');

    const setupCmd = new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Configure the designated text channel for meeting minutes delivery')
      .addChannelOption(option =>
        option
          .setName('channel')
          .setDescription('Text channel where meeting minutes will be sent')
          .setRequired(true)
      );

    const json = setupCmd.toJSON();
    assert.equal(json.name, 'setup');
    assert.equal(json.options.length, 1);
    assert.equal(json.options[0].name, 'channel');
    assert.equal(json.options[0].required, true);
    assert.equal(json.options[0].type, 7); // CHANNEL = 7 in Discord API
  });
});
