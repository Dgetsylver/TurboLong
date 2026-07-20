# Turbolong mainnet go-live runbook

The ordered, copy-pasteable steps to take Tranche 1/2 live once the open PRs are
merged. **Every step touching mainnet is real funds** — do the dry-runs first and
keep keys in a secrets manager (`op run`), never inlined or committed.

Prerequisites you provide:
- `KEEPER_PUBKEY` — funded mainnet account (XLM for fees) that runs harvest +
  rebalance + pulls BLND for Broker swaps.
- `ADMIN_PUBKEY` — admin (controls upgrades + `set_share_token`/`set_swap_account`);
  ideally multisig/hardware.
- `DEPLOY_SECRET_KEY` — deployer secret (pays deploy fees), via `op run`.
- Sign-off on the per-asset config in `scripts/deploy_strategy_mainnet.ts`.

---

## 1. Apply the D1 database migrations (alerts Worker)

Run once each against the production D1 (fresh DBs get the full schema from
`alerts/src/schema.sql`):

```bash
cd alerts
wrangler d1 execute turbolong-alerts --remote --file=migrations/0001_t2_historical_apy_hf_alerts.sql
wrangler d1 execute turbolong-alerts --remote --file=migrations/0002_swap_routes.sql
wrangler secret put KEEPER_INGEST_KEY   # generate a random token; the keeper sends it as Bearer
```

## 2. Build the contract WASMs

```bash
(cd contracts/strategies/blend_leverage && cargo build --target wasm32v1-none --release)
(cd contracts/tokens/vault_share        && cargo build --target wasm32v1-none --release)
```

## 3. Deploy the 4 vaults (DRY-RUN, then live)

```bash
cd scripts && npm install
# Dry-run first — simulates install/deploy, submits nothing:
DRY_RUN=1 op run -- env \
  DEPLOY_SECRET_KEY=op://<vault>/turbolong-deployer/secret \
  ADMIN_PUBKEY=G... KEEPER_PUBKEY=G... \
  npx tsx deploy_strategy_mainnet.ts

# Live (real funds) — only after dry-run looks right and you've signed off config:
op run -- env \
  DEPLOY_SECRET_KEY=op://<vault>/turbolong-deployer/secret \
  ADMIN_PUBKEY=G... KEEPER_PUBKEY=G... \
  npx tsx deploy_strategy_mainnet.ts
```

Writes `deployed-vaults.mainnet.json` with `{strategy, token}` per asset. It also
runs `set_share_token` + `set_swap_account` for each.

## 4. Wire the frontend

In `frontend/src/defindex.ts`, populate `MAINNET_VAULTS` from
`deployed-vaults.mainnet.json` — one entry per asset with the strategy `vaultId`,
the share-token address, `assetId`/`poolId`, and the matching config. Remove the
placeholder. `npm run build` to confirm.

## 5. End-to-end verification (per asset, small amounts)

For each vault, on mainnet: `deposit → loop → withdraw`. Capture the tx hashes and
confirm the b/d-token deltas on Stellar Expert. This satisfies D1's acceptance.
Get the DeFindex team to co-sign the deployments.

## 6. Stand up the keeper (T2.1 / T2.3)

- **Dry-run now (no key, Cloudflare cron or a cheap CI):** run
  `scripts/harvest_router.ts` (default mode) with `SWAP_ROUTES_URL` +
  `KEEPER_INGEST_KEY` set — it logs real Broker-vs-Soroswap quotes to
  `/swap-routes`, building the A/B dataset before any execution.
- **Live execution (dedicated Node service):** point `VAULTS_JSON` at the deployed
  strategy IDs, supply `KEEPER_SECRET` behind a secrets manager / remote signer,
  and run with `--execute`. Schedule harvest + `rebalance_keeper` calls. (Do NOT
  put live signing on a GitHub Action — flaky cron + key-on-CI.)
- **Auto-rebalance (T2.3):** `scripts/rebalance_keeper.ts` is the production
  rebalance keeper. Probe first with no key:
  `NETWORK=mainnet VAULTS_JSON='[{"symbol":"USDC","strategyId":"C…"}]' npm run rebalance-keeper`
  (DRY-RUN: reads on-chain `config()` thresholds + `health_factor()`, simulates
  only). Then run the live service:
  `op run -- env NETWORK=mainnet VAULTS_JSON=… npx tsx rebalance_keeper.ts --execute --loop`
  — it fires `rebalance_keeper` only when HF < the on-chain `orange_hf`, respects
  the 60-ledger on-chain cooldown, and appends every probe/rebalance (before/after
  HF, loops unwound, tx hash) to `docs/evidence/rebalance-keeper-log.jsonl`.
  For a permanent deployment, use the hardened systemd unit + env template in
  `scripts/deploy/` (`rebalance-keeper.service`, `rebalance-keeper.env.example`).
- Accumulate ≥50 executed mainnet harvests → the `GET /swap-routes` report is the
  T2.1 A/B deliverable; the same keeper firing `rebalance_keeper` produces the
  T2.3 live mainnet rebalance (captured in the JSONL evidence log).

## 7. Tranche reporting

- Demonstrate the gitleaks gate: open a throwaway PR planting a fake `S…` secret,
  confirm `secret-scan` blocks it, screenshot, close it (D5 acceptance).
- File the SCF Tranche-1 completion report with the on-chain artifacts (4 vault IDs,
  deposit→loop→withdraw tx hashes, token addresses, test reports) and notify SCF of
  the revised completion dates.
