# D1 — Mainnet Vault Deploy: Readiness

> **State: one signed command away.** Everything in our control is done +
> verified; the deploy itself is gated on the operator's keys + a risk-param
> sign-off (real funds). _Prepared 2026-06-15._

## Ready ✅

- **Deploy script:** `scripts/deploy_strategy_mainnet.ts` — installs both WASMs,
  then per asset deploys the 10-arg `blend_leverage_strategy` + a `vault_share`
  SEP-41 token, wires `set_share_token` + `set_swap_account(keeper)`, and writes
  `deployed-vaults.mainnet.json`.
- **WASMs built** at the exact paths the script reads:
  - `contracts/strategies/blend_leverage/target/wasm32v1-none/release/blend_leverage_strategy.wasm`
  - `contracts/tokens/vault_share/target/wasm32v1-none/release/vault_share_token.wasm`
  - (rebuild: `cd <crate> && cargo build --target wasm32v1-none --release`)
- **Config verified against LIVE mainnet** (Etherfuse pool `CDMAVJPF…`, status=1
  active; Soroswap router `CAG5LRYQ…`). Per-asset strategy `c_factor` sits safely
  below the pool's current value (buffer for HF):

  | Asset | Contract | Strategy cFactor | Pool cFactor (live) | Loops | min_hf | orange_hf |
  |---|---|---|---|---|---|---|
  | USDC  | `CCW67TSZ…JMI75` | 0.90 | 0.95 | 4 | 1.05 | 1.15 |
  | USTRY | `CBLV4ATS…PNUR`  | 0.85 | 0.90 | 3 | 1.05 | 1.15 |
  | CETES | `CAL6ER2T…6VXV`  | 0.75 | 0.80 | 3 | 1.05 | 1.15 |
  | XLM   | `CAS3J7GY…OWMA`  | 0.70 | 0.75 | 2 | 1.10 | 1.20 |

  `reward_threshold = 100 BLND`. (Pool's 5th reserve TESOURO is intentionally out
  of the D1 4-asset scope.)

## Operator inputs (the gate) ⛔

1. **`DEPLOY_SECRET_KEY`** — `S…` deployer secret, via 1Password / a secrets
   manager (never inline a mainnet key). Account must be **funded** (~30–50 XLM
   buffer: 2 WASM installs + 4×[deploy strategy + deploy token + 2 wirings]).
2. **`KEEPER_PUBKEY`** — `G…` keeper account (runs harvest + `rebalance_keeper`,
   pulls BLND). **Required.**
3. **`ADMIN_PUBKEY`** — `G…` admin (upgrade + `set_share_token`/`set_swap_account`).
   Defaults to the deployer; **recommend a multisig/hardware key**.
4. **Risk-param sign-off** — approve (or adjust) the per-asset `c_factor` /
   `target_loops` / `min_hf` / `orange_hf` / `reward_threshold` table above.

## Run it

```bash
# Pre-flight (validates deployer is funded + the WASM install simulates):
op run -- env DRY_RUN=1 \
  DEPLOY_SECRET_KEY=op://Private/turbolong-deployer/secret \
  KEEPER_PUBKEY=G... ADMIN_PUBKEY=G... \
  npx tsx scripts/deploy_strategy_mainnet.ts

# Real deploy (drop DRY_RUN):
op run -- env \
  DEPLOY_SECRET_KEY=op://Private/turbolong-deployer/secret \
  KEEPER_PUBKEY=G... ADMIN_PUBKEY=G... \
  npx tsx scripts/deploy_strategy_mainnet.ts
```

> Note: `DRY_RUN=1` validates the deployer account + the first WASM install
> simulation. The full chain can't be fully dry-run (each deploy depends on the
> prior contract existing on-chain) — the proven rehearsal is the **testnet**
> deploy (`scripts/deploy_strategy.ts`, the live testnet vault `CDOET…`).

## After deploy

1. Wire the 4 vaultIds into `frontend/src/defindex.ts` `MAINNET_VAULTS`
   (`scripts/wire_mainnet_vaults.ts` reads `deployed-vaults.mainnet.json`).
2. Per asset: small **deposit → loop → withdraw** on mainnet; capture tx hashes
   (Stellar Expert) for the T1/T3 reports.
3. **DeFindex co-sign** of the 4 deployments (external).
4. Fill the ⛔ rows in `docs/scf-t1-completion-report.md` +
   `docs/scf-t3-completion-report.md` (vault IDs, receipt-token addresses, tx
   hashes), then file.

Refs: `docs/mainnet-go-live-runbook.md`, `docs/migration-runbook.md`.
