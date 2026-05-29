# Requirements Document

## Introduction

The `harvest` function in the `BlendLeverageStrategy` contract claims BLND emissions and swaps them to the underlying asset via Soroswap. Currently the swap is called with `amount_out_min = 0` when no `data` bytes are provided, meaning the contract will accept any output amount — including a near-zero amount from a manipulated pool. This feature adds a configurable slippage guard stored in the strategy `Config` so that swaps are rejected when the output falls below a minimum derived from the stored basis-points tolerance. A rejected swap leaves BLND in the contract and does not revert the harvest transaction.

## Glossary

- **Slippage_BPS**: The maximum acceptable slippage expressed in basis points (1 bp = 0.01%). Stored in `Config` as `slippage_bps: u32`. Default value: 50 (0.50%).
- **Amount_Out_Min**: The minimum acceptable output token amount for a swap, computed as `amount_in × (10_000 − slippage_bps) / 10_000` using an oracle or spot-price estimate. In this contract, the spot price is approximated from the Soroswap router's `get_amounts_out` query.
- **Slippage_Guard**: The logic in `soroswap.rs` that computes `amount_out_min` from `slippage_bps` and rejects the swap (returning `Ok((0, 0))`) when the quoted output is below that minimum.
- **Harvest**: The `harvest` entry point in `lib.rs` that claims BLND, swaps to underlying, and re-leverages. A slippage-rejected swap is a soft failure — BLND stays in the contract and the harvest returns `Ok(())`.
- **Keeper**: The authorized address that calls `harvest`.
- **BPS_DENOMINATOR**: The constant `10_000u32` used to convert basis points to a fraction.

---

## Requirements

### Requirement 1: Store slippage_bps in Config

**User Story:** As a keeper, I want the slippage tolerance to be stored on-chain in the strategy config so that it is auditable and consistent across all harvest calls.

#### Acceptance Criteria

1. THE `Config` struct in `storage.rs` SHALL include a `slippage_bps: u32` field.
2. THE `__constructor` in `lib.rs` SHALL read `slippage_bps` from `init_args[8]` as a `u32`.
3. IF `slippage_bps` is greater than `10_000`, THEN `__constructor` SHALL panic with `StrategyError::InvalidArgument`.
4. WHEN `slippage_bps` is not provided in `init_args`, THE constructor SHALL use a default value of `50` (0.50%).
5. THE keeper SHALL be able to update `slippage_bps` by calling a new `set_slippage_bps(e: Env, bps: u32)` method on the contract; only the keeper may call this method.
6. WHEN `set_slippage_bps` is called with a value greater than `10_000`, THE method SHALL return `Err(StrategyError::InvalidArgument)` without modifying storage.

---

### Requirement 2: Compute amount_out_min from slippage_bps

**User Story:** As a keeper, I want the contract to automatically compute the minimum acceptable swap output from the stored slippage tolerance, so that I do not need to pass it manually on every harvest call.

#### Acceptance Criteria

1. WHEN `perform_reinvest` is called, THE Slippage_Guard SHALL query the Soroswap router's `get_amounts_out` function with `amount_in = blnd_balance` and `path = [blend_token, asset]` to obtain a spot-price quote for the expected output.
2. WHEN the `get_amounts_out` query succeeds, THE Slippage_Guard SHALL compute `amount_out_min = quoted_out × (10_000 − slippage_bps) / 10_000`.
3. WHEN the `get_amounts_out` query fails or returns an empty result, THE Slippage_Guard SHALL fall back to `amount_out_min = 0` (no slippage protection) and log a warning, rather than reverting the harvest.
4. THE computed `amount_out_min` SHALL be passed as the `amount_out_min` argument to `internal_swap_exact_tokens_for_tokens`, replacing the current caller-supplied value.
5. IF the caller supplies a non-zero `amount_out_min` via the `data` bytes in `harvest`, THEN THE contract SHALL use `max(caller_supplied, computed_from_bps)` as the effective minimum, allowing the keeper to enforce a stricter bound.

---

### Requirement 3: Reject swap without reverting harvest

**User Story:** As a vault depositor, I want a slippage-exceeded swap to leave BLND in the contract rather than reverting the entire harvest, so that BLND accumulates and can be swapped in a later harvest when conditions improve.

#### Acceptance Criteria

1. WHEN `internal_swap_exact_tokens_for_tokens` returns an error indicating the swap output is below `amount_out_min` (i.e., the Soroswap router panics or returns an error), THE `perform_reinvest` function SHALL catch the error and return `Ok((0, 0))` instead of propagating it.
2. WHEN `perform_reinvest` returns `Ok((0, 0))` due to a slippage rejection, THE `harvest` function in `lib.rs` SHALL return `Ok(())` without updating reserves or emitting a harvest event.
3. WHEN a slippage rejection occurs, THE BLND balance in the contract SHALL remain unchanged (BLND is not burned or transferred out).
4. WHEN a slippage rejection occurs, THE strategy's `total_b_tokens` and `total_d_tokens` in storage SHALL remain unchanged.

---

### Requirement 4: Unit tests for slippage guard

**User Story:** As a developer, I want unit tests that verify the slippage guard accepts aligned swaps and rejects slipped ones, so that regressions are caught automatically.

#### Acceptance Criteria

1. A test `test_slippage_bps_default_is_50` SHALL verify that a `Config` constructed without an explicit `slippage_bps` has `slippage_bps == 50`.
2. A test `test_compute_amount_out_min_50bps` SHALL verify that for a quoted output of `1_000_0000000` and `slippage_bps = 50`, `amount_out_min = 995_0000000` (i.e., `1000 × 9950 / 10000`).
3. A test `test_compute_amount_out_min_zero_bps` SHALL verify that for `slippage_bps = 0`, `amount_out_min = quoted_out` (no slippage allowed).
4. A test `test_compute_amount_out_min_100pct_bps` SHALL verify that for `slippage_bps = 10_000`, `amount_out_min = 0` (any output accepted).
5. A test `test_slippage_bps_above_10000_rejected` SHALL verify that constructing a `Config` with `slippage_bps > 10_000` panics or returns an error.
6. A test `test_keeper_can_update_slippage_bps` SHALL verify that `set_slippage_bps` updates the stored value when called by the keeper.
7. A test `test_non_keeper_cannot_update_slippage_bps` SHALL verify that `set_slippage_bps` fails when called by a non-keeper address.
