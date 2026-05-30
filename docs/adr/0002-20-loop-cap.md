# ADR 0002 — 20-Loop Cap on Leverage Loops

Date: 2026-05-30

## Status

Accepted

## Context

The USDC leverage strategy on Blend Protocol achieves leverage by repeatedly
supplying and borrowing the same asset. With a collateral factor `c`, the
theoretical maximum leverage is `1 / (1 − c)`. For `c = 0.95` that is 20×.

Each loop is a separate Soroban transaction invocation. Soroban imposes a
per-transaction instruction budget. Empirical testing shows that beyond 20
loop iterations the transaction exceeds the Soroban instruction limit and
fails on-chain.

Additionally, at 20× leverage the health factor approaches 1.0000, leaving
essentially zero headroom before liquidation. The practical safe maximum is
13–15 loops (HF ≥ 1.05).

## Decision

Hard-cap the number of leverage loops at **20** in both the on-chain strategy
contract and the off-chain simulation scripts. The UI further restricts the
slider to the leverage that keeps HF ≥ 1.01 (normal mode) or HF ≥ 1.00001
(expert mode), which in practice limits loops to ≤ 15 for `c = 0.95`.

## Consequences

**Positive**
- Prevents on-chain transaction failures from instruction-budget exhaustion.
- Provides a clear, documented upper bound for auditors and integrators.

**Negative**
- Users cannot reach the theoretical 20× maximum in practice; the effective
  ceiling is ~13–15× at safe HF levels.
- If Soroban raises instruction limits in a future protocol upgrade, the cap
  may be revisited.
