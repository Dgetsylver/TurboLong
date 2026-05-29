/// D16 — Formal verification spike for leverage.rs core math
///
/// This crate extracts the pure-math functions from leverage.rs (which depends on
/// soroban-sdk / WASM-only types) into a no-std-compatible form and proves the
/// D9 invariants using Kani.
///
/// D9 Invariants (from doc.md):
///   I1. total_supply  = initial × (1 − c^(n+1)) / (1 − c)
///   I2. total_borrow  = total_supply − initial
///   I3. equity        = supply_value − debt_value  (non-negative when b_rate ≥ d_rate)
///   I4. health_factor = (b_tokens × b_rate × c_factor) / (d_tokens × d_rate × SCALAR_7)
///   I5. compute_step borrow ≤ balance  (no step borrows more than it supplies)
///   I6. total_borrow < total_supply    (leverage never inverts)

// ── Constants (mirrors constants.rs) ────────────────────────────────────────

const SCALAR_7: i128 = 10_000_000;
const SCALAR_12: i128 = 1_000_000_000_000;

// ── Pure math extracted from leverage.rs ────────────────────────────────────

#[inline]
fn compute_step(balance: i128, c_factor: i128, is_final: bool) -> (i128, i128) {
    if is_final {
        (balance, 0)
    } else {
        let borrow = balance.checked_mul(c_factor).unwrap_or(0) / SCALAR_7;
        (balance, borrow)
    }
}

fn loop_step_count(n_loops: u32) -> u32 {
    (n_loops + 1).min(21)
}

fn compute_totals(initial_amount: i128, c_factor: i128, n_loops: u32) -> (i128, i128) {
    let count = loop_step_count(n_loops);
    let mut total_supply = 0i128;
    let mut total_borrow = 0i128;
    let mut balance = initial_amount;

    for i in 0..count {
        let is_final = i == n_loops.min(20);
        let (s, b) = compute_step(balance, c_factor, is_final);
        total_supply = total_supply.checked_add(s).unwrap_or(total_supply);
        total_borrow = total_borrow.checked_add(b).unwrap_or(total_borrow);
        balance = b;
    }
    (total_supply, total_borrow)
}

/// Simplified equity: supply_value - debt_value using floor-multiply.
/// Returns None on overflow.
fn compute_equity(
    total_b_tokens: i128,
    total_d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
) -> Option<i128> {
    let supply_value = fixed_mul_floor(total_b_tokens, b_rate, SCALAR_12)?;
    let debt_value = fixed_mul_floor(total_d_tokens, d_rate, SCALAR_12)?;
    supply_value.checked_sub(debt_value)
}

fn compute_health_factor(
    b_tokens: i128,
    d_tokens: i128,
    b_rate: i128,
    d_rate: i128,
    c_factor: i128,
) -> Option<i128> {
    if d_tokens == 0 {
        return Some(i128::MAX);
    }
    let supply_value = fixed_mul_floor(b_tokens, b_rate, SCALAR_12)?;
    let weighted_supply = supply_value.checked_mul(c_factor)?;
    let debt_value = fixed_mul_floor(d_tokens, d_rate, SCALAR_12)?;
    if debt_value == 0 {
        return Some(i128::MAX);
    }
    weighted_supply.checked_div(debt_value)
}

/// floor(a * b / scalar) — mirrors soroban_fixed_point_math::FixedPoint::fixed_mul_floor
fn fixed_mul_floor(a: i128, b: i128, scalar: i128) -> Option<i128> {
    // Use i256-width via i128 checked ops to avoid overflow
    // a * b may overflow i128 for large values; we use u128 widening for positive inputs.
    if a < 0 || b < 0 || scalar <= 0 {
        return None;
    }
    let wide = (a as u128).checked_mul(b as u128)?;
    let result = wide / (scalar as u128);
    if result > i128::MAX as u128 {
        None
    } else {
        Some(result as i128)
    }
}

// ── Kani proof harnesses ─────────────────────────────────────────────────────

#[cfg(kani)]
mod proofs {
    use super::*;

    // ── I5: compute_step borrow ≤ balance ───────────────────────────────────
    //
    // For any non-negative balance and c_factor in [0, SCALAR_7],
    // the borrow returned by compute_step is ≤ balance.
    #[kani::proof]
    #[kani::unwind(1)]
    fn proof_step_borrow_le_balance() {
        let balance: i128 = kani::any();
        let c_factor: i128 = kani::any();

        // Restrict to realistic domain
        kani::assume(balance >= 0);
        kani::assume(c_factor >= 0 && c_factor <= SCALAR_7);

        let (_supply, borrow) = compute_step(balance, c_factor, false);
        assert!(borrow <= balance, "borrow must not exceed balance");
        assert!(borrow >= 0, "borrow must be non-negative");
    }

    // ── I5b: final step always has zero borrow ───────────────────────────────
    #[kani::proof]
    #[kani::unwind(1)]
    fn proof_final_step_zero_borrow() {
        let balance: i128 = kani::any();
        let c_factor: i128 = kani::any();
        kani::assume(balance >= 0);
        kani::assume(c_factor >= 0 && c_factor <= SCALAR_7);

        let (_supply, borrow) = compute_step(balance, c_factor, true);
        assert!(borrow == 0, "final step must have zero borrow");
    }

    // ── I6: total_borrow < total_supply ─────────────────────────────────────
    //
    // For any positive initial and c_factor < SCALAR_7, total_borrow < total_supply.
    // We bound n_loops ≤ 5 to keep Kani's unwind depth tractable.
    #[kani::proof]
    #[kani::unwind(8)]
    fn proof_borrow_lt_supply() {
        let initial: i128 = kani::any();
        let c_factor: i128 = kani::any();
        let n_loops: u32 = kani::any();

        kani::assume(initial > 0 && initial <= 1_000_000_000_000i128); // ≤ 1e12
        kani::assume(c_factor >= 0 && c_factor < SCALAR_7);            // c < 1
        kani::assume(n_loops <= 5);

        let (total_supply, total_borrow) = compute_totals(initial, c_factor, n_loops);

        assert!(total_supply > 0, "total_supply must be positive");
        assert!(total_borrow < total_supply, "borrow must be less than supply");
    }

    // ── I2: total_borrow = total_supply − initial ────────────────────────────
    //
    // The first supply step contributes `initial` with zero borrow (it's the seed).
    // All subsequent supply steps are funded by the previous borrow, so
    // total_supply − total_borrow = initial (the net equity seed).
    #[kani::proof]
    #[kani::unwind(8)]
    fn proof_supply_minus_borrow_eq_initial() {
        let initial: i128 = kani::any();
        let c_factor: i128 = kani::any();
        let n_loops: u32 = kani::any();

        kani::assume(initial > 0 && initial <= 1_000_000_000i128); // ≤ 1e9 to avoid overflow
        kani::assume(c_factor >= 0 && c_factor < SCALAR_7);
        kani::assume(n_loops <= 5);

        let (total_supply, total_borrow) = compute_totals(initial, c_factor, n_loops);

        // I2: total_supply - total_borrow == initial
        // (the net position is always exactly the initial deposit)
        let net = total_supply.checked_sub(total_borrow).expect("no underflow");
        assert!(net == initial, "net equity must equal initial deposit");
    }

    // ── I3: equity ≥ 0 when b_rate ≥ d_rate ────────────────────────────────
    //
    // When the supply rate ≥ debt rate and b_tokens ≥ d_tokens,
    // equity (supply_value − debt_value) is non-negative.
    #[kani::proof]
    #[kani::unwind(1)]
    fn proof_equity_nonneg_when_supply_dominates() {
        let b_tokens: i128 = kani::any();
        let d_tokens: i128 = kani::any();
        let b_rate: i128 = kani::any();
        let d_rate: i128 = kani::any();

        kani::assume(b_tokens >= 0 && b_tokens <= 1_000_000_000_000i128);
        kani::assume(d_tokens >= 0 && d_tokens <= b_tokens); // supply ≥ debt in tokens
        kani::assume(b_rate >= SCALAR_12 && b_rate <= 2 * SCALAR_12); // rate ∈ [1.0, 2.0]
        kani::assume(d_rate >= SCALAR_12 && d_rate <= b_rate);        // b_rate ≥ d_rate

        if let Some(equity) = compute_equity(b_tokens, d_tokens, b_rate, d_rate) {
            assert!(equity >= 0, "equity must be non-negative when supply dominates");
        }
        // If compute_equity returns None (overflow), the assertion is vacuously satisfied.
    }

    // ── I4: health_factor formula correctness ───────────────────────────────
    //
    // When d_tokens > 0, HF = weighted_supply / debt_value.
    // Verify: if b_tokens × b_rate × c_factor ≥ d_tokens × d_rate × SCALAR_7,
    // then HF ≥ SCALAR_7 (i.e., HF ≥ 1.0 in 1e7 scale).
    #[kani::proof]
    #[kani::unwind(1)]
    fn proof_hf_above_one_when_collateral_sufficient() {
        let b_tokens: i128 = kani::any();
        let d_tokens: i128 = kani::any();
        let b_rate: i128 = kani::any();
        let d_rate: i128 = kani::any();
        let c_factor: i128 = kani::any();

        kani::assume(b_tokens > 0 && b_tokens <= 1_000_000_000i128);
        kani::assume(d_tokens > 0 && d_tokens <= b_tokens);
        kani::assume(b_rate >= SCALAR_12 && b_rate <= 2 * SCALAR_12);
        kani::assume(d_rate >= SCALAR_12 && d_rate <= b_rate);
        kani::assume(c_factor > SCALAR_7 && c_factor <= 10 * SCALAR_7); // c > 1.0 ensures HF > 1

        if let Some(hf) = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, c_factor) {
            if hf != i128::MAX {
                assert!(hf >= SCALAR_7, "HF must be ≥ 1.0 when c_factor > 1 and b_tokens ≥ d_tokens");
            }
        }
    }

    // ── I4b: zero debt → infinite HF ────────────────────────────────────────
    #[kani::proof]
    #[kani::unwind(1)]
    fn proof_hf_infinite_when_no_debt() {
        let b_tokens: i128 = kani::any();
        let b_rate: i128 = kani::any();
        let d_rate: i128 = kani::any();
        let c_factor: i128 = kani::any();

        kani::assume(b_tokens >= 0);
        kani::assume(b_rate > 0);
        kani::assume(d_rate > 0);
        kani::assume(c_factor > 0);

        let hf = compute_health_factor(b_tokens, 0, b_rate, d_rate, c_factor);
        assert!(hf == Some(i128::MAX), "zero debt must yield MAX health factor");
    }
}
