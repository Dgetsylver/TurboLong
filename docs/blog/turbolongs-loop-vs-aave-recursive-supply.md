# Turbolong's loop vs Aave recursive supply

*A deep dive into how atomic leverage loops work on Stellar's Blend Protocol vs traditional EVM lending markets.*

If you've ever used DeFi lending markets like Aave to go long on an asset, you're probably familiar with **recursive supply**. The strategy is simple: supply an asset, borrow against it, swap the borrowed asset (if you're going long against a different asset) or re-supply it (if you're just looping for yield/leverage). 

To reach max leverage on Aave, you typically have two options:
1. **Manual Looping:** Supply -> Borrow -> Supply -> Borrow... over several transactions. This is tedious and gas-intensive.
2. **Flash Loans:** Borrow the total target amount upfront via a flash loan, supply it all, borrow exactly enough to repay the flash loan in a single transaction.

On Stellar, using Blend Protocol, the mechanics are fundamentally different. Let's look at why.

## What's different on Stellar?

Stellar's smart contract environment (Soroban) and the Blend Protocol architecture change how we build leverage loops. The most significant difference is the lack of native flash loans. 

### What's NOT possible (No Flash Loans)
Blend Protocol currently does not offer native flash loans, and standard flash loan providers aren't as ubiquitous on Soroban as they are on EVM networks. 
You cannot take an uncollateralized loan of a massive amount, supply it, and repay it at the end of the transaction. 

So how do you achieve 10x or 15x leverage in a single click without flash loans?

## Why atomic `pool.submit()` changes the ergonomics

Blend Protocol exposes a powerful method: `submit_with_allowance()` (or `submit()`), which takes an *array* of requests (e.g., Supply, Borrow, Repay, Withdraw).

The Blend pool processes these requests **sequentially** but evaluates the final state **atomically** within the same transaction.

This means you can batch an entire loop of operations into one single `pool.submit()` call:
`[Supply, Borrow, Supply, Borrow, Supply, Borrow, ...]`

Here is what happens under the hood:
1. **Supply:** You supply your initial collateral. 
2. **Borrow:** Because your collateral is now recognized by the pool, you can immediately borrow against it.
3. **Supply:** You take those borrowed funds and immediately supply them back to the pool *in the very next step of the array*.
4. **Borrow:** The pool recognizes your increased collateral and lets you borrow more.

This continues until you reach your target leverage. The magic here is that **borrow proceeds fund the next supply step within the same `submit()` call**. 

By the end of the execution, the pool simply checks if your final Health Factor is valid. If it is, the entire transaction succeeds.

## Who benefits?

1. **Users:** You get one-click max leverage without paying flash loan fees (typically 0.05% to 0.09% on EVM). You also save on the gas overhead of complex flash loan routing.
2. **Developers:** The code to build a leverage vault or UI becomes much simpler. Instead of integrating external flash loan contracts and writing custom receiver callbacks, Turbolong just computes the math for the loop steps and constructs an array of `Request` structs.
3. **The Network:** Because the logic stays contained within a single protocol's core loop, it reduces external dependencies and composability risks.

In Turbolong, this recursive loop is completely abstracted away. You select your leverage via a slider, and our contracts calculate the optimal array of supply/borrow requests to submit to Blend. It's atomic, capital-efficient, and native to Stellar.
