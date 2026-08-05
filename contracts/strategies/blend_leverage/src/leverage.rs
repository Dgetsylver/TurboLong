use crate::constants::{MAX_SAFE_UTILIZATION, SCALAR_12, SCALAR_7};
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
#[inline]
pub fn loop_step_count(n_loops: u32) -> u32 {
    (n_loops + 1).min(21)
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
pub fn compute_totals(initial_amount: i128, c_factor: i128, n_loops: u32) -> (i128, i128) {
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

/// Combine the strategy's collateral factor with the pool's liability factor into
/// the single 1e7-scaled factor the HF math uses: `cl = c_factor × l_factor`.
///
/// Blend's own health check marks liabilities *up* rather than collateral down:
/// a position is liquidatable once `B × pool_c_factor < D / l_factor`. Folding
/// `l_factor` into the collateral side is algebraically identical
/// (`B·c / (D/l) == B·c·l / D`) and keeps the formula to one division.
///
/// `l_factor` is read live from the pool's reserve config rather than stored, so
/// a Blend governance change to the reserve's risk parameters is picked up on the
/// next call instead of leaving a stale, optimistic value behind.
#[inline]
pub fn effective_c_factor(c_factor: i128, l_factor: i128) -> Result<i128, StrategyError> {
    c_factor
        .fixed_mul_floor(l_factor, SCALAR_7)
        .ok_or(StrategyError::ArithmeticError)
}

/// Calculate health factor for given b/d tokens.
/// HF = (b_tokens × b_rate × c_factor × l_factor) / (d_tokens × d_rate × SCALAR_7)
/// Returns HF in 1e7 scale (1_000_000_0 = 1.0)
///
/// Because the strategy's `c_factor` is asserted at construction to be no larger
/// than the pool's, this HF is a lower bound on Blend's own solvency ratio
/// `(B × pool_c_factor) / (D / l_factor)`: HF ≥ 1.0 therefore implies the
/// position is not liquidatable in Blend's terms.
pub fn compute_health_factor(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
    l_factor: i128,
) -> Result<i128, StrategyError> {
    if d_tokens == 0 {
        return Ok(i128::MAX); // No debt = infinite HF
    }

    let supply_value = b_tokens
        .fixed_mul_floor(b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    // supply_value × c_factor (1e7-scaled), then marked down by l_factor — the
    // mirror of Blend marking the debt side up by dividing by l_factor.
    let weighted_supply = supply_value
        .checked_mul(c_factor)
        .ok_or(StrategyError::ArithmeticError)?
        .fixed_mul_floor(l_factor, SCALAR_7)
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
#[allow(clippy::too_many_arguments)] // safety check legitimately needs the full pool + position context
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
    l_factor: i128,
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

    // 3. Post-loop health factor check. `min_hf > 1.0` is a Blend-terms floor —
    // the HF here already carries the pool's `l_factor` — so clearing it means
    // the post-deposit position is not liquidatable by the pool's own measure.
    let hf = compute_health_factor(
        post_b_tokens,
        post_d_tokens,
        b_rate,
        d_rate,
        config.c_factor,
        l_factor,
    )?;
    if hf < config.min_hf {
        panic_with_error!(e, StrategyError::ExternalError);
    }

    Ok(())
}

/// Compute the minimal underlying amount to repay (and withdraw) to restore HF
/// to `target_hf`, and the number of leverage loops that covers it.
///
/// Closed-form derivation (all values in underlying units):
///   B  = b_tokens × b_rate / SCALAR_12  (supply value)
///   D  = d_tokens × d_rate / SCALAR_12  (debt value)
///   cl = c_factor × l_factor            (effective collateral factor, 1e7)
///   HF = B × cl / D                     (current, in 1e7)
///
/// After repaying x underlying (and withdrawing x collateral):
///   (B - x) × cl = target_hf × (D - x)
///   x = (B × cl - target_hf × D) / (cl - target_hf)
///
/// Returns `(repay_underlying, loops_needed)`.
/// Returns `(0, 0)` if already at or above target_hf, or if no debt.
/// `repay_underlying` is clamped at the outstanding debt value: for degenerate
/// positions (equity <= 0, i.e. B <= D) the closed form yields x >= D, which
/// means a full close — never an over-repay.
pub fn compute_partial_unwind(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
    l_factor: i128,
    target_hf: i128,
) -> Result<(i128, u32), StrategyError> {
    if d_tokens == 0 {
        return Ok((0, 0));
    }

    let hf = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, c_factor, l_factor)?;
    if hf >= target_hf {
        return Ok((0, 0));
    }

    // The HF the closed form solves for carries the pool's liability markup, so
    // the equation is driven by the effective factor, not the raw c_factor.
    // `layer_size` below stays on the raw c_factor: it describes the geometry of
    // the *actual* borrow loop (and of `submit_deleverage`'s layers), which is
    // unaffected by how the pool weights liabilities.
    let cl = effective_c_factor(c_factor, l_factor)?;

    // Supply and debt values in underlying (SCALAR_12 precision)
    let supply_value = b_tokens
        .fixed_mul_floor(b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let debt_value = d_tokens
        .fixed_mul_floor(d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    // numerator   = B × cl - target_hf × D  (both in 1e7 × underlying)
    // denominator = cl - target_hf           (in 1e7)
    // x = numerator / denominator
    let numerator = supply_value
        .checked_mul(cl)
        .ok_or(StrategyError::ArithmeticError)?
        .checked_sub(
            target_hf
                .checked_mul(debt_value)
                .ok_or(StrategyError::ArithmeticError)?,
        )
        .ok_or(StrategyError::UnderflowOverflow)?;

    // denominator = cl - target_hf; negative when target_hf > cl (always true for
    // a healthy target, since cl <= c_factor < 1.0 < target), so we negate both sides.
    let denom = target_hf
        .checked_sub(cl)
        .ok_or(StrategyError::UnderflowOverflow)?;

    if denom <= 0 {
        // target_hf <= cl: can't reach target by partial unwind alone
        return Err(StrategyError::ArithmeticError);
    }

    // x = -numerator / denom  (numerator is negative when HF < target_hf)
    // +1 stroop to clear the threshold; clamped at the debt so a zero/negative
    // equity position resolves to a full close instead of an over-repay.
    let repay_underlying = (numerator
        .checked_neg()
        .ok_or(StrategyError::ArithmeticError)?
        .checked_div(denom)
        .ok_or(StrategyError::DivisionByZero)?
        + 1)
    .min(debt_value);

    // Convert repay amount to loop count.
    // Each loop layer ≈ initial × c_factor^k. The smallest layer (last borrow) ≈
    // total_debt × (1 - c_factor/SCALAR_7). We count how many layers sum to repay_underlying.
    let layer_size = debt_value
        .checked_mul(SCALAR_7 - c_factor)
        .ok_or(StrategyError::ArithmeticError)?
        / SCALAR_7;

    if layer_size == 0 {
        return Ok((repay_underlying, 1));
    }

    let loops = ((repay_underlying + layer_size - 1) / layer_size) as u32;
    Ok((repay_underlying, loops.clamp(1, 20)))
}
