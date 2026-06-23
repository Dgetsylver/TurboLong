# Turbolong Mainnet Launch Runbook

**SCF #43 Tranche 3, deliverable T3.5.** The ordered, end-to-end procedure to take
Turbolong live on mainnet and operate it through the first 14 days. Folds
together the deploy, migration, and listing runbooks and adds monitoring,
rollback, comms, and the post-launch watch.

> Real funds throughout. Small live amounts for verification. Deploy/admin/keeper
> keys via 1Password (`op run` / `op read`) — never inlined. Confirm before any
> destructive or production action.

---

## 0. Pre-launch checklist (gate — all must be true)

- [ ] **Release gate green** — see `docs/testing-programme.md` (80 contract tests,
      parity, lint/build, e2e, audit, gitleaks).
- [ ] Final mainnet WASM built (`cargo build --target wasm32v1-none --release`),
      hash recorded — includes D2 receipt token + D3 admin/upgrade.
- [ ] Mainnet config signed off: per-asset `c_factor` (≤ pool), `target_loops`,
      `min_hf`, `orange_hf`, `reward_threshold` (see `project` notes /
      `mainnet-go-live-runbook.md`).
- [ ] **Keeper** account created + funded; pubkey set. **Admin** account created
      (multisig/hardware preferred); pubkey set.
- [ ] Soroswap mainnet router + Stellar Broker config confirmed.
- [ ] Frontend env: `VITE_ALERTS_WORKER_URL`, `VITE_AQUARIUS_API`, RPC.
- [ ] Alerts Worker deployed; D1 migrations applied to prod D1.
- [ ] DeFindex co-sign outreach in flight; Ledger/mobile sign-offs tracked.

## 1. Deploy the vaults (T1 D1)

Follow **`docs/mainnet-go-live-runbook.md`**:
1. `DRY_RUN=1` deploy to validate args/config.
2. Deploy 4 strategy + 4 share-token contracts; `set_share_token` +
   `set_swap_account` each; persist `deployed-vaults.mainnet.json`.
3. Wire `frontend/src/defindex.ts` `MAINNET_VAULTS` from the deploy output (helper
   `scripts/wire_mainnet_vaults.ts`).
4. Per-asset **deposit → loop → withdraw** with small amounts; capture tx hashes
   on Stellar Expert (b/d-token deltas). Record for the completion report.

## 2. List receipt tokens on Aquarius (T3.2)

Follow **`docs/aquarius-listing-runbook.md`**: create a 0.3% constant-product
pool per receipt token ↔ USDC (300k AQUA fee each), seed liquidity, populate
`frontend/src/aquarius_listings.ts`, then run the **5 verification trades** and
capture hashes. The vault-view "Trade on Aquarius" CTA goes live automatically.

## 3. Ship the frontend

- [ ] `npm run build` (emits `index.html` + `status.html`); deploy `dist/`.
- [ ] Smoke-test on mainnet: connect (each of 5 wallets + Ledger), Compare view
      loads no-wallet, Vault deposit/withdraw, Swap quote (Broker + Aquarius),
      language switch (EN/ES/PT-BR), first-visit onboarding tour.
- [ ] `/status.html` shows all services operational.

## 4. Monitoring & alerts

- **Status page** (`/status.html`): RPC, alerts service, snapshot service,
  Aquarius API. Auto-refreshes every 30s.
- **Alerts service** (T2.5): APY-negative + HF/liquidation channels active;
  rate snapshots accruing (feeds Compare trends + history arrows).
- **Rebalance keeper**: running (Cloudflare/GitHub Action per chosen setup),
  watching HF vs `min_hf`/`orange_hf`; dry-run verified before live.

## 5. Rollback

- **Contract bug:** `upgrade()` to a patched WASM (admin-signed) — storage and
  positions preserved; verify parity within 1e-7 (`docs/migration-runbook.md`).
  Emergency pause via admin if a critical fault is found (issue #45).
- **Frontend bug:** redeploy previous `dist/`. Frontend holds no funds.
- **Listing/liquidity issue:** withdraw seeded liquidity; UI degrades to the
  "listing pending" notice automatically when a listing is removed.

## 6. Comms

- [ ] Announce launch (X / Farcaster — daily APY bot already exists, PR #229).
- [ ] Publish the 4 vault contract IDs + receipt-token addresses + Stellar Expert
      links.
- [ ] Link the status page.

## 7. Post-launch 14-day watch (grant acceptance)

- [ ] Daily: status page all-green, keeper healthy, no HF/liquidation alerts
      unhandled, snapshots accruing.
- [ ] Track TVL, deposits/withdrawals, any rebalance events.
- [ ] Log incidents + resolutions.
- [ ] At 14 days green, compile evidence → `docs/scf-t3-completion-report.md`
      and file the Tranche 3 completion report.
