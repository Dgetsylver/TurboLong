import fs from 'fs';
import path from 'path';
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const horizonUrl = process.env.HORIZON_URL || 'https://horizon.stellar.org';

if (!token) {
  console.error('Missing required environment variable: DISCORD_TOKEN');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ratesPath = path.resolve('./rates.json');

function loadRates() {
  try {
    return JSON.parse(fs.readFileSync(ratesPath, 'utf-8'));
  } catch (error) {
    console.error('Unable to load rates.json', error);
    return [];
  }
}

function buildRatesReply() {
  const rates = loadRates();
  if (rates.length === 0) {
    return 'Unable to load pool rates at the moment. Please try again later.';
  }

  const lines = rates.map(rate => {
    return `**${rate.pool} / ${rate.asset}** — ${rate.netApy} net APY • Utilization ${rate.utilization} • Risk: ${rate.risk}`;
  });

  return lines.join('\n');
}

async function fetchPosition(address) {
  const url = `${horizonUrl}/accounts/${encodeURIComponent(address)}`;
  const response = await fetch(url, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Horizon error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function formatPosition(account) {
  const balances = account.balances || [];
  const balanceLines = balances.map(balance => {
    if (balance.asset_type === 'native') {
      return `• XLM: ${balance.balance}`;
    }
    return `• ${balance.asset_code}:${balance.asset_issuer.slice(0, 8)}... — ${balance.balance}`;
  });

  return `**Account:** ${account.account_id}\n**Sequence:** ${account.sequence}\n**Signers:** ${account.signers?.length ?? 0}\n**Balances:**\n${balanceLines.join('\n')}`;
}

client.once('ready', () => {
  console.log(`Bot ready as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  await interaction.deferReply({ ephemeral: false });

  try {
    if (interaction.commandName === 'rates') {
      const reply = buildRatesReply();
      await interaction.editReply(reply);
      return;
    }

    if (interaction.commandName === 'position') {
      const address = interaction.options.getString('address', true).trim();
      if (!address.startsWith('G')) {
        await interaction.editReply('Please provide a valid Stellar public key starting with G.');
        return;
      }

      const account = await fetchPosition(address);
      const reply = formatPosition(account);
      await interaction.editReply(reply);
      return;
    }

    await interaction.editReply('Command not recognized.');
  } catch (error) {
    console.error('Interaction error:', error);
    await interaction.editReply(`Failed to fetch on-chain data: ${error.message}`);
  }
});

client.login(token);
