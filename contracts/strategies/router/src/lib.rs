#![no_std]

mod storage;

use soroban_sdk::{
    contract, contractclient, contractimpl, contracterror, token::TokenClient, Address, Env,
    IntoVal, Symbol, Val, Vec,
};
use storage::{extend_instance_ttl, StrategyEntry, UserPosition};

// ── Router errors ─────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RouterError {
    NoStrategiesRegistered = 1,
    StrategyNotFound = 2,
    NoPositionFound = 3,
    InsufficientBalance = 4,
    ArithmeticError = 5,
    Unauthorized = 6,
    InvalidAmount = 7,
    StrategyAlreadyRegistered = 8,
}

// ── Strategy interface (minimal client) ───────────────────────────────────────
//
// The router calls these three methods on each underlying strategy contract.
// The signatures match the DeFindexStrategyTrait methods used by all Blend
// leverage strategies; the client is generated from the trait definition here
// so no import of the concrete strategy crate is required.

#[contractclient(name = "StrategyClient")]
pub trait IStrategy {
    fn deposit(e: Env, amount: i128, from: Address) -> i128;
    fn withdraw(e: Env, amount: i128, from: Address, to: Address) -> i128;
    fn balance(e: Env, from: Address) -> i128;
}

// ── Router contract ───────────────────────────────────────────────────────────

#[contract]
pub struct PoolRouter;

#[contractimpl]
impl PoolRouter {
    /// Initialise the router.
    ///
    /// init_args layout:
    ///   [0] admin: Address           — manages the strategy registry and APY updates
    ///   [1..N] strategy: Address     — initial strategy addresses (may be empty)
    pub fn __constructor(e: Env, asset: Address, init_args: Vec<Val>) {
        let admin: Address = init_args
            .get(0)
            .expect("Missing: admin")
            .into_val(&e);

        storage::set_admin(&e, &admin);
        storage::set_asset(&e, &asset);

        // Register any strategy addresses supplied at construction time.
        let mut entries: Vec<StrategyEntry> = Vec::new(&e);
        let mut i = 1u32;
        while let Some(raw) = init_args.get(i) {
            let strategy: Address = raw.into_val(&e);
            entries.push_back(StrategyEntry {
                address: strategy,
                net_apy_bps: 0,
            });
            i += 1;
        }
        storage::set_strategies(&e, &entries);
    }

    // ── Strategy registry management (admin-only) ─────────────────────────────

    /// Add a new strategy to the registry with an initial APY of 0 bps.
    /// The admin must call `update_apy` to set a meaningful rate before deposits
    /// can be routed to this strategy deterministically.
    pub fn add_strategy(e: Env, strategy: Address) -> Result<(), RouterError> {
        extend_instance_ttl(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();

        let mut strategies = storage::get_strategies(&e);
        for i in 0..strategies.len() {
            if strategies.get(i).unwrap().address == strategy {
                return Err(RouterError::StrategyAlreadyRegistered);
            }
        }
        strategies.push_back(StrategyEntry {
            address: strategy,
            net_apy_bps: 0,
        });
        storage::set_strategies(&e, &strategies);
        Ok(())
    }

    /// Remove a strategy from the registry.
    /// Existing user positions in this strategy are unaffected; they can still withdraw.
    pub fn remove_strategy(e: Env, strategy: Address) -> Result<(), RouterError> {
        extend_instance_ttl(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();

        let strategies = storage::get_strategies(&e);
        let mut updated: Vec<StrategyEntry> = Vec::new(&e);
        let mut found = false;
        for i in 0..strategies.len() {
            let entry = strategies.get(i).unwrap();
            if entry.address == strategy {
                found = true;
            } else {
                updated.push_back(entry);
            }
        }
        if !found {
            return Err(RouterError::StrategyNotFound);
        }
        storage::set_strategies(&e, &updated);
        Ok(())
    }

    /// Update the net-APY snapshot for a registered strategy (basis points).
    /// This value is read from an off-chain rate oracle (see B3) and written
    /// on-chain by the admin or a trusted keeper before each routing decision.
    pub fn update_apy(
        e: Env,
        strategy: Address,
        net_apy_bps: i128,
    ) -> Result<(), RouterError> {
        extend_instance_ttl(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();

        // Verify strategy is registered and update its snapshot.
        let mut strategies = storage::get_strategies(&e);
        let mut found = false;
        for i in 0..strategies.len() {
            let mut entry = strategies.get(i).unwrap();
            if entry.address == strategy {
                entry.net_apy_bps = net_apy_bps;
                strategies.set(i, entry);
                found = true;
                break;
            }
        }
        if !found {
            return Err(RouterError::StrategyNotFound);
        }
        storage::set_strategies(&e, &strategies);
        storage::set_strategy_apy(&e, &strategy, net_apy_bps);
        Ok(())
    }

    /// Transfer the admin role to a new address.
    pub fn set_admin(e: Env, new_admin: Address) -> Result<(), RouterError> {
        extend_instance_ttl(&e);
        let admin = storage::get_admin(&e);
        admin.require_auth();
        storage::set_admin(&e, &new_admin);
        Ok(())
    }

    // ── Deposit ───────────────────────────────────────────────────────────────

    /// Deposit `amount` of the underlying asset into the best-APY strategy.
    ///
    /// The router:
    ///   1. Selects the registered strategy with the highest `net_apy_bps`.
    ///   2. If `preferred_strategy` is provided and is registered, uses it instead.
    ///   3. Transfers `amount` from `from` to the router, then calls the strategy's
    ///      `deposit` with the router as the depositor.
    ///   4. Issues virtual shares to the user proportional to their contribution.
    ///
    /// Returns the user's underlying value after the deposit.
    pub fn deposit(
        e: Env,
        amount: i128,
        from: Address,
        preferred_strategy: Option<Address>,
    ) -> Result<i128, RouterError> {
        extend_instance_ttl(&e);
        if amount <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        from.require_auth();

        // If the user already has a position, route to their current strategy unless
        // they explicitly request a different one via preferred_strategy.
        let existing_position = storage::get_user_position(&e, &from);
        let chosen = if preferred_strategy.is_some() {
            Self::select_strategy(&e, preferred_strategy)?
        } else if let Some(ref pos) = existing_position {
            pos.strategy.clone()
        } else {
            Self::select_strategy(&e, None)?
        };

        let router_addr = e.current_contract_address();
        let strategy_client = StrategyClient::new(&e, &chosen);

        // Query router's existing balance before deposit for accurate share pricing.
        let router_balance_before = strategy_client.balance(&router_addr);

        // Pull asset from user into the router, then forward to the strategy.
        let asset = storage::get_asset(&e);
        let token = TokenClient::new(&e, &asset);
        token.transfer(&from, &router_addr, &amount);

        let router_balance_after = strategy_client.deposit(&amount, &router_addr);

        // Mint virtual shares for the user proportional to their contribution.
        let total_vs = storage::get_strategy_virtual_shares(&e, &chosen);
        let user_vs = if total_vs == 0 || router_balance_before <= 0 {
            // First depositor into this strategy via the router: 1 virtual share = 1 unit.
            amount
        } else {
            // Proportional allocation: user_vs = amount × total_vs / router_balance_before
            amount
                .checked_mul(total_vs)
                .ok_or(RouterError::ArithmeticError)?
                .checked_div(router_balance_before)
                .ok_or(RouterError::ArithmeticError)?
        };

        let total_vs_after = total_vs + user_vs;
        storage::set_strategy_virtual_shares(&e, &chosen, total_vs_after);

        // Each user holds one position in the router (single strategy).
        // If they already have a position in the same strategy, accumulate shares.
        // To switch strategies, users must withdraw their current position first.
        let new_vs = match &existing_position {
            Some(pos) if pos.strategy == chosen => pos.virtual_shares + user_vs,
            _ => user_vs,
        };
        storage::set_user_position(
            &e,
            &from,
            &UserPosition {
                strategy: chosen.clone(),
                virtual_shares: new_vs,
            },
        );

        e.events().publish(
            (Symbol::new(&e, "RouterDeposit"), from.clone()),
            (chosen, amount, user_vs),
        );

        // Return underlying value: new_vs / total_vs_after × router_balance_after
        let underlying = new_vs
            .checked_mul(router_balance_after)
            .ok_or(RouterError::ArithmeticError)?
            .checked_div(total_vs_after)
            .ok_or(RouterError::ArithmeticError)?;
        Ok(underlying)
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    /// Withdraw `amount` of underlying from the user's strategy position.
    /// The net equity is sent directly to `to`.
    ///
    /// Returns the user's remaining underlying balance after withdrawal.
    pub fn withdraw(
        e: Env,
        amount: i128,
        from: Address,
        to: Address,
    ) -> Result<i128, RouterError> {
        extend_instance_ttl(&e);
        if amount <= 0 {
            return Err(RouterError::InvalidAmount);
        }
        from.require_auth();

        let position = storage::get_user_position(&e, &from)
            .ok_or(RouterError::NoPositionFound)?;
        let strategy = position.strategy.clone();

        let total_vs = storage::get_strategy_virtual_shares(&e, &strategy);
        if total_vs == 0 {
            return Err(RouterError::InsufficientBalance);
        }

        // Determine user's underlying: user_vs / total_vs × router_balance
        let strategy_client = StrategyClient::new(&e, &strategy);
        let router_addr = e.current_contract_address();
        let router_balance = strategy_client.balance(&router_addr);

        let user_underlying = position
            .virtual_shares
            .checked_mul(router_balance)
            .ok_or(RouterError::ArithmeticError)?
            .checked_div(total_vs)
            .ok_or(RouterError::ArithmeticError)?;

        if amount > user_underlying {
            return Err(RouterError::InsufficientBalance);
        }

        // Compute virtual shares to burn: vs_burn = amount × total_vs / router_balance
        let vs_burn = amount
            .checked_mul(total_vs)
            .ok_or(RouterError::ArithmeticError)?
            .checked_div(router_balance)
            .ok_or(RouterError::ArithmeticError)?;

        // Call strategy.withdraw — sends `amount` equity directly to `to`.
        let remaining_router_balance = strategy_client.withdraw(&amount, &router_addr, &to);

        // Update virtual share bookkeeping.
        let new_user_vs = position.virtual_shares.saturating_sub(vs_burn);
        let new_total_vs = total_vs.saturating_sub(vs_burn);
        storage::set_strategy_virtual_shares(&e, &strategy, new_total_vs);

        if new_user_vs == 0 {
            storage::remove_user_position(&e, &from);
        } else {
            storage::set_user_position(
                &e,
                &from,
                &UserPosition {
                    strategy: strategy.clone(),
                    virtual_shares: new_user_vs,
                },
            );
        }

        e.events().publish(
            (Symbol::new(&e, "RouterWithdraw"), from.clone()),
            (strategy, amount),
        );

        // Return user's remaining underlying.
        if new_user_vs == 0 || new_total_vs == 0 {
            return Ok(0);
        }
        let remaining_user = new_user_vs
            .checked_mul(remaining_router_balance)
            .ok_or(RouterError::ArithmeticError)?
            .checked_div(new_total_vs)
            .ok_or(RouterError::ArithmeticError)?;
        Ok(remaining_user)
    }

    // ── Balance ───────────────────────────────────────────────────────────────

    /// Return the underlying asset value of `from`'s position across the router.
    pub fn balance(e: Env, from: Address) -> Result<i128, RouterError> {
        extend_instance_ttl(&e);
        let position = match storage::get_user_position(&e, &from) {
            Some(p) => p,
            None => return Ok(0),
        };

        let total_vs = storage::get_strategy_virtual_shares(&e, &position.strategy);
        if total_vs == 0 {
            return Ok(0);
        }

        let strategy_client = StrategyClient::new(&e, &position.strategy);
        let router_balance = strategy_client.balance(&e.current_contract_address());

        let underlying = position
            .virtual_shares
            .checked_mul(router_balance)
            .ok_or(RouterError::ArithmeticError)?
            .checked_div(total_vs)
            .ok_or(RouterError::ArithmeticError)?;
        Ok(underlying)
    }

    // ── View helpers ──────────────────────────────────────────────────────────

    /// Return the strategy that would be chosen for a new deposit (deterministic).
    /// Useful for front-ends and for letting users preview before confirming.
    pub fn best_strategy(e: Env) -> Result<Address, RouterError> {
        Self::select_strategy(&e, None)
    }

    /// Return all registered strategies with their APY snapshots.
    pub fn strategies(e: Env) -> Vec<StrategyEntry> {
        extend_instance_ttl(&e);
        storage::get_strategies(&e)
    }

    /// Return the current admin address.
    pub fn admin(e: Env) -> Address {
        extend_instance_ttl(&e);
        storage::get_admin(&e)
    }

    /// Return the underlying asset address.
    pub fn asset(e: Env) -> Address {
        extend_instance_ttl(&e);
        storage::get_asset(&e)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    /// Select the strategy with the highest `net_apy_bps`.
    /// If `preferred` is Some and is registered, it is used instead (user override).
    /// Returns `RouterError::NoStrategiesRegistered` if the registry is empty.
    fn select_strategy(
        e: &Env,
        preferred: Option<Address>,
    ) -> Result<Address, RouterError> {
        let strategies = storage::get_strategies(e);
        if strategies.is_empty() {
            return Err(RouterError::NoStrategiesRegistered);
        }

        // User override: verify the preferred strategy is registered.
        if let Some(pref) = preferred {
            for i in 0..strategies.len() {
                if strategies.get(i).unwrap().address == pref {
                    return Ok(pref);
                }
            }
            return Err(RouterError::StrategyNotFound);
        }

        // Deterministic best-pick: highest net_apy_bps wins.
        // Ties are broken by position in the registry (earlier = preferred), making
        // the selection stable across identical snapshots.
        let mut best_addr = strategies.get(0).unwrap().address.clone();
        let mut best_apy = strategies.get(0).unwrap().net_apy_bps;

        for i in 1..strategies.len() {
            let entry = strategies.get(i).unwrap();
            if entry.net_apy_bps > best_apy {
                best_apy = entry.net_apy_bps;
                best_addr = entry.address.clone();
            }
        }

        Ok(best_addr)
    }
}
