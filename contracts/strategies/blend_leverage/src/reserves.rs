use crate::{
    blend_pool,
    constants::{FIRST_DEPOSIT_LOCKUP, PROFIT_UNLOCK_LEDGERS, SCALAR_12},
    leverage::{self, compute_equity, priced_shares, underlying_to_shares},
    storage::{self, Config, UnvestedShares},
};

use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{panic_with_error, Env};

// ── The vault's position ─────────────────────────────────────────────────────

/// The vault's position at one moment: its b- and d-tokens and the pool's rates,
/// as Blend reports them, and its total shares.
///
/// Only `total_shares` is the vault's own record (`storage::get_total_shares`).
/// The rest is read from Blend on every call (`current`) rather than stored, so
/// it cannot drift from the pool: a change the strategy did not make — a
/// liquidation seizing collateral, Blend writing down bad debt — is priced in
/// from the next call, and lands on every holder at once rather than on
/// whoever is last out. No one can add to the position: Blend changes a
/// borrower's position only with its authorization, or by liquidation.
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct LeverageReserves {
    /// Total shares outstanding across all depositors, lockup included.
    pub total_shares: i128,
    /// The vault's b-tokens (supply) in the pool.
    pub total_b_tokens: i128,
    /// The vault's d-tokens (debt) in the pool.
    pub total_d_tokens: i128,
    /// The pool's b_rate.
    pub b_rate: i128,
    /// The pool's d_rate.
    pub d_rate: i128,
}

/// The vault's position now: read from Blend, with the stored share count.
pub fn current(e: &Env, config: &Config) -> LeverageReserves {
    let (b_rate, d_rate) = blend_pool::get_rates(e, config);
    let (total_b_tokens, total_d_tokens) = blend_pool::get_strategy_positions(e, config);
    LeverageReserves {
        total_shares: storage::get_total_shares(e),
        total_b_tokens,
        total_d_tokens,
        b_rate,
        d_rate,
    }
}

/// Harvest shares still unvested at the current ledger.
pub fn unvested_shares(e: &Env) -> Result<i128, StrategyError> {
    leverage::unvested_shares(&storage::get_unvested_shares(e), e.ledger().sequence())
}

/// The equity that `b_tokens_delta` and `d_tokens_delta` add to `reserves`,
/// rounded down (the collateral down, the debt up) so it is never credited above
/// what they add.
fn equity_added(
    b_tokens_delta: i128,
    d_tokens_delta: i128,
    reserves: &LeverageReserves,
) -> Result<i128, StrategyError> {
    let supply_added = b_tokens_delta
        .fixed_mul_floor(reserves.b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let debt_added = d_tokens_delta
        .fixed_mul_ceil(reserves.d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    supply_added
        .checked_sub(debt_added)
        .ok_or(StrategyError::UnderflowOverflow)
}

// ── Deposit accounting ───────────────────────────────────────────────────────

/// Account for a deposit into the leveraged position.
///
/// Process:
/// 1. Calculate the equity added = (b_delta × b_rate - d_delta × d_rate) / SCALAR_12
/// 2. Convert equity to shares proportionally
/// 3. Apply inflation attack protection for first depositor
/// 4. Record the new share count
///
/// `reserves` is the position **before** the deposit: the pool has already
/// settled it by the time this is called, so a fresh read would price the new
/// shares against equity that already includes the deposit. The deltas are the
/// b/d tokens the pool measurably added.
///
/// Returns `(vault_minted_shares, lockup_shares, updated_reserves)`, the last
/// being the position after the deposit.
///
/// The per-user ledger is the SEP-41 share token, not strategy storage: the
/// caller (`lib.rs::deposit`) mints `vault_minted_shares` to the depositor and,
/// on the first deposit, mints `lockup_shares` to a lock address so
/// `token.total_supply == total_shares`.
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

    // The depositor is never credited more than they add.
    let equity_added = equity_added(b_tokens_delta, d_tokens_delta, &reserves)?;
    if equity_added <= 0 {
        return Err(StrategyError::UnderlyingAmountBelowMin);
    }

    // Convert equity to shares
    let unvested =
        leverage::unvested_shares_down(&storage::get_unvested_shares(e), e.ledger().sequence())?;
    let new_shares = underlying_to_shares(equity_added, &reserves, unvested)?;
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

    // total_shares includes the lockup, matching token supply.
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

    storage::set_total_shares(e, reserves.total_shares);

    Ok((vault_minted_shares, lockup_shares, reserves))
}

// ── Withdraw accounting ──────────────────────────────────────────────────────

/// Size a withdrawal of `amount` of equity: the shares to burn and the b/d
/// tokens that carry them out (see `share_slice`). The shares burned round up,
/// against the withdrawer.
///
/// Returns `(shares_to_burn, b_tokens_to_remove, d_tokens_to_remove)`.
///
/// `user_shares` is the caller's current token balance (read by `lib.rs` from
/// the share token, not from strategy storage); the caller burns
/// `shares_to_burn` from the token.
///
/// Nothing is persisted here. The token amounts are what `submit_unwind` is
/// asked to remove; `commit_withdraw` then records the shares burned.
pub fn withdraw(
    e: &Env,
    user_shares: i128,
    amount: i128, // underlying amount requested
    reserves: &LeverageReserves,
) -> Result<(i128, i128, i128), StrategyError> {
    if user_shares <= 0 {
        return Err(StrategyError::InsufficientBalance);
    }

    let total_equity = compute_equity(reserves)?;
    if total_equity <= 0 {
        return Err(StrategyError::InsufficientBalance);
    }
    let priced_shares = priced_shares(reserves, unvested_shares(e)?)?;

    // Calculate the share proportion for the requested amount
    let shares_to_burn = amount
        .fixed_mul_ceil(priced_shares, total_equity)
        .ok_or(StrategyError::ArithmeticError)?;

    if shares_to_burn > user_shares {
        return Err(StrategyError::InsufficientBalance);
    }

    let (b_tokens_to_remove, d_tokens_to_remove) =
        share_slice(shares_to_burn, reserves, priced_shares)?;
    Ok((shares_to_burn, b_tokens_to_remove, d_tokens_to_remove))
}

/// Size a redemption of exactly `shares`: the b/d tokens that carry them out
/// (see `share_slice`). Refused with `InsufficientBalance` for more shares than
/// `user_shares`, or while the shares are worth nothing.
///
/// Returns `(b_tokens_to_remove, d_tokens_to_remove)`. Like `withdraw`, it
/// persists nothing.
pub fn redeem(
    e: &Env,
    user_shares: i128,
    shares: i128,
    reserves: &LeverageReserves,
) -> Result<(i128, i128), StrategyError> {
    if shares > user_shares {
        return Err(StrategyError::InsufficientBalance);
    }

    if compute_equity(reserves)? <= 0 {
        return Err(StrategyError::InsufficientBalance);
    }

    share_slice(
        shares,
        reserves,
        priced_shares(reserves, unvested_shares(e)?)?,
    )
}

/// The b/d tokens that carry `shares` out of the vault: their pro-rata slice of
/// the position, out of the `priced_shares` (see `leverage::priced_shares`).
///
/// The harvest shares still unvested keep their slice, so the withdrawer's part
/// of a recent harvest stays with the holders it is still vesting to.
///
/// The collateral rounds down and the debt rounds up, against the withdrawer,
/// so the holders who stay never inherit a sliver of the leaver's debt.
fn share_slice(
    shares: i128,
    reserves: &LeverageReserves,
    priced_shares: i128,
) -> Result<(i128, i128), StrategyError> {
    let b_tokens = shares
        .fixed_mul_floor(reserves.total_b_tokens, priced_shares)
        .ok_or(StrategyError::ArithmeticError)?;
    let d_tokens = shares
        .fixed_mul_ceil(reserves.total_d_tokens, priced_shares)
        .ok_or(StrategyError::ArithmeticError)?;
    Ok((b_tokens, d_tokens))
}

/// Record a withdrawal: `shares_to_burn` leave the share count.
///
/// `reserves` is the position before the unwind, and `b_removed`/`d_removed`
/// the b/d tokens the pool measurably removed (returned by `submit_unwind`).
///
/// Returns the position after the withdrawal.
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
    reserves.total_b_tokens = reserves
        .total_b_tokens
        .checked_sub(b_removed)
        .ok_or(StrategyError::UnderflowOverflow)?;
    reserves.total_d_tokens = reserves
        .total_d_tokens
        .checked_sub(d_removed)
        .ok_or(StrategyError::UnderflowOverflow)?;

    storage::set_total_shares(e, reserves.total_shares);
    Ok(reserves)
}

// ── Harvest accounting ───────────────────────────────────────────────────────

/// Account for harvested rewards that have been re-leveraged. The equity the
/// b/d token deltas add is minted as shares, priced as a deposit's, that no one
/// holds: they vest over `PROFIT_UNLOCK_LEDGERS`, so the gain reaches the
/// holders' share price gradually rather than at this ledger.
///
/// `reserves` is the position **before** the reinvest, exactly as `deposit`
/// takes one: the pool has already settled the reinvest by the time this is
/// called, so the gain is measured as the deltas' equity on top of it.
///
/// The caller has refused the harvest while any shares are unvested
/// (`lib.rs::check_vested`), so there are none to price over or to keep.
///
/// Returns the position after the reinvest.
pub fn harvest(
    e: &Env,
    b_tokens_delta: i128,
    d_tokens_delta: i128,
    reserves: &LeverageReserves,
) -> Result<LeverageReserves, StrategyError> {
    let gain = equity_added(b_tokens_delta, d_tokens_delta, reserves)?;
    if gain > 0 {
        let now = e.ledger().sequence();
        storage::set_unvested_shares(
            e,
            &UnvestedShares {
                amount: underlying_to_shares(gain, reserves, 0)?,
                start: now,
                end: now
                    .checked_add(PROFIT_UNLOCK_LEDGERS)
                    .ok_or(StrategyError::UnderflowOverflow)?,
            },
        );
    }

    let mut updated = reserves.clone();
    updated.total_b_tokens = updated
        .total_b_tokens
        .checked_add(b_tokens_delta)
        .ok_or(StrategyError::UnderflowOverflow)?;
    updated.total_d_tokens = updated
        .total_d_tokens
        .checked_add(d_tokens_delta)
        .ok_or(StrategyError::UnderflowOverflow)?;
    Ok(updated)
}
