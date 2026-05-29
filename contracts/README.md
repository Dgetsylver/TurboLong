# Contracts

This directory contains the Soroban smart contract that powers the leveraged Blend strategy used by TurboLong.

## Purpose

The contract under `contracts/strategies/blend_leverage/` manages leveraged deposits, harvests BLND emissions, tracks strategy accounting, and coordinates safety checks against the Blend pool.

## How To Run

From the repository root:

```bash
cd contracts/strategies/blend_leverage
cargo test
cargo build --target wasm32-unknown-unknown --release
```

Notes:

- `cargo test` runs the contract unit and integration tests.
- `cargo build --target wasm32-unknown-unknown --release` builds the WASM artifact for deployment.
- The contract depends on Soroban SDK crates and the Blend contract SDK, so first builds may take a little longer.

## File Map

| File | Role |
| --- | --- |
| `Cargo.toml` | Contract crate manifest and release settings. |
| `src/lib.rs` | Contract entry point, constructor, strategy trait implementation, and public methods. |
| `src/blend_pool.rs` | Blend pool interaction helpers. |
| `src/constants.rs` | Shared constants and scaling values. |
| `src/leverage.rs` | Leverage math, health factor checks, and safety helpers. |
| `src/reserves.rs` | Reserve accounting and share conversion logic. |
| `src/soroswap.rs` | Swap helpers for moving BLND into the underlying asset. |
| `src/storage.rs` | Persistent config, keeper, and TTL management. |
| `src/test_leverage.rs` | Leverage-focused tests. |
| `src/test_integration.rs` | End-to-end contract tests. |

