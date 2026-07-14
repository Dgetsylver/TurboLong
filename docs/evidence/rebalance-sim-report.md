# T2.2/T2.3 Acceptance — Rebalance Simulation Dataset

Offline, deterministic (seed 20260613) simulation of the partial-unwind /
auto-rebalance keeper, using an **i128-faithful BigInt mirror** of the
contract's own fixed-point math (floor division, +1-stroop threshold clear,
debt clamp, layered `submit_deleverage` execution). Trigger policy matches the
contract exactly: fire when HF < `orange_hf`, unwind to `orange_hf`.
Reproduce: `npx tsx scripts/rebalance_sim.ts`.

## Result: ✅ PASS

| Metric | Value |
|--------|-------|
| Degenerate fixtures | 7 (7 valid) |
| Random scenarios | 100 |
| Rebalance triggered (HF < orange_hf) | 58 |
| Stayed healthy (no action) | 49 |
| Restored to ≥ orange_hf (or full close) | 58/58 |
| Underwater (unwind cannot rescue, predicted revert) | 1 |
| Invariant violations | 0 |
| Cooldown: rebalances fired | 5 |
| Cooldown: dips blocked by 60-ledger limit | 21 |
| Cooldown spacing ≥ 60 ledgers | yes |

## Degenerate coverage
- `D1-no-debt` — no debt → HF ∞, no-op: ✅ (repay 0, loops 0, post-HF ∞)
- `D2-boundary-exact` — HF == orange_hf exactly → no-op: ✅ (repay 0, loops 0, post-HF 1.15)
- `D3-one-stroop-below` — HF one stroop below orange_hf: ✅ (repay 5e-7, loops 1, post-HF 1.1777777)
- `D4-zero-equity` — zero equity → full close, never over-repay: ✅ (repay 10, loops 10, post-HF ∞)
- `D5-negative-equity` — underwater → unwind cannot rescue, predicted revert/no-op: ✅ (repay 10, loops 10, post-HF 0.81)
- `D6-dust` — dust position, layer rounds to 0: ✅ (repay 5e-7, loops 1, post-HF 0.95)
- `D7-hf-below-one` — HF < 1.0 but salvageable: ✅ (repay 724.0000001, loops 8, post-HF 1.187234)

## Invariants checked per scenario
- repay ≥ 0 and ≤ debt (never over-repay; zero-equity clamps to a full close)
- layered execution never exceeds the debt; post-unwind supply > 0 unless fully closed
- when triggered, post-HF ≥ `orange_hf` (or full close / predicted underwater revert)
- minimality: one fewer unwind layer would NOT restore the target (no over-unwind)
- underwater positions (equity < 0) are only ever predicted as reverts, never rescues
- no action when HF ≥ `orange_hf` (contract no-op parity)

Full per-scenario rows: `rebalance-sim-dataset.json`.

> Parity chain: this harness mirrors `compute_partial_unwind` +
> `submit_deleverage` bit-for-bit in BigInt, and the contract test
> `test_partial_unwind_dry_run_matches_onchain_within_rounding` proves the same
> prediction model matches the **executed on-chain result** (real Blend pool,
> accrued rates) within a few stroops per layer. The on-testnet/mainnet live
> keeper runs remain the operational acceptance evidence.
