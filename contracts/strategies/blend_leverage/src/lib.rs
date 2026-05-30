#![no_std]

mod blend_pool;
mod constants;
mod leverage;
mod reserves;
mod soroswap;
mod storage;

#[cfg(test)]
mod test_leverage;
#[cfg(test)]
mod test_integration;

use constants::SCALAR_12;
pub use defindex_strategy_core::{event, DeFindexStrategyTrait, StrategyError};
use leverage::{
    check_deposit_safety, compute_health_factor, compute_totals, compute_unwind_loops,
    shares_to_underlying,
};
use soroban_sdk::{
    contract, contractimpl, token::TokenClient, Address, Bytes, Env, IntoVal, String, Val, Vec,
};
use storage::{extend_instance_ttl, Config, STRATEGY_VERSION};

fn check_positive_amount(amount: i128) -> Result<(), StrategyError> {
    if amount <= 0 {
        Err(StrategyError::OnlyPositiveAmountAllowed)
    } else {
        Ok(())
    }
}

const STRATEGY_NAME: &str = "BlendLeverageStrategy";

#[contract]
pub struct BlendLeverageStrategy;

#[contractimpl]
impl DeFindexStrategyTrait for BlendLeverageStrategy {
    /// Initialize the strategy with configuration.
    ///
    /// init_args layout:
    ///   [0] pool: Address          — Blend pool
    ///   [1] blend_token: Address   — BLND token
    ///   [2] router: Address        — Soroswap router
    ///   [3] reward_threshold: i128 — min BLND to trigger harvest
    ///   [4] keeper: Address        — authorized harvest caller
    ///   [5] c_factor: i128         — collateral factor (1e7)
    ///   [6] target_loops: u32      — number of leverage loops
    ///   [7] min_hf: i128           — minimum health factor (1e7)
    fn __constructor(e: Env, asset: Address, init_args: Vec<Val>) {
        let pool: Address = init_args
            .get(0)
            .expect("Missing: pool address")
            .into_val(&e);
        let blend_token: Address = init_args
            .get(1)
            .expect("Missing: blend_token")
            .into_val(&e);
        let router: Address = init_args
            .get(2)
            .expect("Missing: router")
            .into_val(&e);
        let reward_threshold: i128 = init_args
            .get(3)
            .expect("Missing: reward_threshold")
            .into_val(&e);
        let keeper: Address = init_args
            .get(4)
            .expect("Missing: keeper")
            .into_val(&e);
        let c_factor: i128 = init_args
            .get(5)
            .expect("Missing: c_factor")
            .into_val(&e);
        let target_loops: u32 = init_args
            .get(6)
            .expect("Missing: target_loops")
            .into_val(&e);
        let min_hf: i128 = init_args
            .get(7)
            .expect("Missing: min_hf")
            .into_val(&e);

        // Look up the reserve index from the pool
        let pool_client = blend_contract_sdk::pool::Client::new(&e, &pool);
        let reserve = pool_client.get_reserve(&asset);
        let reserve_id = reserve.config.index;

        // Claim IDs: supply side = index*2+1, borrow side = index*2
        let claim_ids: Vec<u32> = Vec::from_array(
            &e,
            [reserve_id * 2 + 1, reserve_id * 2],
        );

        check_positive_amount(reward_threshold).expect("reward_threshold must be positive");

        let config = Config {
            asset: asset.clone(),
            pool,
            reserve_id,
            blend_token,
            router,
            claim_ids,
            reward_threshold,
            c_factor,
            target_loops,
            min_hf,
        };

        storage::set_config(&e, config);
        storage::set_keeper(&e, &keeper);
        storage::set_version(&e, STRATEGY_VERSION);
    }

    fn asset(e: Env) -> Result<Address, StrategyError> {
        extend_instance_ttl(&e);
        Ok(storage::get_config(&e).asset)
    }

    /// Deposit underlying asset, execute leverage loop, mint shares.
    ///
    /// Flow:
    /// 1. Transfer `amount` from `from` to the strategy contract
    /// 2. Execute N-loop leverage: SupplyCollateral+Borrow × N + final SupplyCollateral
    /// 3. Track b/d token deltas, mint proportional shares
    /// 4. Return the depositor's underlying balance
    fn deposit(e: Env, amount: i128, from: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        check_positive_amount(amount)?;
        from.require_auth();

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);

        // Safety: check pool utilization before depositing
        let (pool_supply, pool_borrow) = blend_pool::get_pool_utilization(&e, &config);
        let (add_supply, add_borrow) =
            compute_totals(amount, config.c_factor, config.target_loops);

        // Compute projected position for HF check
        let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
        let proj_b = reserves
            .total_b_tokens
            .checked_add(
                add_supply
                    .checked_mul(SCALAR_12)
                    .unwrap_or(0)
                    .checked_div(b_rate.max(1))
                    .unwrap_or(0),
            )
            .unwrap_or(reserves.total_b_tokens);
        let proj_d = reserves
            .total_d_tokens
            .checked_add(
                add_borrow
                    .checked_mul(SCALAR_12)
                    .unwrap_or(0)
                    .checked_div(d_rate.max(1))
                    .unwrap_or(0),
            )
            .unwrap_or(reserves.total_d_tokens);

        check_deposit_safety(
            &e,
            pool_supply,
            pool_borrow,
            add_supply,
            add_borrow,
            proj_b,
            proj_d,
            b_rate,
            d_rate,
            &config,
        )?;

        // Transfer the initial deposit from user to strategy contract
        let token_client = TokenClient::new(&e, &config.asset);
        token_client.transfer(&from, &e.current_contract_address(), &amount);

        // Execute the leverage loop — contract sends `amount` to pool,
        // pool processes supply+borrow atomically, netting means only `amount` leaves
        let (b_delta, d_delta) = blend_pool::submit_leverage_loop(&e, amount, &config)?;

        // Account for the deposit: mint shares proportional to equity added
        let (vault_shares, updated_reserves) =
            reserves::deposit(&e, &from, b_delta, d_delta, &reserves)?;

        let underlying_balance = shares_to_underlying(vault_shares, &updated_reserves)?;

        event::emit_deposit(
            &e,
            String::from_str(&e, STRATEGY_NAME),
            amount,
            from,
        );

        Ok(underlying_balance)
    }

    /// Harvest BLND emissions, swap to underlying, re-leverage.
    ///
    /// Callable only by the keeper. Claims from both supply and borrow emission
    /// sides, swaps BLND → underlying via Soroswap, then re-leverages proceeds.
    /// No new shares are minted — this increases per-share equity.
    fn harvest(e: Env, from: Address, data: Option<Bytes>) -> Result<(), StrategyError> {
        extend_instance_ttl(&e);

        let keeper = storage::get_keeper(&e);
        keeper.require_auth();

        if from != keeper {
            return Err(StrategyError::NotAuthorized);
        }

        let config = storage::get_config(&e);

        // Claim BLND from both supply and borrow sides
        let harvested_blnd = blend_pool::claim(&e, &config);

        // Parse minimum swap output from data bytes
        let amount_out_min: i128 = match &data {
            Some(bytes) if !bytes.is_empty() => {
                let mut slice = [0u8; 16];
                bytes.copy_into_slice(&mut slice);
                i128::from_be_bytes(slice)
            }
            _ => 0,
        };

        // Swap BLND → underlying, then re-leverage
        let (b_delta, d_delta) = blend_pool::perform_reinvest(&e, &config, amount_out_min)?;

        // Update reserves without minting shares (yield accrues to existing holders)
        if b_delta > 0 {
            let updated_reserves = reserves::harvest(&e, b_delta, d_delta, &config)?;
            event::emit_harvest(
                &e,
                String::from_str(&e, STRATEGY_NAME),
                harvested_blnd,
                keeper,
                shares_to_underlying(SCALAR_12, &updated_reserves)?,
            );
        }

        Ok(())
    }

    /// Withdraw underlying by unwinding proportional leverage.
    ///
    /// Flow:
    /// 1. Calculate proportional b/d tokens for the requested amount
    /// 2. Submit unwind: repay proportional debt, withdraw proportional collateral
    /// 3. Burn shares, transfer equity to `to`
    /// 4. Return the depositor's remaining underlying balance
    fn withdraw(e: Env, amount: i128, from: Address, to: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        check_positive_amount(amount)?;
        from.require_auth();

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);

        // Calculate proportional b/d tokens to unwind
        let (remaining_shares, b_to_remove, d_to_remove, updated_reserves) =
            reserves::withdraw(&e, &from, amount, &reserves)?;

        // Execute unwind on the pool — net equity flows to `to`
        blend_pool::submit_unwind(&e, b_to_remove, d_to_remove, &to, &config)?;

        let underlying_balance = shares_to_underlying(remaining_shares, &updated_reserves)?;

        event::emit_withdraw(
            &e,
            String::from_str(&e, STRATEGY_NAME),
            amount,
            from,
        );

        Ok(underlying_balance)
    }

    /// Query the underlying asset balance for an address.
    ///
    /// balance = caller_shares / total_shares × (supply_value - debt_value)
    fn balance(e: Env, from: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);

        let vault_shares = storage::get_vault_shares(&e, &from);
        if vault_shares <= 0 {
            return Ok(0);
        }

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);
        shares_to_underlying(vault_shares, &reserves)
    }
}

// ── Additional public methods (not part of the trait) ────────────────────────

#[contractimpl]
impl BlendLeverageStrategy {
    /// Rebalance: auto-deleverage if health factor is below min_hf.
    /// Callable by anyone (permissionless — protects the vault).
    pub fn rebalance(e: Env) -> Result<(), StrategyError> {
        extend_instance_ttl(&e);

        let config = storage::get_config(&e);
        let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
        let (b_tokens, d_tokens) = blend_pool::get_strategy_positions(&e, &config);

        if d_tokens == 0 {
            return Ok(()); // No debt, nothing to rebalance
        }

        let hf = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, config.c_factor)?;

        if hf >= config.min_hf {
            return Ok(()); // HF is healthy
        }

        // Compute how many loops to unwind
        let unwind_count = compute_unwind_loops(
            b_tokens, d_tokens, b_rate, d_rate, config.c_factor, config.min_hf,
        )?;

        if unwind_count == 0 {
            return Ok(());
        }

        // Execute deleverage
        let (b_removed, d_removed) =
            blend_pool::submit_deleverage(&e, unwind_count, &config)?;

        // Update reserves accounting
        reserves::deleverage(&e, b_removed, d_removed, &config)?;

        Ok(())
    }

    /// Set a new keeper address. Only the current keeper can call this.
    pub fn set_keeper(e: Env, new_keeper: Address) -> Result<(), StrategyError> {
        extend_instance_ttl(&e);
        let old_keeper = storage::get_keeper(&e);
        old_keeper.require_auth();
        storage::set_keeper(&e, &new_keeper);
        Ok(())
    }

    /// Get current keeper address.
    pub fn get_keeper(e: Env) -> Result<Address, StrategyError> {
        extend_instance_ttl(&e);
        Ok(storage::get_keeper(&e))
    }

    /// Get the strategy version number (1 = V1, 2 = V2, …).
    pub fn get_version(e: Env) -> Result<u32, StrategyError> {
        extend_instance_ttl(&e);
        Ok(storage::get_version(&e))
    }

    /// Get current health factor (1e7 scaled).
    pub fn health_factor(e: Env) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        let config = storage::get_config(&e);
        let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
        let (b_tokens, d_tokens) = blend_pool::get_strategy_positions(&e, &config);
        compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, config.c_factor)
    }

    /// Get current strategy position details.
    /// Returns (total_equity, total_shares, b_tokens, d_tokens, b_rate, d_rate).
    pub fn position(e: Env) -> Result<(i128, i128, i128, i128, i128, i128), StrategyError> {
        extend_instance_ttl(&e);
        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);
        let equity = leverage::compute_equity(&reserves)?;
        Ok((
            equity,
            reserves.total_shares,
            reserves.total_b_tokens,
            reserves.total_d_tokens,
            reserves.b_rate,
            reserves.d_rate,
        ))
    }

    /// Migrate user's position from this strategy (V1) to a new strategy (V2) atomically.
    ///
    /// Flow (single transaction):
    /// 1. Require user's signature.
    /// 2. Burn user's V1 shares; compute their proportional b/d tokens.
    /// 3. Unwind that position on Blend pool → equity (underlying) lands in V1.
    /// 4. Transfer equity to V2.
    /// 5. Call V2.receive_migration(from, equity) — V2 re-leverages and mints V2 shares.
    ///
    /// HF is preserved because the unwind and re-leverage are symmetric:
    /// the same equity is re-deployed at the same c_factor/target_loops.
    pub fn migrate(e: Env, from: Address, to_strategy: Address) -> Result<(), StrategyError> {
        extend_instance_ttl(&e);
        from.require_auth();

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);

        // Burn V1 shares and get proportional b/d tokens.
        // Treat as a full close when the user owns all non-lockup shares: the
        // FIRST_DEPOSIT_LOCKUP shares are permanently locked in total_shares but
        // never credited to any user, so user_shares == total_shares - LOCKUP for
        // a sole depositor. A full-close uses a single atomic repay+withdraw sweep
        // (i64::MAX sentinel) which avoids per-step HF failures after interest accrual.
        let user_shares = storage::get_vault_shares(&e, &from);
        let is_full_close = reserves.total_shares
            .checked_sub(user_shares)
            .unwrap_or(0)
            <= crate::constants::FIRST_DEPOSIT_LOCKUP;

        let (b_tokens_to_remove, d_tokens_to_remove, _) =
            reserves::migrate_withdraw(&e, &from, &reserves)?;

        // For a full close, use pool-actual positions to handle interest accrual
        // since the last accounting update (d_rate may have grown).
        // Pass i64::MAX as d_tokens_to_remove so submit_unwind takes the full-close
        // path regardless of any rate accrual between the two get_positions calls.
        let (unwind_b, unwind_d) = if is_full_close {
            let (pool_b, _) = blend_pool::get_strategy_positions(&e, &config);
            (pool_b, i64::MAX as i128)
        } else {
            (b_tokens_to_remove, d_tokens_to_remove)
        };

        // Unwind position on Blend pool; equity is transferred to V2
        let equity = blend_pool::unwind_to(
            &e,
            unwind_b,
            unwind_d,
            &to_strategy,
            &config,
        )?;

        if equity <= 0 {
            return Err(StrategyError::UnderlyingAmountBelowMin);
        }

        // V2 re-leverages the pre-funded tokens and mints shares for `from`
        e.invoke_contract::<i128>(
            &to_strategy,
            &soroban_sdk::Symbol::new(&e, "receive_migration"),
            soroban_sdk::vec![&e, from.into_val(&e), equity.into_val(&e)],
        );

        Ok(())
    }

    /// Accept pre-funded underlying tokens from a V1 migration and re-leverage them.
    ///
    /// Called by V1's `migrate()` after it has already transferred `amount` underlying
    /// tokens to this contract. Re-leverages and mints shares for `to`.
    /// No `transfer_from` is performed — tokens are already in this contract.
    pub fn receive_migration(e: Env, to: Address, amount: i128) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        check_positive_amount(amount)?;

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);

        // Re-leverage the tokens already held by this contract
        let (b_delta, d_delta) = blend_pool::submit_leverage_loop(&e, amount, &config)?;

        let (vault_shares, updated_reserves) =
            reserves::deposit(&e, &to, b_delta, d_delta, &reserves)?;

        let underlying_balance = shares_to_underlying(vault_shares, &updated_reserves)?;

        event::emit_deposit(
            &e,
            String::from_str(&e, STRATEGY_NAME),
            amount,
            to,
        );

        Ok(underlying_balance)
    }

    /// Absorbs unassigned b_tokens and d_tokens that were transferred to this strategy.
    /// Kept for emergency recovery.
    pub fn absorb(e: Env, to: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);

        let (pool_b, pool_d) = blend_pool::get_strategy_positions(&e, &config);

        let b_diff = pool_b.checked_sub(reserves.total_b_tokens).unwrap_or(0);
        let d_diff = pool_d.checked_sub(reserves.total_d_tokens).unwrap_or(0);

        if b_diff <= 0 && d_diff <= 0 {
            return Ok(0);
        }

        let (vault_shares, _) = reserves::deposit(&e, &to, b_diff, d_diff, &reserves)?;
        Ok(vault_shares)
    }
}

