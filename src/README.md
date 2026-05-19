# CLI Binaries

## Purpose

The root Rust crate contains command-line binaries for simulating and executing the USDC leverage-loop strategy against Blend pool state.

## How To Run

From the repository root:

```bash
cargo run --bin simulate -- --loops 13
cargo run --bin execute_loop -- --key-file path/to/stellar-secret.txt --dry-run
```

Use `--dry-run` before any live submission. Secret key files should stay outside source control and must not be pasted into terminal history.

## File Map

- `bin/simulate.rs`: reads live pool state through `stellar-cli` and prints leverage, rate, and health-factor tables.
- `bin/execute_loop.rs`: builds and submits or dry-runs an atomic Blend `pool.submit()` leverage loop.
