#![cfg(test)]
extern crate std;

//! Property-based invariant tests for leverage math using proptest.
//!
//! Each property is run with at least 1 000 randomly-generated cases. Failing
//! inputs are automatically shrunk to the smallest reproducing example by the
//! proptest framework.
//!
//! Invariants verified:
//!   1. total_supply >= total_borrow        (borrow never exceeds supply)
//!   2. total_supply - total_borrow == initial  (net equity preserved)
//!   3. total_supply <= initial / (1 - c)   (geometric-series upper bound)
//!   4. HF is monotone in c_factor          (higher c → strictly higher HF)
//!   5. compute_step supply == balance      (supply leg is always the full balance)
//!   6. compute_step final borrow == 0     (no borrow on the last step)
//!   7. no overflow / panic on large inputs (graceful saturation via checked_mul)

use crate::constants::SCALAR_7;
use crate::leverage::{compute_health_factor, compute_step, compute_totals};
use proptest::prelude::*;

/// Run every proptest property with at least 1 000 cases.
const CASES: u32 = 1_000;

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    // ── Invariant 1 ─────────────────────────────────────────────────────────
    // total_supply is always >= total_borrow for any valid inputs.
    // Rationale: borrowing is always a fraction (c < 1) of supply, so the
    // cumulative sum of borrows can never exceed the cumulative sum of supplies.
    #[test]
    fn inv_total_supply_gte_total_borrow(
        initial  in 1i128..=1_000_000_000_000i128,
        c_factor in 100_000i128..=9_900_000i128,
        n_loops  in 0u32..=20u32,
    ) {
        let (total_supply, total_borrow) = compute_totals(initial, c_factor, n_loops);
        prop_assert!(
            total_supply >= total_borrow,
            "total_supply ({}) < total_borrow ({}) with initial={}, c={}, n={}",
            total_supply, total_borrow, initial, c_factor, n_loops
        );
    }

    // ── Invariant 2 ─────────────────────────────────────────────────────────
    // total_supply - total_borrow == initial (net equity equals initial deposit).
    // Each loop borrows exactly what the next loop supplies, so the only
    // "free" supply is the original deposit.
    #[test]
    fn inv_net_equity_equals_initial(
        initial  in 1i128..=1_000_000_000_000i128,
        c_factor in 100_000i128..=9_900_000i128,
        n_loops  in 0u32..=20u32,
    ) {
        let (total_supply, total_borrow) = compute_totals(initial, c_factor, n_loops);
        prop_assert_eq!(
            total_supply - total_borrow,
            initial,
            "net equity {} != initial {} (c={}, n={})",
            total_supply - total_borrow, initial, c_factor, n_loops
        );
    }

    // ── Invariant 3 ─────────────────────────────────────────────────────────
    // total_supply <= initial * SCALAR_7 / (SCALAR_7 - c_factor).
    // This is the geometric-series upper bound (leverage ≤ 1 / (1 - c)).
    // We allow +1 for integer truncation rounding.
    #[test]
    fn inv_leverage_bounded_by_geometric_series(
        initial  in 1i128..=1_000_000_000i128,   // keep small enough that max_supply fits i128
        c_factor in 100_000i128..=9_500_000i128, // cap at 95% so denominator >= 500_000
        n_loops  in 0u32..=20u32,
    ) {
        let (total_supply, _) = compute_totals(initial, c_factor, n_loops);
        let denominator = SCALAR_7 - c_factor;
        // max_supply = initial × SCALAR_7 / (SCALAR_7 - c_factor)
        // Use i128 arithmetic carefully; denominator >= 500_000 and initial <= 1e9,
        // so initial * SCALAR_7 <= 1e9 * 1e7 = 1e16, well within i128.
        let max_supply = initial * SCALAR_7 / denominator;
        prop_assert!(
            total_supply <= max_supply + 1,
            "total_supply {} exceeds geometric bound {} (initial={}, c={}, n={})",
            total_supply, max_supply, initial, c_factor, n_loops
        );
    }

    // ── Invariant 4 ─────────────────────────────────────────────────────────
    // HF is monotone (non-decreasing) in c_factor for fixed positions and rates.
    // A higher collateral factor means the same supply is worth more as
    // collateral, so the health factor can only increase.
    #[test]
    fn inv_hf_monotone_in_c_factor(
        b_tokens in 1i128..=1_000_000_000i128,
        d_tokens in 1i128..=500_000_000i128,
        rate     in 1_000_000_000_000i128..=2_000_000_000_000i128,
        c_low    in 1_000_000i128..=4_999_999i128,
        c_high   in 5_000_000i128..=9_900_000i128,
    ) {
        let hf_low  = compute_health_factor(b_tokens, d_tokens, rate, rate, c_low);
        let hf_high = compute_health_factor(b_tokens, d_tokens, rate, rate, c_high);
        if let (Ok(hf_l), Ok(hf_h)) = (hf_low, hf_high) {
            prop_assert!(
                hf_h >= hf_l,
                "HF not monotone: c_low={} → hf={}, c_high={} → hf={}",
                c_low, hf_l, c_high, hf_h
            );
        }
    }

    // ── Invariant 5 ─────────────────────────────────────────────────────────
    // compute_step: the supply leg always equals `balance`, regardless of
    // c_factor or is_final.
    #[test]
    fn inv_compute_step_supply_equals_balance(
        balance  in 0i128..=1_000_000_000_000i128,
        c_factor in 0i128..=9_999_999i128,
        is_final in proptest::bool::ANY,
    ) {
        let (supply, _borrow) = compute_step(balance, c_factor, is_final);
        prop_assert_eq!(
            supply, balance,
            "supply {} != balance {} (c={}, final={})",
            supply, balance, c_factor, is_final
        );
    }

    // ── Invariant 6 ─────────────────────────────────────────────────────────
    // compute_step: borrow is exactly 0 on the final step.
    // The last iteration only supplies; no further borrowing is needed.
    #[test]
    fn inv_compute_step_final_borrow_is_zero(
        balance  in 0i128..=1_000_000_000_000i128,
        c_factor in 0i128..=9_999_999i128,
    ) {
        let (_supply, borrow) = compute_step(balance, c_factor, true);
        prop_assert_eq!(
            borrow, 0i128,
            "final step borrow {} != 0 (balance={}, c={})",
            borrow, balance, c_factor
        );
    }

    // ── Invariant 7 ─────────────────────────────────────────────────────────
    // compute_totals must not panic on extreme inputs.
    // checked_mul saturates to 0 on overflow (unwrap_or(0)), so the function
    // should always return without panicking.
    #[test]
    fn inv_no_panic_on_extreme_inputs(
        initial  in 1i128..=i128::MAX / SCALAR_7,
        c_factor in 0i128..=9_999_999i128,
        n_loops  in 0u32..=20u32,
    ) {
        // Must not panic
        let (total_supply, total_borrow) = compute_totals(initial, c_factor, n_loops);
        // Basic sanity: supply and borrow are non-negative
        prop_assert!(total_supply >= 0, "total_supply {} < 0", total_supply);
        prop_assert!(total_borrow >= 0, "total_borrow {} < 0", total_borrow);
    }
}
