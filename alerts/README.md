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
   wrangler secret put VAPID_PRIVATE_KEY          # JWK JSON from `npm run vapid:generate`
   wrangler secret put STELLAR_BROKER_PARTNER_KEY # Stellar Broker partner key (swap relay)
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

Cron (every 15 min) sends push for the same negative-APY events as email, with the same one-per-episode latch.

## Alert cadence

Alerts are edge-triggered — one notification per breach episode, not one per cron tick:

- A subscription fires when the condition is first breached, then latches (`alert_active = 1`) and stays quiet for as long as the condition holds.
- It re-arms only after the metric recovers past a margin (net APY back above +0.25pp; health factor back above `threshold + 0.02`). The margin is hysteresis, so a value sitting right on the threshold can't mail on every flip.
- `MIN_REALERT_HOURS` (1h) floors the gap between two sends for the same subscription even across a genuine recover-then-breach cycle.
- Re-subscribing clears the latch.

Existing databases need `migrations/0003_edge_triggered_alerts.sql`.

## Stellar Broker relay

- `GET /broker/ws` — WebSocket relay to `api.stellar.broker/ws`. The worker injects
  the `STELLAR_BROKER_PARTNER_KEY` secret into the upstream URL so the partner key
  never ships in the frontend bundle. Handshakes are restricted to `FRONTEND_ORIGIN`
  (plus localhost for dev). The swap screen uses this relay by default; setting
  `VITE_STELLAR_BROKER_PARTNER_KEY` in the frontend bypasses it (local dev only).

## Local dev

```bash
wrangler dev
```

Point the frontend at the local worker:

```bash
# frontend/.env.local
VITE_ALERTS_WORKER_URL=http://127.0.0.1:8787
```
