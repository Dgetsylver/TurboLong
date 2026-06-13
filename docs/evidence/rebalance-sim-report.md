# T2.3 Acceptance — Rebalance Simulation Dataset

Offline, deterministic (seed 20260613) simulation of the auto-rebalance keeper
using the contract's own HF + partial-unwind math. Reproduce: `npx tsx scripts/rebalance_sim.ts`.

## Result: ✅ PASS

| Metric | Value |
|--------|-------|
| Scenarios | 100 |
| Rebalance triggered (HF < min_hf) | 27 |
| Stayed healthy (no action) | 73 |
| Restored to orange band (≥ min_hf, ≈ orange_hf) | 27/27 |
| Invariant violations | 0 |
| Cooldown: rebalances fired | 5 |
| Cooldown: dips blocked by 60-ledger limit | 21 |
| Cooldown spacing ≥ 60 ledgers | yes |

## Invariants checked per scenario
- repay ≥ 0 and ≤ debt (never over-repay)
- post-unwind supply > 0, debt ≥ 0
- when triggered, post-HF ≈ `orange_hf` and ≥ `min_hf` (restored to the safety band)
- no action when HF ≥ `min_hf`

Full per-scenario rows: `rebalance-sim-dataset.json`.

> Model: equity normalised to 1; B = supply value, D = debt value. The contract
> uses i128 fixed-point (1e7 c_factor/HF, 1e12 rates); this harness uses the
> identical closed-form formulas in double precision. This is an **offline
> behavioural** dataset — the on-testnet/mainnet runs (live keeper txs) remain
> as the on-chain acceptance evidence.
