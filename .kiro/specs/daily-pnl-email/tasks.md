# Implementation Plan: Daily P&L Summary Email

## Overview

Extend the Turbolong Alerts Cloudflare Worker to deliver a daily P&L digest email. Changes span five files: `schema.sql` (new columns), `stellar.ts` (expose pool totals), `email.ts` (new template), `index.ts` (subscribe handler + digest cron), and `wrangler.toml` (hourly cron trigger).

## Tasks

- [ ] 1. Extend the database schema
  - Add `ALTER TABLE subscriptions ADD COLUMN digest_enabled INTEGER DEFAULT 0;` to `alerts/src/schema.sql`
  - Add `ALTER TABLE subscriptions ADD COLUMN digest_hour INTEGER DEFAULT NULL;` to `alerts/src/schema.sql`
  - Add `ALTER TABLE subscriptions ADD COLUMN last_digest_at TEXT DEFAULT NULL;` to `alerts/src/schema.sql`
  - Add a DB index `CREATE INDEX IF NOT EXISTS idx_subs_digest ON subscriptions(digest_hour, digest_enabled, verified);` to speed up the hourly query
  - Run `wrangler d1 execute turbolong-alerts --file=src/schema.sql` to apply the migration

- [ ] 2. Extend ReserveRates in stellar.ts
  - Add `totalSupply: number`, `totalBorrow: number`, and `priceUsd: number` fields to the `ReserveRates` interface in `alerts/src/stellar.ts`
  - Update the `return` statement in `fetchReserveRates()` to include `totalSupply`, `totalBorrow`, and `priceUsd` from the already-computed local variables of the same names

- [ ] 3. Add sendDailyDigest to email.ts
  - Add `export async function sendDailyDigest(env, to, opts)` to `alerts/src/email.ts`
  - `opts` type: `{ date: string; positions: Array<{ poolName, assetSymbol, leverage, hf, yield24h, netApy }>; unsubscribeUrl: string; appUrl: string }`
  - Build an HTML email with subject `TurboLong Morning Digest — <date>` using the existing `sendEmail` helper
  - Render a `<table>` with columns: Pool, Asset, Leverage, Health Factor, 24h Yield — one row per position
  - Apply inline `color: #FF4D6A` (red) to HF cells where `hf !== null && hf < 1.2`
  - Apply inline `color: #FF4D6A` (red) to 24h Yield cells where `yield24h !== null && yield24h < 0`
  - Render `N/A` in both HF and 24h Yield cells when the value is `null`
  - Render HF as `∞` when `hf === Infinity`
  - Include an "Open Turbolong" button linking to `appUrl` and an unsubscribe link using `unsubscribeUrl`
  - Wrap the table render in a try/catch; on error, include a fallback `<p>Position data temporarily unavailable.</p>` in place of the table and still send the email

- [ ] 4. Extend handleSubscribe in index.ts
  - Read `digest_hour` from the parsed request body in `handleSubscribe`
  - If `digest_hour` is present: validate it is an integer in range 0–23; if invalid, return `jsonResponse({ ok: false, error: "digest_hour must be an integer 0–23" }, 400, env)` before any DB write
  - Compute `digestEnabled = (digest_hour !== undefined && digest_hour !== null) ? 1 : 0` and `digestHour = digestEnabled ? digest_hour : null`
  - Update the `DB.prepare` INSERT/upsert query to bind `digest_enabled` and `digest_hour` as `?7` and `?8`, and add them to the `ON CONFLICT DO UPDATE` clause

- [ ] 5. Add handleDigestCron to index.ts
  - Add `async function handleDigestCron(env: Env): Promise<void>` to `alerts/src/index.ts`
  - Compute `currentHour = new Date().getUTCHours()`
  - Query the DB: `SELECT id, email, pool_id, asset_symbol, leverage_bracket, unsub_token FROM subscriptions WHERE verified = 1 AND digest_enabled = 1 AND digest_hour = ?1 AND (last_digest_at IS NULL OR last_digest_at < datetime('now', '-23 hours'))` bound to `currentHour`
  - Group the result rows by `email` into a `Map<string, DigestRow[]>`
  - For each email group:
    - For each row, look up the pool from `POOLS` by `pool_id` and the asset by `asset_symbol`; call `fetchReserveRates(pool, asset)` — on null result, set `hf = null` and `yield24h = null`
    - On a valid result, compute `netApy = computeNetApy(rates, row.leverage_bracket)`, `yield24h = netApy / 365`, and `hf = rates.totalBorrow > 0 ? rates.totalSupply / rates.totalBorrow : Infinity`
    - Build the `positions` array for `sendDailyDigest`
    - Call `sendDailyDigest` with the `RESEND_API_KEY`, `RESEND_FROM`, recipient email, positions, unsubscribe URL, `FRONTEND_ORIGIN`, and today's date as `YYYY-MM-DD`
    - On success: `UPDATE subscriptions SET last_digest_at = datetime('now') WHERE id IN (<ids>)`
    - On failure: log the error and continue to the next email group without updating `last_digest_at`

- [ ] 6. Update scheduled() routing in index.ts
  - Change the `scheduled()` handler to branch on `event.cron`:
    - `"*/15 * * * *"` → `ctx.waitUntil(handleCron(env))`
    - `"0 * * * *"` → `ctx.waitUntil(handleDigestCron(env))`
  - Add a `default` branch that logs an unknown cron expression and does nothing

- [ ] 7. Add hourly cron trigger to wrangler.toml
  - Change `crons = ["*/15 * * * *"]` to `crons = ["*/15 * * * *", "0 * * * *"]` in `alerts/wrangler.toml`

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1, 2, 3] },
    { "wave": 2, "tasks": [4, 5] },
    { "wave": 3, "tasks": [6, 7] }
  ],
  "dependencies": {
    "4": [1],
    "5": [1, 2, 3],
    "6": [4, 5],
    "7": [6]
  }
}
```

Tasks 1, 2, and 3 are independent and can be done in parallel. Tasks 4 and 5 depend on the schema (task 1) and the extended types (tasks 2, 3). Tasks 6 and 7 wire everything together.

## Notes

- The `fetchReserveRates` change in task 2 is additive — existing callers (`handleCron`) are unaffected since they only read the fields they already use.
- The unsubscribe URL in the digest uses the first row's `unsub_token` for the email group. Since all rows in a group share the same email, any one token unsubscribes all positions for that email.
- `wrangler d1 execute` with `ALTER TABLE` is idempotent if the column already exists on SQLite ≥ 3.37 (Cloudflare D1 uses SQLite 3.44+). If not, wrap each `ALTER TABLE` in a `CREATE TABLE IF NOT EXISTS` migration guard.
- The `IN (<ids>)` clause in the bulk `last_digest_at` update should be constructed by joining the row IDs as a comma-separated list of integers — no risk of SQL injection since IDs are integers from the DB.
