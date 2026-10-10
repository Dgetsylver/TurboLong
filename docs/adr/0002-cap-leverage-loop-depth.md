# 0002: Cap Leverage Loop Depth

## Status

Accepted

## Context

Recursive supply can theoretically approach high leverage as collateral is repeatedly supplied and borrowed. With a collateral factor near 0.95, the mathematical limit approaches 20x. In practice, positions near that limit have very thin health-factor margin and become sensitive to interest accrual, utilization spikes, reserve liquidity, and rounding.

The UI and scripts need a concrete upper bound so preview calculations, transaction request vectors, and user expectations remain bounded. Unbounded loops would make it easier to create positions that are technically constructible but operationally fragile.

## Decision

Turbolong will cap leverage-loop depth at 20 internal loop steps. Product surfaces should default users below the theoretical maximum and show health-factor, borrow-headroom, utilization, and liquidation-risk warnings before signing.

The cap is a safety ceiling, not a recommendation. Safe default ranges should remain lower and should be derived from the active pool's collateral factor, liability factor, utilization, and interest-rate curve.

## Consequences

The cap prevents runaway request vectors and keeps simulations predictable. It also creates a clear product invariant for frontend previews, scripts, and strategy code.

The tradeoff is that users cannot express leverage above the cap even if a pool's parameters temporarily appear to allow it. That is acceptable because positions near the theoretical maximum are usually dominated by liquidation and rate risk rather than useful capital efficiency.
