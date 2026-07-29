# Aquarius rate comparison — degraded-mode / fallback path

**Scope:** SCF T3.1. What Turbolong shows, and keeps working, when the Aquarius
routing API is slow, refusing, or down.

Aquarius supplies **rate comparison only**. It is never on the path of a
deposit, a loop, a withdrawal, or a health-factor calculation. Nothing a user
can lose money on depends on it being up.

## Where Aquarius is called

| Surface | Call | What it feeds |
| --- | --- | --- |
| Compare Pools (`frontend/src/views/compare.ts`) | `aquariusPriceResult(asset → USDC)` | the **DEX Rate** column, one call per pool/asset row |
| Swap (`frontend/src/views/swap.ts`) | `aquariusBestRateResult(sell → buy)` | the **DEX Rate** cross-check under the Broker quote |
| Alerts cron (`alerts/src/index.ts`, every 15 min) | `aquariusPrice(asset)` from `alerts/src/aquarius.ts` | the `rate_snapshots.dex_rate` column → the **24h/7d rate arrows** |
| Status page (`frontend/src/views/status.ts`) | `reachable(AQUARIUS_API)` | the "Aquarius AMM API" health row |
| Vault (`frontend/src/aquarius_listings.ts`) | none (static registry) | the "Trade on Aquarius" CTA — unaffected by API health |

The browser calls go through `frontend/src/aquarius.ts`; the worker has its own
minimal copy in `alerts/src/aquarius.ts` (separate builds, no shared module —
keep the request shape in sync if the Aquarius API changes). Both implement the
same never-throw contract.

### Cron cost, and why it is off the critical path

The rate is a property of the **asset**, not the pool, and the same asset sits
in several pools (XLM is in all three). The cron memoises per asset id for the
tick, so one tick costs one Aquarius call per *distinct* asset (**9**), not one
per pool/asset row (**16**), and every row for an asset carries an identical
rate. A null is cached too: a tick makes one attempt per asset and does not
retry.

The quotes are **prefetched at the top of the tick and never awaited inline**.
This matters for safety, not just speed: HF and liquidation alerts are sent
inside the same per-asset loop, so awaiting a quote before each snapshot would
put a decorative price lookup in front of the emails that warn a user their
position is about to be liquidated. With a wedged Aquarius that is up to
9 × 8s ≈ 72s of added delay before alerting. Prefetching lets the requests fly
during the Soroban RPC work, so the `await` at insert time is normally already
settled and the alerting path waits on nothing.

Leaving the promises unawaited is safe because `aquariusPrice` never rejects —
it resolves `null` on timeout or error — so no unhandled rejection can escape.

## Client behaviour

`aquariusBestRateResult()` never throws and never blocks a render. It returns
`{ quote, status }` where `status` is one of:

| `status` | Trigger | Meaning |
| --- | --- | --- |
| `ok` | 2xx with `success: true` and a parseable `amount` | live rate |
| `no_route` | 2xx with `success: false`, a missing/garbage `amount`, a 4xx, or an in/out pair that is the same token | Aquarius answered; there is no path for this pair |
| `unreachable` | 5xx, network/DNS/CORS failure, or the 6s `AbortSignal.timeout` | the service is down or unreachable |

The two failure modes are deliberately distinct: `no_route` is a fact about the
**pair**, `unreachable` is a fact about **Aquarius**. Collapsing them would tell
a user an asset is untradeable when the truth is that our quote provider is
offline.

Guarantees:

- **6-second hard timeout** per call (`AbortSignal.timeout(6000)`) — a hung
  Aquarius cannot hang a page.
- **No retry, no backoff.** A failed quote is dropped; the next natural refresh
  (a re-render, or the user changing an input) re-quotes. A down API therefore
  costs at most one 6s request per row per refresh, not a retry storm.
- **Fully parallel and independently settled.** Compare enriches rows with
  `Promise.allSettled`, so one dead pair or a dead API cannot stop the other
  rows, the sparklines, or the ranking.

## What the user sees

| Condition | Compare "DEX Rate" | Swap "DEX Rate" |
| --- | --- | --- |
| `ok` | the rate, 4 dp, with its 24h/7d movement beneath | Aquarius output amount |
| `no_route` | `no route` (tooltip: "Aquarius has no route for this pair right now.") | `N/A` |
| `unreachable` | `unavailable` (tooltip explains Aquarius is unreachable and pool APYs are unaffected) | `unavailable` |

Strings are localised (`compare.dexNoRoute`, `compare.dexDown`,
`common.unavailable`, `common.na`) in en / es / pt.

### The 24h/7d rate arrows during an outage

These read `rate_snapshots.dex_rate`, so they degrade on a delay rather than
instantly:

- **A short outage** (a few ticks) leaves NULL holes in the series. Those rows
  are dropped client-side, so the window simply has fewer points and the
  percentage still spans real quotes. This is why the column is nullable and
  why `history.ts` filters `!= null` *before* the numeric filter: `Number(null)`
  is `0`, which is finite, so a naive parse would turn an outage into a rate of
  zero and a −100% arrow.
- **A long outage** (> the whole window) leaves fewer than 2 points inside it;
  `pctChangeOverHours` returns null and the arrow is omitted entirely. When
  neither window has data the rate renders with no trend line under it at all,
  rather than two empty dashes.
- **No carry-forward.** A stale rate is never repeated into a later tick.

The same applies to a freshly-migrated database: rows written before migration
`0004` have `dex_rate` NULL, so the arrows stay absent until ~24h (then ~7d) of
history has accrued.

## What keeps working during an Aquarius outage

Everything except the DEX Rate column:

- **Pool ranking and the "Best Rate" badge.** The badge marks rank 1 by
  leveraged net APY (`compare_metrics.ts:compareSortRows` → `bestRowIndex`),
  computed from Blend reserve data over Soroban RPC. It does not read the
  Aquarius rate at all, so the ranking is unchanged by an outage.
- **24h / 7d APR trend arrows** (the Trend column). Sourced from
  `rate_snapshots.net_supply_apr` via the alerts Worker's `GET /snapshots`
  (`frontend/src/history.ts`) — Blend data, no Aquarius involvement. Only the
  *rate* arrows in the DEX Rate column depend on Aquarius, and they degrade as
  described above.
- **Base APY, Leveraged APY, Max Lev** — Blend RPC.
- **Swap quotes and execution** — Stellar Broker, which does its own routing
  across Stellar DEXes (Aquarius pools included, via Broker's aggregation).
  Aquarius here is a second opinion, not the quote.
- **Deposits, loops, withdrawals, health factors** — on-chain, no dependency.

## Escalation path

1. **Confirm** on the status page (`/status.html`) — the "Aquarius AMM API" row
   goes red on the same reachability check, auto-refreshing every 30s.
2. **Reproduce** out of band:
   ```
   curl -sS -m 10 -X POST https://amm-api.aqua.network/api/external/v1/find-path/ \
     -H 'Content-Type: application/json' \
     -d '{"token_in_address":"CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
          "token_out_address":"CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
          "amount":"10000000"}'
   ```
3. **Re-run the acceptance probe** across all pairs and read the verdict table:
   ```
   npx tsx scripts/aquarius_rate_report.ts     # → docs/evidence/aquarius-rate-report.md
   ```
4. **If Aquarius has moved** (new host or path), repoint without a code change:
   set `VITE_AQUARIUS_API` in the frontend environment and redeploy. The
   constant in `frontend/src/aquarius.ts` is only the default.
5. **On-chain fallback.** The mainnet Aquarius router
   `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK`
   (`AQUARIUS_ROUTER`) can be queried directly over Soroban RPC if the REST API
   is down for an extended period. This is the documented escape hatch, not a
   hot path: it is slower and needs per-pool discovery, so it is used for
   operator verification rather than being wired into the UI, where the correct
   behaviour is to say "unavailable" and leave the rest of the screen intact.

## Deliberately not done

- **No stale-rate caching.** A remembered rate rendered as if live is worse than
  an honest "unavailable" — the number a user would act on could be hours old.
- **No auto-retry loop.** It multiplies load on a service that is already
  struggling and delays the honest empty state.
- **No blocking spinner.** The Compare table renders pool data first and fills
  the DEX Rate column when (and if) quotes arrive.

## Verification

- Unit tests: `frontend/test/aquarius.test.ts` — covers `ok` / `no_route` /
  `unreachable` classification, the 4xx-vs-5xx split, the numeric-`amount` live
  response shape, and the throwing-fetch path.
- Unit tests: `frontend/test/compare_metrics.test.ts` — the badge lands on the
  argmax row, and the 24h/7d arrows come from the snapshot window.
- Unit tests: `frontend/test/history.test.ts` — NULL `dex_rate` rows are dropped
  rather than read as zero, and both columns come from a single request.
- Migration: `alerts/migrations/0004_aquarius_dex_rate.sql` (run once against
  the deployed D1; fresh deploys get the column from `alerts/src/schema.sql`).
- Live acceptance: `docs/evidence/aquarius-rate-report.md`, regenerated by
  `scripts/aquarius_rate_report.ts`.
