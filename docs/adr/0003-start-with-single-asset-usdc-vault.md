# 0003: Start With A Single-Asset USDC Vault

## Status

Accepted

## Context

Turbolong can eventually support multiple pools, assets, and vault strategies. Starting with a broad multi-asset vault would increase complexity across deposits, withdrawals, share pricing, oracle handling, risk limits, and rebalance logic.

USDC is the clearest first vault asset because users understand the unit of account, pool accounting is easier to explain, and same-asset recursive lending avoids the extra price-basis risk that appears when collateral and debt are different assets.

## Decision

Turbolong will begin with a single-asset USDC vault strategy. The vault will hold USDC exposure, manage a Blend leveraged USDC position, and report user-facing metrics in USDC terms.

Multi-asset routing, pool selection, and cross-asset vaults will be treated as later features after the single-asset accounting and rebalance behavior are proven.

## Consequences

The first vault is easier to test, document, and monitor. Share price, TVL, debt, collateral, and health factor can be explained in one asset without requiring users to understand cross-asset liquidation mechanics.

The tradeoff is narrower product coverage at launch. Users who want exposure to other assets or cross-asset strategies must use direct Blend flows or wait for later vault versions.
