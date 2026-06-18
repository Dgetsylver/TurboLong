use blend_contract_sdk::pool::{Client as BlendPoolClient, Request};
use defindex_strategy_core::StrategyError;
use soroban_sdk::{
    auth::{ContractContext, InvokerContractAuthEntry, SubContractInvocation},
    token::TokenClient,
    vec, Address, Env, IntoVal, Symbol, Vec,
};

use crate::{
    constants::{
        REQUEST_TYPE_BORROW, REQUEST_TYPE_REPAY, REQUEST_TYPE_SUPPLY_COLLATERAL,
        REQUEST_TYPE_WITHDRAW_COLLATERAL, SCALAR_12, SCALAR_7,
    },
    leverage::{compute_step, loop_step_count},
    soroswap::internal_swap_exact_tokens_for_tokens,
    storage::Config,
};

// ── Leverage loop submission ─────────────────────────────────────────────────

/// Submit a leverage loop to the Blend pool as a single atomic submit.
///
/// Blend pool processes requests sequentially: for each supply request it pulls
/// tokens, for each borrow request it sends tokens. So alternating
/// [supply, borrow, supply, borrow, ..., supply] works atomically — borrow
/// proceeds fund the next supply step within the same submit() call.
///
/// Returns (b_token_delta, d_token_delta) — the position deltas.
pub fn submit_leverage_loop(
    e: &Env,
    initial_amount: i128,
    config: &Config,
) -> Result<(i128, i128), StrategyError> {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let strategy = e.current_contract_address();

    // Get pre-loop positions
    let pre_positions = pool_client.get_positions(&strategy);
    let pre_b = pre_positions.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);

    // Build all requests: [supply, borrow, supply, borrow, ..., supply]
    // The pool sums all supply amounts and does one transfer_from for the total.
    // Using submit_with_allowance: we approve the pool for the total supply amount,
    // and the pool uses transferFrom to pull tokens.
    let count = loop_step_count(config.target_loops);
    let mut requests: Vec<Request> = Vec::new(e);
    let mut total_supply = 0i128;
    let mut balance = initial_amount;

    for i in 0..count {
        let is_final = i == config.target_loops.min(20);
        let (supply, borrow) = compute_step(balance, config.c_factor, is_final);
        balance = borrow;

        if supply > 0 {
            requests.push_back(Request {
                address: config.asset.clone(),
                amount: supply,
                request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
            });
            total_supply += supply;
        }

        if borrow > 0 {
            requests.push_back(Request {
                address: config.asset.clone(),
                amount: borrow,
                request_type: REQUEST_TYPE_BORROW,
            });
        }
    }

    // Approve pool to spend total supply amount via allowance
    let token_client = TokenClient::new(e, &config.asset);
    e.authorize_as_current_contract(vec![
        e,
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: config.asset.clone(),
                fn_name: Symbol::new(e, "approve"),
                args: (
                    strategy.clone(),
                    config.pool.clone(),
                    total_supply,
                    e.ledger().sequence() + 1u32,
                )
                    .into_val(e),
            },
            sub_invocations: vec![e],
        }),
    ]);
    token_client.approve(
        &strategy,
        &config.pool,
        &total_supply,
        &(e.ledger().sequence() + 1),
    );

    // Single atomic submit using allowance-based transfers
    pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);

    // Read final positions
    let new_positions = pool_client.get_positions(&strategy);
    let new_b = new_positions.collateral.get(config.reserve_id).unwrap_or(0);
    let new_d = new_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);

    let b_delta = new_b
        .checked_sub(pre_b)
        .ok_or(StrategyError::UnderflowOverflow)?;
    let d_delta = new_d
        .checked_sub(pre_d)
        .ok_or(StrategyError::UnderflowOverflow)?;

    Ok((b_delta, d_delta))
}

// ── Unwind (partial or full) ─────────────────────────────────────────────────

/// Unwind a proportional share of the leveraged position.
///
/// Blend pool processes requests sequentially within a single submit():
/// withdraw sends tokens to strategy, repay pulls them back. Alternating
/// [withdraw, repay, withdraw, repay, ..., withdraw] works atomically —
/// the same pattern as the leverage loop but in reverse.
///
/// The final extra withdraw (after all debt is repaid) extracts the equity.
///
/// Returns (b_tokens_removed, d_tokens_removed).
pub fn submit_unwind(
    e: &Env,
    b_tokens_to_remove: i128,
    d_tokens_to_remove: i128,
    to: &Address,
    config: &Config,
) -> Result<(i128, i128), StrategyError> {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let token_client = TokenClient::new(e, &config.asset);
    let strategy = e.current_contract_address();

    let pre_positions = pool_client.get_positions(&strategy);
    let pre_b = pre_positions.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);

    let pre_balance = token_client.balance(&strategy);

    // Blend request amounts are denominated in the UNDERLYING asset, but the
    // caller passes b/d-TOKEN quantities. Convert with the current pool rates
    // (underlying = tokens × rate / SCALAR_12). The two are only equal while the
    // rates sit at 1.0; once interest accrues they diverge, so skipping this
    // conversion makes the unwind repay/withdraw the wrong amounts.
    let reserve = pool_client.get_reserve(&config.asset);
    let b_rate = reserve.data.b_rate;
    let d_rate = reserve.data.d_rate;
    let d_underlying = d_tokens_to_remove
        .checked_mul(d_rate)
        .ok_or(StrategyError::ArithmeticError)?
        / SCALAR_12;
    let b_underlying = b_tokens_to_remove
        .checked_mul(b_rate)
        .ok_or(StrategyError::ArithmeticError)?
        / SCALAR_12;

    // Build atomic unwind: [withdraw, repay] × N steps + [withdraw equity].
    // Split the underlying debt evenly across target_loops steps.
    // Each step withdraws and repays the same amount, maintaining HF.
    // The final withdraw extracts the equity (b - d difference).
    let mut requests: Vec<Request> = Vec::new(e);
    let mut total_repay = 0i128;

    let n_steps = config.target_loops.max(1);
    let repay_per_step = d_underlying / n_steps as i128;

    // Check if this is a full close (removing all debt)
    let pool_client_inner = BlendPoolClient::new(e, &config.pool);
    let cur_positions = pool_client_inner.get_positions(&strategy);
    let total_d = cur_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);
    let is_full_close = d_tokens_to_remove >= total_d;

    for i in 0..n_steps {
        let is_last = i == n_steps - 1;

        // For repay: only use i64::MAX on full close's last step (cleans dust).
        // For partial unwinds, use exact amounts so the pool doesn't repay all debt.
        let repay_amount = if is_last && is_full_close {
            i64::MAX as i128
        } else if is_last {
            d_underlying - repay_per_step * (n_steps as i128 - 1)
        } else {
            repay_per_step
        };

        // Withdraw same amount as repay in each pair — this frees collateral to cover repayment.
        // The equity portion (b - d, in underlying) is withdrawn separately at the end.
        let withdraw_amount = if is_last {
            d_underlying - repay_per_step * (n_steps as i128 - 1)
        } else {
            repay_per_step
        };

        requests.push_back(Request {
            address: config.asset.clone(),
            amount: withdraw_amount,
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
        });
        requests.push_back(Request {
            address: config.asset.clone(),
            amount: repay_amount,
            request_type: REQUEST_TYPE_REPAY,
        });
        total_repay += repay_amount;
    }

    // Final: withdraw equity portion (collateral minus debt that was removed),
    // in underlying.
    let equity_withdraw = b_underlying.checked_sub(d_underlying).unwrap_or(0);

    if equity_withdraw > 0 {
        requests.push_back(Request {
            address: config.asset.clone(),
            amount: equity_withdraw,
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
        });
    }

    // Approve pool to spend total repay amount via allowance
    if total_repay > 0 {
        let token_client_inner = TokenClient::new(e, &config.asset);
        e.authorize_as_current_contract(vec![
            e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: config.asset.clone(),
                    fn_name: Symbol::new(e, "approve"),
                    args: (
                        strategy.clone(),
                        config.pool.clone(),
                        total_repay,
                        e.ledger().sequence() + 1u32,
                    )
                        .into_val(e),
                },
                sub_invocations: vec![e],
            }),
        ]);
        token_client_inner.approve(
            &strategy,
            &config.pool,
            &total_repay,
            &(e.ledger().sequence() + 1),
        );
    }

    // Single atomic submit using allowance-based transfers
    pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);

    // Transfer equity to `to`
    let post_balance = token_client.balance(&strategy);
    let equity = post_balance
        .checked_sub(pre_balance)
        .ok_or(StrategyError::UnderflowOverflow)?;

    if equity > 0 && to != &strategy {
        e.authorize_as_current_contract(vec![
            e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: config.asset.clone(),
                    fn_name: Symbol::new(e, "transfer"),
                    args: (strategy.clone(), to.clone(), equity).into_val(e),
                },
                sub_invocations: vec![e],
            }),
        ]);
        token_client.transfer(&strategy, to, &equity);
    }

    // Read final positions for return
    let end_positions = pool_client.get_positions(&strategy);
    let end_b = end_positions.collateral.get(config.reserve_id).unwrap_or(0);
    let end_d = end_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);

    let b_removed = pre_b
        .checked_sub(end_b)
        .ok_or(StrategyError::UnderflowOverflow)?;
    let d_removed = pre_d
        .checked_sub(end_d)
        .ok_or(StrategyError::UnderflowOverflow)?;

    Ok((b_removed, d_removed))
}

/// Deleverage by unwinding loops to improve health factor.
/// Builds alternating [withdraw, repay, ...] requests and submits atomically.
/// Returns (b_tokens_removed, d_tokens_removed).
pub fn submit_deleverage(
    e: &Env,
    unwind_loops: u32,
    config: &Config,
) -> Result<(i128, i128), StrategyError> {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let strategy = e.current_contract_address();

    let pre_positions = pool_client.get_positions(&strategy);
    let pre_b = pre_positions.collateral.get(config.reserve_id).unwrap_or(0);
    let pre_d = pre_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);

    if pre_d == 0 {
        return Ok((0, 0));
    }

    // Size one unwind layer as `debt × (1 - c_factor)`, in UNDERLYING — the same
    // definition `compute_partial_unwind` uses to derive `unwind_loops`, so that
    // unwinding N loops repays ≈ the intended `repay_underlying`. (The previous
    // implementation seeded the layers from total collateral, producing layers
    // several times larger than the position, which over-unwound or reverted.)
    // Blend request amounts are denominated in the underlying asset, so convert
    // the d-token debt with the current d_rate.
    let reserve = pool_client.get_reserve(&config.asset);
    let debt_underlying = pre_d
        .checked_mul(reserve.data.d_rate)
        .ok_or(StrategyError::ArithmeticError)?
        / SCALAR_12;
    let layer = debt_underlying
        .checked_mul(SCALAR_7 - config.c_factor)
        .ok_or(StrategyError::ArithmeticError)?
        / SCALAR_7;
    if layer <= 0 {
        return Ok((0, 0));
    }

    // Build all (withdraw, repay) pairs for a single atomic submit, each step
    // HF-neutral (withdraw == repay). Cap the cumulative repay at the outstanding
    // debt so we never over-repay or withdraw more collateral than exists.
    let mut requests: Vec<Request> = Vec::new(e);
    let mut total_repay = 0i128;
    let mut remaining_debt = debt_underlying;

    for _ in 0..unwind_loops.min(20) {
        let amount = layer.min(remaining_debt);
        if amount <= 0 {
            break;
        }

        requests.push_back(Request {
            address: config.asset.clone(),
            amount,
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
        });
        requests.push_back(Request {
            address: config.asset.clone(),
            amount,
            request_type: REQUEST_TYPE_REPAY,
        });
        total_repay += amount;
        remaining_debt -= amount;
    }

    if total_repay > 0 {
        let token_client = TokenClient::new(e, &config.asset);
        e.authorize_as_current_contract(vec![
            e,
            InvokerContractAuthEntry::Contract(SubContractInvocation {
                context: ContractContext {
                    contract: config.asset.clone(),
                    fn_name: Symbol::new(e, "approve"),
                    args: (
                        strategy.clone(),
                        config.pool.clone(),
                        total_repay,
                        e.ledger().sequence() + 1u32,
                    )
                        .into_val(e),
                },
                sub_invocations: vec![e],
            }),
        ]);
        token_client.approve(
            &strategy,
            &config.pool,
            &total_repay,
            &(e.ledger().sequence() + 1),
        );
    }

    if !requests.is_empty() {
        pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);
    }

    let new_positions = pool_client.get_positions(&strategy);
    let new_b = new_positions.collateral.get(config.reserve_id).unwrap_or(0);
    let new_d = new_positions
        .liabilities
        .get(config.reserve_id)
        .unwrap_or(0);

    Ok((
        pre_b.checked_sub(new_b).unwrap_or(0),
        pre_d.checked_sub(new_d).unwrap_or(0),
    ))
}

// ── Claim BLND emissions ─────────────────────────────────────────────────────

/// Claim BLND emissions from both supply and borrow sides.
pub fn claim(e: &Env, config: &Config) -> i128 {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    pool_client.claim(
        &e.current_contract_address(),
        &config.claim_ids,
        &e.current_contract_address(),
    )
}

// ── Harvest: claim + swap + re-leverage ──────────────────────────────────────

/// Claim BLND, swap to underlying via Soroswap, and re-leverage the proceeds.
/// Returns (b_tokens_delta, d_tokens_delta, realized_underlying).
pub fn perform_reinvest(
    e: &Env,
    config: &Config,
    amount_out_min: i128,
) -> Result<(i128, i128, i128), StrategyError> {
    let blnd_balance =
        TokenClient::new(e, &config.blend_token).balance(&e.current_contract_address());

    if blnd_balance < config.reward_threshold {
        return Ok((0, 0, 0));
    }

    let swap_path = vec![e, config.blend_token.clone(), config.asset.clone()];

    let deadline = e
        .ledger()
        .timestamp()
        .checked_add(1)
        .ok_or(StrategyError::UnderflowOverflow)?;

    // Swap BLND → underlying asset
    let swapped_amounts = internal_swap_exact_tokens_for_tokens(
        e,
        &blnd_balance,
        &amount_out_min,
        swap_path,
        &e.current_contract_address(),
        &deadline,
        config,
    )?;

    let amount_out: i128 = swapped_amounts
        .get(1)
        .ok_or(StrategyError::InternalSwapError)?;

    if amount_out <= 0 {
        return Ok((0, 0, 0));
    }

    // Re-leverage the swapped proceeds
    let (b_delta, d_delta) = submit_leverage_loop(e, amount_out, config)?;

    Ok((b_delta, d_delta, amount_out))
}

/// Re-leverage `amount` of the underlying asset that is already held by the
/// strategy (the Stellar Broker harvest path: the keeper swapped BLND→underlying
/// off-chain and transferred the proceeds back). No on-chain swap. Asserts the
/// contract actually holds at least `amount` of underlying before leveraging.
pub fn reinvest_underlying(
    e: &Env,
    config: &Config,
    amount: i128,
) -> Result<(i128, i128), StrategyError> {
    if amount <= 0 {
        return Ok((0, 0));
    }
    let held = TokenClient::new(e, &config.asset).balance(&e.current_contract_address());
    if held < amount {
        return Err(StrategyError::InsufficientBalance);
    }
    submit_leverage_loop(e, amount, config)
}

// ── Pool state queries ───────────────────────────────────────────────────────

/// Fetch current b_rate and d_rate for the configured asset.
pub fn get_rates(e: &Env, config: &Config) -> (i128, i128) {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let reserve = pool_client.get_reserve(&config.asset);
    (reserve.data.b_rate, reserve.data.d_rate)
}

/// Fetch current pool supply and borrow in underlying units.
pub fn get_pool_utilization(e: &Env, config: &Config) -> (i128, i128) {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let reserve = pool_client.get_reserve(&config.asset);

    let supply_underlying = reserve
        .data
        .b_supply
        .checked_mul(reserve.data.b_rate)
        .unwrap_or(0)
        / SCALAR_12;
    let borrow_underlying = reserve
        .data
        .d_supply
        .checked_mul(reserve.data.d_rate)
        .unwrap_or(0)
        / SCALAR_12;

    (supply_underlying, borrow_underlying)
}

/// Get current strategy positions (b_tokens, d_tokens) from the pool.
pub fn get_strategy_positions(e: &Env, config: &Config) -> (i128, i128) {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let positions = pool_client.get_positions(&e.current_contract_address());

    let b_tokens = positions.collateral.get(config.reserve_id).unwrap_or(0);
    let d_tokens = positions.liabilities.get(config.reserve_id).unwrap_or(0);

    (b_tokens, d_tokens)
}
