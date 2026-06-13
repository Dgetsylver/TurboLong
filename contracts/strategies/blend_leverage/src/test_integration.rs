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
    testutils::{Address as _, BytesN as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal, String, Val, Vec,
};

use crate::constants::{
    REQUEST_TYPE_BORROW, REQUEST_TYPE_REPAY, REQUEST_TYPE_SUPPLY_COLLATERAL,
    REQUEST_TYPE_WITHDRAW_COLLATERAL, SCALAR_12, SCALAR_7,
};
use crate::leverage::{compute_health_factor, compute_loop_pairs, shares_to_underlying};
use crate::storage::LeverageReserves;
use crate::{blend_pool, reserves, storage};

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
        &1_000_000,
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

        let (vault_minted, _lockup, updated) =
            reserves::deposit(&e, b_tokens, d_tokens, &init_reserves).unwrap();

        assert!(vault_minted > 0, "Should have shares");

        let balance = shares_to_underlying(vault_minted, &updated).unwrap();
        assert!(
            balance > deposit_amount * 95 / 100,
            "Balance {} should be close to deposit {}",
            balance,
            deposit_amount
        );

        // === WITHDRAW === (user_shares read from the token in production)
        let (burned, b_remove, d_remove, _) =
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

        let (alice_shares, _, after_alice) = reserves::deposit(&e, b1, d1, &init).unwrap();
        let (bob_shares, _, after_bob) = reserves::deposit(&e, b2, d2, &after_alice).unwrap();

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

// ── Share-token wiring (D2 integration) ──────────────────────────────────────

#[contracttype]
enum MockKey {
    Bal(Address),
    Supply,
}

/// Minimal stand-in for the SEP-41 vault-share token, used to verify the
/// strategy's cross-contract mint/burn/balance calls. The real token is tested
/// in its own crate (contracts/tokens/vault_share).
#[contract]
pub struct MockShareToken;

#[contractimpl]
impl MockShareToken {
    pub fn mint(e: Env, to: Address, amount: i128) {
        let b: i128 = e
            .storage()
            .persistent()
            .get(&MockKey::Bal(to.clone()))
            .unwrap_or(0);
        e.storage()
            .persistent()
            .set(&MockKey::Bal(to), &(b + amount));
        let s: i128 = e.storage().instance().get(&MockKey::Supply).unwrap_or(0);
        e.storage().instance().set(&MockKey::Supply, &(s + amount));
    }

    pub fn burn_by_minter(e: Env, from: Address, amount: i128) {
        let b: i128 = e
            .storage()
            .persistent()
            .get(&MockKey::Bal(from.clone()))
            .unwrap_or(0);
        e.storage()
            .persistent()
            .set(&MockKey::Bal(from), &(b - amount));
        let s: i128 = e.storage().instance().get(&MockKey::Supply).unwrap_or(0);
        e.storage().instance().set(&MockKey::Supply, &(s - amount));
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage().persistent().get(&MockKey::Bal(id)).unwrap_or(0)
    }

    pub fn total_supply(e: Env) -> i128 {
        e.storage().instance().get(&MockKey::Supply).unwrap_or(0)
    }
}

/// Register the real strategy via its constructor against the Blend fixture.
fn register_real_strategy(
    e: &Env,
    pool_addr: &Address,
    asset: &Address,
    blnd: &Address,
) -> Address {
    let router = Address::generate(e);
    let keeper = Address::generate(e);
    let admin = Address::generate(e);
    let init_args: Vec<Val> = vec![
        e,
        pool_addr.into_val(e),
        blnd.into_val(e),
        router.into_val(e),
        1_0000000_i128.into_val(e), // reward_threshold
        keeper.into_val(e),
        9_000_000_i128.into_val(e),  // c_factor 0.90
        3u32.into_val(e),            // target_loops
        10_500_000_i128.into_val(e), // min_hf 1.05
        11_500_000_i128.into_val(e), // orange_hf 1.15
        admin.into_val(e),
    ];
    e.register(crate::BlendLeverageStrategy, (asset.clone(), init_args))
}

#[test]
fn test_share_token_wiring_set_migrate_balance() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let mock_token = e.register(MockShareToken, ());

    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // set_share_token + getter.
    sclient.set_share_token(&mock_token);
    assert_eq!(sclient.share_token(), mock_token);

    // Seed a legacy VaultPos holder + reserves, then migrate onto the token.
    let holder = Address::generate(&e);
    e.as_contract(&strategy, || {
        storage::set_vault_shares(&e, &holder, 500_0000000);
        storage::set_strategy_reserves(
            &e,
            LeverageReserves {
                total_shares: 1_000_0000000,
                total_b_tokens: 8_000_0000000,
                total_d_tokens: 7_000_0000000,
                b_rate: SCALAR_12,
                d_rate: SCALAR_12,
            },
        );
    });

    let migrated = sclient.migrate_position(&holder);
    assert_eq!(migrated, 500_0000000, "migrated legacy shares");

    // Token now holds the holder's shares; legacy entry zeroed.
    let mock = MockShareTokenClient::new(&e, &mock_token);
    assert_eq!(mock.balance(&holder), 500_0000000, "token credited");
    e.as_contract(&strategy, || {
        assert_eq!(storage::get_vault_shares(&e, &holder), 0, "legacy zeroed");
    });

    // migrate is idempotent (no double-mint).
    assert_eq!(sclient.migrate_position(&holder), 0);
    assert_eq!(mock.balance(&holder), 500_0000000);

    // balance() reads shares from the token and converts to underlying.
    let bal = sclient.balance(&holder);
    assert!(bal > 0, "balance via token should be positive, got {}", bal);
}

// ── Auto-rebalance keeper auth & rate-limit (T2.3) ────────────────────────────

#[test]
fn test_rebalance_keeper_auth_gating_and_noop() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();
    let stranger = Address::generate(&e);

    // A non-keeper caller is rejected (caller != keeper).
    assert!(
        sclient.try_rebalance_keeper(&stranger).is_err(),
        "non-keeper must be rejected"
    );

    // The keeper may call; with no open position (no debt) it is a no-op.
    assert_eq!(sclient.rebalance_keeper(&keeper), 0, "no debt → no-op");

    // The permissionless rebalance is also a safe no-op with no position.
    sclient.rebalance();
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
    assert!(sclient.try_swap_account().is_err());

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
        sclient.try_harvest_claim(&stranger).is_err(),
        "harvest_claim: non-keeper rejected"
    );
    assert!(
        sclient
            .try_harvest_reinvest(&stranger, &1_000, &true, &900)
            .is_err(),
        "harvest_reinvest: non-keeper rejected"
    );
}

#[test]
fn test_harvest_reinvest_soroswap_requires_min_out() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    // via_soroswap with amount_out_min = 0 must be rejected (mandatory slippage).
    assert!(
        sclient
            .try_harvest_reinvest(&keeper, &1_000, &true, &0)
            .is_err(),
        "soroswap path requires non-zero amount_out_min"
    );
}
