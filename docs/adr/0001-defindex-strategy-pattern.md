# ADR 0001 — DeFindex Strategy Pattern

Date: 2026-05-30

## Status

Accepted

## Context

Turbolong needs a composable on-chain execution layer for its leveraged-yield
strategy. Two approaches were considered:

1. **Monolithic contract** — a single Soroban contract that owns collateral,
   executes loops, and manages withdrawals.
2. **DeFindex strategy pattern** — a thin vault contract (DeFindex) that
   delegates execution to a pluggable `Strategy` contract implementing a
   standard interface (`deposit`, `withdraw`, `harvest`, `balance`).

The DeFindex pattern is already deployed on Stellar mainnet and provides
audited vault accounting, share-token issuance, and emergency-pause
infrastructure that would otherwise need to be built from scratch.

## Decision

Adopt the DeFindex strategy pattern. Turbolong implements the `Strategy`
interface and registers with a DeFindex vault. The vault handles:

- Share-token minting/burning
- Pro-rata withdrawal accounting
- Multi-strategy fan-out (future)

The strategy contract handles:

- Blend Protocol supply/borrow loops
- Rebalance logic (HF maintenance)
- BLND emission harvesting

## Consequences

**Positive**
- Reuses audited vault infrastructure; reduces audit surface.
- Share tokens are standard SEP-41 tokens, enabling composability.
- Strategy can be upgraded independently of the vault.

**Negative**
- Adds a cross-contract call hop on every deposit/withdraw, increasing
  Soroban instruction cost by ~10–15%.
- Turbolong is coupled to DeFindex's upgrade cadence for vault-level changes.
