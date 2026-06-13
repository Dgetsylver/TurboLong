/// SEP-41 receipt token for BlendLeverageStrategy vault shares.
///
/// Each "share" in storage maps 1:1 to one receipt token unit.
/// Transfer moves the full proportional claim on the underlying b/d-token
/// position from sender to receiver — no new leverage is opened or closed.
///
/// Backward-compatible: existing depositors already have shares in storage;
/// their balance is immediately queryable via `receipt_balance`.
use crate::storage;
use defindex_strategy_core::StrategyError;
use soroban_sdk::{contractimpl, symbol_short, Address, Env, String};

use crate::{BlendLeverageStrategy, BlendLeverageStrategyArgs, BlendLeverageStrategyClient};

// ── SEP-41 interface ─────────────────────────────────────────────────────────

#[contractimpl]
impl BlendLeverageStrategy {
    /// Returns the number of decimals used by the receipt token.
    /// Matches the underlying asset convention (7 decimals).
    pub fn receipt_decimals(_e: Env) -> u32 {
        7
    }

    /// Human-readable name of the receipt token.
    pub fn receipt_name(e: Env) -> String {
        String::from_str(&e, "BlendLeverage Vault Share")
    }

    /// Ticker symbol of the receipt token.
    pub fn receipt_symbol(e: Env) -> String {
        String::from_str(&e, "blvSHARE")
    }

    /// Total supply of receipt tokens (= total vault shares outstanding).
    pub fn receipt_total_supply(e: Env) -> i128 {
        storage::get_strategy_reserves(&e).total_shares
    }

    /// Receipt token balance for `id` (= vault shares held by `id`).
    pub fn receipt_balance(e: Env, id: Address) -> i128 {
        storage::get_vault_shares(&e, &id)
    }

    /// Transfer `amount` receipt tokens (vault shares) from `from` to `to`.
    ///
    /// Moves the proportional claim on the underlying leveraged position.
    /// No pool interaction occurs — only the share accounting is updated.
    pub fn receipt_transfer(
        e: Env,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), StrategyError> {
        if amount <= 0 {
            return Err(StrategyError::OnlyPositiveAmountAllowed);
        }
        from.require_auth();

        let from_shares = storage::get_vault_shares(&e, &from);
        if from_shares < amount {
            return Err(StrategyError::InsufficientBalance);
        }

        let to_shares = storage::get_vault_shares(&e, &to);

        storage::set_vault_shares(
            &e,
            &from,
            from_shares
                .checked_sub(amount)
                .ok_or(StrategyError::UnderflowOverflow)?,
        );
        storage::set_vault_shares(
            &e,
            &to,
            to_shares
                .checked_add(amount)
                .ok_or(StrategyError::UnderflowOverflow)?,
        );

        e.events()
            .publish((symbol_short!("transfer"), from, to), amount);

        Ok(())
    }
}
