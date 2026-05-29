# Implementation Plan: Slippage Protection on Soroswap Harvest

## Overview

Add a `slippage_bps: u32` field to `Config`, a `compute_amount_out_min` helper in `soroswap.rs` that queries the Soroswap router for a spot-price quote, soft-failure semantics in `perform_reinvest` so a slippage-exceeded swap leaves BLND in the contract, and 7 unit tests.

## Tasks

- [ ] 1. Add slippage_bps to Config in storage.rs
  - Add `pub slippage_bps: u32` field to the `Config` struct in `contracts/strategies/blend_leverage/src/storage.rs`
  - Place it as the last field to avoid breaking existing field ordering

- [ ] 2. Add BPS_DENOMINATOR constant and compute_amount_out_min to soroswap.rs
  - Add `const BPS_DENOMINATOR: u32 = 10_000;` near the top of `contracts/strategies/blend_leverage/src/soroswap.rs`
  - Add `pub fn compute_amount_out_min(e: &Env, amount_in: i128, path: Vec<Address>, config: &Config) -> i128`
  - Inside the function, call `e.try_invoke_contract::<Vec<i128>, InvokeError>(&config.router, &Symbol::new(e, "get_amounts_out"), vec![e, amount_in.into_val(e), path.into_val(e)].into_val(e))` wrapped in `unwrap_or_else` to return an empty `Vec` on failure
  - Extract `quoted_out = result.get(1).unwrap_or(0)`; if `quoted_out == 0` return `0`
  - Compute and return `quoted_out * (BPS_DENOMINATOR - config.slippage_bps) as i128 / BPS_DENOMINATOR as i128`

- [ ] 3. Update perform_reinvest in blend_pool.rs
  - Remove the `amount_out_min: i128` parameter from `perform_reinvest`'s signature; replace with `caller_min: i128`
  - After checking `blnd_balance >= config.reward_threshold`, call `compute_amount_out_min(e, blnd_balance, swap_path.clone(), config)` to get `computed_min`
  - Set `effective_min = computed_min.max(caller_min)`
  - Change the `internal_swap_exact_tokens_for_tokens` call to use `effective_min`
  - Wrap the swap call result in a `match`: on `Err(StrategyError::InternalSwapError)` return `Ok((0, 0))`; on other errors propagate; on `Ok` proceed with re-leverage as before
  - Update the import in `blend_pool.rs` to include `compute_amount_out_min` from `crate::soroswap`

- [ ] 4. Update harvest in lib.rs and add set_slippage_bps
  - In `__constructor`, read `init_args.get(8)` as `u32` with a fallback default of `50u32` when the index is absent
  - Validate: if `slippage_bps > 10_000` call `panic_with_error!(e, StrategyError::InvalidArgument)`
  - Add `slippage_bps` to the `Config { ... }` construction in `__constructor`
  - In `harvest`, update the `perform_reinvest` call to remove the `amount_out_min` argument (it is now computed internally); pass `caller_min` instead
  - Add `pub fn set_slippage_bps(e: Env, bps: u32) -> Result<(), StrategyError>` to the second `#[contractimpl]` block
  - Inside `set_slippage_bps`: call `extend_instance_ttl(&e)`; call `storage::get_keeper(&e).require_auth()`; if `bps > 10_000` return `Err(StrategyError::InvalidArgument)`; load config, set `config.slippage_bps = bps`, call `storage::set_config(&e, config)`; return `Ok(())`

- [ ] 5. Add unit tests to test_leverage.rs
  - Add `test_slippage_bps_default_is_50`: construct a `Config` with all required fields and `slippage_bps = 50`; assert `config.slippage_bps == 50`
  - Add `test_compute_amount_out_min_50bps`: in a `with_contract` closure, mock `get_amounts_out` to return `vec![e, 0i128, 1_000_0000000i128]`; call `compute_amount_out_min` with `slippage_bps = 50`; assert result `== 995_0000000`
  - Add `test_compute_amount_out_min_zero_bps`: same setup with `slippage_bps = 0`; assert result `== 1_000_0000000`
  - Add `test_compute_amount_out_min_100pct_bps`: `slippage_bps = 10_000`; assert result `== 0`
  - Add `test_slippage_bps_above_10000_rejected`: use `#[should_panic]`; construct a `Config` with `slippage_bps = 10_001` and call the validation logic (or call `__constructor` with `init_args[8] = 10_001u32`)
  - Add `test_keeper_can_update_slippage_bps`: register the strategy contract, set keeper in storage, call `set_slippage_bps(100)` as keeper, reload config, assert `slippage_bps == 100`
  - Add `test_non_keeper_cannot_update_slippage_bps`: same setup but call `set_slippage_bps` as a different address; assert the call fails with an auth error

- [ ] 6. Build and verify
  - Run `cargo build --target wasm32-unknown-unknown --release` in `contracts/strategies/blend_leverage/` and fix any compile errors
  - Run `cargo test` in `contracts/strategies/blend_leverage/` and confirm all 7 new tests pass alongside existing tests

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1, 2] },
    { "wave": 2, "tasks": [3, 4] },
    { "wave": 3, "tasks": [5] },
    { "wave": 4, "tasks": [6] }
  ],
  "dependencies": {
    "3": [1, 2],
    "4": [1, 3],
    "5": [1, 2, 3, 4],
    "6": [5]
  }
}
```

Tasks 1 and 2 are independent. Task 3 depends on both (needs `Config.slippage_bps` and `compute_amount_out_min`). Task 4 depends on 1 and 3. Tests (5) depend on everything. Build (6) validates all.

## Notes

- `get_amounts_out` on Soroswap returns `Vec<i128>` where index 0 is `amount_in` and index 1 is `amount_out`. Use `.get(1).unwrap_or(0)`.
- The soft-failure catch only handles `StrategyError::InternalSwapError` — other errors (e.g. auth failures) still propagate.
- `init_args.get(8)` returns `Option<Val>`. Use `.map(|v| v.into_val(&e)).unwrap_or(50u32)` for the default.
- Existing callers of `perform_reinvest` in `blend_pool.rs` pass `amount_out_min` from `harvest`. After this change, `harvest` passes `caller_min` (parsed from `data` bytes, 0 if absent) and `perform_reinvest` computes the rest internally.
- The `compute_amount_out_min` tests need a mock router contract that implements `get_amounts_out`. Use the same `with_contract` pattern from `test_leverage.rs` and register a minimal mock contract.
