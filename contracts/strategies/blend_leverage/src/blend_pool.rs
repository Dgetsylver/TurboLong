use blend_contract_sdk::pool::{Client as BlendPoolClient, Request};
use defindex_strategy_core::StrategyError;
use soroban_fixed_point_math::FixedPoint;
use soroban_sdk::{token::TokenClient, vec, Address, Env, Vec};

use crate::{
    constants::{
        REQUEST_TYPE_BORROW, REQUEST_TYPE_REPAY, REQUEST_TYPE_SUPPLY_COLLATERAL,
        REQUEST_TYPE_WITHDRAW_COLLATERAL, SCALAR_12,
    },
    leverage::compute_totals,
    soroswap::internal_swap_exact_tokens_for_tokens,
    storage::Config,
};

// ── Position changes ─────────────────────────────────────────────────────────
//
// Every position change is one `submit_with_allowance` of at most two requests.
// Two properties of the Blend v2 pool make that enough:
//
// - Token transfers are settled once, after every request has been applied, and
//   netted per asset: the strategy is pulled from (`transfer_from`) only when it
//   owes the pool on balance, and paid only the surplus. Plain `submit` does not
//   net; this module never uses it.
// - Each `borrow` and `withdraw_collateral` request checks that the reserve's
//   utilization is below 100% at the moment it runs. Max utilization, the
//   health factor and min collateral are checked once, on the final state.
//
// So each submit lists the request that lowers utilization first — supply before
// borrow, repay before withdraw — and its one utilization-raising request runs
// its below-100% check against the submit's final state rather than a halfway
// one. For a borrow that is already implied by the final max-utilization check;
// for a withdraw it asks only that the pool can pay out the net amount.
//
// Blend also rejects any request that mints or burns zero b/d-tokens, so a leg
// that would be zero is left out rather than sent.
//
// Netting is also why only the lever-in grants the pool an allowance: it is the
// one submit where the strategy owes on balance — exactly the deposit. The
// others net to zero (deleverage, re-leverage) or in the strategy's favour
// (unwind), so the pool pulls nothing, and a submit that did owe would revert
// for want of an allowance rather than draw on idle underlying the strategy
// holds (e.g. Broker proceeds awaiting `harvest_reinvest`).

/// Lever `initial_amount` of the underlying into the position as one
/// `[supply_collateral S, borrow D]` submit, `(S, D)` being the totals of the
/// `target_loops`-deep loop (`compute_totals`).
///
/// One pair builds the position the loop would. Netting means only
/// `S − D = initial_amount` leaves the strategy, and the single borrow is checked
/// against the whole supply — the final state, which the loop only reached on its
/// last step — so it is never harder on the pool than the loop was.
///
/// Returns (b_token_delta, d_token_delta) — the position deltas.
pub fn submit_leverage_loop(
    e: &Env,
    initial_amount: i128,
    config: &Config,
) -> Result<(i128, i128), StrategyError> {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let strategy = e.current_contract_address();
    let (pre_b, pre_d) = get_strategy_positions(e, config);

    let (total_supply, total_borrow) =
        compute_totals(initial_amount, config.c_factor, config.target_loops)?;

    // Supply first, so the borrow is checked against the final state. A dust
    // amount whose borrow floors to zero is supplied without one.
    let mut requests: Vec<Request> = vec![
        e,
        Request {
            address: config.asset.clone(),
            amount: total_supply,
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
        },
    ];
    if total_borrow > 0 {
        requests.push_back(Request {
            address: config.asset.clone(),
            amount: total_borrow,
            request_type: REQUEST_TYPE_BORROW,
        });
    }

    // The pool nets the two legs and pulls only `S − D = initial_amount`, so that
    // is all it may pull. The allowance expires next ledger.
    TokenClient::new(e, &config.asset).approve(
        &strategy,
        &config.pool,
        &initial_amount,
        &(e.ledger().sequence() + 1),
    );
    pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);

    let (new_b, new_d) = get_strategy_positions(e, config);
    let b_delta = new_b
        .checked_sub(pre_b)
        .ok_or(StrategyError::UnderflowOverflow)?;
    let d_delta = new_d
        .checked_sub(pre_d)
        .ok_or(StrategyError::UnderflowOverflow)?;

    Ok((b_delta, d_delta))
}

// ── Unwind (partial or full) ─────────────────────────────────────────────────

/// Unwind a proportional share of the leveraged position as one
/// `[repay d, withdraw_collateral b]` submit, paying the equity to `to`.
///
/// Blend request amounts are denominated in the UNDERLYING asset, but the caller
/// passes b/d-TOKEN quantities, so both are converted with the current pool
/// rates (the two only coincide while the rates sit at 1.0) — and rounded
/// against the withdrawer. The repay rounds *up*, so the pool burns exactly
/// `d_tokens_to_remove`: none of the share's debt is left behind for the
/// remaining holders, a full close needs no `i64::MAX` sweep, and a non-zero
/// share can never round down to a zero-token burn. The withdraw rounds *down*,
/// so it burns at most `b_tokens_to_remove`.
///
/// Repay first, so the withdraw is checked against the final state. Netting
/// means the pool pays out only `b − d` — the equity — and the strategy needs
/// no balance of its own. A share with no debt in it (a debt-free or dust-debt
/// position) sends the withdraw alone. A share too small to carry any equity out
/// once rounded is refused with `AmountBelowMinDust` rather than unwound: the
/// caller burns the shares first, and an unwind that pays nothing would take
/// them for nothing.
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

    let (pre_b, pre_d) = get_strategy_positions(e, config);
    let pre_balance = token_client.balance(&strategy);

    let (b_rate, d_rate) = get_rates(e, config);
    let d_underlying = d_tokens_to_remove
        .fixed_mul_ceil(d_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;
    let b_underlying = b_tokens_to_remove
        .fixed_mul_floor(b_rate, SCALAR_12)
        .ok_or(StrategyError::ArithmeticError)?;

    if b_underlying <= d_underlying {
        return Err(StrategyError::AmountBelowMinDust);
    }

    let mut requests: Vec<Request> = Vec::new(e);
    if d_underlying > 0 {
        requests.push_back(Request {
            address: config.asset.clone(),
            amount: d_underlying,
            request_type: REQUEST_TYPE_REPAY,
        });
    }
    requests.push_back(Request {
        address: config.asset.clone(),
        amount: b_underlying,
        request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
    });

    pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);

    // Transfer equity to `to`
    let post_balance = token_client.balance(&strategy);
    let equity = post_balance
        .checked_sub(pre_balance)
        .ok_or(StrategyError::UnderflowOverflow)?;

    if equity > 0 && to != &strategy {
        token_client.transfer(&strategy, to, &equity);
    }

    // Read final positions for return
    let (end_b, end_d) = get_strategy_positions(e, config);

    let b_removed = pre_b
        .checked_sub(end_b)
        .ok_or(StrategyError::UnderflowOverflow)?;
    let d_removed = pre_d
        .checked_sub(end_d)
        .ok_or(StrategyError::UnderflowOverflow)?;

    Ok((b_removed, d_removed))
}

/// Deleverage by `repay_underlying`: repay that much debt and withdraw the same
/// amount of collateral, as one `[repay, withdraw_collateral]` submit. Equity
/// (`B − D`) does not move; only the leverage ratio falls.
///
/// The amount is `compute_partial_unwind`'s, sized so the position lands on a
/// target HF. Repay first: the withdraw is then checked against the final
/// state, whose utilization is no higher than where the pool started (bar a
/// stroop or two of rounding), so the unwind goes through as long as the pool
/// has a few stroops free. The two transfers net to zero.
///
/// Returns (b_tokens_removed, d_tokens_removed).
pub fn submit_deleverage(
    e: &Env,
    repay_underlying: i128,
    config: &Config,
) -> Result<(i128, i128), StrategyError> {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let strategy = e.current_contract_address();

    let (pre_b, pre_d) = get_strategy_positions(e, config);
    if pre_d == 0 || repay_underlying <= 0 {
        return Ok((0, 0));
    }

    let requests: Vec<Request> = vec![
        e,
        Request {
            address: config.asset.clone(),
            amount: repay_underlying,
            request_type: REQUEST_TYPE_REPAY,
        },
        Request {
            address: config.asset.clone(),
            amount: repay_underlying,
            request_type: REQUEST_TYPE_WITHDRAW_COLLATERAL,
        },
    ];

    pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);

    let (new_b, new_d) = get_strategy_positions(e, config);

    Ok((
        pre_b
            .checked_sub(new_b)
            .ok_or(StrategyError::UnderflowOverflow)?,
        pre_d
            .checked_sub(new_d)
            .ok_or(StrategyError::UnderflowOverflow)?,
    ))
}

/// Re-leverage: supply `amount` of the underlying as collateral and borrow the
/// same amount back, in one atomic submit. The mirror of `submit_deleverage`.
///
/// Supply first, for the same reason the deposit does: the borrow is then
/// checked against the final state. The order is not about funding — the two
/// transfers net to zero, so the strategy needs no balance of its own either
/// way. The pool health-checks the finished request set, and the caller
/// (`releverage`) re-reads the position afterwards and reverts if the result is
/// not where it asked for.
///
/// Returns `(b_token_delta, d_token_delta)` — both positive on success.
pub fn submit_releverage(
    e: &Env,
    amount: i128,
    config: &Config,
) -> Result<(i128, i128), StrategyError> {
    if amount <= 0 {
        return Ok((0, 0));
    }

    let pool_client = BlendPoolClient::new(e, &config.pool);
    let strategy = e.current_contract_address();
    let (pre_b, pre_d) = get_strategy_positions(e, config);

    let requests: Vec<Request> = vec![
        e,
        Request {
            address: config.asset.clone(),
            amount,
            request_type: REQUEST_TYPE_SUPPLY_COLLATERAL,
        },
        Request {
            address: config.asset.clone(),
            amount,
            request_type: REQUEST_TYPE_BORROW,
        },
    ];

    pool_client.submit_with_allowance(&strategy, &strategy, &strategy, &requests);

    let (new_b, new_d) = get_strategy_positions(e, config);

    Ok((
        new_b
            .checked_sub(pre_b)
            .ok_or(StrategyError::UnderflowOverflow)?,
        new_d
            .checked_sub(pre_d)
            .ok_or(StrategyError::UnderflowOverflow)?,
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

/// Fetch `(b_rate, d_rate, l_factor)` for the configured asset in a single pool
/// call — the inputs every health-factor computation needs.
///
/// `l_factor` is the pool's *liability* factor (1e7): Blend measures solvency as
/// `B × c_factor` against `D / l_factor`, so omitting it makes the strategy's HF
/// systematically optimistic relative to the number that governs liquidation. It
/// is read live rather than cached at construction because Blend governance can
/// re-parameterise a reserve (`queue_set_reserve`), and a stale copy would fail
/// in exactly the unsafe direction.
pub fn get_rates_and_l_factor(e: &Env, config: &Config) -> (i128, i128, i128) {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let reserve = pool_client.get_reserve(&config.asset);
    (
        reserve.data.b_rate,
        reserve.data.d_rate,
        reserve.config.l_factor as i128,
    )
}

/// Fetch the pool's own risk parameters for the configured asset:
/// `(c_factor, l_factor)`, both 1e7-scaled.
pub fn get_pool_risk_factors(e: &Env, config: &Config) -> (i128, i128) {
    let pool_client = BlendPoolClient::new(e, &config.pool);
    let reserve = pool_client.get_reserve(&config.asset);
    (
        reserve.config.c_factor as i128,
        reserve.config.l_factor as i128,
    )
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
