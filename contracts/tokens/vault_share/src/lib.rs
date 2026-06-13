#![no_std]
// We emit events with the classic SEP-41 topic format
// (`(symbol, from, to) -> amount`) that DEXes / indexers (incl. Aquarius)
// expect. `events().publish` is deprecated in favor of the newer
// #[contractevent] macro, whose shape differs — keep the standard format.
#![allow(deprecated)]
//! SEP-41 vault-share token for the Turbolong BlendLeverage strategy.
//!
//! A standard, transferable Soroban token (SEP-41) whose balance is the holder's
//! vault-share count. The strategy contract is the sole **minter**: it mints
//! shares to a depositor on `deposit` and burns them on `withdraw`. Because the
//! token is a normal SEP-41 contract, shares are tradable on DEXes / Aquarius
//! without routing through the strategy.
//!
//! This contract is intentionally independent of the strategy: it holds no
//! leverage logic, only share accounting. Minting/burning is gated to the
//! `minter` (the strategy); transfers/approvals are permissionless holder ops.

mod storage;
#[cfg(test)]
mod test;

use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Address, Env, String};
use storage::TokenMetadata;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TokenError {
    NegativeAmount = 1,
    InsufficientBalance = 2,
    InsufficientAllowance = 3,
    BadExpiration = 4,
    NotAuthorized = 5,
}

fn check_nonnegative(amount: i128) -> Result<(), TokenError> {
    if amount < 0 {
        Err(TokenError::NegativeAmount)
    } else {
        Ok(())
    }
}

#[contract]
pub struct VaultShareToken;

#[contractimpl]
impl VaultShareToken {
    /// Initialize the token.
    ///
    /// - `admin`   — may set the minter and upgrade the contract.
    /// - `minter`  — the only account allowed to mint/burn (the strategy).
    /// - `decimals`/`name`/`symbol` — token metadata.
    pub fn __constructor(
        e: Env,
        admin: Address,
        minter: Address,
        decimals: u32,
        name: String,
        symbol: String,
    ) {
        storage::set_admin(&e, &admin);
        storage::set_minter(&e, &minter);
        storage::set_metadata(
            &e,
            &TokenMetadata {
                decimals,
                name,
                symbol,
            },
        );
        storage::extend_instance(&e);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn receive(e: &Env, to: &Address, amount: i128) -> Result<(), TokenError> {
        let bal = storage::get_balance(e, to);
        storage::set_balance(
            e,
            to,
            bal.checked_add(amount).ok_or(TokenError::NegativeAmount)?,
        );
        Ok(())
    }

    fn spend(e: &Env, from: &Address, amount: i128) -> Result<(), TokenError> {
        let bal = storage::get_balance(e, from);
        if bal < amount {
            return Err(TokenError::InsufficientBalance);
        }
        storage::set_balance(e, from, bal - amount);
        Ok(())
    }

    fn spend_allowance(
        e: &Env,
        from: &Address,
        spender: &Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        // Read the raw entry so we can preserve its original expiration.
        let live = match storage::get_allowance_raw(e, from, spender) {
            Some(v) if v.expiration_ledger >= e.ledger().sequence() => v,
            _ => return Err(TokenError::InsufficientAllowance),
        };
        if live.amount < amount {
            return Err(TokenError::InsufficientAllowance);
        }
        storage::set_allowance(
            e,
            from,
            spender,
            live.amount - amount,
            live.expiration_ledger,
        );
        Ok(())
    }

    // ── SEP-41 interface ─────────────────────────────────────────────────────

    pub fn allowance(e: Env, from: Address, spender: Address) -> i128 {
        storage::extend_instance(&e);
        storage::get_allowance(&e, &from, &spender)
    }

    pub fn approve(
        e: Env,
        from: Address,
        spender: Address,
        amount: i128,
        expiration_ledger: u32,
    ) -> Result<(), TokenError> {
        from.require_auth();
        check_nonnegative(amount)?;
        if amount > 0 && expiration_ledger < e.ledger().sequence() {
            return Err(TokenError::BadExpiration);
        }
        storage::set_allowance(&e, &from, &spender, amount, expiration_ledger);
        storage::extend_instance(&e);
        e.events().publish(
            (symbol_short!("approve"), from, spender),
            (amount, expiration_ledger),
        );
        Ok(())
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        storage::extend_instance(&e);
        storage::get_balance(&e, &id)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        check_nonnegative(amount)?;
        Self::spend(&e, &from, amount)?;
        Self::receive(&e, &to, amount)?;
        storage::extend_instance(&e);
        e.events()
            .publish((symbol_short!("transfer"), from, to), amount);
        Ok(())
    }

    pub fn transfer_from(
        e: Env,
        spender: Address,
        from: Address,
        to: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        spender.require_auth();
        check_nonnegative(amount)?;
        Self::spend_allowance(&e, &from, &spender, amount)?;
        Self::spend(&e, &from, amount)?;
        Self::receive(&e, &to, amount)?;
        storage::extend_instance(&e);
        e.events()
            .publish((symbol_short!("transfer"), from, to), amount);
        Ok(())
    }

    pub fn burn(e: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        from.require_auth();
        check_nonnegative(amount)?;
        Self::spend(&e, &from, amount)?;
        storage::set_total_supply(&e, storage::get_total_supply(&e) - amount);
        storage::extend_instance(&e);
        e.events().publish((symbol_short!("burn"), from), amount);
        Ok(())
    }

    pub fn burn_from(
        e: Env,
        spender: Address,
        from: Address,
        amount: i128,
    ) -> Result<(), TokenError> {
        spender.require_auth();
        check_nonnegative(amount)?;
        Self::spend_allowance(&e, &from, &spender, amount)?;
        Self::spend(&e, &from, amount)?;
        storage::set_total_supply(&e, storage::get_total_supply(&e) - amount);
        storage::extend_instance(&e);
        e.events().publish((symbol_short!("burn"), from), amount);
        Ok(())
    }

    pub fn decimals(e: Env) -> u32 {
        storage::get_metadata(&e).decimals
    }

    pub fn name(e: Env) -> String {
        storage::get_metadata(&e).name
    }

    pub fn symbol(e: Env) -> String {
        storage::get_metadata(&e).symbol
    }

    // ── Minter / admin extensions ────────────────────────────────────────────

    /// Mint `amount` shares to `to`. Only the minter (the strategy) may call.
    pub fn mint(e: Env, to: Address, amount: i128) -> Result<(), TokenError> {
        let minter = storage::get_minter(&e);
        minter.require_auth();
        check_nonnegative(amount)?;
        Self::receive(&e, &to, amount)?;
        storage::set_total_supply(&e, storage::get_total_supply(&e) + amount);
        storage::extend_instance(&e);
        e.events()
            .publish((symbol_short!("mint"), minter, to), amount);
        Ok(())
    }

    /// Burn `amount` shares from `from`. Only the minter (the strategy) may
    /// call — used by `withdraw` so the strategy never needs the holder's auth.
    pub fn burn_by_minter(e: Env, from: Address, amount: i128) -> Result<(), TokenError> {
        let minter = storage::get_minter(&e);
        minter.require_auth();
        check_nonnegative(amount)?;
        Self::spend(&e, &from, amount)?;
        storage::set_total_supply(&e, storage::get_total_supply(&e) - amount);
        storage::extend_instance(&e);
        e.events().publish((symbol_short!("burn"), from), amount);
        Ok(())
    }

    pub fn total_supply(e: Env) -> i128 {
        storage::get_total_supply(&e)
    }

    pub fn minter(e: Env) -> Address {
        storage::get_minter(&e)
    }

    pub fn admin(e: Env) -> Address {
        storage::get_admin(&e)
    }

    /// Rotate the minter (admin only) — e.g. when the strategy is redeployed.
    pub fn set_minter(e: Env, new_minter: Address) -> Result<(), TokenError> {
        storage::get_admin(&e).require_auth();
        storage::set_minter(&e, &new_minter);
        storage::extend_instance(&e);
        Ok(())
    }
}
