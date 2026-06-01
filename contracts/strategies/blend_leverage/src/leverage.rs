use crate::constants::{MAX_LOOPS, MAX_SAFE_UTILIZATION, SCALAR_12, SCALAR_7};
use crate::storage::{Config, LeverageReserves};
use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{panic_with_error, Env};

// ── Leverage loop computation ────────────────────────────────────────────────
//
// Produces n+1 pairs: n (supply, borrow) pairs + 1 final supply-only.
// Identical to execute_loop.rs:168 `compute_requests()`.
//
// Loop 0:   supply initial,        borrow initial × c
// Loop 1:   supply initial × c,    borrow initial × c²
// …
// Loop n-1: supply initial × c^(n-1), borrow initial × c^n
// Final:    supply initial × c^n      (no borrow)

/// Compute supply and borrow amount for a single loop step.
/// Call repeatedly with updated `balance` to build the full loop.
///
/// For step i < n_loops: supply = balance, borrow = balance * c_factor / SCALAR_7
/// For the final step (i == n_loops): supply = balance, borrow = 0
///
/// Returns (supply, borrow) for this step.
#[inline]
pub fn compute_step(balance: i128, c_factor: i128, is_final: bool) -> (i128, i128) {
    if is_final {
        (balance, 0)
    } else {
        let borrow = balance.checked_mul(c_factor).unwrap_or(0) / SCALAR_7;
        (balance, borrow)
    }
}

/// Total number of steps in a leverage loop (n_loops supply+borrow pairs + 1 final supply).
///
/// Hard-capped at `MAX_LOOPS` (20) loops for three reasons:
///
/// 1. **Soroban instruction budget** – each loop step issues two pool host-function calls
///    (supply-collateral + borrow). Soroban's per-transaction CPU-instruction and
///    host-function-call limits are finite; unconstrained loops would cause the
///    transaction to abort with a resource-exhaustion error beyond ~20 iterations.
///
/// 2. **Diminishing returns** – with c = 0.95 the marginal supply added at loop 20 is
///    initial × 0.95^20 ≈ 0.36 × initial, less than 4% of the total leveraged
///    position. Every additional loop yields strictly less; 20 is the practical plateau
///    where the additional leverage gain no longer justifies the extra on-chain cost.
///
/// 3. **Safety ceiling vs. operator knob** – the per-deployment `target_loops` in
///    `Config` is the tunable parameter (validated at init, must be ≤ `MAX_LOOPS`).
///    This constant is a hard ceiling that prevents misconfigured `target_loops` values
///    from issuing unbounded on-chain requests even if validation is bypassed.
///
/// See also `README.md` § "Loop cap rationale".
#[inline]
pub fn loop_step_count(n_loops: u32) -> u32 {
    (n_loops + 1).min(MAX_LOOPS + 1)
}

/// Compute supply and borrow amounts for each loop iteration.
/// Returns arrays of (supply, borrow) amounts. Last borrow is 0.
///
/// Note: Only used in tests. Production code uses `compute_step` iteratively
/// to avoid large stack arrays that generate bulk memory ops in WASM.
#[cfg(test)]
pub fn compute_loop_pairs(
    initial_amount: i128,
    c_factor: i128,
    n_loops: u32,
) -> ([i128; 21], [i128; 21], u32) {
    let mut supplies = [0i128; 21];
    let mut borrows = [0i128; 21];
    let count = loop_step_count(n_loops);

    let mut balance = initial_amount;
    for i in 0..count as usize {
        let is_final = i as u32 == n_loops.min(20);
        let (s, b) = compute_step(balance, c_factor, is_final);
        supplies[i] = s;
        borrows[i] = b;
        balance = b;
    }

    (supplies, borrows, count)
}

/// Compute total supply and total borrow from the loop.
pub fn compute_totals(
    initial_amount: i128,
    c_factor: i128,
    n_loops: u32,
) -> (i128, i128) {
    let count = loop_step_count(n_loops);
    let mut total_supply = 0i128;
    let mut total_borrow = 0i128;
    let mut balance = initial_amount;

    for i in 0..count {
        let is_final = i == n_loops.min(20);
        let (s, b) = compute_step(balance, c_factor, is_final);
        total_supply = total_supply.checked_add(s).unwrap_or(total_supply);
        total_borrow = total_borrow.checked_add(b).unwrap_or(total_borrow);
        balance = b;
    }
    (total_supply, total_borrow)
}

// ── Equity calculation ───────────────────────────────────────────────────────

/// Calculate the net equity of the strategy position.
/// equity = (b_tokens × b_rate / SCALAR_12) - (d_tokens × d_rate / SCALAR_12)
pub fn compute_equity(reserves: &LeverageReserves) -> Result<i128, StrategyError> {
    let supply_value = reserves
        .total_b_tokens
        .fixed_mul_floor(reserves.b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    let debt_value = reserves
        .total_d_tokens
        .fixed_mul_floor(reserves.d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    supply_value
        .checked_sub(debt_value)
        .ok_or(StrategyError::UnderflowOverflow)
}

/// Convert shares to underlying equity amount.
pub fn shares_to_underlying(
    shares: i128,
    reserves: &LeverageReserves,
) -> Result<i128, StrategyError> {
    if reserves.total_shares == 0 {
        return Ok(0);
    }
    let total_equity = compute_equity(reserves)?;
    if total_equity <= 0 {
        return Ok(0);
    }
    shares
        .fixed_mul_floor(total_equity, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)
}

/// Convert underlying amount to shares.
pub fn underlying_to_shares(
    amount: i128,
    reserves: &LeverageReserves,
) -> Result<i128, StrategyError> {
    if reserves.total_shares == 0 || reserves.total_b_tokens == 0 {
        // First deposit: 1 share = 1 unit
        return Ok(amount);
    }
    let total_equity = compute_equity(reserves)?;
    if total_equity <= 0 {
        return Ok(amount);
    }
    amount
        .fixed_mul_floor(reserves.total_shares, total_equity)
        .ok_or(StrategyError::ArithmeticError)
}

// ── Health factor ────────────────────────────────────────────────────────────

/// Calculate health factor for given b/d tokens.
/// HF = (b_tokens × b_rate × c_factor) / (d_tokens × d_rate × SCALAR_7)
/// Returns HF in 1e7 scale (1_000_000_0 = 1.0)
pub fn compute_health_factor(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
) -> Result<i128, StrategyError> {
    if d_tokens == 0 {
        return Ok(i128::MAX); // No debt = infinite HF
    }

    let supply_value = b_tokens
        .fixed_mul_floor(b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    let weighted_supply = supply_value
        .checked_mul(c_factor)
        .ok_or(StrategyError::ArithmeticError)?;

    let debt_value = d_tokens
        .fixed_mul_floor(d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    // HF = weighted_supply / (debt_value * SCALAR_7)
    // But we want result in 1e7 scale, so:
    // HF_scaled = weighted_supply / debt_value  (already has c_factor's 1e7 factor)
    if debt_value == 0 {
        return Ok(i128::MAX);
    }

    weighted_supply
        .checked_div(debt_value)
        .ok_or(StrategyError::DivisionByZero)
}

// ── Safety checks ────────────────────────────────────────────────────────────

/// Check safety conditions before depositing.
/// - Pool utilization must be below MAX_SAFE_UTILIZATION
/// - Projected utilization after the loop must be below MAX_SAFE_UTILIZATION
/// - Post-loop HF must be above min_hf
pub fn check_deposit_safety(
    e: &Env,
    pool_supply_underlying: i128,
    pool_borrow_underlying: i128,
    additional_supply: i128,
    additional_borrow: i128,
    post_b_tokens: i128,
    post_d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    config: &Config,
) -> Result<(), StrategyError> {
    // 1. Current utilization check
    if pool_supply_underlying > 0 {
        let current_util = pool_borrow_underlying
            .checked_mul(SCALAR_7)
            .ok_or(StrategyError::ArithmeticError)?
            .checked_div(pool_supply_underlying)
            .ok_or(StrategyError::DivisionByZero)?;

        if current_util > MAX_SAFE_UTILIZATION {
            panic_with_error!(e, StrategyError::ExternalError);
        }
    }

    // 2. Projected utilization check
    let proj_supply = pool_supply_underlying
        .checked_add(additional_supply)
        .ok_or(StrategyError::UnderflowOverflow)?;
    let proj_borrow = pool_borrow_underlying
        .checked_add(additional_borrow)
        .ok_or(StrategyError::UnderflowOverflow)?;

    if proj_supply > 0 {
        let proj_util = proj_borrow
            .checked_mul(SCALAR_7)
            .ok_or(StrategyError::ArithmeticError)?
            .checked_div(proj_supply)
            .ok_or(StrategyError::DivisionByZero)?;

        if proj_util > MAX_SAFE_UTILIZATION {
            panic_with_error!(e, StrategyError::ExternalError);
        }
    }

    // 3. Post-loop health factor check
    let hf = compute_health_factor(
        post_b_tokens,
        post_d_tokens,
        b_rate,
        d_rate,
        config.c_factor,
    )?;
    if hf < config.min_hf {
        panic_with_error!(e, StrategyError::ExternalError);
    }

    Ok(())
}

/// Compute how many loops to unwind to bring HF back above min_hf.
/// Returns the number of (withdraw, repay) pairs needed.
pub fn compute_unwind_loops(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
    min_hf: i128,
) -> Result<u32, StrategyError> {
    let mut current_b = b_tokens;
    let mut current_d = d_tokens;
    let mut loops = 0u32;

    loop {
        let hf = compute_health_factor(current_b, current_d, b_rate, d_rate, c_factor)?;
        if hf >= min_hf || current_d == 0 {
            break;
        }

        // Unwind one loop: withdraw enough collateral to repay one "layer" of debt.
        // The last borrow layer ≈ d_tokens × (c_factor/SCALAR_7)^n pattern.
        // Simplified: repay an amount equal to current_d × (1 - c_factor/SCALAR_7)
        // which is approximately the smallest borrow layer.
        let repay_amount = current_d
            .checked_mul(SCALAR_7 - c_factor)
            .ok_or(StrategyError::ArithmeticError)?
            / SCALAR_7;

        if repay_amount == 0 {
            break;
        }

        // The d_tokens burned = repay_underlying / d_rate * SCALAR_12
        let d_tokens_burned = repay_amount
            .fixed_mul_floor(SCALAR_12, d_rate)
            .ok_or(StrategyError::ArithmeticError)?;

        // The b_tokens withdrawn = withdraw_underlying / b_rate * SCALAR_12
        // We withdraw same amount as we repay (netting)
        let b_tokens_withdrawn = repay_amount
            .fixed_mul_floor(SCALAR_12, b_rate)
            .ok_or(StrategyError::ArithmeticError)?;

        current_d = current_d.checked_sub(d_tokens_burned).unwrap_or(0);
        current_b = current_b.checked_sub(b_tokens_withdrawn).unwrap_or(0);
        loops += 1;

        if loops >= 5 {
            // Safety limit on unwind iterations
            break;
        }
    }

    Ok(loops)
}
