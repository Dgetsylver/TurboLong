# Aquarius rate comparison — T3.1 acceptance evidence

Generated: 2026-07-29T14:21:38.363Z
Source: `https://amm-api.aqua.network/api/external/v1` (`POST /find-path/`, strict-send)
Mode: **live**
Probe: 1 unit (10000000 stroops) of each asset → USDC

## Verdict

| Check | Target | Result | Status |
| --- | --- | --- | --- |
| Coverage — pairs with a live rate | ≥ 5 | 8 | PASS |
| Stability — re-quote drift | ≤ 50 bps | 8/8 within | PASS |
| Round-trip — X→USDC→X loss | ≤ 500 bps | 8/8 within | PASS |
| Depth — 10× probe still routes | all priced pairs | 8/8 | PASS |
| Best Rate badge = argmax(levAPY) | exactly 1 badged row | covered by unit test, not by this run — pass --compare-json to check rendered rows | see `frontend/test/compare_metrics.test.ts` |

## Per-pair detail

| Pair | Rate (USDC per 1) | Re-quote | Drift (bps) | Round-trip (bps) | 10× depth | Hops |
| --- | ---: | ---: | ---: | ---: | :---: | ---: |
| XLM/USDC | 0.173744 | 0.173744 | 0.0 | 45 | yes | 2 |
| EURC/USDC | 1.134647 | 1.134647 | 0.0 | -36 | yes | 2 |
| AQUA/USDC | 0.000342 | 0.000342 | 0.0 | 360 | yes | 4 |
| USDGLO/USDC | 0.998942 | 0.998942 | 0.0 | -20 | yes | 1 |
| PYUSD/USDC | 0.998982 | 0.998982 | 0.0 | -4 | yes | 1 |
| USTRY/USDC | 1.068976 | 1.068976 | 0.0 | -36 | yes | 2 |
| CETES/USDC | 0.067268 | 0.067268 | 0.0 | 11 | yes | 1 |
| TESOURO/USDC | 0.240891 | 0.240891 | 0.0 | -27 | yes | 3 |

## Routes taken

- **XLM/USDC** — 2 hop(s): `CCCDPF74BFBIHCBWCA3QX5R2UULH4VSJFOK6KL44KDKJS75ZKJJYUSPH` → `CBMOEJUOKI72AXRPEQCRYSWDUBMI2LZEYVFJUTB256FO3WYSYSZI5F5A`
- **EURC/USDC** — 2 hop(s): `CCPN4NNSQKL3LLPTSPTFKYKXR3FBL37AULE6PTZH3QD24MPHXQCN5O3U` → `CBV6LZABOAJRXHLIEKILTWBPC2AXLYVR4CGGPKZQ3PWJ5QFTPIWSWGWQ`
- **AQUA/USDC** — 4 hop(s): `CCQNVBS5ETNAINQQEACPEP2ECG3ORA27VG2CXOSYV5P5EDM4JNER6X3N` → `CCQ6SUAEW4REXTXI5ZL7F2UNXTZTQAORQIPCCNWQWT3SGNYWZTTDLFTT` → `CBM3E3AV67FLU7AJTEYJCR7VOW63KKTHP4NYMMESXRGP5BIHKMCFZ4C5` → `CB7FKGSTHP75ORTIZGGMVUTQLEMVTSEOI4QORQPCABJSGTAATDFCE2YV`
- **USDGLO/USDC** — 1 hop(s): `CAC56QNJ2CX456TPC5S4MSOU3DBULG4TGN7AZ2SAYGBLD3GICFMZBIT2`
- **PYUSD/USDC** — 1 hop(s): `CDMH535JSD224YXPET3B4SJOLXTQQ24GRSCWACGYBKSH2DKFJYWI7SUW`
- **USTRY/USDC** — 2 hop(s): `CDM3E67MHCLMFXRDJWOIZRRYPKENH7CMARTOQBEZQQZVLQV52RVPMINA` → `CBV6LZABOAJRXHLIEKILTWBPC2AXLYVR4CGGPKZQ3PWJ5QFTPIWSWGWQ`
- **CETES/USDC** — 1 hop(s): `CCKGQSQG5JLZBMYMB4HT6M4H7FUC3NK5C75MIHN6627LRAY5B2SYL2AD`
- **TESOURO/USDC** — 3 hop(s): `CAT65JSA4B3AK7SIUWB5ZONZALAS2HGMFG7EF5GP7BIOKJP6Y4O6J5BF` → `CAWR3CM74VNXM5MRIPILDSTW5S4ZNB47DYBEVE6565UC573L7OFZF7FH` → `CCV2X5THRWCT7HCGJU42DMOVYLAARVIPEDG2LQOVVA2WGONF2MZY2OX6`

## What the UI does with this

- `frontend/src/views/compare.ts` renders the **DEX Rate** column from `aquariusPriceResult(asset → USDC)` — the same `find-path` call and the same 1-unit probe measured above.
- The **Best Rate** badge marks rank 1 after `compareSortRows` → `bestRowIndex` (leveraged net APY, descending) in `frontend/src/compare_metrics.ts`; `frontend/test/compare_metrics.test.ts` asserts exactly one row is badged and that it is the argmax. Pass `--compare-json <dump>` here to re-run the same rule against rendered rows.
- The **24h / 7d rate arrows** under each DEX Rate come from `rate_snapshots.dex_rate` — the same quote, snapshotted every 15 min by the alerts cron (`alerts/src/aquarius.ts`) — via `GET /snapshots`. NULL ticks are dropped, so an outage thins the window instead of reading as a rate of zero.
- The **Trend column** arrows track `net_supply_apr` (Blend), not Aquarius — an Aquarius outage does not affect them.
- Fallback behaviour when Aquarius is unreachable: `docs/aquarius-rate-fallback.md`.
