#![cfg(test)]

//! Integration tests against a real mock Blend pool using BlendFixture.
//!
//! Tests pool interactions (supply, borrow, repay, withdraw) individually,
//! then validates the full deposit→withdraw accounting cycle.
//!
//! Note: Blend v2 pool.submit() does NOT net token flows within a single call.
//! The pool pulls total supply amounts and sends total borrow amounts separately.
//! For leverage loops, requests must be submitted in supply→borrow pairs so that
//! borrowed tokens fund the next supply step.

extern crate std;

use blend_contract_sdk::{
    pool,
    testutils::{default_reserve_config, BlendFixture},
};
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, BytesN as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal, String, Vec,
};

use crate::constants::{
    REQUEST_TYPE_BORROW, REQUEST_TYPE_REPAY, REQUEST_TYPE_SUPPLY_COLLATERAL,
    REQUEST_TYPE_WITHDRAW_COLLATERAL, SCALAR_12, SCALAR_7,
};
use crate::leverage::{
    compute_health_factor, compute_loop_pairs, shares_to_underlying,
};
use crate::storage::LeverageReserves;
use crate::{blend_pool, reserves, storage};
use crate::StrategyError;

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

fn setup_blend_env(e: &Env) -> (Address, Address, Address, BlendFixture<'_>, Address) {
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
        &0_1000000,
        &4,
        &0,
    );

    let mut reserve_config = default_reserve_config();
    reserve_config.c_factor = 9_500_000;
    reserve_config.l_factor = 10_000_000; // 1.0: no liability markup, so effective borrow = supply * c_factor
    reserve_config.max_util = 9_900_000;

    let pool_client = pool::Client::new(e, &pool_addr);
    pool_client
        .mock_all_auths()
        .queue_set_reserve(&token, &reserve_config);
    pool_client.mock_all_auths().set_reserve(&token);

    blend
        .backstop
        .mock_all_auths()
        .deposit(&deployer, &pool_addr, &50_000_0000000);
    pool_client.mock_all_auths().set_status(&3);
    pool_client.mock_all_auths().update_status();

    (pool_addr, token, blnd, blend, deployer)
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
        target_loops: 3,
        min_hf: 10_500_000,
    }
}

fn seed_pool_liquidity(e: &Env, pool_addr: &Address, token: &Address, amount: i128) {
    let whale = Address::generate(e);
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&whale, &amount);

    pool::Client::new(e, pool_addr)
        .mock_all_auths()
        .submit(
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

        pool_client.mock_all_auths().submit(
            strategy,
            strategy,
            strategy,
            &requests,
        );
    }

    // Read final positions
    let positions = pool_client.get_positions(strategy);
    let b_tokens = positions.collateral.get(0).unwrap_or(0);
    let d_tokens = positions.liabilities.get(0).unwrap_or(0);
    (b_tokens, d_tokens)
}

/// Execute an unwind: repay debt + withdraw collateral.
///
/// The Blend pool does gross transfers (not netted), so the spender needs tokens
/// for the repay portion. We pre-fund the strategy with repay tokens, then
/// unwind to `to`, which receives the withdrawal proceeds.
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
        // Pre-fund strategy with tokens to cover the repay.
        // In production, submit() would net these flows, but the pool WASM
        // does gross transfers. This simulates the flash-loan-like behavior
        // where the pool advances the tokens.
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
    assert!(b_tokens > 0, "Should have b-tokens after supply: {}", b_tokens);

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
    assert!(d_tokens > 0, "Should have d-tokens after borrow: {}", d_tokens);

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
        config.target_loops,
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
        config.target_loops,
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
        storage::set_strategy_reserves(&e, init_reserves.clone());

        let (vault_shares, updated) =
            reserves::deposit(&e, &user, b_tokens, d_tokens, &init_reserves).unwrap();

        assert!(vault_shares > 0, "Should have shares");

        let balance = shares_to_underlying(vault_shares, &updated).unwrap();
        assert!(
            balance > deposit_amount * 95 / 100,
            "Balance {} should be close to deposit {}",
            balance,
            deposit_amount
        );

        // === WITHDRAW ===
        let (remaining, b_remove, d_remove, _) =
            reserves::withdraw(&e, &user, balance, &updated).unwrap();
        assert_eq!(remaining, 0, "All shares should be burned");

        // Verify b/d amounts are proportional
        assert!(b_remove > 0 && d_remove > 0, "Should remove b and d tokens");
    });

    // Execute the actual unwind on pool
    execute_unwind(
        &e,
        &pool_addr,
        &strategy,
        &user,
        &token,
        b_tokens,
        d_tokens,
    );

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
    let alice = Address::generate(&e);
    let bob = Address::generate(&e);
    let token_admin = StellarAssetClient::new(&e, &token);

    e.cost_estimate().budget().reset_unlimited();

    // Alice deposits 1000
    let alice_amount = 1_000_0000000_i128;
    token_admin
        .mock_all_auths()
        .mint(&strategy, &alice_amount);

    let (b1, d1) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        alice_amount,
        config.c_factor,
        config.target_loops,
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
        config.target_loops,
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
        storage::set_strategy_reserves(&e, init.clone());

        let (alice_shares, after_alice) =
            reserves::deposit(&e, &alice, b1, d1, &init).unwrap();
        let (bob_shares, after_bob) =
            reserves::deposit(&e, &bob, b2, d2, &after_alice).unwrap();

        let alice_val = shares_to_underlying(alice_shares, &after_bob).unwrap();
        let bob_val = shares_to_underlying(bob_shares, &after_bob).unwrap();

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
        config.target_loops,
    );

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);

    let hf = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, config.c_factor).unwrap();

    // With 3 loops at c=0.95, HF should be > min_hf (1.05)
    assert!(
        hf > config.min_hf,
        "HF {} should be > min_hf {}",
        hf,
        config.min_hf
    );
    // HF should be reasonable (not astronomical)
    assert!(
        hf < 100 * SCALAR_7,
        "HF {} seems too high",
        hf
    );
}

#[test]
fn test_pool_rates_query() {
    let e = Env::default();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    e.cost_estimate().budget().reset_unlimited();

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(
        b_rate >= SCALAR_12,
        "b_rate should be >= 1.0: {}",
        b_rate
    );
    assert!(
        d_rate >= SCALAR_12,
        "d_rate should be >= 1.0: {}",
        d_rate
    );
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
        let (supply, borrow) = blend_pool::get_pool_utilization(&e, &config);
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
        config.target_loops,
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

// ── Migration helpers ────────────────────────────────────────────────────────

/// Register a BlendLeverageStrategy with constructor args.
fn register_strategy(
    e: &Env,
    pool_addr: &Address,
    token: &Address,
    blnd: &Address,
    config: &storage::Config,
) -> Address {
    let keeper = Address::generate(e);
    let router = Address::generate(e);
    let init_args: Vec<soroban_sdk::Val> = vec![
        e,
        pool_addr.into_val(e),
        blnd.into_val(e),
        router.into_val(e),
        1_0000000_i128.into_val(e),
        keeper.into_val(e),
        config.c_factor.into_val(e),
        config.target_loops.into_val(e),
        config.min_hf.into_val(e),
    ];
    e.register(crate::BlendLeverageStrategy, (token.clone(), init_args))
}

#[test]
fn test_migrate() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let v1 = register_strategy(&e, &pool_addr, &token, &blnd, &config);
    let v2 = register_strategy(&e, &pool_addr, &token, &blnd, &config);

    let user = Address::generate(&e);
    let deposit_amount = 1_000_0000000_i128;
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &deposit_amount);

    e.cost_estimate().budget().reset_unlimited();

    let v1_balance_before: i128 = e.invoke_contract(
        &v1,
        &soroban_sdk::Symbol::new(&e, "deposit"),
        vec![&e, deposit_amount.into_val(&e), user.into_val(&e)],
    );
    assert!(v1_balance_before > 0, "V1 balance should be > 0 after deposit");

    // Snapshot V1 HF before migration
    let v1_hf_before: i128 = e.invoke_contract(
        &v1,
        &soroban_sdk::Symbol::new(&e, "health_factor"),
        vec![&e],
    );
    assert!(v1_hf_before > config.min_hf, "V1 HF should be healthy before migration");

    // Migrate V1 → V2 (single transaction, user signs once)
    e.invoke_contract::<()>(
        &v1,
        &soroban_sdk::Symbol::new(&e, "migrate"),
        vec![&e, user.into_val(&e), v2.into_val(&e)],
    );

    // V1 position is fully burned
    let v1_balance_after: i128 = e.invoke_contract(
        &v1,
        &soroban_sdk::Symbol::new(&e, "balance"),
        vec![&e, user.into_val(&e)],
    );
    assert_eq!(v1_balance_after, 0, "V1 balance should be 0 after migration");

    // V2 has the user's position
    let v2_balance: i128 = e.invoke_contract(
        &v2,
        &soroban_sdk::Symbol::new(&e, "balance"),
        vec![&e, user.into_val(&e)],
    );
    assert!(v2_balance > 0, "V2 balance should be > 0 after migration");

    // Balance is preserved within 2% (unwind + re-leverage rounding)
    let diff = (v1_balance_before - v2_balance).abs();
    assert!(
        diff < deposit_amount / 50,
        "Balance preserved: v1={}, v2={}, diff={}",
        v1_balance_before,
        v2_balance,
        diff
    );

    // V2 HF should be healthy (same c_factor and target_loops)
    let v2_hf: i128 = e.invoke_contract(
        &v2,
        &soroban_sdk::Symbol::new(&e, "health_factor"),
        vec![&e],
    );
    assert!(
        v2_hf > config.min_hf,
        "V2 HF {} should be > min_hf {}",
        v2_hf,
        config.min_hf
    );
}

#[test]
fn test_migrate_with_pool_rate_change() {
    // Verifies that after pool rates change (interest accrual + new borrowers),
    // migration still zeroes out V1 and produces a healthy V2 position.
    //
    // NOTE: This test uses moderate utilization (~33%). High utilization (>75%)
    // causes submit_with_allowance to fail with #1205 because the Blend pool
    // enforces HF after each individual request in the unwind sequence, and the
    // strategy has no pre-funded tokens for the repay step. That is a known
    // limitation shared with the existing closePosition flow (which falls back
    // to a two-step repay+withdraw in the frontend). Migration under extreme
    // utilization requires the same two-step fallback.
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 200_000_0000000);

    let v1 = register_strategy(&e, &pool_addr, &token, &blnd, &config);
    let v2 = register_strategy(&e, &pool_addr, &token, &blnd, &config);
    let user = Address::generate(&e);

    let deposit_amount = 1_000_0000000_i128;
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &deposit_amount);

    e.cost_estimate().budget().reset_unlimited();

    e.invoke_contract::<i128>(
        &v1,
        &soroban_sdk::Symbol::new(&e, "deposit"),
        vec![&e, deposit_amount.into_val(&e), user.into_val(&e)],
    );

    // Simulate time passing: advance ledger so interest accrues
    e.ledger().with_mut(|li| {
        li.sequence_number += 10_000;
        li.timestamp += 86_400; // 1 day
    });

    // A second user borrows to drive up utilization (changes rates without blocking unwind)
    let borrower = Address::generate(&e);
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&borrower, &20_000_0000000);
    pool::Client::new(&e, &pool_addr).mock_all_auths().submit(
        &borrower,
        &borrower,
        &borrower,
        &vec![
            &e,
            pool::Request {
                address: token.clone(),
                amount: 20_000_0000000,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            },
            pool::Request {
                address: token.clone(),
                amount: 10_000_0000000, // ~33% utilization — rates change but unwind stays safe
                request_type: REQUEST_TYPE_BORROW,
            },
        ],
    );

    // Migrate under changed pool conditions
    e.invoke_contract::<()>(
        &v1,
        &soroban_sdk::Symbol::new(&e, "migrate"),
        vec![&e, user.into_val(&e), v2.into_val(&e)],
    );

    let v1_balance_after: i128 = e.invoke_contract(
        &v1,
        &soroban_sdk::Symbol::new(&e, "balance"),
        vec![&e, user.into_val(&e)],
    );
    assert_eq!(v1_balance_after, 0);

    let v2_balance: i128 = e.invoke_contract(
        &v2,
        &soroban_sdk::Symbol::new(&e, "balance"),
        vec![&e, user.into_val(&e)],
    );
    assert!(v2_balance > 0, "V2 should have position after migration under rate change");

    let v2_hf: i128 = e.invoke_contract(
        &v2,
        &soroban_sdk::Symbol::new(&e, "health_factor"),
        vec![&e],
    );
    assert!(
        v2_hf > config.min_hf,
        "V2 HF {} should be > min_hf {} after migration with rate change",
        v2_hf,
        config.min_hf
    );
}

#[test]
fn test_get_version_returns_one() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    let v1 = register_strategy(&e, &pool_addr, &token, &blnd, &config);

    let version: u32 = e.invoke_contract(
        &v1,
        &soroban_sdk::Symbol::new(&e, "get_version"),
        vec![&e],
    );
    assert_eq!(version, 1, "Freshly deployed strategy should report version 1");
}

#[test]
fn test_migrate_requires_user_auth() {
    // migrate() must require the depositor's signature; a different caller
    // must not be able to migrate someone else's position.
    let e = Env::default();
    // Do NOT mock_all_auths — auth is enforced.
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let config = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let v1 = register_strategy(&e, &pool_addr, &token, &blnd, &config);
    let v2 = register_strategy(&e, &pool_addr, &token, &blnd, &config);

    let user = Address::generate(&e);
    let attacker = Address::generate(&e);
    let deposit_amount = 1_000_0000000_i128;

    // Deposit as user (mock only user's auth for deposit)
    e.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &user,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &v1,
            fn_name: "deposit",
            args: soroban_sdk::vec![&e, deposit_amount.into_val(&e), user.into_val(&e)],
            sub_invokes: &[soroban_sdk::testutils::MockAuthInvoke {
                contract: &token,
                fn_name: "transfer",
                args: soroban_sdk::vec![
                    &e,
                    user.into_val(&e),
                    v1.into_val(&e),
                    deposit_amount.into_val(&e)
                ],
                sub_invokes: &[],
            }],
        },
    }]);
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&user, &deposit_amount);
    e.cost_estimate().budget().reset_unlimited();
    let _: i128 = e.invoke_contract(
        &v1,
        &soroban_sdk::Symbol::new(&e, "deposit"),
        vec![&e, deposit_amount.into_val(&e), user.into_val(&e)],
    );

    // Attacker tries to migrate user's position — must panic (auth failure)
    let result = e.try_invoke_contract::<(), StrategyError>(
        &v1,
        &soroban_sdk::Symbol::new(&e, "migrate"),
        vec![&e, user.into_val(&e), v2.into_val(&e)],
    );
    assert!(result.is_err(), "migrate() without user auth must fail");

    // Attacker provides their own auth (for attacker address, not user) — still fails
    e.mock_auths(&[soroban_sdk::testutils::MockAuth {
        address: &attacker,
        invoke: &soroban_sdk::testutils::MockAuthInvoke {
            contract: &v1,
            fn_name: "migrate",
            args: soroban_sdk::vec![&e, user.into_val(&e), v2.into_val(&e)],
            sub_invokes: &[],
        },
    }]);
    let result2 = e.try_invoke_contract::<(), StrategyError>(
        &v1,
        &soroban_sdk::Symbol::new(&e, "migrate"),
        vec![&e, user.into_val(&e), v2.into_val(&e)],
    );
    assert!(result2.is_err(), "migrate() with wrong signer must fail");
}

