use soroban_sdk::{contracttype, Address, Env, String};

// ── TTL constants ────────────────────────────────────────────────────────────

const DAY: u32 = 17_280; // ledgers per day (~5s)

const INSTANCE_BUMP: u32 = 30 * DAY;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY;

// Balances/allowances live in persistent storage with a generous TTL window.
const PERSIST_BUMP: u32 = 120 * DAY;
const PERSIST_THRESHOLD: u32 = PERSIST_BUMP - 20 * DAY;

// ── Keys & values ────────────────────────────────────────────────────────────

#[derive(Clone)]
#[contracttype]
pub struct AllowanceKey {
    pub from: Address,
    pub spender: Address,
}

#[derive(Clone)]
#[contracttype]
pub struct AllowanceValue {
    pub amount: i128,
    /// Allowance is unusable once the ledger sequence passes this value.
    pub expiration_ledger: u32,
}

#[derive(Clone)]
#[contracttype]
pub struct TokenMetadata {
    pub decimals: u32,
    pub name: String,
    pub symbol: String,
}

#[derive(Clone)]
#[contracttype]
pub enum DataKey {
    /// Per-holder balance.
    Balance(Address),
    /// Per (owner, spender) allowance.
    Allowance(AllowanceKey),
    /// Account allowed to mint and burn (the strategy contract).
    Minter,
    /// Total tokens outstanding.
    TotalSupply,
    /// decimals / name / symbol.
    Metadata,
}

// ── Instance TTL ─────────────────────────────────────────────────────────────

pub fn extend_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

// ── Admin / minter / metadata ────────────────────────────────────────────────
//
// Admin storage now lives in the `admin-sep` Administratable trait (see lib.rs),
// under the SEP's canonical instance-storage key — there is no local Admin key.

pub fn set_minter(e: &Env, minter: &Address) {
    e.storage().instance().set(&DataKey::Minter, minter);
}

pub fn get_minter(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::Minter)
        .expect("minter not set")
}

pub fn set_metadata(e: &Env, md: &TokenMetadata) {
    e.storage().instance().set(&DataKey::Metadata, md);
}

pub fn get_metadata(e: &Env) -> TokenMetadata {
    e.storage()
        .instance()
        .get(&DataKey::Metadata)
        .expect("metadata not set")
}

// ── Total supply ─────────────────────────────────────────────────────────────

pub fn get_total_supply(e: &Env) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::TotalSupply)
        .unwrap_or(0)
}

pub fn set_total_supply(e: &Env, amount: i128) {
    e.storage().instance().set(&DataKey::TotalSupply, &amount);
}

// ── Balances ─────────────────────────────────────────────────────────────────

pub fn get_balance(e: &Env, id: &Address) -> i128 {
    let key = DataKey::Balance(id.clone());
    match e.storage().persistent().get::<_, i128>(&key) {
        Some(b) => {
            e.storage()
                .persistent()
                .extend_ttl(&key, PERSIST_THRESHOLD, PERSIST_BUMP);
            b
        }
        None => 0,
    }
}

pub fn set_balance(e: &Env, id: &Address, amount: i128) {
    let key = DataKey::Balance(id.clone());
    e.storage().persistent().set(&key, &amount);
    e.storage()
        .persistent()
        .extend_ttl(&key, PERSIST_THRESHOLD, PERSIST_BUMP);
}

// ── Allowances ───────────────────────────────────────────────────────────────

/// Returns the raw stored allowance (amount + expiration), or None.
pub fn get_allowance_raw(e: &Env, from: &Address, spender: &Address) -> Option<AllowanceValue> {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    e.storage().temporary().get::<_, AllowanceValue>(&key)
}

/// Returns the live allowance amount (0 if missing or expired).
pub fn get_allowance(e: &Env, from: &Address, spender: &Address) -> i128 {
    match get_allowance_raw(e, from, spender) {
        Some(v) if v.expiration_ledger >= e.ledger().sequence() => v.amount,
        _ => 0,
    }
}

pub fn set_allowance(
    e: &Env,
    from: &Address,
    spender: &Address,
    amount: i128,
    expiration_ledger: u32,
) {
    let key = DataKey::Allowance(AllowanceKey {
        from: from.clone(),
        spender: spender.clone(),
    });
    let value = AllowanceValue {
        amount,
        expiration_ledger,
    };
    e.storage().temporary().set(&key, &value);
    // Keep the entry alive until its own expiration (no longer needed after).
    if amount > 0 {
        let ttl = expiration_ledger.saturating_sub(e.ledger().sequence());
        if ttl > 0 {
            e.storage().temporary().extend_ttl(&key, ttl, ttl);
        }
    }
}
