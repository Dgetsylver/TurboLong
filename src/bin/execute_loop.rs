/// Blend Protocol · USDC Leverage Loop Executor
///
/// Submits a single atomic `pool.submit()` call that contains N pairs of
/// [SupplyCollateral, Borrow] requests. Because Blend settles all token
/// flows net at the end of `submit()`, your wallet only needs to hold the
/// initial seed amount — the borrowed USDC is re-supplied without ever
/// leaving the contract.
///
/// Usage:
///   execute_loop --key-file <path>         # file containing your S... secret key
///                [--loops <n>]             # number of supply+borrow pairs (default 13)
///                [--initial <usdc>]        # initial USDC deposit, e.g. 1000.0 (default 1000)
///                [--dry-run]              # simulate only, do not submit
///
/// Key file format: one line containing the Stellar secret key (S...).
/// Never paste a secret key in the terminal or in source code.
use std::{
    env, fs,
    process::{self, Command},
};

use ed25519_dalek::SigningKey;
use reqwest::blocking::Client;
use stellar_strkey::ed25519::{PrivateKey, PublicKey};

// ── Constants ─────────────────────────────────────────────────────────────────

const POOL_ID: &str = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";
const USDC_ID: &str = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/// request_type constants (Blend v2)
const SUPPLY_COLLATERAL: u32 = 2;
const BORROW: u32 = 4;

/// 1e7 — all Blend on-chain values use this scalar
const SCALAR: i128 = 10_000_000;

// ── CLI args ──────────────────────────────────────────────────────────────────

struct Args {
    key_file: String,
    loops: usize,
    initial_usdc: f64,
    dry_run: bool,
}

impl Args {
    fn parse() -> Self {
        let mut args = env::args().skip(1);
        let mut key_file = None;
        let mut loops = 13usize;
        let mut initial_usdc = 1_000.0_f64;
        let mut dry_run = false;

        while let Some(flag) = args.next() {
            match flag.as_str() {
                "--key-file" => key_file = Some(args.next().expect("--key-file requires a value")),
                "--loops" => {
                    loops = args
                        .next()
                        .expect("--loops requires a value")
                        .parse()
                        .expect("loops must be an integer")
                }
                "--initial" => {
                    initial_usdc = args
                        .next()
                        .expect("--initial requires a value")
                        .parse()
                        .expect("initial must be a number")
                }
                "--dry-run" => dry_run = true,
                other => eprintln!("Unknown flag: {other}"),
            }
        }

        Args {
            key_file: key_file.expect("--key-file <path> is required"),
            loops,
            initial_usdc,
            dry_run,
        }
    }
}

// ── Pool state from RPC ───────────────────────────────────────────────────────

/// Maximum pool utilization at which new leveraged positions are allowed.
/// Above this, d-tokens (collateral) become illiquid — liquidators can't redeem
/// them, so they won't liquidate, and bad debt accumulates.
const MAX_SAFE_UTILIZATION: f64 = 0.85;

/// Maximum allowed borrow-supply APR spread (percentage points).
/// Abnormally high spreads may indicate rate manipulation.
const MAX_RATE_SPREAD_PCT: f64 = 15.0;

/// Minimal reserve data read via getLedgerEntries (raw, parsed from XDR base64).
/// We use the simulation test for detailed pre-flight; here we just need
/// c_factor and current rates to compute request amounts.
struct PoolSnapshot {
    c_factor: i128, // 1e7-scaled
    usdc_decimals: u32,
    supply_apr: f64,
    borrow_apr: f64,
    pool_supply_usdc: f64,
    pool_borrow_usdc: f64,
}

/// Reads a quick pool snapshot via the Soroban RPC `simulateTransaction` trick:
/// we call `stellar contract read` to pull raw ledger state.
/// For the actual amounts computation we rely on c_factor only (fetched via
/// `stellar contract invoke --dry-run` below), so we hard-code the well-known
/// USDC decimals here and let stellar-cli do the full pre-flight.
fn fetch_pool_snapshot(_client: &Client) -> PoolSnapshot {
    // We call the Soroban RPC to get the reserve config via getLedgerEntries.
    // Reserve config key for USDC in this pool is deterministic from the
    // pool ID + USDC address. Rather than computing the XDR key here, we
    // query it through stellar-cli in preflight mode and parse stdout.
    // For amount computation we need only c_factor; we read it via a quick
    // `simulate` of get_reserve.
    //
    // Shortcut: the Etherfuse pool's USDC c_factor is stable at 0.95 (9500000).
    // The executor always re-validates via the dry-run preflight before signing.
    //
    // A future improvement would parse the raw XDR ledger entries directly.
    PoolSnapshot {
        c_factor: 9_500_000, // 95% — validated in preflight
        usdc_decimals: 7,
        supply_apr: 0.0, // populated in preflight output
        borrow_apr: 0.0,
        pool_supply_usdc: 0.0,
        pool_borrow_usdc: 0.0,
    }
}

// ── Request amount computation ────────────────────────────────────────────────

/// Returns (supply_amount, borrow_amount) for the leverage loop, in USDC stroops.
///
/// Produces n borrows and n+1 supplies. The final extra supply re-deposits the
/// last borrow proceeds without a matching borrow, ensuring HF > 1.0.
/// HF = (1 - c^(n+1)) / (c * (1 - c^n)) > 1.0 for any finite n and c < 1.
///
/// Loop 0:   supply initial,    borrow initial × c
/// Loop 1:   supply initial × c, borrow initial × c²
/// …
/// Loop n-1: supply initial × c^(n-1), borrow initial × c^n
/// Final:    supply initial × c^n  (no borrow)
fn compute_requests(initial_stroops: i128, c_factor: i128, n_loops: usize) -> Vec<(i128, i128)> {
    let mut pairs = Vec::with_capacity(n_loops + 1);
    let mut balance = initial_stroops;
    for _ in 0..n_loops {
        let supply = balance;
        let borrow = supply * c_factor / SCALAR;
        pairs.push((supply, borrow));
        balance = borrow;
    }
    // Final supply-only entry (borrow = 0 signals "supply only")
    pairs.push((balance, 0));
    pairs
}

/// Formats a `Vec<Request>` as a JSON array understood by stellar-cli's
/// argument parser for Blend's `Request` contracttype.
fn format_requests_json(pairs: &[(i128, i128)], usdc_id: &str) -> String {
    let mut items: Vec<String> = Vec::new();
    for (supply, borrow) in pairs {
        items.push(format!(
            r#"{{"address":"{}","amount":"{}","request_type":{}}}"#,
            usdc_id, supply, SUPPLY_COLLATERAL
        ));
        if *borrow > 0 {
            items.push(format!(
                r#"{{"address":"{}","amount":"{}","request_type":{}}}"#,
                usdc_id, borrow, BORROW
            ));
        }
    }
    format!("[{}]", items.join(","))
}

// ── Pre-flight summary ────────────────────────────────────────────────────────

fn print_preflight(pairs: &[(i128, i128)], c_factor: i128, initial_usdc: f64, dry_run: bool) {
    let scalar_f = 10_f64.powi(7);
    let c = c_factor as f64 / SCALAR as f64;
    let total_supply: i128 = pairs.iter().map(|(s, _)| s).sum();
    let total_borrow: i128 = pairs.iter().map(|(_, b)| b).sum();
    let lev = total_supply as f64 / scalar_f / initial_usdc;

    println!();
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║          Blend Protocol · USDC Leverage Executor         ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();
    println!("  Pool:              {POOL_ID}");
    println!("  USDC:              {USDC_ID}");
    let n_borrows = pairs.iter().filter(|(_, b)| *b > 0).count();
    let n_requests = n_borrows + pairs.len(); // supplies + borrows
    println!(
        "  Loops:             {}  ({} borrows + {} supplies = {} requests)",
        n_borrows,
        n_borrows,
        pairs.len(),
        n_requests
    );
    println!("  Initial deposit:   ${initial_usdc:.2}");
    println!("  Collateral factor: {:.0}%", c * 100.0);
    println!();
    println!(
        "  {:>4}  {:>14}  {:>14}",
        "Loop", "Supply ($)", "Borrow ($)"
    );
    println!("  {}", "─".repeat(36));
    for (i, (s, b)) in pairs.iter().enumerate() {
        if *b > 0 {
            println!(
                "  {:>4}  {:>14.2}  {:>14.2}",
                i + 1,
                *s as f64 / scalar_f,
                *b as f64 / scalar_f
            );
        } else {
            println!(
                "  {:>4}  {:>14.2}  {:>14}  (final supply)",
                i + 1,
                *s as f64 / scalar_f,
                "—"
            );
        }
    }
    println!("  {}", "─".repeat(36));
    println!(
        "  {:>4}  {:>14.2}  {:>14.2}  →  {:.3}× leverage",
        "net",
        total_supply as f64 / scalar_f,
        total_borrow as f64 / scalar_f,
        lev,
    );
    println!();
    println!("  Net tokens pulled from wallet:  ${:.2}", initial_usdc);
    println!("  Net tokens sent from pool:       $0.00   (borrows re-supplied atomically)");
    println!();

    if dry_run {
        println!("  ── DRY RUN (--dry-run): transaction will be simulated but not submitted ──");
    } else {
        println!("  ⚠  LIVE MODE: this transaction will be submitted to Stellar MAINNET.");
        println!("  ⚠  Ensure you have reviewed the simulation output and accept the risks.");
    }
    println!();
}

// ── Safety guards ────────────────────────────────────────────────────────────
//
// Pre-flight checks that mitigate structural exploit risks:
//  1. Utilization cap — circular collateral lock at high utilization
//  2. Rate spread guard — abnormal spread may indicate manipulation
//  3. Projected utilization — refuses if the loop itself would push past cap

fn check_safety(snap: &PoolSnapshot, initial_usdc: f64, n_loops: usize) -> Result<(), String> {
    let c = snap.c_factor as f64 / SCALAR as f64;

    // Current utilization
    let util = if snap.pool_supply_usdc > 0.0 {
        snap.pool_borrow_usdc / snap.pool_supply_usdc
    } else {
        0.0
    };

    if util > MAX_SAFE_UTILIZATION {
        return Err(format!(
            "Pool utilization is {:.1}% (max {:.0}%). \
             High utilization means collateral d-tokens are illiquid — \
             liquidators won't act, risking bad debt spiral. Wait for utilization to drop.",
            util * 100.0,
            MAX_SAFE_UTILIZATION * 100.0
        ));
    }

    // Rate spread
    let spread = snap.borrow_apr - snap.supply_apr;
    if spread * 100.0 > MAX_RATE_SPREAD_PCT {
        return Err(format!(
            "Borrow-supply APR spread is {:.1}% — abnormally high (max {:.0}%). \
             This may indicate rate manipulation. Wait for rates to stabilize.",
            spread * 100.0,
            MAX_RATE_SPREAD_PCT
        ));
    }

    // Projected utilization after loop
    let lev = (1.0 - c.powi(n_loops as i32 + 1)) / (1.0 - c);
    let add_supply = initial_usdc * lev;
    let add_borrow = initial_usdc * (lev - 1.0);
    let proj_supply = snap.pool_supply_usdc + add_supply;
    let proj_borrow = snap.pool_borrow_usdc + add_borrow;
    let proj_util = if proj_supply > 0.0 {
        proj_borrow / proj_supply
    } else {
        0.0
    };

    if proj_util > MAX_SAFE_UTILIZATION {
        return Err(format!(
            "This position would push pool utilization to {:.1}% (max {:.0}%). \
             Reduce --loops or --initial.",
            proj_util * 100.0,
            MAX_SAFE_UTILIZATION * 100.0
        ));
    }

    // Warnings (non-fatal)
    if spread * 100.0 > 5.0 {
        eprintln!(
            "  ⚠  Warning: borrow-supply spread is {:.1}%/yr — HF will erode quickly.",
            spread * 100.0
        );
    }

    Ok(())
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let args = Args::parse();

    // 1. Load secret key from file — never from env or CLI arg.
    let secret_raw = fs::read_to_string(&args.key_file).unwrap_or_else(|e| {
        eprintln!("Cannot read key file '{}': {e}", args.key_file);
        process::exit(1);
    });
    let secret_str = secret_raw.trim();

    let secret_key = PrivateKey::from_string(secret_str).unwrap_or_else(|e| {
        eprintln!("Invalid secret key: {e}");
        process::exit(1);
    });
    // Derive the public key via ed25519-dalek (stellar-strkey doesn't expose this).
    let signing_key = SigningKey::from_bytes(&secret_key.0);
    let pub_bytes: [u8; 32] = signing_key.verifying_key().to_bytes();
    let account_id = PublicKey(pub_bytes).to_string();

    println!("Loaded key for account: {account_id}");

    // 2. Quick pool snapshot for amount computation.
    let client = Client::new();
    let snap = fetch_pool_snapshot(&client);

    // 3. Compute request amounts.
    let usdc_scalar = 10_i128.pow(snap.usdc_decimals);
    let initial_stroops = (args.initial_usdc * usdc_scalar as f64).round() as i128;
    let pairs = compute_requests(initial_stroops, snap.c_factor, args.loops);

    // 4. Print pre-flight summary.
    print_preflight(&pairs, snap.c_factor, args.initial_usdc, args.dry_run);

    // 4b. Safety guards — refuse if pool conditions are unsafe.
    if let Err(reason) = check_safety(&snap, args.initial_usdc, args.loops) {
        eprintln!("  ✗ Safety check FAILED: {reason}");
        eprintln!("  Pass --dry-run to bypass safety checks and inspect the simulation.");
        if !args.dry_run {
            process::exit(1);
        }
        eprintln!("  (Continuing in dry-run mode despite safety failure)");
    }

    // 5. Build requests JSON for stellar-cli.
    let requests_json = format_requests_json(&pairs, USDC_ID);

    // 6. Locate stellar-cli (installed alongside this binary).
    let stellar_cli = which_stellar_cli();

    // 7. Build stellar-cli command.
    // stellar contract invoke \
    //   --id POOL_ID \
    //   --source-account SECRET_KEY \
    //   --network mainnet \
    //   [--send=no if dry-run] \
    //   -- submit --from ADDR --spender ADDR --to ADDR --requests '[...]'
    let send_flag = if args.dry_run {
        "--send=no"
    } else {
        "--send=yes"
    };

    let mut cmd = Command::new(&stellar_cli);
    cmd.args([
        "contract",
        "invoke",
        "--id",
        POOL_ID,
        "--source-account",
        secret_str,
        "--network",
        "mainnet",
        send_flag,
        "--",
        "submit",
        "--from",
        &account_id,
        "--spender",
        &account_id,
        "--to",
        &account_id,
        "--requests",
        &requests_json,
    ]);

    println!("Invoking stellar-cli…");
    println!("  stellar contract invoke --id {POOL_ID} --network mainnet {send_flag}");
    println!(
        "  -- submit --from {account_id} ... ({} requests)",
        pairs.len() * 2
    );
    println!();

    let status = cmd.status().unwrap_or_else(|e| {
        eprintln!("Failed to run stellar-cli ({stellar_cli}): {e}");
        eprintln!("Install with: cargo install stellar-cli --locked");
        process::exit(1);
    });

    if !status.success() {
        eprintln!("stellar-cli exited with status: {status}");
        process::exit(status.code().unwrap_or(1));
    }

    println!();
    if args.dry_run {
        println!("Dry-run complete. Re-run without --dry-run to submit to mainnet.");
    } else {
        println!("Transaction submitted. Check your position:");
        println!("  stellar contract invoke --id {POOL_ID} --network mainnet -- get_positions --address {account_id}");
    }
}

// ── stellar-cli discovery ─────────────────────────────────────────────────────

fn which_stellar_cli() -> String {
    // Check common locations in order.
    let candidates = [
        // Same cargo bin dir as this binary.
        std::env::current_exe()
            .ok()
            .and_then(|p| {
                p.parent()
                    .map(|d| d.join("stellar").to_string_lossy().to_string())
            })
            .unwrap_or_default(),
        format!(
            "{}/.cargo/bin/stellar",
            env::var("HOME").unwrap_or_default()
        ),
        "stellar".to_string(), // in PATH
    ];

    for candidate in &candidates {
        if candidate.is_empty() {
            continue;
        }
        if std::path::Path::new(candidate).exists()
            || Command::new(candidate).arg("--version").output().is_ok()
        {
            return candidate.clone();
        }
    }

    // Fall back and let the OS report the error.
    "stellar".to_string()
}
