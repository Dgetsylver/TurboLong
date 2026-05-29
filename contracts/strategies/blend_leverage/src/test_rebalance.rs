#![cfg(test)]

use crate::storage::Config;
use crate::{BlendLeverageStrategy, BlendLeverageStrategyClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env,
};

#[test]
fn test_rebalance_unauthorized() {
    let e = Env::default();
    let contract_id = e.register_contract(None, BlendLeverageStrategy);
    let client = BlendLeverageStrategyClient::new(&e, &contract_id);
    let keeper = Address::generate(&e);

    // Normally we'd init the contract, but let's mock the keeper directly
    crate::storage::set_keeper(&e, keeper.clone()); // Wait, this uses e.as_contract, so we can't do it globally unless inside

    // Let's use `initialize`
    // fn initialize(e: Env, asset: Address, ... keeper: Address)
}
