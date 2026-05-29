# PoolRouter

A Soroban smart contract that acts as an entry point for multi-pool deposits, routing user funds to the registered strategy offering the best net APY.

## Overview

Currently, each `BlendLeverageStrategy` is single-pool: one deployment = one Blend pool. `PoolRouter` sits in front of multiple strategies and automatically directs deposits to the highest-yield option, while giving users the option to override the selection.

```
User
 │
 ▼
PoolRouter.deposit(amount, from, preferred?)
 │
 ├── select_strategy()  →  Strategy A (APY 8.2%)  ◄ chosen (highest)
 │                         Strategy B (APY 7.1%)
 │                         Strategy C (APY 5.8%)
 │
 └── StrategyA.deposit(amount, router_addr)
```

## Architecture

### Virtual shares

The router itself is the depositor in each underlying strategy. Strategy contracts track the router's aggregate balance. Internally, the router issues **virtual shares** to each user proportional to their contribution to the router's position in a given strategy.

```
User deposits 1 000 USDC into Strategy A (first depositor):
  router_balance_before = 0  →  user gets 1 000 virtual shares (1:1)

User 2 deposits 500 USDC into Strategy A (pool has grown to 1 100):
  user2_vs = 500 × 1 000 / 1 100 ≈ 454 virtual shares

User 2's underlying = 454 / 1 454 × 1 600 ≈ 499 USDC
```

### APY snapshots

The router does **not** query Blend pool rates on-chain (this would require re-entrant calls across multiple pools in a single transaction). Instead, the admin (or a trusted keeper that integrates with the B3 rate-snapshot oracle) calls `update_apy(strategy, net_apy_bps)` to write the current net yield for each strategy. The router then reads these snapshots to pick the best pool deterministically.

## Initialisation

```rust
PoolRouter::__constructor(
    asset:      Address,       // underlying asset (must match all strategies)
    init_args:  Vec<Val>,
    //  [0] admin:    Address  — manages registry and APY updates
    //  [1..N] strategy: Address  — initial strategy addresses (optional)
)
```

## Key methods

| Method | Auth | Description |
|--------|------|-------------|
| `deposit(amount, from, preferred?)` | `from` | Route deposit to best (or preferred) strategy |
| `withdraw(amount, from, to)` | `from` | Withdraw from user's current strategy |
| `balance(from)` | none | User's underlying value across the router |
| `best_strategy()` | none | Preview which strategy would be chosen |
| `add_strategy(strategy)` | admin | Register a new strategy |
| `remove_strategy(strategy)` | admin | De-register a strategy |
| `update_apy(strategy, bps)` | admin | Publish a new APY snapshot |
| `set_admin(new_admin)` | admin | Transfer admin role |
| `strategies()` | none | List all registered strategies with APY |

## Migration from a single-pool strategy

Existing depositors in a `BlendLeverageStrategy` can migrate gradually:

1. **No forced migration** — existing positions in individual strategy contracts are unaffected. The router is purely additive.
2. **Withdraw + re-deposit** — to benefit from automatic routing, a user:
   1. Calls `strategy.withdraw(balance, from, to)` on their current strategy.
   2. Calls `router.deposit(amount, from, None)` to enter the router with automatic best-pool selection.
3. **Front-end guidance** — the DeFindex UI can prompt users with a "Migrate to router" flow once the router holds strategies with competitive APYs.

## Routing algorithm

`select_strategy` is deterministic:

1. Iterate registered strategies and find the one with the highest `net_apy_bps`.
2. Ties are broken by insertion order (earlier registration wins), ensuring stable selection when multiple pools report identical rates.
3. If the user supplies `preferred_strategy`, the router verifies it is registered and uses it directly (skipping the APY comparison).

## Events

| Topic | Data | Description |
|-------|------|-------------|
| `(RouterDeposit, from)` | `(strategy, amount, virtual_shares)` | Emitted on each successful deposit |
| `(RouterWithdraw, from)` | `(strategy, amount)` | Emitted on each successful withdrawal |
