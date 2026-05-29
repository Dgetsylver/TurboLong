---
sidebar_position: 4
---

# Smart Contracts

TurboLong smart contracts are built in Rust using the Soroban SDK v25 for Stellar.

## Repository Structure

```
contracts/
└── strategies/
    └── blend_leverage/          # Main leverage contract
        ├── Cargo.toml           # Dependencies
        ├── src/
        │   ├── lib.rs           # Contract entry point
        │   ├── leverage.rs      # Core loop logic
        │   ├── blend_pool.rs    # Blend protocol client
        │   ├── soroswap.rs      # Optional DEX swaps
        │   ├── storage.rs       # On-chain state
        │   ├── constants.rs     # Configuration
        │   ├── reserves.rs      # Reserve rate calculations
        │   ├── test_leverage.rs # Unit tests
        │   └── test_integration.rs # Integration tests
```

## Core Contract: `blend_leverage`

### Public Interface

```rust
pub trait LeverageStrategy {
    /// Open a new leveraged position
    fn open_position(
        env: Env,
        user: Address,
        asset: Address,
        amount: i128,
        leverage: u32,  // e.g., 10 for 10×
        pool: Address,  // Blend pool contract
    ) -> Result<PositionId, Error>;

    /// Close an existing position
    fn close_position(
        env: Env,
        user: Address,
        position_id: PositionId,
    ) -> Result<i128, Error>;  // Returns collateral remainder

    /// Adjust leverage on an existing position
    fn adjust_leverage(
        env: Env,
        user: Address,
        position_id: PositionId,
        new_leverage: u32,
    ) -> Result<(), Error>;

    /// Read position state
    fn get_position(
        env: Env,
        position_id: PositionId,
    ) -> Result<Position, Error>;
}
```

### Key Structures

```rust
pub struct Position {
    pub user: Address,
    pub asset: Address,
    pub pool: Address,
    pub supplied: i128,
    pub borrowed: i128,
    pub leverage: u32,
    pub opened_at: u64,  // ledger sequence
    pub health_factor: i128,  // fixed-point (1e7)
}

pub struct PositionId {
    pub id: u64,
}

pub enum Error {
    InsufficientCollateral,
    InvalidLeverage,
    PoolNotFound,
    TransactionFailed,
    // ...
}
```

## Execution Flow: `open_position`

```
1. Validate inputs
   - Check leverage is 1–20×
   - Check pool exists
   - Check user has sufficient balance

2. Initialize position state
   - Allocate PositionId
   - Store metadata (user, asset, pool)

3. Loop N times (where N = iterations for desired leverage):
     a. Transfer asset from user → contract (first iteration) or from previous borrow
     b. Call blend_pool.supply_collateral(amount)
     c. Compute borrow amount = supplied × c_factor × 0.95
     d. Call blend_pool.borrow(borrow_amount)
     e. Re-supply borrowed amount (unless final iteration)

4. Calculate final HF
   - Verify HF > 1.05 (minimum safety threshold)
   - If HF < 1.05, revert (position too risky)

5. Store position in contract storage
   - Update user's position list
   - Emit PositionOpened event

6. Return PositionId
```

## State Management

### Storage Layout

```rust
pub struct ContractStorage {
    pub positions: Map<PositionId, Position>,
    pub user_positions: Map<Address, Vec<PositionId>>,
    pub next_position_id: u64,
    pub fee_receiver: Address,
    pub protocol_fee_bps: u32,  // basis points (e.g., 25 = 0.25%)
}
```

### Persistent vs. Temporary State

- **Persistent** (stored on-chain, survives ledgers):
  - Position data (supplied, borrowed, HF)
  - User position list
  - Configuration (fee receiver, protocol fee)
- **Temporary** (local to transaction, used for computation):
  - Loop iteration counters
  - Intermediate borrow/supply amounts
  - Transaction XDR building

## Testing

### Unit Tests (`test_leverage.rs`)

```rust
#[test]
fn test_open_position_10x_leverage() {
    // Arrange
    let env = Env::default();
    let contract = LeverageStrategyClient::new(&env, contract_id);
    let user = Address::generate(&env);

    // Act
    let position = contract.open_position(
        user.clone(),
        usdc_address,
        1000_i128 * ONE_USDC,
        10,  // 10× leverage
        pool_address,
    );

    // Assert
    assert_eq!(position.leverage, 10);
    assert!(position.health_factor >= 105_000_000);  // HF ≥ 1.05
}
```

### Integration Tests (`test_integration.rs`)

Tests contract against live Blend pool on Stellar testnet:

```rust
#[test]
fn test_integration_etherfuse_usdc() {
    // Connects to real Blend pool on testnet
    // Opens/closes real positions
    // Verifies rates and HF calculations
}
```

## Dependencies

```toml
[dependencies]
soroban-sdk = "25.0"
soroban-contract = "25.0"

# Blend protocol client
blend-contract-sdk = "2.25.0"

# Optional: SoroSwap integration
soroswap-aggregator-sdk = "*"
```

## Deployment

### Testnet Deployment

```bash
cd contracts/strategies/blend_leverage

# Build optimized WASM
cargo build --target wasm32-unknown-unknown --release

# Deploy to testnet
soroban contract deploy \
  --network testnet \
  --source <SOURCE_KEYPAIR> \
  target/wasm32-unknown-unknown/release/blend_leverage.wasm
```

### Mainnet Deployment

Same process but with `--network mainnet` and a mainnet keypair.

**Note:** Mainnet deployments require:

1. Audit completion
2. Security review from Blend Foundation or auditing firm
3. Community governance approval (per TurboLong DAO if applicable)

## Gas Costs

| Operation                    | Gas Cost       | Approximate USD |
| ---------------------------- | -------------- | --------------- |
| open_position (10× leverage) | ~1,500 stroops | ~$0.00015       |
| close_position               | ~800 stroops   | ~$0.00008       |
| adjust_leverage              | ~1,000 stroops | ~$0.0001        |
| read_position                | 0 (local read) | free            |

**Note:** Stellar base fee is 100 stroops per operation. Leverage contract uses ~15 operations per open_position, hence 1,500 stroops.

## Security Considerations

### Reentrancy

Soroban does not have EVM-style reentrancy risks because contract calls are synchronous and state transitions are atomic.

### Integer Overflow

Rust's type system prevents silent integer overflow. All calculations use `i128` (fits up to ~$170M in asset values).

### Oracle Manipulation

The contract trusts Blend's oracle adapters. If Blend's oracle is manipulated, leveraged positions could be at risk. TurboLong does not add additional oracle checks.

**Mitigation:** Monitor Blend governance; use circuit breaker oracle if available.

### Liquidation Risk

High leverage increases liquidation risk. The contract enforces HF ≥ 1.05 at position open but does not prevent HF from dropping below 1.05 afterward (due to interest accrual or rate changes).

**Mitigation:** Users must monitor positions and adjust leverage proactively.

## See Also

- [Architecture Overview](overview.md)
- [Frontend Integration](frontend.md)
- [Security Reports](../security/vulnerability-reports.md)
