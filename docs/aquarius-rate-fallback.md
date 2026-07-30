# Aquarius rate comparison — degraded-mode / fallback path

**Scope:** SCF T3.1. What Turbolong shows, and keeps working, when the Aquarius
routing API is slow, refusing, or down.

Aquarius supplies **rate comparison only**. It is never on the path of a
deposit, a loop, a withdrawal, or a health-factor calculation. Nothing a user
can lose money on depends on it being up.

Two things it *does* drive, and both fail closed: the **DEX Rate** column and the
**Best Rate** badge. The badge is Aquarius-determined by design — see
[The Best Rate badge](#the-best-rate-badge) — so an outage removes it rather than
moving it somewhere unverified.

## Where Aquarius is called

| Surface | Call | What it feeds |
| --- | --- | --- |
| Compare Pools (`frontend/src/views/compare.ts`) | `aquariusRateWithImpact(asset → USDC)` | the **DEX Rate** column *and* the **Best Rate** badge; two calls per distinct asset |
| Swap (`frontend/src/views/swap.ts`) | `aquariusBestRateResult(sell → buy)` | the **DEX Rate** cross-check under the Broker quote |
| Alerts cron (`alerts/src/index.ts`, every 15 min) | `aquariusPrice(asset)` from `alerts/src/aquarius.ts` | the `rate_snapshots.dex_rate` column → the **24h/7d rate arrows** |
| Status page (`frontend/src/views/status.ts`) | `reachable(AQUARIUS_API)` | the "Aquarius AMM API" health row |
| Vault (`frontend/src/aquarius_listings.ts`) | none (static registry) | the "Trade on Aquarius" CTA — unaffected by API health |

The browser calls go through `frontend/src/aquarius.ts`; the worker has its own
minimal copy in `alerts/src/aquarius.ts` (separate builds, no shared module —
keep the request shape in sync if the Aquarius API changes). Both implement the
same never-throw contract.

### The Best Rate badge

The badge marks the row with the **highest leveraged APY after the cost of
getting in and out at Aquarius' current rates**:

```
netOfCostApy = levApy − (2 × impactBps / 100) / HOLD_YEARS
```

computed by `netOfCostApy` → `bestRateRowIndex` in
`frontend/src/compare_metrics.ts`. `impactBps` is the price impact at
`IMPACT_NOTIONAL` (~$10,000 of output), doubled for the entry and the exit leg,
and spread over a one-year hold so it is on the same annual basis as the APY it
is subtracted from.

Worked from a real render: EURC 26.01% − 0.88pp = **25.13%**, USDC 19.15% − 0 =
19.15%, USTRY 11.58% − 2.45pp = 9.13%, PYUSD 7.19% − 0.02pp = 7.17%, CETES 4.18%
− 1.78pp = 2.40%, TESOURO 6.14% − 29.96pp = **−23.82%**.

The impact costs a second quote per asset. `aquariusRateWithImpact` probes 1 unit
for the reference rate the column displays, then the same route sized to the
notional; the gap between the two per-unit rates is the impact. Both probes are
memoised per asset id, so a render costs two calls per *distinct* asset, not per
row.

**Why not the highest `dexRate`.** That column is USDC per 1 unit, so its argmax
is whichever asset is denominated highest — EURC at 1.14 would beat XLM at 0.17
forever, regardless of which is actually better to hold or trade.

**Why not the cheapest route to trade.** Ranking on impact alone badges the asset
that is cheapest to swap, which is not what someone on a leveraged-lending screen
is shopping for. A 1497 bps round trip genuinely destroys a 6% yield; a 0.3 bps
one is irrelevant next to a 26% one. Only the combination ranks rows the way the
money actually lands.

**Why the notional is a dollar amount rather than a unit count.** 1 unit of XLM
and 1 unit of EURC are ~$0.17 and ~$1.14 of trade. Measured against mainnet, a
1-vs-10-**unit** probe returns 0.0–5.6 bps — noise, occasionally negative from
rounding — while a fixed ~$10k notional separates the assets cleanly and
monotonically.

Four deliberate behaviours:

- **The holding period is an assumption, and it is stated.** Entry/exit is a
  one-time cost; the APY is annual. One year puts them on the same basis. A
  shorter assumed hold weighs the cost more heavily and can change the winner,
  so `HOLD_YEARS` is a named constant and the badge tooltip spells out the
  arithmetic rather than hiding it.
- **The exit is assumed to cost what the entry did.** We measure asset→USDC only
  and double it; quoting the reverse leg separately would double the request
  count for a second-order correction.
- **Negative impact is clamped to zero.** A larger trade cannot genuinely get a
  better per-unit rate on an AMM, so the small negatives mainnet returns on deep
  stable pairs are rounding.
- **USDC carries a real zero cost and is badge-eligible.** A USDC position needs
  no swap in either direction. It still has to win on APY like any other row.

The ranking is **row-level**, not asset-level: one asset in three pools shares an
Aquarius rate but has three different `levApy`, so the badge lands on a specific
row for a reason rather than by tiebreak. Ties within `NET_TIE_EPS_PP` (0.05pp)
go to the earlier, higher-APY row.

#### Known sensitivity: the reference route can change under you

Impact is the gap between a 1-unit reference quote and a sized one, so it assumes
both price the same route. Aquarius re-routes as pool states move, and the rate
is stable *within* a routing regime but steps *between* them. Measured on
mainnet, PYUSD/USDC quoted 0.998982 at 1 hop, then 0.9992623 at 3 hops (30/30
identical probes), then 1.0029662 at 4 hops (10/10 identical) — the last of which
reads as a USD stablecoin worth more than USDC. When the reference re-routes but
the sized probe does not, part of the measured impact is that route change rather
than depth: PYUSD's impact moved 1.2 → 39.7 bps across two runs for this reason,
and EURC's 44.1 → 80.1 bps when its route went 3 → 4 hops.

The badge tolerates this in proportion to the margin, which is checkable. In the
latest run EURC led USDC by 21.21% vs 17.57% net — 3.64pp of headroom, so EURC's
measured impact would have to rise by ~182 bps (from 80) to lose the badge. When
two rows sit close on net APY, expect the badge to move between refreshes; that
is the metric being honest about a real gap in what Aquarius is quoting, not a
defect in the ranking. It is also why the badge is never derived from a cached or
carried-forward rate.

The badge and the ★ in the Rank column are still different markers — the ★ is
rank 1 by leveraged APY *before* costs (`bestRowIndex`). They coincide whenever
trading cost does not change the winner, and diverge exactly when it does, which
is the case worth surfacing.

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

| Condition | Compare "DEX Rate" | Compare "Best Rate" badge | Swap "DEX Rate" |
| --- | --- | --- | --- |
| `ok` | the rate, 4 dp, with its 24h/7d movement beneath | on the best net-of-cost row | Aquarius output amount |
| `no_route` | `no route` (tooltip: "Aquarius has no route for this pair right now.") | row is not eligible — its cost is unknown | `N/A` |
| `unreachable` | `unavailable` (tooltip explains Aquarius is unreachable and pool APYs are unaffected) | row is not eligible | `unavailable` |
| reference quote but no sized quote | the rate | row is not eligible — the rate exists but its cost at size is unmeasured | n/a |
| every row ineligible | as above per row | **no badge anywhere** | as above |

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

Everything except the DEX Rate column and the Best Rate badge:

- **Pool ranking, including the ★ on rank 1.** Ranking is leveraged net APY
  (`compare_metrics.ts:compareSortRows` → `bestRowIndex`) from Blend reserve data
  over Soroban RPC. It does not read Aquarius at all, so row order and the ★ are
  unchanged by an outage.
- **The "Best Rate" badge disappears** — this is the one visible casualty.
  `bestRateRowIndex` returns `-1` when no row has a measurable impact, so nothing
  is badged. It deliberately does **not** fall back to rank 1: with no cost data,
  netting cost off the yield is exactly the thing we cannot do, and silently
  badging the APY leader would present a pre-cost number as a post-cost one. No
  badge is the honest state, and the table is fully usable without it.
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
- **No badge fallback to APY.** Covered above: an unbadged table beats a badge
  that implies an unverified rate.
- **No `amount_with_fee` shortcut for the badge.** It would have made the impact
  measurement free, but Aquarius returns it equal to `amount` on every mainnet
  pair we quote, so it carries no fee or depth signal. Hence the second probe.

## Verification

- Unit tests: `frontend/test/aquarius.test.ts` — covers `ok` / `no_route` /
  `unreachable` classification, the 4xx-vs-5xx split, the numeric-`amount` live
  response shape, the throwing-fetch path, and `aquariusRateWithImpact` (impact
  sign and magnitude, notional-based probe sizing, the negative clamp, and
  keeping the reference rate when only the sized probe fails).
- Unit tests: `frontend/test/compare_metrics.test.ts` — `netOfCostApy`
  arithmetic (both legs, annualised; a large enough cost turning a positive yield
  negative); and the badge landing on the net-of-cost argmax on live-shaped data,
  letting cost overturn the highest headline APY, *not* collapsing to "cheapest
  to trade", ranking row-level so one asset in two pools is split by its own APY,
  ignoring unquotable rows, badging nothing rather than defaulting to rank 1
  during an outage, and breaking sub-tolerance ties toward the higher-APY row.
- Unit tests: `frontend/test/history.test.ts` — NULL `dex_rate` rows are dropped
  rather than read as zero, and both columns come from a single request.
- Migration: `alerts/migrations/0004_aquarius_dex_rate.sql` (run once against
  the deployed D1; fresh deploys get the column from `alerts/src/schema.sql`).
- Live acceptance: `docs/evidence/aquarius-rate-report.md`, regenerated by
  `scripts/aquarius_rate_report.ts`. It measures impact for every pair against
  the live routing API and checks that half of the badge input unconditionally.
  The **ranking** needs `--compare-json <dump of the rendered rows>`, because
  `levApy` is Blend data the script does not query: the dump supplies the APYs
  and which row was badged, the run supplies the live costs, and
  `bestRateRowIndex` is **imported from the frontend** so the verdict cannot
  drift from what ships. A wrong badge exits non-zero. Without a dump the script
  says the ranking was not checked rather than inventing APYs to assert one.
