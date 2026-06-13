# Strategy Upgrade & Migration Runbook

How to ship a new version of `blend_leverage` without forcing users to exit and
re-enter their leveraged positions. Covers the **in-place WASM upgrade** path
(SCF #43 Tranche 1, Deliverable 3).

## Model

The strategy upgrades **in place** via `update_current_contract_wasm`. The
contract keeps the same address and all persistent storage — `Config`,
`Reserves` (`total_shares`, `total_b_tokens`, `total_d_tokens`, rates), every
per-user `VaultPos`, `Keeper`, and `Admin` — across the upgrade. Because the
storage is byte-identical before and after, each user's health factor and
underlying balance are unchanged: there is no exit/re-enter and no per-user
signing.

Authorization: `upgrade(new_wasm_hash)` requires `admin.require_auth()`. The
admin is set at construction (`init_args[9]`). A `version()` counter starts at
1 and is bumped on every upgrade for observability.

> Use this path when v2's storage layout is compatible with v1 (the common
> case: new entrypoints, bug fixes, added optional fields read with
> `unwrap_or`). A storage-layout-breaking change is out of scope for T1 and
> would instead require a data-migration entrypoint.

## Pre-flight

1. Land and review the v2 code; `cargo test`, `cargo clippy --all-targets -- -D
   warnings`, and `cargo fmt --check` all green (enforced by `contracts.yml`).
2. Build the release WASM:
   ```
   cd contracts/strategies/blend_leverage
   cargo build --target wasm32v1-none --release
   ```
3. Confirm the admin key is available in the signer (1Password / hardware) and
   matches `admin()` on the live contract.

## Upgrade procedure (per deployed vault)

1. **Snapshot** the live state for the parity check below:
   ```
   stellar contract invoke --id <STRATEGY> -- position           # equity, total_shares, b/d tokens, rates
   stellar contract invoke --id <STRATEGY> -- health_factor
   stellar contract invoke --id <STRATEGY> -- version             # expect N
   # plus balance() for a sample of known depositors
   ```
2. **Install** the v2 WASM and capture its hash:
   ```
   stellar contract install --wasm target/wasm32v1-none/release/blend_leverage_strategy.wasm
   # -> <V2_WASM_HASH>
   ```
3. **Upgrade** (admin-signed):
   ```
   stellar contract invoke --id <STRATEGY> --source-account <ADMIN> \
     -- upgrade --new_wasm_hash <V2_WASM_HASH>
   ```
4. **Verify parity** — re-read the same calls as step 1 and assert:
   - `version()` == N + 1
   - `position()` and `health_factor()` identical to the snapshot
   - each sampled `balance(depositor)` identical within **1e-7** (expected:
     exactly equal — storage is untouched)

   The same invariant is asserted in unit tests
   (`test_upgrade_preserves_hf_and_balance_parity` in `src/test_leverage.rs`):
   the same stored reserves yield byte-identical equity, HF, and per-share
   underlying. The on-chain step above is the live-pool-state confirmation.

## Testnet rehearsal (do this before any mainnet upgrade)

1. Deploy v1 to testnet (`scripts/deploy_strategy.ts`).
2. Seed a real leveraged position: `deposit` from a funded test account; record
   `position()` / `health_factor()` / `balance(user)`.
3. Build v2, install, `upgrade()`.
4. Re-read and assert parity within 1e-7 (above). Confirm a `deposit` and
   `withdraw` still succeed post-upgrade.

## Rollback

`update_current_contract_wasm` is itself reversible: re-`upgrade()` to the
previous WASM hash (keep the prior `<V1_WASM_HASH>` recorded). Storage is
unaffected, so rolling the code back also restores prior behavior. If v2
introduced a storage write that v1 cannot read, do **not** roll back code
without a compensating data fix — validate this in the testnet rehearsal first.

## Admin key hygiene

The admin can replace the contract code, so treat it like a protocol key:
hold it in a hardware signer or multisig, never in source or CI. Rotating the
admin is not yet an entrypoint; if needed, add a `set_admin(new)` guarded by the
current admin in a future version (and ship it via this same upgrade flow).
