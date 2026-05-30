use crate::{
    blend_pool,
    constants::{FIRST_DEPOSIT_LOCKUP, SCALAR_12},
    leverage::{compute_equity, underlying_to_shares},
    storage::{self, Config, LeverageReserves},
};

use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{panic_with_error, Address, Env};

// ── Reserve management ───────────────────────────────────────────────────────

/// Get the strategy reserves from storage and update b_rate/d_rate from the pool.
pub fn get_strategy_reserves_updated(e: &Env, config: &Config) -> LeverageReserves {
    let mut reserves = storage::get_strategy_reserves(e);
    let (b_rate, d_rate) = blend_pool::get_rates(e, config);
    reserves.b_rate = b_rate;
    reserves.d_rate = d_rate;
    reserves
}

// ── Deposit accounting ───────────────────────────────────────────────────────

/// Account for a deposit into the leveraged position.
///
/// Unlike the standard Blend strategy which tracks only b-tokens, we track both
/// b-tokens AND d-tokens since leverage involves debt.
///
/// Process:
/// 1. Calculate the equity added = (b_delta × b_rate - d_delta × d_rate) / SCALAR_12
/// 2. Convert equity to shares proportionally
/// 3. Apply inflation attack protection for first depositor
/// 4. Update totals
pub fn deposit(
    e: &Env,
    from: &Address,
    b_tokens_delta: i128,
    d_tokens_delta: i128,
    reserves: &LeverageReserves,
) -> Result<(i128, LeverageReserves), StrategyError> {
    let mut reserves = reserves.clone();

    if b_tokens_delta <= 0 {
        return Err(StrategyError::BTokensAmountBelowMin);
    }

    // Calculate the equity added by this deposit
    let supply_added = b_tokens_delta
        .fixed_mul_floor(reserves.b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let debt_added = d_tokens_delta
        .fixed_mul_floor(reserves.d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let equity_added = supply_added
        .checked_sub(debt_added)
        .ok_or(StrategyError::UnderflowOverflow)?;

    if equity_added <= 0 {
        return Err(StrategyError::UnderlyingAmountBelowMin);
    }

    // Convert equity to shares
    let new_shares = underlying_to_shares(equity_added, &reserves)?;
    if new_shares <= 0 {
        panic_with_error!(e, StrategyError::InvalidSharesMinted);
    }

    // Inflation attack protection: first depositor lockup
    let vault_minted_shares = if reserves.total_shares == 0 {
        if new_shares <= FIRST_DEPOSIT_LOCKUP {
            panic_with_error!(e, StrategyError::InvalidSharesMinted);
        }
        new_shares
            .checked_sub(FIRST_DEPOSIT_LOCKUP)
            .ok_or(StrategyError::UnderflowOverflow)?
    } else {
        new_shares
    };

    // Update totals
    reserves.total_shares = reserves
        .total_shares
        .checked_add(new_shares)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_b_tokens = reserves
        .total_b_tokens
        .checked_add(b_tokens_delta)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_d_tokens = reserves
        .total_d_tokens
        .checked_add(d_tokens_delta)
        .ok_or(StrategyError::UnderflowOverflow)?;

    // Persist
    storage::set_strategy_reserves(e, reserves.clone());

    let old_shares = storage::get_vault_shares(e, from);
    let new_vault_shares = old_shares
        .checked_add(vault_minted_shares)
        .ok_or(StrategyError::UnderflowOverflow)?;
    storage::set_vault_shares(e, from, new_vault_shares);

    Ok((new_vault_shares, reserves))
}

// ── Withdraw accounting ──────────────────────────────────────────────────────

/// Account for a withdrawal from the leveraged position.
///
/// Process:
/// 1. Determine share proportion to burn
/// 2. Calculate proportional b/d tokens
/// 3. Update totals
///
/// Returns (remaining_shares, b_tokens_to_remove, d_tokens_to_remove, updated_reserves)
pub fn withdraw(
    e: &Env,
    from: &Address,
    amount: i128, // underlying amount requested
    reserves: &LeverageReserves,
) -> Result<(i128, i128, i128, LeverageReserves), StrategyError> {
    let mut reserves = reserves.clone();

    let vault_shares = storage::get_vault_shares(e, from);
    if vault_shares <= 0 {
        return Err(StrategyError::InsufficientBalance);
    }

    let total_equity = compute_equity(&reserves)?;
    if total_equity <= 0 {
        return Err(StrategyError::InsufficientBalance);
    }

    // Calculate the share proportion for the requested amount
    let shares_to_burn = amount
        .fixed_mul_ceil(reserves.total_shares, total_equity)
        .ok_or(StrategyError::ArithmeticError)?;

    if shares_to_burn > vault_shares {
        return Err(StrategyError::InsufficientBalance);
    }

    // Calculate proportional b/d tokens to remove
    let b_tokens_to_remove = shares_to_burn
        .fixed_mul_floor(reserves.total_b_tokens, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)?;
    let d_tokens_to_remove = shares_to_burn
        .fixed_mul_floor(reserves.total_d_tokens, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)?;

    // Update totals
    reserves.total_shares = reserves
        .total_shares
        .checked_sub(shares_to_burn)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_b_tokens = reserves
        .total_b_tokens
        .checked_sub(b_tokens_to_remove)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_d_tokens = reserves
        .total_d_tokens
        .checked_sub(d_tokens_to_remove)
        .ok_or(StrategyError::UnderflowOverflow)?;

    // Persist
    let remaining = vault_shares
        .checked_sub(shares_to_burn)
        .ok_or(StrategyError::UnderflowOverflow)?;
    storage::set_vault_shares(e, from, remaining);
    storage::set_strategy_reserves(e, reserves.clone());

    Ok((remaining, b_tokens_to_remove, d_tokens_to_remove, reserves))
}

/// Account for a full withdrawal due to strategy migration.
/// Burns all user shares and returns their proportional b/d tokens.
pub fn migrate_withdraw(
    e: &Env,
    from: &Address,
    reserves: &LeverageReserves,
) -> Result<(i128, i128, LeverageReserves), StrategyError> {
    let mut reserves = reserves.clone();

    let vault_shares = storage::get_vault_shares(e, from);
    if vault_shares <= 0 {
        return Err(StrategyError::InsufficientBalance);
    }

    let b_tokens_to_remove = vault_shares
        .fixed_mul_floor(reserves.total_b_tokens, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)?;
    let d_tokens_to_remove = vault_shares
        .fixed_mul_floor(reserves.total_d_tokens, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)?;

    reserves.total_shares = reserves
        .total_shares
        .checked_sub(vault_shares)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_b_tokens = reserves
        .total_b_tokens
        .checked_sub(b_tokens_to_remove)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_d_tokens = reserves
        .total_d_tokens
        .checked_sub(d_tokens_to_remove)
        .ok_or(StrategyError::UnderflowOverflow)?;

    storage::set_vault_shares(e, from, 0);
    storage::set_strategy_reserves(e, reserves.clone());

    Ok((b_tokens_to_remove, d_tokens_to_remove, reserves))
}


// ── Harvest accounting ───────────────────────────────────────────────────────

/// Account for harvested rewards that have been re-leveraged.
/// The b/d token deltas increase total tokens without minting new shares,
/// effectively increasing the per-share equity (yield).
pub fn harvest(
    e: &Env,
    b_tokens_delta: i128,
    d_tokens_delta: i128,
    config: &Config,
) -> Result<LeverageReserves, StrategyError> {
    let mut reserves = get_strategy_reserves_updated(e, config);

    reserves.total_b_tokens = reserves
        .total_b_tokens
        .checked_add(b_tokens_delta)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_d_tokens = reserves
        .total_d_tokens
        .checked_add(d_tokens_delta)
        .ok_or(StrategyError::UnderflowOverflow)?;

    storage::set_strategy_reserves(e, reserves.clone());
    Ok(reserves)
}

/// Account for deleveraging: b and d tokens decrease without changing shares.
pub fn deleverage(
    e: &Env,
    b_tokens_removed: i128,
    d_tokens_removed: i128,
    config: &Config,
) -> Result<LeverageReserves, StrategyError> {
    let mut reserves = get_strategy_reserves_updated(e, config);

    reserves.total_b_tokens = reserves
        .total_b_tokens
        .checked_sub(b_tokens_removed)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_d_tokens = reserves
        .total_d_tokens
        .checked_sub(d_tokens_removed)
        .ok_or(StrategyError::UnderflowOverflow)?;

    storage::set_strategy_reserves(e, reserves.clone());
    Ok(reserves)
}
