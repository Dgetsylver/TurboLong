use crate::{
    blend_pool,
    constants::{FIRST_DEPOSIT_LOCKUP, SCALAR_12},
    leverage::{compute_equity, underlying_to_shares},
    storage::{self, Config, LeverageReserves},
};

use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{panic_with_error, Env};

// ── Reserve management ───────────────────────────────────────────────────────

/// Get the strategy reserves from storage, refresh b_rate/d_rate from the pool,
/// and reconcile the tracked position against the pool's measured one.
///
/// See `reconcile` for the reconciliation rule. This does **not** persist: it is
/// called from read-only views (`balance`, `position`) as well as the mutating
/// paths, and a view must not write. The mutating paths persist the reconciled
/// figure as a side effect of their own `± measured delta` write, and
/// `sync_reserves()` persists it on demand.
pub fn get_strategy_reserves_updated(e: &Env, config: &Config) -> LeverageReserves {
    let (b_rate, d_rate) = blend_pool::get_rates(e, config);
    let (pool_b, pool_d) = blend_pool::get_strategy_positions(e, config);
    reconcile(e, pool_b, pool_d, b_rate, d_rate)
}

/// Build the reconciled reserves from pool values the caller has already read,
/// avoiding a duplicate cross-contract round-trip.
///
/// The reconciliation rule is **downward only**: each tracked total is clamped to
/// the pool's measured figure when the pool reports *less*, and left alone when
/// the pool reports more.
///
/// Clamping down is what closes the finding. `total_b_tokens` / `total_d_tokens`
/// are otherwise a running ledger of deltas the strategy itself caused, so any
/// position change it did not initiate — a liquidation seizing collateral, a
/// Blend bad-debt socialization — was invisible to share pricing. `compute_equity`
/// would keep quoting the pre-seizure position, `withdraw` would price shares off
/// that inflated figure, and the shortfall would land entirely on whoever was
/// last out. Clamping makes the loss visible to every holder at once, on the
/// first read after it happens.
///
/// *Not* clamping up is what keeps that safe. If the tracked total followed the
/// pool upwards, any collateral credited to the strategy's position would move
/// the share price — the lever an inflation attack needs, and the opposite of the
/// "a donation cannot move the share price" property the strategy relies on.
/// Blend offers no such credit path today (`submit`'s `to` routes outgoing
/// transfers, so a third party's `SupplyCollateral` lands on the sender), so this
/// is defence in depth rather than a live hole — but it is cheap, and it is what
/// makes the property hold by construction instead of by the pool's good manners.
/// Any excess is not lost, merely unpriced: it accrues to the position and is
/// realized on a full close.
///
/// The one asymmetry worth naming: a third party *repaying* the strategy's debt
/// lowers `pool_d`, which does clamp down and does raise equity. That is a
/// donation of value that moves the share price, but it is bounded by the vault's
/// own outstanding debt rather than unbounded like a collateral donation, and the
/// alternative — leaving `total_d_tokens` high after a liquidation — would
/// systematically under-price every holder's shares until the position closed.
pub fn reconcile(
    e: &Env,
    pool_b: i128,
    pool_d: i128,
    b_rate: i128,
    d_rate: i128,
) -> LeverageReserves {
    let mut reserves = storage::get_strategy_reserves(e);
    reserves.b_rate = b_rate;
    reserves.d_rate = d_rate;
    reserves.total_b_tokens = reserves.total_b_tokens.min(pool_b);
    reserves.total_d_tokens = reserves.total_d_tokens.min(pool_d);
    reserves
}

/// Persist the reconciliation, returning `(b_written_down, d_written_down)` —
/// both non-negative, both zero when the tracked position already matched.
///
/// Storage is only written when the *position* actually moved: refreshed rates
/// alone are not worth a persistent-entry write, and the read path recomputes
/// them on every call anyway.
pub fn sync(e: &Env, config: &Config) -> (i128, i128) {
    let stored = storage::get_strategy_reserves(e);
    let reconciled = get_strategy_reserves_updated(e, config);

    let b_correction = stored.total_b_tokens - reconciled.total_b_tokens;
    let d_correction = stored.total_d_tokens - reconciled.total_d_tokens;

    if b_correction != 0 || d_correction != 0 {
        storage::set_strategy_reserves(e, reconciled);
    }

    (b_correction, d_correction)
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
///
/// Returns `(vault_minted_shares, lockup_shares, updated_reserves)`.
///
/// The per-user ledger is the SEP-41 share token, not strategy storage, so this
/// no longer writes `VaultPos`: the caller (`lib.rs::deposit`) mints
/// `vault_minted_shares` to the depositor and, on the first deposit, mints
/// `lockup_shares` to a lock address so `token.total_supply == total_shares`.
pub fn deposit(
    e: &Env,
    b_tokens_delta: i128,
    d_tokens_delta: i128,
    reserves: &LeverageReserves,
) -> Result<(i128, i128, LeverageReserves), StrategyError> {
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

    // Inflation attack protection: first depositor lockup. The lockup portion is
    // minted to a lock address by the caller (never to the depositor).
    let (vault_minted_shares, lockup_shares) = if reserves.total_shares == 0 {
        if new_shares <= FIRST_DEPOSIT_LOCKUP {
            panic_with_error!(e, StrategyError::InvalidSharesMinted);
        }
        (
            new_shares
                .checked_sub(FIRST_DEPOSIT_LOCKUP)
                .ok_or(StrategyError::UnderflowOverflow)?,
            FIRST_DEPOSIT_LOCKUP,
        )
    } else {
        (new_shares, 0)
    };

    // Update totals (total_shares includes the lockup, matching token supply).
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

    Ok((vault_minted_shares, lockup_shares, reserves))
}

// ── Withdraw accounting ──────────────────────────────────────────────────────

/// Account for a withdrawal from the leveraged position.
///
/// Process:
/// 1. Determine share proportion to burn
/// 2. Calculate proportional b/d tokens
/// 3. Update totals
///
/// Returns `(shares_to_burn, b_tokens_to_remove, d_tokens_to_remove, preview_reserves)`.
///
/// `user_shares` is the caller's current token balance (read by `lib.rs` from
/// the share token, not from strategy storage). This no longer writes
/// `VaultPos`: the caller burns `shares_to_burn` from the token.
///
/// IMPORTANT: this function does **not** persist the position. The returned
/// `b/d_tokens_to_remove` are the *intended* unwind amounts (fed to
/// `submit_unwind`); the `preview_reserves` are the corresponding projected
/// state and are exact only when token≈underlying. The real reserves are
/// committed by `commit_withdraw` from the pool's *measured* deltas, so stored
/// reserves stay in lock-step with the actual pool position (Finding ①).
pub fn withdraw(
    _e: &Env,
    user_shares: i128,
    amount: i128, // underlying amount requested
    reserves: &LeverageReserves,
) -> Result<(i128, i128, i128, LeverageReserves), StrategyError> {
    let mut reserves = reserves.clone();

    if user_shares <= 0 {
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

    if shares_to_burn > user_shares {
        return Err(StrategyError::InsufficientBalance);
    }

    // Calculate proportional b/d tokens to remove
    let b_tokens_to_remove = shares_to_burn
        .fixed_mul_floor(reserves.total_b_tokens, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)?;
    let d_tokens_to_remove = shares_to_burn
        .fixed_mul_floor(reserves.total_d_tokens, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)?;

    // Project the post-withdraw state for the caller's preview/return value.
    // NOTE: not persisted here — see `commit_withdraw` (Finding ①).
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

    Ok((
        shares_to_burn,
        b_tokens_to_remove,
        d_tokens_to_remove,
        reserves,
    ))
}

/// Commit a withdrawal to storage using the b/d tokens the pool *actually*
/// removed (returned by `submit_unwind`), keeping stored reserves in lock-step
/// with the real pool position — the same measured-delta discipline used by
/// `deposit`, `harvest` and `deleverage`.
///
/// `reserves` is the pre-withdraw snapshot (with refreshed rates). `shares_to_burn`
/// is the amount burned from the share token; `b_removed`/`d_removed` are the
/// measured pool deltas. Position totals use `saturating_sub` so a full close
/// that clears a stroop more than was tracked (e.g. the `i64::MAX` dust sweep)
/// floors at zero instead of reverting.
///
/// Returns the persisted, post-withdraw reserves.
pub fn commit_withdraw(
    e: &Env,
    shares_to_burn: i128,
    b_removed: i128,
    d_removed: i128,
    reserves: &LeverageReserves,
) -> Result<LeverageReserves, StrategyError> {
    let mut reserves = reserves.clone();

    reserves.total_shares = reserves
        .total_shares
        .checked_sub(shares_to_burn)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_b_tokens = reserves.total_b_tokens.saturating_sub(b_removed);
    reserves.total_d_tokens = reserves.total_d_tokens.saturating_sub(d_removed);

    storage::set_strategy_reserves(e, reserves.clone());
    Ok(reserves)
}

// ── Harvest accounting ───────────────────────────────────────────────────────

/// Account for harvested rewards that have been re-leveraged.
/// The b/d token deltas increase total tokens without minting new shares,
/// effectively increasing the per-share equity (yield).
///
/// `reserves` is the **pre-reinvest** snapshot, exactly as `deposit` takes one.
/// It cannot re-read the position itself: by the time this is called the pool
/// has already settled the reinvest, so a fresh read would already include
/// `b_tokens_delta` and adding it again would double-count.
pub fn harvest(
    e: &Env,
    b_tokens_delta: i128,
    d_tokens_delta: i128,
    reserves: &LeverageReserves,
) -> Result<LeverageReserves, StrategyError> {
    let mut reserves = reserves.clone();

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
///
/// `reserves` is the **pre-unwind** snapshot, for the same reason `harvest` takes
/// one: the pool has already settled the unwind, so a fresh read would already
/// have `b_tokens_removed` taken out and subtracting it again would double-count.
///
/// Position totals use `saturating_sub`, matching `commit_withdraw`. The measured
/// removal comes from the pool while the snapshot is clamped to the pool's
/// *pre*-unwind position, so if the tracked total ever sat below the pool's the
/// pool can legitimately report removing more than was ever tracked. Flooring at
/// zero keeps liquidation protection working in that case; reverting would let an
/// upward gap brick `rebalance`.
pub fn deleverage(
    e: &Env,
    b_tokens_removed: i128,
    d_tokens_removed: i128,
    reserves: &LeverageReserves,
) -> Result<LeverageReserves, StrategyError> {
    let mut reserves = reserves.clone();

    reserves.total_b_tokens = reserves.total_b_tokens.saturating_sub(b_tokens_removed);
    reserves.total_d_tokens = reserves.total_d_tokens.saturating_sub(d_tokens_removed);

    storage::set_strategy_reserves(e, reserves.clone());
    Ok(reserves)
}
