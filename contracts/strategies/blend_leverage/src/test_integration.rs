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

    let (b_rate, d_rate, l_factor) = blend_pool::get_rates_and_l_factor(&e, &config);

    let hf = compute_health_factor(
        b_tokens,
        d_tokens,
        b_rate,
        d_rate,
        config.c_factor,
        l_factor,
    )
    .unwrap();

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
    let cfg = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);

    let strategy = register_real_strategy(&e, &pool_addr, &token, &blnd);
    let mock_token = e.register(MockShareToken, ());

    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // set_share_token + getter.
    sclient.set_share_token(&mock_token);
    assert_eq!(sclient.share_token(), mock_token);

    // Open a REAL pool position for the strategy before seeding the legacy
    // accounting. The tracked totals are reconciled against the pool on every
    // read, so a fabricated position would now price at zero equity — the seeded
    // ledger has to describe a position that actually exists.
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
        cfg.c_factor,
        cfg.target_loops,
    );

    // Seed a legacy VaultPos holder + reserves, then migrate onto the token.
    let holder = Address::generate(&e);
    e.as_contract(&strategy, || {
        storage::set_vault_shares(&e, &holder, 500_0000000);
        storage::set_strategy_reserves(
            &e,
            LeverageReserves {
                total_shares: 1_000_0000000,
                total_b_tokens: b_tokens,
                total_d_tokens: d_tokens,
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

// ── partial_unwind target bounding (audit M-1) ───────────────────────────────

// Regression for M-1: inside the orange zone `partial_unwind` is unauthenticated,
// and it used to pass the caller's `target_hf` straight through (floored, never
// capped). Any address could pass an arbitrarily large target and drive
// `compute_partial_unwind` to a full repay — 20 layers, the whole debt retired,
// the vault's yield destroyed for a transaction fee. A permissionless caller must
// now get exactly what `rebalance()` gives: HF restored to orange_hf, no further.
#[test]
fn test_partial_unwind_ignores_target_from_permissionless_caller() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let (_, _, _, orange_hf) = sclient.config();

    let before_hf = sclient.health_factor();
    let (_, _, _, d_before, _, _) = sclient.position();
    assert!(
        before_hf < orange_hf,
        "fixture must open inside the orange zone so the caller needs no keeper role"
    );

    // A stranger asking for HF 100 — far above anything the vault is configured
    // to hold, and enough to clamp the closed form to a full repay.
    let stranger = Address::generate(&e);
    let loops = sclient.partial_unwind(&stranger, &100_0000000);
    assert!(
        loops >= 1,
        "the permissionless branch must still do its job"
    );

    let (_, _, _, d_after, _, _) = sclient.position();
    let after_hf = sclient.health_factor();

    // The finding: debt fully retired, HF at i128::MAX. The fix: debt survives.
    assert!(
        d_after > 0,
        "M-1: a stranger must not be able to force a full deleverage (d_tokens {} -> {})",
        d_before,
        d_after
    );
    assert!(d_after < d_before, "the unwind must still reduce debt");
    assert!(
        after_hf >= orange_hf,
        "HF must be restored to the floor: after={}, orange={}",
        after_hf,
        orange_hf
    );

    // "No more powerful than rebalance()": the position is now where the
    // permissionless rebalance would leave it, so rebalance is a no-op — and the
    // stranger cannot come back for a second bite, because HF is out of the orange
    // zone and the keeper gate now applies.
    sclient.rebalance();
    assert_eq!(
        sclient.health_factor(),
        after_hf,
        "rebalance has nothing left to do"
    );
    assert!(
        sclient.try_partial_unwind(&stranger, &100_0000000).is_err(),
        "with HF restored the stranger is back outside the permissionless window"
    );
    assert_eq!(
        sclient.health_factor(),
        after_hf,
        "position untouched by the retry"
    );
}

// The other half of the M-1 fix: capping the target must not disarm the keeper.
// The keeper is a trusted role and still gets the `target_hf` it asks for, so it
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

    // A target comfortably above the orange floor (1.15) — reachable by unwinding
    // more layers than a permissionless caller would be allowed to.
    let target = orange_hf + 2_000_000;
    let loops = sclient.partial_unwind(&keeper, &target);
    assert!(loops >= 1, "keeper unwind must do work");

    let after_hf = sclient.health_factor();
    assert!(
        after_hf >= target,
        "keeper target must be honoured: after={}, target={}",
        after_hf,
        target
    );
}

// Unchanged by the M-1 fix, pinned so the auth gate is not lost while the target
// bounding moves around it: above the orange zone the entrypoint is keeper-only.
#[test]
fn test_partial_unwind_rejects_non_keeper_above_orange_zone() {
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

    let (_, _, _, orange_hf) = sclient.config();
    assert!(
        sclient.health_factor() >= orange_hf,
        "fixture must sit above the orange floor"
    );

    let stranger = Address::generate(&e);
    assert!(
        sclient.try_partial_unwind(&stranger, &orange_hf).is_err(),
        "outside the orange zone partial_unwind is keeper-only"
    );
}

// ── releverage (audit M-3) ───────────────────────────────────────────────────

// Opens a REAL healthy position through the production `deposit` entrypoint:
// 3 loops at c = 0.90 lands at HF ≈ 1.269 — the design HF for that loop count,
// comfortably above the orange floor (1.15). Returns the strategy address.
fn open_healthy_strategy(e: &Env, pool_addr: &Address, token: &Address, blnd: &Address) -> Address {
    let strategy = register_real_strategy(e, pool_addr, token, blnd);
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

    let (c_factor, target_loops, _, _) = sclient.config();
    let (_, _, l_factor) = sclient.risk_factors();
    let design_hf =
        crate::leverage::design_health_factor(c_factor, target_loops, l_factor).unwrap();

    let (_equity0, _, _, d0, _, _) = sclient.position();
    let hf0 = sclient.health_factor();
    assert!(
        hf0 <= design_hf + design_hf / 1_000,
        "a fresh deposit opens at the design HF: {} vs {}",
        hf0,
        design_hf
    );

    // Emergency: the keeper deleverages far past the orange floor.
    let loops = sclient.partial_unwind(&keeper, &(design_hf + 4_000_000));
    assert!(loops >= 1, "emergency unwind must do work");

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

    let borrowed = sclient.releverage(&keeper);
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
    // have built — the HF cap and the loop geometry agree.
    let (design_supply, design_borrow) =
        crate::leverage::compute_totals(1_000_000_000_000_i128, c_factor, target_loops);
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

// The hysteresis band, on-chain. On a deployment whose design leverage sits
// *inside* the rebalance band (8 loops at c = 0.90 → design HF ≈ 1.076, below
// orange_hf 1.15), re-levering all the way to design would hand the position
// straight back to `rebalance` and the two would ping-pong every cooldown. The
// floor binds instead: re-leverage stops at `orange_hf + RELEVERAGE_HF_BUFFER`,
// and the proof it is far enough is that a rebalance immediately afterwards has
// nothing to do.
#[test]
fn test_releverage_floor_keeps_the_position_clear_of_the_rebalance_band() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_stressed_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    let (c_factor, target_loops, _, orange_hf) = sclient.config();
    let (_, _, l_factor) = sclient.risk_factors();
    let design_hf =
        crate::leverage::design_health_factor(c_factor, target_loops, l_factor).unwrap();
    assert!(
        design_hf < orange_hf,
        "fixture must be the pathological case: design {} vs orange {}",
        design_hf,
        orange_hf
    );

    let floor = orange_hf + crate::constants::RELEVERAGE_HF_BUFFER;

    // Deleverage well clear of the band, then re-lever.
    sclient.partial_unwind(&keeper, &(orange_hf + 3_000_000));
    let borrowed = sclient.releverage(&keeper);
    assert!(borrowed > 0, "must re-lever toward the floor");

    let hf = sclient.health_factor();
    assert!(
        hf >= floor,
        "must stop at the floor, not the design HF: {} < {}",
        hf,
        floor
    );
    assert!(
        hf <= floor + floor / 1_000,
        "must reach the floor: {} vs {}",
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

    assert_eq!(sclient.releverage(&keeper), 0, "no slack → no-op");
    assert!(
        find_releverage_event(&e, &strategy, &keeper).is_none(),
        "no event on a no-op"
    );

    let (equity_after, _, b_after, d_after, _, _) = sclient.position();
    assert_eq!(sclient.health_factor(), hf, "position untouched");
    assert_eq!((equity_after, b_after, d_after), (equity, b, d));

    let last = e.as_contract(&strategy, || storage::get_last_releverage(&e));
    assert_eq!(last, None, "a no-op must not arm the cooldown");
    assert_eq!(sclient.releverage(&keeper), 0, "immediate retry allowed");
}

// Rate limit, on-chain: a real re-leverage arms the cooldown, and the rejection
// inside the window is `DeadlineExpired` — the caller *is* authorized, it is
// simply too early, and reusing `NotAuthorized` for that is what makes
// `rebalance_keeper`'s cooldown misleading to operators (audit L-7).
#[test]
fn test_releverage_cooldown_rate_limits_on_chain() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let strategy = open_healthy_strategy(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);
    let keeper = sclient.get_keeper();

    sclient.partial_unwind(&keeper, &(sclient.health_factor() + 4_000_000));
    assert!(sclient.releverage(&keeper) > 0, "first call must do work");
    assert_eq!(
        e.as_contract(&strategy, || storage::get_last_releverage(&e)),
        Some(e.ledger().sequence()),
        "a real re-leverage arms the cooldown"
    );

    match sclient.try_releverage(&keeper) {
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
        sclient.try_releverage(&keeper).is_err(),
        "cooldown must hold until the full window has elapsed"
    );

    // Liquidation protection is never rate-limited by the re-leverage cooldown.
    sclient.rebalance();

    // At expiry the keeper may call again — a no-op here, HF is back at design.
    e.ledger().with_mut(|li| {
        li.sequence_number += 1;
    });
    assert_eq!(
        sclient.releverage(&keeper),
        0,
        "post-cooldown call succeeds"
    );
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
    let keeper = sclient.get_keeper();

    // Genuine slack to re-lever, so the rejection is about identity, not state.
    sclient.partial_unwind(&keeper, &(sclient.health_factor() + 4_000_000));

    let stranger = Address::generate(&e);
    match sclient.try_releverage(&stranger) {
        Err(Ok(StrategyError::NotAuthorized)) => {}
        other => std::panic!("expected NotAuthorized for a stranger, got {:?}", other),
    }
    assert!(
        sclient.releverage(&keeper) > 0,
        "the keeper may still re-lever"
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

    let (b_rate, d_rate, l_factor) = blend_pool::get_rates_and_l_factor(&e, &config);
    assert!(d_rate > SCALAR_12, "precondition: interest must accrue");

    let pre = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pre_b = pre.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre.liabilities.get(config.reserve_id).unwrap_or(0);
    let pre_equity = pre_b * b_rate / SCALAR_12 - pre_d * d_rate / SCALAR_12;
    let pre_hf =
        compute_health_factor(pre_b, pre_d, b_rate, d_rate, config.c_factor, l_factor).unwrap();

    // Unwind 2 loops through the REAL production deleverage path.
    let (b_removed, d_removed) = e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, 2, &config).unwrap()
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let post_b = post.collateral.get(config.reserve_id).unwrap_or(0);
    let post_d = post.liabilities.get(config.reserve_id).unwrap_or(0);
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

    let (b_rate, d_rate, l_factor) = blend_pool::get_rates_and_l_factor(&e, &config);
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

    // Production logic: derive the loop count needed to restore HF to target.
    let (_, loops) =
        compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, l_factor, target).unwrap();
    assert!(loops >= 1, "should need at least one unwind loop");

    // Execute the real deleverage on the real pool.
    e.as_contract(&strategy, || {
        blend_pool::submit_deleverage(&e, loops, &config).unwrap();
    });

    let post = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let b2 = post.collateral.get(config.reserve_id).unwrap_or(0);
    let d2 = post.liabilities.get(config.reserve_id).unwrap_or(0);
    let after_hf =
        compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor, l_factor).unwrap();

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

    let (b_rate, d_rate, l_factor) = blend_pool::get_rates_and_l_factor(&e, &config);
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

    // ── Dry-run prediction (same model as scripts/rebalance_sim.ts) ──────────
    let (_, loops) =
        compute_partial_unwind(b, d, b_rate, d_rate, config.c_factor, l_factor, target).unwrap();
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
    let after_hf =
        compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor, l_factor).unwrap();

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
    let share = e.register(MockShareToken, ());
    sclient.set_share_token(&share);

    let user = Address::generate(e);
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
    let claimed = sclient.harvest_claim(&sclient.get_keeper());
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
    let (strategy, sclient, keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    let seq_before = e.ledger().sequence();
    let claimed = sclient.harvest_claim(&keeper);
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

#[test]
fn test_harvest_claim_rejected_while_a_claim_is_still_pullable() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (_strategy, sclient, keeper, _swap) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim(&keeper);

    // Overlapping approvals would put more BLND at risk than the newer floor
    // covers, so a second claim inside the window is refused.
    assert_eq!(
        sclient.try_harvest_claim(&keeper),
        Err(Ok(StrategyError::DeadlineExpired)),
        "claiming over a live allowance must be refused"
    );

    // Past the window nothing can be pulled against the old approval, so a
    // fresh claim proceeds.
    e.ledger()
        .set_sequence_number(e.ledger().sequence() + crate::constants::HARVEST_APPROVAL_LEDGERS);
    sclient.harvest_claim(&keeper);
}

#[test]
fn test_broker_settlement_below_floor_reverts() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, deployer) = setup_blend_env(&e);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    let (strategy, sclient, keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim(&keeper);

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
        sclient.try_harvest_reinvest(&keeper, &1_0000000, &false, &0),
        Err(Ok(StrategyError::UnderlyingAmountBelowMin)),
        "1 underlying back for 1000 BLND must not settle"
    );

    // Returning nothing at all is the same answer.
    assert_eq!(
        sclient.try_harvest_reinvest(&keeper, &1_0000000, &false, &0),
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
    let (strategy, sclient, keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim(&keeper);
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
    let realized = sclient.harvest_reinvest(&keeper, &proceeds, &false, &0);
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
    let (strategy, sclient, keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim(&keeper);

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
        sclient.try_harvest_reinvest(&keeper, &4_0000000, &false, &0),
        Err(Ok(StrategyError::UnderlyingAmountBelowMin)),
        "4 back for 250 BLND is under the prorated floor"
    );

    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &2_0000000);
    assert_eq!(
        sclient.harvest_reinvest(&keeper, &6_0000000, &false, &0),
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
    let (strategy, sclient, keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    // The vault is already sitting on 50 underlying *before* the claim — a
    // donation, a rounding remainder, anything. The claim-time baseline is what
    // stops it being counted as harvest proceeds: `amount_in` alone would be
    // fully covered by it, and the pre-M-4 "is it held?" check would pass.
    StellarAssetClient::new(&e, &token)
        .mock_all_auths()
        .mint(&strategy, &50_0000000);

    sclient.harvest_claim(&keeper);
    TokenClient::new(&e, &blnd).transfer_from(
        &swap_account,
        &strategy,
        &swap_account,
        &1_000_0000000,
    );

    assert_eq!(
        sclient.try_harvest_reinvest(&keeper, &50_0000000, &false, &0),
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

    sclient.harvest_claim(&keeper);

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
    let (strategy, sclient, keeper, swap_account) =
        setup_broker_harvest(&e, &pool_addr, &token, &blnd, &deployer, 1_000_0000000);

    sclient.harvest_claim(&keeper);
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
    sclient.harvest_claim(&keeper);

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

// ── Audit M-2: stored reserves must reconcile with the real pool position ─────
//
// Finding ① below fixed the paths where the *strategy itself* moved the position.
// M-2 is the complement: a position change the strategy did NOT initiate — a
// liquidation seizing collateral, a Blend bad-debt socialization — was invisible
// to the tracked ledger, so `compute_equity` kept quoting the pre-seizure
// position and `withdraw` priced shares off the inflated figure. The shortfall
// landed entirely on whoever was last out.
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
    let share = e.register(MockShareToken, ());
    sclient.set_share_token(&share);

    let user = Address::generate(e);
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
// next deposit, not when an operator remembers to sync. Both `balance()` and
// `position()` read through the reconciliation, so the write-down is priced in on
// the very next read. Before the fix both would have reported the pre-seizure
// equity, and a withdrawal at that price would have overpaid at the expense of
// the remaining holders.
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
    let (equity_before, _, b_before, _, _, _) = sclient.position();
    let stored_before = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));

    // Seize ~10% of the collateral.
    let seized = b_before / 10;
    seize_collateral(&e, &pool_addr, &strategy, &token, seized);

    // The tracked ledger is untouched — this is exactly the blind spot M-2 is
    // about, and it is what the reconciliation has to see through.
    let stored_after = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));
    assert_eq!(
        stored_after.total_b_tokens, stored_before.total_b_tokens,
        "the seizure must be invisible to the raw stored ledger — otherwise this test proves nothing"
    );

    // The pool is the truth, and the views must now agree with it.
    let pool_b = pool::Client::new(&e, &pool_addr)
        .get_positions(&strategy)
        .collateral
        .get(cfg.reserve_id)
        .unwrap_or(0);
    assert!(
        pool_b < stored_before.total_b_tokens,
        "collateral must have left"
    );

    let (equity_after, _, b_after, _, _, _) = sclient.position();
    let balance_after = sclient.balance(&user);

    assert_eq!(
        b_after, pool_b,
        "M-2: position() must report the pool's collateral, not the stale ledger"
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
    let seized_value = (b_before - pool_b) * stored_before.b_rate / SCALAR_12;
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

// The observability half of M-2. Pricing already self-corrects on read, but the
// correction is silent — nothing on-chain says "the position changed and we did
// not do it". `sync_reserves()` persists the write-down and emits `reserves_sync`
// so the `alerts/` stack can detect a liquidation. Permissionless, idempotent.
#[test]
fn test_sync_reserves_writes_down_seizure_and_emits_event() {
    let e = Env::default();
    e.mock_all_auths();
    let (pool_addr, token, blnd, _blend, _deployer) = setup_blend_env(&e);
    let cfg = make_config(&e, &pool_addr, &token, &blnd);
    seed_pool_liquidity(&e, &pool_addr, &token, 100_000_0000000);
    e.cost_estimate().budget().reset_unlimited();

    let (strategy, _user) = open_position_for_seizure(&e, &pool_addr, &token, &blnd);
    let sclient = crate::BlendLeverageStrategyClient::new(&e, &strategy);

    // In sync to begin with: no correction, no event, nothing written.
    assert_eq!(
        sclient.sync_reserves(),
        (0, 0),
        "a position the strategy alone moved is already in sync"
    );
    assert!(
        find_reserves_sync_event(&e, &strategy).is_none(),
        "no event when there is nothing to correct"
    );

    let stored_before = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));
    let seized = stored_before.total_b_tokens / 10;
    seize_collateral(&e, &pool_addr, &strategy, &token, seized);

    // Anyone may call it — no keeper, no admin, no caller argument at all.
    let (b_corr, d_corr) = sclient.sync_reserves();
    let (ev_b_before, ev_b_after, ev_d_before, ev_d_after) =
        find_reserves_sync_event(&e, &strategy).expect("a correction must emit reserves_sync");

    let pool_positions = pool::Client::new(&e, &pool_addr).get_positions(&strategy);
    let pool_b = pool_positions.collateral.get(cfg.reserve_id).unwrap_or(0);
    let pool_d = pool_positions.liabilities.get(cfg.reserve_id).unwrap_or(0);

    let stored_after = e.as_contract(&strategy, || storage::get_strategy_reserves(&e));
    assert_eq!(
        stored_after.total_b_tokens, pool_b,
        "sync must write the stored ledger down to the pool"
    );
    assert_eq!(stored_after.total_d_tokens, pool_d, "debt side likewise");
    assert_eq!(
        b_corr,
        stored_before.total_b_tokens - pool_b,
        "returned correction must be the amount written down"
    );
    assert_eq!(d_corr, 0, "the seizure touched collateral only");

    // Event payload describes the transition the alerts stack has to reason about.
    assert_eq!(ev_b_before, stored_before.total_b_tokens, "event b before");
    assert_eq!(ev_b_after, pool_b, "event b after");
    assert_eq!(ev_d_before, stored_before.total_d_tokens, "event d before");
    assert_eq!(ev_d_after, pool_d, "event d after");

    // Idempotent: a second call has nothing to do and stays quiet.
    assert_eq!(sclient.sync_reserves(), (0, 0), "second sync is a no-op");
    assert!(
        find_reserves_sync_event(&e, &strategy).is_none(),
        "no-op sync must not emit"
    );
}

// The reconciliation is deliberately one-directional: it clamps the tracked
// totals DOWN to the pool's, never up. Following the pool upwards would mean any
// collateral credited to the strategy's position moved the share price — the
// lever an inflation attack needs, and the opposite of the property the audit's
// "not exploitable" list rests on ("a donation cannot move the share price").
//
// Two things are pinned here. First, the assumption underneath: Blend does not
// currently offer a way to credit somebody else's position — `submit`'s `to`
// argument routes outgoing transfers, not incoming supply, so a `SupplyCollateral`
// submitted with `to = strategy` credits the *sender*. Second, and the part that
// matters if that ever changes: even with the pool reporting more collateral than
// the strategy tracks, the views stay on the tracked figure.
#[test]
fn test_reconciliation_never_revises_the_position_upward() {
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

    // So construct the upward gap directly, and pin the rule that guards it:
    // stored below the pool's measured position must NOT be revised up.
    let balance_before = sclient.balance(&user);
    let (equity_before, _, _, _, _, _) = sclient.position();
    let understated = b_before - 1_000_0000000;
    e.as_contract(&strategy, || {
        let mut r = storage::get_strategy_reserves(&e);
        r.total_b_tokens = understated;
        storage::set_strategy_reserves(&e, r);
    });

    let (equity_after, _, b_after, _, _, _) = sclient.position();
    assert_eq!(
        b_after, understated,
        "reconciliation must keep the lower tracked figure, not the pool's higher one"
    );
    assert!(
        equity_after < equity_before && sclient.balance(&user) < balance_before,
        "the understated position must price low, never be topped up from the pool"
    );
    assert_eq!(
        sclient.sync_reserves(),
        (0, 0),
        "sync only writes down; an upward gap is not a correction"
    );
    assert_eq!(
        e.as_contract(&strategy, || storage::get_strategy_reserves(&e))
            .total_b_tokens,
        understated,
        "and sync must not have persisted an upward revision"
    );
}

/// Decode the strategy's `("reserves_sync",)` event payload
/// `(b_before, b_after, d_before, d_after)` from the LAST invocation's events.
fn find_reserves_sync_event(e: &Env, strategy: &Address) -> Option<(i128, i128, i128, i128)> {
    use soroban_sdk::{xdr, TryFromVal, Val};
    let events = e.events().all().filter_by_contract(strategy);
    for ev in events.events() {
        let xdr::ContractEventBody::V0(v0) = &ev.body;
        if v0.topics.len() != 1 {
            continue;
        }
        if Symbol::try_from_val(e, &v0.topics[0]) != Ok(Symbol::new(e, "reserves_sync")) {
            continue;
        }
        let data: Val = Val::try_from_val(e, &v0.data).ok()?;
        return <(i128, i128, i128, i128)>::try_from_val(e, &data).ok();
    }
    None
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
        let (b_rate, d_rate, l_factor) = blend_pool::get_rates_and_l_factor(&e, &config);
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
    sclient.set_share_token(&e.register(MockShareToken, ()));

    let user = Address::generate(&e);
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
    sclient.set_share_token(&e.register(MockShareToken, ()));

    let user = Address::generate(&e);
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
