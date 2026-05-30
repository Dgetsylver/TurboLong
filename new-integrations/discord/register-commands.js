import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('Missing required environment variables: DISCORD_TOKEN and DISCORD_CLIENT_ID');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('rates')
    .setDescription('Show current net APY for Turbolong pools and assets'),
  new SlashCommandBuilder()
    .setName('position')
    .setDescription('Fetch on-chain Stellar account position state')
    .addStringOption(option =>
      option
        .setName('address')
        .setDescription('Stellar account public key (G...)')
        .setRequired(true)
    )
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    if (guildId) {
      console.log(`Registering commands to guild ${guildId}...`);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    } else {
      console.log('Registering global commands...');
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
    }
    console.log('Commands registered successfully.');
  } catch (error) {
    console.error('Error registering commands:', error);
    process.exit(1);
  }
})();
