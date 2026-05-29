# Turbolong Stats Dashboard

Public protocol stats dashboard — no wallet needed.

## What it shows

| Metric | Source |
|---|---|
| Total Value Locked | Soroban RPC on-chain fallback → D1 snapshot |
| Active Users | D1 `subscriptions` table (verified alert subs) |
| Avg. Leverage | D1 `pool_snapshots` (written by alerts cron) |
| 24h Deposit Volume | D1 `pool_snapshots` (placeholder, wire event-indexer) |
| Top Assets | On-chain Soroban RPC → D1 `asset_snapshots` |

## Data refresh

The **alerts worker cron** (`*/15 * * * *`) writes to D1:
- `pool_snapshots` — aggregate TVL, volume, leverage
- `asset_snapshots` — per-asset TVL + APR

The stats page fetches `GET https://turbolong-alerts.workers.dev/stats` on load,
then falls back to direct Soroban RPC if D1 has no data yet.

Auto-refreshes every **15 minutes** with a countdown timer.

## Local dev

```bash
cd stats
npm install
npm run dev        # http://localhost:5174
```

## Deploy to Cloudflare Pages

```bash
# 1. Build
npm run build

# 2. Deploy (first time creates the project)
npx wrangler pages deploy dist --project-name turbolong-stats

# 3. Set custom domain in Cloudflare dashboard → Pages → turbolong-stats → Custom Domains
#    Add: stats.turbolong.xyz  (CNAME to turbolong-stats.pages.dev)
```

## D1 Schema migration

Run once after deploying the alerts worker:

```bash
cd alerts
npx wrangler d1 execute turbolong-alerts --file=src/schema.sql
```
