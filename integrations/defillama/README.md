# Turbolong — DefiLlama TVL Adapter

This directory contains the TVL adapter for Turbolong's leveraged-yield
strategies, intended for submission to
[DefiLlama/DefiLlama-Adapters](https://github.com/DefiLlama/DefiLlama-Adapters).

## What it measures

Turbolong runs a USDC supply/borrow loop on Blend Protocol (Stellar mainnet).
Users deposit USDC into a DeFindex vault; the strategy contract loops the
deposit up to ~13× leverage.

**TVL** = total USDC collateral held by Turbolong strategy contracts inside
Blend pools (gross collateral, not net equity).

**Borrowed** = total USDC debt owed by the strategy contracts to Blend pools.

## File layout

```
integrations/defillama/
├── index.js      ← adapter (copy to projects/turbolong/ in the adapters repo)
└── README.md     ← this file
```

## Submitting to DefiLlama

1. Fork [DefiLlama/DefiLlama-Adapters](https://github.com/DefiLlama/DefiLlama-Adapters).
2. Copy `index.js` to `projects/turbolong/index.js`.
3. Fill in the `strategyId` field in `POOLS` once the mainnet vault is deployed.
4. Test locally:
   ```bash
   npm install
   node test.js projects/turbolong/index.js
   ```
5. Open a PR with "Allow edits by maintainers" enabled.

## Pre-deployment note

The `strategyId` fields in `POOLS` are empty until the DeFindex vault is
deployed to Stellar mainnet. The adapter returns zero TVL until those are set.
Update them and re-test before submitting the PR.

## Chain

`stellar` — Stellar mainnet (public network).
