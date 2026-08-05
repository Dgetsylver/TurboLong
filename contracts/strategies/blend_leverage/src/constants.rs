/// 1 with 7 decimal places — Blend on-chain scalar for factors, rates, ir_mod
pub const SCALAR_7: i128 = 10_000_000;

/// 1 with 12 decimal places — Blend b_rate / d_rate scalar
pub const SCALAR_12: i128 = 1_000_000_000_000;

/// Maximum pool utilization at which new deposits are allowed.
/// Above this, d-tokens become illiquid — liquidators can't redeem them.
pub const MAX_SAFE_UTILIZATION: i128 = 9_500_000; // 0.95 in 1e7

/// Maximum allowed borrow-supply APR spread (percentage points × 1e7).
/// Abnormally high spreads may indicate rate manipulation.
/// Reserved for future rate-spread guard in check_deposit_safety.
#[allow(dead_code)]
pub const MAX_RATE_SPREAD: i128 = 15_000_000; // 15% in 1e7

/// Inflation attack protection: first depositor lockup
pub const FIRST_DEPOSIT_LOCKUP: i128 = 1000;

/// Minimum ledgers between keeper-triggered rebalances (~5 minutes at ~5s/
/// ledger). Rate-limits the automation; the permissionless `rebalance` is
/// unaffected (anyone can always protect a position).
pub const REBALANCE_COOLDOWN_LEDGERS: u32 = 60;

/// Minimum ledgers between keeper re-leverages (~1 day at ~5s/ledger).
///
/// Deliberately far slower than the rebalance cooldown: deleveraging is an
/// emergency and must stay responsive, while adding leverage back is
/// maintenance that is never urgent. The cap on *how much* leverage
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

/// Blend v2 request type constants
pub const REQUEST_TYPE_SUPPLY_COLLATERAL: u32 = 2;
pub const REQUEST_TYPE_WITHDRAW_COLLATERAL: u32 = 3;
pub const REQUEST_TYPE_BORROW: u32 = 4;
pub const REQUEST_TYPE_REPAY: u32 = 5;
