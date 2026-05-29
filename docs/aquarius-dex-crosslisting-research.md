# Aquarius DEX Cross-Listing Research

**Feature:** Aquarius (Aquarius DEX) cross-listing of the TurboLong strategy receipt token  
**Depends on:** D10 (mainnet vault deployment — `vaultId` populated in `defindex.ts`)  
**Status:** Research / Pre-decision  
**Date:** May 2026

---

## 1. Executive Summary

The TurboLong DeFindex vault issues a fungible receipt token (dfToken) to depositors representing their pro-rata share of the leveraged USDC strategy. Listing this token on Aquarius — Stellar's primary on-chain liquidity layer — would allow holders to trade, exit, or use their position without going through the vault's `withdraw()` function. This document covers what Aquarius is, what listing requires technically and economically, the risks and benefits, and a recommended path forward.

**Recommendation:** Proceed with a dfToken/USDC pool on Aquarius AMM once the mainnet vault is deployed and has accumulated ≥ $50,000 TVL. The listing itself is permissionless and costs only Soroban transaction fees. The real work is seeding initial liquidity and campaigning for AQUA reward votes.

---

## 2. What Is Aquarius?

Aquarius is Stellar's liquidity incentive and AMM layer. It operates in two modes:

### 2.1 SDEX Rewards (Classic Stellar DEX)
- Any Stellar asset pair can be listed on the SDEX (Stellar Decentralized Exchange) by simply placing an offer.
- Aquarius distributes AQUA tokens hourly to market makers on pairs that receive sufficient community votes.
- Requirement: the pair must receive **≥ 1% of all AQUA liquidity votes** cast in a given period to qualify for rewards.

### 2.2 Aquarius AMM (Soroban-based)
- Launched in 2024 using Soroban smart contracts.
- Fully permissionless: anyone can create a pool for any two SEP-41 compliant tokens.
- Two pool types:
  - **Volatile pool** — constant-product AMM (x·y=k), customizable fee 0.1%–1%.
  - **Stable swap pool** — optimized for pegged assets (e.g. USDC/dfToken if dfToken trades near NAV).
- Pool creation requires only Soroban transaction fees (a few XLM at most).
- AMM pools can also receive AQUA rewards if they accumulate enough liquidity votes.

The Aquarius AMM entry point contract on mainnet is:  
`CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK`

---

## 3. The Receipt Token (dfToken)

### 3.1 What it is
When a user deposits USDC into the TurboLong vault (`buildVaultDepositXdr`), the DeFindex strategy contract mints dfTokens proportional to the current share price:

```
shares_minted = deposit_amount / share_price
share_price   = total_equity / total_shares
```

The `position()` method returns `(equity, total_shares, b_tokens, d_tokens, b_rate, d_rate)`. Share price appreciates over time as the leveraged strategy earns net yield.

### 3.2 Token standard
DeFindex vault tokens implement the **SEP-41 token interface** (Stellar's equivalent of ERC-20), which is the standard required by Aquarius AMM. The interface includes `transfer`, `balance`, `allowance`, `approve`, `decimals`, `name`, `symbol`.

### 3.3 Current status
- Testnet vault: `CDOETIUHCETALQMBMYUXGFJFA34KDTV74AMHTWXJLY2XUVNZ23JDLJZA`
- Mainnet vault: **not yet deployed** (`vaultId: ""` in `defindex.ts`)
- D10 (mainnet deployment) is a prerequisite for any listing.

### 3.4 Wrapper consideration
The scope mentions "or a wrapper." A wrapper would be a separate SEP-41 contract that wraps dfTokens 1:1 to present a cleaner interface or different metadata. This is **not necessary** — dfTokens are already SEP-41 compliant. A wrapper adds smart contract risk and complexity with no benefit unless the vault contract has a non-standard interface. Recommendation: list the dfToken directly.

---

## 4. Listing Requirements

### 4.1 Technical requirements

| Requirement | Status | Notes |
|---|---|---|
| SEP-41 token interface | ✅ DeFindex implements this | Confirmed by `invokeRead` calls in `defindex.ts` |
| Mainnet contract deployed | ❌ Pending D10 | `vaultId` is empty string |
| Token metadata (name, symbol, decimals) | ✅ Set at deploy time | `assetSymbol: "USDC"`, `decimals: 7` — vault token needs its own symbol (e.g. `tlUSDC`) |
| No freeze authority required | ✅ Soroban contracts have no freeze authority by default | Unlike classic Stellar assets |

### 4.2 Pool creation process (Aquarius AMM)

1. Call the Aquarius AMM entry point contract's `create_pool` function with:
   - `tokens: [dfToken_contract_id, USDC_contract_id]` (ordered lexicographically)
   - `pool_type: Volatile` (recommended — dfToken is not pegged 1:1 to USDC, it appreciates)
   - `fee_fraction: 30` (0.3% — standard for non-stablecoin pairs)
2. Deposit initial liquidity via `deposit()`.
3. The pool is immediately live and tradeable.

No approval, whitelist, or governance vote is required to create the pool. The pool exists on-chain regardless of AQUA votes.

### 4.3 SDEX listing (optional, parallel)

To list on the classic SDEX:
1. Create a trustline to the dfToken in a market-making wallet.
2. Place buy/sell offers via `manage_sell_offer` or `manage_buy_offer` operations.
3. Cost: 0.5 XLM base reserve per trustline.

SDEX listing is simpler but provides less liquidity depth than an AMM pool.

---

## 5. Costs

| Item | Estimated Cost | Notes |
|---|---|---|
| Pool creation (Soroban tx) | ~0.1–0.5 XLM | Soroban resource fee; negligible |
| Initial liquidity seed | **$5,000–$20,000** | dfToken + USDC pair; determines initial depth and slippage |
| SDEX voting wallet creation | ~5 XLM | Per Aquarius docs: "up to 5 XLM for new voting wallets" |
| AQUA for liquidity voting | Variable | To qualify for AQUA rewards, the pair needs ≥ 1% of all votes; at 1B AQUA total votes, that's ≥ 10M AQUA (~$1,000–$5,000 at current prices) |
| Ongoing LP management | Team time | Rebalancing, monitoring impermanent loss |
| Bribe campaign (optional) | Variable | Aquarius supports "bribes" — paying AQUA holders to vote for your pair |

**Total minimum cost to list and seed:** ~$5,000–$20,000 in initial liquidity + negligible on-chain fees.  
**Cost to qualify for AQUA rewards:** additional 10M+ AQUA in votes (can be sourced from community or purchased).

---

## 6. Benefits

### 6.1 Secondary market exit
Without an AMM listing, the only way to exit a vault position is via `withdraw()`, which calls the DeFindex contract and unwinds part of the leveraged position. This:
- Requires the vault to have sufficient liquidity headroom.
- Takes multiple Soroban transactions.
- May fail if pool utilization is high.

An AMM listing lets holders sell dfTokens directly for USDC without touching the vault, improving UX and reducing smart contract interaction risk for exits.

### 6.2 Composability
A tradeable dfToken can be:
- Used as collateral in other Blend pools (if listed as a reserve asset — separate governance process).
- Integrated into other DeFindex strategies as an input asset.
- Held by wallets and protocols that understand SEP-41 tokens without needing vault-specific integration.

### 6.3 Price discovery
An on-chain market provides a real-time market price for the vault share, which may differ from NAV (net asset value) based on demand. A premium to NAV signals strong demand; a discount signals exit pressure.

### 6.4 AQUA rewards for LPs
If the pair accumulates enough votes, LPs earn AQUA tokens on top of trading fees, improving LP economics and attracting more liquidity.

### 6.5 Ecosystem visibility
Aquarius is the primary liquidity hub for Stellar DeFi. Listing there increases TurboLong's visibility to the broader Stellar community and potential integrators.

---

## 7. Risks

### 7.1 Impermanent loss for LPs
dfToken appreciates over time (share price increases as yield accrues). In a dfToken/USDC pool, this creates **one-directional impermanent loss**: the pool continuously rebalances toward USDC as dfToken price rises, meaning LPs effectively sell dfTokens at below-NAV prices over time.

**Mitigation:** Use a stable swap pool type if dfToken trades close to USDC (e.g. if the vault has low leverage and slow appreciation). For a 3× leveraged vault earning ~10% net APY, share price appreciates ~10%/year — this is meaningful IL for LPs.

**Alternative:** A single-sided liquidity mechanism or a concentrated liquidity pool (not currently available on Aquarius) would reduce this. For now, LPs should be aware of the IL profile.

### 7.2 Thin liquidity / high slippage
At early TVL, the AMM pool will have thin liquidity. A $10,000 seed provides roughly $5,000 depth per side, meaning a $500 trade would move price ~5%. This makes the market unattractive for larger traders.

**Mitigation:** Seed with at least $20,000 and run a bribe campaign to attract external LPs.

### 7.3 Vault not yet deployed
D10 (mainnet vault deployment) is a hard prerequisite. Listing a testnet token on mainnet Aquarius is not meaningful.

### 7.4 dfToken symbol collision
The vault token's `symbol()` should be distinct from `USDC` (the underlying). A symbol like `tlUSDC` (TurboLong USDC) or `dfUSDC-ETH` (DeFindex USDC Etherfuse) should be set at deployment time. This needs to be confirmed with the DeFindex team before deployment.

### 7.5 Regulatory considerations
Receipt tokens representing leveraged DeFi positions may be subject to securities regulations in some jurisdictions. This is a general DeFi risk, not specific to Aquarius listing, but listing on a public DEX increases visibility. The existing disclaimer in the app covers this for direct users; secondary market buyers may not see it.

---

## 8. Comparison: Direct Listing vs. Wrapper

| Approach | Pros | Cons |
|---|---|---|
| **List dfToken directly** | No extra contract, no extra audit surface, simpler UX | dfToken symbol/metadata must be set correctly at vault deploy |
| **Wrapper contract** | Can add custom metadata, freeze/pause functionality | Extra smart contract risk, extra audit cost, extra complexity, no functional benefit |

**Decision: list dfToken directly.** The wrapper adds no value for this use case.

---

## 9. Comparison: AMM Pool vs. SDEX Only

| Approach | Pros | Cons |
|---|---|---|
| **Aquarius AMM pool** | Passive liquidity, no active market-making required, eligible for AQUA AMM rewards | Requires initial liquidity seed, IL risk for LPs |
| **SDEX only** | No liquidity seed required, simpler | Requires active market-making, spread-based, less capital-efficient |
| **Both** | Maximum coverage | More operational overhead |

**Recommendation:** Start with AMM pool only. Add SDEX market-making later if there is demand from professional market makers.

---

## 10. Integration Tests (if listing proceeds)

If the listing is greenlit, the following integration tests should be written:

### 10.1 Pool creation test
- Deploy a test dfToken on testnet with SEP-41 interface.
- Call Aquarius AMM `create_pool` with dfToken + USDC.
- Assert pool address is returned and pool is queryable via `get_pools`.

### 10.2 Deposit/withdraw liquidity test
- Deposit dfToken + USDC into the pool.
- Assert LP share tokens are minted.
- Withdraw liquidity.
- Assert dfToken + USDC are returned (minus fees).

### 10.3 Swap test
- Swap USDC → dfToken via the pool.
- Assert output amount is within expected slippage bounds.
- Swap dfToken → USDC.
- Assert round-trip loss is bounded by pool fee.

### 10.4 Price tracking test
- After vault yield accrues (share price increases), assert that the AMM pool price of dfToken in USDC is ≥ previous price (arbitrage should keep it near NAV).

These tests would live in `tests/aquarius_integration.rs` and use the same mainnet-fork snapshot infrastructure already in place (`tests-snapshot-source/`).

---

## 11. Recommended Action Plan

| Step | Owner | Prerequisite | Effort |
|---|---|---|---|
| 1. Confirm dfToken symbol/metadata with DeFindex team | TurboLong team | — | Low |
| 2. Deploy mainnet vault (D10) | TurboLong team | — | High |
| 3. Create Aquarius AMM pool (dfToken/USDC, volatile, 0.3% fee) | TurboLong team | D10 complete | Low (1 tx) |
| 4. Seed initial liquidity ($10K–$20K) | TurboLong team / treasury | Pool created, TVL ≥ $50K | Medium |
| 5. Submit pair to Aquarius voting UI | TurboLong team | Pool created | Low |
| 6. Run bribe campaign or community vote for AQUA rewards | TurboLong team | Pair submitted | Medium |
| 7. Write and run integration tests | TurboLong team | Testnet pool available | Medium |
| 8. Add "Trade dfToken" link to frontend | TurboLong team | Pool live | Low |

**Greenlight criteria:** D10 deployed, vault TVL ≥ $50,000, dfToken symbol confirmed.

---

## 12. References

- [Aquarius AMM — Creating a Pool](https://docs.aqua.network/amm-and-pools/pools/creating-a-pool) — permissionless pool creation, fee options
- [Aquarius AQUA Rewards](https://docs.aqua.network/aquarius-aqua-rewards) — 1% vote threshold for reward eligibility
- [Aquarius Soroban Functions](https://docs.aqua.network/developers/aquarius-soroban-functions) — AMM contract entry point and function signatures
- [How to Vote for Markets](https://docs.aqua.network/guides/how-to-use-aqua.network-vote) — ~5 XLM for voting wallet creation
- [Aquarius Bribes](https://docs.aqua.network/bribes) — incentivizing AQUA holders to vote for a pair
- [SEP-41 Token Interface](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md) — Stellar token standard
- [Stellar Composability Blog Post](https://stellar.org/blog/developers/composability-on-stellar-from-concept-to-reality) — context on Stellar DeFi composability
- [DeFindex](https://www.defindex.io/) — vault infrastructure provider
- `frontend/src/defindex.ts` — vault contract interface in this codebase
- `doc.md` — leverage loop strategy documentation
