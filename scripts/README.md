# Scripts

## Purpose

This directory contains TypeScript and Python utilities for inspecting Blend pools, querying oracle state, testing leverage-loop flows, generating landing assets, and executing operational loops.

## How To Run

```bash
cd scripts
npm install
npm run testnet-loop
```

Run one-off TypeScript scripts with `npx tsx`:

```bash
npx tsx discover_pools.ts
npx tsx mainnet_loop.ts --help
```

Never pass Stellar secret keys directly on the command line. Use the key-file or wallet flow expected by each script.

## File Map

- `package.json`: script dependencies and the `testnet-loop` command.
- `testnet_loop.ts`: testnet leverage-loop exercise.
- `mainnet_loop.ts`: mainnet loop workflow and fee/op-count reference logic.
- `test_strategy.ts`: strategy test harness.
- `deploy_strategy.ts`: deployment helper for the strategy contract.
- `discover_pools.ts`: pool discovery helper.
- `debug_*.ts`: focused debugging helpers for pools and BLND.
- `get_oracle*.ts`, `oracle_deep*.ts`, `query_oracle.ts`: oracle inspection utilities.
- `identify_tokens.ts`: token identification helper.
- `gen_thumbnail.py`: landing/social thumbnail generation script.
