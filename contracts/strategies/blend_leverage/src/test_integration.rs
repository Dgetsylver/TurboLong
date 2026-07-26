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
    testutils::{Address as _, BytesN as _, Events as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    vec, Address, BytesN, Env, IntoVal, String, Symbol, Val, Vec,
};

use crate::constants::{
    REQUEST_TYPE_BORROW, REQUEST_TYPE_REPAY, REQUEST_TYPE_SUPPLY_COLLATERAL,
    REQUEST_TYPE_WITHDRAW_COLLATERAL, SCALAR_12, SCALAR_7,
};
use crate::leverage::{
    compute_health_factor, compute_loop_pairs, compute_partial_unwind, shares_to_underlying,
};
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
    register_real_strategy_with_loops(e, pool_addr, asset, blnd, 3)
}

/// Same as `register_real_strategy` but with a configurable `target_loops`.
/// At c = 0.90, 8 loops opens at HF ≈ 1.076 — above min_hf (1.05) so the
/// deposit passes the safety check, but inside the orange zone (< 1.15), which
/// is exactly the stressed fixture the auto-rebalance keeper tests need.
fn register_real_strategy_with_loops(
    e: &Env,
    pool_addr: &Address,
    asset: &Address,
    blnd: &Address,
    target_loops: u32,
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
        9_000_000_i128.into_val(e), // c_factor 0.90
        target_loops.into_val(e),
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
    let (c_factor, target_loops, min_hf, orange_hf) = sclient.config();
    assert_eq!(c_factor, 9_000_000, "c_factor 0.90");
    assert_eq!(target_loops, 3, "target_loops");
    assert_eq!(min_hf, 10_500_000, "min_hf 1.05");
    assert_eq!(orange_hf, 11_500_000, "orange_hf 1.15");
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
    let strategy = register_real_strategy_with_loops(e, pool_addr, token, blnd, 8);
    let sclient = crate::BlendLeverageStrategyClient::new(e, &strategy);
    let share = e.register(MockShareToken, ());
    sclient.set_share_token(&share);

    let user = Address::generate(e);
    StellarAssetClient::new(e, token)
        .mock_all_auths()
        .mint(&user, &1_000_0000000);
    sclient.deposit(&1_000_0000000, &user);
    strategy
}

/// Find the strategy's `("rebalance", caller)` event in the LAST invocation's
/// event stream and decode its `(before_hf, after_hf, loops)` payload.
///
/// NOTE: `e.events().all()` only surfaces the last contract invocation's
/// events, so this must be called immediately after the rebalance entrypoint,
/// before any other contract call.
fn find_rebalance_event(
    e: &Env,
    strategy: &Address,
    caller: &Address,
) -> Option<(i128, i128, u32)> {
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
        return <(i128, i128, u32)>::try_from_val(e, &data).ok();
    }
    None
}

// T2.3 spec: "unwinds N loops to restore target when HF drops below the
// configured threshold; emits events with before/after HF and loops unwound."
// Drives the REAL `rebalance_keeper` entrypoint against a REAL stressed
// position on the REAL Blend pool and asserts every observable in the spec:
// HF restored to >= orange_hf, loops > 0 returned, the `rebalance` event
// emitted with a payload consistent with the on-chain state transition, and
// the rate-limit timestamp recorded.
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

    let loops = sclient.rebalance_keeper(&keeper);
    assert!(loops >= 1, "stressed position must unwind loops");

    // The `rebalance` event carries (before_hf, after_hf, loops). Captured
    // FIRST: the test env only keeps the last invocation's events.
    let (ev_before, ev_after, ev_loops) = find_rebalance_event(&e, &strategy, &keeper)
        .expect("rebalance event must be emitted on every rebalance");

    // HF restored to at least the configured target.
    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= orange_hf,
        "HF must be restored: after={}, target={}",
        after_hf,
        orange_hf
    );

    assert_eq!(ev_before, before_hf, "event before_hf matches pre-state");
    assert_eq!(ev_loops, loops, "event loops matches return value");
    assert!(
        ev_after >= orange_hf,
        "event after_hf must be at/above target: {}",
        ev_after
    );
    assert_eq!(ev_after, after_hf, "event after_hf matches post-state");

    // The rate-limit timestamp was recorded (a real rebalance consumes it).
    let last = e.as_contract(&strategy, || storage::get_last_rebalance(&e));
    assert_eq!(
        last,
        Some(e.ledger().sequence()),
        "LastRebalance must be set after a real unwind"
    );

    std::println!(
        "keeper rebalance: hf {} -> {} (target {}), loops={}",
        before_hf,
        after_hf,
        orange_hf,
        loops
    );
}

// T2.3 spec: "rate-limited". On-chain proof of the 60-ledger cooldown: after a
// real (loops > 0) keeper rebalance, an immediate second call is rejected; once
// REBALANCE_COOLDOWN_LEDGERS have elapsed the keeper may call again (a safe
// no-op here since HF is already restored). The permissionless `rebalance`
// stays available inside the cooldown window (anyone can always protect the
// vault).
#[test]
fn test_rebalance_keeper_cooldown_rate_limits_on_chain() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    // First keeper rebalance does real work and arms the cooldown.
    let loops = sclient.rebalance_keeper(&keeper);
    assert!(loops >= 1, "first call must unwind");

    // Second call inside the cooldown window is rejected — even for the keeper.
    assert!(
        sclient.try_rebalance_keeper(&keeper).is_err(),
        "keeper must be rate-limited inside the cooldown window"
    );

    // One ledger short of expiry: still rejected.
    e.ledger().with_mut(|li| {
        li.sequence_number += crate::constants::REBALANCE_COOLDOWN_LEDGERS - 1;
    });
    assert!(
        sclient.try_rebalance_keeper(&keeper).is_err(),
        "cooldown must hold until the full window has elapsed"
    );

    // The permissionless safety valve is NOT rate-limited.
    sclient.rebalance();

    // At exactly cooldown expiry the keeper may call again (no-op: HF restored).
    e.ledger().with_mut(|li| {
        li.sequence_number += 1;
    });
    assert_eq!(
        sclient.rebalance_keeper(&keeper),
        0,
        "post-cooldown call succeeds (no-op, HF already at target)"
    );
}

// T2.3 spec edge case: "already at floor". A healthy position (HF >= orange_hf,
// debt outstanding) must be a clean no-op: zero loops unwound, no `rebalance`
// event, and — critically — the cooldown NOT consumed, so the keeper is never
// locked out of a real rebalance by an earlier no-op probe.
#[test]
fn test_rebalance_keeper_already_at_floor_noop_does_not_consume_cooldown() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    // 3 loops at c = 0.90 opens at HF ≈ 1.27 — debt outstanding, above orange.
    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = e.register(MockShareToken, ());
    sclient.set_share_token(&share);
    let user = Address::generate(&e);
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

    // No-op: zero loops, no event, position untouched.
    assert_eq!(sclient.rebalance_keeper(&keeper), 0, "at floor → no-op");
    assert!(
        find_rebalance_event(&e, &strategy, &keeper).is_none(),
        "no event on a no-op"
    );
    assert_eq!(sclient.health_factor(), hf, "position untouched");

    // The no-op must not consume the cooldown: an immediate second keeper call
    // is still allowed (also a no-op), and LastRebalance stays unset.
    let last = e.as_contract(&strategy, || storage::get_last_rebalance(&e));
    assert_eq!(last, None, "no-op must not arm the cooldown");
    assert_eq!(
        sclient.rebalance_keeper(&keeper),
        0,
        "immediate retry allowed after a no-op"
    );
}

// T2.3 spec edge case: "locked reserves". When pool utilization exceeds
// MAX_SAFE_UTILIZATION (0.95) the deposit path is deliberately locked
// (#[Error #422]) — but liquidation protection must NOT be: the keeper's
// rebalance still unwinds and restores HF. Deleveraging (withdraw == repay per
// layer) reduces utilization, so it is safe at any utilization; this test pins
// that property on the real pool with genuinely accrued rates.
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
    // rate), dragging utilization past MAX_SAFE_UTILIZATION. Accrue in 30-day
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
            e.as_contract(&strategy, || blend_pool::get_pool_utilization(&e, &config));
        util = pool_borrow * SCALAR_7 / pool_supply;
        if util > crate::constants::MAX_SAFE_UTILIZATION {
            break;
        }
    }

    // Precondition: reserves are "locked" for depositors.
    assert!(
        util > crate::constants::MAX_SAFE_UTILIZATION,
        "fixture must exceed MAX_SAFE_UTILIZATION: util={}",
        util
    );
    let depositor = Address::generate(&e);
    token_admin.mock_all_auths().mint(&depositor, &100_0000000);
    assert!(
        sclient.try_deposit(&100_0000000, &depositor).is_err(),
        "deposits must be locked above MAX_SAFE_UTILIZATION"
    );

    // The keeper's protection path must still work.
    let (_, _, _, orange_hf) = sclient.config();
    let before_hf = sclient.health_factor();
    assert!(
        before_hf < orange_hf,
        "accrued rates must have dragged HF into the orange zone: {}",
        before_hf
    );

    let loops = sclient.rebalance_keeper(&keeper);
    assert!(
        loops >= 1,
        "rebalance must unwind even with locked reserves"
    );
    // Event captured first: the test env only keeps the last invocation's events.
    let (ev_before, ev_after, ev_loops) =
        find_rebalance_event(&e, &strategy, &keeper).expect("rebalance event must be emitted");
    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= orange_hf,
        "HF must be restored despite locked reserves: {} < {}",
        after_hf,
        orange_hf
    );
    assert_eq!((ev_before, ev_loops), (before_hf, loops));
    assert_eq!(ev_after, after_hf);

    std::println!(
        "locked-reserves rebalance: util={} hf {} -> {} loops={}",
        util,
        before_hf,
        after_hf,
        loops
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
    let (b_tokens, d_tokens) = execute_leverage_loop_stepped(
        &e,
        &pool_addr,
        &strategy,
        &token,
        deposit,
        config.c_factor,
        config.target_loops,
    );

    // Seed reserves to match (1 share == 1 underlying at entry, rates 1.0).
    e.as_contract(&strategy, || {
        storage::set_strategy_reserves(
            &e,
            LeverageReserves {
                total_shares: deposit,
                total_b_tokens: b_tokens,
                total_d_tokens: d_tokens,
                b_rate: SCALAR_12,
                d_rate: SCALAR_12,
            },
        );
    });

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
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);
        let equity = crate::leverage::compute_equity(&reserves).unwrap();
        let requested = equity / 4;
        let (_burned, b_rm, d_rm, _updated) =
            reserves::withdraw(&e, reserves.total_shares, requested, &reserves).unwrap();
        (requested, b_rm, d_rm)
    });

    let user_before = token_client.balance(&user);

    // Run the REAL production unwind against the REAL pool.
    e.as_contract(&strategy, || {
        blend_pool::submit_unwind(&e, b_to_remove, d_to_remove, &user, &config).unwrap();
    });

    let received = token_client.balance(&user) - user_before;

    std::println!(
        "b_rate={} d_rate={} | requested(owed)={} received={} (b_rm={}, d_rm={})",
        b_rate,
        d_rate,
        requested,
        received,
        b_to_remove,
        d_to_remove
    );

    // The user must receive the equity they actually own — no more, no less.
    // Allow 1% tolerance for pool/loop rounding. FAILS today because the unwind
    // pays out ~ (b_to_remove - d_to_remove) of underlying, materially above the
    // owed equity once rates have accrued.
    let tolerance = requested / 100;
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
        config.target_loops,
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

    // User gets their full equity (1% tolerance for pool/loop rounding).
    assert!(
        (received - owed).abs() <= owed / 100,
        "full close should return all equity ~{}, got {}",
        owed,
        received
    );
    // No material collateral left stranded (≤ 0.5% of the original collateral).
    assert!(
        end_b <= b_tokens / 200,
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
// and preserve equity (each layer withdraws == repays the same underlying).
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
        config.target_loops,
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

    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pre_b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre.liabilities.get(config.reserve_id).unwrap_or(0);
    let pre_equity = pre_b * b_rate / SCALAR_12 - pre_d * d_rate / SCALAR_12;
    let pre_hf = compute_health_factor(pre_b, pre_d, b_rate, d_rate, config.c_factor).unwrap();

    // Unwind 2 loops through the REAL production deleverage path.
    let (b_removed, d_removed) = e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, 2, &config).unwrap()
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let post_b = post.collateral.get(config.reserve_id).unwrap_or(0);
    let post_d = post.liabilities.get(config.reserve_id).unwrap_or(0);
    let post_equity = post_b * b_rate / SCALAR_12 - post_d * d_rate / SCALAR_12;
    let post_hf = compute_health_factor(post_b, post_d, b_rate, d_rate, config.c_factor).unwrap();

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

    // Equity is preserved (each layer withdraws == repays the same underlying);
    // allow 1% for pool/loop rounding.
    assert!(
        (post_equity - pre_equity).abs() <= pre_equity / 100,
        "equity must be preserved: pre={}, post={}",
        pre_equity,
        post_equity
    );
}

// A single-loop deleverage must be a PARTIAL unwind, not a full close. With the
// broken layer sizing, one "layer" exceeds the whole debt, so a 1-loop unwind
// either reverts or repays the entire position — defeating partial protection.
#[test]
fn test_deleverage_one_loop_is_partial_not_full_close() {
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
        config.target_loops,
    );

    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pre_d = pre.liabilities.get(config.reserve_id).unwrap_or(0);

    // Unwind exactly ONE loop through the real production path.
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, 1, &config).unwrap();
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let post_d = post.liabilities.get(config.reserve_id).unwrap_or(0);

    std::println!("pre_d={} post_d={}", pre_d, post_d);

    // A single-loop unwind should clear only one layer (~debt × (1-c) ≈ 10%),
    // so the bulk of the debt must remain. FAILS today: the oversized layer
    // wipes (or over-shoots) the whole debt.
    assert!(
        post_d > 0,
        "1-loop unwind should not fully close the position"
    );
    assert!(
        post_d >= pre_d / 2,
        "1-loop unwind must be partial: pre_d={}, post_d={} (over-unwound)",
        pre_d,
        post_d
    );
}

// End-to-end protection round-trip (mirrors lib.rs::unwind_to): a position that
// sits in the orange zone (HF < orange_hf) must be restored to >= orange_hf by
// `compute_partial_unwind` → `submit_deleverage`. This proves the two pieces are
// consistent: the loop count derived from the closed form actually achieves the
// target HF on the real pool.
#[test]
fn test_rebalance_round_trip_restores_hf_to_target() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let mut config = make_config(&e, &pool_addr, &token, &blnd);
    // High leverage so the freshly-built position starts inside the orange zone.
    config.target_loops = 8;

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
        config.target_loops,
    );

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let d = pre.liabilities.get(config.reserve_id).unwrap_or(0);

    let target = config.orange_hf;
    let before_hf = compute_health_factor(b, d, b_rate, d_rate, config.c_factor).unwrap();
    assert!(
        before_hf < target,
        "fixture must start in the orange zone: before_hf={}, target={}",
        before_hf,
        target
    );

    // Production logic: derive the loop count needed to restore HF to target.
    let (_, loops) = compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, target).unwrap();
    assert!(loops >= 1, "should need at least one unwind loop");

    // Execute the real deleverage on the real pool.
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, loops, &config).unwrap();
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b2 = post.collateral.get(config.reserve_id).unwrap_or(0);
    let d2 = post.liabilities.get(config.reserve_id).unwrap_or(0);
    let after_hf = compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor).unwrap();

    std::println!(
        "before_hf={} after_hf={} target={} loops={}",
        before_hf,
        after_hf,
        target,
        loops
    );

    // HF restored to at least the target …
    assert!(
        after_hf >= target,
        "HF must be restored to >= target: after_hf={}, target={}",
        after_hf,
        target
    );
    // … without grossly over-unwinding (ceil rounding adds at most ~one layer).
    assert!(
        after_hf <= target + target * 30 / 100,
        "over-unwound: after_hf={}, target={}",
        after_hf,
        target
    );
}

// T2.2 acceptance — dry-run ↔ on-chain parity within rounding.
//
// The dry-run prediction is the exact model the off-chain harness
// (scripts/rebalance_sim.ts) uses: `compute_partial_unwind` for (repay, loops),
// then the layered execution `submit_deleverage` performs (loops layers of
// debt × (1 - c_factor) underlying, capped at the outstanding debt). This test
// executes the real deleverage on the real Blend pool AFTER a year of interest
// accrual (so b_rate/d_rate ≠ 1 and every underlying↔token conversion rounds)
// and asserts the executed position matches the prediction to within a few
// stroops per layer.
#[test]
fn test_partial_unwind_dry_run_matches_onchain_within_rounding() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let mut config = make_config(&e, &pool_addr, &token, &blnd);
    // High leverage so the position sits inside the orange zone.
    config.target_loops = 8;

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
        config.target_loops,
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

    let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest must accrue");

    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let d = pre.liabilities.get(config.reserve_id).unwrap_or(0);

    let target = config.orange_hf;
    let before_hf = compute_health_factor(b, d, b_rate, d_rate, config.c_factor).unwrap();
    assert!(
        before_hf < target,
        "fixture must start in the orange zone: before_hf={}",
        before_hf
    );

    // ── Dry-run prediction (same model as scripts/rebalance_sim.ts) ──────────
    let (_, loops) = compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, target).unwrap();
    assert!(loops >= 1);

    // Layered execution model (mirrors blend_pool::submit_deleverage).
    let debt_underlying = d * d_rate / SCALAR_12;
    let supply_underlying = b * b_rate / SCALAR_12;
    let layer = debt_underlying * (SCALAR_7 - config.c_factor) / SCALAR_7;
    let mut total_repay = 0_i128;
    let mut remaining = debt_underlying;
    for _ in 0..loops {
        let amount = layer.min(remaining);
        if amount <= 0 {
            break;
        }
        total_repay += amount;
        remaining -= amount;
    }
    let pred_supply = supply_underlying - total_repay;
    let pred_debt = debt_underlying - total_repay;
    let pred_hf = pred_supply * config.c_factor / pred_debt;

    // ── Execute the real deleverage on the real pool ──────────────────────────
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, loops, &config).unwrap();
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b2 = post.collateral.get(config.reserve_id).unwrap_or(0);
    let d2 = post.liabilities.get(config.reserve_id).unwrap_or(0);
    let actual_supply = b2 * b_rate / SCALAR_12;
    let actual_debt = d2 * d_rate / SCALAR_12;
    let after_hf = compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor).unwrap();

    std::println!(
        "loops={} pred_supply={} actual_supply={} pred_debt={} actual_debt={} pred_hf={} after_hf={}",
        loops,
        pred_supply,
        actual_supply,
        pred_debt,
        actual_debt,
        pred_hf,
        after_hf
    );

    // Every underlying↔token conversion rounds by ≤1 stroop, twice per layer.
    let tol = (loops as i128) * 3 + 5;
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
    // HF parity: a few-stroop position drift moves the 1e7-scale HF by <<1e-4.
    assert!(
        (after_hf - pred_hf).abs() <= 1_000,
        "HF diverges beyond rounding: pred={}, actual={}",
        pred_hf,
        after_hf
    );
    assert!(after_hf >= target, "restored: {} >= {}", after_hf, target);
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

// ── Finding ①: withdraw must keep stored reserves in sync with the pool ───────
//
// The strategy keeps TWO ledgers of the same position:
//   A) stored `LeverageReserves.total_b/d_tokens`  — values shares (deposit /
//      withdraw / balance / position)
//   B) the real `pool.get_positions(strategy)`     — drives HF / rebalance
//
// `deposit`, `harvest` and `deleverage` all update A from the *measured* pool
// delta, so A == B by construction. `withdraw` used to be the lone exception: it
// subtracted the *intended* `b_to_remove`/`d_to_remove` (proportional token
// counts) and DISCARDED the actual amounts `submit_unwind` removed, so A drifted
// away from B and never reconciled. The fix routes the withdraw through
// `reserves::commit_withdraw`, persisting the *measured* (b_removed, d_removed)
// just like the other three paths.
//
// End-to-end guard for Finding ①, driven through the REAL `deposit`/`withdraw`
// contract entrypoints (not the internal helpers). This is the test that
// actually protects the production code path: it FAILS if lib.rs::withdraw is
// reverted to subtract the intended deltas instead of committing the measured
// ones. Uses the real strategy + real Blend pool + a mock share token.
#[test]
fn test_real_withdraw_entrypoint_keeps_reserves_in_sync() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Wire the share token (the strategy is its minter).
    let share = e.register(MockShareToken, ());
    sclient.set_share_token(&share);

    // Fund a user and deposit through the REAL entrypoint (runs the real
    // submit_leverage_loop + reserves::deposit reconciliation).
    let user = Address::generate(&e);
    let token_admin = StellarAssetClient::new(&e, &token);
    let deposit = 1_000_0000000_i128;
    token_admin.mint(&user, &deposit);
    e.cost_estimate().budget().reset_unlimited();

    sclient.deposit(&deposit, &user);

    // Post-deposit, stored reserves should already equal pool positions.
    let after_dep = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let dep_b = after_dep.collateral.get(cfg.reserve_id).unwrap_or(0);
    let dep_d = after_dep.liabilities.get(cfg.reserve_id).unwrap_or(0);
    let stored_dep = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));
    assert_eq!(stored_dep.total_b_tokens, dep_b, "post-deposit b in sync");
    assert_eq!(stored_dep.total_d_tokens, dep_d, "post-deposit d in sync");

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
    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pool_b = post.collateral.get(cfg.reserve_id).unwrap_or(0);
    let pool_d = post.liabilities.get(cfg.reserve_id).unwrap_or(0);
    let stored = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));

    std::println!(
        "e2e post-withdraw: stored_b={} pool_b={} (diff={}) | stored_d={} pool_d={} (diff={})",
        stored.total_b_tokens,
        pool_b,
        stored.total_b_tokens - pool_b,
        stored.total_d_tokens,
        pool_d,
        stored.total_d_tokens - pool_d,
    );

    assert_eq!(
        stored.total_b_tokens, pool_b,
        "post-withdraw b out of sync with pool"
    );
    assert_eq!(
        stored.total_d_tokens, pool_d,
        "post-withdraw d out of sync with pool"
    );
}

// Full-close sibling of the e2e guard: a user withdrawing their ENTIRE balance
// drives the near-full unwind (large repay + the `i64::MAX` dust sweep) and the
// `commit_withdraw` `saturating_sub`. Asserts the stored==pool invariant still
// holds, the user is paid ~their full balance, and only the inflation lockup is
// left behind.
#[test]
fn test_real_full_withdraw_entrypoint_keeps_reserves_in_sync() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let share = e.register(MockShareToken, ());
    sclient.set_share_token(&share);
    let shclient = MockShareTokenClient::new(&e, &share);

    let user = Address::generate(&e);
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

    // Invariant still holds across the near-full unwind (saturating_sub path).
    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pool_b = post.collateral.get(cfg.reserve_id).unwrap_or(0);
    let pool_d = post.liabilities.get(cfg.reserve_id).unwrap_or(0);
    let stored = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));

    std::println!(
        "full-close e2e: received={} (bal={}) | stored_b={} pool_b={} | stored_d={} pool_d={} | total_shares={} user_shares_left={}",
        received,
        bal,
        stored.total_b_tokens,
        pool_b,
        stored.total_d_tokens,
        pool_d,
        stored.total_shares,
        shclient.balance(&user),
    );

    assert_eq!(
        stored.total_b_tokens, pool_b,
        "full-close: stored b out of sync with pool"
    );
    assert_eq!(
        stored.total_d_tokens, pool_d,
        "full-close: stored d out of sync with pool"
    );

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
        (stored.total_shares - crate::constants::FIRST_DEPOSIT_LOCKUP).abs() <= 1_000,
        "only the lockup should remain, total_shares={}",
        stored.total_shares
    );
}

// ── D2: a transferred receipt token carries the underlying claim ──────────────
//
// The vault-share token is a standard SEP-41 — holding it *is* holding the
// position. This drives the full chain through the REAL token contract (not the
// MockShareToken): real SEP-41 `transfer` semantics + real strategy + real
// Blend pool. Alice deposits, transfers her entire share balance to Bob, then
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
    // the public strategy entrypoints rather than stored reserves directly.
    let _cfg = make_config(&e, &pool_addr, &token, &blnd);

    seed_pool_liquidity(&e, &pool_addr, &token, 1_000_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // Wire the REAL SEP-41 share token, with the strategy as its sole minter.
    let share = e.register(
        vault_share_token::VaultShareToken,
        (
            Address::generate(&e), // admin
            strategy.clone(),      // minter = the strategy
            7u32,
            String::from_str(&e, "BlendLeverage USDC Share"),
            String::from_str(&e, "blvUSDC"),
        ),
    );
    sclient.set_share_token(&share);
    let shclient = vault_share_token::VaultShareTokenClient::new(&e, &share);

    // Alice deposits through the real entrypoint (mints her shares on the token).
    let alice = Address::generate(&e);
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
    let stored = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));
    assert_eq!(
        shclient.total_supply(),
        stored.total_shares,
        "token supply must stay equal to strategy total_shares"
    );
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
// is read host-side from the *preserved* persistent storage and recomputed with
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

    // Real SEP-41 share token, with the strategy as its sole minter.
    let share = e.register(
        vault_share_token::VaultShareToken,
        (
            Address::generate(&e), // admin
            strategy.clone(),      // minter = the strategy
            7u32,
            String::from_str(&e, "BlendLeverage USDC Share"),
            String::from_str(&e, "blvUSDC"),
        ),
    );
    sclient.set_share_token(&share);
    let shclient = vault_share_token::VaultShareTokenClient::new(&e, &share);

    // Real leveraged deposit -> live pool position.
    let user = Address::generate(&e);
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
    let (equity_before, _shares_before, _b_before, d_before, b_rate_before, d_rate_before) =
        sclient.position();
    let hf_before = sclient.health_factor();
    let user_underlying_before = sclient.balance(&user);
    let version_before = sclient.version();
    let user_shares = shclient.balance(&user);
    let stored_before = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));

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
    // persistent storage and unchanged pool state.
    let version_after = e.as_contract(&strategy, || storage::get_version(&e));
    let stored_after = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));
    let (equity_after, hf_after, user_underlying_after) = e.as_contract(&strategy, || {
        let config = storage::get_config(&e);
        let r = reserves::get_strategy_reserves_updated(&e, &config);
        let equity = crate::leverage::compute_equity(&r).unwrap();
        let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
        let (b_tokens, d_tokens) = blend_pool::get_strategy_positions(&e, &config);
        let hf =
            compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, config.c_factor).unwrap();
        let underlying = shares_to_underlying(user_shares, &r).unwrap();
        (equity, hf, underlying)
    });

    // Version bumped by exactly 1; all persisted reserves byte-identical.
    assert_eq!(
        version_after,
        version_before + 1,
        "version must bump on upgrade"
    );
    assert_eq!(
        stored_after.total_shares, stored_before.total_shares,
        "total_shares preserved across upgrade"
    );
    assert_eq!(
        stored_after.total_b_tokens, stored_before.total_b_tokens,
        "b-tokens preserved across upgrade"
    );
    assert_eq!(
        stored_after.total_d_tokens, stored_before.total_d_tokens,
        "d-tokens preserved across upgrade"
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
