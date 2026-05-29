# Scripts

This directory contains utility scripts for debugging, deployment, oracle inspection, token discovery, and leverage simulations.

## Purpose

The scripts here are intended for local operator workflows. They are not the user-facing app, but they are useful for inspecting on-chain state, testing strategy behavior, and preparing deployments.

## How To Run

From the repository root:

```bash
cd scripts
npm install
npm run testnet-loop
```

You can also run any individual TypeScript helper directly:

```bash
npx tsx test_strategy.ts
npx tsx debug_pool.ts
```

Notes:

- `npm run testnet-loop` is the main packaged entry point in `package.json`.
- The other `.ts` files are runnable with `tsx` as ad hoc utilities.
- `gen_thumbnail.py` is a Python helper and should be run with your local Python interpreter.

## File Map

| File | Role |
| --- | --- |
| `package.json` | Script entry points and runtime dependencies. |
| `.npmrc` | npm configuration for the scripts workspace. |
| `debug_blnd.ts` | Debug helper for BLND-related calculations. |
| `debug_pool.ts` | Debug helper for pool state and rates. |
| `deploy_strategy.ts` | Deployment helper for strategy contracts. |
| `discover_pools.ts` | Pool discovery and inspection utility. |
| `gen_thumbnail.py` | Python helper for asset or report thumbnail generation. |
| `get_oracle.ts` | Oracle lookup helper. |
| `get_oracle2.ts` | Alternate oracle lookup helper. |
| `identify_tokens.ts` | Token identification helper. |
| `mainnet_loop.ts` | Mainnet loop runner and strategy exercise script. |
| `oracle_deep.ts` | Deep oracle inspection script. |
| `oracle_deep2.ts` | Alternate deep oracle inspection script. |
| `oracle_deep3.ts` | Alternate deep oracle inspection script. |
| `oracle_deep4.ts` | Alternate deep oracle inspection script. |
| `query_oracle.ts` | Oracle query helper. |
| `testnet_loop.ts` | Testnet loop runner used by the npm script. |
| `test_strategy.ts` | Strategy test harness. |

