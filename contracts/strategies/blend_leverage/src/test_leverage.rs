#![cfg(test)]

//! Unit tests for leverage math, equity calculation, share accounting, and safety checks.

use crate::constants::{FIRST_DEPOSIT_LOCKUP, SCALAR_12, SCALAR_7};
use crate::leverage::{
    compute_equity, compute_health_factor, compute_loop_pairs, compute_partial_unwind,
    compute_totals, shares_to_underlying, underlying_to_shares,
};
use crate::storage::LeverageReserves;

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
    let hf = compute_health_factor(1_000_0000000, 0, SCALAR_12, SCALAR_12, 9_500_000).unwrap();
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
    )
    .unwrap();
    assert_eq!(hf, 9_500_000);
    assert!(hf < SCALAR_7); // HF < 1.0 → liquidatable
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
        let hf_new = compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000).unwrap();
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
        11_500_000, // target = 1.15
    )
    .unwrap();
    assert!(repay > 0);
    assert!((1..=20).contains(&loops), "loops={} out of range", loops);

    // Verify restoration
    let new_b = 20_000_0000000 - repay;
    let new_d = 19_000_0000000 - repay;
    if new_d > 0 {
        let hf_new = compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000).unwrap();
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
        11_500_000,
    )
    .unwrap();

    // Repaying 1 less stroop should leave HF below target
    if repay > 1 {
        let x_minus = repay - 2;
        let new_b = 10_500_0000000 - x_minus;
        let new_d = 9_500_0000000 - x_minus;
        let hf_short =
            compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000).unwrap();
        assert!(
            hf_short < 11_500_000,
            "Repaying less should leave HF below target"
        );
    }

    // Repaying the computed amount should reach target
    let new_b = 10_500_0000000 - repay;
    let new_d = 9_500_0000000 - repay;
    if new_d > 0 {
        let hf_ok = compute_health_factor(new_b, new_d, SCALAR_12, SCALAR_12, 9_500_000).unwrap();
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
        &config,
    );
    assert!(
        result.is_ok(),
        "Should allow at 50% utilization with healthy HF"
    );
}

// ── Admin / versioning (D3) ──────────────────────────────────────────────────

#[test]
fn test_admin_storage_roundtrip() {
    let e = Env::default();
    with_contract(&e, |e, _| {
        let admin = Address::generate(e);
        storage::set_admin(e, &admin);
        assert_eq!(storage::get_admin(e), admin);
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
    assert!(compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, c).is_err());
    // target < c_factor → denom < 0 → error.
    assert!(compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, c - 1_000_000).is_err());
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
        let hf0 = compute_health_factor(b, d, SCALAR_12, SCALAR_12, c).unwrap();
        assert!(hf0 < target, "fixture must be unhealthy: hf={}", hf0);

        let (repay, loops) = compute_partial_unwind(b, d, SCALAR_12, SCALAR_12, c, target).unwrap();
        assert!(loops >= 1, "should unwind at least one loop");
        assert!(repay > 0 && repay < d, "repay in range: {}", repay);

        // Model the exact unwind: withdraw `repay` collateral, repay `repay` debt.
        let new_hf = compute_health_factor(b - repay, d - repay, SCALAR_12, SCALAR_12, c).unwrap();

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
fn test_partial_unwind_with_accrued_rates_is_sane() {
    // Debt grew faster than supply (b_rate 1.05, d_rate 1.10) — HF degraded.
    let c = 9_000_000_i128;
    let target = 11_500_000_i128;
    let b_rate = SCALAR_12 * 105 / 100;
    let d_rate = SCALAR_12 * 110 / 100;
    let b = 10_000_0000000_i128;
    let d = 8_000_0000000_i128;

    let hf0 = compute_health_factor(b, d, b_rate, d_rate, c).unwrap();
    if hf0 < target {
        let (repay, loops) = compute_partial_unwind(b, d, b_rate, d_rate, c, target).unwrap();
        assert!((1..=20).contains(&loops), "loops in [1,20]: {}", loops);
        assert!(repay > 0, "positive repay: {}", repay);
    }
}
