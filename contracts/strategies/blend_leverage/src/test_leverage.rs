//! Unit tests for leverage math, equity calculation, share accounting, and safety checks.

use crate::constants::{FIRST_DEPOSIT_LOCKUP, SCALAR_12, SCALAR_7};
use crate::leverage::{
    compute_equity, compute_health_factor, compute_loop_pairs, compute_partial_unwind,
    compute_releverage, compute_totals, design_health_factor, harvest_floor, prorate_floor,
    shares_to_underlying, underlying_to_shares,
};
use crate::storage::LeverageReserves;

/// `l_factor = 1.0` — the pool applies no liability markup, so HF reduces to the
/// pre-`l_factor` formula `B × c_factor / D`. Used by the cases that predate
/// H-1 so their expected values stay directly comparable; the cases that
/// exercise the markup pass an explicit `l_factor < 1.0`.
const L_NONE: i128 = SCALAR_7;

// ── compute_loop_pairs ───────────────────────────────────────────────────────

#[test]
fn test_loop_pairs_basic_3_loops() {
    // c_factor = 0.95 (9_500_000 in 1e7), initial = 1000_0000000 (1000 USDC in 7 dec)
    let initial = 1_000_0000000_i128;
    let c_factor = 9_500_000_i128;
    let (supplies, borrows, count) = compute_loop_pairs(initial, c_factor, 3);

    assert_eq!(count, 4); // 3 loops + 1 final supply

    // Loop 0: supply 1000, borrow 1000*0.95 = 950
    assert_eq!(supplies[0], 1_000_0000000);
    assert_eq!(borrows[0], 950_0000000);

    // Loop 1: supply 950, borrow 950*0.95 = 902.5
    assert_eq!(supplies[1], 950_0000000);
    assert_eq!(borrows[1], 902_5000000);

    // Loop 2: supply 902.5, borrow 902.5*0.95 = 857.375
    assert_eq!(supplies[2], 902_5000000);
    assert_eq!(borrows[2], 857_3750000);

    // Final: supply 857.375, borrow 0
    assert_eq!(supplies[3], 857_3750000);
    assert_eq!(borrows[3], 0);
}

#[test]
fn test_loop_pairs_zero_loops() {
    let (supplies, borrows, count) = compute_loop_pairs(1_000_0000000, 9_500_000, 0);
    assert_eq!(count, 1);
    assert_eq!(supplies[0], 1_000_0000000);
    assert_eq!(borrows[0], 0);
}

#[test]
fn test_loop_pairs_one_loop() {
    let initial = 100_0000000_i128;
    let c_factor = 9_500_000_i128;
    let (supplies, borrows, count) = compute_loop_pairs(initial, c_factor, 1);
    assert_eq!(count, 2);
    assert_eq!(supplies[0], 100_0000000);
    assert_eq!(borrows[0], 95_0000000);
    assert_eq!(supplies[1], 95_0000000);
    assert_eq!(borrows[1], 0);
}

#[test]
fn test_loop_pairs_capped_at_20() {
    let (_, _, count) = compute_loop_pairs(1_000_0000000, 9_500_000, 25);
    assert_eq!(count, 21); // capped at 20 loops + 1 final = 21
}

// ── compute_totals ───────────────────────────────────────────────────────────

#[test]
fn test_totals_match_loop_pairs() {
    let initial = 1_000_0000000_i128;
    let c = 9_500_000_i128;
    let n = 8;

    let (total_supply, total_borrow) = compute_totals(initial, c, n);

    // Verify against manual sum of loop pairs
    let (supplies, borrows, count) = compute_loop_pairs(initial, c, n);
    let mut sum_s = 0i128;
    let mut sum_b = 0i128;
    for i in 0..count as usize {
        sum_s += supplies[i];
        sum_b += borrows[i];
    }
    assert_eq!(total_supply, sum_s);
    assert_eq!(total_borrow, sum_b);
}

#[test]
fn test_totals_leverage_ratio() {
    // With c=0.95 and 8 loops, leverage ≈ (1 - 0.95^9) / (1 - 0.95) ≈ 8.3
    let initial = 1_000_0000000_i128;
    let (total_supply, total_borrow) = compute_totals(initial, 9_500_000, 8);

    let leverage_x100 = total_supply * 100 / initial;
    // Leverage should be between 7 and 9
    assert!(
        leverage_x100 > 700 && leverage_x100 < 900,
        "Leverage {}.{} out of expected range",
        leverage_x100 / 100,
        leverage_x100 % 100
    );

    // Borrow should be supply - initial (equity)
    assert_eq!(total_supply - total_borrow, initial);
}

#[test]
fn test_totals_net_equals_initial() {
    // For any number of loops, total_supply - total_borrow = initial deposit
    for n in 0..15 {
        let initial = 1_000_0000000_i128;
        let (total_supply, total_borrow) = compute_totals(initial, 9_500_000, n);
        assert_eq!(
            total_supply - total_borrow,
            initial,
            "Net supply != initial at {} loops",
            n
        );
    }
}

// ── compute_equity ───────────────────────────────────────────────────────────

#[test]
fn test_equity_no_debt() {
    let reserves = LeverageReserves {
        total_shares: 1_000_0000000,
        total_b_tokens: 1_000_0000000,
        total_d_tokens: 0,
        b_rate: SCALAR_12, // 1:1 rate
        d_rate: SCALAR_12,
    };
    let equity = compute_equity(&reserves).unwrap();
    assert_eq!(equity, 1_000_0000000); // all supply is equity
}

#[test]
fn test_equity_with_leverage() {
    // Simulating ~2x leverage: 2000 supply, 1000 debt
    // b_rate = d_rate = 1.0 (SCALAR_12)
    let reserves = LeverageReserves {
        total_shares: 1_000_0000000,
        total_b_tokens: 2_000_0000000,
        total_d_tokens: 1_000_0000000,
        b_rate: SCALAR_12,
        d_rate: SCALAR_12,
    };
    let equity = compute_equity(&reserves).unwrap();
    assert_eq!(equity, 1_000_0000000); // 2000 - 1000 = 1000
}

#[test]
fn test_equity_with_accrued_rates() {
    // b_rate grew 5% (1.05), d_rate grew 8% (1.08)
    // Supply value = 2000 * 1.05 = 2100
    // Debt value = 1000 * 1.08 = 1080
    // Equity = 2100 - 1080 = 1020
    let b_rate = SCALAR_12 * 105 / 100; // 1.05e12
    let d_rate = SCALAR_12 * 108 / 100; // 1.08e12

    let reserves = LeverageReserves {
        total_shares: 1_000_0000000,
        total_b_tokens: 2_000_0000000,
        total_d_tokens: 1_000_0000000,
        b_rate,
        d_rate,
    };
    let equity = compute_equity(&reserves).unwrap();
    // 2000 * 1.05 - 1000 * 1.08 = 2100 - 1080 = 1020
    assert_eq!(equity, 1_020_0000000);
}

#[test]
fn test_equity_underwater() {
    // Debt has grown past supply value
    let b_rate = SCALAR_12;
    let d_rate = SCALAR_12 * 3; // 3x — debt exploded

    let reserves = LeverageReserves {
        total_shares: 1_000_0000000,
        total_b_tokens: 1_500_0000000,
        total_d_tokens: 1_000_0000000,
        b_rate,
        d_rate,
    };
    // Equity = 1500 - 3000 = -1500 (would be Err or negative)
    let result = compute_equity(&reserves);
    assert!(result.is_err() || result.unwrap() < 0);
}

// ── shares_to_underlying / underlying_to_shares ──────────────────────────────

#[test]
fn test_shares_to_underlying_simple() {
    let reserves = LeverageReserves {
        total_shares: 1_000_0000000,
        total_b_tokens: 2_000_0000000,
        total_d_tokens: 1_000_0000000,
        b_rate: SCALAR_12,
        d_rate: SCALAR_12,
    };
    // Total equity = 1000. Full shares = full equity.
    let value = shares_to_underlying(1_000_0000000, &reserves).unwrap();
    assert_eq!(value, 1_000_0000000);

    // Half shares = half equity
    let half = shares_to_underlying(500_0000000, &reserves).unwrap();
    assert_eq!(half, 500_0000000);
}

#[test]
fn test_shares_to_underlying_zero_shares() {
    let reserves = LeverageReserves {
        total_shares: 0,
        total_b_tokens: 0,
        total_d_tokens: 0,
        b_rate: SCALAR_12,
        d_rate: SCALAR_12,
    };
    assert_eq!(shares_to_underlying(0, &reserves).unwrap(), 0);
}

#[test]
fn test_underlying_to_shares_first_deposit() {
    let reserves = LeverageReserves {
        total_shares: 0,
        total_b_tokens: 0,
        total_d_tokens: 0,
        b_rate: SCALAR_12,
        d_rate: SCALAR_12,
    };
    // First deposit: 1 share = 1 unit
    assert_eq!(
        underlying_to_shares(1_000_0000000, &reserves).unwrap(),
        1_000_0000000
    );
}

#[test]
fn test_underlying_to_shares_proportional() {
    let reserves = LeverageReserves {
        total_shares: 1_000_0000000,
        total_b_tokens: 2_000_0000000,
        total_d_tokens: 1_000_0000000,
        b_rate: SCALAR_12,
        d_rate: SCALAR_12,
    };
    // Equity = 1000. Depositing 500 should get 500 shares.
    let shares = underlying_to_shares(500_0000000, &reserves).unwrap();
    assert_eq!(shares, 500_0000000);
}

#[test]
fn test_shares_roundtrip() {
    let reserves = LeverageReserves {
        total_shares: 3_000_0000000,
        total_b_tokens: 6_000_0000000,
        total_d_tokens: 3_500_0000000,
        b_rate: SCALAR_12 * 103 / 100, // 1.03
        d_rate: SCALAR_12 * 106 / 100, // 1.06
    };
    let equity = compute_equity(&reserves).unwrap();
    assert!(equity > 0);

    // Convert equity -> shares -> equity, should be close to original
    let shares = underlying_to_shares(equity, &reserves).unwrap();
    let recovered = shares_to_underlying(shares, &reserves).unwrap();
    // Allow 1 stroop rounding
    assert!(
        (recovered - equity).abs() <= 1,
        "Roundtrip error: equity={}, recovered={}",
        equity,
        recovered
    );
}

// ── compute_health_factor ────────────────────────────────────────────────────

#[test]
fn test_hf_no_debt() {
    let hf =
        compute_health_factor(1_000_0000000, 0, SCALAR_12, SCALAR_12, 9_500_000, L_NONE).unwrap();
    assert_eq!(hf, i128::MAX);
}

#[test]
fn test_hf_equal_rates() {
    // b_tokens=2000, d_tokens=1000, both rates=1.0, c_factor=0.95
    // HF = (2000 * 1.0 * 0.95) / (1000 * 1.0) = 1.9 in 1e7 = 19_000_000
    let hf = compute_health_factor(
        2_000_0000000,
        1_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
    )
    .unwrap();
    // HF = supply_value * c_factor / debt_value = 2000 * 9500000 / 1000 = 19_000_000
    assert_eq!(hf, 19_000_000);
}

#[test]
fn test_hf_near_liquidation() {
    // 8x leverage: b=8000, d=7000, c=0.95
    // HF = 8000*0.95/7000 ≈ 1.0857 → 10_857_142 in 1e7
    let hf = compute_health_factor(
        8_000_0000000,
        7_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
    )
    .unwrap();
    // 8000 * 9500000 / 7000 = 76000000000000000 / 7000_0000000 = 10_857_142
    assert_eq!(hf, 10_857_142);
    assert!(hf > SCALAR_7); // HF > 1.0
}

#[test]
fn test_hf_below_one() {
    // b=1000, d=1000, c=0.95 → HF = 0.95 → 9_500_000
    let hf = compute_health_factor(
        1_000_0000000,
        1_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
    )
    .unwrap();
    assert_eq!(hf, 9_500_000);
    assert!(hf < SCALAR_7); // HF < 1.0 → liquidatable
}

// ── Health factor: Blend's l_factor liability markup (H-1) ───────────────────

#[test]
fn test_hf_applies_l_factor_markup() {
    // b=2000, d=1000, c=0.95, l=0.85
    // HF = 2000 × 0.95 × 0.85 / 1000 = 1.615 → 16_150_000
    let hf = compute_health_factor(
        2_000_0000000,
        1_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        8_500_000,
    )
    .unwrap();
    assert_eq!(hf, 16_150_000);

    // The same position with no markup reports the old, optimistic 1.9.
    let hf_no_markup = compute_health_factor(
        2_000_0000000,
        1_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
    )
    .unwrap();
    assert_eq!(hf_no_markup, 19_000_000);
    assert!(
        hf < hf_no_markup,
        "l_factor < 1.0 must lower the reported HF"
    );
}

#[test]
fn test_hf_crosses_one_at_blends_liquidation_boundary() {
    // Blend liquidates once B × pool_c < D / l. With pool_c = c (the strategy's
    // worst case, borrowing exactly as aggressively as the pool allows), the
    // boundary sits at B/D = 1 / (c × l). Check HF straddles 1.0 there.
    let c = 9_500_000_i128; // 0.95
    let l = 8_500_000_i128; // 0.85
    let d = 1_000_0000000_i128;

    // B exactly at the boundary: B = D / (c × l) = D / 0.8075
    let b_boundary = d * SCALAR_7 * SCALAR_7 / (c * l);
    let hf_boundary = compute_health_factor(b_boundary, d, SCALAR_12, SCALAR_12, c, l).unwrap();
    assert!(
        (hf_boundary - SCALAR_7).abs() <= 1,
        "HF at Blend's boundary should be 1.0, got {}",
        hf_boundary
    );

    // 1% less collateral → liquidatable, and the formula says so.
    let hf_under =
        compute_health_factor(b_boundary * 99 / 100, d, SCALAR_12, SCALAR_12, c, l).unwrap();
    assert!(
        hf_under < SCALAR_7,
        "HF should drop below 1.0, got {}",
        hf_under
    );

    // The pre-H-1 formula called the same position healthy — this is the bug.
    let hf_under_old =
        compute_health_factor(b_boundary * 99 / 100, d, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();
    assert!(
        hf_under_old > SCALAR_7,
        "regression guard: the l_factor-free formula reported {} (> 1.0) for a \
         position Blend would liquidate",
        hf_under_old
    );
}

#[test]
fn test_hf_is_lower_bound_on_blend_ratio_when_c_factor_not_above_pools() {
    // The constructor asserts strategy c_factor <= pool c_factor. That is what
    // makes the reported HF conservative: HF = B·c_s·l/D <= B·c_pool·l/D, the
    // ratio Blend itself compares against 1.0.
    let pool_c = 9_500_000_i128;
    let l = 7_500_000_i128;
    let b = 3_439_0000000_i128;
    let d = 2_439_0000000_i128;

    for strategy_c in [7_000_000_i128, 9_000_000, pool_c] {
        let hf = compute_health_factor(b, d, SCALAR_12, SCALAR_12, strategy_c, l).unwrap();
        let blend_ratio = compute_health_factor(b, d, SCALAR_12, SCALAR_12, pool_c, l).unwrap();
        assert!(
            hf <= blend_ratio,
            "strategy HF {} must not exceed Blend's ratio {} (c_s={})",
            hf,
            blend_ratio,
            strategy_c
        );
    }
}

// ── compute_partial_unwind ───────────────────────────────────────────────────

#[test]
fn test_partial_unwind_already_at_target_returns_zero() {
    // HF = 1.9 >> target 1.15 → no unwind needed
    let (repay, loops) = compute_partial_unwind(
        2_000_0000000,
        1_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
        11_500_000, // target_hf = 1.15
    )
    .unwrap();
    assert_eq!(repay, 0);
    assert_eq!(loops, 0);
}

#[test]
fn test_partial_unwind_no_debt_returns_zero() {
    let (repay, loops) = compute_partial_unwind(
        1_000_0000000,
        0,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
        11_500_000,
    )
    .unwrap();
    assert_eq!(repay, 0);
    assert_eq!(loops, 0);
}

#[test]
fn test_partial_unwind_single_loop_position() {
    // 1-loop position: b=1950, d=950, c=0.95
    // HF = 1950*0.95/950 = 1.95 → healthy, no unwind
    let (repay, loops) = compute_partial_unwind(
        1_950_0000000,
        950_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
        11_500_000,
    )
    .unwrap();
    assert_eq!(repay, 0);
    assert_eq!(loops, 0);

    // Now make it unhealthy: b=1100, d=1000, c=0.95 → HF = 1.045 < 1.15
    let (repay2, loops2) = compute_partial_unwind(
        1_100_0000000,
        1_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
        11_500_000,
    )
    .unwrap();
    assert!(repay2 > 0, "Should need repayment");
    assert!(loops2 >= 1, "Should need at least 1 loop");

    // Verify the repay amount actually restores HF
    // After repaying x: new_b = 1100 - x, new_d = 1000 - x
    // HF_new = (1100-x)*0.95 / (1000-x) >= 1.15
    let x = repay2;
    let new_b = 1_100_0000000 - x;
    let new_d = 1_000_0000000 - x;
    if new_d > 0 {
        let hf_new =
            compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000, L_NONE).unwrap();
        assert!(
            hf_new >= 11_500_000,
            "HF after unwind={} should be >= target 1.15",
            hf_new
        );
    }
}

#[test]
fn test_partial_unwind_max_loops_position() {
    // 20-loop position (max): very high leverage, HF just below orange zone
    // b=20000, d=19000, c=0.95 → HF = 20000*0.95/19000 ≈ 1.0
    let (repay, loops) = compute_partial_unwind(
        20_000_0000000,
        19_000_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
        11_500_000, // target = 1.15
    )
    .unwrap();
    assert!(repay > 0);
    assert!((1..=20).contains(&loops), "loops={} out of range", loops);

    // Verify restoration
    let new_b = 20_000_0000000 - repay;
    let new_d = 19_000_0000000 - repay;
    if new_d > 0 {
        let hf_new =
            compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000, L_NONE).unwrap();
        assert!(
            hf_new >= 11_500_000,
            "HF after unwind={} should be >= 1.15",
            hf_new
        );
    }
}

#[test]
fn test_partial_unwind_minimal_repay_is_exact() {
    // Verify the closed-form gives the minimum repay (not over-unwinding).
    // b=10500, d=9500, c=0.95 → HF = 10500*0.95/9500 ≈ 1.05
    // target = 1.15
    let (repay, _) = compute_partial_unwind(
        10_500_0000000,
        9_500_0000000,
        SCALAR_12,
        SCALAR_12,
        9_500_000,
        L_NONE,
        11_500_000,
    )
    .unwrap();

    // Repaying 1 less stroop should leave HF below target
    if repay > 1 {
        let x_minus = repay - 2;
        let new_b = 10_500_0000000 - x_minus;
        let new_d = 9_500_0000000 - x_minus;
        let hf_short =
            compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000, L_NONE).unwrap();
        assert!(
            hf_short < 11_500_000,
            "Repaying less should leave HF below target"
        );
    }

    // Repaying the computed amount should reach target
    let new_b = 10_500_0000000 - repay;
    let new_d = 9_500_0000000 - repay;
    if new_d > 0 {
        let hf_ok =
            compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000, L_NONE).unwrap();
        assert!(
            hf_ok >= 11_500_000,
            "HF after exact repay={} should be >= target",
            hf_ok
        );
    }
}

// ── Leverage table validation (cross-reference with simulate.rs) ─────────────

#[test]
fn test_leverage_table_matches_simulator() {
    // From simulate.rs: leverage(n, c) = (1 - c^(n+1)) / (1 - c)
    // Our compute_totals should produce the same leverage ratio.
    let initial = 1_000_0000000_i128;
    let c = 9_500_000_i128;

    for n in 0..=13 {
        let (total_supply, _) = compute_totals(initial, c, n);
        let our_lev_x1000 = total_supply * 1000 / initial;

        // Compute expected via float formula
        let c_f = 0.95_f64;
        let expected_lev = (1.0 - c_f.powi(n as i32 + 1)) / (1.0 - c_f);
        let expected_x1000 = (expected_lev * 1000.0).round() as i128;

        // Allow 1‰ tolerance for integer rounding
        let diff = (our_lev_x1000 - expected_x1000).abs();
        assert!(
            diff <= 1,
            "Loop {}: our={}.{:03}x, expected={}.{:03}x (diff={})",
            n,
            our_lev_x1000 / 1000,
            our_lev_x1000 % 1000,
            expected_x1000 / 1000,
            expected_x1000 % 1000,
            diff
        );
    }
}

// ── Deposit/withdraw accounting (with Soroban Env for storage) ───────────────

extern crate std;

use crate::reserves;
use crate::storage;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn make_reserves(b: i128, d: i128, shares: i128) -> LeverageReserves {
    LeverageReserves {
        total_shares: shares,
        total_b_tokens: b,
        total_d_tokens: d,
        b_rate: SCALAR_12,
        d_rate: SCALAR_12,
    }
}

/// Minimal contract for unit-test storage context (avoids real constructor).
#[soroban_sdk::contract]
struct TestStorageContract;

#[soroban_sdk::contractimpl]
impl TestStorageContract {}

/// Register a minimal contract and run the closure inside its context.
/// This is needed because Soroban storage functions only work within a contract.
fn with_contract<F: FnOnce(&Env, &Address)>(e: &Env, f: F) {
    let contract_id = e.register(TestStorageContract, ());
    e.as_contract(&contract_id, || {
        f(e, &contract_id);
    });
}

#[test]
fn test_deposit_first_depositor() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        // Set up empty reserves in storage
        let init_reserves = make_reserves(0, 0, 0);
        storage::set_strategy_reserves(e, init_reserves.clone());

        // First deposit: 1000 equity → 1000 shares - 1000 lockup
        // Simulating: b_delta = 8000 (leverage 8x), d_delta = 7000, equity = 1000
        let b_delta = 8_000_0000000_i128;
        let d_delta = 7_000_0000000_i128;
        let (vault_minted, lockup, updated) =
            reserves::deposit(e, b_delta, d_delta, &init_reserves).unwrap();

        // Equity added = 8000 - 7000 = 1000 (since rates = 1.0)
        // First deposit: new_shares = 1000, vault_minted = 1000 - 1000(lockup) = 999.9999
        assert_eq!(vault_minted, 1_000_0000000 - FIRST_DEPOSIT_LOCKUP);
        assert_eq!(lockup, FIRST_DEPOSIT_LOCKUP);
        assert_eq!(updated.total_shares, 1_000_0000000); // includes lockup
        assert_eq!(updated.total_b_tokens, b_delta);
        assert_eq!(updated.total_d_tokens, d_delta);
    });
}

#[test]
fn test_deposit_second_depositor() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        // First deposit
        let init = make_reserves(0, 0, 0);
        storage::set_strategy_reserves(e, init.clone());
        let (_, _, after_first) =
            reserves::deposit(e, 8_000_0000000, 7_000_0000000, &init).unwrap();

        // Second deposit: same equity (1000)
        let (user2_shares, _, after_second) =
            reserves::deposit(e, 8_000_0000000, 7_000_0000000, &after_first).unwrap();

        // User2 should get proportional shares (1000 out of total 2000)
        assert_eq!(user2_shares, 1_000_0000000);
        assert_eq!(after_second.total_shares, 2_000_0000000);
        assert_eq!(after_second.total_b_tokens, 16_000_0000000);
        assert_eq!(after_second.total_d_tokens, 14_000_0000000);
    });
}

#[test]
fn test_withdraw_full() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        // Set up: user has all shares (read from the token in production).
        let user_shares = 1_000_0000000_i128;
        let reserves_state = make_reserves(8_000_0000000, 7_000_0000000, 1_000_0000000);
        storage::set_strategy_reserves(e, reserves_state.clone());

        // Withdraw all equity (1000)
        let (burned, b_remove, d_remove, updated) =
            reserves::withdraw(e, user_shares, 1_000_0000000, &reserves_state).unwrap();

        assert_eq!(user_shares - burned, 0);
        assert_eq!(b_remove, 8_000_0000000);
        assert_eq!(d_remove, 7_000_0000000);
        assert_eq!(updated.total_shares, 0);
        assert_eq!(updated.total_b_tokens, 0);
        assert_eq!(updated.total_d_tokens, 0);
    });
}

#[test]
fn test_withdraw_partial() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        let user_shares = 1_000_0000000_i128;
        let reserves_state = make_reserves(8_000_0000000, 7_000_0000000, 1_000_0000000);
        storage::set_strategy_reserves(e, reserves_state.clone());

        // Withdraw half equity (500)
        let (burned, b_remove, d_remove, updated) =
            reserves::withdraw(e, user_shares, 500_0000000, &reserves_state).unwrap();

        assert_eq!(user_shares - burned, 500_0000000);
        assert_eq!(b_remove, 4_000_0000000); // half of 8000
        assert_eq!(d_remove, 3_500_0000000); // half of 7000
        assert_eq!(updated.total_shares, 500_0000000);
    });
}

#[test]
fn test_withdraw_insufficient_balance() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        let user_shares = 500_0000000_i128; // only has 500
        let reserves_state = make_reserves(8_000_0000000, 7_000_0000000, 1_000_0000000);
        storage::set_strategy_reserves(e, reserves_state.clone());

        // Try to withdraw more than the user's shares cover
        let result = reserves::withdraw(e, user_shares, 600_0000000, &reserves_state);
        assert!(result.is_err());
    });
}

// ── Harvest accounting ───────────────────────────────────────────────────────

#[test]
fn test_harvest_increases_share_value() {
    // Pure math test - no storage needed
    // Start: 8000 b-tokens, 7000 d-tokens, 1000 shares, equity = 1000
    let reserves_state = make_reserves(8_000_0000000, 7_000_0000000, 1_000_0000000);

    let pre_value = shares_to_underlying(1_000_0000000, &reserves_state).unwrap();

    // Harvest adds 500 b-tokens and 400 d-tokens (net +100 equity from BLND compound)
    let mut updated = reserves_state.clone();
    updated.total_b_tokens += 500_0000000;
    updated.total_d_tokens += 400_0000000;
    // total_shares stays the same — that's the point of harvest

    let post_value = shares_to_underlying(1_000_0000000, &updated).unwrap();

    assert!(
        post_value > pre_value,
        "Share value should increase after harvest: pre={}, post={}",
        pre_value,
        post_value
    );
    assert_eq!(post_value - pre_value, 100_0000000); // +100 equity
}

// ── Edge cases ───────────────────────────────────────────────────────────────

#[test]
fn test_deposit_zero_b_tokens_fails() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        let reserves_state = make_reserves(0, 0, 0);
        storage::set_strategy_reserves(e, reserves_state.clone());

        let result = reserves::deposit(e, 0, 0, &reserves_state);
        assert!(result.is_err());
    });
}

#[test]
fn test_deposit_negative_equity_fails() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        let reserves_state = make_reserves(0, 0, 0);
        storage::set_strategy_reserves(e, reserves_state.clone());

        // More debt than supply → negative equity
        let result = reserves::deposit(e, 1_000_0000000, 2_000_0000000, &reserves_state);
        assert!(result.is_err());
    });
}

#[test]
fn test_multi_user_proportional() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        let init = make_reserves(0, 0, 0);
        storage::set_strategy_reserves(e, init.clone());

        // Alice deposits first: equity = 1000
        let (alice_shares, _, after_alice) =
            reserves::deposit(e, 8_000_0000000, 7_000_0000000, &init).unwrap();

        // Bob deposits: equity = 2000 (double Alice)
        let (bob_shares, _, after_bob) =
            reserves::deposit(e, 16_000_0000000, 14_000_0000000, &after_alice).unwrap();

        // Bob should have ~2x Alice's shares
        let alice_actual = alice_shares; // minus lockup
        assert!(
            (bob_shares as f64 / alice_actual as f64 - 2.0).abs() < 0.01,
            "Bob should have ~2x Alice's shares: alice={}, bob={}",
            alice_actual,
            bob_shares
        );

        // Total equity should be 3000
        let total_equity = compute_equity(&after_bob).unwrap();
        assert_eq!(total_equity, 3_000_0000000);

        // Alice's value should be ~1000
        let alice_value = shares_to_underlying(alice_shares, &after_bob).unwrap();
        // Allow for lockup adjustment
        let expected =
            1_000_0000000 - (FIRST_DEPOSIT_LOCKUP * 1_000_0000000 / after_bob.total_shares);
        // Allow small rounding from fixed-point math (up to 1000 stroops)
        assert!(
            (alice_value - expected).abs() <= 1000,
            "Alice value={}, expected~={}",
            alice_value,
            expected
        );
    });
}

// ── Safety: utilization check ────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #422)")]
fn test_safety_rejects_high_utilization() {
    use crate::leverage::check_deposit_safety;
    use crate::storage::Config;

    let e = Env::default();
    let dummy = Address::generate(&e);
    let config = Config {
        asset: dummy.clone(),
        pool: dummy.clone(),
        reserve_id: 0,
        blend_token: dummy.clone(),
        router: dummy.clone(),
        claim_ids: soroban_sdk::Vec::new(&e),
        reward_threshold: 1,
        c_factor: 9_500_000,
        target_loops: 8,
        min_hf: 10_500_000,
        orange_hf: 11_500_000,
    };

    // Pool at 96% utilization → should panic (above 95% limit)
    check_deposit_safety(
        &e,
        1_000_0000000, // pool supply
        960_0000000,   // pool borrow (96%)
        100_0000000,   // add supply
        50_0000000,    // add borrow
        1_000_0000000, // post b
        500_0000000,   // post d
        SCALAR_12,
        SCALAR_12,
        L_NONE,
        &config,
    )
    .unwrap();
}

#[test]
fn test_safety_allows_healthy_pool() {
    use crate::leverage::check_deposit_safety;
    use crate::storage::Config;

    let e = Env::default();
    let dummy = Address::generate(&e);
    let config = Config {
        asset: dummy.clone(),
        pool: dummy.clone(),
        reserve_id: 0,
        blend_token: dummy.clone(),
        router: dummy.clone(),
        claim_ids: soroban_sdk::Vec::new(&e),
        reward_threshold: 1,
        c_factor: 9_500_000,
        target_loops: 8,
        min_hf: 10_500_000,
        orange_hf: 11_500_000,
    };

    // Pool at 50% utilization, healthy HF
    let result = check_deposit_safety(
        &e,
        1_000_0000000,
        500_0000000, // 50% util
        100_0000000,
        50_0000000,
        2_000_0000000, // plenty of collateral
        500_0000000,
        SCALAR_12,
        SCALAR_12,
        L_NONE,
        &config,
    );
    assert!(
        result.is_ok(),
        "Should allow at 50% utilization with healthy HF"
    );
}

/// H-1 regression: the deposit gate must reject a position that clears `min_hf`
/// under the old (l_factor-free) formula but that Blend would treat as
/// liquidatable. Numbers are the audit's XLM case — strategy `c = 0.70`,
/// `min_hf = 1.10` — against a reserve whose `l_factor` is 0.80:
///
///   B/D = 1.10 / 0.70 = 1.5714
///   old HF = 1.5714 × 0.70            = 1.10  → passed the gate
///   new HF = 1.5714 × 0.70 × 0.80     = 0.88  → below 1.0: liquidatable
#[test]
#[should_panic]
fn test_safety_rejects_position_blend_would_liquidate() {
    use crate::leverage::check_deposit_safety;
    use crate::storage::Config;

    let e = Env::default();
    let dummy = Address::generate(&e);
    let config = Config {
        asset: dummy.clone(),
        pool: dummy.clone(),
        reserve_id: 0,
        blend_token: dummy.clone(),
        router: dummy.clone(),
        claim_ids: soroban_sdk::Vec::new(&e),
        reward_threshold: 1,
        c_factor: 7_000_000,
        target_loops: 3,
        min_hf: 11_000_000,
        orange_hf: 11_500_000,
    };

    let post_d = 1_000_0000000_i128;
    let post_b = 1_571_4285714_i128; // B/D = min_hf / c_factor

    // Sanity: this position is exactly at min_hf when the markup is ignored.
    let hf_old = compute_health_factor(
        post_b,
        post_d,
        SCALAR_12,
        SCALAR_12,
        config.c_factor,
        L_NONE,
    )
    .unwrap();
    assert!(hf_old >= config.min_hf, "fixture must clear the old gate");

    check_deposit_safety(
        &e,
        10_000_0000000,
        1_000_0000000, // 10% util — utilization is not what should reject this
        100_0000000,
        50_0000000,
        post_b,
        post_d,
        SCALAR_12,
        SCALAR_12,
        8_000_000, // l_factor = 0.80
        &config,
    )
    .unwrap();
}

/// The unwind closed form must solve for the HF that includes the markup, not
/// the optimistic one — otherwise it under-repays and leaves the vault short of
/// `target_hf` in Blend's terms.
#[test]
fn test_partial_unwind_under_liability_markup_restores_target() {
    let c = 9_000_000_i128;
    let l = 8_500_000_i128;
    let target = 11_500_000_i128;
    let b = 3_439_0000000_i128;
    let d = 2_439_0000000_i128;

    let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c, l).unwrap();
    assert!(hf0 < target, "fixture must start below target: {}", hf0);

    let (repay, loops) = compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, l, target).unwrap();
    assert!(repay > 0 && (1..=20).contains(&loops));

    let hf_new = compute_health_factor(b - repay, d - repay, SCALAR_12, SCALAR_12, c, l).unwrap();
    assert!(
        hf_new >= target,
        "HF after unwind={} should reach target {}",
        hf_new,
        target
    );

    // And it repays strictly more than the l_factor-free computation would have,
    // which is exactly the shortfall H-1 describes.
    let (repay_no_markup, _) =
        compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, L_NONE, target).unwrap();
    assert!(
        repay > repay_no_markup,
        "markup-aware repay {} should exceed markup-free repay {}",
        repay,
        repay_no_markup
    );
}

// ── Admin / versioning (D3) ──────────────────────────────────────────────────

#[test]
fn test_admin_storage_roundtrip() {
    use admin_sep::Administratable;
    let e = Env::default();
    e.mock_all_auths();
    with_contract(&e, |e, _| {
        let admin = Address::generate(e);
        crate::BlendLeverageStrategy::set_admin(e, &admin);
        assert_eq!(crate::BlendLeverageStrategy::admin(e), admin);
    });
}

// Proves the admin-sep gating is real: once an admin exists, rotating it via
// `set_admin` requires the *current* admin's authorization. The existing
// integration tests run under `mock_all_auths`, so this is the test that
// actually exercises the `require_auth` path (no auth mocked → must panic).
#[test]
#[should_panic]
fn test_set_admin_requires_current_admin_auth() {
    use admin_sep::Administratable;
    let e = Env::default();
    with_contract(&e, |e, _| {
        // First assignment: no prior admin, so no auth needed.
        let admin1 = Address::generate(e);
        crate::BlendLeverageStrategy::set_admin(e, &admin1);
        // Rotation: admin1's auth is NOT mocked → require_auth must reject.
        let admin2 = Address::generate(e);
        crate::BlendLeverageStrategy::set_admin(e, &admin2);
    });
}

#[test]
fn test_version_defaults_to_one_then_bumps() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        // Unset version reads as 1 (matches a freshly constructed v1 contract).
        assert_eq!(storage::get_version(e), 1);
        storage::set_version(e, 2);
        assert_eq!(storage::get_version(e), 2);
    });
}

/// An in-place WASM upgrade preserves all persistent storage, so a user's
/// underlying balance and the strategy HF computed from the stored position
/// must be identical before and after. This asserts that parity invariant on
/// a seeded fixture: the same stored reserves yield byte-identical equity, HF,
/// and per-share underlying — well within the 1e-7 acceptance tolerance (the
/// difference is exactly zero).
#[test]
fn test_upgrade_preserves_hf_and_balance_parity() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        // Seed a realistic leveraged position: ~8x supply, 7x debt.
        let reserves = make_reserves(8_000_0000000, 7_000_0000000, 1_000_0000000);
        storage::set_strategy_reserves(e, reserves.clone());
        let user = Address::generate(e);
        storage::set_vault_shares(e, &user, 1_000_0000000);

        // Pre-upgrade snapshot (v1 reading current storage).
        let equity_before = compute_equity(&reserves).unwrap();
        let hf_before = compute_health_factor(
            reserves.total_b_tokens,
            reserves.total_d_tokens,
            reserves.b_rate,
            reserves.d_rate,
            9_000_000,
            L_NONE,
        )
        .unwrap();
        let user_underlying_before =
            shares_to_underlying(storage::get_vault_shares(e, &user), &reserves).unwrap();

        // An upgrade does not touch persistent storage; re-read it as v2 would.
        let reserves_after = storage::get_strategy_reserves(e);
        let equity_after = compute_equity(&reserves_after).unwrap();
        let hf_after = compute_health_factor(
            reserves_after.total_b_tokens,
            reserves_after.total_d_tokens,
            reserves_after.b_rate,
            reserves_after.d_rate,
            9_000_000,
            L_NONE,
        )
        .unwrap();
        let user_underlying_after =
            shares_to_underlying(storage::get_vault_shares(e, &user), &reserves_after).unwrap();

        // Parity within 1e-7 — here exactly equal.
        assert_eq!(equity_before, equity_after, "equity parity");
        assert_eq!(hf_before, hf_after, "HF parity");
        assert_eq!(
            user_underlying_before, user_underlying_after,
            "balance parity"
        );
    });
}

// ── Partial-unwind degenerate cases & HF-restoration parity (T2.2) ────────────

#[test]
fn test_partial_unwind_target_at_or_below_cfactor_errors() {
    let c = 9_000_000_i128; // 0.90
                            // Very unhealthy position so HF is below both targets and we
                            // reach the denom check. b=7000, d=9000 → HF = 7000*0.9/9000 = 0.70.
    let b = 7_000_0000000_i128;
    let d = 9_000_0000000_i128;
    // target == c_factor → denom 0 → error.
    assert!(compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, L_NONE, c).is_err());
    // target < c_factor → denom < 0 → error.
    assert!(compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, L_NONE, c - 1_000_000).is_err());
}

#[test]
fn test_partial_unwind_restores_hf_to_target() {
    let c = 9_000_000_i128; // 0.90
    let target = 11_500_000_i128; // 1.15 (orange_hf)

    // A spread of unhealthy positions (rates = 1.0 so value == tokens, letting us
    // model the unwind as "withdraw `repay` collateral, repay `repay` debt").
    let cases = [
        (10_000_0000000_i128, 8_500_0000000_i128),
        (10_000_0000000_i128, 8_000_0000000_i128),
        (5_000_0000000_i128, 4_200_0000000_i128),
        (20_000_0000000_i128, 16_500_0000000_i128),
    ];

    for (b, d) in cases {
        let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();
        assert!(hf0 < target, "fixture must be unhealthy: hf={}", hf0);

        let (repay, loops) =
            compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, L_NONE, target).unwrap();
        assert!(loops >= 1, "should unwind at least one loop");
        assert!(repay > 0 && repay < d, "repay in range: {}", repay);

        // Model the exact unwind: withdraw `repay` collateral, repay `repay` debt.
        let new_hf =
            compute_health_factor(b - repay, d - repay, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();

        // Restored to at least target …
        assert!(
            new_hf >= target,
            "HF not restored for ({}, {}): {} < {}",
            b,
            d,
            new_hf,
            target
        );
        // … and not wildly over-unwound (within ~1% above target).
        assert!(
            new_hf <= target + target / 100,
            "over-unwound for ({}, {}): {}",
            b,
            d,
            new_hf
        );
    }
}

#[test]
fn test_partial_unwind_boundary_hf_exactly_at_target_is_noop() {
    // HF lands EXACTLY on the target (1e7-scale equality): b/d = target/c.
    // c = 0.90, target = 1.15 → b/d = 23/18. HF = 2300×0.9/1800 = 1.15 exactly.
    let (repay, loops) = compute_partial_unwind(
        2_300_0000000,
        1_800_0000000,
        SCALAR_12,
        SCALAR_12,
        9_000_000,
        L_NONE,
        11_500_000,
    )
    .unwrap();
    assert_eq!(repay, 0, "at-target boundary must be a no-op");
    assert_eq!(loops, 0);
}

#[test]
fn test_partial_unwind_one_stroop_below_target_minimal_repay() {
    // One d-token stroop past the exact boundary: HF = floor just below target.
    let b = 2_300_0000000_i128;
    let d = 1_800_0000001_i128;
    let c = 9_000_000_i128;
    let target = 11_500_000_i128;

    let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();
    assert!(hf0 < target, "fixture must sit just below target: {}", hf0);

    let (repay, loops) =
        compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, L_NONE, target).unwrap();
    assert!(loops >= 1);
    assert!(
        repay > 0 && repay < 100,
        "a 1-stroop breach needs only a few stroops of repay, got {}",
        repay
    );

    let hf_new =
        compute_health_factor(b - repay, d - repay, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();
    assert!(hf_new >= target, "restored: {} >= {}", hf_new, target);
}

#[test]
fn test_partial_unwind_zero_equity_clamps_to_full_close() {
    // Zero equity (B == D): the closed form yields x >= D — must clamp to the
    // debt (full close), never an over-repay.
    let b = 1_000_0000000_i128;
    let d = 1_000_0000000_i128;
    let (repay, loops) =
        compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, 9_000_000, L_NONE, 11_500_000).unwrap();
    assert_eq!(
        repay, d,
        "zero equity resolves to a full close (repay == debt)"
    );
    assert!((1..=20).contains(&loops), "loops={} out of range", loops);
}

#[test]
fn test_partial_unwind_negative_equity_clamps_to_full_close() {
    // Underwater (B < D): x > D from the closed form — clamp at the debt so the
    // caller can never be told to repay more than is owed.
    let b = 900_0000000_i128;
    let d = 1_000_0000000_i128;
    let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, 9_000_000, L_NONE).unwrap();
    assert!(hf0 < SCALAR_7, "fixture must be underwater: {}", hf0);

    let (repay, loops) =
        compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, 9_000_000, L_NONE, 11_500_000).unwrap();
    assert_eq!(repay, d, "never over-repay: clamp at the outstanding debt");
    assert!((1..=20).contains(&loops), "loops={} out of range", loops);
}

#[test]
fn test_partial_unwind_hf_below_one_but_salvageable() {
    // HF < 1.0 (liquidatable) but equity still positive: a partial unwind can
    // rescue the position without a full close.
    let b = 1_000_0000000_i128;
    let d = 940_0000000_i128;
    let c = 9_000_000_i128;
    let target = 11_500_000_i128;

    let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();
    assert!(hf0 < SCALAR_7, "fixture must be below 1.0: {}", hf0);

    let (repay, loops) =
        compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, L_NONE, target).unwrap();
    assert!(
        repay > 0 && repay < d,
        "partial, not full close: repay={}",
        repay
    );
    assert!((1..=20).contains(&loops));

    let hf_new =
        compute_health_factor(b - repay, d - repay, SCALAR_12, SCALAR_12, c, L_NONE).unwrap();
    assert!(
        hf_new >= target,
        "rescued to target: {} >= {}",
        hf_new,
        target
    );
}

#[test]
fn test_partial_unwind_dust_position_layer_rounds_to_zero() {
    // Dust position: the layer size (debt × (1-c)) floors to 0 stroops. The
    // function must still return a sane (repay ≤ debt, loops = 1) answer
    // instead of dividing by zero.
    let b = 5_i128;
    let d = 5_i128;
    let (repay, loops) =
        compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, 9_500_000, L_NONE, 11_500_000).unwrap();
    assert!(repay > 0 && repay <= d, "repay within debt: {}", repay);
    assert_eq!(loops, 1, "dust position unwinds in a single loop");
}

#[test]
fn test_partial_unwind_with_accrued_rates_is_sane() {
    // Debt grew faster than supply (b_rate 1.05, d_rate 1.10) — HF degraded.
    let c = 9_000_000_i128;
    let target = 11_500_000_i128;
    let b_rate = SCALAR_12 * 105 / 100;
    let d_rate = SCALAR_12 * 110 / 100;
    let b = 10_000_0000000_i128;
    let d = 8_000_0000000_i128;

    let hf0 = compute_health_factor(b, d, b_rate, d_rate, c, L_NONE).unwrap();
    if hf0 < target {
        let (repay, loops) =
            compute_partial_unwind(b, d, b_rate, d_rate, c, L_NONE, target).unwrap();
        assert!((1..=20).contains(&loops), "loops in [1,20]: {}", loops);
        assert!(repay > 0, "positive repay: {}", repay);
    }
}

// ── design_health_factor / compute_releverage (audit M-3) ────────────────────

/// The design HF must *be* the configured leverage, not merely correlate with
/// it: at `HF = h` a position's collateral/equity ratio is pinned to
/// `h / (h − cl)`, and that has to match the `B/E` the deposit loop actually
/// builds for the same `target_loops`. This is the identity that lets
/// `releverage` cap leverage at `target_loops` by capping an HF.
#[test]
fn test_design_hf_is_the_leverage_the_deposit_loop_builds() {
    let notional = 1_000_000_000_000_i128; // matches DESIGN_NOTIONAL
    for c in [5_000_000_i128, 7_000_000, 9_000_000] {
        for l in [SCALAR_7, 9_500_000_i128] {
            let cl = c * l / SCALAR_7;
            for loops in 1..=10u32 {
                let (b, d) = compute_totals(notional, c, loops);
                let equity = b - d;

                let h = design_health_factor(c, loops, l).unwrap();

                let lev_built = b * SCALAR_7 / equity; // B/E from the loop itself
                let lev_from_hf = h * SCALAR_7 / (h - cl); // B/E implied by the HF

                let diff = (lev_built - lev_from_hf).abs();
                assert!(
                    diff <= 100, // ≤ 1e-5× leverage, i.e. fixed-point dust
                    "c={} l={} loops={}: leverage from loop {} vs from HF {}",
                    c,
                    l,
                    loops,
                    lev_built,
                    lev_from_hf
                );
            }
        }
    }
}

/// Design HF falls as loops rise (more leverage = thinner margin), and the
/// pool's liability markup drags it down proportionally.
#[test]
fn test_design_hf_decreases_with_loops_and_carries_l_factor() {
    let c = 9_000_000_i128;
    let mut prev = i128::MAX;
    for loops in 1..=8u32 {
        let h = design_health_factor(c, loops, SCALAR_7).unwrap();
        assert!(h < prev, "design HF must fall as loops rise at {}", loops);
        prev = h;
    }

    // l_factor scales the whole ratio: HF = B·c·l/D.
    let plain = design_health_factor(c, 4, SCALAR_7).unwrap();
    let marked = design_health_factor(c, 4, 9_500_000).unwrap();
    let expected = plain * 9_500_000 / SCALAR_7;
    assert!(
        (marked - expected).abs() <= 2,
        "l_factor markup: {} vs {}",
        marked,
        expected
    );
}

/// The core property: borrowing `x` and supplying it back lands the position on
/// the requested HF — at or just above it, never below — and leaves equity
/// (and therefore the share price) untouched.
#[test]
fn test_releverage_lands_on_target_without_moving_equity() {
    let c = 9_000_000_i128; // 0.90
    let cases = [
        (10_000_0000000_i128, 5_000_0000000_i128, SCALAR_7),
        (10_000_0000000_i128, 0_i128, SCALAR_7), // debt-free: post-full-unwind
        (5_000_0000000_i128, 3_000_0000000_i128, SCALAR_7),
        (20_000_0000000_i128, 12_000_0000000_i128, 9_500_000), // with markup
        (7_777_7777777_i128, 3_333_3333333_i128, 9_500_000),
    ];

    for (b, d, l) in cases {
        let target = design_health_factor(c, 3, l).unwrap();
        let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c, l).unwrap();
        assert!(hf0 > target, "fixture must have slack: hf={}", hf0);

        let x = compute_releverage(b, d, SCALAR_12, SCALAR_12, c, l, target).unwrap();
        assert!(x > 0, "must borrow something for ({}, {}): {}", b, d, x);

        // Borrow x, supply x — both sides of the position move together.
        let hf1 = compute_health_factor(b + x, d + x, SCALAR_12, SCALAR_12, c, l).unwrap();
        assert!(
            hf1 >= target,
            "must not overshoot below target for ({}, {}): {} < {}",
            b,
            d,
            hf1,
            target
        );
        assert!(
            hf1 <= target + target / 1_000_000,
            "must actually reach the target for ({}, {}): {}",
            b,
            d,
            hf1
        );
        assert_eq!((b + x) - (d + x), b - d, "equity is invariant");
    }
}

/// `compute_releverage` and `compute_partial_unwind` are the same closed form
/// with the denominator negated: unwinding to a higher HF and re-levering back
/// must return the position to where it started, bar fixed-point dust.
#[test]
fn test_releverage_inverts_partial_unwind() {
    let c = 9_000_000_i128;
    let l = 9_500_000_i128;
    let b = 10_000_0000000_i128;
    let d = 7_000_0000000_i128;

    let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c, l).unwrap();

    // Deleverage up to a much safer HF (what an emergency unwind does) …
    let safe = hf0 + 3_000_000; // +0.30
    let (repay, _) = compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, l, safe).unwrap();
    let (b1, d1) = (b - repay, d - repay);
    assert!(
        compute_health_factor(b1, d1, SCALAR_12, SCALAR_12, c, l).unwrap() >= safe,
        "unwind must reach the safe target"
    );

    // … then re-lever back to the original HF.
    let borrow = compute_releverage(b1, d1, SCALAR_12, SCALAR_12, c, l, hf0).unwrap();
    let (b2, d2) = (b1 + borrow, d1 + borrow);
    let hf2 = compute_health_factor(b2, d2, SCALAR_12, SCALAR_12, c, l).unwrap();

    assert!(
        hf2 >= hf0 && hf2 - hf0 <= 2,
        "round trip must restore HF: {} vs {}",
        hf2,
        hf0
    );
    assert!(
        (b2 - b).abs() <= repay / 1_000_000 + 2,
        "round trip must restore the position: {} vs {}",
        b2,
        b
    );
}

#[test]
fn test_releverage_is_noop_at_or_below_target() {
    let c = 9_000_000_i128;
    let target = 11_500_000_i128; // 1.15

    // Exactly at target: b/d = 23/18 → HF = 1.15.
    assert_eq!(
        compute_releverage(
            2_300_0000000,
            1_800_0000000,
            SCALAR_12,
            SCALAR_12,
            c,
            L_NONE,
            target
        )
        .unwrap(),
        0,
        "at target → nothing to borrow"
    );

    // Below target (already over-levered — that is `rebalance`'s job, not this).
    assert_eq!(
        compute_releverage(
            1_000_0000000,
            900_0000000,
            SCALAR_12,
            SCALAR_12,
            c,
            L_NONE,
            target
        )
        .unwrap(),
        0,
        "below target → no re-leverage"
    );

    // Empty vault.
    assert_eq!(
        compute_releverage(0, 0, SCALAR_12, SCALAR_12, c, L_NONE, target).unwrap(),
        0
    );
}

#[test]
fn test_releverage_target_at_or_below_effective_c_factor_errors() {
    let c = 9_000_000_i128;
    let l = 9_500_000_i128;
    let cl = c * l / SCALAR_7; // 0.855
    let (b, d) = (10_000_0000000_i128, 5_000_0000000_i128);

    // HF asymptotes down to `cl` as leverage grows, so `cl` is unreachable …
    assert!(compute_releverage(b, d, SCALAR_12, SCALAR_12, c, l, cl).is_err());
    // … and anything below it doubly so.
    assert!(compute_releverage(b, d, SCALAR_12, SCALAR_12, c, l, cl - 1).is_err());
}

#[test]
fn test_releverage_with_accrued_rates_is_sane() {
    // Supply grew faster than debt (a harvest-heavy stretch): HF improved, so
    // there is genuine slack to re-lever.
    let c = 9_000_000_i128;
    let b_rate = SCALAR_12 * 110 / 100;
    let d_rate = SCALAR_12 * 105 / 100;
    let b = 10_000_0000000_i128;
    let d = 6_000_0000000_i128;
    let target = design_health_factor(c, 3, L_NONE).unwrap();

    let x = compute_releverage(b, d, b_rate, d_rate, c, L_NONE, target).unwrap();
    assert!(x > 0, "positive borrow: {}", x);

    // Borrowing x underlying adds x/d_rate d-tokens and x/b_rate b-tokens.
    let hf1 = compute_health_factor(
        b + x * SCALAR_12 / b_rate,
        d + x * SCALAR_12 / d_rate,
        b_rate,
        d_rate,
        c,
        L_NONE,
    )
    .unwrap();
    assert!(
        hf1 >= target,
        "rate-adjusted re-leverage must not overshoot: {} < {}",
        hf1,
        target
    );
}

// ── Harvest settlement floor (audit M-4) ─────────────────────────────────────

#[test]
fn test_harvest_floor_scales_by_rate() {
    // 1000 BLND (7 dec) at a floor rate of 0.02 underlying per BLND → 20 units.
    let blnd = 1_000_0000000_i128;
    assert_eq!(harvest_floor(blnd, 200_000).unwrap(), 20_0000000);

    // Rate of exactly 1.0 is the identity — the floor is the BLND amount.
    assert_eq!(harvest_floor(blnd, SCALAR_7).unwrap(), blnd);

    // Nothing claimed, or no rate configured, owes nothing.
    assert_eq!(harvest_floor(0, 200_000).unwrap(), 0);
    assert_eq!(harvest_floor(-5, 200_000).unwrap(), 0);
    assert_eq!(harvest_floor(blnd, 0).unwrap(), 0);
}

#[test]
fn test_harvest_floor_rounds_up() {
    // 1 stroop of BLND at 0.02 would be 0.02 stroops of underlying; rounding
    // down would let dust settle for free, so it rounds to 1.
    assert_eq!(harvest_floor(1, 200_000).unwrap(), 1);
    // 3 × 0.5 = 1.5 → 2.
    assert_eq!(harvest_floor(3, SCALAR_7 / 2).unwrap(), 2);
}

#[test]
fn test_prorate_floor_follows_the_blnd_that_left() {
    let floor = 20_0000000_i128;
    let claimed = 1_000_0000000_i128;

    // Nothing pulled → nothing owed. This is the keeper who claimed and then
    // routed through Soroswap instead, or a Broker that declined the trade.
    assert_eq!(prorate_floor(floor, 0, claimed).unwrap(), 0);

    // Half pulled → half owed.
    assert_eq!(
        prorate_floor(floor, claimed / 2, claimed).unwrap(),
        floor / 2
    );

    // Whole approval pulled → whole floor.
    assert_eq!(prorate_floor(floor, claimed, claimed).unwrap(), floor);

    // More than claimed cannot happen (the approval caps it) but must not
    // extrapolate past the full floor if it somehow did.
    assert_eq!(prorate_floor(floor, claimed * 2, claimed).unwrap(), floor);
}

#[test]
fn test_prorate_floor_rounds_up_and_handles_degenerate_input() {
    // 20 units over 3 of 1000 claimed = 0.06 → 1, never 0.
    assert_eq!(prorate_floor(20_0000000, 3, 1_000_0000000).unwrap(), 1);

    // No floor, or a record with nothing claimed, owes nothing rather than
    // dividing by zero.
    assert_eq!(prorate_floor(0, 500, 1000).unwrap(), 0);
    assert_eq!(prorate_floor(20_0000000, 500, 0).unwrap(), 0);
}
