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

/// Blend v2 request type constants
pub const REQUEST_TYPE_SUPPLY_COLLATERAL: u32 = 2;
pub const REQUEST_TYPE_WITHDRAW_COLLATERAL: u32 = 3;
pub const REQUEST_TYPE_BORROW: u32 = 4;
pub const REQUEST_TYPE_REPAY: u32 = 5;
