use crate::constants::{SCALAR_12, SCALAR_7};
use crate::storage::{Config, LeverageReserves, LockedProfit};
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

/// The equity shares are priced at: `compute_equity` less the harvest profit
/// still `locked` (see `locked_profit`), never taken below zero.
pub fn priced_equity(reserves: &LeverageReserves, locked: i128) -> Result<i128, StrategyError> {
    let equity = compute_equity(reserves)?;
    equity
        .checked_sub(locked.clamp(0, equity.max(0)))
        .ok_or(StrategyError::UnderflowOverflow)
}

/// Convert shares to underlying equity amount, net of the `locked` harvest
/// profit.
pub fn shares_to_underlying(
    shares: i128,
    reserves: &LeverageReserves,
    locked: i128,
) -> Result<i128, StrategyError> {
    if reserves.total_shares == 0 {
        return Ok(0);
    }
    let total_equity = priced_equity(reserves, locked)?;
    if total_equity <= 0 {
        return Ok(0);
    }
    shares
        .fixed_mul_floor(total_equity, reserves.total_shares)
        .ok_or(StrategyError::ArithmeticError)
}

/// Convert underlying amount to shares, net of the `locked` harvest profit.
pub fn underlying_to_shares(
    amount: i128,
    reserves: &LeverageReserves,
    locked: i128,
) -> Result<i128, StrategyError> {
    if reserves.total_shares == 0 || reserves.total_b_tokens == 0 {
        // First deposit: 1 share = 1 unit
        return Ok(amount);
    }
    let total_equity = priced_equity(reserves, locked)?;
    if total_equity <= 0 {
        return Ok(amount);
    }
    amount
        .fixed_mul_floor(reserves.total_shares, total_equity)
        .ok_or(StrategyError::ArithmeticError)
}

// ── Profit release (audit finding 7) ─────────────────────────────────────────
//
// A harvest's equity gain is locked and released into the share price linearly
// over `PROFIT_UNLOCK_LEDGERS` rather than priced in at the harvest ledger (the
// constant explains why). All harvests share one linear schedule: a new one
// folds in and the combined amount releases until the gain-weighted average of
// the two end dates, so each harvest keeps, on average, its own window.

/// Profit still locked at ledger `now`. Rounds down: it unlocks a stroop early
/// rather than late.
pub fn locked_profit(lock: &LockedProfit, now: u32) -> Result<i128, StrategyError> {
    if lock.amount <= 0 || now >= lock.until {
        return Ok(0);
    }
    let span = lock.until.saturating_sub(lock.from).max(1);
    let remaining = (lock.until - now).min(span);
    lock.amount
        .fixed_mul_floor(remaining as i128, span as i128)
        .ok_or(StrategyError::ArithmeticError)
}

/// Fold `gain` into `lock` at ledger `now`.
///
/// What is still locked keeps its end date and `gain` gets the full `window`;
/// the sum releases linearly until the gain-weighted average of the two. A
/// non-positive `gain` locks nothing and only re-bases the schedule onto `now`,
/// which leaves it releasing exactly as before.
pub fn lock_profit(
    lock: &LockedProfit,
    gain: i128,
    now: u32,
    window: u32,
) -> Result<LockedProfit, StrategyError> {
    let still_locked = locked_profit(lock, now)?;
    let gain = gain.max(0);
    let amount = still_locked
        .checked_add(gain)
        .ok_or(StrategyError::UnderflowOverflow)?;
    if amount == 0 {
        return Ok(LockedProfit::default());
    }

    // underlying × ledgers: many orders inside i128.
    let weighted = still_locked
        .checked_mul(lock.until.saturating_sub(now) as i128)
        .ok_or(StrategyError::ArithmeticError)?
        .checked_add(
            gain.checked_mul(window as i128)
                .ok_or(StrategyError::ArithmeticError)?,
        )
        .ok_or(StrategyError::UnderflowOverflow)?;
    // A weighted average of the two durations, rounded up so a positive amount
    // always has at least a ledger to release over.
    let duration = weighted
        .fixed_mul_ceil(1, amount)
        .and_then(|d| u32::try_from(d).ok())
        .ok_or(StrategyError::ArithmeticError)?;

    Ok(LockedProfit {
        amount,
        from: now,
        until: now
            .checked_add(duration)
            .ok_or(StrategyError::UnderflowOverflow)?,
    })
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

/// Refuse a position whose health factor is below `config.min_hf`.
///
/// Run on the position Blend actually settled, not a projection of it.
/// `min_hf > 1.0` is a Blend-terms floor — the HF here already carries the
/// pool's `l_factor` — so clearing it means the position is not liquidatable by
/// the pool's own measure.
pub fn check_min_health_factor(
    e: &Env,
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    l_factor: i128,
    config: &Config,
) -> Result<(), StrategyError> {
    let hf = compute_health_factor(
        b_tokens,
        d_tokens,
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

/// Compute the underlying amount to repay (and withdraw) so that, once Blend has
/// settled the pair, HF sits at or just above `target_hf`.
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
/// The closed form is exact; the pool is not. Blend burns `ceil(x / b_rate)`
/// b-tokens for the withdraw and `floor(x / d_rate)` d-tokens for the repay, and
/// `B`/`D` above are already floored — every rounding lands against HF, enough to
/// leave the exact `x` one unit (1e-7) short of the target in a third to a half
/// of cases, i.e. still inside the orange zone it was meant to leave. `x` is
/// therefore padded by `unwind_rounding_margin` (≈25 stroops at typical
/// parameters).
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
    // +1 stroop to clear the threshold, plus the rounding margin; clamped at the
    // debt so a zero/negative equity position resolves to a full close instead
    // of an over-repay.
    let margin = unwind_rounding_margin(b_rate, d_rate, cl, target_hf)?;
    let repay_underlying = numerator
        .checked_neg()
        .ok_or(StrategyError::ArithmeticError)?
        .checked_div(denom)
        .ok_or(StrategyError::DivisionByZero)?
        .checked_add(1 + margin)
        .ok_or(StrategyError::UnderflowOverflow)?
        .min(debt_value);

    Ok(repay_underlying)
}

/// Stroops added to `compute_partial_unwind`'s repay so that Blend's rounding
/// cannot leave the settled HF below `target_hf`.
///
/// Each leg can cost the position up to `rate / SCALAR_12 + 1` stroops on its
/// side — one token of burn rounding plus the floor on the value — which the
/// `+ 2` below covers for any rate: collateral (`slip_b`) for the withdraw, debt
/// (`slip_d`) for the repay. Every extra stroop repaid moves `B·cl − target·D` by
/// `target − cl`, so buying both back takes
/// `(slip_b·cl + slip_d·target) / (target − cl)` stroops, plus one for the
/// division's floor.
pub fn unwind_rounding_margin(
    b_rate: i128,
    d_rate: i128,
    cl: i128,
    target_hf: i128,
) -> Result<i128, StrategyError> {
    let denom = target_hf
        .checked_sub(cl)
        .ok_or(StrategyError::UnderflowOverflow)?;
    if denom <= 0 {
        return Err(StrategyError::ArithmeticError);
    }

    let slip_b = b_rate / SCALAR_12 + 2;
    let slip_d = d_rate / SCALAR_12 + 2;
    let margin = slip_b
        .checked_mul(cl)
        .ok_or(StrategyError::ArithmeticError)?
        .checked_add(
            slip_d
                .checked_mul(target_hf)
                .ok_or(StrategyError::ArithmeticError)?,
        )
        .ok_or(StrategyError::UnderflowOverflow)?
        / denom;

    Ok(margin + 1)
}

/// Compute the underlying amount to borrow (and immediately re-supply) to bring
/// HF *down* to `target_hf` — the mirror image of `compute_partial_unwind`.
///
/// Same closed form, opposite sign. Borrowing x and supplying it back raises
/// both sides of the position by x:
///   (B + x) × cl = target_hf × (D + x)
///   x = (B × cl − target_hf × D) / (target_hf − cl)
///
/// which is `compute_partial_unwind`'s `x = (B×cl − t×D) / (cl − t)` with the
/// denominator negated. The shared numerator is the position's distance from the
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
        .fixed_mul_floor(d_rate, SCALAR_12)
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
    // can still settle the HF a unit or so under the target, which is why
    // `releverage` checks the settled HF only against `orange_hf` — a floor the
    // target clears by `RELEVERAGE_HF_BUFFER`.
    Ok((numerator
        .checked_div(denom)
        .ok_or(StrategyError::DivisionByZero)?
        - 1)
    .max(0))
}

// ── Harvest settlement floor (audit M-4) ─────────────────────────────────────
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
