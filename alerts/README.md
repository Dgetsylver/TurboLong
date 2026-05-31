# Turbolong APY Alerts Worker

Cloudflare Worker for email and web-push APY alerts (negative net APY per pool/asset/leverage bracket).

## Setup

```bash
npm install
```

1. **D1** — Create the database (once), paste `database_id` into `wrangler.toml`:

   ```bash
   npm run db:create
   npm run db:migrate:remote
   ```

2. **Secrets** (never commit these):

   ```bash
   wrangler secret put RESEND_API_KEY
   wrangler secret put VAPID_PRIVATE_KEY   # JWK JSON from `npm run vapid:generate`
   ```

   `VAPID_PUBLIC_KEY` is set in `wrangler.toml` and must match the key pair used for `VAPID_PRIVATE_KEY`.

3. **Deploy** (after `npx wrangler login`):

   ```bash
   npm run setup:remote
   ```

   This creates D1 (if needed), runs the remote migration, uploads `VAPID_PRIVATE_KEY` from `.dev.vars`, prompts for `RESEND_API_KEY`, and deploys.

   Or step by step: `npm run build` then `npm run deploy`.

## Web push (E5)

- `GET /vapid-public-key` — public VAPID key for `pushManager.subscribe`
- `POST /push/subscribe` — body: `{ subscription, pool_id, asset_symbol, leverage_bracket }`
- `GET /push/unsubscribe?token=` — remove subscription

Cron (every 15 min) sends push for the same negative-APY events as email, with the same 24h throttle.

## Local dev

```bash
wrangler dev
```

Point the frontend at the local worker:

```bash
# frontend/.env.local
VITE_ALERTS_WORKER_URL=http://127.0.0.1:8787
```
