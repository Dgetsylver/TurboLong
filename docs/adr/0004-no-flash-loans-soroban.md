# ADR 0004 — No Flash Loans on Soroban

Date: 2026-05-30

## Status

Accepted

## Context

EVM-based leverage strategies commonly use flash loans to open or close a
leveraged position atomically in a single transaction, avoiding the need for
iterative supply/borrow loops. This reduces gas cost and eliminates
intermediate HF exposure.

Soroban (Stellar's smart-contract platform) does not support flash loans:

- Soroban's execution model does not allow a contract to borrow funds and
  repay them within the same transaction without an external liquidity source.
- Blend Protocol v2 does not expose a flash-loan interface.
- Soroban's re-entrancy restrictions and lack of callback-based token
  transfers make the standard EVM flash-loan pattern unimplementable.

## Decision

Do **not** use flash loans. Implement leverage via iterative supply/borrow
loops, capped at 20 iterations (see ADR 0002). Each loop step is a
sequential Soroban invocation within a single transaction envelope.

## Consequences

**Positive**
- No dependency on external flash-loan liquidity providers.
- Strategy is self-contained within Blend Protocol.

**Negative**
- Opening/closing large positions requires more Soroban instructions than a
  flash-loan approach would.
- Position is not opened atomically from the user's perspective; intermediate
  states are visible on-chain between loop steps.
- If Blend Protocol adds flash loans in a future version, this decision should
  be revisited.
