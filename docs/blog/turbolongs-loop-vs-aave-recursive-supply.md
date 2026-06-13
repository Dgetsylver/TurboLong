# Turbolong's Loop vs Aave Recursive Supply

Recursive supply is a familiar DeFi pattern: deposit collateral, borrow against it, deposit the borrowed asset, and repeat until the position reaches a target leverage. On Aave-style EVM markets, users normally experience that pattern as a sequence of separate lending and borrowing actions, or as a specialized smart-contract workflow that wraps those actions for them. Turbolong applies the same economic idea to Stellar, but the execution model is different because Blend positions are updated through Soroban contract calls.

This post explains what changes on Stellar, why atomic `pool.submit()` changes the ergonomics, what is not possible, and who benefits from the design.

## The Shared Idea

Both Turbolong and Aave recursive supply are trying to express the same balance-sheet shape:

```text
Initial collateral
  -> borrow against collateral
  -> resupply borrowed asset
  -> repeat until target leverage or risk limit
```

The result is not a perpetual futures position and it is not a zero-risk yield product. It is a leveraged lending position. The user earns supply-side yield and incentives on a larger supplied balance, pays borrow cost on the debt side, and carries liquidation, rate, liquidity, oracle, and smart-contract risk.

For same-asset loops, such as supplying and borrowing a stable asset, price exposure may be muted because collateral and debt move together. That does not remove health-factor risk. Borrow APR can rise, supply APR can fall, liquidity can thin out, and interest accrual can push a highly levered account toward liquidation.

## How Aave-Style Recursive Supply Usually Feels

On Aave and similar EVM lending markets, the base protocol exposes supply and borrow operations. A user can recursively loop manually, but that means repeated wallet prompts and repeated transaction risk:

1. Supply asset.
2. Borrow asset.
3. Supply the borrowed asset.
4. Borrow again.
5. Continue until the target leverage is reached.

Integrators often improve this with a helper contract or aggregator. Some flows may use flash liquidity to resize, migrate, or lever a position in a single higher-level action. The user interface can feel like one action, but under the hood the implementation has to manage EVM approvals, gas, contract routing, and the lending protocol's state transitions.

That is a mature model, but it has friction. It can be expensive on high-gas chains, awkward to simulate for users, and difficult to explain when several contracts participate in the route.

## What Changes On Stellar And Blend

Blend's pool contract accepts a vector of requests through `pool.submit()`. A Turbolong leverage loop can package the sequence of supply-collateral and borrow requests into one Soroban transaction. In the wallet-facing flow, the user approves the seed amount and then submits the request vector.

The important ergonomic difference is that the recursive loop is modeled as one pool-level state transition. The user does not need to manually click through each supply and borrow step. Turbolong can preview the leverage, health factor, total supply, total borrow, and fee budget before the signing prompt.

In simplified terms:

```text
Approve initial amount
  -> submit [supply_collateral, borrow, supply_collateral, borrow, ...]
  -> Blend updates the position atomically
```

Atomic execution matters because the loop either succeeds as a coherent state change or fails before the position is partially built. That reduces the "step two failed after step one succeeded" problem that can appear in manual recursive workflows.

## Why Atomic `pool.submit()` Changes The UX

Atomic `pool.submit()` does not make leverage safe, but it does make the user experience more legible.

- The interface can show one target leverage instead of many manual loop steps.
- Health factor can be computed against the final intended position.
- The position can be rejected before signing if the projected health factor or utilization is unsafe.
- Users see a small number of wallet prompts instead of a long sequence of repeated actions.
- Integrators can build higher-level flows without asking users to understand every internal supply and borrow request.

That is why Turbolong focuses on previews and guardrails. The useful product surface is not "more leverage at any cost." It is a clearer way to understand the position before submitting it.

## What Is Not Possible

Turbolong is not an Aave flash-loan clone on Stellar.

There is no assumption that the user can borrow arbitrary uncollateralized liquidity, perform an external strategy, and repay within the same transaction. Turbolong's loop is collateralized lending through Blend request semantics. The borrowed asset is used inside the leverage loop, and the resulting debt remains part of the user's position.

Turbolong also does not bypass the lending pool's constraints. The pool's collateral factors, liability factors, utilization, reserve caps, interest-rate curve, and liquidation mechanics still apply. If a requested loop would push utilization too high or produce an unsafe health factor, the correct result is refusal, not forced execution.

## Who Benefits

Turbolong is most useful for users and integrators who already understand the tradeoff of recursive lending but want a cleaner Stellar-native interface.

- Yield-seeking users can compare projected net APY, health factor, borrow headroom, and liquidation runway before signing.
- Wallet users get fewer prompts and a clearer "what will this position look like" preview.
- Vault builders can express strategy deposits, rebalances, and deleveraging around a consistent position model.
- Risk-aware users can treat leverage as a parameter with visible guardrails rather than as a sequence of manual protocol clicks.
- Developers can integrate with Stellar contracts and Blend pools without recreating every UI calculation from scratch.

## The Bottom Line

Aave recursive supply and Turbolong loops share the same economic shape, but the execution surface is different. On Stellar, Turbolong can use Blend's atomic request submission to make recursive lending feel like one coherent action with a previewable end state.

That is a UX improvement, not a risk eraser. The position still has debt, liquidation thresholds, rate exposure, liquidity constraints, and smart-contract risk. The value of Turbolong is that those risks can be shown before the user signs.
