# T2.3 Acceptance — On-chain Testnet Rebalance Validation

Live simulation against the deployed testnet leveraged-USDC strategy.
Reproduce: `cd frontend && npx tsx ../scripts/rebalance_testnet_sim.ts`.

| Check | Result |
|-------|--------|
| Vault contract | `CDOETIUHCETALQMBMYUXGFJFA34KDTV74AMHTWXJLY2XUVNZ23JDLJZA` (testnet) |
| Contract reachable (simulate) | ✅ yes |
| `health_factor()` | 1.2683 (min_hf 1.05) |
| `position()` equity / b / d | 502.0702904 / 17271999153 / 12240894564 |
| Position health | healthy (HF ≥ min_hf) |
| `rebalance()` simulates | ✅ success (auto-deleverage path operational) |

## What this proves
The permissionless `rebalance()` / keeper auto-deleverage path is **operational
on a real deployed contract** (it simulates successfully and reads a live HF).
Combined with `scripts/rebalance_sim.ts` — the deterministic **100-scenario**
behavioural dataset (all restored to the orange band, 0 invariant violations,
60-ledger cooldown honoured) — this covers the T2.3 acceptance offline + on-chain.

## Remaining (operator, needs a funded testnet keeper)
The live **100-run** dataset (`--execute --runs 100`) opens/stresses a position
and calls `rebalance_keeper` each run, recording before/after HF + tx hashes,
respecting the 60-ledger cooldown. It needs `KEEPER_SECRET`
(the strategy's keeper account, funded) — provide it via `op run` / `.env.local`.
The single live **mainnet** rebalance remains mainnet-gated.
