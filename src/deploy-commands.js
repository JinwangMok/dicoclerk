import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const commands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start recording the voice channel meeting')
    .addStringOption(option =>
      option
        .setName('language')
        .setDescription('Language for speech recognition')
        .setRequired(false)
        .addChoices(
          { name: 'Korean', value: 'ko' },
          { name: 'English', value: 'en' },
          { name: 'Multi (Korean + English)', value: 'multi' }
        )
    ),
  new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop recording and generate meeting minutes'),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function deployCommands() {
  try {
    console.log(`Registering ${commands.length} slash commands...`);

    if (process.env.DISCORD_GUILD_ID) {
      // Guild-specific (instant, for development)
      await rest.put(
        Routes.applicationGuildCommands(
          process.env.DISCORD_CLIENT_ID,
          process.env.DISCORD_GUILD_ID
        ),
        { body: commands }
      );
      console.log(`Commands registered to guild ${process.env.DISCORD_GUILD_ID}`);
    } else {
      // Global (takes up to 1 hour to propagate)
      await rest.put(
        Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
        { body: commands }
      );
      console.log('Commands registered globally');
    }

    console.log('Slash commands registered successfully.');
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
}

deployCommands();
