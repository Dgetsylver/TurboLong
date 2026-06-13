use blend_contract_sdk::pool;
use soroban_ledger_snapshot_source_tx::{Network, TxSnapshotSource};
use soroban_sdk::{
    testutils::Address as _,
    token::{StellarAssetClient, TokenClient},
    Address, Env, Vec,
};

/// Etherfuse pool on Blend Protocol (Stellar mainnet)
const POOL_ID: &str = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";

/// User address to inspect for existing positions
const USER_ADDR: &str = "GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA";

/// Stellar mainnet ledger to fork from (fetched 2026-03-11)
const MAINNET_LEDGER: u32 = 61_605_613;

/// All Blend v2 config/rate values are scaled by 1e7
const SCALAR: f64 = 1e7;

// ─── Interest rate model ──────────────────────────────────────────────────────
//
// Blend v2 uses a three-kink interest rate curve.
// All curve params (r_base, r_one, r_two, r_three, util, max_util) are 1e7-scaled.
//
// borrow_apr = curve(utilization) × ir_mod
// supply_apr = borrow_apr × utilization × (1 − backstop_take_rate)
//
fn compute_rates(
    reserve: &pool::Reserve,
    bstop_rate: f64, // backstop take rate, 0–1
) -> (f64, f64) {
    let cfg = &reserve.config;

    // Current utilization  (SCALAR cancels → dimensionless ratio)
    let total_borrows = reserve.data.b_supply as f64 * reserve.data.b_rate as f64;
    let total_supply = reserve.data.d_supply as f64 * reserve.data.d_rate as f64;
    let util = if total_supply > 0.0 {
        total_borrows / total_supply
    } else {
        0.0
    };

    let util_target = cfg.util as f64 / SCALAR;
    let max_util = cfg.max_util as f64 / SCALAR;
    let r_base = cfg.r_base as f64 / SCALAR;
    let r_one = cfg.r_one as f64 / SCALAR;
    let r_two = cfg.r_two as f64 / SCALAR;
    let r_three = cfg.r_three as f64 / SCALAR;

    let base_rate = if util <= util_target {
        r_base + r_one * util / util_target
    } else if util <= max_util {
        r_base + r_one + r_two * (util - util_target) / (max_util - util_target)
    } else {
        r_base + r_one + r_two + r_three * (util - max_util) / (1.0 - max_util)
    };

    let ir_mod = reserve.data.ir_mod as f64 / SCALAR;
    let borrow_apr = base_rate * ir_mod;
    let supply_apr = borrow_apr * util * (1.0 - bstop_rate);

    (supply_apr, borrow_apr)
}

// ─── Leverage math ────────────────────────────────────────────────────────────
//
// Strategy: supply USDC as collateral → borrow USDC (up to c_factor × collateral)
//           → re-supply → repeat.
//
// After n loops starting from `initial`:
//   total_supplied(n) = initial × (1 − c^(n+1)) / (1 − c)
//   total_borrowed(n) = total_supplied(n) − initial
//   leverage(n)       = total_supplied(n) / initial
//   health_factor(n)  = (total_supplied × c) / total_borrowed
//
// Maximum (n → ∞):
//   leverage_max      = 1 / (1 − c)          e.g. c=0.95 → 20×
//   health_factor_min = 1.0000               (razor thin)
//
// Since both supplied and borrowed asset are USDC:
//   HF is independent of price → no oracle-based liquidation risk.
//
fn leverage(n: usize, c: f64) -> f64 {
    (1.0 - c.powi(n as i32 + 1)) / (1.0 - c)
}

#[test]
fn simulate_usdc_leverage() {
    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║    Blend Protocol · Etherfuse Pool · USDC Loop Sim      ║");
    println!("╚══════════════════════════════════════════════════════════╝");

    // ── 1. Fork Stellar mainnet ───────────────────────────────────────────────
    println!("\n[1/4] Forking mainnet at ledger {}…", MAINNET_LEDGER);
    println!("      (first run fetches from Stellar RPC and caches locally)");

    let source = TxSnapshotSource::new(Network::mainnet(None), MAINNET_LEDGER, None);
    let env = Env::from_ledger_snapshot(source);

    // ── 2. Connect to pool ────────────────────────────────────────────────────
    let pool_addr = Address::from_str(&env, POOL_ID);
    let pool = pool::Client::new(&env, &pool_addr);

    let pool_cfg = pool.get_config();
    let bstop_rate = pool_cfg.bstop_rate as f64 / SCALAR;

    // ── 3. Discover USDC reserve ──────────────────────────────────────────────
    println!("[2/4] Reading pool reserves…");

    let reserve_list = pool.get_reserve_list();
    println!("\n  Pool assets ({} total):", reserve_list.len());

    let mut usdc_addr: Option<Address> = None;
    for i in 0..reserve_list.len() {
        let asset = reserve_list.get(i).unwrap();
        let token = TokenClient::new(&env, &asset);
        let symbol = token.symbol();
        let is_usdc = symbol == soroban_sdk::String::from_str(&env, "USDC");
        println!(
            "    [{}] {:?}{}",
            i,
            asset,
            if is_usdc { "  ◄ USDC" } else { "" }
        );
        if is_usdc {
            usdc_addr = Some(asset);
        }
    }

    let usdc = usdc_addr.expect("USDC not found among pool reserves");

    // ── 4. Read USDC reserve data ─────────────────────────────────────────────
    println!("\n[3/4] Reading USDC reserve…");
    let reserve = pool.get_reserve(&usdc);
    let cfg = &reserve.config;

    let c_factor = cfg.c_factor as f64 / SCALAR;
    let l_factor = cfg.l_factor as f64 / SCALAR;

    let (supply_apr, borrow_apr) = compute_rates(&reserve, bstop_rate);

    let util = {
        let borrows = reserve.data.b_supply as f64 * reserve.data.b_rate as f64;
        let supply = reserve.data.d_supply as f64 * reserve.data.d_rate as f64;
        if supply > 0.0 {
            borrows / supply
        } else {
            0.0
        }
    };

    // Supply cap + current pool totals.
    let scalar_f = 10_f64.powi(cfg.decimals as i32);
    let pool_supplied =
        reserve.data.d_supply as f64 * reserve.data.d_rate as f64 / SCALAR / scalar_f;
    let pool_borrowed =
        reserve.data.b_supply as f64 * reserve.data.b_rate as f64 / SCALAR / scalar_f;
    let supply_cap_usdc = if cfg.supply_cap > 0 {
        Some(cfg.supply_cap as f64 / scalar_f)
    } else {
        None // 0 = uncapped
    };
    let cap_pct = supply_cap_usdc.map(|cap| pool_supplied / cap * 100.0);
    let cap_room = supply_cap_usdc.map(|cap| cap - pool_supplied);

    // BLND emissions: d-token index = cfg.index * 2, b-token = cfg.index * 2 + 1.
    // eps is in 1e7-scaled BLND per second (1 BLND/s = eps of 1e7).
    const SECONDS_PER_YEAR: f64 = 31_536_000.0;
    let supply_eps = pool
        .get_reserve_emissions(&(cfg.index * 2))
        .map(|e| e.eps)
        .unwrap_or(0);
    let borrow_eps = pool
        .get_reserve_emissions(&(cfg.index * 2 + 1))
        .map(|e| e.eps)
        .unwrap_or(0);
    let pool_supply_blnd_yr = supply_eps as f64 * SECONDS_PER_YEAR / SCALAR;
    let pool_borrow_blnd_yr = borrow_eps as f64 * SECONDS_PER_YEAR / SCALAR;

    // BLND per $1 supplied/borrowed per year (pool-dilution approximation).
    let blnd_per_usdc_supply = if pool_supplied > 0.0 {
        pool_supply_blnd_yr / pool_supplied
    } else {
        0.0
    };
    let blnd_per_usdc_borrow = if pool_borrowed > 0.0 {
        pool_borrow_blnd_yr / pool_borrowed
    } else {
        0.0
    };

    println!("\n  ┌─────────────────────────────────────────────────────────┐");
    println!("  │        USDC Reserve (live from mainnet fork)            │");
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!(
        "  │  Collateral factor (c):  {:>7.1}%                       │",
        c_factor * 100.0
    );
    println!(
        "  │  Liquidation factor:     {:>7.1}%                       │",
        l_factor * 100.0
    );
    println!(
        "  │  Utilization:            {:>7.2}%                       │",
        util * 100.0
    );
    println!(
        "  │  Supply APR:             {:>7.2}%                       │",
        supply_apr * 100.0
    );
    println!(
        "  │  Borrow APR:             {:>7.2}%                       │",
        borrow_apr * 100.0
    );
    println!(
        "  │  Backstop take rate:     {:>7.1}%                       │",
        bstop_rate * 100.0
    );
    println!(
        "  │  IR modifier:            {:>8.4}                       │",
        reserve.data.ir_mod as f64 / SCALAR
    );
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!(
        "  │  Pool supplied:   {:>14.2} USDC                    │",
        pool_supplied
    );
    println!(
        "  │  Pool borrowed:   {:>14.2} USDC                    │",
        pool_borrowed
    );
    match (supply_cap_usdc, cap_pct, cap_room) {
        (Some(cap), Some(pct), Some(room)) => {
            println!(
                "  │  Supply cap:      {:>14.2} USDC  ({:>5.1}% used)     │",
                cap, pct
            );
            println!(
                "  │  Room remaining:  {:>14.2} USDC                    │",
                room
            );
        }
        _ => {
            println!("  │  Supply cap:           uncapped                         │");
        }
    }
    println!("  ├─────────────────────────────────────────────────────────┤");
    if supply_eps == 0 && borrow_eps == 0 {
        println!("  │  BLND emissions:   NONE configured for this reserve     │");
    } else {
        println!(
            "  │  BLND supply eps: {:>12} (raw 1e7-scaled BLND/s)   │",
            supply_eps
        );
        println!(
            "  │  BLND borrow eps: {:>12} (raw 1e7-scaled BLND/s)   │",
            borrow_eps
        );
        println!(
            "  │  Pool supply BLND/yr: {:>10.1}                       │",
            pool_supply_blnd_yr
        );
        println!(
            "  │  Pool borrow BLND/yr: {:>10.1}                       │",
            pool_borrow_blnd_yr
        );
        println!(
            "  │  Per $1 supplied: {:>10.4} BLND/yr                    │",
            blnd_per_usdc_supply
        );
        println!(
            "  │  Per $1 borrowed: {:>10.4} BLND/yr                    │",
            blnd_per_usdc_borrow
        );
        println!("  │  ⚠  Net APY below excludes BLND. Multiply by price.   │");
    }
    println!("  └─────────────────────────────────────────────────────────┘");

    // ── 5. Show user's current positions ─────────────────────────────────────
    let user = Address::from_str(&env, USER_ADDR);
    let positions = pool.get_positions(&user);
    println!(
        "\n  User positions ({}…{}):",
        &USER_ADDR[..6],
        &USER_ADDR[USER_ADDR.len() - 4..]
    );
    if positions.collateral.is_empty() && positions.liabilities.is_empty() {
        println!("    None — using hypothetical $1,000 USDC for simulation below");
    } else {
        println!("    Collateral positions:  {}", positions.collateral.len());
        println!("    Liability positions:   {}", positions.liabilities.len());
    }

    // ── 6. Leverage simulation ────────────────────────────────────────────────
    println!("\n[4/4] Simulating leverage loops…\n");

    let initial = 1_000.0_f64;
    let max_lev = 1.0 / (1.0 - c_factor);

    println!("  Initial deposit:          ${:.0}", initial);
    println!(
        "  Collateral factor (c):     {:.0}%  (borrow up to c × collateral)",
        c_factor * 100.0
    );
    println!(
        "  Max theoretical leverage:  {:.2}×  (= 1 / (1 − c))",
        max_lev
    );
    println!("  Max leveraged exposure:   ${:.0}", initial * max_lev);

    // Combined BLND per $1 (supply + borrow sides scale together in a loop).
    let blnd_per_usdc_net = blnd_per_usdc_supply + blnd_per_usdc_borrow;

    println!();
    println!(
        "  {:>4}  {:>12}  {:>12}  {:>8}  {:>11}  {:>10}  {:>10}  {}",
        "Loop", "Supplied ($)", "Borrowed ($)", "Leverage", "HF", "Net APY", "BLND/yr", "⚠"
    );
    println!("  {}", "─".repeat(85));

    let mut last_safe_loops = 0usize;

    for n in 0usize..=60 {
        let lev = leverage(n, c_factor);
        let supplied = initial * lev;
        let borrowed = supplied - initial;
        let hf_str = if borrowed > 0.0 {
            format!("{:.4}", (supplied * c_factor) / borrowed)
        } else {
            "      ∞".to_string()
        };

        let net_yield = supply_apr * supplied - borrow_apr * borrowed;
        let net_apy = net_yield / initial * 100.0;

        // BLND per year: supply side + borrow side, scaled by leverage.
        let blnd_yr = supplied * blnd_per_usdc_supply + borrowed * blnd_per_usdc_borrow;

        // Cap warning: flag if leveraged supply would exceed remaining room.
        let cap_warn = match cap_room {
            Some(room) if supplied > pool_supplied + room => "CAP",
            _ => "",
        };

        println!(
            "  {:>4}  {:>12.2}  {:>12.2}  {:>7.2}×  {:>11}  {:>9.2}%  {:>10.1}  {}",
            n, supplied, borrowed, lev, hf_str, net_apy, blnd_yr, cap_warn
        );

        let hf = if borrowed > 0.0 {
            (supplied * c_factor) / borrowed
        } else {
            f64::INFINITY
        };
        if hf >= 1.05 {
            last_safe_loops = n;
        }
        if lev / max_lev > 0.9999 {
            break;
        }
    }

    // Theoretical infinity row
    let max_sup = initial * max_lev;
    let max_bor = max_sup - initial;
    let max_net_apy = (supply_apr * max_sup - borrow_apr * max_bor) / initial * 100.0;
    let max_blnd_yr = max_sup * blnd_per_usdc_supply + max_bor * blnd_per_usdc_borrow;
    let max_cap_warn = match cap_room {
        Some(room) if max_sup > pool_supplied + room => "CAP",
        _ => "",
    };
    println!("  {}", "─".repeat(85));
    println!(
        "  {:>4}  {:>12.2}  {:>12.2}  {:>7.2}×  {:>11.4}  {:>9.2}%  {:>10.1}  {}",
        "∞", max_sup, max_bor, max_lev, 1.0_f64, max_net_apy, max_blnd_yr, max_cap_warn
    );

    // ── 7. Liquidation risk analysis ──────────────────────────────────────────
    println!();
    println!("  ┌─────────────────────────────────────────────────────────┐");
    println!("  │                 Liquidation Risk Analysis               │");
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!("  │  Borrowed asset:  USDC                                  │");
    println!("  │  Collateral:      USDC  (same asset)                    │");
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!("  │  ✓ Price risk: NONE                                      │");
    println!("  │    HF = (supplied × c) / borrowed — price-independent   │");
    println!("  │    USDC/USDC always = 1.0 in the oracle                 │");
    println!("  ├─────────────────────────────────────────────────────────┤");

    let safe_lev = leverage(last_safe_loops, c_factor);
    println!(
        "  │  Safe max: {} loops → {:.2}× leverage (HF ≥ 1.05)  │",
        last_safe_loops, safe_lev,
    );
    println!("  │  At 20× max: HF → 1.0000 — one accrual tick risks liq  │");
    println!("  ├─────────────────────────────────────────────────────────┤");

    if supply_apr > borrow_apr {
        println!(
            "  │  ✓ Rate spread: +{:.2}%  (strategy earns interest)      │",
            (supply_apr - borrow_apr) * 100.0
        );
        println!(
            "  │    Max net interest APY at {:.0}×: {:.2}%               │",
            max_lev, max_net_apy
        );
    } else {
        println!(
            "  │  ✗ Borrow APR ({:.2}%) > Supply APR ({:.2}%)           │",
            borrow_apr * 100.0,
            supply_apr * 100.0
        );
        println!("  │    Interest spread is NEGATIVE — BLND is the only yield │");
    }
    println!("  ├─────────────────────────────────────────────────────────┤");
    if blnd_per_usdc_net > 0.0 {
        let safe_blnd = initial * leverage(last_safe_loops, c_factor) * blnd_per_usdc_supply
            + (initial * leverage(last_safe_loops, c_factor) - initial) * blnd_per_usdc_borrow;
        println!(
            "  │  BLND at safe max ({} loops, {:.2}×): {:.1} BLND/yr   │",
            last_safe_loops,
            leverage(last_safe_loops, c_factor),
            safe_blnd
        );
        println!(
            "  │  BLND at 20× max:  {:.1} BLND/yr                    │",
            max_blnd_yr
        );
        println!("  │  ⚠  BLND earned must be sold to realize APY.           │");
        println!("  │  ⚠  claim() required — does not compound automatically. │");
        if let Some(room) = cap_room {
            if max_sup > pool_supplied + room {
                println!("  │  ⚠  Supply cap hit before 20× — max safe supply:       │");
                println!(
                    "  │     ${:.2} total (cap room: ${:.2})              │",
                    pool_supplied + room,
                    room
                );
            }
        }
    } else {
        println!("  │  No BLND emissions configured for USDC on this pool.   │");
    }
    println!("  └─────────────────────────────────────────────────────────┘");
    println!();
}

// ─── Transaction execution test ───────────────────────────────────────────────
//
// Validates the leverage math by actually executing supply+borrow transactions
// on the mainnet fork and comparing on-chain positions to the theoretical table.
//
// Each loop iteration submits an atomic batch:
//   [SupplyCollateral(balance), Borrow(balance × c_factor)]
//
// After each loop, the returned Positions are converted from d-tokens / b-tokens
// back to underlying USDC using the reserve's current d_rate / b_rate.
//
#[test]
fn execute_leverage_loop() {
    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║   Blend Protocol · Execute & Verify USDC Leverage Loop  ║");
    println!("╚══════════════════════════════════════════════════════════╝");

    // ── 1. Fork Stellar mainnet ───────────────────────────────────────────────
    println!("\n[1/4] Forking mainnet at ledger {}…", MAINNET_LEDGER);
    let source = TxSnapshotSource::new(Network::mainnet(None), MAINNET_LEDGER, None);
    let env = Env::from_ledger_snapshot(source);
    env.mock_all_auths(); // bypass auth for supply/borrow/mint

    // ── 2. Identify USDC reserve ──────────────────────────────────────────────
    println!("[2/4] Connecting to pool and locating USDC reserve…");
    let pool_addr = Address::from_str(&env, POOL_ID);
    let pool = pool::Client::new(&env, &pool_addr);
    let pool_cfg = pool.get_config();
    let bstop_rate = pool_cfg.bstop_rate as f64 / SCALAR;

    let reserve_list = pool.get_reserve_list();
    let mut usdc_addr: Option<Address> = None;
    for i in 0..reserve_list.len() {
        let asset = reserve_list.get(i).unwrap();
        let tok = TokenClient::new(&env, &asset);
        if tok.symbol() == soroban_sdk::String::from_str(&env, "USDC") {
            usdc_addr = Some(asset);
            break;
        }
    }
    let usdc_addr = usdc_addr.expect("USDC not found among pool reserves");

    let reserve = pool.get_reserve(&usdc_addr);
    let cfg = &reserve.config;
    let c_factor = cfg.c_factor as f64 / SCALAR;
    let usdc_decimals = cfg.decimals;
    let usdc_index = cfg.index;
    let scalar_f = 10_f64.powi(usdc_decimals as i32);

    let (supply_apr, borrow_apr) = compute_rates(&reserve, bstop_rate);

    println!(
        "  c_factor = {:.1}%  supply APR = {:.2}%  borrow APR = {:.2}%",
        c_factor * 100.0,
        supply_apr * 100.0,
        borrow_apr * 100.0
    );

    // ── 3. Create test account and fund with 1 000 USDC ──────────────────────
    println!("[3/4] Minting 1 000 USDC to test account…");
    let test_user = Address::generate(&env);
    let initial: i128 = 1_000 * 10_i128.pow(usdc_decimals);

    StellarAssetClient::new(&env, &usdc_addr).mint(&test_user, &initial);

    let usdc_token = TokenClient::new(&env, &usdc_addr);
    assert_eq!(usdc_token.balance(&test_user), initial, "mint failed");

    let initial_f = initial as f64 / scalar_f;

    // ── 4. Execute leverage loops ─────────────────────────────────────────────
    //
    // How many loops to run (13 keeps HF ≥ 1.05 at c=0.95, see doc.md).
    // The last loop in the table (loop 13) still borrows; loop 14 just
    // supplies the proceeds without borrowing to illustrate the final state.
    //
    const N_LOOPS: usize = 13;

    println!("[4/4] Executing {N_LOOPS} supply+borrow loops on mainnet fork…\n");
    println!(
        "  {:>4}  {:>14}  {:>14}  {:>9}  {:>9}  {:>8}",
        "Loop", "Supplied  ($)", "Borrowed  ($)", "Actual", "Theory", "Δ lev"
    );
    println!("  {}", "─".repeat(67));

    for n in 0..N_LOOPS {
        let balance = usdc_token.balance(&test_user);

        // Borrow up to c_factor × supply (integer arithmetic, truncates).
        let borrow_amount = balance * cfg.c_factor as i128 / SCALAR as i128;

        let mut requests = Vec::new(&env);
        requests.push_back(pool::Request {
            request_type: 2, // SupplyCollateral
            address: usdc_addr.clone(),
            amount: balance,
        });
        requests.push_back(pool::Request {
            request_type: 4, // Borrow
            address: usdc_addr.clone(),
            amount: borrow_amount,
        });

        let positions = pool.submit(&test_user, &test_user, &test_user, &requests);

        // Convert d-tokens / b-tokens → underlying USDC using live rates.
        let r = pool.get_reserve(&usdc_addr);
        let d_rate = r.data.d_rate as f64 / SCALAR;
        let b_rate = r.data.b_rate as f64 / SCALAR;

        let coll_dtok = positions.collateral.get(usdc_index).unwrap_or(0);
        let liab_btok = positions.liabilities.get(usdc_index).unwrap_or(0);

        let actual_supplied = coll_dtok as f64 * d_rate / scalar_f;
        let actual_borrowed = liab_btok as f64 * b_rate / scalar_f;
        let actual_lev = actual_supplied / initial_f;

        let theory_lev = leverage(n + 1, c_factor);

        println!(
            "  {:>4}  {:>14.2}  {:>14.2}  {:>8.4}×  {:>8.4}×  {:>+8.5}",
            n + 1,
            actual_supplied,
            actual_borrowed,
            actual_lev,
            theory_lev,
            actual_lev - theory_lev
        );
    }

    println!("  {}", "─".repeat(67));

    // Final position summary.
    let positions = pool.get_positions(&test_user);
    let r = pool.get_reserve(&usdc_addr);
    let coll_dtok = positions.collateral.get(usdc_index).unwrap_or(0);
    let liab_btok = positions.liabilities.get(usdc_index).unwrap_or(0);
    let final_supplied = coll_dtok as f64 * (r.data.d_rate as f64 / SCALAR) / scalar_f;
    let final_borrowed = liab_btok as f64 * (r.data.b_rate as f64 / SCALAR) / scalar_f;
    let final_lev = final_supplied / initial_f;
    let final_hf = if final_borrowed > 0.0 {
        (final_supplied * c_factor) / final_borrowed
    } else {
        f64::INFINITY
    };

    println!();
    println!("  Final on-chain position after {N_LOOPS} loops:");
    println!("    Supplied:  ${final_supplied:.2}");
    println!("    Borrowed:  ${final_borrowed:.2}");
    println!("    Leverage:  {final_lev:.4}×");
    println!("    Health:    {final_hf:.4}");
    println!(
        "    Δ from theory: {:+.5}×",
        final_lev - leverage(N_LOOPS, c_factor)
    );
    println!();

    // Sanity checks.
    assert!(
        final_hf >= 1.05,
        "health factor dropped below safe threshold: {final_hf:.4}"
    );
    assert!(
        (final_lev - leverage(N_LOOPS, c_factor)).abs() < 0.01,
        "actual leverage deviates too far from theory: {final_lev:.4}× vs {:.4}×",
        leverage(N_LOOPS, c_factor),
    );
}
