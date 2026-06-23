# Turbolong Testing Programme

**SCF #43 Tranche 3, deliverable T3.4.** A structured, layered QA programme for a
leveraged DeFi protocol handling real funds. It documents every test layer, what
each covers, how to run it, which CI gate enforces it, the known coverage gaps,
and the release gate that must be green before any mainnet change.

Turbolong's risk surface is leverage-loop math, health-factor accounting, and
fund-custody contract entrypoints. The programme is weighted accordingly: the
deepest coverage is on the on-chain math and the TS↔Rust parity that the UI
relies on to quote positions.

---

## Test pyramid

```
                ┌─ Mainnet verification (manual, small live amounts) ─┐   Layer 6
              ┌─ E2E wallet flows (Playwright, mock seam) ─┐               Layer 4
            ┌─ Frontend lint + build (Biome, Vite) ─┐                      Layer 3
          ┌─ Rate-model parity (TS ↔ Rust, ≥20 fixtures) ─┐                Layer 2
        ┌─ Contract unit + integration (Rust, 80 tests) ───────┐          Layer 1
        └────────── Supply-chain / secret scanning (always-on) ─┘          Layer 0
```

---

## Layer 0 — Supply-chain & secrets (always-on)

| What | Tool | CI gate |
|------|------|---------|
| Secret scanning on every PR + pre-commit | gitleaks + `.gitleaks.toml` | `secret-scan.yml` |
| Rust dependency advisories | `cargo audit` | `cargo-audit.yml` |
| Dependency freshness | Dependabot (npm × `frontend/`+`alerts/`, cargo, actions) | weekly PRs |

**Run locally:** `pre-commit run --all-files`; `cargo audit`.

## Layer 1 — Contract unit & integration (Rust) — *primary*

The fund-holding logic. **80 tests** across:

| Crate / file | Tests | Covers |
|--------------|-------|--------|
| `contracts/strategies/blend_leverage/src/test_leverage.rs` | 43 | leverage-loop open/close, health-factor math, partial unwind, `orange_hf` band, rebalance keeper, BLND harvest split (`harvest_claim` / `harvest_reinvest`), interest-rate kink, utilization-cap panics (e.g. `#[should_panic("Error(Contract, #422)")]` at >95% util); **version counter** (`test_version_defaults_to_one_then_bumps`) and **upgrade-parity on a seeded fixture** (`test_upgrade_preserves_hf_and_balance_parity`) — equity/HF/per-share underlying identical **within 1e-7** |
| `contracts/strategies/blend_leverage/src/test_integration.rs` | 22 | integration against a real Blend pool (`BlendFixture`): supply/borrow, leverage-loop build, full deposit→withdraw cycle, two-user proportionality, deleverage/partial-unwind, rebalance round-trip, harvest, real `deposit`/`withdraw` entrypoints keep reserves in sync, share-token wiring + `migrate_position`, transferred-share withdraw; **live pool-state `upgrade()` parity** (`test_upgrade_preserves_hf_and_balance_on_live_pool_state`) — real deposit + drifted rates, the real `upgrade()` entrypoint (admin-gated, version bump), equity/HF/per-user balance identical **within 1e-7** pre/post |
| `contracts/tokens/vault_share/src/test.rs` | 15 | SEP-41 receipt token: `transfer` moves shares + proportional claim (no pool interaction), insufficient-balance/non-positive guards, `approve`/`allowance`/`transfer_from` happy + expiry + over-allowance, `total_supply == Σ balances` |

**Run:** `cd contracts/strategies/blend_leverage && cargo test`;
`cd contracts/tokens/vault_share && cargo test`.
**Gate:** `contracts.yml` runs `cargo test` + `cargo build --target wasm32v1-none --release`; clippy `-D warnings` + `cargo fmt --check` enforced.

## Layer 2 — Rate-model parity (TS ↔ Rust) — *primary*

The UI computes net APY / projected rates in TypeScript (`projectRates`); the
contract uses the same math in Rust. **Drift here misquotes leverage to users**,
so a parity harness pins them together.

- `frontend/test/parity.test.ts` feeds `tests/fixtures/rates.json`
  (**≥ 20 IR-kink fixtures**, asserted) through the Rust `rate_calc` binary via
  stdin and compares to TS `projectRates` for every fixture.
- **Run:** `cargo build --bin rate_calc && cd frontend && npm run test`.
- **Gate:** `parity.yml` (builds `rate_calc`, runs the suite on every PR).

## Layer 3 — Frontend lint & build

- Biome lint (`npm run lint` / `lint:ci`) + Vite production build.
- **Gate:** `frontend-ci.yml` — lint + build for `frontend/`, plus a wrangler
  dry-run build for the `alerts/` Worker.

## Layer 4 — E2E wallet flows (Playwright)

`frontend/e2e/tests/wallets.spec.ts` against a deterministic **mock-wallet seam**
(the E2E harness installs a fake signer so CI needs no real wallet/extension):

1. Boots under the E2E harness and installs the mock seam.
2. Registers all five wallets **plus Ledger** (Freighter, xBull, Albedo, Lobstr,
   Hana, Ledger).
3. Exposes a submitted-tx ledger so `sign → submit` can be asserted on both
   classic and Soroban operations.

- **Run:** `cd frontend && npm run test:e2e`.
- **Gate:** `frontend-ci.yml` e2e job (installs Chromium, runs the mock-harness
  suite). The parity vitest run excludes `e2e/**` so the two never collide.

## Layer 5 — Worker (alerts service)

- `alerts/` (Cloudflare Worker + D1): typecheck + `wrangler` dry-run build;
  schema migrations (`0001_*`, `0002_*`) applied to a local D1 before deploy.
- **Run:** `cd alerts && npm run build`; `wrangler d1 migrations apply --local`.

## Layer 6 — Mainnet verification (manual, small live amounts)

Executed at/after deploy; evidence captured for the SCF completion report.

- **Per-asset deposit → loop → withdraw** on each of the 4 mainnet vaults; tx
  hashes confirmed on Stellar Expert (b/d-token deltas). See
  `docs/mainnet-go-live-runbook.md`.
- **Upgrade parity on mainnet:** snapshot → install v2 WASM → `upgrade()` →
  re-verify Config/positions/HF. See `docs/migration-runbook.md`.
- **Aquarius receipt-token listing + 5 verification trades.** See
  `docs/aquarius-listing-runbook.md`.
- **Broker swap session** end-to-end through the keeper harvest path.

---

## Known coverage gaps & planned work

- **Property / invariant tests** for leverage math (issue #50, PR #235) — pending
  merge; will add randomized invariants (HF monotonicity, shares↔underlying
  round-trip, no value creation on open/close) on top of the example-based suite.
- **Reentrancy regression** (#56, closed) — keep the regression cases green.
- **Frontend unit coverage** beyond parity is thin; leverage/vault flow logic is
  covered indirectly via E2E. Candidate for targeted vitest units.
- **Fuzzing** the rate model across the full fixed-point domain (beyond the 20
  curated kink fixtures).
- No silent caps: any sampling/top-N in future test tooling must log what it
  skipped.

## Release gate — must be green before any mainnet change

- [ ] `cargo test` (all 80 contract tests) green.
- [ ] `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check` clean.
- [ ] `cargo build --target wasm32v1-none --release` produces the final WASM.
- [ ] Parity suite green (`rate_calc` ↔ `projectRates`, ≥20 fixtures).
- [ ] `npm run lint` + `npm run build` clean (frontend + alerts).
- [ ] Playwright e2e green for 5 wallets + Ledger × {classic, Soroban}.
- [ ] `cargo audit` passing; gitleaks blocks a planted secret.
- [ ] For contract changes: upgrade-parity fixture test passes within 1e-7.
- [ ] For mainnet deploys: Layer 6 checklist completed with captured tx hashes.

## Test data & fixtures

- Rate-model fixtures: `tests/fixtures/rates.json` (IR-kink scenarios for parity).
- Upgrade-parity fixtures: a seeded reserves fixture in `test_leverage.rs`
  (`test_upgrade_preserves_hf_and_balance_parity`) and a live `BlendFixture`
  pool-state fixture in `test_integration.rs`
  (`test_upgrade_preserves_hf_and_balance_on_live_pool_state`).

## Cadence & ownership

- **Every PR:** Layers 0–4 run in CI (`secret-scan`, `contracts`, `cargo-audit`,
  `parity`, `frontend-ci`).
- **Pre-release:** full release-gate checklist (above), core team owns Layer 6.
- **Weekly:** Dependabot PRs reviewed and merged; `cargo audit` re-run.
- Contributor-safe layers: parity fixtures, E2E cases, frontend units. Core-only:
  contract math/custody tests, mainnet verification.
