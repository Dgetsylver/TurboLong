# Design Document: Slippage Protection on Soroswap Harvest

## Overview

The `harvest` function swaps BLND → underlying via Soroswap. Currently `amount_out_min` defaults to `0` when the keeper omits the `data` bytes, leaving the swap unprotected against price manipulation. This feature adds a `slippage_bps: u32` field to `Config`, a `get_amounts_out` pre-query to derive a spot-price minimum, and soft-failure semantics so a slippage-exceeded swap leaves BLND in the contract rather than reverting.

Changes are confined to four files:
- `storage.rs` — add `slippage_bps` to `Config`
- `soroswap.rs` — add `compute_amount_out_min` helper; update `perform_reinvest` call site
- `blend_pool.rs` — update `perform_reinvest` signature to use computed minimum
- `lib.rs` — read `slippage_bps` from `init_args[8]`; add `set_slippage_bps` method
- `test_leverage.rs` — add 7 unit tests

---

## Components and Interfaces

### Config (storage.rs)

```rust
pub struct Config {
    // ... existing fields ...
    /// Maximum acceptable slippage in basis points (1 bp = 0.01%).
    /// Default: 50 (0.50%). Range: 0–10_000.
    pub slippage_bps: u32,
}
```

### compute_amount_out_min (soroswap.rs)

```rust
/// Query Soroswap router for a spot-price quote and apply slippage tolerance.
///
/// Returns `amount_in × (10_000 − slippage_bps) / 10_000` based on the
/// router's `get_amounts_out` quote. Falls back to 0 on query failure.
pub fn compute_amount_out_min(
    e: &Env,
    amount_in: i128,
    path: Vec<Address>,
    config: &Config,
) -> i128
```

### perform_reinvest (blend_pool.rs)

Signature unchanged externally. Internally, the `amount_out_min` parameter is removed from the function signature — the function now computes it internally using `compute_amount_out_min`. The `harvest` call site in `lib.rs` no longer passes `amount_out_min`.

```rust
pub fn perform_reinvest(
    e: &Env,
    config: &Config,
    caller_min: i128,   // from harvest data bytes; 0 if not provided
) -> Result<(i128, i128), StrategyError>
```

### set_slippage_bps (lib.rs)

```rust
pub fn set_slippage_bps(e: Env, bps: u32) -> Result<(), StrategyError>
```

Only the keeper may call this. Returns `Err(StrategyError::InvalidArgument)` if `bps > 10_000`.

---

## Data Models

### BPS_DENOMINATOR

```rust
const BPS_DENOMINATOR: u32 = 10_000;
```

Defined in `soroswap.rs` (or `constants.rs`). Used in `compute_amount_out_min`.

### Slippage computation

```
quoted_out  = router.get_amounts_out(amount_in, path)[last]
computed    = quoted_out × (10_000 − slippage_bps) / 10_000
effective   = max(caller_min, computed)
```

---

## Architecture

### Harvest flow (updated)

```
harvest(e, from, data)
  │
  ├─ keeper.require_auth()
  ├─ claim BLND
  ├─ parse caller_min from data bytes (0 if absent)
  │
  └─ perform_reinvest(e, config, caller_min)
       │
       ├─ check blnd_balance >= reward_threshold
       ├─ compute_amount_out_min(e, blnd_balance, path, config)
       │     ├─ router.get_amounts_out(amount_in, path)  ← NEW
       │     └─ returns quoted × (10_000 − bps) / 10_000
       │
       ├─ effective_min = max(caller_min, computed_min)
       │
       ├─ try internal_swap_exact_tokens_for_tokens(..., effective_min, ...)
       │     ├─ swap succeeds → re-leverage proceeds → Ok((b_delta, d_delta))
       │     └─ swap panics (slippage exceeded) → catch → Ok((0, 0))  ← NEW
       │
       └─ if (0, 0): BLND stays in contract, harvest returns Ok(())
```

### Soft-failure catch

Soroban's `try_invoke_contract` already returns a `Result`. The swap call in `internal_swap_exact_tokens_for_tokens` uses `panic_with_error!` on failure, which propagates as a contract error. In `perform_reinvest`, we wrap the swap call in a pattern that returns `Ok((0, 0))` on any `StrategyError::InternalSwapError`:

```rust
match internal_swap_exact_tokens_for_tokens(...) {
    Ok(amounts) => { /* proceed with re-leverage */ }
    Err(StrategyError::InternalSwapError) => {
        // Slippage exceeded or swap failed — BLND stays in contract
        return Ok((0, 0));
    }
    Err(e) => return Err(e),
}
```

---

## Implementation Details

### get_amounts_out query

Soroswap router exposes `get_amounts_out(amount_in: i128, path: Vec<Address>) -> Vec<i128>`. We call it via `try_invoke_contract` (not `invoke_contract`) so a failure returns `Err` rather than panicking:

```rust
let quoted: Vec<i128> = e
    .try_invoke_contract::<Vec<i128>, InvokeError>(
        &config.router,
        &Symbol::new(e, "get_amounts_out"),
        vec![e, amount_in.into_val(e), path.into_val(e)].into_val(e),
    )
    .unwrap_or_else(|_| Ok(Vec::new(e)))  // fallback: empty vec
    .unwrap_or_else(|_| Vec::new(e));

let quoted_out: i128 = quoted.get(1).unwrap_or(0);
```

If `quoted_out == 0` (query failed or path has no liquidity), `compute_amount_out_min` returns `0` — no protection, but harvest proceeds rather than blocking.

### Constructor init_args layout (updated)

```
[0] pool: Address
[1] blend_token: Address
[2] router: Address
[3] reward_threshold: i128
[4] keeper: Address
[5] c_factor: i128
[6] target_loops: u32
[7] min_hf: i128
[8] slippage_bps: u32   ← NEW (optional, defaults to 50)
```

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| `get_amounts_out` query fails | Falls back to `amount_out_min = 0`; harvest proceeds without slippage protection |
| Swap output below `amount_out_min` | `InternalSwapError` caught in `perform_reinvest`; returns `Ok((0, 0))`; BLND stays in contract |
| `slippage_bps > 10_000` in constructor | `panic_with_error!(e, StrategyError::InvalidArgument)` |
| `set_slippage_bps` called by non-keeper | `keeper.require_auth()` fails with auth error |
| `set_slippage_bps(bps > 10_000)` | Returns `Err(StrategyError::InvalidArgument)` |
| `blnd_balance < reward_threshold` | Early return `Ok((0, 0))` — unchanged behaviour |

## Correctness Properties

Property 1: **BLND preservation on rejection** — When a swap is rejected due to slippage, the BLND token balance of the contract is identical before and after `perform_reinvest`. No tokens are burned or transferred.
**Validates: Requirements 3.3, 3.4**

Property 2: **Harvest non-reversion** — A slippage rejection causes `harvest` to return `Ok(())`, not an error. The keeper's transaction succeeds and can be retried later.
**Validates: Requirements 3.1, 3.2**

Property 3: **Keeper-supplied minimum respected** — When the keeper passes a non-zero `amount_out_min` via `data` bytes, the effective minimum is `max(keeper_min, computed_from_bps)`, never less than either.
**Validates: Requirements 2.5, 4.3**

Property 4: **Default slippage is 50 bps** — A strategy deployed without `init_args[8]` has `slippage_bps = 50`.
**Validates: Requirements 1.4, 4.1**

## Testing Strategy

All tests are pure unit tests in `test_leverage.rs` — no Blend pool mock needed:

1. `test_slippage_bps_default_is_50` — construct `Config` without `slippage_bps`, assert `== 50`
2. `test_compute_amount_out_min_50bps` — call `compute_amount_out_min` with mocked quote `1_000_0000000`, assert result `== 995_0000000`
3. `test_compute_amount_out_min_zero_bps` — `slippage_bps = 0`, assert result `== quoted_out`
4. `test_compute_amount_out_min_100pct_bps` — `slippage_bps = 10_000`, assert result `== 0`
5. `test_slippage_bps_above_10000_rejected` — assert constructor panics with `InvalidArgument`
6. `test_keeper_can_update_slippage_bps` — call `set_slippage_bps(100)` as keeper, assert stored value `== 100`
7. `test_non_keeper_cannot_update_slippage_bps` — call `set_slippage_bps(100)` as non-keeper, assert auth error

## Affected Files

| File | Change |
|---|---|
| `storage.rs` | Add `slippage_bps: u32` to `Config` |
| `soroswap.rs` | Add `compute_amount_out_min`; add `BPS_DENOMINATOR` constant |
| `blend_pool.rs` | Update `perform_reinvest` to call `compute_amount_out_min`; catch swap errors softly |
| `lib.rs` | Read `slippage_bps` from `init_args[8]` with default 50; add `set_slippage_bps` method |
| `test_leverage.rs` | Add 7 unit tests for slippage guard |
