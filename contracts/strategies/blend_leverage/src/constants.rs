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

/// Maximum number of leverage loops allowed per deposit transaction.
///
/// Each loop step issues two pool host-function calls (supply-collateral + borrow).
/// Soroban's per-transaction instruction budget and the diminishing marginal supply
/// at high loop counts (c^20 < 0.36 for c = 0.95) make 20 the practical ceiling.
/// The operator-visible `target_loops` in `Config` is the tunable knob; this constant
/// is a hard safety ceiling that prevents misconfiguration from bricking transactions.
///
/// See `leverage::loop_step_count` and `README.md` § "Loop cap rationale" for details.
pub const MAX_LOOPS: u32 = 20;

/// Blend v2 request type constants
pub const REQUEST_TYPE_SUPPLY_COLLATERAL: u32 = 2;
pub const REQUEST_TYPE_WITHDRAW_COLLATERAL: u32 = 3;
pub const REQUEST_TYPE_BORROW: u32 = 4;
pub const REQUEST_TYPE_REPAY: u32 = 5;
