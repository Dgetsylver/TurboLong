# Contracts

## Purpose

This directory contains Soroban smart contracts for Turbolong strategy automation. The current contract package implements a leveraged Blend strategy intended to be managed through DeFindex-style vault flows.

## How To Run

From the strategy package:

```bash
cd contracts/strategies/blend_leverage
cargo test
cargo build --release
```

For optimized Soroban/WASM builds, use the target and tooling configured in your local Stellar contract environment.

## File Map

- `strategies/blend_leverage/Cargo.toml`: contract package manifest and release profile.
- `strategies/blend_leverage/src/lib.rs`: contract entry points and module wiring.
- `strategies/blend_leverage/src/leverage.rs`: leverage-loop strategy logic.
- `strategies/blend_leverage/src/blend_pool.rs`: Blend pool integration helpers.
- `strategies/blend_leverage/src/reserves.rs`: reserve accounting helpers.
- `strategies/blend_leverage/src/soroswap.rs`: Soroswap integration surface.
- `strategies/blend_leverage/src/storage.rs`: contract storage helpers.
- `strategies/blend_leverage/src/constants.rs`: shared constants.
- `strategies/blend_leverage/src/test_*.rs`: unit and integration coverage.
