# 0004: Do Not Depend On Flash Loans On Soroban

## Status

Accepted

## Context

On EVM lending markets, some recursive supply, migration, and leverage-management flows use flash loans or flash liquidity to temporarily borrow assets and settle a position change in one transaction. That pattern is powerful but it depends on available flash-loan primitives, liquidity, and route-specific assumptions.

Turbolong is built around Blend request submission on Soroban. The core leverage loop can be expressed as collateralized supply and borrow requests through `pool.submit()` or related Blend calls. It should not assume that uncollateralized flash liquidity exists or that external flash-loan routes are available.

## Decision

Turbolong will not depend on flash loans for core leverage-loop creation, adjustment, or vault rebalance behavior. The product will model loops as collateralized Blend position changes and will reject requests that do not satisfy pool health-factor, utilization, reserve, or allowance constraints.

Documentation and UI copy should avoid presenting Turbolong as a flash-loan product.

## Consequences

This keeps the execution model aligned with the underlying Stellar and Blend primitives. It also makes previews easier to explain: the position has collateral, debt, health factor, and reserve constraints throughout the workflow.

The tradeoff is that some EVM-style one-shot migrations or leverage resizing techniques are out of scope until native, safe, and well-documented Soroban liquidity primitives exist.
