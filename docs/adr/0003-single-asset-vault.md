# ADR 0003 — Single-Asset Vault

Date: 2026-05-30

## Status

Accepted

## Context

DeFindex supports multi-asset vaults where depositors contribute a basket of
tokens. Turbolong's leverage strategy, however, loops a single asset (e.g.
USDC) as both collateral and borrowed asset on Blend Protocol.

Two vault configurations were evaluated:

1. **Multi-asset vault** — accepts any token; the strategy rebalances into the
   target asset on deposit.
2. **Single-asset vault** — accepts only the strategy's underlying asset
   (e.g. USDC); no rebalancing swap is needed.

## Decision

Deploy one **single-asset vault per underlying asset**. Each vault accepts
exactly one token (e.g. USDC) and runs the corresponding Blend loop strategy.

Rationale:
- Eliminates swap slippage and oracle dependency on deposit/withdraw.
- Simplifies accounting: 1 share = `n` underlying tokens, no basket math.
- Reduces attack surface: no DEX integration in the critical deposit path.
- Aligns with the USDC/USDC loop design where price risk is near-zero.

## Consequences

**Positive**
- Simpler share-price calculation and easier auditability.
- No swap failure modes on deposit.

**Negative**
- Users must hold the exact underlying asset before depositing.
- Supporting a new asset requires deploying a new vault + strategy pair.
