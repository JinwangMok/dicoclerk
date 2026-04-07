/**
 * /setup command handler
 *
 * Allows guild administrators (or members with Manage Guild permission) to
 * designate a text channel for meeting minutes delivery.
 *
 * Usage:
 *   /setup channel:#minutes-channel
 *
 * The configured channel is persisted via GuildConfigStore and used by the
 * meeting minutes pipeline instead of falling back to the /start invocation
 * channel.
 */

import { PermissionsBitField, ChannelType } from 'discord.js';

/**
 * Handle /setup slash command.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {import('../config/guild-config-store.js').GuildConfigStore} guildConfigStore
 */
export async function handleSetup(interaction, guildConfigStore) {
  // Validate: invoker must have Manage Guild (or Administrator) permission
  const memberPerms = interaction.memberPermissions;
  const hasPermission =
    memberPerms?.has(PermissionsBitField.Flags.ManageGuild) ||
    memberPerms?.has(PermissionsBitField.Flags.Administrator);

  if (!hasPermission) {
    await interaction.reply({
      content: '❌ You need the **Manage Server** permission to configure the bot.',
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.options.getChannel('channel', true);

  // Validate: must be a text channel (text or news/announcements)
  const validTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  if (!validTypes.includes(channel.type)) {
    await interaction.reply({
      content: `❌ <#${channel.id}> is not a text channel. Please select a **text** channel.`,
      ephemeral: true,
    });
    return;
  }

  // Validate: bot must be able to send messages in that channel
  const botMember = interaction.guild?.members?.me;
  if (botMember) {
    const perms = channel.permissionsFor(botMember);
    if (!perms?.has(PermissionsBitField.Flags.SendMessages)) {
      await interaction.reply({
        content: `❌ I don't have permission to send messages in <#${channel.id}>. Please grant me the **Send Messages** permission there.`,
        ephemeral: true,
      });
      return;
    }
    if (!perms?.has(PermissionsBitField.Flags.AttachFiles)) {
      await interaction.reply({
        content: `❌ I don't have permission to attach files in <#${channel.id}>. Please grant me the **Attach Files** permission there (needed to deliver the minutes markdown file).`,
        ephemeral: true,
      });
      return;
    }
  }

  try {
    await guildConfigStore.setTextChannelId(interaction.guildId, channel.id);
  } catch (err) {
    console.error('[Command] /setup failed to persist config:', err);
    await interaction.reply({
      content: '❌ Failed to save configuration. Please try again.',
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    content: [
      `✅ **Meeting minutes channel configured!**`,
      ``,
      `All future meeting minutes will be delivered to <#${channel.id}>.`,
      ``,
      `*Tip: Run \`/start\` in any channel — the output will always go to <#${channel.id}>.*`,
    ].join('\n'),
    ephemeral: false,
  });

  console.log(
    `[Command] /setup executed: guild=${interaction.guildId} textChannel=${channel.id} by=${interaction.user?.tag}`
  );
}
