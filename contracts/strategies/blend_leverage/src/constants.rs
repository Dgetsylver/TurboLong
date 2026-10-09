/// 1 with 7 decimal places — Blend on-chain scalar for factors, rates, ir_mod
pub const SCALAR_7: i128 = 10_000_000;

/// 1 with 12 decimal places — Blend b_rate / d_rate scalar
pub const SCALAR_12: i128 = 1_000_000_000_000;

/// Maximum pool utilization at which new deposits are allowed.
/// Above this, d-tokens become illiquid — liquidators can't redeem them.
pub const MAX_SAFE_UTILIZATION: i128 = 9_500_000; // 0.95 in 1e7

/// Deepest leverage loop a strategy can be configured with (`target_loops`).
/// The deposit is one supply + one borrow at any depth; this bounds the series
/// `compute_totals` sums.
pub const MAX_LOOPS: u32 = 20;

/// Inflation attack protection: first depositor lockup
pub const FIRST_DEPOSIT_LOCKUP: i128 = 1000;

/// Minimum ledgers between keeper re-leverages (~1 day at ~5s/ledger).
///
/// Only this direction is rate-limited: deleveraging is an emergency and must
/// stay responsive, while adding leverage back is maintenance that is never
/// urgent. The cap on *how much* leverage
/// `releverage` can add is a level, not a rate (see `RELEVERAGE_HF_BUFFER`), so
/// repeated calls converge rather than compound — this cooldown is about not
/// churning the position through the pool (and the rounding each submit costs)
/// rather than about bounding a compromised keeper.
pub const RELEVERAGE_COOLDOWN_LEDGERS: u32 = 17_280;

/// Hysteresis band above `orange_hf`, 1e7-scaled, for the re-leverage path.
///
/// `releverage` never targets a health factor below `orange_hf + this`, and only
/// fires when the current HF clears that target by the same margin. Without the
/// band a re-leverage would land the position exactly on the rebalance trigger,
/// and the next interest accrual would hand it straight back to `rebalance` —
/// leverage ping-ponging every cooldown for nothing but fees.
///
/// 0.02 sized against the decay it has to outlast: HF decays at roughly the
/// borrow/supply spread (`d(ln HF)/dt ≈ r_supply − r_borrow`), so at a 4-point
/// spread a 1.15 → 1.17 band is ~5 months of drift, and the position spends that
/// whole time levered rather than oscillating.
pub const RELEVERAGE_HF_BUFFER: i128 = 200_000; // 0.02 in 1e7

/// Landing margin above `orange_hf`, 1e7-scaled, for the rebalance path.
///
/// `rebalance` still fires once HF drops below `orange_hf`, but it unwinds to
/// `orange_hf + this` rather than to the trigger itself. The unwind is a single
/// exact repay that lands on its target to within a few 1e-7, and a position
/// parked exactly on the trigger is back under it after a few minutes of
/// interest — without the band the keeper would rebalance on every pass, a
/// sliver of debt at a time.
///
/// 0.01 buys roughly 2.5–5 months of drift at a 2–4 point borrow/supply spread
/// (the decay estimate under `RELEVERAGE_HF_BUFFER`) for about 3% of leverage at
/// c = 0.90. It must stay below `2 × RELEVERAGE_HF_BUFFER`: `releverage` only acts
/// once HF clears `orange_hf` by that much, so a narrower band can never hand a
/// freshly rebalanced position straight back to it.
pub const REBALANCE_HF_BUFFER: i128 = 100_000; // 0.01 in 1e7

const _: () = assert!(REBALANCE_HF_BUFFER < 2 * RELEVERAGE_HF_BUFFER);

/// Ledgers a claim's BLND approval to the swap account stays live (~5 minutes
/// at ~5s/ledger).
///
/// The approval exists for exactly one purpose: to let the off-chain Broker
/// pull the just-claimed BLND in the transaction that follows `harvest_claim`.
/// It was ~1 day (17_280 ledgers), which left a standing pull right over the
/// vault's BLND for the 99.97% of that window when no harvest was in flight.
/// Five minutes is the operational envelope of the claim → swap → settle
/// round trip; anything longer is allowance the flow never uses.
///
/// The expiry is a backstop, not the control: `harvest_reinvest` revokes the
/// allowance when it settles, and `harvest_claim` revokes any stale one before
/// granting a fresh one. What the expiry bounds is the case where neither runs.
pub const HARVEST_APPROVAL_LEDGERS: u32 = 60;

/// Blend v2 request type constants
pub const REQUEST_TYPE_SUPPLY_COLLATERAL: u32 = 2;
pub const REQUEST_TYPE_WITHDRAW_COLLATERAL: u32 = 3;
pub const REQUEST_TYPE_BORROW: u32 = 4;
pub const REQUEST_TYPE_REPAY: u32 = 5;
