# Aquarius Cross-Listing Research

Source check date: 2026-05-19

## Decision Summary

Do not submit an Aquarius listing yet. TurboLong can only move forward after D10
ships a transferable strategy receipt token, or a wrapper that represents vault
shares as a token. The current strategy contract stores per-user vault shares in
contract storage (`VaultPos(Address)`) and exposes balances through the strategy
API, but it does not expose a separate token contract or classic Stellar asset
that Aquarius can pool, route, or vote on.

Once the token exists, the preferred route is:

1. Deploy or confirm the receipt token/wrapper contract and publish metadata.
2. Create an Aquarius AMM pool for the receipt token against USDC or XLM.
3. Seed enough liquidity for sane price discovery before promoting swaps.
4. Create the corresponding Aquarius market pair for voting if it is not already
   represented.
5. Consider a bribe only after there is enough real liquidity and a clear budget.

## What "Listing" Means On Aquarius

Aquarius is not a centralized exchange with a manual listing form. It provides
liquidity and reward surfaces around Stellar markets:

- Aquarius AMM pools: anyone can create pools for tokens available on Stellar or
  the Soroban smart-contract layer.
- SDEX rewards: eligible Stellar order-book markets can receive AQUA rewards when
  AQUA/ICE holders vote for them.
- Bribes: projects can pay voters to direct voting weight toward a market.

For TurboLong, an Aquarius cross-listing should mean making a receipt token
swappable and visible in the Aquarius pool/voting ecosystem. It should not mean
listing the current internal accounting shares, because those are not
transferable assets.

## Current TurboLong Readiness

Current repository state:

- `contracts/strategies/blend_leverage/src/storage.rs` stores per-user shares as
  `DataKey::VaultPos(Address)`.
- `contracts/strategies/blend_leverage/src/lib.rs` mints and burns strategy
  accounting shares during `deposit` and `withdraw`.
- No standalone receipt token or wrapper address is present in the repo.

Result: cross-listing is blocked by the missing asset. A listing attempt before
D10 would either fail or create a separate asset that is not redeemable for the
strategy position.

## Listing Paths

### Path A: Aquarius AMM Pool

This is the most direct path once a Soroban receipt token exists. Aquarius docs
state that AMM pools can be created with tokens on Stellar or Soroban. The pool
creator chooses the pool type and assets:

- Volatile pool: use for a receipt token whose price floats against USDC or XLM.
- Stable pool: only use if the receipt token is intended to remain close to a
  1:1 value against the paired asset. This is unlikely unless the wrapper is
  explicitly redeemable at near-par value and has low rate/liquidation drift.

Recommended first pool:

- Pair: receipt token / USDC.
- Pool type: volatile unless D10 defines a strong 1:1 redemption invariant.
- Initial liquidity: small, internally funded seed liquidity first; scale only
  after the unwrap/redeem path is monitored.

### Path B: Aquarius Voting / Reward-Zone Market

Aquarius liquidity rewards are market-vote driven. If the receipt token pair is
not represented in the voting platform, a user can create the pair. Rewards are
not automatic: AQUA and ICE holders must vote enough weight for the pair to enter
the reward zone.

This path makes sense after Path A has real liquidity. Voting before a usable
pool exists would create visibility without a working market.

### Path C: Classic Stellar Asset Wrapper

If Aquarius voting or SDEX order-book tools cannot use the D10 Soroban token
directly, create a classic Stellar asset wrapper. This adds operational risk
because the wrapper issuer must maintain a verifiable mint/redeem bridge with the
underlying strategy shares.

Use this path only if:

- the Aquarius UI cannot pool/vote the Soroban receipt token directly,
- wrapper issuer controls and freeze/clawback policy are documented,
- mint/redeem accounting can be tested against strategy deposits and withdrawals,
- emergency unwind behavior is defined.

## Cost Model

| Item | Current requirement | Notes |
| --- | --- | --- |
| Aquarius AMM pool creation | 300,000 AQUA | Paid when creating a pool. USD cost changes with AQUA price. |
| New Aquarius voting pair | Up to 5 XLM | Used to create voting wallets/trustlines for a new market pair. |
| Bribe campaign | Minimum value of 100,000 AQUA per week | Optional. Aquarius validates by converting enough of the bribe to 100,000 AQUA at collection time. |
| AQUA reward receipt | AQUA trustline required | Needed by wallets that receive AQUA rewards. |
| Stellar base reserves | 1 XLM minimum account balance plus 0.5 XLM per subentry | Trustlines, offers, signers, and data entries add reserves. |
| Classic SDEX offers | Network fees plus offer reserve impact | Relevant only if also placing order-book liquidity. |
| Native Stellar AMM pool participation | Trustlines to both assets and a pool-share trustline | Pool-share trustline requires 2 base reserves; native AMM fee is 30 bps. Aquarius AMM rewards now target Aquarius Soroban AMMs, not the legacy native AMM. |
| Seed liquidity | Product decision | Must be large enough to avoid unsafe price impact, but not so large that wrapper defects or strategy unwind failures create outsized losses. |

## Operational Requirements

Before creating a pool:

- D10 receipt token or wrapper is deployed on the intended network.
- Token metadata is published: name, symbol, decimals, contract/asset address,
  issuer or admin policy, and redeemability model.
- The token has a clear valuation source. For a vault share, this should be
  share price or redeemable underlying value, not only market price.
- Treasury seed-liquidity budget is approved.
- The team confirms whether the token should be paired with USDC, XLM, or both.
- Monitoring exists for price deviation, pool TVL, volume, and withdrawal
  failures.

Before seeking AQUA rewards:

- The pool has active liquidity and successful swap/withdraw history.
- The voting pair exists or is ready to be created.
- AQUA or ICE voting budget is understood.
- If using bribes, the weekly budget can clear the 100,000 AQUA minimum-value
  check at collection time.

## Risks

- Receipt-token mismatch: an asset that is not redeemable for strategy shares
  creates misleading liquidity.
- Pricing drift: vault share value changes with leveraged yield, borrow rates,
  BLND rewards, and health-factor changes.
- Redemption risk: users buying the receipt token need a documented path to
  redeem or unwrap.
- Liquidity fragmentation: a low-liquidity pool can produce bad swap quotes and
  weak price discovery.
- Incentive farming: AQUA rewards or bribes may attract short-term capital that
  leaves once incentives end.
- Wrapper custody/admin risk: a classic asset wrapper introduces issuer-policy
  and mint/burn correctness risk.

## Proposed Implementation Sequence

1. Finish D10 so vault shares are represented by a transferable Soroban token or
   a wrapper with a contract/asset address.
2. Add token metadata and a public docs page with redeem/unwrap instructions.
3. Add integration tests that deposit into TurboLong, mint or wrap the receipt,
   transfer it, and redeem it back to underlying value.
4. Test Aquarius pool creation on testnet if Aquarius supports the same token
   surface there; otherwise run local Soroban contract tests around token
   approval, transfer, and unwrap/redeem flows.
5. Create a small mainnet Aquarius volatile pool against USDC.
6. Add monitoring for pool TVL, swap price impact, receipt-token premium/discount,
   and failed redeem/withdraw attempts.
7. Create or vote for the Aquarius market pair.
8. Reassess whether a bribe is economical after observing organic liquidity.

## Integration Tests

No Aquarius integration test is applicable in this PR because the asset to list
does not exist yet. The tests to add with D10 are:

- Receipt token exists: deploy D10 token/wrapper, assert name/symbol/decimals and
  transferability.
- Deposit-to-receipt: deposit USDC into the strategy and assert receipt balance
  increases.
- Transfer-to-redeem: transfer receipt tokens to a second account and redeem or
  unwrap to underlying value.
- Slippage guard: pool deposit/swap calls reject stale or unsafe price bounds.
- Accounting invariant: total receipt supply matches strategy shares or wrapper
  reserves after deposit, transfer, redeem, and harvest.

## Sources

- Aquarius docs: [Welcome to Aquarius](https://docs.aqua.network/)
- Aquarius docs: [Creating a Pool](https://docs.aqua.network/amm-and-pools/pools/creating-a-pool)
- Aquarius docs: [Deposit & Withdraw Liquidity](https://docs.aqua.network/amm-and-pools/pools/deposit-and-withdraw-liquidity)
- Aquarius docs: [How to vote for markets on Aquarius](https://docs.aqua.network/guides/how-to-vote-for-markets-on-aquarius)
- Aquarius docs: [Aquarius AMM Rewards](https://docs.aqua.network/aquarius-aqua-rewards/aquarius-amm-rewards)
- Aquarius docs: [How to create bribes](https://docs.aqua.network/guides/how-to-create-bribes)
- Stellar docs: [Lumens, fees, and base reserves](https://developers.stellar.org/docs/learn/fundamentals/lumens)
- Stellar docs: [Stellar accounts and trustlines](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts)
- Stellar docs: [SDEX and liquidity pools](https://developers.stellar.org/docs/learn/fundamentals/liquidity-on-stellar-sdex-liquidity-pools)
