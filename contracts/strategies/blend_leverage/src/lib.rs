#![no_std]
// Cosmetic only: many 1e7/1e12-scaled financial literals use intentional
// non-uniform underscore grouping for readability (e.g. 10_500_000 = 1.05).
// Rewriting 100+ numeric constants risks a value typo in a fund-holding
// contract, so this purely-stylistic lint is allowed crate-wide.
#![allow(clippy::inconsistent_digit_grouping)]
// TODO(events): migrate `e.events().publish(...)` to the #[contractevent]
// macro alongside the SEP-41 receipt-token event rework (SCF T1 D2), then
// drop this allow.
#![allow(deprecated)]

mod blend_pool;
mod constants;
mod leverage;
mod reserves;
mod soroswap;
mod storage;

#[cfg(test)]
mod test_integration;
#[cfg(test)]
mod test_leverage;

use constants::SCALAR_12;
pub use defindex_strategy_core::{event, DeFindexStrategyTrait, StrategyError};
use leverage::{
    check_deposit_safety, compute_health_factor, compute_partial_unwind, compute_totals,
    shares_to_underlying,
};
use soroban_sdk::{
    contract, contractclient, contractimpl, token::TokenClient, Address, Bytes, BytesN, Env,
    IntoVal, String, Symbol, Val, Vec,
};
use storage::{extend_instance_ttl, Config};

/// Cross-contract client for the SEP-41 vault-share token (the per-user share
/// ledger). The strategy is the token's minter, so `mint`/`burn_by_minter`
/// auth is satisfied automatically when the strategy is the direct caller.
#[contractclient(name = "ShareTokenClient")]
pub trait ShareTokenInterface {
    fn mint(e: Env, to: Address, amount: i128);
    fn burn_by_minter(e: Env, from: Address, amount: i128);
    fn balance(e: Env, id: Address) -> i128;
    fn total_supply(e: Env) -> i128;
}

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
    ///   [8] orange_hf: i128        — orange-zone threshold; partial unwind triggered below this (1e7)
    ///   [9] admin: Address         — authorized to upgrade the contract and set the share token
    fn __constructor(e: Env, asset: Address, init_args: Vec<Val>) {
        let pool: Address = init_args
            .get(0)
            .expect("Missing: pool address")
            .into_val(&e);
        let blend_token: Address = init_args.get(1).expect("Missing: blend_token").into_val(&e);
        let router: Address = init_args.get(2).expect("Missing: router").into_val(&e);
        let reward_threshold: i128 = init_args
            .get(3)
            .expect("Missing: reward_threshold")
            .into_val(&e);
        let keeper: Address = init_args.get(4).expect("Missing: keeper").into_val(&e);
        let c_factor: i128 = init_args.get(5).expect("Missing: c_factor").into_val(&e);
        let target_loops: u32 = init_args
            .get(6)
            .expect("Missing: target_loops")
            .into_val(&e);
        let min_hf: i128 = init_args.get(7).expect("Missing: min_hf").into_val(&e);
        let orange_hf: i128 = init_args.get(8).expect("Missing: orange_hf").into_val(&e);
        let admin: Address = init_args.get(9).expect("Missing: admin").into_val(&e);

        // Look up the reserve index from the pool
        let pool_client = blend_contract_sdk::pool::Client::new(&e, &pool);
        let reserve = pool_client.get_reserve(&asset);
        let reserve_id = reserve.config.index;

        // Claim IDs: supply side = index*2+1, borrow side = index*2
        let claim_ids: Vec<u32> = Vec::from_array(&e, [reserve_id * 2 + 1, reserve_id * 2]);

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
            orange_hf,
        };

        storage::set_config(&e, config);
        storage::set_keeper(&e, &keeper);
        storage::set_admin(&e, &admin);
        storage::set_version(&e, 1);
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
        let (add_supply, add_borrow) = compute_totals(amount, config.c_factor, config.target_loops);

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
        token_client.transfer(&from, e.current_contract_address(), &amount);

        // Execute the leverage loop — contract sends `amount` to pool,
        // pool processes supply+borrow atomically, netting means only `amount` leaves
        let (b_delta, d_delta) = blend_pool::submit_leverage_loop(&e, amount, &config)?;

        // Account for the deposit: compute the shares to mint.
        let (vault_minted, lockup, updated_reserves) =
            reserves::deposit(&e, b_delta, d_delta, &reserves)?;

        // Mint share tokens to the depositor. On the first deposit, mint the
        // inflation-lockup portion to the strategy's own (inert) address so the
        // token's total_supply stays equal to total_shares.
        let token = ShareTokenClient::new(&e, &storage::get_share_token(&e));
        token.mint(&from, &vault_minted);
        if lockup > 0 {
            token.mint(&e.current_contract_address(), &lockup);
        }

        let user_shares = token.balance(&from);
        let underlying_balance = shares_to_underlying(user_shares, &updated_reserves)?;

        event::emit_deposit(&e, String::from_str(&e, STRATEGY_NAME), amount, from);

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
        let (b_delta, d_delta, realized_underlying) =
            blend_pool::perform_reinvest(&e, &config, amount_out_min)?;

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

            // Emit custom event for realized underlying
            e.events().publish(
                (
                    Symbol::new(&e, "harvest_realized"),
                    String::from_str(&e, STRATEGY_NAME),
                ),
                realized_underlying,
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

        // Read the caller's share balance from the token (the per-user ledger).
        let token = ShareTokenClient::new(&e, &storage::get_share_token(&e));
        let user_shares = token.balance(&from);

        // Calculate shares to burn + the intended proportional b/d tokens to
        // unwind. This does NOT persist the position (see `commit_withdraw`).
        let (shares_to_burn, b_to_remove, d_to_remove, _preview) =
            reserves::withdraw(&e, user_shares, amount, &reserves)?;

        // Burn the caller's shares (minter burn — from already authorized above).
        token.burn_by_minter(&from, &shares_to_burn);

        // Execute unwind on the pool — net equity flows to `to`. The returned
        // deltas are the b/d tokens the pool *actually* removed.
        let (b_removed, d_removed) =
            blend_pool::submit_unwind(&e, b_to_remove, d_to_remove, &to, &config)?;

        // Persist using the measured pool deltas so stored reserves stay in
        // lock-step with the real pool position (Finding ①), matching the
        // measured-delta discipline of deposit/harvest/deleverage.
        let updated_reserves =
            reserves::commit_withdraw(&e, shares_to_burn, b_removed, d_removed, &reserves)?;

        let remaining_shares = user_shares
            .checked_sub(shares_to_burn)
            .ok_or(StrategyError::UnderflowOverflow)?;
        let underlying_balance = shares_to_underlying(remaining_shares, &updated_reserves)?;

        event::emit_withdraw(&e, String::from_str(&e, STRATEGY_NAME), amount, from);

        Ok(underlying_balance)
    }

    /// Query the underlying asset balance for an address.
    ///
    /// balance = caller_shares / total_shares × (supply_value - debt_value)
    fn balance(e: Env, from: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);

        let token = ShareTokenClient::new(&e, &storage::get_share_token(&e));
        let user_shares = token.balance(&from);
        if user_shares <= 0 {
            return Ok(0);
        }

        let config = storage::get_config(&e);
        let reserves = reserves::get_strategy_reserves_updated(&e, &config);
        shares_to_underlying(user_shares, &reserves)
    }
}

/// Shared partial-unwind: if HF is below `target_hf`, unwind the minimal loops
/// to restore it. Returns `(before_hf, after_hf, loops_unwound)`. A no-op
/// (loops = 0) when there is no debt or HF is already at/above target.
fn unwind_to(
    e: &Env,
    config: &Config,
    target_hf: i128,
) -> Result<(i128, i128, u32), StrategyError> {
    let (b_rate, d_rate) = blend_pool::get_rates(e, config);
    let (b_tokens, d_tokens) = blend_pool::get_strategy_positions(e, config);

    if d_tokens == 0 {
        return Ok((i128::MAX, i128::MAX, 0));
    }

    let before_hf = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, config.c_factor)?;
    if before_hf >= target_hf {
        return Ok((before_hf, before_hf, 0));
    }

    let (_, loops) = compute_partial_unwind(
        b_tokens,
        d_tokens,
        b_rate,
        d_rate,
        config.c_factor,
        target_hf,
    )?;
    if loops == 0 {
        return Ok((before_hf, before_hf, 0));
    }

    let (b_removed, d_removed) = blend_pool::submit_deleverage(e, loops, config)?;
    reserves::deleverage(e, b_removed, d_removed, config)?;

    // Recompute HF on the post-unwind position for the event / return.
    let (b2, d2) = blend_pool::get_strategy_positions(e, config);
    let after_hf = if d2 == 0 {
        i128::MAX
    } else {
        compute_health_factor(b2, d2, b_rate, d_rate, config.c_factor)?
    };

    Ok((before_hf, after_hf, loops))
}

/// Emit a rebalance event: topics `("rebalance", caller)`, data
/// `(before_hf, after_hf, loops_unwound)` (HF in 1e7 scale).
fn emit_rebalance(e: &Env, caller: &Address, before_hf: i128, after_hf: i128, loops: u32) {
    e.events().publish(
        (Symbol::new(e, "rebalance"), caller.clone()),
        (before_hf, after_hf, loops),
    );
}

// ── Additional public methods (not part of the trait) ────────────────────────

#[contractimpl]
impl BlendLeverageStrategy {
    /// Rebalance: partial-unwind if HF is in the orange zone (HF < orange_hf),
    /// restoring HF to orange_hf. Callable by anyone (permissionless — protects
    /// the vault). Emits a `rebalance` event when loops are unwound.
    pub fn rebalance(e: Env) -> Result<(), StrategyError> {
        extend_instance_ttl(&e);
        let config = storage::get_config(&e);
        let caller = e.current_contract_address();
        let (before_hf, after_hf, loops) = unwind_to(&e, &config, config.orange_hf)?;
        if loops > 0 {
            emit_rebalance(&e, &caller, before_hf, after_hf, loops);
        }
        Ok(())
    }

    /// Keeper-authorised, rate-limited auto-rebalance. Unwinds the minimal loops
    /// to restore HF to orange_hf when HF has dropped into the orange zone.
    /// Limited to once per `REBALANCE_COOLDOWN_LEDGERS`; emits a `rebalance`
    /// event with before/after HF and loops unwound. Returns loops unwound.
    pub fn rebalance_keeper(e: Env, caller: Address) -> Result<u32, StrategyError> {
        extend_instance_ttl(&e);
        let keeper = storage::get_keeper(&e);
        keeper.require_auth();
        if caller != keeper {
            return Err(StrategyError::NotAuthorized);
        }

        // Rate-limit.
        let now = e.ledger().sequence();
        let last = storage::get_last_rebalance(&e);
        if last != 0 && now < last.saturating_add(constants::REBALANCE_COOLDOWN_LEDGERS) {
            return Err(StrategyError::NotAuthorized);
        }

        let config = storage::get_config(&e);
        let (before_hf, after_hf, loops) = unwind_to(&e, &config, config.orange_hf)?;
        if loops > 0 {
            storage::set_last_rebalance(&e, now);
            emit_rebalance(&e, &caller, before_hf, after_hf, loops);
        }
        Ok(loops)
    }

    /// Partial-unwind liquidation protection: unwind just enough loops to restore
    /// HF to `target_hf`. Callable by the keeper, or by anyone when HF is already
    /// in the orange zone. `target_hf` is floored at config.orange_hf to prevent
    /// over-unwinding. Emits a `rebalance` event when loops are unwound.
    pub fn partial_unwind(e: Env, caller: Address, target_hf: i128) -> Result<u32, StrategyError> {
        extend_instance_ttl(&e);
        let config = storage::get_config(&e);
        let (b_rate, d_rate) = blend_pool::get_rates(&e, &config);
        let (b_tokens, d_tokens) = blend_pool::get_strategy_positions(&e, &config);

        if d_tokens == 0 {
            return Ok(0);
        }

        let hf = compute_health_factor(b_tokens, d_tokens, b_rate, d_rate, config.c_factor)?;

        // Only the keeper can trigger above the orange zone; anyone can inside it.
        if hf >= config.orange_hf {
            let keeper = storage::get_keeper(&e);
            if caller != keeper {
                return Err(StrategyError::NotAuthorized);
            }
        }
        caller.require_auth();

        let effective_target = target_hf.max(config.orange_hf);
        let (before_hf, after_hf, loops) = unwind_to(&e, &config, effective_target)?;
        if loops > 0 {
            emit_rebalance(&e, &caller, before_hf, after_hf, loops);
        }
        Ok(loops)
    }

    /// Set a new keeper address. Only the current keeper can call this.
    pub fn set_keeper(e: Env, new_keeper: Address) -> Result<(), StrategyError> {
        extend_instance_ttl(&e);
        let old_keeper = storage::get_keeper(&e);
        old_keeper.require_auth();
        storage::set_keeper(&e, &new_keeper);
        Ok(())
    }

    /// Get the current keeper address.
    pub fn get_keeper(e: Env) -> Result<Address, StrategyError> {
        extend_instance_ttl(&e);
        Ok(storage::get_keeper(&e))
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

    /// Upgrade the contract WASM in place (admin-gated).
    ///
    /// All persistent storage (Config, Reserves, per-user VaultPos, Keeper,
    /// Admin) is preserved across the upgrade, so user health factors and
    /// balances are untouched — no exit/re-enter required. The version counter
    /// is bumped for observability. See docs/migration-runbook.md.
    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) -> Result<(), StrategyError> {
        let admin = storage::get_admin(&e);
        admin.require_auth();
        e.deployer().update_current_contract_wasm(new_wasm_hash);
        storage::set_version(&e, storage::get_version(&e).saturating_add(1));
        Ok(())
    }

    /// Current contract version (1 at deploy, bumped on each upgrade).
    pub fn version(e: Env) -> u32 {
        storage::get_version(&e)
    }

    /// The admin authorized to upgrade the contract and set the share token.
    pub fn admin(e: Env) -> Address {
        storage::get_admin(&e)
    }

    /// Set the SEP-41 vault-share token (admin-gated, one-time wiring).
    ///
    /// The token must already be deployed with this strategy as its minter.
    /// Required before the first deposit. On a fresh deploy the token is the
    /// per-user ledger from day one; for an upgraded legacy deployment, call
    /// `migrate_position` per holder afterwards.
    pub fn set_share_token(e: Env, token: Address) -> Result<(), StrategyError> {
        storage::get_admin(&e).require_auth();
        storage::set_share_token(&e, &token);
        extend_instance_ttl(&e);
        Ok(())
    }

    /// The configured share token, or an error if not yet set.
    pub fn share_token(e: Env) -> Result<Address, StrategyError> {
        if storage::has_share_token(&e) {
            Ok(storage::get_share_token(&e))
        } else {
            Err(StrategyError::NotAuthorized)
        }
    }

    /// Migrate a legacy `VaultPos` holder onto the share token: mint their
    /// shares into the token and zero the legacy entry. Permissionless and
    /// idempotent (it only moves a holder's own shares into their token
    /// balance — no theft possible). Used once after upgrading a deployment
    /// that predates the token; fresh deploys never need it.
    pub fn migrate_position(e: Env, holder: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        let legacy = storage::get_vault_shares(&e, &holder);
        if legacy <= 0 {
            return Ok(0);
        }
        let token = ShareTokenClient::new(&e, &storage::get_share_token(&e));
        token.mint(&holder, &legacy);
        storage::set_vault_shares(&e, &holder, 0);
        Ok(legacy)
    }

    // ── Split harvest for pluggable swap routing (T2.1) ──────────────────────
    //
    // The DeFindex-trait `harvest` stays as the atomic on-chain Soroswap path.
    // These keeper entrypoints let an off-chain keeper choose the best swap venue
    // per harvest (Stellar Broker vs Soroswap): `harvest_claim` claims BLND and
    // approves the keeper's swap account to pull it (for an off-chain Broker swap)
    // while leaving it recoverable for the on-chain Soroswap fallback;
    // `harvest_reinvest` executes whichever path the keeper chose and re-leverages.

    /// Set the keeper-controlled account allowed to pull claimed BLND for an
    /// off-chain swap (admin-gated).
    pub fn set_swap_account(e: Env, account: Address) -> Result<(), StrategyError> {
        storage::get_admin(&e).require_auth();
        storage::set_swap_account(&e, &account);
        extend_instance_ttl(&e);
        Ok(())
    }

    /// The configured swap account, or an error if unset.
    pub fn swap_account(e: Env) -> Result<Address, StrategyError> {
        if storage::has_swap_account(&e) {
            Ok(storage::get_swap_account(&e))
        } else {
            Err(StrategyError::NotAuthorized)
        }
    }

    /// Keeper-gated: claim BLND emissions into the strategy and approve the swap
    /// account to pull them (if set) for an off-chain Broker swap. The BLND stays
    /// in the contract until pulled, so the on-chain Soroswap path remains a valid
    /// fallback. Returns the BLND balance available to swap.
    pub fn harvest_claim(e: Env, from: Address) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        let keeper = storage::get_keeper(&e);
        keeper.require_auth();
        if from != keeper {
            return Err(StrategyError::NotAuthorized);
        }

        let config = storage::get_config(&e);
        blend_pool::claim(&e, &config);

        let blnd = TokenClient::new(&e, &config.blend_token);
        let bal = blnd.balance(&e.current_contract_address());
        if bal > 0 && storage::has_swap_account(&e) {
            let expiration = e.ledger().sequence().saturating_add(17_280); // ~1 day
            blnd.approve(
                &e.current_contract_address(),
                &storage::get_swap_account(&e),
                &bal,
                &expiration,
            );
        }

        e.events()
            .publish((Symbol::new(&e, "harvest_claim"), keeper), bal);
        Ok(bal)
    }

    /// Keeper-gated: re-leverage harvested proceeds via the chosen route.
    ///
    /// - `via_soroswap = true`: swap the strategy's BLND → underlying on-chain
    ///   through Soroswap (mandatory non-zero `amount_out_min`), then re-leverage.
    /// - `via_soroswap = false` (Broker): the keeper has already swapped off-chain
    ///   and transferred `amount_in` of underlying back to the strategy; re-leverage
    ///   it directly (asserted to be held). `amount_out_min` is ignored here.
    ///
    /// Emits a `harvest_route` event `(route, amount_in, amount_out_min, realized)`
    /// for the keeper's A/B telemetry. Returns realized underlying re-leveraged.
    pub fn harvest_reinvest(
        e: Env,
        from: Address,
        amount_in: i128,
        via_soroswap: bool,
        amount_out_min: i128,
    ) -> Result<i128, StrategyError> {
        extend_instance_ttl(&e);
        let keeper = storage::get_keeper(&e);
        keeper.require_auth();
        if from != keeper {
            return Err(StrategyError::NotAuthorized);
        }
        check_positive_amount(amount_in)?;
        let config = storage::get_config(&e);

        let (b_delta, d_delta, realized) = if via_soroswap {
            // Mandatory slippage protection on the on-chain swap.
            if amount_out_min <= 0 {
                return Err(StrategyError::OnlyPositiveAmountAllowed);
            }
            blend_pool::perform_reinvest(&e, &config, amount_out_min)?
        } else {
            let (b, d) = blend_pool::reinvest_underlying(&e, &config, amount_in)?;
            (b, d, amount_in)
        };

        if b_delta > 0 {
            let updated = reserves::harvest(&e, b_delta, d_delta, &config)?;
            event::emit_harvest(
                &e,
                String::from_str(&e, STRATEGY_NAME),
                realized,
                keeper.clone(),
                shares_to_underlying(SCALAR_12, &updated)?,
            );
        }

        e.events().publish(
            (Symbol::new(&e, "harvest_route"), keeper),
            (
                if via_soroswap { 0u32 } else { 1u32 },
                amount_in,
                amount_out_min,
                realized,
            ),
        );
        Ok(realized)
    }
}
