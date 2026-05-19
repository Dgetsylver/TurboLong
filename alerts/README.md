# Alerts

## Purpose

This module is a Cloudflare Worker that manages APY alert subscriptions. It verifies subscribers, stores alert preferences in D1, checks Blend reserve rates on a cron schedule, and sends email when a subscribed leverage bracket turns negative.

## How To Run

```bash
cd alerts
npm install
npm run dev
```

Common maintenance commands:

```bash
npm run db:create
npm run db:migrate
npm run deploy
```

Configure Worker bindings and secrets in Cloudflare/Wrangler before deploying. `RESEND_API_KEY`, `RESEND_FROM`, `FRONTEND_ORIGIN`, and the D1 binding are required by `src/index.ts`.

## File Map

- `package.json`: Wrangler scripts and TypeScript dependency.
- `wrangler.toml`: Worker, cron, and D1 binding configuration.
- `tsconfig.json`: TypeScript compiler settings.
- `src/index.ts`: routes for subscribe, verify, unsubscribe, and scheduled checks.
- `src/schema.sql`: D1 schema for alert subscriptions.
- `src/email.ts`: Resend email templates and sending helpers.
- `src/stellar.ts`: Blend reserve-rate fetching and APY calculations.
- `src/xdr.ts`: minimal XDR helpers for Soroban simulation calls.
