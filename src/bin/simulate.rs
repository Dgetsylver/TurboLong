/// Blend Protocol · USDC Leverage Loop Simulation
///
/// Reads live pool state from Stellar mainnet via stellar-cli and prints
/// the full leverage table with interest rates, health factor, and BLND
/// emission estimates.
///
/// Usage:  simulate [--loops <n>]  (default 20)
///
/// Requires: stellar-cli (https://github.com/stellar/stellar-cli)
///           configured with the "mainnet" network profile.
use std::{env, process::Command};

use serde::Deserialize;
use serde_json::Value;

// ── Pool constants ────────────────────────────────────────────────────────────

const POOL_ID: &str = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
const USDC_ID: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/// Arbitrary read-only account for simulation calls (no signing required).
const DUMMY_ADDR: &str = "GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA";

// ── Blend v2 scalar conventions ───────────────────────────────────────────────
//
// Field              | Stored scalar
// -------------------|---------------
// c_factor, l_factor | 1e7  (SCALAR_7)
// util_target, r_*   | 1e7
// ir_mod             | 1e7  (capped [0.1 × 1e7, 10 × 1e7])
// b_rate, d_rate     | 1e12 (SCALAR_12)
// b_supply, d_supply | raw token units (same scale as underlying strops)
// eps (emissions)    | 1e7-scaled BLND per second
//
// Naming convention:
//   b_* = balance/supply tokens (what depositors hold)
//   d_* = debt tokens           (what borrowers owe)
//
// Utilization = (d_supply × d_rate) / (b_supply × b_rate)

const SCALAR_7: f64 = 1e7;
const SCALAR_12: f64 = 1e12;
const SECONDS_PER_YEAR: f64 = 31_536_000.0;

// ── Data types ────────────────────────────────────────────────────────────────

#[derive(Deserialize, Debug)]
struct PoolConfig {
    bstop_rate: i64,
}

#[derive(Deserialize, Debug)]
struct ReserveConfig {
    c_factor: i64,
    decimals: u32,
    index: u32,
    l_factor: i64,
    max_util: i64,
    r_base: i64,
    r_one: i64,
    r_two: i64,
    r_three: i64,
    supply_cap: String, // i128 comes as quoted string from stellar-cli
    util: i64,          // target utilization
}

#[derive(Deserialize, Debug)]
struct ReserveData {
    b_rate: String, // i128 quoted
    b_supply: String,
    d_rate: String, // i128 quoted
    d_supply: String,
    ir_mod: String,
}

#[derive(Deserialize, Debug)]
struct Reserve {
    config: ReserveConfig,
    data: ReserveData,
}

#[derive(Deserialize, Debug)]
struct EmissionData {
    eps: u64,
    #[allow(dead_code)] // present in ledger JSON; kept to document the entry shape
    expiration: u64,
}

// ── stellar-cli helper ────────────────────────────────────────────────────────

fn stellar_invoke(args: &[&str]) -> Value {
    let stellar = which_stellar();
    let mut cmd = Command::new(&stellar);
    cmd.args([
        "contract",
        "invoke",
        "--id",
        POOL_ID,
        "--source-account",
        DUMMY_ADDR,
        "--network",
        "mainnet",
        "--send=no",
        "--",
    ]);
    cmd.args(args);

    let out = cmd.output().unwrap_or_else(|e| {
        eprintln!("stellar-cli failed: {e}");
        std::process::exit(1);
    });

    if !out.status.success() {
        eprintln!("stellar error: {}", String::from_utf8_lossy(&out.stderr));
        std::process::exit(1);
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str(stdout.trim()).unwrap_or_else(|e| {
        eprintln!("JSON parse error: {e}\nOutput: {stdout}");
        std::process::exit(1);
    })
}

fn which_stellar() -> String {
    let home = env::var("HOME").unwrap_or_default();
    let candidates = [format!("{home}/.cargo/bin/stellar"), "stellar".to_string()];
    for c in &candidates {
        if std::path::Path::new(c).exists() {
            return c.clone();
        }
    }
    "stellar".to_string()
}

// ── Interest rate model ───────────────────────────────────────────────────────

fn compute_rates(cfg: &ReserveConfig, data: &ReserveData, bstop_rate: f64) -> (f64, f64, f64) {
    let b_rate = data.b_rate.parse::<i128>().unwrap() as f64 / SCALAR_12;
    let d_rate = data.d_rate.parse::<i128>().unwrap() as f64 / SCALAR_12;
    let b_supply = data.b_supply.parse::<i128>().unwrap() as f64;
    let d_supply = data.d_supply.parse::<i128>().unwrap() as f64;
    let ir_mod = data.ir_mod.parse::<i128>().unwrap() as f64 / SCALAR_7;

    // b = balance (supply), d = debt (borrows)
    let supply_underlying = b_supply * b_rate;
    let debt_underlying = d_supply * d_rate;
    let util = if supply_underlying > 0.0 {
        (debt_underlying / supply_underlying).min(1.0) // capped at 1 per protocol
    } else {
        0.0
    };

    let util_target = cfg.util as f64 / SCALAR_7;
    let max_util = cfg.max_util as f64 / SCALAR_7;
    let r_base = cfg.r_base as f64 / SCALAR_7;
    let r_one = cfg.r_one as f64 / SCALAR_7;
    let r_two = cfg.r_two as f64 / SCALAR_7;
    let r_three = cfg.r_three as f64 / SCALAR_7;

    let base_rate = if util <= util_target {
        r_base + r_one * util / util_target
    } else if util <= max_util {
        r_base + r_one + r_two * (util - util_target) / (max_util - util_target)
    } else {
        r_base + r_one + r_two + r_three * (util - max_util) / (1.0 - max_util)
    };

    let borrow_apr = base_rate * ir_mod;
    let supply_apr = borrow_apr * util * (1.0 - bstop_rate);

    (util, supply_apr, borrow_apr)
}

// ── Leverage math ─────────────────────────────────────────────────────────────

fn leverage(n: usize, c: f64) -> f64 {
    (1.0 - c.powi(n as i32 + 1)) / (1.0 - c)
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let n_loops: usize = env::args()
        .skip_while(|a| a != "--loops")
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);

    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║    Blend Protocol · Etherfuse Pool · USDC Loop Sim      ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();
    println!("Fetching live data from Stellar mainnet…");

    // ── 1. Pool config ────────────────────────────────────────────────────────
    let pool_cfg: PoolConfig =
        serde_json::from_value(stellar_invoke(&["get_config"])).expect("parse pool config");
    let bstop_rate = pool_cfg.bstop_rate as f64 / SCALAR_7;

    // ── 2. USDC reserve ───────────────────────────────────────────────────────
    let reserve: Reserve =
        serde_json::from_value(stellar_invoke(&["get_reserve", "--asset", USDC_ID]))
            .expect("parse reserve");

    let cfg = &reserve.config;
    let data = &reserve.data;

    let c_factor = cfg.c_factor as f64 / SCALAR_7;
    let l_factor = cfg.l_factor as f64 / SCALAR_7;
    let scalar_f = 10_f64.powi(cfg.decimals as i32); // 1e7 for USDC

    let supply_cap_usdc = cfg.supply_cap.parse::<i128>().unwrap() as f64 / scalar_f;

    let b_rate_n = data.b_rate.parse::<i128>().unwrap() as f64 / SCALAR_12;
    let d_rate_n = data.d_rate.parse::<i128>().unwrap() as f64 / SCALAR_12;
    let b_supply = data.b_supply.parse::<i128>().unwrap() as f64;
    let d_supply = data.d_supply.parse::<i128>().unwrap() as f64;
    let ir_mod = data.ir_mod.parse::<i128>().unwrap() as f64 / SCALAR_7;

    let pool_supplied_usdc = b_supply * b_rate_n / scalar_f;
    let pool_borrowed_usdc = d_supply * d_rate_n / scalar_f;

    let (util, supply_apr, borrow_apr) = compute_rates(cfg, data, bstop_rate);

    // ── 3. BLND emissions ─────────────────────────────────────────────────────
    // reserve token index convention (blend-contracts-v2 emissions/manager.rs):
    //   even  (cfg.index * 2)     = borrow/liability side (d-tokens)
    //   odd   (cfg.index * 2 + 1) = supply side           (b-tokens)
    let supply_eps_idx = (cfg.index * 2 + 1).to_string();
    let borrow_eps_idx = (cfg.index * 2).to_string();

    let supply_emission: Option<EmissionData> = serde_json::from_value(stellar_invoke(&[
        "get_reserve_emissions",
        "--reserve_token_index",
        &supply_eps_idx,
    ]))
    .ok()
    .flatten();
    let borrow_emission: Option<EmissionData> = serde_json::from_value(stellar_invoke(&[
        "get_reserve_emissions",
        "--reserve_token_index",
        &borrow_eps_idx,
    ]))
    .ok()
    .flatten();

    let supply_eps = supply_emission.as_ref().map(|e| e.eps).unwrap_or(0);
    let borrow_eps = borrow_emission.as_ref().map(|e| e.eps).unwrap_or(0);

    // Pool-wide BLND per year.
    // eps unit: BLND-strops/s for the pool, BUT the index accrual formula scales by
    // SCALAR_7 so that: pool_strops/s = eps / SCALAR_7, pool_BLND/s = eps / SCALAR_7 / SCALAR_7.
    // (See blend-contracts-v2 emissions/distributor.rs: to_accrue = user_bal * eps * t / supply / SCALAR_7)
    let pool_supply_blnd_yr = supply_eps as f64 * SECONDS_PER_YEAR / SCALAR_7 / SCALAR_7;
    let pool_borrow_blnd_yr = borrow_eps as f64 * SECONDS_PER_YEAR / SCALAR_7 / SCALAR_7;

    // BLND per $1 supplied/borrowed per year
    let blnd_per_usdc_supply = if pool_supplied_usdc > 0.0 {
        pool_supply_blnd_yr / pool_supplied_usdc
    } else {
        0.0
    };
    let blnd_per_usdc_borrow = if pool_borrowed_usdc > 0.0 {
        pool_borrow_blnd_yr / pool_borrowed_usdc
    } else {
        0.0
    };

    // ── 4. Print reserve summary ──────────────────────────────────────────────
    println!();
    println!("  ┌─────────────────────────────────────────────────────────┐");
    println!("  │        USDC Reserve (live Stellar mainnet)              │");
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
        "  │  Utilization (actual):   {:>7.2}%                       │",
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
        "  │  IR modifier:           {:>8.6}                        │",
        ir_mod
    );
    println!("  ├─────────────────────────────────────────────────────────┤");
    println!(
        "  │  Pool supplied:   {:>14.2} USDC                    │",
        pool_supplied_usdc
    );
    println!(
        "  │  Pool borrowed:   {:>14.2} USDC                    │",
        pool_borrowed_usdc
    );
    println!(
        "  │  Supply cap:      {:>14.2} USDC                    │",
        supply_cap_usdc
    );
    let cap_pct = pool_supplied_usdc / supply_cap_usdc * 100.0;
    let cap_room = supply_cap_usdc - pool_supplied_usdc;
    println!(
        "  │  Cap used:        {:>7.2}%  ({:.2} USDC room)          │",
        cap_pct, cap_room
    );
    println!("  ├─────────────────────────────────────────────────────────┤");

    if supply_eps == 0 && borrow_eps == 0 {
        println!("  │  BLND emissions:  NONE configured for this reserve     │");
    } else {
        if supply_eps > 0 {
            println!(
                "  │  Supply BLND/yr:  {:>12.1}  ({:.4} per $1/yr)      │",
                pool_supply_blnd_yr, blnd_per_usdc_supply
            );
        } else {
            println!("  │  Supply BLND/yr:  NONE                                  │");
        }
        if borrow_eps > 0 {
            println!(
                "  │  Borrow BLND/yr:  {:>12.1}  ({:.4} per $1/yr)      │",
                pool_borrow_blnd_yr, blnd_per_usdc_borrow
            );
        } else {
            println!("  │  Borrow BLND/yr:  NONE                                  │");
        }
        println!("  │  ⚠ APY below excludes BLND. Multiply BLND/yr by price. │");
    }
    println!("  └─────────────────────────────────────────────────────────┘");

    // ── 5. Leverage table ─────────────────────────────────────────────────────
    let initial = 1_000.0_f64;
    let max_lev = 1.0 / (1.0 - c_factor);

    println!();
    println!(
        "  Initial deposit: ${:.0}    c_factor: {:.0}%    max leverage: {:.2}×",
        initial,
        c_factor * 100.0,
        max_lev
    );
    if supply_apr >= borrow_apr {
        println!(
            "  ✓ Rate spread: +{:.3}%  (interest is positive carry)",
            (supply_apr - borrow_apr) * 100.0
        );
    } else {
        println!(
            "  ✗ Rate spread: {:.3}%  (NEGATIVE carry — BLND is only yield)",
            (supply_apr - borrow_apr) * 100.0
        );
    }
    println!();
    println!(
        "  {:>4}  {:>12}  {:>12}  {:>8}  {:>8}  {:>10}  {:>10}  ⚠",
        "Loop", "Supplied ($)", "Borrowed ($)", "Leverage", "HF", "Net APY", "BLND/yr"
    );
    println!("  {}", "─".repeat(84));

    let mut last_safe_loop = 0;

    for n in 0..=n_loops {
        let lev = leverage(n, c_factor);
        let supplied = initial * lev;
        let borrowed = supplied - initial;
        let hf = if borrowed > 0.0 {
            (supplied * c_factor) / borrowed
        } else {
            f64::INFINITY
        };
        let hf_str = if borrowed > 0.0 {
            format!("{:.4}", hf)
        } else {
            "     ∞".to_string()
        };

        let net_yield = supply_apr * supplied - borrow_apr * borrowed;
        let net_apy = net_yield / initial * 100.0;

        let blnd_yr = supplied * blnd_per_usdc_supply + borrowed * blnd_per_usdc_borrow;

        let cap_warn = if supplied > pool_supplied_usdc + cap_room {
            "CAP"
        } else {
            ""
        };

        println!(
            "  {:>4}  {:>12.2}  {:>12.2}  {:>7.2}×  {:>8}  {:>9.2}%  {:>10.1}  {}",
            n, supplied, borrowed, lev, hf_str, net_apy, blnd_yr, cap_warn
        );

        if hf >= 1.05 {
            last_safe_loop = n;
        }
        if lev / max_lev > 0.9999 {
            break;
        }
    }

    // Theoretical ∞ row
    let max_sup = initial * max_lev;
    let max_bor = max_sup - initial;
    let max_net_apy = (supply_apr * max_sup - borrow_apr * max_bor) / initial * 100.0;
    let max_blnd_yr = max_sup * blnd_per_usdc_supply + max_bor * blnd_per_usdc_borrow;
    let max_cap_warn = if max_sup > pool_supplied_usdc + cap_room {
        "CAP"
    } else {
        ""
    };

    println!("  {}", "─".repeat(84));
    println!(
        "  {:>4}  {:>12.2}  {:>12.2}  {:>7.2}×  {:>8.4}  {:>9.2}%  {:>10.1}  {}",
        "∞", max_sup, max_bor, max_lev, 1.0_f64, max_net_apy, max_blnd_yr, max_cap_warn
    );

    // ── 6. Risk summary ───────────────────────────────────────────────────────
    let safe_lev = leverage(last_safe_loop, c_factor);
    let safe_blnd = safe_lev * initial * blnd_per_usdc_supply
        + (safe_lev * initial - initial) * blnd_per_usdc_borrow;

    println!();
    println!("  ┌─────────────────────────────────────────────────────────┐");
    println!("  │                     Risk Summary                        │");
    println!("  ├─────────────────────────────────────────────────────────┤");

    // ── Structural vulnerability warnings ──
    //
    // These warnings flag the critical exploit vectors identified in the
    // oracle & flash loan analysis:
    //
    // 1. Circular Collateral Lock: At high utilization, d-tokens can't be
    //    redeemed → liquidators won't act → bad debt spiral.
    //
    // 2. Rate Manipulation: Abnormally high borrow-supply spread may
    //    indicate an attacker spiking utilization to force liquidations.
    //
    // 3. Cascade Risk: Large leveraged positions at similar HF levels
    //    can trigger chain liquidations when one position is liquidated.

    let max_safe_util: f64 = 0.85;
    if util > max_safe_util {
        println!(
            "  │  ⛔ UTILIZATION: {:.1}% — ABOVE {:.0}% SAFETY CAP           │",
            util * 100.0,
            max_safe_util * 100.0
        );
        println!("  │    Collateral d-tokens are ILLIQUID at this level.       │");
        println!("  │    Liquidators cannot redeem → bad debt accumulates.     │");
        println!("  │    DO NOT open new leveraged positions.                  │");
        println!("  ├─────────────────────────────────────────────────────────┤");
    } else if util > 0.75 {
        println!(
            "  │  ⚠  Utilization {:.1}% — approaching {:.0}% cap            │",
            util * 100.0,
            max_safe_util * 100.0
        );
        println!("  │    Opening large loops may push utilization past limit.  │");
        println!("  ├─────────────────────────────────────────────────────────┤");
    }

    // Rate manipulation guard
    let spread = borrow_apr - supply_apr;
    if spread > 0.15 {
        println!(
            "  │  ⛔ RATE SPREAD: {:.1}%/yr — ABNORMALLY HIGH             │",
            spread * 100.0
        );
        println!("  │    May indicate rate manipulation attack. Do not open    │");
        println!("  │    new positions until rates stabilize.                  │");
        println!("  ├─────────────────────────────────────────────────────────┤");
    }

    println!("  │  Collateral = Borrowed = USDC → NO price-based liq     │");
    println!(
        "  │  Safe max: {:>2} loops → {:.3}× leverage (HF ≥ 1.05)    │",
        last_safe_loop, safe_lev
    );
    println!("  ├─────────────────────────────────────────────────────────┤");

    if supply_apr >= borrow_apr {
        println!(
            "  │  ✓ Interest spread: +{:.3}%/yr                         │",
            (supply_apr - borrow_apr) * 100.0
        );
    } else {
        println!(
            "  │  ✗ Interest spread: {:.3}%/yr  (NEGATIVE carry)       │",
            (supply_apr - borrow_apr) * 100.0
        );
        println!("  │    Pure interest loop loses money without BLND          │");
    }

    if blnd_per_usdc_borrow > 0.0 {
        println!("  ├─────────────────────────────────────────────────────────┤");
        println!(
            "  │  BLND at safe max ({} loops, {:.2}×):  {:.1} BLND/yr │",
            last_safe_loop, safe_lev, safe_blnd
        );
        println!(
            "  │  BLND at max ({:.0}×):        {:.1} BLND/yr        │",
            max_lev, max_blnd_yr
        );
        println!("  │  ⚠ Only borrow side earns BLND (supply side: NONE)     │");
        println!("  │  ⚠ Claim via pool.claim() — does NOT auto-compound     │");
        println!("  │  ⚠ BLND must be sold to realize yield                  │");
    }

    if cap_room < max_sup {
        println!("  ├─────────────────────────────────────────────────────────┤");
        println!(
            "  │  ⚠ SUPPLY CAP: ${:.0} room left before pool cap       │",
            cap_room
        );
        println!(
            "  │    Max safe supply for $1000: ${:.2}                │",
            (pool_supplied_usdc + cap_room).min(max_sup)
        );
    }

    println!("  └─────────────────────────────────────────────────────────┘");
    println!();
}
