use crate::constants::{MAX_LOOPS, MAX_SAFE_UTILIZATION, SCALAR_12, SCALAR_7};
use crate::storage::{Config, LeverageReserves, LockedProfit};
use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{panic_with_error, Env};

// ── Leverage loop computation ────────────────────────────────────────────────
//
// A deposit is levered to the position the n-loop geometric series builds:
// n (supply, borrow) pairs + 1 final supply-only, identical to
// `compute_requests()` in src/bin/execute_loop.rs.
//
// Loop 0:   supply initial,        borrow initial × c
// Loop 1:   supply initial × c,    borrow initial × c²
// …
// Loop n-1: supply initial × c^(n-1), borrow initial × c^n
// Final:    supply initial × c^n      (no borrow)
//
// Every supply after the first is the previous borrow, so the totals satisfy
// `S = initial + D`. `compute_totals` sums the series and `submit_leverage_loop`
// sends the two totals as one supply + one borrow.

/// Total `(supply, borrow)` of the `n_loops`-deep loop (capped at `MAX_LOOPS`),
/// each layer floored as the loop floors it. `S − D = initial_amount` exactly.
pub fn compute_totals(
    initial_amount: i128,
    c_factor: i128,
    n_loops: u32,
) -> Result<(i128, i128), StrategyError> {
    let mut layer = initial_amount;
    let mut total_borrow = 0i128;
    for _ in 0..n_loops.min(MAX_LOOPS) {
        layer = layer
            .checked_mul(c_factor)
            .ok_or(StrategyError::ArithmeticError)?
            / SCALAR_7;
        total_borrow = total_borrow
            .checked_add(layer)
            .ok_or(StrategyError::UnderflowOverflow)?;
    }
    let total_supply = initial_amount
        .checked_add(total_borrow)
        .ok_or(StrategyError::UnderflowOverflow)?;
    Ok((total_supply, total_borrow))
}

/// The loop's individual `(supply, borrow)` steps, the last borrow 0, and the
/// step count. Test-only: the reference `compute_totals` is checked against,
/// and the request sequence of the stepped loop the integration tests compare
/// the single submit with.
#[cfg(test)]
pub fn compute_loop_pairs(
    initial_amount: i128,
    c_factor: i128,
    n_loops: u32,
) -> (
    [i128; MAX_LOOPS as usize + 1],
    [i128; MAX_LOOPS as usize + 1],
    u32,
) {
    let n = n_loops.min(MAX_LOOPS) as usize;
    let mut supplies = [0i128; MAX_LOOPS as usize + 1];
    let mut borrows = [0i128; MAX_LOOPS as usize + 1];

    let mut balance = initial_amount;
    for i in 0..=n {
        supplies[i] = balance;
        if i < n {
            borrows[i] = balance * c_factor / SCALAR_7;
        }
        balance = borrows[i];
    }

    (supplies, borrows, n as u32 + 1)
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

/// Reference notional for the design-leverage derivation below. Large enough
/// that per-layer truncation is immaterial across the full 20-loop range (the
/// smallest layer at c = 0.5 is still ~9.5e5 stroops), small enough that
/// `B × c_factor × l_factor` stays many orders inside i128.
const DESIGN_NOTIONAL: i128 = 1_000_000_000_000; // 1e12

/// The health factor a position freshly levered to `target_loops` sits at — the
/// vault's *design* leverage expressed as an HF.
///
/// Derived by running the same `compute_totals` the deposit path runs, so the
/// two cannot drift: whatever leverage `deposit` actually builds is the leverage
/// this returns an HF for.
///
/// HF and leverage are the same statement about a position. At `HF = h` the
/// ratio `B/D` is pinned to `h / cl`, hence `B/E = h / (h − cl)` — so capping
/// `releverage`'s target HF at this value is exactly capping the position's
/// leverage at `target_loops`, with no separate ratio check to keep in sync.
/// Both sides carry the same live `l_factor`, so the resulting leverage ratio
/// matches the design regardless of what the pool's liability markup is.
pub fn design_health_factor(
    c_factor: i128,
    target_loops: u32,
    l_factor: i128,
) -> Result<i128, StrategyError> {
    let (supply, borrow) = compute_totals(DESIGN_NOTIONAL, c_factor, target_loops)?;
    // `compute_totals` returns underlying amounts, so feeding them in at unit
    // rates (SCALAR_12 = 1.0) treats them as their own token quantities.
    compute_health_factor(supply, borrow, SCALAR_12, SCALAR_12, c_factor, l_factor)
}

// ── Safety checks ────────────────────────────────────────────────────────────

/// Refuse when the pool's utilization is above `MAX_SAFE_UTILIZATION`.
///
/// `deposit` runs this on the current figures before its Blend submit (no new
/// borrow demand on an already-strained pool), and `deposit` and `releverage`
/// run it on the settled figures after theirs (the submit itself must not have
/// pushed the pool past the cap). Reading the settled pool replaces projecting
/// the submit's effect onto it. The harvest paths, which lever in only swapped
/// rewards, are not gated.
pub fn check_pool_utilization(
    e: &Env,
    pool_supply_underlying: i128,
    pool_borrow_underlying: i128,
) -> Result<(), StrategyError> {
    if pool_supply_underlying > 0 {
        let util = pool_borrow_underlying
            .checked_mul(SCALAR_7)
            .ok_or(StrategyError::ArithmeticError)?
            .checked_div(pool_supply_underlying)
            .ok_or(StrategyError::DivisionByZero)?;

        if util > MAX_SAFE_UTILIZATION {
            panic_with_error!(e, StrategyError::ExternalError);
        }
    }
    Ok(())
}

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
