//! Integration tests against a real mock Blend pool using BlendFixture.
//!
//! Tests pool interactions (supply, borrow, repay, withdraw) individually,
//! then validates the full deposit→withdraw accounting cycle.
//!
//! Note: Blend v2 settles token flows differently per entrypoint. Plain
//! `pool.submit()` — used by the helpers below — does NOT net them: it pulls
//! every supply/repay before sending any borrow/withdraw, so a loop built through
//! it must go step by step (`execute_leverage_loop_stepped`) or with the spender
//! pre-funded (`execute_unwind`). `submit_with_allowance`, which the strategy
//! uses, nets the flows per asset — which is why the strategy levers in or
//! unwinds with a single two-request submit.

extern crate std;

use blend_contract_sdk::{
    pool,
    testutils::{default_reserve_config, BlendFixture},
};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, BytesN as _, Events as _,
        Ledger as _, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, Address, Bytes, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

use crate::constants::{
    REQUEST_TYPE_BORROW, REQUEST_TYPE_REPAY, REQUEST_TYPE_SUPPLY_COLLATERAL,
    REQUEST_TYPE_WITHDRAW_COLLATERAL, SCALAR_12, SCALAR_7,
};
use crate::leverage::{compute_health_factor, compute_partial_unwind, shares_to_underlying};
use crate::reserves::LeverageReserves;
use crate::{blend_pool, reserves, storage, StrategyError};

// ── Mock Oracle ──────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum Asset {
    Stellar(Address),
    Other(soroban_sdk::Symbol),
}

#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// Mock oracle: returns $1 for any asset (14 decimals).
#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(_e: Env) {}

    pub fn lastprice(e: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: 100_000_000_000_000, // 1.0 in 14 decimals
            timestamp: e.ledger().timestamp(),
        })
    }

    pub fn decimals(_e: Env) -> u32 {
        14
    }

    pub fn base(e: Env) -> Asset {
        Asset::Other(soroban_sdk::Symbol::new(&e, "USD"))
    }
}

// ── Minimal strategy contract ────────────────────────────────────────────────

#[contract]
struct TestStrategyContract;

#[contractimpl]
impl TestStrategyContract {}

// ── Test helpers ─────────────────────────────────────────────────────────────

/// Standard fixture: reserve with `l_factor = 1.0` (no liability markup), so
/// HF reduces to `B × c_factor / D` and the pre-H-1 expectations in the tests
/// below still read the same. Use `setup_blend_env_with_l_factor` for the cases
/// that must exercise a real markup.
fn setup_blend_env(e: &Env) -> (Address, Address, Address, BlendFixture<'_>, Address) {
    setup_blend_env_with_l_factor(e, 10_000_000)
}

/// As `setup_blend_env`, with the reserve's `l_factor` under the test's control.
/// Blend marks liabilities up by dividing by this factor, so anything below 1.0
/// moves the pool's liquidation threshold above the naive `B × c / D` ratio.
fn setup_blend_env_with_l_factor(
    e: &Env,
    l_factor: u32,
) -> (Address, Address, Address, BlendFixture<'_>, Address) {
    let (pool_addr, token, blnd, blend, deployer, _) = setup_blend_pool(e, l_factor, false);
    (pool_addr, token, blnd, blend, deployer)
}

/// As `setup_blend_env`, plus a second reserve, `collateral` (same $1 oracle
/// price), returned as `(pool, token, collateral, blnd)`.
///
/// A borrower posting `collateral` can borrow the leverage asset without being
/// capped by that asset's own collateral factor — the only way a test can push
/// the leverage asset's utilization toward 100%.
fn setup_blend_env_with_collateral_reserve(e: &Env) -> (Address, Address, Address, Address) {
    let (pool_addr, token, blnd, _blend, _deployer, collateral) =
        setup_blend_pool(e, 10_000_000, true);
    (pool_addr, token, collateral.unwrap(), blnd)
}

/// Deploy the Blend fixture and an active pool with the leverage reserve and,
/// optionally, a second reserve. Both are added while the pool is still in
/// setup: once it is active, `queue_set_reserve` carries a one-week timelock.
fn setup_blend_pool(
    e: &Env,
    l_factor: u32,
    with_collateral: bool,
) -> (
    Address,
    Address,
    Address,
    BlendFixture<'_>,
    Address,
    Option<Address>,
) {
    let deployer = Address::generate(e);

    let blnd = e
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();
    let usdc = e
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();

    let blend = BlendFixture::deploy(e, &deployer, &blnd, &usdc);

    let token = e
        .register_stellar_asset_contract_v2(deployer.clone())
        .address();

    let oracle = e.register(MockOracle, ());

    let pool_addr = blend.pool_factory.mock_all_auths().deploy(
        &deployer,
        &String::from_str(e, "test_leverage_pool"),
        &BytesN::<32>::random(e),
        &oracle,
        &1_000_000,
        &4,
        &0,
    );

    let mut reserve_config = default_reserve_config();
    reserve_config.c_factor = 9_500_000;
    reserve_config.l_factor = l_factor;
    reserve_config.max_util = 9_900_000;

    let pool_client = pool::Client::new(e, &pool_addr);
    pool_client
        .mock_all_auths()
        .queue_set_reserve(&token, &reserve_config);
    pool_client.mock_all_auths().set_reserve(&token);

    let collateral = if with_collateral {
        let collateral = e
            .register_stellar_asset_contract_v2(deployer.clone())
            .address();
        let mut collateral_config = default_reserve_config();
        collateral_config.c_factor = 9_500_000;
        collateral_config.l_factor = 10_000_000;
        collateral_config.max_util = 9_900_000;
        pool_client
            .mock_all_auths()
            .queue_set_reserve(&collateral, &collateral_config);
        pool_client.mock_all_auths().set_reserve(&collateral);
        Some(collateral)
    } else {
        None
    };

    blend
        .backstop
        .mock_all_auths()
        .deposit(&deployer, &pool_addr, &50_000_0000000);
    pool_client.mock_all_auths().set_status(&3);
    pool_client.mock_all_auths().update_status();

    (pool_addr, token, blnd, blend, deployer, collateral)
}

fn make_config(e: &Env, pool_addr: &Address, token: &Address, blnd: &Address) -> storage::Config {
    let pool_client = pool::Client::new(e, pool_addr);
    let reserve = pool_client.get_reserve(token);
    let reserve_id = reserve.config.index;

    storage::Config {
        asset: token.clone(),
        pool: pool_addr.clone(),
        reserve_id,
        blend_token: blnd.clone(),
        router: Address::generate(e),
        claim_ids: Vec::from_array(e, [reserve_id * 2 + 1, reserve_id * 2]),
        reward_threshold: 1_0000000,
        c_factor: 9_000_000, // 0.90: below pool's c=0.95 to keep HF > 1.0
        target_hf: TARGET_HF,
        min_hf: 10_500_000,
        orange_hf: 11_500_000,
    }
}

fn seed_pool_liquidity(e: &Env, pool_addr: &Address, token: &Address, amount: i128) {
    let whale = Address::generate(e);
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&whale, &amount);

    pool::Client::new(e, pool_addr).mock_all_auths().submit(
        &whale,
        &whale,
        &whale,
        &vec![
            e,
            pool::Request {
                address: token.clone(),
                amount,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
}

/// Advance the ledger by `seconds` and poke the reserve (a 1-unit supply from a
/// fresh account) so the accrued interest is materialised in the stored rates.
fn accrue_interest(e: &Env, pool_addr: &Address, token: &Address, seconds: u64) {
    e.ledger().with_mut(|li| {
        li.timestamp += seconds;
        li.sequence_number += (seconds / 5) as u32;
    });
    let poker = Address::generate(e);
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&poker, &1_0000000);
    pool::Client::new(e, pool_addr).mock_all_auths().submit(
        &poker,
        &poker,
        &poker,
        &vec![
            e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
}

/// The HF the real strategy levers to in these tests: what 3 loops at c = 0.90
/// used to build.
const TARGET_HF: i128 = 12_690_000;

/// A deposit levered to this HF opens deep in the orange zone (what 8 loops at
/// c = 0.90 used to build). The constructor refuses it as a target, so tests
/// reach it through `set_target_hf` — the state rate drift or an `l_factor` cut
/// leaves a real position in.
const STRESSED_HF: i128 = 10_756_000;

/// Loop depth for positions built step by step on a bare test contract.
const TEST_LOOPS: u32 = 3;

/// The `(supply, borrow)` steps of an `n_loops`-deep loop, the last borrow 0,
/// and the step count — the request sequence `execute_leverage_loop_stepped`
/// sends one submit at a time.
fn compute_loop_pairs(
    initial_amount: i128,
    c_factor: i128,
    n_loops: u32,
) -> ([i128; 21], [i128; 21], u32) {
    let n = n_loops.min(20) as usize;
    let mut supplies = [0i128; 21];
    let mut borrows = [0i128; 21];
    let mut balance = initial_amount;
    for i in 0..=n {
        supplies[i] = balance;
        if i < n {
            borrows[i] = balance * c_factor / SCALAR_7;
        }
        balance = borrows[i];
    }
    (supplies, borrows, n as u32 + 1)
}

/// The pool's `(supply, borrow)` for the strategy's reserve, in underlying.
fn get_pool_utilization(e: &Env, config: &storage::Config) -> (i128, i128) {
    let reserve = pool::Client::new(e, &config.pool).get_reserve(&config.asset);
    (
        reserve.data.b_supply * reserve.data.b_rate / SCALAR_12,
        reserve.data.d_supply * reserve.data.d_rate / SCALAR_12,
    )
}

/// Overwrite the stored `target_hf`, bypassing the constructor's band check.
fn set_target_hf(e: &Env, strategy: &Address, target_hf: i128) {
    e.as_contract(strategy, || {
        let mut config = storage::get_config(e);
        config.target_hf = target_hf;
        storage::set_config(e, config);
    });
}

/// Execute a leverage loop step-by-step: supply→borrow in separate pool.submit() calls.
/// This matches how the Blend pool settles token flows.
/// Returns (total_b_tokens, total_d_tokens).
fn execute_leverage_loop_stepped(
    e: &Env,
    pool_addr: &Address,
    strategy: &Address,
    token: &Address,
    initial_amount: i128,
    c_factor: i128,
    n_loops: u32,
) -> (i128, i128) {
    let pool_client = pool::Client::new(e, pool_addr);
    let (supplies, borrows, count) = compute_loop_pairs(initial_amount, c_factor, n_loops);

    for i in 0..count as usize {
        let mut requests: Vec<pool::Request> = Vec::new(e);

        // Supply
        if supplies[i] > 0 {
            requests.push_back(pool::Request {
                address: token.clone(),
                amount: supplies[i],
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            });
        }

        // Borrow (if not the final supply-only step)
        if borrows[i] > 0 {
            requests.push_back(pool::Request {
                address: token.clone(),
                amount: borrows[i],
                request_type: REQUEST_TYPE_BORROW,
            });
        }

        pool_client
            .mock_all_auths()
            .submit(strategy, strategy, strategy, &requests);
    }

    // Read final positions
    let positions = pool_client.get_positions(strategy);
    let b_tokens = positions.collateral.get(0).unwrap_or(0);
    let d_tokens = positions.liabilities.get(0).unwrap_or(0);
    (b_tokens, d_tokens)
}

/// Execute an unwind: repay debt + withdraw collateral.
///
/// Plain `submit` does gross transfers (it does not net like
/// `submit_with_allowance`), so the spender needs tokens for the repay portion.
/// We pre-fund the strategy with repay tokens, then unwind to `to`, which
/// receives the withdrawal proceeds.
fn execute_unwind(
    e: &Env,
    pool_addr: &Address,
    strategy: &Address,
    to: &Address,
    token: &Address,
    b_tokens_to_remove: i128,
    d_tokens_to_remove: i128,
) {
    let pool_client = pool::Client::new(e, pool_addr);

    if d_tokens_to_remove > 0 {
        // Pre-fund strategy with tokens to cover the repay. Production uses
        // submit_with_allowance, which nets these flows and needs no funding;
        // plain submit() moves the gross amounts.
        StellarAssetClient::new(e, token)
            .mock_all_auths()
            .mint(strategy, &d_tokens_to_remove);

        let mut requests: Vec<pool::Request> = Vec::new(e);
        requests.push_back(pool::Request {
            address: token.clone(),
            amount: d_tokens_to_remove,
            request_type: REQUEST_TYPE_REPAY,
        });
        requests.push_back(pool::Request {
            address: token.clone(),
            amount: b_tokens_to_remove,
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
        });

        pool_client
            .mock_all_auths()
            .submit(strategy, strategy, to, &requests);
    } else if b_tokens_to_remove > 0 {
        pool_client.mock_all_auths().submit(
            strategy,
            strategy,
            to,
            &vec![
                e,
                pool::Request {
                    address: token.clone(),
                    amount: b_tokens_to_remove,
                    request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
                },
            ],
        );
    }
}

// ── Integration tests ────────────────────────────────────────────────────────

#[test]
fn test_simple_supply_and_borrow() {
    let e = Env::default();
    let (pool_addr, token, _blnd, _blend, _deployer) = setup_blend_env(&e);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = Address::generate(&e);
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &1_000_0000000);

    e.cost_estimate().budget().reset_unlimited();

    // Supply 1000
    let pool_client = pool::Client::new(&e, &pool_addr);
    pool_client.mock_all_auths().submit(
        &strategy,
        &strategy,
        &strategy,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    let positions = pool_client.get_positions(&strategy);
    let b_tokens = positions.collateral.get(0).unwrap_or(0);
    assert!(
        b_tokens > 0,
        "Should have b-tokens after supply: {}",
        b_tokens
    );

    // Borrow 900 (c=0.90, below pool's c=0.95 to keep HF > 1.0)
    pool_client.mock_all_auths().submit(
        &strategy,
        &strategy,
        &strategy,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 900_0000000,
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );

    let positions = pool_client.get_positions(&strategy);
    let d_tokens = positions.liabilities.get(0).unwrap_or(0);
    assert!(
        d_tokens > 0,
        "Should have d-tokens after borrow: {}",
        d_tokens
    );

    // Strategy should have received borrow proceeds
    let token_client = TokenClient::new(&e, &token);
    let balance = token_client.balance(&strategy);
    assert_eq!(balance, 900_0000000, "Should have borrow proceeds");
}

#[test]
fn test_leverage_loop_builds_correct_position() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = Address::generate(&e);
    let deposit_amount = 1_000_0000000_i128;
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &deposit_amount);

    e.cost_estimate().budget().reset_unlimited();

    let (b_tokens, d_tokens) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit_amount,
        config.c_factor,
        TEST_LOOPS,
    );

    assert!(b_tokens > 0, "Should have b-tokens: {}", b_tokens);
    assert!(d_tokens > 0, "Should have d-tokens: {}", d_tokens);

    // Verify leverage ratio
    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    let supply_value = b_tokens * b_rate / SCALAR_12;
    let debt_value = d_tokens * d_rate / SCALAR_12;
    let equity = supply_value - debt_value;

    // Equity should be close to the initial deposit
    let tolerance = deposit_amount / 50; // 2%
    assert!(
        (equity - deposit_amount).abs() < tolerance,
        "Equity {} should be close to deposit {} (diff={})",
        equity,
        deposit_amount,
        (equity - deposit_amount).abs()
    );

    // Leverage ratio should be ~3.4x for 3 loops at c=0.90
    let leverage_x100 = supply_value * 100 / deposit_amount;
    assert!(
        leverage_x100 > 300 && leverage_x100 < 400,
        "Leverage {}.{}x out of expected range (3.0-4.0x)",
        leverage_x100 / 100,
        leverage_x100 % 100
    );
}

#[test]
fn test_deposit_withdraw_full_cycle() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let user = Address::generate(&e);
    let deposit_amount = 1_000_0000000_i128;
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &deposit_amount);

    e.cost_estimate().budget().reset_unlimited();

    // === DEPOSIT ===
    let (b_tokens, d_tokens) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit_amount,
        config.c_factor,
        TEST_LOOPS,
    );

    // Account for deposit in reserves
    e.as_contract(&strategy, || {
        let init_reserves = LeverageReserves {
            total_shares: 0,
            total_b_tokens: 0,
            total_d_tokens: 0,
            b_rate: SCALAR_12,
            d_rate: SCALAR_12,
        };
        storage::set_total_shares(&e, init_reserves.total_shares);

        let (vault_minted, _lockup, updated) =
            reserves::deposit(&e, b_tokens, d_tokens, &init_reserves).unwrap();

        assert!(vault_minted > 0, "Should have shares");

        let balance = shares_to_underlying(vault_minted, &updated, 0).unwrap();
        assert!(
            balance > deposit_amount * 95 / 100,
            "Balance {} should be close to deposit {}",
            balance,
            deposit_amount
        );

        // === WITHDRAW === (user_shares read from the token in production)
        let (burned, b_remove, d_remove) =
            reserves::withdraw(&e, vault_minted, balance, &updated).unwrap();
        assert_eq!(vault_minted - burned, 0, "All shares should be burned");

        // Verify b/d amounts are proportional
        assert!(b_remove > 0 && d_remove > 0, "Should remove b and d tokens");
    });

    // Execute the actual unwind on pool
    execute_unwind(&e, &pool_addr, &strategy, &user, &token, b_tokens, d_tokens);

    // User received full withdrawal (b_tokens underlying value).
    // The net equity = withdrawal - repay = b_tokens_value - d_tokens_value ≈ deposit_amount.
    // Since we pre-funded the strategy with d_tokens for repay, the user's balance
    // equals the full withdrawal amount. The real equity is withdrawal - repay.
    let user_balance = TokenClient::new(&e, &token).balance(&user);
    assert!(user_balance > 0, "User should have tokens back");

    // Get rates to compute underlying values
    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    let b_value = b_tokens * b_rate / SCALAR_12;
    let d_value = d_tokens * d_rate / SCALAR_12;
    let equity = b_value - d_value;

    let tolerance = deposit_amount / 20; // 5%
    assert!(
        (equity - deposit_amount).abs() < tolerance,
        "Equity {} should be close to deposit {} (diff={})",
        equity,
        deposit_amount,
        (equity - deposit_amount).abs()
    );
}

#[test]
fn test_two_users_proportional() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 200_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let _alice = Address::generate(&e);
    let _bob = Address::generate(&e);
    let token_admin = StellarAssetClient::new(&e, &token);

    e.cost_estimate().budget().reset_unlimited();

    // Alice deposits 1000
    let alice_amount = 1_000_0000000_i128;
    token_admin.mock_all_auths().mint(&strategy, &alice_amount);

    let (b1, d1) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        alice_amount,
        config.c_factor,
        TEST_LOOPS,
    );

    // Bob deposits 2000
    let bob_amount = 2_000_0000000_i128;
    token_admin.mock_all_auths().mint(&strategy, &bob_amount);

    let pool_client = pool::Client::new(&e, &pool_addr);
    let pre_bob = pool_client.get_positions(&strategy);
    let pre_b = pre_bob.collateral.get(0).unwrap_or(0);
    let pre_d = pre_bob.liabilities.get(0).unwrap_or(0);

    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        bob_amount,
        config.c_factor,
        TEST_LOOPS,
    );

    let post_bob = pool_client.get_positions(&strategy);
    let post_b = post_bob.collateral.get(0).unwrap_or(0);
    let post_d = post_bob.liabilities.get(0).unwrap_or(0);

    let b2 = post_b - pre_b;
    let d2 = post_d - pre_d;

    // Account in reserves
    e.as_contract(&strategy, || {
        let init = LeverageReserves {
            total_shares: 0,
            total_b_tokens: 0,
            total_d_tokens: 0,
            b_rate: SCALAR_12,
            d_rate: SCALAR_12,
        };
        storage::set_total_shares(&e, init.total_shares);

        let (alice_shares, _, after_alice) = reserves::deposit(&e, b1, d1, &init).unwrap();
        let (bob_shares, _, after_bob) = reserves::deposit(&e, b2, d2, &after_alice).unwrap();

        let alice_val = shares_to_underlying(alice_shares, &after_bob, 0).unwrap();
        let bob_val = shares_to_underlying(bob_shares, &after_bob, 0).unwrap();

        // Bob should have ~2x Alice's value
        let ratio_x100 = bob_val * 100 / alice_val;
        assert!(
            ratio_x100 > 190 && ratio_x100 < 210,
            "Bob ~2x Alice: alice={}, bob={}, ratio={}",
            alice_val,
            bob_val,
            ratio_x100
        );
    });
}

#[test]
fn test_health_factor_from_pool() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = Address::generate(&e);
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &1_000_0000000);

    e.cost_estimate().budget().reset_unlimited();

    let (b_tokens, d_tokens) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        1_000_0000000,
        config.c_factor,
        TEST_LOOPS,
    );

    let (b_rate, d_rate, _, l_factor) = blend_pool::get_rates_and_factors(&e, &config);

    let hf = compute_health_factor(
        b_tokens,
        d_tokens,
        b_rate,
        d_rate,
        config.c_factor,
        l_factor,
    )
    .unwrap();

    // With 3 loops at the strategy's c = 0.90, HF should be > min_hf (1.05)
    assert!(
        hf > config.min_hf,
        "HF {} should be > min_hf {}",
        hf,
        config.min_hf
    );
    // HF should be reasonable (not astronomical)
    assert!(hf < 100 * SCALAR_7, "HF {} seems too high", hf);
}

#[test]
fn test_pool_rates_query() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    e.cost_estimate().budget().reset_unlimited();

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(b_rate >= SCALAR_12, "b_rate should be >= 1.0: {}", b_rate);
    assert!(d_rate >= SCALAR_12, "d_rate should be >= 1.0: {}", d_rate);
}

#[test]
fn test_pool_utilization_query() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 10_000_0000000);

    e.cost_estimate().budget().reset_unlimited();

    // Read-only query doesn't need contract context
    let strategy = e.register(TestStrategyContract, ());
    e.as_contract(&strategy, || {
        let (supply, borrow) = get_pool_utilization(&e, &config);
        assert!(supply > 0, "Pool should have supply: {}", supply);
        assert_eq!(borrow, 0, "No borrows initially");
    });
}

#[test]
fn test_deleverage_step_by_step() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = Address::generate(&e);
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &1_000_0000000);

    e.cost_estimate().budget().reset_unlimited();

    // Build leveraged position
    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        1_000_0000000,
        config.c_factor,
        TEST_LOOPS,
    );

    let pool_client = pool::Client::new(&e, &pool_addr);
    let pre = pool_client.get_positions(&strategy);
    let pre_b = pre.collateral.get(0).unwrap_or(0);
    let pre_d = pre.liabilities.get(0).unwrap_or(0);

    // Deleverage: withdraw some collateral, repay some debt
    // Each "unwind" step: withdraw + repay one layer
    let layer = pre_d * (SCALAR_7 - config.c_factor) / SCALAR_7;

    // Pre-fund strategy with tokens for repay (pool does gross transfers)
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &layer);

    // Repay + withdraw in a single submit
    pool_client.mock_all_auths().submit(
        &strategy,
        &strategy,
        &strategy,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: layer,
                request_type: REQUEST_TYPE_REPAY,
            },
            pool::Request {
                address: token.clone(),
                amount: layer,
                request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
            },
        ],
    );

    let post = pool_client.get_positions(&strategy);
    let post_b = post.collateral.get(0).unwrap_or(0);
    let post_d = post.liabilities.get(0).unwrap_or(0);

    assert!(post_b < pre_b, "b-tokens should decrease");
    assert!(post_d < pre_d, "d-tokens should decrease");

    // Equity should be approximately preserved
    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    let pre_eq = pre_b * b_rate / SCALAR_12 - pre_d * d_rate / SCALAR_12;
    let post_eq = post_b * b_rate / SCALAR_12 - post_d * d_rate / SCALAR_12;
    let diff = (post_eq - pre_eq).abs();
    let tolerance = 1_000_0000000 / 20; // 5%
    assert!(
        diff < tolerance,
        "Equity preserved: pre={}, post={}, diff={}",
        pre_eq,
        post_eq,
        diff
    );
}

// ── Share-token wiring (D2 integration) ──────────────────────────────────────

// ── Mock Soroswap router ─────────────────────────────────────────────────────

#[contracttype]
enum RouterKey {
    Rate,
    LastMin,
    LastPath,
}

/// Minimal stand-in for the Soroswap router, enough to exercise the strategy's
/// swap leg: it quotes at a fixed rate, **enforces `amount_out_min`** the way
/// the real router does, and records the last one it was handed so a test can
/// assert what floor the strategy actually sent. It plays the pair as well as
/// the router — `router_pair_for` returns its own address, so the input tokens
/// land here and the output is paid from its own balance.
#[contract]
pub struct MockSoroswapRouter;

#[contractimpl]
impl MockSoroswapRouter {
    /// `rate` is output per `SCALAR_7` of input, matching `min_harvest_rate`'s
    /// units so tests can put the quote directly either side of the floor.
    pub fn __constructor(e: Env, rate: i128) {
        e.storage().instance().set(&RouterKey::Rate, &rate);
    }

    pub fn router_pair_for(e: Env, _token_a: Address, _token_b: Address) -> Address {
        e.current_contract_address()
    }

    pub fn swap_exact_tokens_for_tokens(
        e: Env,
        amount_in: i128,
        amount_out_min: i128,
        path: Vec<Address>,
        to: Address,
        _deadline: u64,
    ) -> Vec<i128> {
        e.storage()
            .instance()
            .set(&RouterKey::LastMin, &amount_out_min);
        e.storage().instance().set(&RouterKey::LastPath, &path);
        let rate: i128 = e.storage().instance().get(&RouterKey::Rate).unwrap();
        let amount_out = amount_in * rate / SCALAR_7;
        if amount_out < amount_out_min {
            panic!("soroswap: insufficient output amount");
        }
        let pair = e.current_contract_address();
        TokenClient::new(&e, &path.get(0).unwrap()).transfer(&to, &pair, &amount_in);
        TokenClient::new(&e, &path.last().unwrap()).transfer(&pair, &to, &amount_out);
        // One amount per token on the path, as the real router returns; the
        // intermediate hops are not modelled.
        let mut amounts = vec![&e, amount_in];
        for _ in 2..path.len() {
            amounts.push_back(0);
        }
        amounts.push_back(amount_out);
        amounts
    }

    /// The path of the most recent swap.
    pub fn last_path(e: Env) -> Vec<Address> {
        e.storage().instance().get(&RouterKey::LastPath).unwrap()
    }

    /// The `amount_out_min` of the most recent swap.
    pub fn last_amount_out_min(e: Env) -> i128 {
        e.storage().instance().get(&RouterKey::LastMin).unwrap_or(0)
    }
}

/// The share token's release wasm, which the strategy's constructor deploys.
/// Build it before these tests:
/// `(cd contracts/tokens/vault_share && cargo build --locked --target wasm32v1-none --release)`.
const SHARE_TOKEN_WASM: &[u8] = include_bytes!(
    "../../../tokens/vault_share/target/wasm32v1-none/release/vault_share_token.wasm"
);

/// Register the real strategy via its constructor against the Blend fixture.
fn register_real_strategy(
    e: &Env,
    pool_addr: &Address,
    asset: &Address,
    blnd: &Address,
) -> Address {
    register_real_strategy_with_target(e, pool_addr, asset, blnd, TARGET_HF)
}

/// Same as `register_real_strategy` but with a configurable `target_hf`.
/// At c = 0.90, 8 loops opens at HF ≈ 1.076 — above min_hf (1.05) so the
/// deposit passes the safety check, but inside the orange zone (< 1.15), which
/// is exactly the stressed fixture the auto-rebalance keeper tests need.
fn register_real_strategy_with_target(
    e: &Env,
    pool_addr: &Address,
    asset: &Address,
    blnd: &Address,
    target_hf: i128,
) -> Address {
    register_real_strategy_with_target_and_router(
        e,
        pool_addr,
        asset,
        blnd,
        target_hf,
        &Address::generate(e),
    )
}

/// Same again with the Soroswap router under the test's control. Everywhere
/// else the router is an unregistered generated address — fine, because no
/// other test reaches the swap — but the trait-`harvest` slippage tests need a
/// router that actually quotes and enforces `amount_out_min`.
fn register_real_strategy_with_target_and_router(
    e: &Env,
    pool_addr: &Address,
    asset: &Address,
    blnd: &Address,
    target_hf: i128,
    router: &Address,
) -> Address {
    let router = router.clone();
    let keeper = Address::generate(e);
    let admin = Address::generate(e);
    let init_args: Vec<Val> = vec![
        e,
        pool_addr.into_val(e),
        blnd.into_val(e),
        router.into_val(e),
        1_0000000_i128.into_val(e), // reward_threshold
        keeper.into_val(e),
        9_000_000_i128.into_val(e), // c_factor 0.90
        target_hf.into_val(e),
        10_500_000_i128.into_val(e), // min_hf 1.05
        11_500_000_i128.into_val(e), // orange_hf 1.15
        admin.into_val(e),
        e.deployer()
            .upload_contract_wasm(SHARE_TOKEN_WASM)
            .into_val(e), // share token wasm
        String::from_str(e, "BlendLeverage TEST Share").into_val(e),
        String::from_str(e, "blvTEST").into_val(e),
    ];
    e.register(crate::BlendLeverageStrategy, (asset.clone(), init_args))
}

// The strategy deploys its own share token and is both its admin and its
// minter, so neither can change after construction: the strategy has no
// setter for its token, and no key outside it can call the token's
// `set_minter` or `set_admin`.
#[test]
fn test_the_strategy_owns_its_share_token() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());

    assert_eq!(share.minter(), strategy);
    assert_eq!(share.admin(), strategy);
    assert_eq!(share.decimals(), TokenClient::new(&e, &token).decimals());
    assert_eq!(share.symbol(), String::from_str(&e, "blvTEST"));
    assert_eq!(share.total_supply(), 0);

    // Not even the strategy's admin key can change either: only the strategy's
    // own authorization could, and it never gives it.
    let admin = sclient.admin();
    let outsider = Address::generate(&e);
    let args: Vec<Val> = (outsider.clone(),).into_val(&e);
    let as_admin = |fn_name: &'static str| MockAuthInvoke {
        contract: &share.address,
        fn_name,
        args: args.clone(),
        sub_invokes: &[],
    };
    let set_minter = as_admin("set_minter");
    let set_admin = as_admin("set_admin");
    assert!(share
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &set_minter,
        }])
        .try_set_minter(&outsider)
        .is_err());
    assert!(share
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &set_admin,
        }])
        .try_set_admin(&outsider)
        .is_err());
    assert_eq!(share.minter(), strategy);
    assert_eq!(share.admin(), strategy);
}

// Admin recovery path: the admin can rotate the keeper via `admin_set_keeper`
// without the old keeper's cooperation (second of the two rotation routes).
#[test]
fn test_admin_set_keeper_rotates_keeper() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    let new_keeper = Address::generate(&e);
    sclient.admin_set_keeper(&new_keeper);
    assert_eq!(
        sclient.get_keeper(),
        new_keeper,
        "admin must be able to recover/rotate the keeper"
    );
}

// The `config()` view must expose exactly the risk parameters the constructor
// was given — it is the anti-drift source of truth for the frontend/keeper.
#[test]
fn test_config_view_exposes_constructor_risk_params() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Values from register_real_strategy's init_args.
    let (c_factor, target_hf, min_hf, orange_hf) = sclient.config();
    assert_eq!(c_factor, 9_000_000, "c_factor 0.90");
    assert_eq!(target_hf, TARGET_HF, "target_hf");
    assert_eq!(min_hf, 10_500_000, "min_hf 1.05");
    assert_eq!(orange_hf, 11_500_000, "orange_hf 1.15");
}

/// A token reporting 18 decimals, for the constructor's decimals check.
#[contract]
pub struct EighteenDecimalsToken;

#[contractimpl]
impl EighteenDecimalsToken {
    pub fn decimals(_e: Env) -> u32 {
        18
    }
}

// Share pricing multiplies shares by equity in i128, which a high-decimals
// asset overflows at trivial sizes (~13 tokens at 18 decimals), so the
// constructor refuses one.
#[test]
#[should_panic(expected = "asset decimals must be <= 7")]
fn test_constructor_refuses_an_asset_with_more_than_7_decimals() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, _token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let token = e.register(EighteenDecimalsToken, ());
    register_real_strategy(&e, &pool_addr, &token, &blnd);
}

// ── Risk parameter setters ───────────────────────────────────────────────────

// The admin can retune the risk parameters without a redeploy, and the change
// applies to the next deposit: here a lower target_hf levers it further.
#[test]
fn test_set_risk_params_applies_to_the_next_deposit() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    sclient.set_risk_params(&9_000_000, &11_800_000, &10_600_000, &11_600_000);
    assert_eq!(
        sclient.config(),
        (9_000_000, 11_800_000, 10_600_000, 11_600_000)
    );

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    let hf = sclient.health_factor();
    assert!(
        (hf - 11_800_000).abs() <= 2,
        "the deposit lands on the new target: {}",
        hf
    );

    sclient.set_reward_threshold(&5_0000000);
    let stored = e.as_contract(&strategy, || storage::get_config(&e).reward_threshold);
    assert_eq!(stored, 5_0000000);
}

// When borrowing costs more than BLND pays, the vault is taken almost unlevered
// with the controls it has (the runbook's "De-risk a vault"): the admin raises
// `target_hf` to 100 and the keeper unwinds to it. At HF 100 the debt is about
// 1% of the collateral; `releverage` holds the vault there, and new deposits
// land there too.
#[test]
fn test_the_admin_and_the_keeper_can_take_a_vault_almost_unlevered() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let (c_factor, target_hf, min_hf, orange_hf) = sclient.config();
    let de_risked = 100 * SCALAR_7;
    let debt_share = |sclient: &crate::BlendLeverageStrategyClient| {
        let (_, _, b, d, b_rate, d_rate) = sclient.position();
        (d * d_rate) as f64 / (b * b_rate) as f64
    };

    sclient.set_risk_params(&c_factor, &de_risked, &min_hf, &orange_hf);
    sclient.partial_unwind(&de_risked);
    assert!(sclient.health_factor() >= de_risked);
    assert!(
        debt_share(&sclient) <= 0.01,
        "debt/collateral = {}",
        debt_share(&sclient)
    );
    assert_eq!(sclient.releverage(), 0, "held at the de-risked target");

    let user = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    assert!(
        debt_share(&sclient) <= 0.01,
        "debt/collateral = {}",
        debt_share(&sclient)
    );

    // Restoring the target lets the keeper lever back up to it.
    sclient.set_risk_params(&c_factor, &target_hf, &min_hf, &orange_hf);
    assert!(sclient.releverage() > 0);
    let hf = sclient.health_factor();
    assert!(
        hf >= target_hf && hf - target_hf <= 1_000,
        "back at the target: {} for {}",
        hf,
        target_hf
    );
}

// The setter runs the constructor's own validation, against the live pool: a
// target inside the rebalance band, or a c_factor above the pool's (what a Blend
// governance cut would leave), is refused and nothing changes.
#[test]
fn test_set_risk_params_is_validated_like_the_constructor() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let before = sclient.config();

    // orange_hf 1.15 needs target_hf >= 1.17.
    assert!(sclient
        .try_set_risk_params(&9_000_000, &11_699_999, &10_500_000, &11_500_000)
        .is_err());
    // The test pool's c_factor is 0.95.
    assert!(sclient
        .try_set_risk_params(&9_600_000, &TARGET_HF, &10_500_000, &11_500_000)
        .is_err());
    assert!(sclient.try_set_reward_threshold(&0).is_err());
    assert_eq!(sclient.config(), before, "a refused change changes nothing");
}

// Both setters are admin-gated: with no authorization mocked, they are refused.
#[test]
fn test_risk_setters_require_the_admin() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    e.set_auths(&[]);
    assert!(sclient
        .try_set_risk_params(&9_000_000, &TARGET_HF, &10_500_000, &11_500_000)
        .is_err());
    assert!(sclient.try_set_reward_threshold(&5_0000000).is_err());
}

// ── Auto-rebalance keeper auth & rate-limit (T2.3) ────────────────────────────

#[test]
fn test_rebalance_keeper_auth_gating_and_noop() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let stranger = Address::generate(&e);

    // Signed by a stranger instead of the keeper, the call is rejected.
    assert!(
        sclient
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &strategy,
                    fn_name: "rebalance_keeper",
                    args: Vec::new(&e),
                    sub_invokes: &[],
                },
            }])
            .try_rebalance_keeper()
            .is_err(),
        "non-keeper must be rejected"
    );

    // The keeper may call; with no open position (no debt) it is a no-op.
    assert_eq!(sclient.rebalance_keeper(), 0, "no debt → no-op");

    // The permissionless rebalance is also a safe no-op with no position.
    sclient.rebalance();
}

// Opens a REAL stressed position through the production `deposit` entrypoint:
// 8 loops at c = 0.90 lands at HF ≈ 1.076 — above min_hf (1.05) so the deposit
// safety check passes, but inside the orange zone (< orange_hf 1.15), so the
// auto-rebalance keeper has genuine work to do. Returns the strategy address.
fn open_stressed_strategy(
    e: &Env,
    pool_addr: &Address,
    token: &Address,
    blnd: &Address,
) -> Address {
    let strategy = register_real_strategy(e, pool_addr, token, blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    set_target_hf(e, &strategy, STRESSED_HF);
    sclient.deposit(&1_000_0000000, &user);
    set_target_hf(e, &strategy, TARGET_HF);
    strategy
}

/// Find the strategy's `("rebalance", caller)` event in the LAST invocation's
/// event stream and decode its `(before_hf, after_hf, repaid)` payload.
///
/// NOTE: `e.events().all()` only surfaces the last contract invocation's
/// events, so this must be called immediately after the rebalance entrypoint,
/// before any other contract call.
fn find_rebalance_event(
    e: &Env,
    strategy: &Address,
    caller: &Address,
) -> Option<(i128, i128, i128)> {
    use soroban_sdk::{xdr, TryFromVal, Val};
    let events = e.events().all().filter_by_contract(strategy);
    for ev in events.events() {
        let xdr::ContractEventBody::V0(v0) = &ev.body;
        if v0.topics.len() != 2 {
            continue;
        }
        let t0 = Symbol::try_from_val(e, &v0.topics[0]);
        let t1 = Address::try_from_val(e, &v0.topics[1]);
        if t0 != Ok(Symbol::new(e, "rebalance")) || t1.as_ref() != Ok(caller) {
            continue;
        }
        let data: Val = Val::try_from_val(e, &v0.data).ok()?;
        return <(i128, i128, i128)>::try_from_val(e, &data).ok();
    }
    None
}

// T2.3 spec: "unwinds N loops to restore target when HF drops below the
// configured threshold; emits events with before/after HF and loops unwound."
// The loops are now one exact repay, so the event carries the underlying repaid.
// Drives the REAL `rebalance_keeper` entrypoint against a REAL stressed
// position on the REAL Blend pool and asserts every observable in the spec:
// HF restored to the rebalance target (orange_hf + REBALANCE_HF_BUFFER), a
// positive repay returned, and the `rebalance` event emitted with a payload
// consistent with the on-chain state transition.
#[test]
fn test_rebalance_keeper_unwinds_stressed_position_and_emits_event() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    let (_, _, min_hf, orange_hf) = sclient.config();
    let before_hf = sclient.health_factor();
    assert!(
        before_hf >= min_hf && before_hf < orange_hf,
        "fixture must open inside the orange zone: hf={}, orange={}",
        before_hf,
        orange_hf
    );

    let repaid = sclient.rebalance_keeper();
    assert!(repaid > 0, "stressed position must repay debt");

    // The `rebalance` event carries (before_hf, after_hf, repaid). Captured
    // FIRST: the test env only keeps the last invocation's events.
    let (ev_before, ev_after, ev_repaid) = find_rebalance_event(&e, &strategy, &keeper)
        .expect("rebalance event must be emitted on every rebalance");

    // HF lands on the rebalance target: at it, and only a hair above.
    let target = orange_hf + crate::constants::REBALANCE_HF_BUFFER;
    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= target,
        "HF must be restored: after={}, target={}",
        after_hf,
        target
    );
    assert!(
        after_hf <= target + 10,
        "HF must land on the target, not past it: after={}, target={}",
        after_hf,
        target
    );

    assert_eq!(ev_before, before_hf, "event before_hf matches pre-state");
    assert_eq!(ev_repaid, repaid, "event repaid matches return value");
    assert!(
        ev_after >= target,
        "event after_hf must be at/above target: {}",
        ev_after
    );
    assert_eq!(ev_after, after_hf, "event after_hf matches post-state");

    std::println!(
        "keeper rebalance: hf {} -> {} (target {}), repaid={}",
        before_hf,
        after_hf,
        target,
        repaid
    );
}

// `unwind_to` refuses a deleverage that leaves HF lower than it found it. That
// guard must never fire on a real rebalance, or it would block liquidation
// protection: across liability markups and accrued rates, the keeper's
// rebalance goes through and the HF it reports only rises.
#[test]
fn test_rebalance_never_lowers_the_health_factor() {
    for l_factor in [10_000_000_u32, 9_500_000, 8_500_000] {
        for seconds in [0_u64, 30 * 24 * 60 * 60] {
            let e = Env::default();
            e.mock_all_auths();
            e.cost_estimate().budget().reset_unlimited();
            let (pool_addr, token, blnd, _blend, _deployer) =
                setup_blend_env_with_l_factor(&e, l_factor);
            seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
            let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
            if seconds > 0 {
                accrue_interest(&e, &pool_addr, &token, seconds);
            }
            let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
            let keeper = sclient.get_keeper();

            assert!(
                sclient.rebalance_keeper() > 0,
                "l={} after {}s: the stressed position must repay",
                l_factor,
                seconds
            );
            let (before_hf, after_hf, _) =
                find_rebalance_event(&e, &strategy, &keeper).expect("rebalance event");
            assert!(
                after_hf > before_hf,
                "l={} after {}s: HF {} -> {}",
                l_factor,
                seconds,
                before_hf,
                after_hf
            );
        }
    }
}

// The rebalance needs no rate limit: it acts only below `orange_hf` and lands
// above it, so an immediate repeat — by the keeper, or by anyone through the
// permissionless `rebalance` — repays nothing, emits nothing and leaves the
// position exactly where the first call put it.
#[test]
fn test_rebalance_keeper_repeat_call_is_a_noop() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    let repaid = sclient.rebalance_keeper();
    assert!(repaid > 0, "first call must unwind");
    let hf = sclient.health_factor();
    let position = sclient.position();

    assert_eq!(
        sclient.rebalance_keeper(),
        0,
        "an immediate repeat repays nothing"
    );
    assert!(
        find_rebalance_event(&e, &strategy, &keeper).is_none(),
        "no event on the repeat"
    );
    sclient.rebalance();

    assert_eq!(sclient.health_factor(), hf, "HF untouched by the repeats");
    assert_eq!(
        sclient.position(),
        position,
        "position untouched by the repeats"
    );
}

// T2.3 spec edge case: "already at floor". A healthy position (HF >= orange_hf,
// debt outstanding) must be a clean no-op: nothing repaid, no `rebalance`
// event, position untouched.
#[test]
fn test_rebalance_keeper_already_at_floor_is_a_noop() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    // 3 loops at c = 0.90 opens at HF ≈ 1.27 — debt outstanding, above orange.
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    let keeper = sclient.get_keeper();
    let (_, _, _, orange_hf) = sclient.config();
    let hf = sclient.health_factor();
    let (_, _, _, d_tokens, _, _) = sclient.position();
    assert!(d_tokens > 0, "fixture must carry debt");
    assert!(hf >= orange_hf, "fixture must sit at/above the floor");

    // No-op: nothing repaid, no event, position untouched.
    assert_eq!(sclient.rebalance_keeper(), 0, "at floor → no-op");
    assert!(
        find_rebalance_event(&e, &strategy, &keeper).is_none(),
        "no event on a no-op"
    );
    assert_eq!(sclient.health_factor(), hf, "position untouched");
}

// ── partial_unwind is keeper-only (audit M-1) ────────────────────────────────

// Regression for M-1. `partial_unwind` used to be open to anyone inside the
// orange zone, and to pass the caller's `target_hf` straight through: any
// address could ask for an arbitrarily large target and drive
// `compute_partial_unwind` to a full repay — the whole debt retired, the vault's
// yield destroyed for a transaction fee. It now takes the keeper's
// authorization at any HF, so a stranger cannot reach it at all; the protective
// unwind open to anyone is `rebalance()`, which lands on the rebalance target
// and no further.
#[test]
fn test_partial_unwind_is_keeper_only_even_in_the_orange_zone() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let (_, _, _, orange_hf) = sclient.config();
    let before_hf = sclient.health_factor();
    assert!(
        before_hf < orange_hf,
        "fixture must open inside the orange zone, where no keeper used to be needed"
    );

    // A stranger signs a call asking for HF 100, enough to clamp the closed form
    // to a full repay. Without the keeper's signature it is refused.
    let stranger = Address::generate(&e);
    let target = 100_0000000_i128;
    let args: Vec<Val> = (target,).into_val(&e);
    assert!(sclient
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &strategy,
                fn_name: "partial_unwind",
                args,
                sub_invokes: &[],
            },
        }])
        .try_partial_unwind(&target)
        .is_err());
    assert_eq!(sclient.health_factor(), before_hf, "position untouched");

    // Anyone can still protect the vault through `rebalance()`, which lands on
    // the rebalance target and leaves the debt in place.
    sclient.rebalance();
    let after_hf = sclient.health_factor();
    let floor = orange_hf + crate::constants::REBALANCE_HF_BUFFER;
    assert!(
        after_hf >= floor && after_hf <= floor + 10,
        "rebalance lands on the rebalance target: after={}, target={}",
        after_hf,
        floor
    );
    let (_, _, _, d_after, _, _) = sclient.position();
    assert!(d_after > 0, "rebalance must not retire the whole debt");
}

// The keeper's authorization is spent even when the call has nothing to do. A
// call that returned before asking for it left the signature unspent, so anyone
// could replay it from the public transaction until it expired, deleveraging
// the vault at a moment of their choosing; a debt-free vault was that case.
#[test]
fn test_partial_unwind_spends_the_keeper_authorization_on_a_no_op() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();
    let (_, _, _, orange_hf) = sclient.config();
    let target = orange_hf + crate::constants::REBALANCE_HF_BUFFER;
    let keeper_signed = || {
        std::vec![(
            keeper.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    strategy.clone(),
                    Symbol::new(&e, "partial_unwind"),
                    (target,).into_val(&e),
                )),
                sub_invocations: std::vec![],
            },
        )]
    };

    // No debt at all.
    assert_eq!(sclient.partial_unwind(&target), 0);
    assert_eq!(
        e.auths(),
        keeper_signed(),
        "keeper auth required with no debt"
    );

    // Debt, with HF already above the target.
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = keeper.clone();
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    assert!(
        sclient.health_factor() > target,
        "precondition: above target"
    );
    assert_eq!(sclient.partial_unwind(&target), 0);
    assert_eq!(
        e.auths(),
        keeper_signed(),
        "keeper auth required above target"
    );
}

// The keeper gets the `target_hf` it asks for, above the orange zone too, so it
// can deleverage past orange_hf when it judges that necessary.
#[test]
fn test_partial_unwind_honours_keeper_target_above_orange() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();
    let (_, _, _, orange_hf) = sclient.config();

    // A target comfortably above the orange floor (1.15), further than
    // `rebalance()` would unwind.
    let target = orange_hf + 2_000_000;
    let repaid = sclient.partial_unwind(&target);
    assert!(repaid > 0, "keeper unwind must do work");
    let (_, _, ev_repaid) = find_rebalance_event(&e, &strategy, &keeper)
        .expect("the rebalance event is attributed to the keeper");
    assert_eq!(ev_repaid, repaid);

    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= target,
        "keeper target must be honoured: after={}, target={}",
        after_hf,
        target
    );
}

// ── releverage (audit M-3) ───────────────────────────────────────────────────

// Opens a REAL healthy position through the production `deposit` entrypoint:
// 3 loops at c = 0.90 lands at HF ≈ 1.269 — the design HF for that loop count,
// comfortably above the orange floor (1.15). Returns the strategy address.
fn open_healthy_strategy(e: &Env, pool_addr: &Address, token: &Address, blnd: &Address) -> Address {
    let strategy = register_real_strategy(e, pool_addr, token, blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    strategy
}

/// Find the strategy's `("releverage", caller)` event in the LAST invocation's
/// event stream and decode its `(before_hf, after_hf, borrowed)` payload. Same
/// last-invocation caveat as `find_rebalance_event`.
fn find_releverage_event(
    e: &Env,
    strategy: &Address,
    caller: &Address,
) -> Option<(i128, i128, i128)> {
    use soroban_sdk::{xdr, TryFromVal, Val};
    let events = e.events().all().filter_by_contract(strategy);
    for ev in events.events() {
        let xdr::ContractEventBody::V0(v0) = &ev.body;
        if v0.topics.len() != 2 {
            continue;
        }
        let t0 = Symbol::try_from_val(e, &v0.topics[0]);
        let t1 = Address::try_from_val(e, &v0.topics[1]);
        if t0 != Ok(Symbol::new(e, "releverage")) || t1.as_ref() != Ok(caller) {
            continue;
        }
        let data: Val = Val::try_from_val(e, &v0.data).ok()?;
        return <(i128, i128, i128)>::try_from_val(e, &data).ok();
    }
    None
}

// The finding itself: leverage removed by an unwind never came back. An
// emergency keeper deleverage leaves the vault under-levered, `rebalance` can
// only ever remove more, and every other lever-adding path (`deposit`,
// `harvest`) touches only the new capital it brings in — so the position stayed
// where the unwind left it, earning the reduced yield, indefinitely.
//
// Drives the real entrypoints against the real Blend pool: deleverage hard, show
// `rebalance` cannot undo it, then `releverage` back to exactly the design
// leverage — with equity, and therefore every holder's share price, untouched.
#[test]
fn test_releverage_restores_design_leverage_after_an_emergency_unwind() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    let (c_factor, design_hf, _, _) = sclient.config();
    let (_, _, l_factor) = sclient.risk_factors();

    let (_equity0, _, _, d0, _, _) = sclient.position();
    let hf0 = sclient.health_factor();
    assert!(
        hf0 <= design_hf + design_hf / 1_000,
        "a fresh deposit opens at the design HF: {} vs {}",
        hf0,
        design_hf
    );

    // Emergency: the keeper deleverages far past the orange floor.
    let repaid = sclient.partial_unwind(&(design_hf + 4_000_000));
    assert!(repaid > 0, "emergency unwind must do work");

    let (equity1, _, _, d1, _, _) = sclient.position();
    let hf1 = sclient.health_factor();
    assert!(hf1 > hf0, "unwind must have removed leverage");
    assert!(d1 < d0, "debt must have been repaid");

    // Nothing on-chain used to be able to put that leverage back: `rebalance`
    // only ever unwinds, so above the orange floor it is a no-op.
    sclient.rebalance();
    assert_eq!(
        sclient.health_factor(),
        hf1,
        "rebalance cannot restore leverage — that is the finding"
    );

    let borrowed = sclient.releverage();
    assert!(borrowed > 0, "re-leverage must borrow: {}", borrowed);

    let (ev_before, ev_after, ev_borrowed) = find_releverage_event(&e, &strategy, &keeper)
        .expect("releverage event must be emitted when leverage is added");

    let hf2 = sclient.health_factor();
    let (equity2, _, b2, d2, b_rate, _) = sclient.position();

    // Landed ON the design HF — restored, not merely improved, and not past it.
    assert!(
        hf2 >= design_hf,
        "must not lever past the design target: {} < {}",
        hf2,
        design_hf
    );
    assert!(
        hf2 <= design_hf + design_hf / 1_000,
        "must actually restore the design target: {} vs {}",
        hf2,
        design_hf
    );
    assert!(d2 > d1, "debt restored: {} vs {}", d2, d1);

    // The leverage ratio matches what a fresh deposit of the same equity would
    // have built — the HF cap and the deposit sizing agree.
    let (design_supply, design_borrow) =
        crate::leverage::compute_lever_in(1_000_000_000_000_i128, c_factor, l_factor, design_hf)
            .unwrap();
    let design_lev = design_supply * SCALAR_7 / (design_supply - design_borrow);
    let lev = (b2 * b_rate / SCALAR_12) * SCALAR_7 / equity2;
    assert!(
        (lev - design_lev).abs() <= design_lev / 500,
        "restored leverage {} must match design {}",
        lev,
        design_lev
    );

    // Equity — and therefore the share price — is untouched: the borrow and the
    // supply are the same amount.
    assert!(
        (equity2 - equity1).abs() <= equity1 / 1_000_000 + 10,
        "re-leverage must not move equity: {} vs {}",
        equity2,
        equity1
    );

    assert_eq!(ev_before, hf1, "event before_hf matches pre-state");
    assert_eq!(ev_after, hf2, "event after_hf matches post-state");
    assert_eq!(ev_borrowed, borrowed, "event amount matches return value");

    std::println!(
        "releverage: hf {} -> {} (design {}), borrowed={}",
        hf1,
        hf2,
        design_hf,
        borrowed
    );
}

// A target inside the rebalance band — where every deposit would open as
// `rebalance` bait, and a re-leverage would hand the position straight back to
// it — is refused at construction rather than tolerated afterwards.
#[test]
#[should_panic(expected = "target_hf must clear orange_hf by RELEVERAGE_HF_BUFFER")]
fn test_constructor_refuses_a_target_inside_the_rebalance_band() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    // orange_hf is 1.15 in these tests: the lowest target accepted is 1.17.
    register_real_strategy_with_target(
        &e,
        &pool_addr,
        &token,
        &blnd,
        11_500_000 + crate::constants::RELEVERAGE_HF_BUFFER - 1,
    );
}

// The hysteresis band, on-chain. At the lowest target the constructor accepts,
// `orange_hf + RELEVERAGE_HF_BUFFER`, a re-leverage lands just clear of the
// rebalance band — and the proof it is far enough is that a rebalance
// immediately afterwards has nothing to do.
#[test]
fn test_releverage_to_the_lowest_target_stays_clear_of_the_rebalance_band() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let orange_hf = 11_500_000;
    let floor = orange_hf + crate::constants::RELEVERAGE_HF_BUFFER;
    let strategy = register_real_strategy_with_target(&e, &pool_addr, &token, &blnd, floor);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    // Deleverage well clear of the band, then re-lever.
    sclient.partial_unwind(&(orange_hf + 3_000_000));
    let borrowed = sclient.releverage();
    assert!(borrowed > 0, "must re-lever toward the target");

    let hf = sclient.health_factor();
    assert!(
        hf >= floor && hf <= floor + floor / 1_000,
        "must land on the target: {} vs {}",
        hf,
        floor
    );

    // No ping-pong: the position is clear of the rebalance band, so the
    // permissionless rebalance immediately afterwards is a no-op.
    sclient.rebalance();
    assert_eq!(
        sclient.health_factor(),
        hf,
        "re-levered position must not be rebalance bait"
    );
}

// A position with no slack must be left alone — and, like `rebalance_keeper`'s
// no-op, must not consume the cooldown, so a probe can never lock the keeper out
// of a real re-leverage.
#[test]
fn test_releverage_noop_without_slack_does_not_consume_cooldown() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    // A fresh deposit already sits at its design HF: there is nothing to restore.
    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    let hf = sclient.health_factor();
    let (equity, _, b, d, _, _) = sclient.position();

    assert_eq!(sclient.releverage(), 0, "no slack → no-op");
    assert!(
        find_releverage_event(&e, &strategy, &keeper).is_none(),
        "no event on a no-op"
    );

    let (equity_after, _, b_after, d_after, _, _) = sclient.position();
    assert_eq!(sclient.health_factor(), hf, "position untouched");
    assert_eq!((equity_after, b_after, d_after), (equity, b, d));

    let last = e.as_contract(&strategy, || storage::get_last_releverage(&e));
    assert_eq!(last, None, "a no-op must not arm the cooldown");
    assert_eq!(sclient.releverage(), 0, "immediate retry allowed");
}

// Rate limit, on-chain: a real re-leverage arms the cooldown, and the rejection
// inside the window is `DeadlineExpired` — the caller *is* authorized, it is
// simply too early, and reusing `NotAuthorized` for that misleads operators
// (audit L-7).
#[test]
fn test_releverage_cooldown_rate_limits_on_chain() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    sclient.partial_unwind(&(sclient.health_factor() + 4_000_000));
    assert!(sclient.releverage() > 0, "first call must do work");
    assert_eq!(
        e.as_contract(&strategy, || storage::get_last_releverage(&e)),
        Some(e.ledger().sequence()),
        "a real re-leverage arms the cooldown"
    );

    match sclient.try_releverage() {
        Err(Ok(StrategyError::DeadlineExpired)) => {}
        other => std::panic!(
            "expected DeadlineExpired inside the window, got {:?}",
            other
        ),
    }

    // One ledger short of expiry: still rejected.
    e.ledger().with_mut(|li| {
        li.sequence_number += crate::constants::RELEVERAGE_COOLDOWN_LEDGERS - 1;
    });
    assert!(
        sclient.try_releverage().is_err(),
        "cooldown must hold until the full window has elapsed"
    );

    // Liquidation protection is never rate-limited by the re-leverage cooldown.
    sclient.rebalance();

    // At expiry the keeper may call again — a no-op here, HF is back at design.
    e.ledger().with_mut(|li| {
        li.sequence_number += 1;
    });
    assert_eq!(sclient.releverage(), 0, "post-cooldown call succeeds");
}

// Adding leverage is the unsafe direction, so unlike `rebalance` it is never
// permissionless.
#[test]
fn test_releverage_rejects_non_keeper() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Genuine slack to re-lever, so the rejection is about identity, not state.
    sclient.partial_unwind(&(sclient.health_factor() + 4_000_000));

    // The host refuses a stranger's signature for want of the keeper's, before
    // the contract can answer with an error of its own.
    let stranger = Address::generate(&e);
    match sclient
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &strategy,
                fn_name: "releverage",
                args: Vec::new(&e),
                sub_invokes: &[],
            },
        }])
        .try_releverage()
    {
        Err(Err(_)) => {}
        other => std::panic!("expected an auth failure for a stranger, got {:?}", other),
    }
    assert!(sclient.releverage() > 0, "the keeper may still re-lever");
}

// T2.3 spec edge case: "locked reserves". When pool utilization exceeds the
// reserve's own `max_util`, Blend refuses a deposit's borrow — but liquidation
// protection must NOT be locked: the keeper's
// rebalance still unwinds and restores HF. Deleveraging (repay == withdraw)
// reduces utilization, so it is safe at any utilization; this test pins that
// property on the real pool with genuinely accrued rates.
#[test]
fn test_rebalance_keeper_works_while_deposits_locked_by_high_utilization() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    let token_admin = StellarAssetClient::new(&e, &token);

    // Whale seeds 100k of liquidity (as collateral, so it can borrow later).
    let whale = Address::generate(&e);
    token_admin.mock_all_auths().mint(&whale, &100_000_0000000);
    let pool_client = pool::Client::new(&e, &pool_addr);
    pool_client.mock_all_auths().submit(
        &whale,
        &whale,
        &whale,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 100_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
    e.cost_estimate().budget().reset_unlimited();

    // Strategy opens a stressed 8-loop position while the pool is still calm.
    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    // Whale borrows near its collateral cap. Utilization cannot exceed the
    // pool's per-account collateral factor by borrowing alone, so interest
    // accrual does the rest: debt compounds faster than supply (backstop take
    // rate), dragging utilization past the reserve's max_util. Accrue in 30-day
    // steps (poking the reserve each step so rates materialise) until the
    // threshold is crossed — adaptive because the 3-slope IR model + reactive
    // ir_mod make a fixed jump unreliable.
    pool_client.mock_all_auths().submit(
        &whale,
        &whale,
        &whale,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 94_000_0000000,
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );
    let poker = Address::generate(&e);
    token_admin.mock_all_auths().mint(&poker, &100_0000000);
    let max_util = pool_client.get_reserve(&token).config.max_util as i128;
    let mut util = 0_i128;
    for _ in 0..48 {
        e.ledger().with_mut(|li| {
            li.timestamp += 2_592_000; // 30 days
            li.sequence_number += 500_000;
        });
        pool_client.mock_all_auths().submit(
            &poker,
            &poker,
            &poker,
            &vec![
                &e,
                pool::Request {
                    address: token.clone(),
                    amount: 1_0000000,
                    request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
                },
            ],
        );
        let (pool_supply, pool_borrow) =
            e.as_contract(&strategy, || get_pool_utilization(&e, &config));
        util = pool_borrow * SCALAR_7 / pool_supply;
        if util > max_util {
            break;
        }
    }

    // Precondition: reserves are "locked" for depositors.
    assert!(
        util > max_util,
        "fixture must exceed the reserve's max_util: util={}",
        util
    );
    let depositor = Address::generate(&e);
    token_admin.mock_all_auths().mint(&depositor, &100_0000000);
    assert!(
        sclient.try_deposit(&100_0000000, &depositor).is_err(),
        "Blend must refuse a deposit's borrow above the reserve's max_util"
    );

    // The keeper's protection path must still work.
    let (_, _, _, orange_hf) = sclient.config();
    let before_hf = sclient.health_factor();
    assert!(
        before_hf < orange_hf,
        "accrued rates must have dragged HF into the orange zone: {}",
        before_hf
    );

    let repaid = sclient.rebalance_keeper();
    assert!(
        repaid > 0,
        "rebalance must unwind even with locked reserves"
    );
    // Event captured first: the test env only keeps the last invocation's events.
    let (ev_before, ev_after, ev_repaid) =
        find_rebalance_event(&e, &strategy, &keeper).expect("rebalance event must be emitted");
    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= orange_hf + crate::constants::REBALANCE_HF_BUFFER,
        "HF must be restored despite locked reserves: {} < {}",
        after_hf,
        orange_hf + crate::constants::REBALANCE_HF_BUFFER
    );
    assert_eq!((ev_before, ev_repaid), (before_hf, repaid));
    assert_eq!(ev_after, after_hf);

    std::println!(
        "locked-reserves rebalance: util={} hf {} -> {} repaid={}",
        util,
        before_hf,
        after_hf,
        repaid
    );
}

// ── Split harvest entrypoints (T2.1) — auth gating + swap account ─────────────

#[test]
fn test_set_swap_account_admin_and_getter() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Unset → error.
    assert!(matches!(
        sclient.try_swap_account(),
        Err(Ok(StrategyError::NotInitialized))
    ));

    let swap_acct = Address::generate(&e);
    sclient.set_swap_account(&swap_acct);
    assert_eq!(sclient.swap_account(), swap_acct);
}

#[test]
fn test_split_harvest_rejects_non_keeper() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let stranger = Address::generate(&e);

    assert!(
        sclient
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &strategy,
                    fn_name: "harvest_claim",
                    args: Vec::new(&e),
                    sub_invokes: &[],
                },
            }])
            .try_harvest_claim()
            .is_err(),
        "harvest_claim: non-keeper rejected"
    );
    assert!(
        sclient
            .mock_auths(&[MockAuth {
                address: &stranger,
                invoke: &MockAuthInvoke {
                    contract: &strategy,
                    fn_name: "harvest_reinvest",
                    args: (1_000_i128, true, 900_i128).into_val(&e),
                    sub_invokes: &[],
                },
            }])
            .try_harvest_reinvest(&1_000, &true, &900)
            .is_err(),
        "harvest_reinvest: non-keeper rejected"
    );
}

// ── Regression test: unwind must pay the correct equity after rates accrue ────
//
// Bug #1 (b/d-token ↔ underlying unit confusion). `reserves::withdraw` returns
// proportional b/d-TOKEN quantities; `blend_pool::submit_unwind` feeds them
// straight into Blend `Request.amount`, which Blend reads as UNDERLYING. Tokens
// equal underlying ONLY when b_rate == d_rate == SCALAR_12 (what every other
// test pins). Once Blend interest accrues, withdrawing X equity pays out the
// WRONG amount of underlying, draining the vault.
//
// This test exercises the REAL production `submit_unwind` against the REAL Blend
// pool after ~1 year of interest, and asserts the withdrawing user receives the
// equity they are actually owed. It FAILS until `submit_unwind` converts token
// amounts to underlying (× rate / SCALAR_12).
#[test]
fn test_unwind_pays_correct_equity_after_rates_accrue() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let user = Address::generate(&e);
    let token_admin = StellarAssetClient::new(&e, &token);
    let token_client = TokenClient::new(&e, &token);

    let deposit = 1_000_0000000_i128;
    token_admin.mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    // Build the leveraged position (3 loops at c=0.90).
    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        TEST_LOOPS,
    );

    // Seed the share count to match (1 share == 1 underlying at entry, rates
    // 1.0); the position itself is read from the pool.
    e.as_contract(&strategy, || storage::set_total_shares(&e, deposit));

    // Advance ~1 year so Blend interest accrues (rates drift above 1.0).
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    // Poke the reserve so the accrual is materialised in the stored rates.
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(
        d_rate > SCALAR_12,
        "precondition: interest must accrue (d_rate={})",
        d_rate
    );

    // Compute a 25%-equity withdrawal using the accrued rates, exactly like
    // production: shares→(b_to_remove, d_to_remove) token quantities.
    let (requested, b_to_remove, d_to_remove) = e.as_contract(&strategy, || {
        let reserves = reserves::current(&e, &config);
        let equity = crate::leverage::compute_equity(&reserves).unwrap();
        let requested = equity / 4;
        let (_burned, b_rm, d_rm) =
            reserves::withdraw(&e, reserves.total_shares, requested, &reserves).unwrap();
        (requested, b_rm, d_rm)
    });

    let user_before = token_client.balance(&user);

    // Run the REAL production unwind against the REAL pool.
    let (b_removed, d_removed, _) = e.as_contract(&strategy, || {
        blend_pool::submit_unwind(&e, b_to_remove, d_to_remove, &user, &config).unwrap()
    });

    let received = token_client.balance(&user) - user_before;

    // The share's debt is repaid in full — the repay rounds up, so the pool burns
    // exactly the d-token share — and at most the share's collateral is burnt.
    assert_eq!(d_removed, d_to_remove, "the whole debt share must be burnt");
    assert!(
        b_removed <= b_to_remove && b_removed >= b_to_remove - 1,
        "collateral burnt must be the share, bar a token of rounding: {} vs {}",
        b_removed,
        b_to_remove
    );

    std::println!(
        "b_rate={} d_rate={} | requested(owed)={} received={} (b_rm={}, d_rm={})",
        b_rate,
        d_rate,
        requested,
        received,
        b_to_remove,
        d_to_remove
    );

    // The user must receive the equity they actually own — no more, no less, bar
    // a couple of stroops of rounding. (Before the unit-conversion fix the unwind
    // paid out ~ (b_to_remove - d_to_remove) of underlying, materially above the
    // owed equity once rates had accrued.)
    let tolerance = 2;
    assert!(
        (received - requested).abs() <= tolerance,
        "withdrawing user should receive ~{} (owed equity) but got {} (diff {})",
        requested,
        received,
        (received - requested).abs()
    );
}

// Full-close sibling of the regression test above: withdrawing the ENTIRE
// position after interest has accrued must (a) pay the user their full equity
// and (b) leave no collateral/debt stranded in the pool. Before the unit-
// confusion fix, the unwind under-withdrew collateral (token counts used as
// underlying), leaving dust locked in the pool.
#[test]
fn test_full_close_returns_all_equity_after_rates_accrue() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let user = Address::generate(&e);
    let token_admin = StellarAssetClient::new(&e, &token);
    let token_client = TokenClient::new(&e, &token);

    let deposit = 1_000_0000000_i128;
    token_admin.mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    let (b_tokens, d_tokens) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        TEST_LOOPS,
    );

    // Advance ~1 year and poke the reserve so interest is materialised.
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest must accrue");

    // Equity owed for a FULL close, in underlying.
    let owed = b_tokens * b_rate / SCALAR_12 - d_tokens * d_rate / SCALAR_12;

    let user_before = token_client.balance(&user);
    e.as_contract(&strategy, || {
        blend_pool::submit_unwind(&e, b_tokens, d_tokens, &user, &config).unwrap();
    });
    let received = token_client.balance(&user) - user_before;

    // Position should be essentially emptied.
    let end = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let end_b = end.collateral.get(config.reserve_id).unwrap_or(0);
    let end_d = end.liabilities.get(config.reserve_id).unwrap_or(0);

    std::println!(
        "owed={} received={} end_b={} end_d={}",
        owed,
        received,
        end_b,
        end_d
    );

    // User gets their full equity, bar a couple of stroops of rounding.
    assert!(
        (received - owed).abs() <= 2,
        "full close should return all equity ~{}, got {}",
        owed,
        received
    );
    // No collateral left stranded beyond a token of rounding.
    assert!(
        end_b <= 1,
        "collateral left stranded in pool: end_b={} (started {})",
        end_b,
        b_tokens
    );
    // All debt cleared.
    assert!(end_d == 0, "debt not fully cleared: end_d={}", end_d);
}

// Coverage for the production `submit_deleverage` path (used by rebalance /
// partial_unwind) at accrued rates — the third site of the unit-confusion fix.
// Deleveraging must reduce both collateral and debt, improve the health factor,
// and preserve equity (the withdraw and the repay are the same underlying).
#[test]
fn test_deleverage_improves_hf_and_preserves_equity_after_rates_accrue() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let token_admin = StellarAssetClient::new(&e, &token);

    let deposit = 1_000_0000000_i128;
    token_admin.mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        TEST_LOOPS,
    );

    // Advance ~1 year and poke the reserve so interest is materialised.
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    let (b_rate, d_rate, _, l_factor) = blend_pool::get_rates_and_factors(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest must accrue");

    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pre_b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre.liabilities.get(config.reserve_id).unwrap_or(0);
    let pre_equity = pre_b * b_rate / SCALAR_12 - pre_d * d_rate / SCALAR_12;
    let pre_hf =
        compute_health_factor(pre_b, pre_d, b_rate, d_rate, config.c_factor, l_factor).unwrap();

    // Repay a fifth of the debt through the REAL production deleverage path.
    let repay = pre_d * d_rate / SCALAR_12 / 5;
    let settled = e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, repay, &config)
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let post_b = post.collateral.get(config.reserve_id).unwrap_or(0);
    let post_d = post.liabilities.get(config.reserve_id).unwrap_or(0);
    assert_eq!(settled, (post_b, post_d), "returns the settled position");
    let (b_removed, d_removed) = (pre_b - post_b, pre_d - post_d);
    let post_equity = post_b * b_rate / SCALAR_12 - post_d * d_rate / SCALAR_12;
    let post_hf =
        compute_health_factor(post_b, post_d, b_rate, d_rate, config.c_factor, l_factor).unwrap();

    std::println!(
        "b_removed={} d_removed={} pre_hf={} post_hf={} pre_eq={} post_eq={}",
        b_removed,
        d_removed,
        pre_hf,
        post_hf,
        pre_equity,
        post_equity
    );

    // Deleveraging reduces both sides of the position.
    assert!(
        b_removed > 0 && d_removed > 0,
        "should remove collateral and debt: b_removed={}, d_removed={}",
        b_removed,
        d_removed
    );
    assert!(
        post_d < pre_d,
        "debt must decrease: pre={}, post={}",
        pre_d,
        post_d
    );

    // Reducing leverage improves the health factor.
    assert!(
        post_hf > pre_hf,
        "HF must improve after deleverage: pre={}, post={}",
        pre_hf,
        post_hf
    );

    // Equity is preserved (the withdraw and the repay are the same underlying),
    // bar a couple of stroops of rounding.
    assert!(
        (post_equity - pre_equity).abs() <= 2,
        "equity must be preserved: pre={}, post={}",
        pre_equity,
        post_equity
    );
}

// A deleverage repays exactly what it is asked to — no layers, nothing rounded
// up to the next one. Asking for a tenth of the debt, at accrued rates where
// every conversion rounds, must burn exactly that tenth's tokens on both sides,
// leave the rest of the position alone, and move nothing through the strategy.
#[test]
fn test_deleverage_repays_exactly_the_requested_amount() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let token_admin = StellarAssetClient::new(&e, &token);

    let deposit = 1_000_0000000_i128;
    token_admin.mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        TEST_LOOPS,
    );
    accrue_interest(&e, &pool_addr, &token, 31_536_000);

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest must accrue");
    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pre_b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre.liabilities.get(config.reserve_id).unwrap_or(0);

    let repay = pre_d * d_rate / SCALAR_12 / 10;
    let (post_b, post_d) = e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, repay, &config)
    });
    let (b_removed, d_removed) = (pre_b - post_b, pre_d - post_d);

    // Blend converts at the live rates: the repay burns floor(repay / d_rate)
    // d-tokens and the withdraw ceil(repay / b_rate) b-tokens — nothing more.
    assert_eq!(d_removed, repay * SCALAR_12 / d_rate, "d-tokens burnt");
    assert_eq!(
        b_removed,
        (repay * SCALAR_12 + b_rate - 1) / b_rate,
        "b-tokens burnt"
    );
    assert!(
        pre_d - d_removed >= pre_d * 9 / 10 - 1,
        "nine tenths of the debt must remain: pre_d={}, removed={}",
        pre_d,
        d_removed
    );
    assert_eq!(
        TokenClient::new(&e, &token).balance(&strategy),
        0,
        "the repay and the withdraw net to zero"
    );
}

// End-to-end protection round-trip (mirrors lib.rs::unwind_to): a position that
// sits in the orange zone (HF < orange_hf) must be restored to >= orange_hf by
// `compute_partial_unwind` → `submit_deleverage`. This proves the two pieces are
// consistent: the repay derived from the closed form lands the real pool on the
// target HF — at it, not a layer past it.
#[test]
fn test_rebalance_round_trip_restores_hf_to_target() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    // High leverage (8 loops) so the freshly-built position starts inside the orange zone.
    let loops = 8;

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let token_admin = StellarAssetClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        loops,
    );

    let (b_rate, d_rate, _, l_factor) = blend_pool::get_rates_and_factors(&e, &config);
    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let d = pre.liabilities.get(config.reserve_id).unwrap_or(0);

    let target = config.orange_hf;
    let before_hf = compute_health_factor(b, d, b_rate, d_rate, config.c_factor, l_factor).unwrap();
    assert!(
        before_hf < target,
        "fixture must start in the orange zone: before_hf={}, target={}",
        before_hf,
        target
    );

    // Production logic: derive the repay needed to restore HF to target.
    let repay =
        compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, l_factor, target).unwrap();
    assert!(repay > 0, "should need a repay");

    // Execute the real deleverage on the real pool.
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, repay, &config);
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b2 = post.collateral.get(config.reserve_id).unwrap_or(0);
    let d2 = post.liabilities.get(config.reserve_id).unwrap_or(0);
    let after_hf =
        compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor, l_factor).unwrap();

    std::println!(
        "before_hf={} after_hf={} target={} repay={}",
        before_hf,
        after_hf,
        target,
        repay
    );

    // HF restored to at least the target …
    assert!(
        after_hf >= target,
        "HF must be restored to >= target: after_hf={}, target={}",
        after_hf,
        target
    );
    // … and no further: the rounding margin is a few dozen stroops.
    assert!(
        after_hf <= target + 10,
        "over-unwound: after_hf={}, target={}",
        after_hf,
        target
    );
}

// T2.2 acceptance — dry-run ↔ on-chain parity within rounding.
//
// The dry-run prediction is the contract's own model: `compute_partial_unwind`'s
// repay, taken off both sides of the position in one submit. This test executes
// the real deleverage on the real Blend pool AFTER a year of interest accrual
// (so b_rate/d_rate ≠ 1 and every underlying↔token conversion rounds) and
// asserts the executed position matches the prediction to within a few stroops.
#[test]
fn test_partial_unwind_dry_run_matches_onchain_within_rounding() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    // High leverage (8 loops) so the position sits inside the orange zone.
    let loops = 8;

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    let token_admin = StellarAssetClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        loops,
    );

    // Advance ~1 year and poke the reserve so interest is materialised and the
    // rates diverge from 1.0 — the rounding-heavy regime.
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    let (b_rate, d_rate, _, l_factor) = blend_pool::get_rates_and_factors(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest must accrue");

    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let d = pre.liabilities.get(config.reserve_id).unwrap_or(0);

    let target = config.orange_hf;
    let before_hf = compute_health_factor(b, d, b_rate, d_rate, config.c_factor, l_factor).unwrap();
    assert!(
        before_hf < target,
        "fixture must start in the orange zone: before_hf={}",
        before_hf
    );

    // ── Dry-run prediction ───────────────────────────────────────────────────
    let repay =
        compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, l_factor, target).unwrap();
    assert!(repay > 0);

    // One repay, one withdraw of the same underlying (blend_pool::submit_deleverage).
    let debt_underlying = d * d_rate / SCALAR_12;
    let supply_underlying = b * b_rate / SCALAR_12;
    let pred_supply = supply_underlying - repay;
    let pred_debt = debt_underlying - repay;
    let pred_hf = pred_supply * config.c_factor / pred_debt;

    // ── Execute the real deleverage on the real pool ──────────────────────────
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, repay, &config);
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b2 = post.collateral.get(config.reserve_id).unwrap_or(0);
    let d2 = post.liabilities.get(config.reserve_id).unwrap_or(0);
    let actual_supply = b2 * b_rate / SCALAR_12;
    let actual_debt = d2 * d_rate / SCALAR_12;
    let after_hf =
        compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor, l_factor).unwrap();

    std::println!(
        "repay={} pred_supply={} actual_supply={} pred_debt={} actual_debt={} pred_hf={} after_hf={}",
        repay,
        pred_supply,
        actual_supply,
        pred_debt,
        actual_debt,
        pred_hf,
        after_hf
    );

    // Each underlying↔token conversion rounds by about a stroop: one burn per
    // side, plus the floor on reading each side back.
    let tol = 5;
    assert!(
        (actual_supply - pred_supply).abs() <= tol,
        "supply diverges beyond rounding: pred={}, actual={}, tol={}",
        pred_supply,
        actual_supply,
        tol
    );
    assert!(
        (actual_debt - pred_debt).abs() <= tol,
        "debt diverges beyond rounding: pred={}, actual={}, tol={}",
        pred_debt,
        actual_debt,
        tol
    );
    // HF parity: a few-stroop position drift moves the 1e7-scale HF by <<1e-6.
    assert!(
        (after_hf - pred_hf).abs() <= 10,
        "HF diverges beyond rounding: pred={}, actual={}",
        pred_hf,
        after_hf
    );
    assert!(after_hf >= target, "restored: {} >= {}", after_hf, target);
}

/// One deleverage on a fresh pool: build `deposit` `loops` deep, accrue
/// `seconds` of interest, then run `compute_partial_unwind` → `submit_deleverage`
/// to `target`. Returns `(before_hf, after_hf)`, or `None` when the position
/// does not start below the target.
fn deleverage_scenario(
    l_factor: u32,
    deposit: i128,
    seconds: u64,
    loops: u32,
    target: i128,
) -> Option<(i128, i128)> {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env_with_l_factor(&e, l_factor);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, (deposit * 10).max(1_000_0000000));

    let strategy = e.register(TestStrategyContract, ());
    StellarAssetClient::new(&e, &token).mint(&strategy, &deposit);
    e.cost_estimate().budget().reset_unlimited();
    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        loops,
    );
    accrue_interest(&e, &pool_addr, &token, seconds);

    let (b_rate, d_rate, _, l) = blend_pool::get_rates_and_factors(&e, &config);
    let (b, d) = e.as_contract(&strategy, || {
        blend_pool::get_strategy_positions(&e, &config)
    });
    let before_hf = compute_health_factor(b, d, b_rate, d_rate, config.c_factor, l).unwrap();
    if before_hf >= target {
        return None;
    }

    let repay = compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, l, target).unwrap();
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, repay, &config)
    });

    let (b2, d2) = e.as_contract(&strategy, || {
        blend_pool::get_strategy_positions(&e, &config)
    });
    let after_hf = compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor, l).unwrap();
    Some((before_hf, after_hf))
}

/// The point of replacing the layers with one exact repay: a deleverage lands ON
/// its target — never short of it, which would leave the vault in the orange
/// zone it was meant to leave, and never a layer past it. Swept over position
/// sizes from dust to a million units and interest accrued over a month and over
/// three years (rates well off 1.0, so every conversion rounds), against the
/// real pool. `test_partial_unwind_lands_on_target_after_blend_rounding` sweeps
/// the same property far wider against a model of the pool's rounding.
fn assert_deleverage_lands_on_target(l_factor: u32) {
    let target = 11_500_000_i128;
    let mut landed = 0;
    for deposit in [1_000_000_i128, 1_000_0000000, 1_000_000_0000000] {
        for seconds in [2_592_000_u64, 94_608_000] {
            if let Some((before_hf, after_hf)) =
                deleverage_scenario(l_factor, deposit, seconds, 8, target)
            {
                assert!(
                    after_hf >= target && after_hf <= target + 100,
                    "l={} deposit={} accrued={}s: {} -> {} must land on {}",
                    l_factor,
                    deposit,
                    seconds,
                    before_hf,
                    after_hf,
                    target
                );
                landed += 1;
            }
        }
    }
    assert_eq!(landed, 6, "every scenario must start below the target");
}

#[test]
fn test_deleverage_lands_on_target() {
    assert_deleverage_lands_on_target(10_000_000);
}

#[test]
fn test_deleverage_lands_on_target_under_liability_markup() {
    assert_deleverage_lands_on_target(9_500_000);
}

// A dust withdraw — a debt share smaller than the loop count — used to split
// into zero-sized layers, and Blend rejects any request that burns no tokens, so
// the whole withdraw reverted. As one [repay, withdraw] it goes through, and the
// debt share is still repaid in full.
#[test]
fn test_unwind_of_a_dust_share_repays_its_debt() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 10_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    StellarAssetClient::new(&e, &token).mint(&strategy, &1_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        1_000_0000000,
        config.c_factor,
        TEST_LOOPS,
    );

    let user = Address::generate(&e);
    let (b_removed, d_removed, _) = e.as_contract(&strategy, || {
        blend_pool::submit_unwind(&e, 30, 2, &user, &config).unwrap()
    });

    assert_eq!(d_removed, 2, "the debt share is repaid in full");
    assert_eq!(b_removed, 30, "the collateral share is withdrawn");
    assert_eq!(
        TokenClient::new(&e, &token).balance(&user),
        28,
        "the user is paid the equity in the share"
    );
}

// The smallest debt share there is: one d-token, at a d_rate above 1.0.
// Floored twice, its repay would round to nothing and Blend would reject it;
// rounded up, it cancels exactly that one d-token.
#[test]
fn test_unwind_of_a_one_token_debt_share_at_accrued_rates() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 10_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    StellarAssetClient::new(&e, &token).mint(&strategy, &1_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        1_000_0000000,
        config.c_factor,
        TEST_LOOPS,
    );
    accrue_interest(&e, &pool_addr, &token, 365 * 24 * 60 * 60);
    let (_, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(
        d_rate > SCALAR_12,
        "precondition: d_rate above 1.0: {}",
        d_rate
    );

    let user = Address::generate(&e);
    let (b_removed, d_removed, _) = e.as_contract(&strategy, || {
        blend_pool::submit_unwind(&e, 30, 1, &user, &config).unwrap()
    });
    assert_eq!(d_removed, 1, "exactly the one d-token is cancelled");
    assert_eq!(b_removed, 30);
    assert!(TokenClient::new(&e, &token).balance(&user) > 0);
}

// A vault with no debt left — what a keeper `partial_unwind` to a high enough
// target produces — must still let holders out. The layered unwind turned even a
// zero debt share into repay/withdraw pairs of zero, which Blend rejects, so
// every withdraw from such a vault reverted until someone re-levered it. A share
// with no debt in it now goes out as a bare withdraw.
#[test]
fn test_withdraw_after_the_debt_is_fully_repaid() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    // The keeper retires the debt. The closed form only approaches a full repay
    // as the target grows (HF 100 still leaves ~0.4% of it), so ask for an HF no
    // partial repay can reach: the repay clamps at the whole debt.
    assert!(sclient.partial_unwind(&100_000_000_000_000_000_000) > 0);
    let (_, _, _, d_tokens, _, _) = sclient.position();
    assert!(
        d_tokens <= 1,
        "debt must be retired, bar a token of rounding dust: {}",
        d_tokens
    );

    let token_client = TokenClient::new(&e, &token);
    let amount = sclient.balance(&user) / 2;
    let before = token_client.balance(&user);
    sclient.withdraw(&amount, &user, &user);
    let received = token_client.balance(&user) - before;
    assert!(
        (received - amount).abs() <= 10,
        "withdraw must pay out: asked {}, got {}",
        amount,
        received
    );
}

// The same, with the debt at exactly zero — what a liquidation or an outside
// repay leaves, where the keeper's unwind above can leave a token of dust —
// and every kind of exit at accrued rates: a 10-stroop one, a partial one and
// full exits. Each sends a bare withdraw.
#[test]
fn test_withdraw_after_an_outside_event_clears_the_debt() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    let config = make_config(&e, &pool_addr, &token, &blnd);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let (alice, bob) = (sclient.get_keeper(), Address::generate(&e));
    for user in [&alice, &bob] {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(user, &1_000_0000000);
        sclient.deposit(&1_000_0000000, user);
    }
    accrue_interest(&e, &pool_addr, &token, 30 * 24 * 60 * 60);

    // Clear the debt in Blend, as the strategy's own position — the strategy's
    // accounting never sees it, just as with a liquidation.
    let positions =
        |e: &Env| e.as_contract(&strategy, || blend_pool::get_strategy_positions(e, &config));
    let (_, pool_d) = positions(&e);
    let (_, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest has accrued");
    let repay = (pool_d * d_rate + SCALAR_12 - 1) / SCALAR_12;
    StellarAssetClient::new(&e, &token).mint(&strategy, &repay);
    e.as_contract(&strategy, || {
        TokenClient::new(&e, &token).approve(&strategy, &pool_addr, &repay, &e.ledger().sequence());
        pool::Client::new(&e, &pool_addr).submit_with_allowance(
            &strategy,
            &strategy,
            &strategy,
            &vec![
                &e,
                pool::Request {
                    address: token.clone(),
                    amount: repay,
                    request_type: REQUEST_TYPE_REPAY,
                },
            ],
        );
    });
    assert_eq!(
        positions(&e).1,
        0,
        "precondition: the vault has exactly zero debt"
    );

    let token_client = TokenClient::new(&e, &token);
    let withdraw = |user: &Address, amount: i128| {
        let before = token_client.balance(user);
        sclient.withdraw(&amount, user, user);
        let received = token_client.balance(user) - before;
        assert!(
            (received - amount).abs() <= 2,
            "asked {}, got {}",
            amount,
            received
        );
    };
    withdraw(&alice, 10); // a 10-stroop exit
    withdraw(&alice, sclient.balance(&alice) / 2);
    withdraw(&alice, sclient.balance(&alice));
    withdraw(&bob, sclient.balance(&bob));

    assert_eq!(positions(&e).1, 0, "no repay was ever sent");
    assert!(sclient.balance(&alice) <= 2 && sclient.balance(&bob) <= 2);
}

// Liquidation protection near 100% utilization. Blend checks utilization is
// below 100% as each withdraw request runs, so the layered unwind — withdraw,
// then repay, a layer at a time — needed a whole layer of free liquidity and
// reverted with less. Repaying first means the one withdraw runs against the
// final state, which is never more utilized than where the pool started.
#[test]
fn test_rebalance_works_near_full_utilization() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, collateral, blnd) = setup_blend_env_with_collateral_reserve(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    let pool_client = pool::Client::new(&e, &pool_addr);

    // A lender supplies the leverage asset (request type 0: plain supply).
    let lender = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&lender, &100_000_0000000);
    pool_client.submit(
        &lender,
        &lender,
        &lender,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 100_000_0000000,
                request_type: 0,
            },
        ],
    );

    // A stressed position (HF ≈ 1.076) opened through the real deposit.
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token).mint(&user, &10_000_0000000);
    set_target_hf(&e, &strategy, STRESSED_HF);
    sclient.deposit(&10_000_0000000, &user);
    set_target_hf(&e, &strategy, TARGET_HF);

    // A borrower posts the second reserve and borrows the leverage asset up to
    // ~98.9% utilization (the reserve's max is 99%); the lender then withdraws
    // until it is ~99.8% (request type 1: withdrawals are held to 100%, not to
    // the max).
    let borrower = Address::generate(&e);
    StellarAssetClient::new(&e, &collateral).mint(&borrower, &1_000_000_0000000);
    pool_client.submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            &e,
            pool::Request {
                address: collateral.clone(),
                amount: 1_000_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
    let (supply, borrow) = get_pool_utilization(&e, &config);
    pool_client.submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: supply * 989 / 1000 - borrow,
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );
    let (supply, borrow) = get_pool_utilization(&e, &config);
    pool_client.submit(
        &lender,
        &lender,
        &lender,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: supply - borrow * 1000 / 998,
                request_type: 1,
            },
        ],
    );

    // Preconditions: deep in the orange zone, and less free liquidity than one
    // of the old layers (debt × (1 − c_factor)) — the first withdraw of the
    // layered unwind would have reverted here.
    let (supply, borrow) = get_pool_utilization(&e, &config);
    let (_, _, _, orange_hf) = sclient.config();
    let before_hf = sclient.health_factor();
    let (_, _, _, d_tokens, _, d_rate) = sclient.position();
    let layer = d_tokens * d_rate / SCALAR_12 * (SCALAR_7 - config.c_factor) / SCALAR_7;
    assert!(
        before_hf < orange_hf,
        "fixture must start in the orange zone"
    );
    assert!(
        borrow * SCALAR_7 / supply >= 9_970_000,
        "fixture must sit near 100% utilization: {}",
        borrow * SCALAR_7 / supply
    );
    assert!(
        supply - borrow < layer,
        "fixture must have less free liquidity than one layer: free={}, layer={}",
        supply - borrow,
        layer
    );

    sclient.rebalance();

    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= orange_hf + crate::constants::REBALANCE_HF_BUFFER,
        "HF must be restored at ~100% utilization: {} -> {}",
        before_hf,
        after_hf
    );
}

// One [supply, borrow] submit lands a deposit on `target_hf`, on a real pool
// whose rates have drifted off 1.0 after a year of interest — and only the
// deposit leaves the strategy, which ends up holding nothing.
#[test]
fn test_lever_in_lands_on_target_hf_after_rates_drift() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    // Background borrowing, so the rates drift off 1.0.
    let whale = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&whale, &1_000_000_0000000);
    let pool_client = pool::Client::new(&e, &pool_addr);
    pool_client.submit(
        &whale,
        &whale,
        &whale,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_000_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
    pool_client.submit(
        &whale,
        &whale,
        &whale,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 500_000_0000000,
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );
    accrue_interest(&e, &pool_addr, &token, 31_536_000);

    let strategy = e.register(TestStrategyContract, ());
    let deposit = 1_234_5678901_i128;
    StellarAssetClient::new(&e, &token).mint(&strategy, &deposit);
    let (b, d) = e.as_contract(&strategy, || {
        blend_pool::submit_lever_in(&e, deposit, &config, false).unwrap()
    });

    let (b_rate, d_rate, _, l_factor) = blend_pool::get_rates_and_factors(&e, &config);
    assert!(
        b_rate > SCALAR_12 && d_rate > b_rate,
        "rates must have drifted"
    );
    let hf = compute_health_factor(b, d, b_rate, d_rate, config.c_factor, l_factor).unwrap();
    std::println!(
        "lever-in at rates ({}, {}): hf {} vs target {}",
        b_rate,
        d_rate,
        hf,
        config.target_hf
    );
    assert!(
        (hf - config.target_hf).abs() <= 2,
        "the deposit lands on the target: {} vs {}",
        hf,
        config.target_hf
    );
    assert_eq!(
        TokenClient::new(&e, &token).balance(&strategy),
        0,
        "only the deposit leaves the strategy, and all of it"
    );
}

/// The `(amount, live_until_ledger)` of each allowance `owner` granted `spender`
/// on `token` in the last invocation, read from the token's `approve` events.
fn approvals(
    e: &Env,
    token: &Address,
    owner: &Address,
    spender: &Address,
) -> std::vec::Vec<(i128, u32)> {
    use soroban_sdk::{xdr, TryFromVal};
    let mut found = std::vec::Vec::new();
    for ev in e.events().all().filter_by_contract(token).events() {
        let xdr::ContractEventBody::V0(v0) = &ev.body;
        let address = |i: usize| Address::try_from_val(e, &v0.topics[i]).ok();
        if v0.topics.first().map(|t| Symbol::try_from_val(e, t))
            != Some(Ok(Symbol::new(e, "approve")))
            || address(1).as_ref() != Some(owner)
            || address(2).as_ref() != Some(spender)
        {
            continue;
        }
        let data = Vec::<Val>::try_from_val(e, &Val::try_from_val(e, &v0.data).unwrap()).unwrap();
        found.push((
            i128::try_from_val(e, &data.get(0).unwrap()).unwrap(),
            u32::try_from_val(e, &data.get(1).unwrap()).unwrap(),
        ));
    }
    found
}

// Only a lever-in grants the pool an allowance: a deposit or a harvest
// reinvest approves exactly what the pool nets out of the strategy, live for
// this ledger only, and the submit uses all of it. A deleverage, a re-leverage
// and a withdraw net to zero or in the strategy's favour, and approve nothing.
#[test]
fn test_only_the_lever_in_approves_the_pool_and_the_submit_uses_it_all() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.ledger().with_mut(|li| li.sequence_number += 1_000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let token_client = TokenClient::new(&e, &token);
    let mint = |to: &Address, amount: i128| {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(to, &amount)
    };
    // Each read is of the call just made: the events are the last invocation's.
    let pool_approvals = || approvals(&e, &token, &strategy, &pool_addr);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let keeper = sclient.get_keeper();
    let deposit = 1_000_0000000_i128;
    mint(&keeper, deposit);
    sclient.deposit(&deposit, &keeper);
    assert_eq!(
        pool_approvals(),
        std::vec![(deposit, e.ledger().sequence())],
        "the deposit, until this ledger"
    );
    assert_eq!(token_client.allowance(&strategy, &pool_addr), 0, "all used");

    let proceeds = 50_0000000_i128;
    mint(&strategy, proceeds);
    sclient.harvest_reinvest(&proceeds, &false, &0);
    assert_eq!(
        pool_approvals(),
        std::vec![(proceeds, e.ledger().sequence())],
        "the proceeds, until this ledger"
    );
    assert_eq!(token_client.allowance(&strategy, &pool_addr), 0, "all used");

    assert!(sclient.partial_unwind(&(TARGET_HF + 1_000_000)) > 0);
    assert_eq!(pool_approvals(), std::vec![], "deleverage");
    assert!(sclient.releverage() > 0);
    assert_eq!(pool_approvals(), std::vec![], "re-leverage");
    sclient.withdraw(&(sclient.balance(&keeper) / 2), &keeper, &keeper);
    assert_eq!(pool_approvals(), std::vec![], "withdraw");
    assert_eq!(token_client.allowance(&strategy, &pool_addr), 0);
}

// The after-submit gate holds a deposit to `min_hf` on the position Blend
// actually settled. A target of 1.014 (far below what the constructor accepts,
// written straight to storage) builds a position Blend accepts (its floor is
// 1.0, measured with the pool's c = 0.95), but the vault's floor is 1.05, so the
// deposit must revert as a whole — the user's transfer included.
#[test]
fn test_deposit_reverts_when_the_settled_hf_is_below_min_hf() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    set_target_hf(&e, &strategy, 10_140_000);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);

    match sclient.try_deposit(&1_000_0000000, &user) {
        Err(Ok(StrategyError::ExternalError)) => {}
        other => std::panic!("expected ExternalError (#422), got {:?}", other),
    }
    assert_eq!(
        TokenClient::new(&e, &token).balance(&user),
        1_000_0000000,
        "the user's transfer reverts with the rest"
    );
    let (_, _, b_tokens, d_tokens, _, _) = sclient.position();
    assert_eq!((b_tokens, d_tokens), (0, 0), "no position is left behind");
}

// The first deposit gives up `FIRST_DEPOSIT_LOCKUP` shares, so a user is never
// the one to make it: only the keeper or the admin opens a vault. Once it is
// open, anyone deposits and keeps every share their deposit buys.
#[test]
fn test_only_the_keeper_or_the_admin_opens_the_vault() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    let lockup = crate::constants::FIRST_DEPOSIT_LOCKUP;
    let mint = |to: &Address| {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(to, &1_000_0000000)
    };

    // A user's first deposit is refused, and nothing moves.
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let user = Address::generate(&e);
    mint(&user);
    match sclient.try_deposit(&1_000_0000000, &user) {
        Err(Ok(StrategyError::NotAuthorized)) => {}
        other => std::panic!("expected NotAuthorized, got {:?}", other),
    }
    assert_eq!(TokenClient::new(&e, &token).balance(&user), 1_000_0000000);
    assert_eq!(share.total_supply(), 0, "the vault is still unopened");

    // The admin opens it and pays the lockup.
    let admin = sclient.admin();
    mint(&admin);
    sclient.deposit(&1_000_0000000, &admin);
    assert_eq!(share.balance(&strategy), lockup);

    // Now the user's deposit goes through and gives up nothing to the lockup:
    // the same amount buys more shares than the admin's did.
    sclient.deposit(&1_000_0000000, &user);
    assert_eq!(share.balance(&strategy), lockup, "the lockup is taken once");
    assert!(share.balance(&user) > share.balance(&admin));

    // The keeper can open a vault too.
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let keeper = sclient.get_keeper();
    mint(&keeper);
    sclient.deposit(&1_000_0000000, &keeper);
    assert_eq!(share.balance(&strategy), lockup);
}

// `releverage` adds borrow demand exactly as a deposit does, so Blend holds it to
// the reserve's own `max_util`. A pool just inside the cap, which the
// re-leverage's own borrow would tip over it, must revert the whole call — and a
// reverted call must not arm the cooldown.
#[test]
fn test_releverage_reverts_when_it_would_push_utilization_past_the_cap() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, collateral, blnd) = setup_blend_env_with_collateral_reserve(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 20_000_0000000);

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Slack to re-lever: the keeper deleverages well clear of the band.
    sclient.partial_unwind(&(sclient.health_factor() + 4_000_000));

    // A borrower takes the pool to just under the reserve's max_util (99% here)
    // — inside the cap now, past it once the re-leverage borrows.
    let max_util = pool::Client::new(&e, &pool_addr)
        .get_reserve(&token)
        .config
        .max_util as i128;
    let borrower = Address::generate(&e);
    StellarAssetClient::new(&e, &collateral).mint(&borrower, &1_000_000_0000000);
    let pool_client = pool::Client::new(&e, &pool_addr);
    pool_client.submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            &e,
            pool::Request {
                address: collateral.clone(),
                amount: 1_000_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
    let (supply, borrow) = get_pool_utilization(&e, &config);
    pool_client.submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: supply * (max_util - 1_000) / SCALAR_7 - borrow,
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );
    let (supply, borrow) = get_pool_utilization(&e, &config);
    assert!(
        borrow * SCALAR_7 / supply <= max_util,
        "fixture must start inside the cap"
    );

    let hf = sclient.health_factor();
    // Blend's InvalidUtilRate.
    match sclient.try_releverage() {
        Err(Err(soroban_sdk::InvokeError::Contract(1207))) => {}
        other => std::panic!("expected Blend's InvalidUtilRate (#1207), got {:?}", other),
    }
    assert_eq!(sclient.health_factor(), hf, "position untouched");
    assert_eq!(
        e.as_contract(&strategy, || storage::get_last_releverage(&e)),
        None,
        "a reverted re-leverage must not arm the cooldown"
    );
}

// A rebalance lands REBALANCE_HF_BUFFER above its trigger, not on it. Landed
// exactly on orange_hf, the first interest to accrue would put the position
// straight back under the trigger and the keeper would rebalance every cooldown.
// With the buffer, a month of interest later HF has drifted but is still clear
// of the zone, and neither rebalance path has anything to do.
#[test]
fn test_rebalance_lands_clear_of_its_own_trigger() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let (_, _, _, orange_hf) = sclient.config();

    assert!(sclient.rebalance_keeper() > 0, "must rebalance");
    let landed = sclient.health_factor();
    assert!(landed >= orange_hf + crate::constants::REBALANCE_HF_BUFFER);

    accrue_interest(&e, &pool_addr, &token, 2_592_000);
    let drifted = sclient.health_factor();
    assert!(
        drifted < landed,
        "interest must erode HF: {} -> {}",
        landed,
        drifted
    );
    assert!(
        drifted >= orange_hf,
        "a month later the position must still be clear of the zone: {} < {}",
        drifted,
        orange_hf
    );

    sclient.rebalance();
    assert_eq!(sclient.health_factor(), drifted, "nothing to rebalance");
    assert_eq!(sclient.rebalance_keeper(), 0, "nothing for the keeper");
}

/// A fresh lender supplies `amount` of `token` (request type 0: a plain supply,
/// not collateral — it only lends).
fn lend(e: &Env, pool_addr: &Address, token: &Address, amount: i128) {
    let lender = Address::generate(e);
    StellarAssetClient::new(e, token).mint(&lender, &amount);
    pool::Client::new(e, pool_addr).submit(
        &lender,
        &lender,
        &lender,
        &vec![
            e,
            pool::Request {
                address: token.clone(),
                amount,
                request_type: 0,
            },
        ],
    );
}

/// A fresh borrower posts ample `collateral` (the second reserve) and borrows
/// the leverage asset until only `free` of it is left unborrowed in the pool.
fn borrow_until_free(e: &Env, config: &storage::Config, collateral: &Address, free: i128) {
    let borrower = Address::generate(e);
    StellarAssetClient::new(e, collateral).mint(&borrower, &1_000_000_0000000);
    let pool_client = pool::Client::new(e, &config.pool);
    pool_client.submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            e,
            pool::Request {
                address: collateral.clone(),
                amount: 1_000_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );
    let (supply, borrow) = get_pool_utilization(e, config);
    pool_client.submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            e,
            pool::Request {
                address: config.asset.clone(),
                amount: supply - borrow - free,
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );
}

// Request order is what lets a submit be large against the pool's free
// liquidity: Blend checks utilization below 100% as each borrow runs. A deposit
// whose borrow alone exceeds the free liquidity goes through because its supply
// lands first — as it did, step by step, in the loop. Borrowing first would
// revert here (InvalidUtilRate).
#[test]
fn test_large_deposit_into_a_pool_with_little_free_liquidity() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, collateral, blnd) = setup_blend_env_with_collateral_reserve(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    lend(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // 94.5% utilized, 5,500 left to borrow …
    borrow_until_free(&e, &config, &collateral, 5_500_0000000);
    let (supply, borrow) = get_pool_utilization(&e, &config);

    // … against a deposit whose borrow is ~24,390.
    let deposit = 10_000_0000000_i128;
    let (_, l_factor) = blend_pool::get_pool_risk_factors(&e, &config);
    let (_, deposit_borrow) =
        crate::leverage::compute_lever_in(deposit, config.c_factor, l_factor, config.target_hf)
            .unwrap();
    assert!(
        deposit_borrow > supply - borrow,
        "fixture: the deposit's borrow must exceed the free liquidity: {} vs {}",
        deposit_borrow,
        supply - borrow
    );

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token).mint(&user, &deposit);
    sclient.deposit(&deposit, &user);

    let (supply2, borrow2) = get_pool_utilization(&e, &config);
    assert!(
        borrow2 * supply < borrow * supply2,
        "a levered deposit lowers utilization"
    );
    let (_, _, min_hf, _) = sclient.config();
    assert!(sclient.health_factor() >= min_hf);
}

// The withdraw side of the same property: repaying first means the one withdraw
// needs only the user's equity in free liquidity, not their gross collateral.
// The pool has 2,000 free — more than the ~1,000 of equity going out, less than
// the ~3,439 of collateral behind it — so withdrawing first would revert here
// (InvalidUtilRate).
#[test]
fn test_withdraw_needs_only_its_equity_in_free_liquidity() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, collateral, blnd) = setup_blend_env_with_collateral_reserve(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    lend(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    borrow_until_free(&e, &config, &collateral, 2_000_0000000);

    let balance = sclient.balance(&user);
    let (_, _, b_tokens, _, b_rate, _) = sclient.position();
    let collateral_value = b_tokens * b_rate / SCALAR_12;
    let (supply, borrow) = get_pool_utilization(&e, &config);
    let free = supply - borrow;
    assert!(
        balance < free && free < collateral_value,
        "fixture: equity < free liquidity < collateral: {} < {} < {}",
        balance,
        free,
        collateral_value
    );

    let token_client = TokenClient::new(&e, &token);
    let before = token_client.balance(&user);
    sclient.withdraw(&balance, &user, &user);
    let received = token_client.balance(&user) - before;
    assert!(
        (received - balance).abs() <= 10,
        "withdraw must pay out the whole balance: asked {}, got {}",
        balance,
        received
    );
}

// And for re-leverage: supplying first lets it borrow more than the pool has
// free, so long as the settled utilization stays within the reserve's
// `max_util`. The old
// borrow-first order reverted here (InvalidUtilRate) before the supply landed.
#[test]
fn test_releverage_larger_than_the_free_liquidity() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, collateral, blnd) = setup_blend_env_with_collateral_reserve(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    lend(&e, &pool_addr, &token, 8_000_0000000);

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    sclient.partial_unwind(&(sclient.health_factor() + 4_000_000));

    // What `releverage` will borrow, from the same inputs it reads.
    let (c_factor, target, _, _) = sclient.config();
    let (_, _, l_factor) = sclient.risk_factors();
    let (_, _, b, d, b_rate, d_rate) = sclient.position();
    let x = crate::leverage::compute_releverage(b, d, b_rate, d_rate, c_factor, l_factor, target)
        .unwrap();

    // Leave less free than that, but enough for the settled utilization to stay
    // within the reserve's max_util: free ∈ [(1 − max_util) of (supply + x), x).
    let max_util = pool::Client::new(&e, &pool_addr)
        .get_reserve(&token)
        .config
        .max_util as i128;
    let (supply, _) = get_pool_utilization(&e, &config);
    let lo = (supply + x) * (SCALAR_7 - max_util) / SCALAR_7 + 1;
    assert!(
        lo < x,
        "fixture: the window must be non-empty: {} vs {}",
        lo,
        x
    );
    let free = (lo + x) / 2;
    borrow_until_free(&e, &config, &collateral, free);

    let borrowed = sclient.releverage();
    assert_eq!(borrowed, x, "re-levers by the amount computed above");
    assert!(
        borrowed > free,
        "borrowed {} against {} free",
        borrowed,
        free
    );
    let (supply2, borrow2) = get_pool_utilization(&e, &config);
    assert!(borrow2 * SCALAR_7 / supply2 <= max_util);
}

// A share that rounds to no equity is refused rather than unwound: `withdraw`
// burns the shares before the unwind, so paying out nothing would take them for
// nothing.
#[test]
fn test_unwind_of_a_share_with_no_equity_is_refused() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 10_000_0000000);

    let strategy = e.register(TestStrategyContract, ());
    StellarAssetClient::new(&e, &token).mint(&strategy, &1_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        1_000_0000000,
        config.c_factor,
        TEST_LOOPS,
    );
    accrue_interest(&e, &pool_addr, &token, 31_536_000);

    let user = Address::generate(&e);
    // Nothing at all, and one token of each — after accrual the debt token is
    // worth more than the collateral token, so the share carries no equity.
    for (b, d) in [(0_i128, 0_i128), (1, 1)] {
        let result = e.as_contract(&strategy, || {
            blend_pool::submit_unwind(&e, b, d, &user, &config)
        });
        assert!(
            matches!(result, Err(StrategyError::AmountBelowMinDust)),
            "share ({}, {}) must be refused",
            b,
            d
        );
    }
}

// The keeper may not ask for less than the rebalance target: a keeper landing on
// the trigger would re-arm it on the next accrual, the churn the buffer exists
// to prevent. Such a target is refused rather than quietly raised, so the keeper
// gets the target it asked for or an error, never a different one.
#[test]
fn test_partial_unwind_refuses_a_target_below_the_rebalance_target() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let (_, _, _, orange_hf) = sclient.config();
    let floor = orange_hf + crate::constants::REBALANCE_HF_BUFFER;
    let before_hf = sclient.health_factor();

    for target in [orange_hf, floor - 1] {
        assert_eq!(
            sclient.try_partial_unwind(&target),
            Err(Ok(StrategyError::InvalidArgument)),
            "target {} is below the rebalance target {}",
            target,
            floor
        );
    }
    assert_eq!(sclient.health_factor(), before_hf, "position untouched");

    // The rebalance target itself is the lowest the keeper may ask for.
    assert!(sclient.partial_unwind(&floor) > 0);
    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= floor && after_hf <= floor + 10,
        "keeper asking for the rebalance target must land on it: {} vs {}",
        after_hf,
        floor
    );
}

// The Soroswap route of `harvest_reinvest` runs under the same floor as the
// trait `harvest`. With neither the keeper's `amount_out_min` nor the admin's
// rate there is no floor, and the swap is refused rather than run unprotected.
#[test]
fn test_soroswap_reinvest_without_any_floor_is_refused() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (_strategy, sclient, _router, _keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);

    match sclient.try_harvest_reinvest(&1, &true, &0) {
        Err(Ok(StrategyError::OnlyPositiveAmountAllowed)) => {}
        other => std::panic!("expected OnlyPositiveAmountAllowed, got {:?}", other),
    }
}

// With no claim pending (a Broker partial fill already settled it, or a vault
// without a swap account), the Soroswap route still gets the admin's floor
// whenever that is the stricter one — a keeper passing 1 cannot sell for 1.
#[test]
fn test_soroswap_reinvest_without_a_claim_is_held_to_the_admin_floor() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (_strategy, sclient, router, _keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE); // 0.02 per BLND
    assert!(sclient.try_pending_harvest().is_err(), "no claim in flight");

    sclient.harvest_reinvest(&1, &true, &1);

    // 1000 BLND × 0.02 = 20 underlying, not the keeper's 1.
    assert_eq!(router.last_amount_out_min(), 20_0000000);
}

// The on-chain route can go through an intermediate token: BLND → via →
// underlying, for an asset with no BLND pair of its own.
#[test]
fn test_soroswap_reinvest_swaps_through_swap_via() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, router, _keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);
    let via = Address::generate(&e);

    sclient.set_swap_via(&Some(via.clone()));
    assert_eq!(sclient.swap_via(), Some(via.clone()));
    let realized = sclient.harvest_reinvest(&1, &true, &1);

    assert_eq!(
        router.last_path(),
        vec![&e, blnd.clone(), via, token.clone()]
    );
    assert_eq!(
        realized, 50_0000000,
        "the last hop's output is what is levered in"
    );
    assert_eq!(TokenClient::new(&e, &blnd).balance(&strategy), 0);

    sclient.set_swap_via(&None);
    assert_eq!(sclient.swap_via(), None);
}

// ── Audit M-4: the Broker harvest path must settle against an on-chain floor ──
//
// `harvest_claim` approves the swap account for the whole claimed BLND balance
// and `harvest_reinvest(via_soroswap = false)` re-leverages `amount_in` of
// underlying. Before this fix nothing joined the two: `amount_in` only had to
// be *held* by the contract, so BLND could leave and any amount — including
// nothing — could come back, and the approval outlived the transaction by a
// day. The tests below pin the three parts of the fix: the floor is recorded at
// claim, it is enforced on measured balances at settle, and the allowance is
// scoped to the round trip.

/// Floor rate used throughout: 0.02 underlying per BLND, 1e7-scaled.
const TEST_MIN_HARVEST_RATE: i128 = 200_000;

/// A strategy with a real leveraged position, a swap account and a floor rate,
/// holding `blnd_amount` of claimable-equivalent BLND. Returns
/// `(strategy, sclient, keeper, swap_account)`.
///
/// BLND is minted straight to the strategy rather than accrued as emissions:
/// `harvest_claim` floors and approves whatever balance it finds after
/// `pool.claim`, so a minted balance exercises the identical path without
/// making the test depend on the fixture's emission schedule.
fn setup_broker_harvest<'a>(
    e: &Env,
    pool_addr: &Address,
    token: &Address,
    blnd: &Address,
    deployer: &Address,
    blnd_amount: i128,
) -> (
    Address,
    crate::BlendLeverageStrategyClient<'a>,
    Address,
    Address,
) {
    let strategy = register_real_strategy(e, pool_addr, token, blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    let swap_account = Address::generate(e);
    sclient.set_swap_account(&swap_account);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);

    StellarAssetClient::new(e, blnd)
        .mock_all_auths()
        .mint(&strategy, &blnd_amount);
    let _ = deployer;

    let keeper = sclient.get_keeper();
    (strategy, sclient, keeper, swap_account)
}

#[test]
fn test_min_harvest_rate_set_and_getter() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Unset → error, which is what closes the Broker path by default.
    assert!(sclient.try_min_harvest_rate().is_err());

    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);
    assert_eq!(sclient.min_harvest_rate(), TEST_MIN_HARVEST_RATE);

    // A non-positive floor is not a floor.
    assert!(sclient.try_set_min_harvest_rate(&0).is_err());
    assert!(sclient.try_set_min_harvest_rate(&-1).is_err());
}

#[test]
fn test_harvest_claim_without_floor_rate_grants_no_allowance() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let swap_account = Address::generate(&e);
    sclient.set_swap_account(&swap_account);

    StellarAssetClient::new(&e, &blnd)
        .mock_all_auths()
        .mint(&strategy, &1_000_0000000);

    // Swap account set, floor rate not: the claim succeeds and the BLND stays
    // put for the Soroswap route, but nothing may pull it.
    let claimed = sclient.harvest_claim();
    assert_eq!(claimed, 1_000_0000000);
    assert_eq!(
        TokenClient::new(&e, &blnd).allowance(&strategy, &swap_account),
        0,
        "no floor configured ⇒ no allowance"
    );
    assert!(
        sclient.try_pending_harvest().is_err(),
        "no allowance ⇒ nothing to settle"
    );
}

#[test]
fn test_harvest_claim_records_floor_and_scopes_the_allowance() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    let seq_before = e.ledger().sequence();
    let claimed = sclient.harvest_claim();
    assert_eq!(claimed, 1_000_0000000);

    let (blnd_claimed, underlying_before, floor, expiration) = sclient.pending_harvest();
    assert_eq!(blnd_claimed, claimed);
    assert_eq!(
        underlying_before,
        TokenClient::new(&e, &token).balance(&strategy),
        "baseline is the idle underlying at claim time"
    );
    // 1000 BLND × 0.02 = 20 underlying.
    assert_eq!(floor, 20_0000000);
    assert_eq!(
        expiration,
        seq_before + crate::constants::HARVEST_APPROVAL_LEDGERS
    );

    // The allowance covers the claim and dies with it — minutes, not a day.
    assert_eq!(
        TokenClient::new(&e, &blnd).allowance(&strategy, &swap_account),
        claimed
    );
    const {
        assert!(
            crate::constants::HARVEST_APPROVAL_LEDGERS <= 300,
            "approval window must stay inside the round trip it exists for"
        )
    };
}

// Rotating the swap account while a claim is in flight takes the pull away
// from the outgoing account, which would otherwise keep it until the claim
// expires. The BLND stays in the vault, and once the claim has expired the next
// one approves the new account.
#[test]
fn test_rotating_the_swap_account_revokes_the_old_allowance() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, old_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);
    let blnd_client = TokenClient::new(&e, &blnd);

    let claimed = sclient.harvest_claim();
    assert_eq!(blnd_client.allowance(&strategy, &old_account), claimed);

    let new_account = Address::generate(&e);
    sclient.set_swap_account(&new_account);

    assert_eq!(
        blnd_client.allowance(&strategy, &old_account),
        0,
        "the outgoing account's pull is revoked"
    );
    assert!(
        blnd_client
            .try_transfer_from(&old_account, &strategy, &old_account, &claimed)
            .is_err(),
        "the outgoing account cannot take the BLND"
    );
    assert_eq!(blnd_client.balance(&strategy), claimed);
    assert_eq!(blnd_client.allowance(&strategy, &new_account), 0);

    e.ledger()
        .with_mut(|li| li.sequence_number += crate::constants::HARVEST_APPROVAL_LEDGERS);
    assert_eq!(sclient.harvest_claim(), claimed);
    assert_eq!(
        blnd_client.allowance(&strategy, &new_account),
        claimed,
        "the next claim approves the new account"
    );
}

#[test]
fn test_harvest_claim_rejected_while_a_claim_is_still_pullable() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (_strategy, sclient, _keeper, _swap) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim();

    // Overlapping approvals would put more BLND at risk than the newer floor
    // covers, so a second claim inside the window is refused.
    assert_eq!(
        sclient.try_harvest_claim(),
        Err(Ok(StrategyError::DeadlineExpired)),
        "claiming over a live allowance must be refused"
    );

    // Past the window nothing can be pulled against the old approval, so a
    // fresh claim proceeds.
    e.ledger()
        .set_sequence_number(e.ledger().sequence() + crate::constants::HARVEST_APPROVAL_LEDGERS);
    sclient.harvest_claim();
}

#[test]
fn test_broker_settlement_below_floor_reverts() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim();

    // The swap account pulls the whole approval — 20 underlying is now owed.
    TokenClient::new(&e, &blnd).transfer_from(
        &swap_account,
        &strategy,
        &swap_account,
        &1_000_0000000,
    );

    // …and returns a fraction of it. Before M-4 this settled: the contract held
    // `amount_in`, which was the entire test the Broker leg applied.
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &1_0000000);
    assert_eq!(
        sclient.try_harvest_reinvest(&1_0000000, &false, &0),
        Err(Ok(StrategyError::UnderlyingAmountBelowMin)),
        "1 underlying back for 1000 BLND must not settle"
    );

    // Returning nothing at all is the same answer.
    assert_eq!(
        sclient.try_harvest_reinvest(&1_0000000, &false, &0),
        Err(Ok(StrategyError::UnderlyingAmountBelowMin))
    );

    // The revert took the whole transaction with it, so the obligation is still
    // recorded and still has to be met.
    let (_, _, floor, _) = sclient.pending_harvest();
    assert_eq!(floor, 20_0000000);
}

#[test]
fn test_broker_settlement_at_floor_succeeds_and_kills_the_allowance() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim();
    TokenClient::new(&e, &blnd).transfer_from(
        &swap_account,
        &strategy,
        &swap_account,
        &1_000_0000000,
    );

    // An honest settlement: 25 underlying for 1000 BLND, comfortably over the
    // 20-unit floor.
    let proceeds = 25_0000000_i128;
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &proceeds);

    let before = sclient.balance(&strategy);
    let realized = sclient.harvest_reinvest(&proceeds, &false, &0);
    assert_eq!(realized, proceeds);
    assert!(
        sclient.balance(&strategy) >= before,
        "settled proceeds are levered into the position"
    );

    // Settling consumes the claim and the pull that went with it.
    assert!(
        sclient.try_pending_harvest().is_err(),
        "claim consumed by settlement"
    );
    assert_eq!(
        TokenClient::new(&e, &blnd).allowance(&strategy, &swap_account),
        0,
        "allowance must not outlive the harvest it was granted for"
    );
}

#[test]
fn test_broker_floor_prorates_to_the_blnd_actually_pulled() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim();

    // The Broker takes a quarter of the approval: 250 BLND ⇒ 5 underlying owed,
    // not the full 20.
    TokenClient::new(&e, &blnd).transfer_from(
        &swap_account,
        &strategy,
        &swap_account,
        &250_0000000,
    );

    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &4_0000000);
    assert_eq!(
        sclient.try_harvest_reinvest(&4_0000000, &false, &0),
        Err(Ok(StrategyError::UnderlyingAmountBelowMin)),
        "4 back for 250 BLND is under the prorated floor"
    );

    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &2_0000000);
    assert_eq!(
        sclient.harvest_reinvest(&6_0000000, &false, &0),
        6_0000000,
        "6 back for 250 BLND clears the prorated floor"
    );
}

#[test]
fn test_broker_settlement_ignores_pre_existing_idle_underlying() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    // The vault is already sitting on 50 underlying *before* the claim — a
    // donation, a rounding remainder, anything. The claim-time baseline is what
    // stops it being counted as harvest proceeds: `amount_in` alone would be
    // fully covered by it, and the pre-M-4 "is it held?" check would pass.
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &50_0000000);

    sclient.harvest_claim();
    TokenClient::new(&e, &blnd).transfer_from(
        &swap_account,
        &strategy,
        &swap_account,
        &1_000_0000000,
    );

    assert_eq!(
        sclient.try_harvest_reinvest(&50_0000000, &false, &0),
        Err(Ok(StrategyError::UnderlyingAmountBelowMin)),
        "idle underlying held before the claim cannot settle it"
    );
}

#[test]
fn test_trait_harvest_refused_while_a_claim_awaits_settlement() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (_strategy, sclient, keeper, _swap) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim();

    // The trait path would swap the pending claim's BLND and lever the proceeds
    // in one call, leaving nothing for `harvest_reinvest` to measure.
    assert_eq!(
        sclient.try_harvest(&keeper, &None),
        Err(Ok(StrategyError::DeadlineExpired)),
        "the old harvest path must not run through a pending settlement"
    );
}

#[test]
fn test_unsettled_claim_is_reported_when_a_later_claim_replaces_it() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim();
    TokenClient::new(&e, &blnd).transfer_from(
        &swap_account,
        &strategy,
        &swap_account,
        &1_000_0000000,
    );

    // The keeper never settles and simply waits the window out. The obligation
    // cannot be enforced retroactively — the BLND is gone — but it does not get
    // to vanish quietly either.
    e.ledger()
        .set_sequence_number(e.ledger().sequence() + crate::constants::HARVEST_APPROVAL_LEDGERS);
    StellarAssetClient::new(&e, &blnd)
        .mock_all_auths()
        .mint(&strategy, &500_0000000);
    sclient.harvest_claim();

    use soroban_sdk::{xdr, TryFromVal};
    let unsettled = e
        .events()
        .all()
        .filter_by_contract(&strategy)
        .events()
        .iter()
        .filter(|ev| {
            let xdr::ContractEventBody::V0(v0) = &ev.body;
            !v0.topics.is_empty()
                && Symbol::try_from_val(&e, &v0.topics[0])
                    == Ok(Symbol::new(&e, "harvest_unsettled"))
        })
        .count();
    assert_eq!(unsettled, 1, "an unsettled claim must be reported on-chain");

    // The replacement claim is floored on its own balance, not the old one's.
    let (blnd_claimed, _, floor, _) = sclient.pending_harvest();
    assert_eq!(blnd_claimed, 500_0000000);
    assert_eq!(floor, 10_0000000);
}

// ── Audit M-5: the trait `harvest` must never swap unprotected ────────────────
//
// `harvest(from, None)` — the natural call for a DeFindex-trait caller that does
// not know this contract's private 16-byte `data` encoding — used to reach
// Soroswap with `amount_out_min = 0`, while `harvest_reinvest` had refused
// exactly that since M-4. The fix closes the asymmetry: the admin's
// `min_harvest_rate` prices a floor over the BLND being swapped, the stricter of
// that and the caller's own number is what reaches the router, and a swap with
// neither is refused rather than run at zero protection.

/// The private `data` encoding: `amount_out_min` as 16 big-endian bytes.
fn min_out_data(e: &Env, amount_out_min: i128) -> Bytes {
    Bytes::from_array(e, &amount_out_min.to_be_bytes())
}

/// A strategy with a real position, `blnd_amount` of BLND in hand and a mock
/// Soroswap router quoting `rate` (underlying per `SCALAR_7` of BLND — the same
/// units as `min_harvest_rate`, so a test can put the quote either side of the
/// floor). Returns `(strategy, sclient, router, keeper)`.
fn setup_trait_harvest<'a>(
    e: &Env,
    pool_addr: &Address,
    token: &Address,
    blnd: &Address,
    blnd_amount: i128,
    rate: i128,
) -> (
    Address,
    crate::BlendLeverageStrategyClient<'a>,
    MockSoroswapRouterClient<'a>,
    Address,
) {
    let router = e.register(MockSoroswapRouter, (rate,));
    let strategy = register_real_strategy_with_target_and_router(
        e, pool_addr, token, blnd, TARGET_HF, &router,
    );
    let sclient = crate::BlendLeverageStrategyClient::new(e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    // The router pays the swap output out of its own balance.
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&router, &10_000_0000000);
    StellarAssetClient::new(e, blnd)
        .mock_all_auths()
        .mint(&strategy, &blnd_amount);

    let keeper = sclient.get_keeper();
    (
        strategy,
        sclient,
        MockSoroswapRouterClient::new(e, &router),
        keeper,
    )
}

#[test]
fn test_trait_harvest_with_no_floor_on_either_side_is_refused() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    // Quote 0.05/BLND — a perfectly good price. The point is that nothing on
    // chain requires it to be one.
    let (strategy, sclient, router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);

    // No `min_harvest_rate`, no `data`: this is the call the finding is about.
    assert_eq!(
        sclient.try_harvest(&keeper, &None),
        Err(Ok(StrategyError::OnlyPositiveAmountAllowed)),
        "an unfloored swap must be refused, not executed at whatever the route quotes"
    );
    // An explicit zero is the same request spelled out, and gets the same answer.
    assert_eq!(
        sclient.try_harvest(&keeper, &Some(min_out_data(&e, 0))),
        Err(Ok(StrategyError::OnlyPositiveAmountAllowed))
    );

    // Nothing was swapped: the refusal took the whole transaction with it.
    assert_eq!(router.last_amount_out_min(), 0);
    assert_eq!(
        TokenClient::new(&e, &blnd).balance(&strategy),
        1_000_0000000,
        "the BLND is still here, waiting for a floored harvest"
    );

    // The keeper's own number reopens the path without waiting on the admin.
    sclient.harvest(&keeper, &Some(min_out_data(&e, 40_0000000)));
    assert_eq!(router.last_amount_out_min(), 40_0000000);
}

#[test]
fn test_trait_harvest_uses_the_admin_floor_when_data_is_absent() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);

    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE); // 0.02 per BLND

    sclient.harvest(&keeper, &None);

    // 1000 BLND × 0.02 = 20 underlying, priced over the balance actually swapped.
    assert_eq!(
        router.last_amount_out_min(),
        20_0000000,
        "`None` now means the admin's floor, not zero"
    );
    assert_eq!(
        TokenClient::new(&e, &blnd).balance(&strategy),
        0,
        "the harvest still runs — the floor is a bound, not a blocker"
    );
}

/// The data of the strategy's last event named `name` in the last invocation.
fn last_event_data(e: &Env, strategy: &Address, name: &str) -> Option<Val> {
    use soroban_sdk::{xdr, TryFromVal};
    let mut found = None;
    for ev in e.events().all().filter_by_contract(strategy).events() {
        let xdr::ContractEventBody::V0(v0) = &ev.body;
        if v0.topics.first().map(|t| Symbol::try_from_val(e, t)) == Some(Ok(Symbol::new(e, name))) {
            found = Val::try_from_val(e, &v0.data).ok();
        }
    }
    found
}

/// The `amount` field of the strategy's last DeFindex event named `name`.
fn defindex_event_amount(e: &Env, strategy: &Address, name: &str) -> Option<i128> {
    use soroban_sdk::{Map, TryFromVal};
    let data = Map::<Symbol, Val>::try_from_val(e, &last_event_data(e, strategy, name)?).ok()?;
    i128::try_from_val(e, &data.get(Symbol::new(e, "amount"))?).ok()
}

// The DeFindex events report the underlying that moved: a harvest what the swap
// of every BLND the strategy held realized, BLND held before the call included,
// as `harvest_reinvest` reports it; a withdraw the amount paid.
#[test]
fn test_harvest_and_withdraw_events_report_the_underlying_that_moved() {
    use soroban_sdk::TryFromVal;
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);

    // The 1000 BLND were in hand before the call; at 0.05 they sell for 50.
    sclient.harvest(&keeper, &None);
    let realized = i128::try_from_val(
        &e,
        &last_event_data(&e, &strategy, "harvest_realized").unwrap(),
    )
    .unwrap();
    assert!(realized >= 50_0000000, "realized={}", realized);
    assert_eq!(
        defindex_event_amount(&e, &strategy, "harvest_event"),
        Some(realized)
    );

    let user = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    // At accrued rates, rounding against the withdrawer pays a little under the
    // amount asked; the event reports the payment. Read before any other call:
    // the events are the last invocation's.
    accrue_interest(&e, &pool_addr, &token, 30 * 24 * 60 * 60);
    let asked = sclient.balance(&user) / 2;
    sclient.withdraw(&asked, &user, &user);
    let logged = defindex_event_amount(&e, &strategy, "withdraw_event");
    let paid = TokenClient::new(&e, &token).balance(&user);
    assert!(paid < asked, "precondition: paid={} asked={}", paid, asked);
    assert_eq!(logged, Some(paid));
}

#[test]
fn test_trait_harvest_takes_the_stricter_of_the_caller_and_admin_floors() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);

    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE); // floor: 20 underlying

    // A keeper asking for 1 stroop of protection does not get to undercut the
    // admin — otherwise the fix would be one malformed `data` away from moot.
    sclient.harvest(&keeper, &Some(min_out_data(&e, 1)));
    assert_eq!(router.last_amount_out_min(), 20_0000000);

    // Stricter than the floor, on the other hand, is the caller's business: they
    // may know the live price, which the admin's slack floor deliberately does not.
    // (The next harvest waits for this one's shares to vest.)
    StellarAssetClient::new(&e, &blnd)
        .mock_all_auths()
        .mint(&strategy, &1_000_0000000);
    e.ledger()
        .with_mut(|li| li.sequence_number += crate::constants::PROFIT_UNLOCK_LEDGERS);
    sclient.harvest(&keeper, &Some(min_out_data(&e, 45_0000000)));
    assert_eq!(router.last_amount_out_min(), 45_0000000);
}

#[test]
fn test_trait_harvest_reverts_when_the_quote_is_below_the_admin_floor() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    // The route quotes 0.005/BLND — a quarter of the floor. This is the trade
    // the finding says the vault should not be making silently.
    let (strategy, sclient, router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 50_000);

    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);

    assert!(
        sclient.try_harvest(&keeper, &None).is_err(),
        "a swap 4× below the floor must revert at the router, not settle"
    );
    assert_eq!(
        router.last_amount_out_min(),
        0,
        "the reverted swap left no state behind"
    );
    assert_eq!(
        TokenClient::new(&e, &blnd).balance(&strategy),
        1_000_0000000
    );
}

#[test]
fn test_trait_harvest_below_the_reward_threshold_needs_no_floor() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    // Half a BLND, against a 1 BLND `reward_threshold`.
    let (_strategy, sclient, router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 5000000, 500_000);

    // `perform_reinvest` no-ops below the threshold, so there is no swap to
    // protect and the floor requirement must not turn a no-op into a revert.
    sclient.harvest(&keeper, &None);
    assert_eq!(router.last_amount_out_min(), 0, "no swap ran");
}

// ── Harvest profit vests, it is not sniped ───────────────────────────────────

/// What the harvest shares still unvested are worth, in underlying: the harvest
/// profit not yet in the holders' share price.
fn unvested_value(sclient: &crate::BlendLeverageStrategyClient) -> i128 {
    let (equity, shares, ..) = sclient.position();
    let unvested = sclient.unvested_shares();
    unvested * equity / (shares + unvested)
}

// A deposit just before a harvest and a withdraw just after used to collect a
// pro-rata share of emissions earned before the deposit, and `harvest_claim`
// announces the amount minutes ahead. The harvest's profit now reaches the
// share price over `PROFIT_UNLOCK_LEDGERS`: the round trip takes out what it
// put in, and the holder who was there gets the harvest as it vests.
#[test]
fn test_harvest_profit_cannot_be_sniped_by_a_round_trip() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let mint = |to: &Address, amount: i128| {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(to, &amount)
    };

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let honest = sclient.get_keeper();
    mint(&honest, 1_000_0000000);
    sclient.deposit(&1_000_0000000, &honest);
    let honest_before = sclient.balance(&honest);

    // The attacker matches the vault just before the harvest lands.
    let attacker = Address::generate(&e);
    mint(&attacker, 1_000_0000000);
    sclient.deposit(&1_000_0000000, &attacker);

    // The harvest: 100 of Broker proceeds, levered in. Its equity is minted as
    // unvested shares rather than priced in.
    let proceeds = 100_0000000_i128;
    mint(&strategy, proceeds);
    sclient.harvest_reinvest(&proceeds, &false, &0);
    let locked = unvested_value(&sclient);
    assert!(
        (proceeds - locked).abs() <= 10,
        "the harvest's equity is unvested: {}",
        locked
    );

    // Out again in the same ledger. Priced in at once, the harvest would have
    // handed the attacker half of it; released gradually, nothing.
    sclient.withdraw(&sclient.balance(&attacker), &attacker, &attacker);
    let attacker_back = TokenClient::new(&e, &token).balance(&attacker);
    assert!(
        attacker_back <= 1_000_0000000,
        "a round trip around the harvest must not profit: got back {}",
        attacker_back
    );

    // The honest holder gets all of it as it vests — the attacker's half
    // included, since the attacker left it behind.
    let (equity, held, ..) = sclient.position();
    let unvested = sclient.unvested_shares();
    let honest_gain = |ledgers: u32| {
        e.ledger().with_mut(|li| li.sequence_number += ledgers);
        sclient.balance(&honest) - honest_before
    };
    let tolerance = locked / 1_000;
    assert!(honest_gain(0).abs() <= 10, "no jump at the harvest");
    // Half the unvested shares are left after half a window, priced alongside
    // the holder's.
    let half = honest_gain(crate::constants::PROFIT_UNLOCK_LEDGERS / 2);
    let expected = equity * held / (held + unvested / 2) - honest_before;
    assert!(
        (half - expected).abs() <= tolerance,
        "half the shares vested after half a window: {} of {}, expected {}",
        half,
        locked,
        expected
    );
    let all = honest_gain(crate::constants::PROFIT_UNLOCK_LEDGERS / 2);
    assert!(
        (all - locked).abs() <= tolerance,
        "all vested after the window: {} of {}",
        all,
        locked
    );
    assert_eq!(sclient.unvested_shares(), 0);

    // And it is real: the honest holder can take it out.
    sclient.withdraw(&sclient.balance(&honest), &honest, &honest);
    let honest_back = TokenClient::new(&e, &token).balance(&honest);
    assert!(
        (honest_back - (honest_before + locked)).abs() <= tolerance,
        "the honest holder withdraws deposit + harvest: {}",
        honest_back
    );
}

/// The harvest routes besides the Broker one, which
/// `test_harvest_profit_cannot_be_sniped_by_a_round_trip` covers.
#[derive(Clone, Copy, Debug)]
enum HarvestRoute {
    /// Broker proceeds with Blend refusing the borrow: they go in unlevered.
    BrokerUnlevered,
    /// Trait `harvest`: BLND swapped on Soroswap, levered in.
    TraitHarvest,
    /// `harvest_reinvest(via_soroswap = true)`.
    ReinvestSoroswap,
}

/// The round trip on one `route`: the attacker matches an honest holder's 1,000
/// just before a harvest worth ~100 of equity and withdraws everything in the
/// same ledger. Returns `(attacker_back, honest_jump, locked)` — what the
/// attacker got back, how far the honest holder's balance moved at the harvest
/// ledger, and what the shares the harvest minted unvested are worth.
fn round_trip_around_a_harvest(route: HarvestRoute) -> (i128, i128, i128) {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    // 0.05 underlying per BLND, so 2,000 BLND swaps to 100.
    let router = e.register(MockSoroswapRouter, (500_000_i128,));
    let strategy = register_real_strategy_with_target_and_router(
        &e, &pool_addr, &token, &blnd, TARGET_HF, &router,
    );
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);
    let keeper = sclient.get_keeper();
    let mint = |asset: &Address, to: &Address, amount: i128| {
        StellarAssetClient::new(&e, asset)
            .mock_all_auths()
            .mint(to, &amount)
    };
    mint(&token, &router, 10_000_0000000);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let honest = keeper.clone();
    mint(&token, &honest, 1_000_0000000);
    sclient.deposit(&1_000_0000000, &honest);
    let attacker = Address::generate(&e);
    mint(&token, &attacker, 1_000_0000000);
    sclient.deposit(&1_000_0000000, &attacker);
    let honest_before = sclient.balance(&honest);

    let proceeds = 100_0000000_i128;
    match route {
        HarvestRoute::BrokerUnlevered => {
            pool::Client::new(&e, &pool_addr).set_status(&2); // no new borrowing
            mint(&token, &strategy, proceeds);
            sclient.harvest_reinvest(&proceeds, &false, &0);
        }
        HarvestRoute::TraitHarvest => {
            mint(&blnd, &strategy, 2_000_0000000);
            sclient.harvest(&keeper, &None);
        }
        HarvestRoute::ReinvestSoroswap => {
            mint(&blnd, &strategy, 2_000_0000000);
            sclient.harvest_reinvest(&1, &true, &0);
        }
    }
    let locked = unvested_value(&sclient);
    let honest_jump = sclient.balance(&honest) - honest_before;

    sclient.withdraw(&sclient.balance(&attacker), &attacker, &attacker);
    let attacker_back = TokenClient::new(&e, &token).balance(&attacker);
    (attacker_back, honest_jump, locked)
}

// The round trip above, on every other route that levers harvest equity in.
// Each mints its gain as unvested shares the same way, so none hands the
// attacker half of it.
#[test]
fn test_no_harvest_route_lets_a_round_trip_collect_the_harvest() {
    for route in [
        HarvestRoute::BrokerUnlevered,
        HarvestRoute::TraitHarvest,
        HarvestRoute::ReinvestSoroswap,
    ] {
        let (attacker_back, honest_jump, locked) = round_trip_around_a_harvest(route);
        assert!(
            (locked - 100_0000000).abs() <= 10,
            "{:?}: the harvest's equity must be unvested: {}",
            route,
            locked
        );
        assert!(
            honest_jump.abs() <= 10,
            "{:?}: the share price must not jump at the harvest: {}",
            route,
            honest_jump
        );
        assert!(
            attacker_back <= 1_000_0000000,
            "{:?}: the round trip must not profit: got back {}",
            route,
            attacker_back
        );
    }
}

// A harvest is refused, by every route and at the claim, until the previous
// one's shares have all vested: each harvest vests over a window of its own.
#[test]
fn test_a_harvest_is_refused_until_the_previous_one_has_vested() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);
    let mint = |to: &Address, amount: i128| {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(to, &amount)
    };

    mint(&strategy, 100_0000000);
    sclient.harvest_reinvest(&100_0000000, &false, &0);
    mint(&strategy, 10_0000000);
    let refused = || {
        let too_early = Some(Ok(StrategyError::DeadlineExpired));
        assert_eq!(sclient.try_harvest(&keeper, &None).err(), too_early);
        assert_eq!(sclient.try_harvest_claim().err(), too_early);
        assert_eq!(
            sclient.try_harvest_reinvest(&10_0000000, &false, &0).err(),
            too_early
        );
        assert_eq!(sclient.try_harvest_reinvest(&1, &true, &0).err(), too_early);
    };
    refused();

    // A ledger short of the window, some of the shares are still unvested.
    e.ledger().with_mut(|li| {
        li.sequence_number += crate::constants::PROFIT_UNLOCK_LEDGERS - 1;
    });
    assert!(sclient.unvested_shares() > 0);
    refused();

    // At its end, the next harvest goes through and starts a window of its own.
    e.ledger().with_mut(|li| li.sequence_number += 1);
    assert_eq!(sclient.unvested_shares(), 0);
    sclient.harvest(&keeper, &None);
    assert!(sclient.unvested_shares() > 0);
}

// When Blend refuses the levered reinvest — the pool on ice here (no new
// borrowing), or the reserve over its max_util — harvest proceeds are supplied
// unlevered rather than left idle in the strategy. A deposit asked for leverage,
// so it still fails.
#[test]
fn test_harvest_reinvest_supplies_unlevered_when_blend_refuses_the_borrow() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let (_, _, b0, d0, _, _) = sclient.position();

    pool::Client::new(&e, &pool_addr).set_status(&2); // admin on ice

    let proceeds = 10_0000000_i128;
    StellarAssetClient::new(&e, &token).mint(&strategy, &proceeds);
    assert_eq!(sclient.harvest_reinvest(&proceeds, &false, &0), proceeds);

    let (_, _, b1, d1, b_rate, _) = sclient.position();
    assert_eq!(d1, d0, "no borrow while the pool is on ice");
    assert!(
        (b1 - b0) * b_rate / SCALAR_12 >= proceeds - 1,
        "the proceeds are supplied: {} b-tokens",
        b1 - b0
    );
    assert_eq!(
        TokenClient::new(&e, &token).balance(&strategy),
        0,
        "nothing is left idle"
    );

    let user = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&user, &100_0000000);
    assert!(sclient.try_deposit(&100_0000000, &user).is_err());
}

// ── Audit M-2: a position change the strategy did not make is priced in ──────
//
// The withdraw tests further down cover the paths where the *strategy itself*
// moved the position.
// M-2 is the complement: a position change the strategy did NOT initiate — a
// liquidation seizing collateral, a Blend bad-debt socialization — was invisible
// to the tracked ledger, so `compute_equity` kept quoting the pre-seizure
// position and `withdraw` priced shares off the inflated figure. The shortfall
// landed entirely on whoever was last out. The position is now read from Blend
// on every call, so there is no ledger to fall behind.
//
// These tests use a direct pool `WithdrawCollateral` submitted as the strategy to
// a third party. It is not a liquidation auction, but it is the same event as far
// as the strategy's accounting is concerned: collateral leaves the position
// without the strategy asking, and nothing in the strategy records it.

/// Open a real leveraged position through the production `deposit` entrypoint
/// and return `(strategy, user)`. Uses the default 3-loop config (HF ≈ 1.27), so
/// there is collateral headroom to seize without tripping the pool's own checks.
fn open_position_for_seizure(
    e: &Env,
    pool_addr: &Address,
    token: &Address,
    blnd: &Address,
) -> (Address, Address) {
    let strategy = register_real_strategy(e, pool_addr, token, blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    (strategy, user)
}

/// Move `amount` of collateral out of the strategy's pool position to `thief`,
/// submitted as the strategy so the strategy's own accounting never sees it.
fn seize_collateral(
    e: &Env,
    pool_addr: &Address,
    strategy: &Address,
    token: &Address,
    amount: i128,
) -> Address {
    let thief = Address::generate(e);
    e.as_contract(strategy, || {
        pool::Client::new(e, pool_addr).submit(
            strategy,
            strategy,
            &thief,
            &vec![
                e,
                pool::Request {
                    address: token.clone(),
                    amount,
                    request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
                },
            ],
        );
    });
    thief
}

// The core of M-2: after collateral leaves the position without the strategy's
// involvement, the loss must show up in share pricing immediately — not on the
// next deposit. Both `balance()` and `position()` read the position from Blend,
// so the write-down is priced in on the very next read. A stored copy of the
// position would have reported the pre-seizure equity, and a withdrawal at that
// price would have overpaid at the expense of the remaining holders.
#[test]
fn test_seized_collateral_is_priced_into_balance_immediately() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let (strategy, user) = open_position_for_seizure(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    let balance_before = sclient.balance(&user);
    let (equity_before, _, b_before, _, b_rate, _) = sclient.position();

    // Seize ~10% of the collateral.
    let seized = b_before / 10;
    seize_collateral(&e, &pool_addr, &strategy, &token, seized);

    // The pool is the truth, and the views must now agree with it.
    let pool_b = pool::Client::new(&e, &pool_addr)
        .get_positions(&strategy)
        .collateral
        .get(cfg.reserve_id)
        .unwrap_or(0);
    assert!(pool_b < b_before, "collateral must have left");

    let (equity_after, _, b_after, _, _, _) = sclient.position();
    let balance_after = sclient.balance(&user);

    assert_eq!(
        b_after, pool_b,
        "M-2: position() must report the pool's collateral"
    );
    assert!(
        equity_after < equity_before,
        "M-2: seized collateral must reduce equity ({} -> {})",
        equity_before,
        equity_after
    );
    assert!(
        balance_after < balance_before,
        "M-2: the holder's priced balance must absorb the loss ({} -> {})",
        balance_before,
        balance_after
    );

    // The loss is priced at its real size, not approximated: equity fell by the
    // underlying value of exactly the collateral that left.
    let seized_value = (b_before - pool_b) * b_rate / SCALAR_12;
    assert_within_1e7(
        equity_before - equity_after,
        seized_value,
        "equity write-down",
    );

    std::println!(
        "M-2 seizure: b {} -> {} | equity {} -> {} | user balance {} -> {}",
        b_before,
        b_after,
        equity_before,
        equity_after,
        balance_before,
        balance_after
    );
}

// Reading the position from Blend on every call is safe because no one else can
// add to it: Blend changes a borrower's position only with its authorization, or
// by liquidation. A third party's `SupplyCollateral` submitted with
// `to = strategy` credits the sender (`submit`'s `to` routes outgoing transfers,
// not incoming supply), so a donation cannot move the share price.
#[test]
fn test_no_one_else_can_add_to_the_position() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let (strategy, user) = open_position_for_seizure(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let pool_client = pool::Client::new(&e, &pool_addr);
    let collateral_of = |who: &Address| {
        pool_client
            .get_positions(who)
            .collateral
            .get(cfg.reserve_id)
            .unwrap_or(0)
    };

    let (_, _, b_before, _, _, _) = sclient.position();
    let balance_before = sclient.balance(&user);

    // A donor tries to supply collateral onto the STRATEGY's position.
    let donor = Address::generate(&e);
    let donation = 5_000_0000000_i128;
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&donor, &donation);
    pool_client.submit(
        &donor,
        &donor,
        &strategy,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: donation,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    // It lands on the donor instead — the pool has no third-party supply path.
    assert_eq!(
        collateral_of(&strategy),
        b_before,
        "Blend must not let a third party credit the strategy's position"
    );
    assert!(
        collateral_of(&donor) > 0,
        "the supply landed on the sender, as expected"
    );
    assert_eq!(
        sclient.balance(&user),
        balance_before,
        "the share price did not move"
    );
}

/// Take the strategy's whole position out from under it — debt repaid,
/// collateral withdrawn — as the strategy, so its own accounting never sees it,
/// and hand the proceeds to a third party. The state a full liquidation or a
/// bad-debt write-off leaves: shares outstanding, nothing behind them.
fn wipe_out_position(e: &Env, pool_addr: &Address, strategy: &Address, token: &Address) {
    let liquidator = Address::generate(e);
    e.as_contract(strategy, || {
        // Blend caps both legs at the position, and the pool nets them, so the
        // strategy owes nothing and is paid the equity.
        pool::Client::new(e, pool_addr).submit_with_allowance(
            strategy,
            strategy,
            strategy,
            &vec![
                e,
                pool::Request {
                    address: token.clone(),
                    amount: i64::MAX as i128,
                    request_type: REQUEST_TYPE_REPAY,
                },
                pool::Request {
                    address: token.clone(),
                    amount: i64::MAX as i128,
                    request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
                },
            ],
        );
        let token_client = TokenClient::new(e, token);
        token_client.transfer(strategy, &liquidator, &token_client.balance(strategy));
    });
}

// A vault wiped out with shares outstanding has no share price. A deposit
// used to be minted 1:1 against nothing and diluted into the old shares, and a
// harvest would restart the vault at a dust price; both are refused.
#[test]
fn test_a_wiped_out_vault_takes_no_deposit_and_no_harvest() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _router, keeper) =
        setup_trait_harvest(&e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);

    wipe_out_position(&e, &pool_addr, &strategy, &token);
    let (equity, shares, b, d, _, _) = sclient.position();
    assert!(
        equity <= 0 && shares > 0 && b == 0 && d == 0,
        "precondition: shares with nothing behind them: equity={} shares={} b={} d={}",
        equity,
        shares,
        b,
        d
    );

    let depositor = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&depositor, &1_000_0000000);
    assert_eq!(
        sclient.try_deposit(&1_000_0000000, &depositor),
        Err(Ok(StrategyError::InvalidSharesMinted))
    );
    assert_eq!(
        TokenClient::new(&e, &token).balance(&depositor),
        1_000_0000000,
        "the depositor keeps their funds"
    );

    // No harvest route restarts it: trait harvest, Broker and Soroswap reinvest.
    assert_eq!(
        sclient.try_harvest(&keeper, &None),
        Err(Ok(StrategyError::InvalidSharesMinted))
    );
    StellarAssetClient::new(&e, &token).mint(&strategy, &10_0000000);
    assert_eq!(
        sclient.try_harvest_reinvest(&10_0000000, &false, &0),
        Err(Ok(StrategyError::InvalidSharesMinted))
    );
    assert_eq!(
        sclient.try_harvest_reinvest(&1, &true, &0),
        Err(Ok(StrategyError::InvalidSharesMinted))
    );
}

/// Take `loss` of equity out of the strategy's position, as the strategy, so
/// its own accounting never sees it, and hand it to a third party: the whole
/// debt repaid and `loss` more collateral withdrawn than that cost. A loss short
/// of a wipe-out, such as a liquidation or a bad-debt write-off leaves.
fn take_equity(e: &Env, pool_addr: &Address, strategy: &Address, token: &Address, loss: i128) {
    let (_, _, _, d, _, d_rate) = crate::BlendLeverageStrategyClient::new(e, strategy).position();
    let debt = (d * d_rate + SCALAR_12 - 1) / SCALAR_12;
    let thief = Address::generate(e);
    e.as_contract(strategy, || {
        // Blend caps the repay at the debt and nets the two legs, so the
        // strategy owes nothing and is paid `loss`.
        pool::Client::new(e, pool_addr).submit_with_allowance(
            strategy,
            strategy,
            strategy,
            &vec![
                e,
                pool::Request {
                    address: token.clone(),
                    amount: i64::MAX as i128,
                    request_type: REQUEST_TYPE_REPAY,
                },
                pool::Request {
                    address: token.clone(),
                    amount: debt + loss,
                    request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
                },
            ],
        );
        let token_client = TokenClient::new(e, token);
        token_client.transfer(strategy, &thief, &token_client.balance(strategy));
    });
}

/// A vault the keeper holds 1,000 of, in which a harvest has just minted ~100
/// of profit as unvested shares and a loss has then left 50 of equity: less
/// than the harvest added. Returns `(strategy, client, keeper, token)`.
fn loss_inside_the_vesting_window<'a>(
    e: &Env,
) -> (
    Address,
    crate::BlendLeverageStrategyClient<'a>,
    Address,
    Address,
) {
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(e);
    seed_pool_liquidity(e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, _router, keeper) =
        setup_trait_harvest(e, &pool_addr, &token, &blnd, 1_000_0000000, 500_000);
    sclient.set_min_harvest_rate(&TEST_MIN_HARVEST_RATE);

    StellarAssetClient::new(e, &token)
        .mock_all_auths()
        .mint(&strategy, &100_0000000);
    sclient.harvest_reinvest(&100_0000000, &false, &0);
    assert!(
        sclient.unvested_shares() > 0,
        "precondition: the harvest minted unvested shares"
    );

    let (equity, ..) = sclient.position();
    take_equity(e, &pool_addr, &strategy, &token, equity - 50_0000000);
    let (equity, ..) = sclient.position();
    assert_eq!(equity, 50_0000000, "precondition: 50 of equity left");
    (strategy, sclient, keeper, token)
}

// A loss inside a harvest's vesting window falls on every share pro rata, the
// unvested ones included, so the holders keep their part of what is left. A
// deposit made just after collects only its part of what vests while it is
// in. (Had the harvest's gain been held back as an amount of underlying, the
// loss would have come out of the holders' equity alone: it would have priced
// their shares at nothing, and a deposit made as the hold-back was released
// below the equity would have bought nearly all the shares and collected the
// 50.)
#[test]
fn test_a_loss_inside_the_vesting_window_falls_on_every_share_pro_rata() {
    let e = Env::default();
    let (_strategy, sclient, keeper, token) = loss_inside_the_vesting_window(&e);
    let shares = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());

    // The keeper's shares are worth their pro-rata part of the 50.
    let (equity, total, ..) = sclient.position();
    let unvested = sclient.unvested_shares();
    let worth = sclient.balance(&keeper);
    assert_eq!(
        worth,
        shares.balance(&keeper) * equity / (total + unvested),
        "the loss falls on every share pro rata"
    );
    assert!(
        worth > 45_0000000,
        "the keeper keeps ~10/11 of the 50: {}",
        worth
    );

    // A deposit of 10 is credited at most what it adds.
    let bob = Address::generate(&e);
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&bob, &10_0000000);
    sclient.deposit(&10_0000000, &bob);
    assert!(sclient.balance(&bob) <= 10_0000000);

    // Over the window, Bob collects his part of the unvested shares' worth,
    // as any holder would, and the keeper keeps everything the loss left it.
    let (_, total, ..) = sclient.position();
    let bob_part = unvested_value(&sclient) * shares.balance(&bob) / total;
    e.ledger().with_mut(|li| {
        li.sequence_number += crate::constants::PROFIT_UNLOCK_LEDGERS;
    });
    assert_eq!(sclient.unvested_shares(), 0);
    let bob_gain = sclient.balance(&bob) - 10_0000000;
    assert!(
        bob_gain <= bob_part + 1,
        "Bob collects at most his part of what vests: {} of {}",
        bob_gain,
        bob_part
    );
    assert!(
        sclient.balance(&keeper) >= worth,
        "the keeper keeps what the loss left it: {} of {}",
        sclient.balance(&keeper),
        worth
    );
}

// Since the shares stay priced after a loss inside the vesting window, the
// vault stays open: deposits and exits, by amount or by share count, go
// through at once, and harvests, by either route, once the window ends, as
// after any harvest.
#[test]
fn test_a_loss_inside_the_vesting_window_leaves_the_vault_open() {
    let e = Env::default();
    let (strategy, sclient, keeper, token) = loss_inside_the_vesting_window(&e);
    let shares = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let mint = |to: &Address, amount: i128| {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(to, &amount)
    };
    let next_window = || {
        e.ledger()
            .with_mut(|li| li.sequence_number += crate::constants::PROFIT_UNLOCK_LEDGERS)
    };

    let depositor = Address::generate(&e);
    mint(&depositor, 1_000_0000000);
    sclient.deposit(&1_000_0000000, &depositor);
    assert!(sclient.balance(&depositor) > 0);

    let worth = sclient.balance(&keeper);
    sclient.withdraw(&(worth / 2), &keeper, &keeper);
    let paid = sclient.redeem(&shares.balance(&keeper), &keeper, &keeper);
    assert!(paid > 0 && shares.balance(&keeper) == 0);

    next_window();
    sclient.harvest(&keeper, &None);
    next_window();
    mint(&strategy, 10_0000000);
    sclient.harvest_reinvest(&10_0000000, &false, &0);
}

// ── Withdrawals at accrued rates keep the share count in sync ───────────────
//
// The strategy stores one figure of its own, the share count; its position is
// read from Blend on every call. Through the real `deposit`/`withdraw`
// entrypoints, at rates drifted above 1.0, the stored count must stay equal to
// the share token's supply, the per-user ledger it mirrors, and the position the
// strategy reports must be the pool's.
#[test]
fn test_real_withdraw_entrypoint_keeps_the_share_count_in_sync() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Wire the share token (the strategy is its minter).

    // Fund a user and deposit through the REAL entrypoint (runs the real
    // submit_lever_in + reserves::deposit).
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    let token_admin = StellarAssetClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&user, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    sclient.deposit(&deposit, &user);

    // Accrue ~1 year and poke the reserve so rates drift above 1.0.
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    // Withdraw ~30% of the user's balance through the REAL entrypoint, twice.
    for _ in 0..2 {
        let bal = sclient.balance(&user);
        let amount = bal * 3 / 10;
        sclient.withdraw(&amount, &user, &user);
    }

    // The invariant must hold through the production withdraw path.
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let stored_shares = e.as_contract(&strategy, || storage::get_total_shares(&e));
    assert_eq!(stored_shares, share.total_supply(), "share count in sync");
    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let (_, _, b, d, _, _) = sclient.position();
    assert_eq!(b, post.collateral.get(cfg.reserve_id).unwrap_or(0));
    assert_eq!(d, post.liabilities.get(cfg.reserve_id).unwrap_or(0));
}

// Full-close sibling: a user withdrawing their ENTIRE balance drives the
// near-full unwind (the repay of almost all the debt). The user is paid ~their
// full balance, only the inflation lockup is left behind, and the stored share
// count still matches the token's supply.
#[test]
fn test_real_full_withdraw_entrypoint_keeps_the_share_count_in_sync() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let shclient = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    let token_admin = StellarAssetClient::new(&e, &token);
    let token_client = TokenClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&user, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    sclient.deposit(&deposit, &user);

    // Accrue ~1 year and poke so rates drift above 1.0.
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    // Withdraw the user's ENTIRE reported balance through the real entrypoint.
    let bal = sclient.balance(&user);
    let user_before = token_client.balance(&user);
    sclient.withdraw(&bal, &user, &user);
    let received = token_client.balance(&user) - user_before;

    // The invariant still holds across the near-full unwind.
    let stored_shares = e.as_contract(&strategy, || storage::get_total_shares(&e));
    assert_eq!(
        stored_shares,
        shclient.total_supply(),
        "share count in sync"
    );
    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let (_, _, b, d, _, _) = sclient.position();
    assert_eq!(b, post.collateral.get(cfg.reserve_id).unwrap_or(0));
    assert_eq!(d, post.liabilities.get(cfg.reserve_id).unwrap_or(0));

    // The user is paid ~their whole balance (1% tolerance for pool/loop rounding).
    assert!(
        (received - bal).abs() <= bal / 100,
        "user should receive ~full balance: got {} want {}",
        received,
        bal
    );

    // Only the inflation lockup (held by the strategy) remains; the user's own
    // shares are essentially gone (allow a few stroops of ceil/floor dust).
    assert!(
        shclient.balance(&user) <= 1_000,
        "user shares should be ~fully burned, left {}",
        shclient.balance(&user)
    );
    assert!(
        (stored_shares - crate::constants::FIRST_DEPOSIT_LOCKUP).abs() <= 1_000,
        "only the lockup should remain, total_shares={}",
        stored_shares
    );
}

// A withdrawal rounds against the withdrawer: the shares it burns round up,
// their collateral down and their debt up, and Blend's own rounding of the two
// legs comes out of the amount paid. So at drifted rates, whatever the size,
// the holders who stay keep at least their share of the position's exact value,
// at a health factor no lower than before, and the withdrawer is paid no more
// than the shares burned were worth.
#[test]
fn test_a_withdrawal_never_costs_the_holders_who_stay() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let shares = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let token_client = TokenClient::new(&e, &token);

    // The keeper opens the vault and stays; the leaver exits a piece at a time.
    let (stayer, leaver) = (sclient.get_keeper(), Address::generate(&e));
    for user in [&stayer, &leaver] {
        StellarAssetClient::new(&e, &token)
            .mock_all_auths()
            .mint(user, &1_000_0000000);
        sclient.deposit(&1_000_0000000, user);
    }
    accrue_interest(&e, &pool_addr, &token, 31_536_000);

    // `(value, shares, b, d)`: `value` is the position's exact value, in
    // underlying × SCALAR_12, so a share's is `value / shares` unrounded.
    let position = || {
        let (_, total_shares, b, d, b_rate, d_rate) = sclient.position();
        assert!(
            b_rate > SCALAR_12 && d_rate > SCALAR_12,
            "rates have drifted"
        );
        (b * b_rate - d * d_rate, total_shares, b, d)
    };

    // Odd amounts of underlying, then the rest by share count.
    let exits = [
        Some(1_000_i128),
        Some(12_345),
        Some(3_333_333),
        Some(123_456_789),
        None,
    ];
    for exit in exits {
        let (value, total, b, d) = position();
        let held = shares.balance(&leaver);
        let balance = token_client.balance(&leaver);
        match exit {
            Some(amount) => {
                sclient.withdraw(&amount, &leaver, &leaver);
            }
            None => {
                sclient.redeem(&held, &leaver, &leaver);
            }
        }
        let burned = held - shares.balance(&leaver);
        let paid = token_client.balance(&leaver) - balance;
        let (value_after, total_after, b_after, d_after) = position();

        assert!(
            value_after * total >= value * total_after,
            "{:?}: a share of what stays is worth no less: {}/{} -> {}/{}",
            exit,
            value,
            total,
            value_after,
            total_after
        );
        assert!(
            b_after * d >= b * d_after,
            "{:?}: the collateral-to-debt ratio, so the HF, does not fall",
            exit
        );
        assert!(
            paid * SCALAR_12 * total <= burned * value,
            "{:?}: paid {} for {} of {} shares",
            exit,
            paid,
            burned,
            total
        );
    }
    assert_eq!(shares.balance(&leaver), 0);
}

// ── D2: a transferred receipt token carries the underlying claim ──────────────
//
// The vault-share token is a standard SEP-41 — holding it *is* holding the
// position. This drives the full chain through the REAL token contract: real
// SEP-41 `transfer` semantics + real strategy + real Blend pool. Alice deposits, transfers her entire share balance to Bob, then
// Bob — who never touched the strategy — withdraws and is paid the underlying,
// while Alice is paid nothing. This is the integration guarantee the Aquarius
// listing (T3) relies on: the strategy attributes equity by *current* token
// ownership, and the token supply stays equal to the strategy's `total_shares`.
#[test]
fn test_transferred_shares_let_recipient_withdraw() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    // Config must exist for the pool reserve, but this test reads claims through
    // the public strategy entrypoints rather than storage directly.
    let _cfg = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // The REAL SEP-41 share token the strategy deployed, as its sole minter.
    let share = sclient.share_token();
    let shclient = vault_share_token::VaultShareTokenClient::new(&e, &share);

    // Alice deposits through the real entrypoint (mints her shares on the token).
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let alice = sclient.get_keeper();
    let bob = Address::generate(&e);
    let token_admin = StellarAssetClient::new(&e, &token);
    let token_client = TokenClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&alice, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    sclient.deposit(&deposit, &alice);

    let alice_shares = shclient.balance(&alice);
    assert!(alice_shares > 0, "alice should hold shares after deposit");
    assert_eq!(shclient.balance(&bob), 0, "bob starts with no shares");

    // Accrue ~1 year and poke the reserve so rates drift above 1.0 (equity grows
    // beyond principal — the post-transfer claim is non-trivial).
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    // Alice transfers her ENTIRE share balance to Bob via the SEP-41 `transfer`.
    shclient.transfer(&alice, &bob, &alice_shares);
    assert_eq!(shclient.balance(&alice), 0, "alice fully transferred out");
    assert_eq!(
        shclient.balance(&bob),
        alice_shares,
        "bob now holds the shares"
    );

    // The strategy must now attribute the position to BOB, not Alice.
    assert_eq!(
        sclient.balance(&alice),
        0,
        "alice has no claim post-transfer"
    );
    let bob_claim = sclient.balance(&bob);
    assert!(
        bob_claim > 0,
        "bob's transferred shares carry the underlying claim"
    );

    // Bob — who never deposited — withdraws his full balance and is paid.
    let bob_before = token_client.balance(&bob);
    sclient.withdraw(&bob_claim, &bob, &bob);
    let bob_received = token_client.balance(&bob) - bob_before;
    let alice_received = token_client.balance(&alice);

    std::println!(
        "transfer-then-withdraw: alice_shares={} bob_claim={} bob_received={} alice_received={}",
        alice_shares,
        bob_claim,
        bob_received,
        alice_received,
    );

    // Bob receives ~his claim (1% tolerance for pool/loop rounding); Alice none.
    assert!(
        (bob_received - bob_claim).abs() <= bob_claim / 100,
        "bob should receive ~his claim: got {} want {}",
        bob_received,
        bob_claim
    );
    assert_eq!(
        alice_received, 0,
        "alice must not be paid after transferring her shares away"
    );

    // Bob's shares are ~fully burned; the token supply still equals the
    // strategy's accounting (`total_supply == total_shares`), with only the
    // inflation lockup left behind.
    assert!(
        shclient.balance(&bob) <= 1_000,
        "bob shares should be ~fully burned, left {}",
        shclient.balance(&bob)
    );
    assert_eq!(
        shclient.total_supply(),
        e.as_contract(&strategy, || storage::get_total_shares(&e)),
        "token supply must stay equal to strategy total_shares"
    );
}

// A holder quotes their balance, and by the time the withdraw lands the share
// price has moved: `withdraw` of that quote either asks for more than the shares
// are now worth and is refused, or for less and leaves shares behind. `redeem`
// of the share balance exits completely and pays what the shares are worth.
#[test]
fn test_redeem_exits_by_share_count_after_the_price_moves() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let underlying = TokenClient::new(&e, &token);
    let (alice, bob) = (Address::generate(&e), Address::generate(&e));
    for holder in [sclient.get_keeper(), alice.clone(), bob.clone()] {
        StellarAssetClient::new(&e, &token).mint(&holder, &1_000_0000000);
        sclient.deposit(&1_000_0000000, &holder);
    }
    let alice_quote = sclient.balance(&alice);
    accrue_interest(&e, &pool_addr, &token, 30 * 24 * 60 * 60);
    assert_ne!(
        sclient.balance(&alice),
        alice_quote,
        "precondition: the price moved"
    );

    match sclient.try_withdraw(&alice_quote, &alice, &alice) {
        Err(_) => {}
        Ok(_) => assert!(
            share.balance(&alice) > 0,
            "a withdraw that lands leaves shares"
        ),
    }

    let worth = sclient.balance(&bob);
    let paid = sclient.redeem(&share.balance(&bob), &bob, &bob);
    assert_eq!(share.balance(&bob), 0, "nothing is left behind");
    assert_eq!(
        underlying.balance(&bob),
        paid,
        "the return value is what was paid"
    );
    assert!(
        paid <= worth && worth - paid <= 10,
        "pays the shares' worth, rounded against the holder: paid={} worth={}",
        paid,
        worth
    );

    // The share count is recorded as `withdraw` records it.
    assert_eq!(
        e.as_contract(&strategy, || storage::get_total_shares(&e)),
        share.total_supply()
    );
}

#[test]
fn test_redeem_refuses_what_the_holder_cannot_redeem() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let user = Address::generate(&e);
    for holder in [sclient.get_keeper(), user.clone()] {
        StellarAssetClient::new(&e, &token).mint(&holder, &1_000_0000000);
        sclient.deposit(&1_000_0000000, &holder);
    }
    let held = share.balance(&user);

    match sclient.try_redeem(&(held + 1), &user, &user) {
        Err(Ok(StrategyError::InsufficientBalance)) => {}
        other => std::panic!("expected InsufficientBalance, got {:?}", other),
    }
    match sclient.try_redeem(&0, &user, &user) {
        Err(Ok(StrategyError::OnlyPositiveAmountAllowed)) => {}
        other => std::panic!("expected OnlyPositiveAmountAllowed, got {:?}", other),
    }

    // A stranger's signature does not redeem the holder's shares.
    let stranger = Address::generate(&e);
    assert!(sclient
        .mock_auths(&[MockAuth {
            address: &stranger,
            invoke: &MockAuthInvoke {
                contract: &strategy,
                fn_name: "redeem",
                args: (held, user.clone(), stranger.clone()).into_val(&e),
                sub_invokes: &[],
            },
        }])
        .try_redeem(&held, &user, &stranger)
        .is_err());
    assert_eq!(
        share.balance(&user),
        held,
        "the holder's shares are untouched"
    );
}

// Blend refuses a withdraw that leaves a borrower with debt and less than the
// pool's `min_collateral` ($5 on the live pool). The last holder's exit leaves
// only the locked shares' slice, worth a fraction of a cent, so a proportional
// unwind would be refused and the holder locked in. The exit closes the whole
// debt instead, and the locked shares keep their value, unlevered.
#[test]
fn test_the_last_holder_exits_below_the_pool_min_collateral() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    // $5 at the mock oracle's 14 decimals, as on the live pool.
    pool::Client::new(&e, &pool_addr).update_pool(&1_000_000, &4, &500_000_000_000_000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = vault_share_token::VaultShareTokenClient::new(&e, &sclient.share_token());
    let keeper = sclient.get_keeper();
    let user = Address::generate(&e);
    for holder in [keeper.clone(), user.clone()] {
        StellarAssetClient::new(&e, &token).mint(&holder, &1_000_0000000);
        sclient.deposit(&1_000_0000000, &holder);
    }
    accrue_interest(&e, &pool_addr, &token, 30 * 24 * 60 * 60);

    // An exit that leaves the vault large goes out as usual.
    sclient.redeem(&share.balance(&user), &user, &user);
    let pool_d = |e: &Env| {
        pool::Client::new(e, &pool_addr)
            .get_positions(&strategy)
            .liabilities
            .get(cfg.reserve_id)
            .unwrap_or(0)
    };
    assert!(pool_d(&e) > 0, "the vault is still levered");

    // The last holder's exit closes the debt.
    let locked_before = sclient.balance(&strategy);
    let worth = sclient.balance(&keeper);
    let paid = sclient.redeem(&share.balance(&keeper), &keeper, &keeper);
    assert_eq!(share.balance(&keeper), 0);
    assert_eq!(pool_d(&e), 0, "no debt is left behind");
    assert!(
        sclient.balance(&strategy) >= locked_before,
        "the locked shares keep their value"
    );
    assert!(
        paid <= worth && worth - paid <= 10,
        "paid={} worth={}",
        paid,
        worth
    );
    let stored_shares = e.as_contract(&strategy, || storage::get_total_shares(&e));
    assert_eq!(stored_shares, crate::constants::FIRST_DEPOSIT_LOCKUP);
    assert_eq!(stored_shares, share.total_supply());

    // The vault takes deposits again.
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    assert!(pool_d(&e) > 0, "a new deposit levers in");
}

// ── T1.3: in-place WASM upgrade parity on a LIVE Blend pool-state fixture ──────
//
// The deliverable requires the in-place WASM upgrade to preserve each user's
// health factor and balance "against live pool-state fixtures, within 1e-7".
// Unlike the seeded unit fixture in `test_leverage.rs`
// (`test_upgrade_preserves_hf_and_balance_parity`), this drives a REAL leveraged
// position on the BlendFixture pool — a real `deposit` plus a year of accrued,
// drifted b/d rates — snapshots equity / HF / per-user underlying through the
// production entrypoints, then invokes the REAL `upgrade()` entrypoint
// (admin-gated, version bump). `upgrade()` calls `update_current_contract_wasm`,
// which the test host rejects unless the target hash is a genuinely uploaded
// WASM, so we upload a real Soroban WASM to satisfy the in-place swap. After the
// swap the strategy's executable points at the new code, so post-upgrade state
// is read host-side from the *preserved* contract storage and recomputed with
// the same production functions the entrypoints use. Parity must hold within
// 1e-7 (it is exact: an in-place WASM swap never touches storage).
fn assert_within_1e7(before: i128, after: i128, label: &str) {
    let tol = (before.abs() / 10_000_000).max(1);
    assert!(
        (after - before).abs() <= tol,
        "{label} parity beyond 1e-7: before={before} after={after} tol={tol}"
    );
}

#[test]
fn test_upgrade_preserves_hf_and_balance_on_live_pool_state() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // The REAL SEP-41 share token the strategy deployed, as its sole minter.
    let share = sclient.share_token();
    let shclient = vault_share_token::VaultShareTokenClient::new(&e, &share);

    // Real leveraged deposit -> live pool position.
    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    let token_admin = StellarAssetClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&user, &deposit);
    e.cost_estimate().budget().reset_unlimited();
    sclient.deposit(&deposit, &user);

    // Accrue ~1 year and poke so b/d rates drift above 1.0 — a genuine,
    // non-trivial live fixture (not seeded reserves pinned at rate == 1.0).
    e.ledger().with_mut(|li| {
        li.timestamp += 31_536_000;
        li.sequence_number += 6_000_000;
    });
    let poker = Address::generate(&e);
    token_admin.mint(&poker, &1_0000000);
    pool::Client::new(&e, &pool_addr).submit(
        &poker,
        &poker,
        &poker,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 1_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
        ],
    );

    // ── Pre-upgrade snapshot via the production entrypoints ──
    let (equity_before, _shares_before, b_before, d_before, b_rate_before, d_rate_before) =
        sclient.position();
    let hf_before = sclient.health_factor();
    let user_underlying_before = sclient.balance(&user);
    let version_before = sclient.version();
    let user_shares = shclient.balance(&user);
    let shares_before = e.as_contract(&strategy, || storage::get_total_shares(&e));

    // The fixture must be a real, leveraged, rate-drifted position.
    assert!(d_before > 0, "fixture must carry debt (leverage active)");
    assert!(
        equity_before > 0 && hf_before > 0 && user_underlying_before > 0,
        "fixture must be a non-trivial live position"
    );
    assert!(
        b_rate_before != SCALAR_12 || d_rate_before != SCALAR_12,
        "rates must have drifted off 1.0 — proves a live pool fixture, not seeded"
    );

    // ── Invoke the REAL upgrade() entrypoint ──
    let new_wasm = e
        .deployer()
        .upload_contract_wasm(blend_contract_sdk::pool::WASM);
    sclient.upgrade(&new_wasm);

    // ── Post-upgrade recomputation from PRESERVED storage (host-side) ──
    // The executable now points at the swapped WASM, so we recompute with the
    // same production functions the entrypoints call, over the untouched
    // contract storage and unchanged pool state.
    let version_after = e.as_contract(&strategy, || storage::get_version(&e));
    let shares_after = e.as_contract(&strategy, || storage::get_total_shares(&e));
    let (equity_after, hf_after, user_underlying_after, b_after, d_after) =
        e.as_contract(&strategy, || {
            let config = storage::get_config(&e);
            let r = reserves::current(&e, &config);
            let equity = crate::leverage::compute_equity(&r).unwrap();
            let (b_rate, d_rate, _, l_factor) = blend_pool::get_rates_and_factors(&e, &config);
            let (b_tokens, d_tokens) = blend_pool::get_strategy_positions(&e, &config);
            let hf = compute_health_factor(
                b_tokens,
                d_tokens,
                b_rate,
                d_rate,
                config.c_factor,
                l_factor,
            )
            .unwrap();
            let underlying =
                shares_to_underlying(user_shares, &r, reserves::unvested_shares(&e).unwrap())
                    .unwrap();
            (equity, hf, underlying, r.total_b_tokens, r.total_d_tokens)
        });

    // Version bumped by exactly 1; the stored share count and Blend's record of
    // the position both untouched.
    assert_eq!(
        version_after,
        version_before + 1,
        "version must bump on upgrade"
    );
    assert_eq!(
        shares_after, shares_before,
        "total_shares preserved across upgrade"
    );
    assert_eq!(
        (b_after, d_after),
        (b_before, d_before),
        "position untouched by the upgrade"
    );

    // HF and per-user balance identical within 1e-7 (here: exactly equal).
    assert_within_1e7(equity_before, equity_after, "equity");
    assert_within_1e7(hf_before, hf_after, "health factor");
    assert_within_1e7(
        user_underlying_before,
        user_underlying_after,
        "user underlying",
    );

    std::println!(
        "upgrade-parity (live pool): v{}->v{} | hf={} | equity={} | user_underlying={} | rates b={} d={}",
        version_before,
        version_after,
        hf_before,
        equity_before,
        user_underlying_before,
        b_rate_before,
        d_rate_before,
    );
}

// ── H-1: the reported HF must carry Blend's l_factor liability markup ─────────
//
// `compute_health_factor` used to weight only the collateral side
// (`HF = B × c_factor / D`) while Blend's own solvency check marks liabilities
// *up* by dividing by the reserve's `l_factor`. The strategy's HF was therefore
// systematically optimistic relative to the number that actually governs
// liquidation, and the whole suite was blind to the term because every fixture
// pinned `l_factor = 1.0`.
//
// These tests run against a reserve with a REAL markup and check the fix where
// it matters: the strategy's HF crosses 1.0 exactly when the Blend pool starts
// accepting a liquidation auction on the position.

/// Ask the pool to open a user-liquidation auction against `user`, and report
/// whether it will. This is Blend's own verdict on the position rather than a
/// re-implementation of it: the pool rejects the auction outright while the
/// position is healthy by its own measure.
///
/// Every percentage is swept because Blend accepts exactly the one that restores
/// the user to its target health — anything smaller or larger is rejected with a
/// different error — so a fixed handful of percentages would report a false
/// "not liquidatable".
fn blend_would_liquidate(e: &Env, pool_addr: &Address, user: &Address, asset: &Address) -> bool {
    let assets = vec![e, asset.clone()];
    (1u32..=100).any(|percent| {
        pool::Client::new(e, pool_addr)
            .mock_all_auths()
            .try_new_auction(&0, user, &assets, &assets, &percent)
            .is_ok()
    })
}

#[test]
fn test_health_factor_carries_pool_l_factor() {
    let e = Env::default();
    e.mock_all_auths();
    // Reserve with a genuine liability markup: l = 0.85, pool c = 0.95.
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env_with_l_factor(&e, 8_500_000);
    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    // The view reports the pool's live risk parameters, and the constructor's
    // `c_factor <= pool c_factor` invariant holds.
    let (strategy_c, pool_c, l_factor) = sclient.risk_factors();
    assert_eq!(
        (strategy_c, pool_c, l_factor),
        (9_000_000, 9_500_000, 8_500_000)
    );
    assert!(strategy_c <= pool_c);

    let positions = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let config = make_config(&e, &pool_addr, &token, &blnd);
    let b = positions.collateral.get(config.reserve_id).unwrap_or(0);
    let d = positions.liabilities.get(config.reserve_id).unwrap_or(0);
    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);

    // 1. The entrypoint reports the markup-aware number.
    let hf = sclient.health_factor();
    let expected = compute_health_factor(b, d, b_rate, d_rate, strategy_c, l_factor).unwrap();
    assert_eq!(hf, expected);

    // 2. Which is strictly below what the pre-H-1 formula reported.
    let hf_pre_fix = compute_health_factor(b, d, b_rate, d_rate, strategy_c, SCALAR_7).unwrap();
    assert!(
        hf < hf_pre_fix,
        "markup-aware HF {} should be below the l_factor-free {}",
        hf,
        hf_pre_fix
    );

    // 3. And it is a lower bound on Blend's own ratio, so HF >= 1.0 is a real
    //    guarantee rather than a per-asset parameter coincidence.
    let blend_ratio = compute_health_factor(b, d, b_rate, d_rate, pool_c, l_factor).unwrap();
    assert!(
        hf <= blend_ratio,
        "strategy HF {} must not exceed Blend's ratio {}",
        hf,
        blend_ratio
    );

    // 4. The pool agrees the position is safe.
    assert!(hf > SCALAR_7, "fixture should be healthy: hf={}", hf);
    assert!(
        !blend_would_liquidate(&e, &pool_addr, &strategy, &token),
        "Blend should refuse to liquidate a position the strategy calls healthy"
    );

    std::println!(
        "l_factor fixture: hf={} (pre-fix {}) blend_ratio={} b={} d={}",
        hf,
        hf_pre_fix,
        blend_ratio,
        b,
        d
    );
}

#[test]
fn test_health_factor_tracks_a_governance_l_factor_cut() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e); // l = 1.0
    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // The keeper opens the vault: only it or the admin may make the first deposit.
    let user = sclient.get_keeper();
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);

    let hf_before = sclient.health_factor();
    assert!(hf_before > SCALAR_7, "should open healthy: {}", hf_before);
    assert!(!blend_would_liquidate(&e, &pool_addr, &strategy, &token));

    // Blend governance re-parameterises the reserve, cutting l_factor to 0.60.
    // This is why the strategy reads l_factor live instead of caching it at
    // construction: a stored copy would keep reporting the stale, safe number.
    let pool_client = pool::Client::new(&e, &pool_addr);
    let mut reserve_config = pool_client.get_reserve(&token).config;
    reserve_config.l_factor = 6_000_000;
    pool_client.queue_set_reserve(&token, &reserve_config);
    e.ledger()
        .set_timestamp(e.ledger().timestamp() + 8 * 24 * 60 * 60);
    pool_client.set_reserve(&token);
    assert_eq!(sclient.risk_factors().2, 6_000_000);

    // The strategy now reports the position as liquidatable — and so does Blend.
    let hf_after = sclient.health_factor();
    assert!(
        hf_after < hf_before,
        "HF should fall with l_factor: before={} after={}",
        hf_before,
        hf_after
    );
    assert!(
        hf_after < SCALAR_7,
        "HF should drop below 1.0 after the cut: {}",
        hf_after
    );
    assert!(
        blend_would_liquidate(&e, &pool_addr, &strategy, &token),
        "Blend should accept a liquidation once the strategy's HF is below 1.0"
    );

    std::println!("governance l_factor cut: hf {} -> {}", hf_before, hf_after);
}

// Blend governance cuts the reserve's c_factor below the strategy's own. The
// strategy must measure health with the live, lower factor — otherwise it
// calls a position Blend can liquidate healthy, `rebalance` never steps in,
// and deposits keep levering to the stale ratio.
#[test]
fn test_health_factor_tracks_a_governance_c_factor_cut() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e); // c 0.95, l 1.0
    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);
    e.cost_estimate().budget().reset_unlimited();
    let config = make_config(&e, &pool_addr, &token, &blnd);

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd); // c 0.90
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Governance cuts the reserve's c_factor from 0.95 to 0.70.
    let pool_client = pool::Client::new(&e, &pool_addr);
    let mut reserve_config = pool_client.get_reserve(&token).config;
    reserve_config.c_factor = 7_000_000;
    pool_client.queue_set_reserve(&token, &reserve_config);
    e.ledger()
        .set_timestamp(e.ledger().timestamp() + 8 * 24 * 60 * 60);
    pool_client.set_reserve(&token);
    assert_eq!(sclient.risk_factors(), (9_000_000, 7_000_000, SCALAR_7));

    // Blend's own ratio for the position, at the live c_factor.
    let blend_hf = |e: &Env| {
        let (b, d) = e.as_contract(&strategy, || blend_pool::get_strategy_positions(e, &config));
        let (b_rate, d_rate) = blend_pool::get_rates(e, &config);
        compute_health_factor(b, d, b_rate, d_rate, 7_000_000, SCALAR_7).unwrap()
    };
    assert!(
        blend_hf(&e) < SCALAR_7,
        "precondition: the cut leaves the position liquidatable: {}",
        blend_hf(&e)
    );

    // 1. The strategy's HF is no longer optimistic.
    let hf = sclient.health_factor();
    assert!(
        hf <= blend_hf(&e),
        "strategy HF {} must not exceed Blend's {} after the cut",
        hf,
        blend_hf(&e)
    );

    // 2. So the permissionless rebalance acts, and lands clear of the orange
    //    zone in Blend's terms.
    sclient.rebalance();
    assert!(
        blend_hf(&e) >= config.orange_hf,
        "rebalance must restore Blend's ratio above orange: {}",
        blend_hf(&e)
    );
    assert!(!blend_would_liquidate(&e, &pool_addr, &strategy, &token));

    // 3. And a new deposit levers to the target against the live factor, not
    //    the stale one.
    let user = Address::generate(&e);
    StellarAssetClient::new(&e, &token).mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    assert!(
        blend_hf(&e) >= config.orange_hf,
        "a deposit must not lever past the target in Blend's terms: {}",
        blend_hf(&e)
    );
    assert!(!blend_would_liquidate(&e, &pool_addr, &strategy, &token));
}
