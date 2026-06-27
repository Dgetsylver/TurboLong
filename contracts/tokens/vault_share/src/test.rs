use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, Env, String,
};

use crate::{TokenError, VaultShareToken, VaultShareTokenClient};

struct Fix<'a> {
    e: Env,
    admin: Address,
    minter: Address,
    client: VaultShareTokenClient<'a>,
}

fn setup<'a>() -> Fix<'a> {
    let e = Env::default();
    let admin = Address::generate(&e);
    let minter = Address::generate(&e);
    let id = e.register(
        VaultShareToken,
        (
            admin.clone(),
            minter.clone(),
            7u32,
            String::from_str(&e, "BlendLeverage Vault Share"),
            String::from_str(&e, "blvSHARE"),
        ),
    );
    Fix {
        client: VaultShareTokenClient::new(&e, &id),
        e,
        admin,
        minter,
    }
}

#[test]
fn test_metadata() {
    let f = setup();
    assert_eq!(f.client.decimals(), 7);
    assert_eq!(
        f.client.name(),
        String::from_str(&f.e, "BlendLeverage Vault Share")
    );
    assert_eq!(f.client.symbol(), String::from_str(&f.e, "blvSHARE"));
    assert_eq!(f.client.minter(), f.minter);
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn test_mint_and_supply() {
    let f = setup();
    f.e.mock_all_auths();
    let user = Address::generate(&f.e);
    f.client.mint(&user, &1_000);
    assert_eq!(f.client.balance(&user), 1_000);
    assert_eq!(f.client.total_supply(), 1_000);
    f.client.mint(&user, &500);
    assert_eq!(f.client.balance(&user), 1_500);
    assert_eq!(f.client.total_supply(), 1_500);
}

#[test]
fn test_mint_requires_minter_auth() {
    let f = setup();
    let user = Address::generate(&f.e);
    // No auth mocked → mint must fail (minter.require_auth panics).
    let r = f.client.try_mint(&user, &100);
    assert!(r.is_err());
}

#[test]
fn test_transfer() {
    let f = setup();
    f.e.mock_all_auths();
    let a = Address::generate(&f.e);
    let b = Address::generate(&f.e);
    f.client.mint(&a, &1_000);
    f.client.transfer(&a, &b, &400);
    assert_eq!(f.client.balance(&a), 600);
    assert_eq!(f.client.balance(&b), 400);
    // Supply unchanged by transfers.
    assert_eq!(f.client.total_supply(), 1_000);
}

#[test]
fn test_transfer_insufficient_balance() {
    let f = setup();
    f.e.mock_all_auths();
    let a = Address::generate(&f.e);
    let b = Address::generate(&f.e);
    f.client.mint(&a, &100);
    let r = f.client.try_transfer(&a, &b, &101);
    assert_eq!(r, Err(Ok(TokenError::InsufficientBalance)));
}

#[test]
fn test_approve_allowance_transfer_from() {
    let f = setup();
    f.e.mock_all_auths();
    let owner = Address::generate(&f.e);
    let spender = Address::generate(&f.e);
    let to = Address::generate(&f.e);
    f.client.mint(&owner, &1_000);

    let exp = f.e.ledger().sequence() + 1_000;
    f.client.approve(&owner, &spender, &600, &exp);
    assert_eq!(f.client.allowance(&owner, &spender), 600);

    f.client.transfer_from(&spender, &owner, &to, &250);
    assert_eq!(f.client.balance(&owner), 750);
    assert_eq!(f.client.balance(&to), 250);
    // Allowance reduced, expiration preserved.
    assert_eq!(f.client.allowance(&owner, &spender), 350);
}

#[test]
fn test_transfer_from_over_allowance() {
    let f = setup();
    f.e.mock_all_auths();
    let owner = Address::generate(&f.e);
    let spender = Address::generate(&f.e);
    let to = Address::generate(&f.e);
    f.client.mint(&owner, &1_000);
    let exp = f.e.ledger().sequence() + 1_000;
    f.client.approve(&owner, &spender, &100, &exp);
    let r = f.client.try_transfer_from(&spender, &owner, &to, &101);
    assert_eq!(r, Err(Ok(TokenError::InsufficientAllowance)));
}

#[test]
fn test_allowance_expires() {
    let f = setup();
    f.e.mock_all_auths();
    let owner = Address::generate(&f.e);
    let spender = Address::generate(&f.e);
    let to = Address::generate(&f.e);
    f.client.mint(&owner, &1_000);

    let exp = f.e.ledger().sequence() + 10;
    f.client.approve(&owner, &spender, &500, &exp);
    assert_eq!(f.client.allowance(&owner, &spender), 500);

    // Advance past expiration.
    f.e.ledger().set_sequence_number(exp + 1);
    assert_eq!(f.client.allowance(&owner, &spender), 0);
    let r = f.client.try_transfer_from(&spender, &owner, &to, &1);
    assert_eq!(r, Err(Ok(TokenError::InsufficientAllowance)));
}

#[test]
fn test_approve_expired_nonzero_rejected() {
    let f = setup();
    f.e.mock_all_auths();
    let owner = Address::generate(&f.e);
    let spender = Address::generate(&f.e);
    f.e.ledger().set_sequence_number(100);
    // Non-zero amount with a past expiration is invalid.
    let r = f.client.try_approve(&owner, &spender, &10, &50);
    assert_eq!(r, Err(Ok(TokenError::BadExpiration)));
}

#[test]
fn test_burn() {
    let f = setup();
    f.e.mock_all_auths();
    let a = Address::generate(&f.e);
    f.client.mint(&a, &1_000);
    f.client.burn(&a, &300);
    assert_eq!(f.client.balance(&a), 700);
    assert_eq!(f.client.total_supply(), 700);
}

#[test]
fn test_burn_from() {
    let f = setup();
    f.e.mock_all_auths();
    let owner = Address::generate(&f.e);
    let spender = Address::generate(&f.e);
    f.client.mint(&owner, &1_000);
    let exp = f.e.ledger().sequence() + 1_000;
    f.client.approve(&owner, &spender, &400, &exp);
    f.client.burn_from(&spender, &owner, &250);
    assert_eq!(f.client.balance(&owner), 750);
    assert_eq!(f.client.total_supply(), 750);
    assert_eq!(f.client.allowance(&owner, &spender), 150);
}

#[test]
fn test_burn_by_minter() {
    let f = setup();
    f.e.mock_all_auths();
    let user = Address::generate(&f.e);
    f.client.mint(&user, &1_000);
    // Strategy (minter) burns on withdraw without the holder's auth.
    f.client.burn_by_minter(&user, &400);
    assert_eq!(f.client.balance(&user), 600);
    assert_eq!(f.client.total_supply(), 600);
}

#[test]
fn test_negative_amount_rejected() {
    let f = setup();
    f.e.mock_all_auths();
    let user = Address::generate(&f.e);
    assert_eq!(
        f.client.try_mint(&user, &-1),
        Err(Ok(TokenError::NegativeAmount))
    );
}

#[test]
fn test_set_minter() {
    let f = setup();
    f.e.mock_all_auths();
    let new_minter = Address::generate(&f.e);
    f.client.set_minter(&new_minter);
    assert_eq!(f.client.minter(), new_minter);
}

// admin-sep rotation: the current admin can hand the admin role over.
#[test]
fn test_set_admin_rotates_under_admin_auth() {
    let f = setup();
    f.e.mock_all_auths();
    let new_admin = Address::generate(&f.e);
    f.client.set_admin(&new_admin);
    assert_eq!(f.client.admin(), new_admin);
}

// Proves the gating is real (not just mocked): rotating the admin requires the
// current admin's authorization — no auth mocked → must reject.
#[test]
#[should_panic]
fn test_set_admin_requires_current_admin_auth() {
    let f = setup();
    let new_admin = Address::generate(&f.e);
    f.client.set_admin(&new_admin);
}

#[test]
fn test_total_supply_conserved_across_transfers() {
    let f = setup();
    f.e.mock_all_auths();
    let a = Address::generate(&f.e);
    let b = Address::generate(&f.e);
    let c = Address::generate(&f.e);
    f.client.mint(&a, &1_000);
    f.client.transfer(&a, &b, &300);
    f.client.transfer(&b, &c, &100);
    // Sum of balances == total supply.
    let sum = f.client.balance(&a) + f.client.balance(&b) + f.client.balance(&c);
    assert_eq!(sum, f.client.total_supply());
    assert_eq!(sum, 1_000);
}
