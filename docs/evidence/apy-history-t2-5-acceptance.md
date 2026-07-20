# T2.5 — Historical APY storage + HF/liquidation alerts: acceptance evidence

**Date:** 2026-07-17 · **Worker:** `https://turbolong-alerts.turbolong.workers.dev`
(version `6772a2ad-1a53-4cc2-a975-caef859a0783`) · **D1:** `turbolong-alerts`
(`08ac5484-e3b5-4d60-905b-dc49ae28c137`) · **Cron:** `*/15 * * * *` (live)

Reproduce any of this with `scripts/demo_t2_5.sh` (read-only) or
`ADMIN=1 WAIT_CRON=1 ALERT_EMAIL=you@example.com scripts/demo_t2_5.sh`
(full production round-trip: prune sentinel + live alert firing).

---

## Deliverable recap

> Extend the alerts service: (a) add a `rate_snapshots` D1 table written every
> 15 minutes by the existing cron, with public GET endpoint and 365-day
> retention; (b) extend `subscriptions` with `hf_threshold`, `alert_type`
> (`'apy' | 'hf' | 'liquidation' | 'rate_spike'`) and `last_fired_at` to
> support health-factor and liquidation-imminent alert channels.

| Acceptance criterion | Status 2026-07-17 |
|---|---|
| `rate_snapshots` written every 15 min by the cron | ✅ live in production (see §2) |
| Public endpoint serving paginated JSON | ✅ live (see §3) |
| Pruning job (365-day retention) tested | ✅ **tested against the production DB** (see §4) |
| HF + liquidation alert channels live | ✅ deployed + subscriptions armed (see §5) |
| ≥ 1 alert fired in production | ⛔ blocked on `RESEND_API_KEY` (see §5.3) |
| ≥ 30 days of snapshot data | ⏳ accumulating since 2026-07-16 08:45 UTC → target 2026-08-15 (see §6) |

---

## 1. Where it lives

- **Schema** — `alerts/src/schema.sql`: `rate_snapshots` (12 columns:
  `pool_id`, `asset_symbol`, `recorded_at`, `net_supply_apr`,
  `net_borrow_cost`, `interest_supply_apr`, `interest_borrow_apr`,
  `blnd_supply_apr`, `blnd_borrow_apr`, `util`, `c_factor`) +
  index `idx_snapshots_pool_asset_time`; `subscriptions` extended with
  `alert_type` (default `'apy'`; `'rate_spike'` reserved), `hf_threshold`,
  `last_fired_at`. Migration for existing DBs:
  `alerts/migrations/0001_t2_historical_apy_hf_alerts.sql`.
- **Cron** — `alerts/wrangler.toml` `crons = ["*/15 * * * *"]` →
  `handleCron` in `alerts/src/index.ts`: fetch reserve rates → `writeSnapshot`
  → APY / HF / liquidation alert evaluation → `pruneSnapshots` (365 days).
- **Endpoint** — `GET /snapshots` (`handleSnapshots`): filters `pool_id`,
  `asset`; `limit` 1–500 (default 100); cursor pagination via `before` (id);
  returns `{ snapshots: [...], nextCursor }`, newest first.
- **Frontend consumers** — `frontend/src/history.ts` (`fetchSnapshotSeries`)
  feeding the Compare view 7D/30D/1Y trend arrows + sparklines
  (`frontend/src/views/compare.ts`) and the trade-view 7d sparkline
  (`frontend/src/views/trade.ts`). Same series powers the Tranche‑3 delta
  arrows and the Aquarius comparison.

## 2. Cron writing every 15 minutes (production)

Live `wrangler tail` capture of the 2026-07-17 08:15:49 UTC tick:

```
"*/15 * * * *" @ 7/17/2026, 10:15:49 AM - Ok
  (log) [cron] rate snapshot + alert check starting...
  ...
  (log) [cron] rate snapshot + alert check complete.
```

Consecutive production rows for `USDC` on the Fixed pool
(`GET /snapshots?pool_id=CAJJZ…&asset=USDC&limit=4`) are exactly one tick
apart: `08:00:58`, `07:45:58`, `07:30:58`, … — 8 series (Etherfuse:
XLM/USDC/CETES/USTRY/TESOURO + Fixed: XLM/USDC/EURC) × 4 rows/hour.

## 3. Public paginated JSON endpoint (production)

```
$ curl "https://turbolong-alerts.turbolong.workers.dev/snapshots?limit=2"
{"snapshots":[{"id":752,"pool_id":"CAJJZ…BXBD","asset_symbol":"EURC",
  "recorded_at":"2026-07-17 08:00:59",…,"c_factor":0.95},
  {"id":751,…,"asset_symbol":"USDC","recorded_at":"2026-07-17 08:00:58",…}],
 "nextCursor":751}
```

- **Cursor pagination:** `?limit=1&before=2` returns row `id=1`
  (`recorded_at 2026-07-16 08:45:42` — the very first snapshot).
- **Filtering:** `?pool_id=<Fixed>&asset=USDC` returns only that series.

## 4. 365-day retention — pruning job tested in production

Test executed 2026-07-17 against the **live** D1 database:

1. **08:08 UTC** — inserted a sentinel row aged 400 days:
   `id=753, pool_id='RETENTION_TEST', recorded_at='2025-06-12 08:08:38'`.
2. **08:15:49 UTC** — production cron tick ran (tail capture above).
3. **08:17 UTC** — verification query:

```sql
SELECT (SELECT COUNT(*) FROM rate_snapshots WHERE pool_id='RETENTION_TEST') AS sentinel_left,
       (SELECT COUNT(*) FROM rate_snapshots) AS total, ...
-- → sentinel_left: 0, total: 760, oldest: "2026-07-16 08:45:42", newest: "2026-07-17 08:16:00"
```

The >365-day row was deleted by `pruneSnapshots`
(`DELETE FROM rate_snapshots WHERE recorded_at < datetime('now','-365 days')`)
while the 8 fresh rows of the tick were written (752 → 760 = +8 new − 1 pruned
+ 1 sentinel). **Pruning: proven live.**

## 5. HF + liquidation alert channels

### 5.1 Subscriptions API + schema (production)

`POST /subscribe` accepts `alert_type: 'apy' | 'hf' | 'liquidation'`
(`hf_threshold > 1` required for `'hf'`). Two live subscriptions created
2026-07-17 on Fixed/USDC @ 10x:

| id | alert_type | hf_threshold | verified | fires when |
|----|-----------|--------------|----------|------------|
| 1 | `hf` | 1.2 | 1 | HF = L·c_factor/(L−1) < 1.2 |
| 2 | `liquidation` | — | 1 | HF < 1.05 (`LIQUIDATION_HF`) |

With the Fixed-pool USDC `c_factor = 0.95`, HF(10x) = 10·0.95/9 = **1.0556**:
subscription 1 (threshold 1.2) is triggered on every cron tick; subscription 2
arms and fires if `c_factor` ever drops below 0.945. 6-hour debounce via
`last_fired_at`.

### 5.2 Cron evaluation observed live

The 08:30 UTC tick (post-fix version) shows the HF channel triggering
end-to-end in production — subscription queried, HF(10x)=1.056 computed,
threshold 1.2 breached, `sendHfAlert` invoked:

```
"*/15 * * * *" @ 7/17/2026, 10:30 AM - Ok
  (error) [cron] Failed to send HF alert to hugo@theaha.co:
          Resend 401: {"statusCode":401,…,"message":"API key is invalid"}
```

Everything upstream of the Resend API call works; only the missing secret
blocks delivery.

### 5.3 Remaining blocker: `RESEND_API_KEY`

Delivery fails at the final hop because the Resend secret was never set on the
deployed worker (`wrangler secret list` shows only `KEEPER_INGEST_KEY` +
`STELLAR_BROKER_PARTNER_KEY`):

```
(error) [cron] Failed to send email alert to …: Resend 401:
        {"statusCode":401,"name":"validation_error","message":"API key is invalid"}
```

**Fix (one command, then the next cron tick fires the armed HF alert and
stamps `last_fired_at`):**

```bash
cd alerts && npx wrangler secret put RESEND_API_KEY   # key from resend.com, domain turbolong.com verified
```

Then screenshot the received "⚠ Health factor 1.056: USDC at 10x on Fixed"
email + `SELECT last_fired_at FROM subscriptions WHERE id=1` as the final
evidence artifact.

## 6. ≥30 days of data — accumulation timeline

- First snapshot: **2026-07-16 08:45:42 UTC** (id=1); first snapshot with
  real decoded rates (post XDR fix, §7): **2026-07-17 08:30 UTC** (id=762).
- ~768 rows/day (8 series × 96 ticks); 365-day retention ≫ 30-day target.
- **30 days of real-rate data reached: 2026-08-16** — re-run
  `scripts/demo_t2_5.sh` then to capture the "≥30 days accumulated" line for
  the tranche filing.

## 7. Fixes shipped during this acceptance run (2026-07-17)

Live inspection surfaced two defects, fixed and deployed as version
`6772a2ad-1a53-4cc2-a975-caef859a0783`:

1. **XDR decoder used wrong `SCValType` discriminants**
   (`alerts/src/xdr.ts`: symbol 14→15, u32 1→3, u64 3→5, i128 8→10 with
   hi/lo order corrected, string 11→14, bool/void/error/u256 payloads, account
   address key-type). Until then `get_reserve` responses failed to decode
   (`Unknown ScVal type: 15` warnings) and **every snapshot recorded fallback
   defaults** (borrow 0.3 %, util 0, c_factor 0.95 across all assets).
   Verified against live Soroban RPC after the fix — real, per-asset rates:

   ```
   Etherfuse  USDC   supply=5.023% borrow=3.828%  util=0.8322 c_factor=0.95
   Etherfuse  CETES  supply=1.451% borrow=0.100%  util=0.0001 c_factor=0.8
   Fixed      USDC   supply=7.622% borrow=11.557% util=0.8058 c_factor=0.95
   Fixed      EURC   supply=5.887% borrow=4.805%  util=0.7744 c_factor=0.95
   ```

   Rows id ≤ 761 (2026-07-16 08:45 → 2026-07-17 08:16 UTC) carry the default
   values and should be discounted in analyses; real data accrues from row
   id 762 (2026-07-17 08:30 UTC tick) onward — confirmed live:

   ```
   id= 768 2026-07-17 08:30:59 USDC  supply=7.623% borrow=11.824% util=0.8058 cf=0.95
   id= 763 2026-07-17 08:30:54 USDC  supply=2.548% borrow=3.828%  util=0.8322 cf=0.95
   ```
2. **Negative-APY email channel didn't filter `alert_type='apy'`**
   (`alertEmailSubscribers`), so `hf`/`liquidation` subscribers also received
   negative-APY emails. Filter added; HF-alert send failures now logged.

## 8. Frontend demo (for the video)

1. `cd frontend && npm run dev` → open the **Compare** view: the 7D/30D/1Y
   trend arrows + sparklines are fed by `GET /snapshots` (visible in the
   network tab → `turbolong-alerts.turbolong.workers.dev/snapshots?...`).
2. Run `scripts/demo_t2_5.sh` in a terminal beside it for the
   endpoint/pagination/retention walk-through.
3. After `RESEND_API_KEY` is set: show the HF alert email arriving after a
   cron tick.
