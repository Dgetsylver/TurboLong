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
    Config,
    Reserves,
    VaultPos(Address),
    Keeper,
    /// Monotonic contract version, bumped on each upgrade.
    Version,
    /// The SEP-41 vault-share token contract — the canonical per-user share
    /// ledger. The strategy is its minter (mints on deposit, burns on withdraw).
    ShareToken,
    /// Ledger sequence of the last keeper rebalance (for rate-limiting).
    LastRebalance,
    /// Ledger sequence of the last keeper re-leverage (for rate-limiting).
    LastReleverage,
    /// Keeper-controlled account allowed to pull claimed BLND for an off-chain
    /// (Stellar Broker) swap during the split harvest flow.
    SwapAccount,
    /// Minimum underlying the vault will accept per `SCALAR_7` of BLND when an
    /// off-chain harvest settles (admin-set). Gates the Broker path.
    MinHarvestRate,
    /// The in-flight `harvest_claim` awaiting settlement by `harvest_reinvest`.
    PendingHarvest,
}

// ── Config ───────────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct Config {
    /// The underlying asset (e.g. USDC)
    pub asset: Address,
    /// Blend pool address
    pub pool: Address,
    /// Reserve index in the pool
    pub reserve_id: u32,
    /// BLND token address
    pub blend_token: Address,
    /// Soroswap router address
    pub router: Address,
    /// Emission claim IDs (supply + borrow sides)
    pub claim_ids: Vec<u32>,
    /// Minimum BLND balance to trigger harvest swap
    pub reward_threshold: i128,
    /// Collateral factor (1e7 scaled, e.g. 9_500_000 = 0.95)
    pub c_factor: i128,
    /// Target number of supply+borrow loops
    pub target_loops: u32,
    /// Minimum health factor (1e7 scaled, e.g. 1_050_000 = 1.05)
    pub min_hf: i128,
    /// Orange-zone threshold: HF below this triggers partial unwind (1e7 scaled).
    /// Must satisfy min_hf < orange_hf. e.g. 1_150_000 = 1.15
    pub orange_hf: i128,
}

pub fn set_config(e: &Env, config: Config) {
    e.storage().instance().set(&DataKey::Config, &config);
}

pub fn get_config(e: &Env) -> Config {
    e.storage()
        .instance()
        .get(&DataKey::Config)
        .expect("Config not initialized")
}

// ── Leverage reserves (strategy-level accounting) ────────────────────────────

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub struct LeverageReserves {
    /// Total shares outstanding across all depositors
    pub total_shares: i128,
    /// Total b-tokens (supply tokens) held by the strategy in the pool
    pub total_b_tokens: i128,
    /// Total d-tokens (debt tokens) owed by the strategy in the pool
    pub total_d_tokens: i128,
    /// Last known b_rate from the pool
    pub b_rate: i128,
    /// Last known d_rate from the pool
    pub d_rate: i128,
}

pub fn set_strategy_reserves(e: &Env, reserves: LeverageReserves) {
    e.storage().persistent().set(&DataKey::Reserves, &reserves);
    e.storage().persistent().extend_ttl(
        &DataKey::Reserves,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn get_strategy_reserves(e: &Env) -> LeverageReserves {
    e.storage()
        .persistent()
        .get(&DataKey::Reserves)
        .unwrap_or_default()
}

// ── Per-user vault shares ────────────────────────────────────────────────────

pub fn set_vault_shares(e: &Env, address: &Address, shares: i128) {
    let key = DataKey::VaultPos(address.clone());
    e.storage().persistent().set(&key, &shares);
    e.storage().persistent().extend_ttl(
        &key,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn get_vault_shares(e: &Env, address: &Address) -> i128 {
    let key = DataKey::VaultPos(address.clone());
    let shares = e.storage().persistent().get(&key).unwrap_or(0i128);
    if shares > 0 {
        e.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }
    shares
}

// ── Keeper ───────────────────────────────────────────────────────────────────

pub fn set_keeper(e: &Env, keeper: &Address) {
    e.storage().persistent().set(&DataKey::Keeper, keeper);
    e.storage().persistent().extend_ttl(
        &DataKey::Keeper,
        PERSISTENT_LIFETIME_THRESHOLD,
        PERSISTENT_BUMP_AMOUNT,
    );
}

pub fn get_keeper(e: &Env) -> Address {
    e.storage()
        .persistent()
        .get(&DataKey::Keeper)
        .expect("Keeper not set")
}

// ── Admin ────────────────────────────────────────────────────────────────────
//
// Admin storage now lives in the `admin-sep` Administratable trait (see lib.rs),
// under the SEP's canonical instance-storage key — there is no local Admin key.

// ── Version ──────────────────────────────────────────────────────────────────

pub fn set_version(e: &Env, version: u32) {
    e.storage().instance().set(&DataKey::Version, &version);
}

pub fn get_version(e: &Env) -> u32 {
    e.storage().instance().get(&DataKey::Version).unwrap_or(1)
}

// ── Share token ──────────────────────────────────────────────────────────────

pub fn set_share_token(e: &Env, token: &Address) {
    e.storage().instance().set(&DataKey::ShareToken, token);
}

pub fn get_share_token(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::ShareToken)
        .expect("share token not set")
}

pub fn has_share_token(e: &Env) -> bool {
    e.storage().instance().has(&DataKey::ShareToken)
}

// ── Keeper rebalance rate-limit ──────────────────────────────────────────────

pub fn set_last_rebalance(e: &Env, ledger: u32) {
    e.storage().instance().set(&DataKey::LastRebalance, &ledger);
}

/// `None` when no keeper rebalance has ever been recorded. An explicit Option
/// (instead of a `0` sentinel) so a rebalance recorded at any ledger sequence
/// — including 0 in test environments — correctly arms the cooldown.
pub fn get_last_rebalance(e: &Env) -> Option<u32> {
    e.storage().instance().get(&DataKey::LastRebalance)
}

// ── Keeper re-leverage rate-limit ────────────────────────────────────────────

pub fn set_last_releverage(e: &Env, ledger: u32) {
    e.storage()
        .instance()
        .set(&DataKey::LastReleverage, &ledger);
}

/// `None` when no re-leverage has ever been recorded — same explicit-Option
/// reasoning as `get_last_rebalance`.
pub fn get_last_releverage(e: &Env) -> Option<u32> {
    e.storage().instance().get(&DataKey::LastReleverage)
}

// ── Swap account (off-chain Broker harvest path) ─────────────────────────────

pub fn set_swap_account(e: &Env, account: &Address) {
    e.storage().instance().set(&DataKey::SwapAccount, account);
}

pub fn get_swap_account(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::SwapAccount)
        .expect("swap account not set")
}

pub fn has_swap_account(e: &Env) -> bool {
    e.storage().instance().has(&DataKey::SwapAccount)
}

// ── Harvest settlement floor (audit M-4) ─────────────────────────────────────

/// Minimum underlying owed back per `SCALAR_7` (1e7) of BLND handed to the swap
/// account, in the underlying's own smallest units.
///
/// A *floor*, not a price: the admin sets it well under the market BLND rate so
/// ordinary spread, Broker fee and drift never trip it, and it only binds when
/// a settlement comes back materially short. Because it is expressed as a ratio
/// of smallest units it also absorbs any decimal difference between BLND and
/// the underlying — with both at 7 decimals it is simply the BLND price in
/// units of the underlying, 1e7-scaled (BLND at $0.02 against USDC → 200_000).
///
/// `None` when unset, which disables the Broker path: `harvest_claim` grants no
/// allowance and the on-chain Soroswap route stays the fallback. Fail-closed is
/// deliberate — an upgraded-but-unconfigured deployment loses a swap venue
/// rather than silently keeping an unfloored one.
pub fn set_min_harvest_rate(e: &Env, rate: i128) {
    e.storage().instance().set(&DataKey::MinHarvestRate, &rate);
}

pub fn get_min_harvest_rate(e: &Env) -> Option<i128> {
    e.storage().instance().get(&DataKey::MinHarvestRate)
}

/// A `harvest_claim` whose BLND has been approved to the swap account and whose
/// proceeds have not yet been settled by `harvest_reinvest`.
///
/// The record is what ties the two halves of the split harvest together: it
/// pins how much BLND was pullable, what the underlying balance was before any
/// of it could come back, and the minimum that must return. Single-use — the
/// settling call takes it.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingHarvest {
    /// BLND held by the strategy at claim time — the whole approved amount.
    pub blnd_claimed: i128,
    /// Underlying held at claim time, the baseline the settlement is measured
    /// against. Idle underlying is normally ~0 (deposits are levered in the
    /// same call), so growth over this baseline *is* the harvest proceeds.
    pub underlying_before: i128,
    /// Minimum underlying owed back if the whole `blnd_claimed` is pulled.
    /// Prorated at settlement by how much BLND actually left.
    pub floor: i128,
    /// Ledger at which the swap account's allowance expires.
    pub expiration: u32,
}

pub fn set_pending_harvest(e: &Env, pending: &PendingHarvest) {
    e.storage()
        .instance()
        .set(&DataKey::PendingHarvest, pending);
}

pub fn get_pending_harvest(e: &Env) -> Option<PendingHarvest> {
    e.storage().instance().get(&DataKey::PendingHarvest)
}

/// Read and clear the pending harvest — settlement consumes it, so a second
/// `harvest_reinvest` cannot re-settle the same claim.
pub fn take_pending_harvest(e: &Env) -> Option<PendingHarvest> {
    let pending = get_pending_harvest(e);
    if pending.is_some() {
        e.storage().instance().remove(&DataKey::PendingHarvest);
    }
    pending
}

// ── Instance TTL ─────────────────────────────────────────────────────────────

pub fn extend_instance_ttl(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
}
