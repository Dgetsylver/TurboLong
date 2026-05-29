# src

This directory contains the Rust command-line binaries used to simulate, calculate, and execute TurboLong leverage flows.

## Purpose

The binaries here mirror the on-chain Blend math and transaction flow so you can inspect rates, simulate loops, or prepare an execution run before touching a wallet.

## How To Run

From the repository root:

```bash
cargo test
cargo run --bin rate_calc < tests/fixtures/rates.json
cargo run --bin simulate -- --loops 20
```

For the execution helper, provide a secret key file and run from the repo root:

```bash
cargo run --bin execute_loop -- --key-file /path/to/keyfile --loops 13 --initial 1000
```

Notes:

- `cargo test` runs the Rust test suite, including the leverage simulation test under `tests/`.
- `rate_calc` reads JSON fixtures from stdin and prints projected rates.
- `simulate` reads live pool data and prints a leverage table.
- `execute_loop` submits or simulates the atomic leverage transaction flow.

## File Map

| File | Role |
| --- | --- |
| `bin/execute_loop.rs` | CLI for building and submitting the leverage execution flow. |
| `bin/rate_calc.rs` | Fixture-driven rate projection tool used by parity tests. |
| `bin/simulate.rs` | Live mainnet simulation and reporting tool. |

