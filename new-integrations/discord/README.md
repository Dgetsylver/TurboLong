# Turbolong Discord Bot

This directory contains a simple Discord bot for Turbolong with two slash commands:

- `/rates` — returns current net APY for Turbolong pools and assets.
- `/position` — looks up Stellar account position state from on-chain Horizon data.

## Setup

1. Install dependencies:

   ```bash
   cd /workspaces/TurboLong/new-integrations/discord
   npm install
   ```

2. Create a `.env` file with the following values:

   ```text
   DISCORD_TOKEN=your-bot-token
   DISCORD_CLIENT_ID=your-application-client-id
   GUILD_ID=your-test-guild-id   # optional, useful for fast command registration
   HORIZON_URL=https://horizon.stellar.org
   ```

3. Register the slash commands:

   ```bash
   npm run register
   ```

   If you set `GUILD_ID`, commands will register immediately in that guild. If not, they will register globally.

4. Start the bot:

   ```bash
   npm start
   ```

## Inviting the bot

Use the OAuth2 URL generator in the Discord Developer Portal and request the following scopes:

- `bot`
- `applications.commands`

Under Bot permissions, grant `Send Messages` and `Use Slash Commands`.

## Notes

- `/rates` currently reads sample APY data from `rates.json`.
- `/position` fetches live account data from the Stellar Horizon network and returns balances plus sequence state.
- The bot is self-hostable and can be extended to decode Blend position state and pool APYs from on-chain contract data.
