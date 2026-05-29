use soroban_sdk::{contracttype, Address, Env, Vec};

// ── TTL constants ────────────────────────────────────────────────────────────

const ONE_DAY_LEDGERS: u32 = 17_280;
const INSTANCE_BUMP_AMOUNT: u32 = 30 * ONE_DAY_LEDGERS;
const INSTANCE_LIFETIME_THRESHOLD: u32 = INSTANCE_BUMP_AMOUNT - ONE_DAY_LEDGERS;
const PERSISTENT_BUMP_AMOUNT: u32 = 120 * ONE_DAY_LEDGERS;
const PERSISTENT_LIFETIME_THRESHOLD: u32 = PERSISTENT_BUMP_AMOUNT - 20 * ONE_DAY_LEDGERS;

// ── Data keys ────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address (manages strategy registry)
    Admin,
    /// Underlying asset address (must be the same across all strategies)
    Asset,
    /// Ordered list of registered strategy addresses
    Strategies,
    /// Net APY snapshot for a strategy (basis points, 100 bps = 1%)
    StrategyApy(Address),
    /// Total virtual shares the router has issued for a given strategy
    StrategyVirtualShares(Address),
    /// Per-user position: which strategy their funds are in and their virtual shares
    UserPosition(Address),
}

// ── StrategyEntry ─────────────────────────────────────────────────────────────

/// A registered strategy with its latest net-APY snapshot.
#[contracttype]
#[derive(Clone, Debug)]
pub struct StrategyEntry {
    pub address: Address,
    /// Net APY in basis points (e.g. 500 = 5.00%).  Updated by the admin via
    /// `update_apy`. The router uses this snapshot to pick the best pool; it does
    /// NOT query rates on-chain to avoid re-entrant calls.
    pub net_apy_bps: i128,
}

// ── UserPosition ──────────────────────────────────────────────────────────────

/// Tracks a user's allocation via the router.
#[contracttype]
#[derive(Clone, Debug)]
pub struct UserPosition {
    /// The strategy contract this user's funds are deposited in.
    pub strategy: Address,
    /// The user's virtual-share balance in the router's pool for that strategy.
    pub virtual_shares: i128,
}

// ── Admin ─────────────────────────────────────────────────────────────────────

pub fn set_admin(e: &Env, admin: &Address) {
    e.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_admin(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("Admin not set")
}

// ── Asset ─────────────────────────────────────────────────────────────────────

pub fn set_asset(e: &Env, asset: &Address) {
    e.storage().instance().set(&DataKey::Asset, asset);
}

pub fn get_asset(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::Asset)
        .expect("Asset not set")
}

// ── Strategy registry ─────────────────────────────────────────────────────────

pub fn set_strategies(e: &Env, strategies: &Vec<StrategyEntry>) {
    e.storage().instance().set(&DataKey::Strategies, strategies);
}

pub fn get_strategies(e: &Env) -> Vec<StrategyEntry> {
    e.storage()
        .instance()
        .get(&DataKey::Strategies)
        .unwrap_or_else(|| Vec::new(e))
}

pub fn set_strategy_apy(e: &Env, strategy: &Address, apy_bps: i128) {
    e.storage()
        .instance()
        .set(&DataKey::StrategyApy(strategy.clone()), &apy_bps);
}

pub fn get_strategy_apy(e: &Env, strategy: &Address) -> i128 {
    e.storage()
        .instance()
        .get(&DataKey::StrategyApy(strategy.clone()))
        .unwrap_or(0)
}

// ── Virtual shares (router-internal accounting) ───────────────────────────────

pub fn get_strategy_virtual_shares(e: &Env, strategy: &Address) -> i128 {
    e.storage()
        .persistent()
        .get(&DataKey::StrategyVirtualShares(strategy.clone()))
        .unwrap_or(0i128)
}

pub fn set_strategy_virtual_shares(e: &Env, strategy: &Address, shares: i128) {
    let key = DataKey::StrategyVirtualShares(strategy.clone());
    e.storage().persistent().set(&key, &shares);
    e.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

// ── Per-user position ─────────────────────────────────────────────────────────

pub fn get_user_position(e: &Env, user: &Address) -> Option<UserPosition> {
    let key = DataKey::UserPosition(user.clone());
    let pos: Option<UserPosition> = e.storage().persistent().get(&key);
    if pos.is_some() {
        e.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
    pos
}

pub fn set_user_position(e: &Env, user: &Address, position: &UserPosition) {
    let key = DataKey::UserPosition(user.clone());
    e.storage().persistent().set(&key, position);
    e.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn remove_user_position(e: &Env, user: &Address) {
    e.storage()
        .persistent()
        .remove(&DataKey::UserPosition(user.clone()));
}

// ── Instance TTL ──────────────────────────────────────────────────────────────

pub fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}
