# Alerts

This module is a Cloudflare Worker that lets users subscribe to APY alerts for supported pools and leverage brackets.

## Purpose

`alerts/` stores the worker that:

- accepts subscription requests,
- sends email verification and unsubscribe flows,
- checks pool rates on a schedule, and
- emails subscribers when the calculated net APY turns negative.

## How To Run

From the repository root:

```bash
cd alerts
npm install
npm run dev
```

Useful worker commands:

```bash
npm run db:create
npm run db:migrate
npm run deploy
```

Notes:

- `npm run dev` starts the worker locally with Wrangler.
- `npm run db:create` creates the D1 database entry expected by `wrangler.toml`.
- `npm run db:migrate` applies the schema from `src/schema.sql`.
- `npm run deploy` publishes the worker to Cloudflare.

## File Map

| File | Role |
| --- | --- |
| `package.json` | Local scripts and Wrangler tooling. |
| `wrangler.toml` | Worker config, cron schedule, D1 binding, and env vars. |
| `src/index.ts` | HTTP routes, cron handler, validation, and alert orchestration. |
| `src/email.ts` | Email composition and delivery helpers. |
| `src/schema.sql` | D1 schema for subscription storage. |
| `src/stellar.ts` | Pool metadata, rate fetching, and APY math. |
| `src/xdr.ts` | XDR helpers used by the worker. |

