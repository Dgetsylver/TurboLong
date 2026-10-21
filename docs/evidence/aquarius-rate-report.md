# Aquarius rate comparison — T3.1 acceptance evidence

Generated: 2026-07-30T14:09:22.087Z
Source: `https://amm-api.aqua.network/api/external/v1` (`POST /find-path/`, strict-send)
Mode: **live**
Probe: 1 unit (10000000 stroops) of each asset → USDC
Badge probe: ~10,000 USDC of notional per asset

## Verdict

| Check | Target | Result | Status |
| --- | --- | --- | --- |
| Coverage — pairs with a live rate | ≥ 5 | 8 | PASS |
| Stability — re-quote drift | ≤ 50 bps | 8/8 within | PASS |
| Round-trip — X→USDC→X loss | ≤ 500 bps | 8/8 within | PASS |
| Depth — 10× probe still routes | all priced pairs | 8/8 | PASS |
| Badge input — price impact measurable | all priced pairs | 8/8 priced pairs yielded a usable impact (0.3–1527.5 bps) | PASS |
| Best Rate badge = argmax(APY − round-trip cost) | exactly 1 badged row, = argmax | rendered badge on Fixed/EURC = argmax of APY − round-trip cost across 11 priceable rows: 22.81% − 1.60pp = 21.21% net (next USDC at 17.57%) | PASS |

> The badge ranks **leveraged APY minus the Aquarius round-trip cost of entering and exiting** (2 × impact, over a 1-year hold). Half that input is Blend reserve data, which this script does not query — so a standalone run verifies the Aquarius half (the impact every cost is derived from) and the ranking itself requires `--compare-json <dump of the rendered rows>`. This run had one, so the row above is the real end-to-end check.

## Per-pair detail

| Pair | Rate (USDC per 1) | Re-quote | Drift (bps) | Round-trip (bps) | 10× depth | Impact @ notional (bps) | Hops |
| --- | ---: | ---: | ---: | ---: | :---: | ---: | ---: |
| XLM/USDC | 0.173229 | 0.173229 | 0.0 | 50 | yes | 53.2 | 2 |
| EURC/USDC | 1.150877 | 1.150877 | 0.0 | 32 | yes | 80.1 **← badged on screen** | 4 |
| AQUA/USDC | 0.000339 | 0.000339 | 0.0 | 92 | yes | 84.6 | 3 |
| USDGLO/USDC | 0.998942 | 0.998942 | 0.0 | -20 | yes | 0.3 | 1 |
| PYUSD/USDC | 1.002966 | 1.002966 | 0.0 | 66 | yes | 39.7 | 4 |
| USTRY/USDC | 1.076145 | 1.076145 | 0.0 | 13 | yes | 160.7 | 4 |
| CETES/USDC | 0.067767 | 0.067767 | 0.0 | 19 | yes | 110.0 | 4 |
| TESOURO/USDC | 0.243912 | 0.243912 | 0.0 | 28 | yes | 1527.5 | 4 |

## Routes taken

- **XLM/USDC** — 2 hop(s): `CDE57N6XTUPBKYYDGQMXX7E7SLNOLFY3JEQB4MULSMR2AKTSAENGX2HC` → `CBRUQ7I6C6OGHMDYWD6XQUZFB6KJ3LLPNE34EPKSPFZ2YMBJ2GIWYYZ7`
- **EURC/USDC** — 4 hop(s): `CCPN4NNSQKL3LLPTSPTFKYKXR3FBL37AULE6PTZH3QD24MPHXQCN5O3U` → `CB7NBRNRMSZW576ABOBGCZCPC6RB6FCFNJTABLVI7FRTIBWFE3MKPBEK` → `CCQNVBS5ETNAINQQEACPEP2ECG3ORA27VG2CXOSYV5P5EDM4JNER6X3N` → `CBRUQ7I6C6OGHMDYWD6XQUZFB6KJ3LLPNE34EPKSPFZ2YMBJ2GIWYYZ7`
- **AQUA/USDC** — 3 hop(s): `CADFWSBBD6VMCL45DEPZ37X3JNXOZXIWEVJJTHMQH3UEB3JSQVJSPG2I` → `CDJPROL4CVOGTIJ4VBJST67D6SJDPUICASDQFBYD3DB74AR3SE3MAR4V` → `CBBMQBNHB2FYVZYV7VNHOJHUMTFJLR4PUMRVQYNW6RHIKZO2NQMIBUCV`
- **USDGLO/USDC** — 1 hop(s): `CAC56QNJ2CX456TPC5S4MSOU3DBULG4TGN7AZ2SAYGBLD3GICFMZBIT2`
- **PYUSD/USDC** — 4 hop(s): `CBGSR4FCHGM5WXDIY6YD4T6SSS26HHGIJCXGVIQ2PFSO7EPLMKBZE3KW` → `CB7NBRNRMSZW576ABOBGCZCPC6RB6FCFNJTABLVI7FRTIBWFE3MKPBEK` → `CCQNVBS5ETNAINQQEACPEP2ECG3ORA27VG2CXOSYV5P5EDM4JNER6X3N` → `CBRUQ7I6C6OGHMDYWD6XQUZFB6KJ3LLPNE34EPKSPFZ2YMBJ2GIWYYZ7`
- **USTRY/USDC** — 4 hop(s): `CDM3E67MHCLMFXRDJWOIZRRYPKENH7CMARTOQBEZQQZVLQV52RVPMINA` → `CB7NBRNRMSZW576ABOBGCZCPC6RB6FCFNJTABLVI7FRTIBWFE3MKPBEK` → `CCQNVBS5ETNAINQQEACPEP2ECG3ORA27VG2CXOSYV5P5EDM4JNER6X3N` → `CBRUQ7I6C6OGHMDYWD6XQUZFB6KJ3LLPNE34EPKSPFZ2YMBJ2GIWYYZ7`
- **CETES/USDC** — 4 hop(s): `CCC466Y3A5332PRE7NQOKOLJXDHF5CNS2M5MT7I7YIPNKLUO4YETIE3B` → `CDM3E67MHCLMFXRDJWOIZRRYPKENH7CMARTOQBEZQQZVLQV52RVPMINA` → `CB2I6JGVCWBGXQ4WAJOQQEAKEXXPURL4E2BPEW4NKVTUYYK7VPTDDTMN` → `CC6WOGTWGZERQVJRT45XST76QYGD3YICUWDNYW3K3AD5ONARQQW2N7XP`
- **TESOURO/USDC** — 4 hop(s): `CAT65JSA4B3AK7SIUWB5ZONZALAS2HGMFG7EF5GP7BIOKJP6Y4O6J5BF` → `CB7NBRNRMSZW576ABOBGCZCPC6RB6FCFNJTABLVI7FRTIBWFE3MKPBEK` → `CCQNVBS5ETNAINQQEACPEP2ECG3ORA27VG2CXOSYV5P5EDM4JNER6X3N` → `CBRUQ7I6C6OGHMDYWD6XQUZFB6KJ3LLPNE34EPKSPFZ2YMBJ2GIWYYZ7`

## What the UI does with this

- `frontend/src/views/compare.ts` renders the **DEX Rate** column from `aquariusRateWithImpact(asset → USDC)` — the same `find-path` call and the same 1-unit probe measured above.
- The **Best Rate** badge marks the row with the highest leveraged APY **after trading costs**: `levApy − 2 × impact`, where impact is the price impact at ~10,000 USDC of notional measured in the table below, doubled for entry + exit and spread over a 1-year hold (`netOfCostApy` → `bestRateRowIndex` in `frontend/src/compare_metrics.ts`).
- Why net of cost rather than the raw rate or the cheapest route: the raw `dexRate` is USDC per unit, so its argmax is just the highest-denominated token; and the cheapest route to trade is not what a user on a leveraged-lending screen is shopping for. A 1497 bps round trip genuinely destroys a 6% yield, while a 0.3 bps one is irrelevant next to a 26% one.
- The ranking is **row-level**, not asset-level: one asset in three pools shares an Aquarius rate but has three different APYs, so the badge lands on a specific row for a reason rather than by tiebreak.
- USDC rows carry a real zero cost (no swap needed in either direction) and compete on APY like any other row.
- The ★ in the Rank column is a *different* marker: rank 1 by leveraged APY before costs (`bestRowIndex`). It coincides with the badge whenever trading cost does not change the winner, and diverges exactly when it does.
- The **24h / 7d rate arrows** under each DEX Rate come from `rate_snapshots.dex_rate` — the same quote, snapshotted every 15 min by the alerts cron (`alerts/src/aquarius.ts`) — via `GET /snapshots`. NULL ticks are dropped, so an outage thins the window instead of reading as a rate of zero.
- The **Trend column** arrows track `net_supply_apr` (Blend), not Aquarius — an Aquarius outage does not affect them.
- Fallback behaviour when Aquarius is unreachable: `docs/aquarius-rate-fallback.md`.
