# SCF #43 — Tranche 2 Completion Report (DRAFT)

> **Status: draft.** All T2 deliverables are code-complete and verifiable on
> `main`. Items marked ⛔ are **operational / mainnet-gated** (a live keeper +
> the deployed alerts Worker producing real data) — they piggyback on the T1 D1
> mainnet deploy and the T3 launch/14-day watch, and will be filled in then.
> Do not file as *complete* until the ⛔ rows have captured live evidence; file
> now as a **status update**.

**Project:** Turbolong — leveraged-long protocol on Stellar/Blend.
**Track:** Integration ($100k XLM). **Tranche 2.**
**Report date:** _TBD at filing._
_Per-deliverable amounts per the SCF #43 application §8 (not restated here)._

---

## Deliverables

| # | Deliverable | Status | Evidence |
|---|-------------|--------|----------|
| T2.1 | Stellar Broker primary swap routing | ✅ Code complete / ⛔ live acceptance | Dual-quote router: **Broker** (`estimateSwap`, `@stellar-broker/client`) vs **Soroswap** (router SDK), best-route pick + slippage floor + uplift(bps). Frontend `frontend/src/views/swap.ts` + `frontend/src/aquarius.ts` (**9 unit tests**, `frontend/test/aquarius.test.ts`). Contract split harvest `harvest_claim` / `harvest_reinvest` (keeper-gated, emits `harvest_route`) — `contracts/strategies/blend_leverage/src/lib.rs`. Keeper `scripts/harvest_router.ts` (DRY-RUN default). A/B telemetry: `swap_routes` D1 table + POST/GET `/swap-routes` (`alerts/`). Acceptance generator `scripts/swap_route_report.ts --fixture` → `docs/evidence/swap-route-report.md`. PRs #268, #269, #270, #281. ⛔ ≥50 mainnet harvests with both quotes logged + DeFindex sign-off. |
| T2.2 | Partial-unwind liquidation protection (+ fixtures) | ✅ Done | `partial_unwind(caller, target_hf)` + `compute_partial_unwind()` (minimal repay to restore HF to the orange band; over-unwind guard, debt clamp — zero/negative equity resolves to a full close, never an over-repay — + accrued-rate checks) — `contracts/strategies/blend_leverage/src/lib.rs`. Permissionless when HF in orange zone, keeper otherwise. Degenerate fixture set (exact boundary, one-stroop breach, zero/negative equity, dust position, HF < 1 salvageable, `target ≤ c_factor`) in `test_leverage.rs`; **dry-run ↔ on-chain parity within rounding** proved by `test_partial_unwind_dry_run_matches_onchain_within_rounding` (real Blend pool, accrued rates) + the i128-faithful BigInt harness `scripts/rebalance_sim.ts` (contract trigger parity: fires at `orange_hf`; 7 degenerate + 100 random scenarios). On-chain testnet validation (PR #287). Evidence: `docs/evidence/rebalance-sim-dataset.json`, `rebalance-sim-report.md`, `rebalance-testnet-validation.md`. |
| T2.3 | Auto-rebalance keeper | ✅ Done | `rebalance()` (permissionless) + `rebalance_keeper(caller)` (keeper-auth, 60-ledger cooldown) restore HF below `orange_hf`; emit before/after-HF + loops-unwound — `lib.rs`. PR #265. **On-chain integration tests** (`test_integration.rs`): stressed 8-loop position restored ≥ orange_hf with event payload verified against on-chain state; cooldown enforced on-chain (incl. one-ledger-short boundary, permissionless path unaffected); already-at-floor no-op (no event, cooldown not consumed); rebalance operational while deposits are locked above `MAX_SAFE_UTILIZATION`. Offline acceptance sim (PR #280) + on-chain testnet rebalance harness + validation (PR #287, `docs/evidence/rebalance-testnet-validation.md`). Production keeper `scripts/rebalance_keeper.ts` (DRY-RUN default, `--execute --loop` for the live service, testnet + mainnet, on-chain `config()` thresholds, JSONL evidence trail). ⛔ Production keeper operation is validated during the T3 14-day launch watch. |
| T2.4 | Post-loop projected rates (≥20 IR-kink fixtures) | ✅ Done | 3-kink IR model `projectRates()` — `frontend/src/blend.ts` — mirrored by the Rust simulator `src/bin/rate_calc.rs`. **34 fixtures** (`tests/fixtures/rates.json`, exceeds ≥20) across all curve segments + kink boundaries + loop-crossing. TS↔Rust parity within **1e-7** over all fixtures (`frontend/test/parity.test.ts`, enforced in `parity.yml`). PR #266 (+ #176 earlier impl). Fully verifiable now; no external gate. |
| T2.5 | Historical APY storage + HF/liquidation alerts | ✅ Code complete / ⛔ Worker deploy | Cloudflare Worker (`alerts/`): `rate_snapshots` D1 table written every 15 min (net supply/borrow APR, rates, emissions, util, c_factor; 365-day prune); paginated `GET /snapshots` powers the 24h/7d/30d/1y deltas + Compare history. Alerts: `subscriptions` extended with `alert_type` ('apy'\|'hf'\|'liquidation') + `hf_threshold` + `last_fired_at`; cron fires HF alerts (user threshold) + liquidation-imminent (HF<1.05), email + web-push, 6h debounce (`alerts/src/{index,stellar,email}.ts`, `schema.sql`, migration `0001_t2_historical_apy_hf_alerts.sql`). Frontend consumer `frontend/src/history.ts`. ⛔ Deploy the Worker to production so snapshots accrue + alerts fire live. |

## Verifiable now (on `main`)

- **Contracts:** `partial_unwind` / `compute_partial_unwind`, `rebalance` /
  `rebalance_keeper`, split `harvest_claim` / `harvest_reinvest` — covered by the
  contract test suite (89 tests green, incl. the partial-unwind degenerate
  fixtures + the dry-run ↔ on-chain rounding-parity test) + clippy
  `-D warnings` + `cargo fmt`.
- **Rate model:** TS `projectRates` ↔ Rust `rate_calc` parity within 1e-7 over
  **34 IR-kink fixtures** (`parity.yml`).
- **Swap routing:** dual-quote best-route logic + slippage floor + A/B telemetry
  table/endpoints; `swap_route_report.ts --fixture` produces a deterministic
  acceptance report; 9 frontend unit tests for the DEX path.
- **Alerts + history:** Worker code with `rate_snapshots` cron + `/snapshots`
  endpoint + HF/liquidation alert channels (email + push) + D1 migration; CI
  green (Biome + build).
- **Rebalance acceptance:** offline sim dataset + report and an on-chain
  **testnet** rebalance validation captured under `docs/evidence/`.

## Operational / mainnet-gated (fill at launch) ⛔

- [ ] Deploy the **alerts Worker** to production (D1 bound, cron live) →
      snapshots accruing + HF/liquidation/APY alerts firing on real positions.
- [ ] Keeper running on **mainnet**: ≥50 harvests with Broker + Soroswap quotes
      logged → live `swap_route_report.ts --url … --network mainnet`.
- [ ] Production auto-rebalance observed healthy across the **14-day** T3 watch.
- [ ] DeFindex sign-off on keeper + routing logic (external).

## Links

- Testing programme: `docs/testing-programme.md` · Launch runbook: `docs/launch-runbook.md`
- Evidence: `docs/evidence/rebalance-sim-report.md`, `rebalance-testnet-validation.md`, `swap-route-report.md`
- PRs: #265 (T2.3 keeper), #266 (T2.4 fixtures), #268/#269/#270/#281 (T2.1 broker routing), #280/#287 (T2.2/T2.3 rebalance sim + testnet validation)
