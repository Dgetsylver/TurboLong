# 0001: Use The DeFindex Strategy Pattern

## Status

Accepted

## Context

Turbolong needs a vault surface for users who want leveraged exposure without manually operating every loop, rebalance, harvest, and unwind. A custom standalone vault could hold user deposits directly, but that would require Turbolong to own more accounting, share issuance, deposit/withdraw semantics, and strategy lifecycle behavior.

DeFindex already provides a strategy-oriented vault pattern for Soroban. Building around that pattern lets Turbolong focus on the Blend leverage strategy while relying on a familiar vault abstraction for deposits, withdrawals, share accounting, and strategy composition.

## Decision

Turbolong will model automated vault exposure through a DeFindex-style strategy contract. The strategy owns the Blend leveraged position mechanics, while the vault surface represents user deposits and withdrawals through shares.

The frontend will treat the vault as a separate protocol view from direct Blend position management. Contract code will keep leverage-specific logic in the strategy module instead of duplicating vault accounting in the UI.

## Consequences

This keeps the strategy modular and makes future vault integrations easier to reason about. It also gives integrators a clearer boundary: vault shares represent user ownership, while the strategy contract manages Blend collateral, debt, harvest, and rebalance behavior.

The tradeoff is that Turbolong inherits the operational constraints of the DeFindex pattern. Strategy upgrades, share-price reporting, and rebalance permissions must be documented and tested carefully so users understand where vault accounting ends and leveraged-position risk begins.
