use crate::constants::{SCALAR_12, SCALAR_7};
use crate::{reserves::LeverageReserves, storage::UnvestedShares};
use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{panic_with_error, Env};

// ── Lever-in sizing ──────────────────────────────────────────────────────────

/// `(supply, borrow)` that lever `initial_amount` of equity to `target_hf`.
///
/// A position with equity `E` at health factor `h` has `B·cl / D = h` and
/// `B − D = E` (`cl = c_factor × l_factor`, as in every HF here), so
/// `D = E·cl / (h − cl)` and `B = E + D`: the leverage `B/E = h / (h − cl)` that
/// `target_hf` stands for. The borrow rounds down, toward a higher HF; the
/// pool's own rounding can still settle the HF a unit or so either side.
/// `supply − borrow = initial_amount` exactly, which is what the pool nets the
/// two legs to.
pub fn compute_lever_in(
    initial_amount: i128,
    c_factor: i128,
    l_factor: i128,
    target_hf: i128,
) -> Result<(i128, i128), StrategyError> {
    let cl = effective_c_factor(c_factor, l_factor)?;
    let denom = target_hf
        .checked_sub(cl)
        .ok_or(StrategyError::UnderflowOverflow)?;
    if denom <= 0 {
        // No leverage reaches an HF at or below `cl`.
        return Err(StrategyError::ArithmeticError);
    }

    let borrow = initial_amount
        .fixed_mul_floor(cl, denom)
        .ok_or(StrategyError::ArithmeticError)?;
    let supply = initial_amount
        .checked_add(borrow)
        .ok_or(StrategyError::UnderflowOverflow)?;
    Ok((supply, borrow))
}

// ── Equity calculation ───────────────────────────────────────────────────────

/// Calculate the net equity of the strategy position.
/// equity = (b_tokens × b_rate / SCALAR_12) - (d_tokens × d_rate / SCALAR_12)
///
/// Rounded down, as Blend values a position: the collateral down, the debt up.
pub fn compute_equity(reserves: &LeverageReserves) -> Result<i128, StrategyError> {
    let supply_value = reserves
        .total_b_tokens
        .fixed_mul_floor(reserves.b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    let debt_value = reserves
        .total_d_tokens
        .fixed_mul_ceil(reserves.d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    supply_value
        .checked_sub(debt_value)
        .ok_or(StrategyError::UnderflowOverflow)
}

/// `compute_equity` rounded up instead: the collateral up, the debt down. What
/// a deposit is priced against, so it never mints more shares than it adds.
pub fn compute_equity_up(reserves: &LeverageReserves) -> Result<i128, StrategyError> {
    let supply_value = reserves
        .total_b_tokens
        .fixed_mul_ceil(reserves.b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    let debt_value = reserves
        .total_d_tokens
        .fixed_mul_floor(reserves.d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    supply_value
        .checked_sub(debt_value)
        .ok_or(StrategyError::UnderflowOverflow)
}

/// The share count the vault is priced over: the holders' (`total_shares`) and
/// the harvest shares still `unvested` (see `unvested_shares`).
pub fn priced_shares(reserves: &LeverageReserves, unvested: i128) -> Result<i128, StrategyError> {
    reserves
        .total_shares
        .checked_add(unvested.max(0))
        .ok_or(StrategyError::UnderflowOverflow)
}

/// Convert shares to underlying equity amount, priced over the holders' shares
/// and the `unvested` ones.
pub fn shares_to_underlying(
    shares: i128,
    reserves: &LeverageReserves,
    unvested: i128,
) -> Result<i128, StrategyError> {
    if reserves.total_shares == 0 {
        return Ok(0);
    }
    let total_equity = compute_equity(reserves)?;
    if total_equity <= 0 {
        return Ok(0);
    }
    shares
        .fixed_mul_floor(total_equity, priced_shares(reserves, unvested)?)
        .ok_or(StrategyError::ArithmeticError)
}

/// Whether the vault has shares outstanding with no equity behind them: wiped
/// out by a liquidation or bad debt. No fair share price exists, so it takes no
/// new deposits and no harvests.
pub fn is_wiped_out(reserves: &LeverageReserves) -> Result<bool, StrategyError> {
    Ok(reserves.total_shares > 0 && compute_equity(reserves)? <= 0)
}

/// Convert underlying amount to shares, priced over the holders' shares and the
/// `unvested` ones.
///
/// Refused with `InvalidSharesMinted` when shares are outstanding with no
/// equity behind them (see `is_wiped_out`): there is no price to mint at.
/// Otherwise the vault is priced at its equity rounded up (`compute_equity_up`)
/// and the shares round down, so a deposit never mints more than it adds.
pub fn underlying_to_shares(
    amount: i128,
    reserves: &LeverageReserves,
    unvested: i128,
) -> Result<i128, StrategyError> {
    if reserves.total_shares == 0 {
        // First deposit: 1 share = 1 unit
        return Ok(amount);
    }
    if is_wiped_out(reserves)? {
        return Err(StrategyError::InvalidSharesMinted);
    }
    amount
        .fixed_mul_floor(
            priced_shares(reserves, unvested)?,
            compute_equity_up(reserves)?,
        )
        .ok_or(StrategyError::ArithmeticError)
}

// ── Profit vesting ───────────────────────────────────────────────────────────
//
// A harvest's equity gain is minted as shares held by no one, which vest
// linearly over `PROFIT_UNLOCK_LEDGERS` rather than reaching the share price at
// the harvest ledger (the constant explains why). Until they vest they are
// priced like any other share, so a loss in the meantime falls on them and on
// the holders' shares pro rata. A harvest is refused while any are unvested
// (`lib.rs::check_vested`), so the schedule holds a single harvest's shares.

/// Shares of `schedule` still unvested at ledger `now`. Rounds up, so the
/// holders' shares are valued, and leave, over a count never short of the exact
/// one.
pub fn unvested_shares(schedule: &UnvestedShares, now: u32) -> Result<i128, StrategyError> {
    unvested(schedule, now, true)
}

/// `unvested_shares` rounded down instead: what a deposit or a harvest is
/// minted against, so neither mints more than the exact count would.
pub fn unvested_shares_down(schedule: &UnvestedShares, now: u32) -> Result<i128, StrategyError> {
    unvested(schedule, now, false)
}

fn unvested(schedule: &UnvestedShares, now: u32, round_up: bool) -> Result<i128, StrategyError> {
    if schedule.amount <= 0 || now >= schedule.end {
        return Ok(0);
    }
    let span = schedule.end.saturating_sub(schedule.start).max(1) as i128;
    let remaining = (schedule.end - now).min(span as u32) as i128;
    if round_up {
        schedule.amount.fixed_mul_ceil(remaining, span)
    } else {
        schedule.amount.fixed_mul_floor(remaining, span)
    }
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
/// Because callers pass the strategy's `c_factor` capped at the pool's live one
/// (`blend_pool::get_rates_and_factors`), this HF is a lower bound on Blend's own
/// solvency ratio `(B × pool_c_factor) / (D / l_factor)`: HF ≥ 1.0 therefore
/// implies the position is not liquidatable in Blend's terms.
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

    // Rounded up, as Blend values debt, so this HF never exceeds Blend's.
    let debt_value = d_tokens
        .fixed_mul_ceil(d_rate, SCALAR_12)
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

/// Refuse a health factor below `min_hf`.
///
/// Run on the position Blend actually settled, not a projection of it.
/// `min_hf > 1.0` is a Blend-terms floor — `compute_health_factor` carries the
/// pool's `l_factor` and a `c_factor` no higher than the pool's — so clearing it
/// means the position is not liquidatable by the pool's own measure.
pub fn check_min_health_factor(e: &Env, hf: i128, min_hf: i128) -> Result<(), StrategyError> {
    if hf < min_hf {
        panic_with_error!(e, StrategyError::ExternalError);
    }
    Ok(())
}

/// Compute the underlying amount to repay (and withdraw) so that, once Blend has
/// settled the pair, HF sits on `target_hf`, to within the pool's rounding.
///
/// Closed-form derivation (all values in underlying units):
///   B  = b_tokens × b_rate / SCALAR_12  (supply value)
///   D  = d_tokens × d_rate / SCALAR_12  (debt value)
///   cl = c_factor × l_factor            (effective collateral factor, 1e7)
///   HF = B × cl / D                     (current, in 1e7)
///
/// After repaying x underlying (and withdrawing x collateral):
///   (B - x) × cl = target_hf × (D - x)
///   x = (target_hf × D - B × cl) / (target_hf - cl)
/// Both terms are positive while HF is below target: target_hf > cl for any
/// healthy target, since cl <= c_factor < 1.0 < target_hf.
///
/// `B` is rounded down and `D` up, as Blend values them, so both err toward
/// repaying more. The closed form is exact; the pool is not. Blend burns
/// `ceil(x / b_rate)` b-tokens for the withdraw and `floor(x / d_rate)` d-tokens
/// for the repay, which can settle HF a unit (1e-7) short of the target, or a
/// couple of dozen on a dust position. Every caller's target sits at least
/// `REBALANCE_HF_BUFFER` above `orange_hf`, so the position still leaves the
/// orange zone.
///
/// Returns `0` if already at or above target_hf, or if there is no debt.
/// The result is clamped at the outstanding debt value: for degenerate positions
/// (equity <= 0, i.e. B <= D) the closed form yields x >= D, which means a full
/// close — never an over-repay.
pub fn compute_partial_unwind(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
    l_factor: i128,
    target_hf: i128,
) -> Result<i128, StrategyError> {
    if d_tokens == 0 {
        return Ok(0);
    }

    let hf = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, c_factor, l_factor)?;
    if hf >= target_hf {
        return Ok(0);
    }

    // The HF the closed form solves for carries the pool's liability markup, so
    // the equation is driven by the effective factor, not the raw c_factor.
    let cl = effective_c_factor(c_factor, l_factor)?;

    // Supply and debt values in underlying (SCALAR_12 precision)
    let supply_value = b_tokens
        .fixed_mul_floor(b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let debt_value = d_tokens
        .fixed_mul_ceil(d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    // B × cl - target_hf × D (1e7 × underlying), negative while HF < target_hf.
    let numerator = supply_value
        .checked_mul(cl)
        .ok_or(StrategyError::ArithmeticError)?
        .checked_sub(
            target_hf
                .checked_mul(debt_value)
                .ok_or(StrategyError::ArithmeticError)?,
        )
        .ok_or(StrategyError::UnderflowOverflow)?;

    // target_hf - cl (1e7).
    let denom = target_hf
        .checked_sub(cl)
        .ok_or(StrategyError::UnderflowOverflow)?;

    if denom <= 0 {
        // target_hf <= cl: can't reach target by partial unwind alone
        return Err(StrategyError::ArithmeticError);
    }

    // x = -numerator / denom, +1 stroop to clear the threshold; clamped at the
    // debt so a zero/negative equity position resolves to a full close instead
    // of an over-repay.
    let repay_underlying = numerator
        .checked_neg()
        .ok_or(StrategyError::ArithmeticError)?
        .checked_div(denom)
        .ok_or(StrategyError::DivisionByZero)?
        .checked_add(1)
        .ok_or(StrategyError::UnderflowOverflow)?
        .min(debt_value);

    Ok(repay_underlying)
}

/// Compute the underlying amount to borrow (and immediately re-supply) to bring
/// HF *down* to `target_hf` — the mirror image of `compute_partial_unwind`.
///
/// Same closed form, opposite sign. Borrowing x and supplying it back raises
/// both sides of the position by x:
///   (B + x) × cl = target_hf × (D + x)
///   x = (B × cl − target_hf × D) / (target_hf − cl)
///
/// which is `compute_partial_unwind`'s `x = (t×D − B×cl) / (t − cl)` with the
/// numerator negated. `B×cl − t×D` is the position's distance from the
/// target: positive when HF sits *above* it (slack to re-lever, this function),
/// negative when it sits below (debt to repay, that one). Equity `B − D` is
/// invariant under the operation, so this moves the leverage ratio without
/// touching the share price.
///
/// Returns the borrow amount in underlying, or `0` when HF is already at or
/// below `target_hf` (nothing to re-lever). Works with `d_tokens == 0`: an
/// unlevered position — the state a full unwind leaves behind — is precisely
/// what this restores.
pub fn compute_releverage(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
    l_factor: i128,
    target_hf: i128,
) -> Result<i128, StrategyError> {
    let cl = effective_c_factor(c_factor, l_factor)?;

    // denominator = target_hf − cl, positive for any sane target (cl <= c_factor
    // < 1.0 < target). A target at or below cl is unreachable by borrowing: the
    // position asymptotes to cl as leverage grows without bound.
    let denom = target_hf
        .checked_sub(cl)
        .ok_or(StrategyError::UnderflowOverflow)?;
    if denom <= 0 {
        return Err(StrategyError::ArithmeticError);
    }

    let supply_value = b_tokens
        .fixed_mul_floor(b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let debt_value = d_tokens
        .fixed_mul_ceil(d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    // numerator = B × cl − target_hf × D, positive exactly when HF > target_hf.
    let numerator = supply_value
        .checked_mul(cl)
        .ok_or(StrategyError::ArithmeticError)?
        .checked_sub(
            target_hf
                .checked_mul(debt_value)
                .ok_or(StrategyError::ArithmeticError)?,
        )
        .ok_or(StrategyError::UnderflowOverflow)?;

    if numerator <= 0 {
        return Ok(0);
    }

    // −1 stroop, the mirror of the +1 in `compute_partial_unwind`, rounds the
    // borrow down. The pool's own rounding (b-tokens minted down, d-tokens up)
    // can still settle HF a unit or so below the target, as for a deposit;
    // `releverage` checks the settled HF against `orange_hf`, which the target
    // clears by `RELEVERAGE_HF_BUFFER`.
    Ok((numerator
        .checked_div(denom)
        .ok_or(StrategyError::DivisionByZero)?
        - 1)
    .max(0))
}

// ── Harvest settlement floor ─────────────────────────────────────────────────
//
// The Broker harvest leaves the chain between `harvest_claim` and
// `harvest_reinvest`: BLND is approved out, a swap happens off-chain, underlying
// comes back. Nothing on-chain can observe the swap, but it *can* observe both
// ends of it — how much BLND left and how much underlying arrived — and hold the
// pair to a rate the admin fixed in advance. These two functions are that rate
// arithmetic; the measurement lives in `harvest_reinvest`.
//
// Both round *up*, so rounding always favours the vault.

/// Minimum underlying owed back for `blnd_amount` of BLND at `min_rate`
/// (underlying smallest-units per `SCALAR_7` BLND smallest-units).
pub fn harvest_floor(blnd_amount: i128, min_rate: i128) -> Result<i128, StrategyError> {
    if blnd_amount <= 0 || min_rate <= 0 {
        return Ok(0);
    }
    blnd_amount
        .fixed_mul_ceil(min_rate, SCALAR_7)
        .ok_or(StrategyError::ArithmeticError)
}

/// The share of `floor` owed for the `spent` of `claimed` BLND that actually
/// left the vault.
///
/// The Broker is free to pull less than the whole approval — or nothing at all,
/// when the keeper claims and then routes through Soroswap instead — and the
/// floor has to follow the BLND rather than the approval. `spent >= claimed`
/// (the whole approval taken) owes the full floor.
pub fn prorate_floor(floor: i128, spent: i128, claimed: i128) -> Result<i128, StrategyError> {
    if floor <= 0 || spent <= 0 || claimed <= 0 {
        return Ok(0);
    }
    if spent >= claimed {
        return Ok(floor);
    }
    floor
        .fixed_mul_ceil(spent, claimed)
        .ok_or(StrategyError::ArithmeticError)
}
