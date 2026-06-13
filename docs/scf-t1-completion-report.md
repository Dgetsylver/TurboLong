# SCF #43 — Tranche 1 Completion Report (DRAFT)

> **Status: draft.** Code/prep deliverables are complete and verifiable on
> `main`. Items marked ⛔ are **mainnet-gated** or **external** and will be
> filled at launch. **T1's stated completion date (08 Jun 2026) has passed** —
> this report doubles as the proactive notice of revised dates (see bottom).
> Do not file as *complete* until the ⛔ rows have captured evidence; file now
> as a **status update + revised-date notice**.

**Project:** Turbolong — leveraged-long protocol on Stellar/Blend.
**Track:** Integration ($100k XLM). **Tranche 1 = $20,000 (20%).**
**Original due:** 08 Jun 2026. **Report date:** _TBD at filing._

---

## Deliverables

| # | Deliverable ($) | Status | Evidence |
|---|-----------------|--------|----------|
| D1 | 4-asset mainnet vault deployment ($7k) | ⛔ Prepped, not deployed | Deploy script `scripts/deploy_strategy_mainnet.ts` (4 strategy + 4 `vault_share`, `set_share_token` + `set_swap_account`, writes `deployed-vaults.mainnet.json`) — PR #271. Frontend wiring + `MAINNET_VAULTS` — PR #272. `docs/mainnet-go-live-runbook.md`. Config sourced (Soroswap router, live pool c_factors). ⛔ Deploy + per-asset deposit→loop→withdraw verification + DeFindex co-sign pending. |
| D2 | Full SEP-41 receipt token ($4k) | ✅ Done | Separate `vault_share` SEP-41 contract (resolves the trait-`balance` vs SEP-41-`balance` collision). `transfer`/`approve`/`allowance`/`transfer_from`, `total_supply == Σ balances`. **15 unit tests** (`contracts/tokens/vault_share/src/test.rs`). Mainnet address captured at D1 deploy. |
| D3 | In-place WASM upgrade + admin ($2k) | ✅ Done | `upgrade()` + admin role + `version()`; storage/positions preserved. Upgrade-parity tests assert Config, every `VaultPos`, `total_shares`, recomputed HF identical **within 1e-7** pre/post (`test_integration.rs`, **13 tests**). Runbook: `docs/migration-runbook.md`. |
| D4 | Wallets Kit mobile + Ledger + E2E ($5k) | ✅ Code done / ⛔ device sign-off | Ledger module + WalletConnect mobile deep-link + Playwright e2e (5 wallets × {classic, Soroban}, mock seam) — PR #259. ⛔ Physical Ledger run + iOS/Android device runs (Lobstr/xBull) + wallet-team sign-off pending (external). |
| D5 | CI / supply-chain hygiene ($2k) | ✅ Done | `dependabot.yml`, `cargo-audit.yml`, Clippy `-D warnings` + `cargo fmt --check` (`contracts.yml`), Biome + build + e2e (`frontend-ci.yml`), `secret-scan.yml` (gitleaks) + `.gitleaks.toml` + pre-commit. Dependabot actively opening PRs. ⛔ gitleaks planted-secret block screenshot (evidence demo) — in progress. |

## Verifiable now (on `main`)

- **Contracts:** 71 tests green (43 `test_leverage.rs`, 13 `test_integration.rs`
  incl. upgrade-parity 1e-7, 15 `vault_share/test.rs`); clippy `-D warnings` +
  `cargo fmt --check` enforced; wasm builds.
- **Rate parity:** TS `projectRates` ↔ Rust `rate_calc` over ≥20 IR-kink
  fixtures (`parity.yml`).
- **Frontend/Worker:** Biome + Vite build + Playwright e2e (`frontend-ci.yml`).
- **Supply-chain:** Dependabot PRs landing weekly; `cargo audit`; gitleaks gate
  on every PR; main CI fully green.
- **Receipt-token correctness:** unit-tested transfer/approve/allowance semantics.
- **Upgrade safety:** parity within 1e-7 + documented migration runbook.

## Mainnet-gated / external (fill at launch) ⛔

- [ ] 4 mainnet vault contract IDs + receipt-token addresses.
- [ ] Per-asset deposit → loop → withdraw tx hashes (Stellar Expert).
- [ ] DeFindex co-sign of the 4 deployments.
- [ ] Ledger hardware run + iOS/Android deep-link runs + wallet-team sign-off.
- [ ] gitleaks planted-secret block screenshot.

## Revised dates / notice to SCF

- **D2, D3, D5** — complete and verifiable on `main` now.
- **D1** — code/prep complete; deploy is gated on operational sign-offs (keeper +
  admin keys, per-asset config, go-ahead) and DeFindex co-sign. **Revised target:
  _set at filing_** (align with the T3 mainnet launch window, due 15 Sep 2026).
- **D4** — code complete; device/hardware sign-offs are external. **Revised
  target: _set at filing_**, tracked in parallel.

## Links

- Mainnet deploy: `docs/mainnet-go-live-runbook.md` · Migration: `docs/migration-runbook.md`
- Launch runbook: `docs/launch-runbook.md` · Testing programme: `docs/testing-programme.md`
- PRs: #271 (D1 deploy script), #272 (D1 wiring), #259 (D4 wallets)
