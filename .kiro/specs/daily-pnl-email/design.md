# Design Document: Daily P&L Summary Email

## Overview

The Daily P&L Summary Email extends the existing Turbolong Alerts Cloudflare Worker to deliver a morning digest to opted-in subscribers. Each digest contains a compact HTML table showing every position the subscriber monitors — pool, asset, leverage, current Health Factor, and 24h yield — sent at the UTC hour they chose. The feature reuses all existing infrastructure: Resend for delivery, D1 for storage, and the Soroban RPC helpers in `stellar.ts`.

---

## Components and Interfaces

### Schema Migration (`schema.sql`)

Three new columns added to `subscriptions`:

```sql
ALTER TABLE subscriptions ADD COLUMN digest_enabled INTEGER DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN digest_hour    INTEGER DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN last_digest_at TEXT    DEFAULT NULL;
```

### `/subscribe` handler (`index.ts`)

Extended to accept an optional `digest_hour` field (integer 0–23). Validation:
- Missing → `digest_enabled = 0`, `digest_hour = NULL`
- Present and valid → `digest_enabled = 1`, `digest_hour = <value>`
- Present and invalid → HTTP 400, no row written

The upsert query is updated to include the two new columns.

### `handleDigestCron(env)` (`index.ts`)

New async function, called from `scheduled()` when `event.cron === "0 * * * *"`. Steps:
1. Get current UTC hour
2. Query all verified subscriptions due for a digest (see SQL below)
3. Group rows by email
4. For each email group, fetch rates for each position, build digest data, send email
5. On success, update `last_digest_at` for all rows in the group

### `sendDailyDigest(env, to, opts)` (`email.ts`)

New export. Builds and sends the digest HTML email via the existing `sendEmail` helper.

### `wrangler.toml`

Add `"0 * * * *"` to the `crons` array alongside the existing `"*/15 * * * *"`.

---

## Data Models

### DigestRow (query result)

```typescript
interface DigestRow {
  id: number;
  email: string;
  pool_id: string;
  asset_symbol: string;
  leverage_bracket: number;
  unsub_token: string;
}
```

### DigestPositionData (computed per position)

```typescript
interface DigestPositionData {
  poolName: string;
  assetSymbol: string;
  leverage: number;
  hf: number | null;       // null when fetchReserveRates returns null
  yield24h: number | null; // netApy / 365, null on fetch failure
  netApy: number | null;
}
```

---

## Architecture

### Cron Routing

```
scheduled(event)
  ├── event.cron === "*/15 * * * *"  →  handleCron(env)       [existing APY alerts]
  └── event.cron === "0 * * * *"    →  handleDigestCron(env)  [new digest]
```

### Digest Flow

```
handleDigestCron(env)
  │
  ├─ currentHour = new Date().getUTCHours()
  │
  ├─ DB query: verified subs with digest_enabled=1, digest_hour=currentHour,
  │            last_digest_at IS NULL OR last_digest_at < now - 23h
  │
  ├─ Group rows by email → Map<email, DigestRow[]>
  │
  └─ For each email:
       ├─ For each row: fetchReserveRates(pool, asset) → compute HF + 24h yield
       ├─ sendDailyDigest(env, email, { positions, unsubToken, appUrl, date })
       └─ On success: UPDATE last_digest_at = datetime('now') WHERE id IN (row ids)
```

### Health Factor Computation

`fetchReserveRates` currently returns `netSupplyApr`, `netBorrowCost`, etc. but not `totalSupply`/`totalBorrow`. To compute HF we need to extend `ReserveRates` to expose these:

```typescript
export interface ReserveRates {
  // existing fields ...
  totalSupply: number;
  totalBorrow: number;
  priceUsd:    number;
}
```

HF formula:
```
hf = totalBorrow > 0 ? totalSupply / totalBorrow : Infinity
```

(Price cancels: `(totalSupply × price) / (totalBorrow × price) = totalSupply / totalBorrow`)

---

## Implementation Details

### DB Query for Due Subscribers

```sql
SELECT id, email, pool_id, asset_symbol, leverage_bracket, unsub_token
FROM subscriptions
WHERE verified = 1
  AND digest_enabled = 1
  AND digest_hour = ?1
  AND (last_digest_at IS NULL OR last_digest_at < datetime('now', '-23 hours'))
ORDER BY email
```

### Upsert Update (handleSubscribe)

```sql
INSERT INTO subscriptions
  (email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token,
   digest_enabled, digest_hour)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
  SET verify_token    = ?5,
      unsub_token     = ?6,
      verified        = 0,
      digest_enabled  = ?7,
      digest_hour     = ?8
```

### Email Template Structure

```
Subject: TurboLong Morning Digest — 2026-05-29

[Header: TurboLong logo text + date]

[Table]
Pool       | Asset | Leverage | Health Factor | 24h Yield
-----------|-------|----------|---------------|----------
Etherfuse  | CETES |    3×    |     1.42      |  +0.03%
Fixed      | USDC  |    5×    |     1.08 ⚠    |  -0.01%  ← red
...

[Footer: "Open Turbolong" button + Unsubscribe link]
```

Color rules:
- HF < 1.2 → orange/red cell
- 24h yield < 0 → red cell
- N/A shown when `fetchReserveRates` returns null

---

## Correctness Properties

Property 1: **Exactly-once per day** — A subscriber receives at most one digest per 23-hour window. The `last_digest_at < now - 23h` guard in the query prevents duplicates even if the hourly cron fires multiple times.
**Validates: Requirements 5.4**

Property 2: **Grouping** — All positions for a given email are batched into a single email send. The number of Resend API calls equals the number of distinct emails, not the number of subscription rows.
**Validates: Requirements 5.2**

Property 3: **Partial failure isolation** — A send failure for subscriber A does not prevent subscriber B from receiving their digest. `last_digest_at` is only updated for rows whose email was sent successfully.
**Validates: Requirements 5.6**

Property 4: **No-op on missing digest_hour** — Subscriptions created without `digest_hour` have `digest_enabled = 0` and are never selected by the digest query, leaving the existing APY alert behaviour unchanged.
**Validates: Requirements 1.2, 5.1**

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `fetchReserveRates` returns `null` for a position | Position row shows `N/A` for HF and 24h Yield; email still sends |
| `fetchReserveRates` throws for a position | Caught, logged; position row shows `N/A`; email still sends |
| `sendDailyDigest` Resend API call fails | Error logged; `last_digest_at` not updated for that email group; other groups continue |
| Table render throws inside `sendDailyDigest` | Caught; fallback `<p>Position data temporarily unavailable.</p>` used; email still sent |
| DB query for due subscribers fails | Error logged; `handleDigestCron` exits early; APY alert cron is unaffected |
| `digest_hour` present but invalid in `/subscribe` | HTTP 400 returned before any DB write; existing subscription row unchanged |
| Hourly cron fires twice within same hour | Second run finds `last_digest_at` within 23 hours; no emails sent; no DB updates |

## Testing Strategy

Manual verification steps:
1. **Opt-in validation** — POST `/subscribe` with `digest_hour: 25` → expect HTTP 400. POST with `digest_hour: 9` → expect row with `digest_enabled=1, digest_hour=9`.
2. **Digest send** — Trigger the hourly cron manually via `wrangler dev --test-scheduled`; confirm one email per distinct subscriber email, not one per row.
3. **Deduplication** — Trigger the cron twice within the same hour; confirm the second run sends no emails (all `last_digest_at` values are within 23 hours).
4. **Graceful N/A** — Mock `fetchReserveRates` to return null for one position; confirm the email still sends with `N/A` in that row.
5. **APY alert unchanged** — Trigger the 15-minute cron; confirm `handleDigestCron` is not called.

---

## Affected Files

| File | Change |
|---|---|
| `alerts/src/schema.sql` | Add 3 columns: `digest_enabled`, `digest_hour`, `last_digest_at` |
| `alerts/src/stellar.ts` | Extend `ReserveRates` to expose `totalSupply`, `totalBorrow`, `priceUsd` |
| `alerts/src/email.ts` | Add `sendDailyDigest()` export |
| `alerts/src/index.ts` | Extend `handleSubscribe`, add `handleDigestCron`, update `scheduled()` routing |
| `alerts/wrangler.toml` | Add `"0 * * * *"` cron trigger |
