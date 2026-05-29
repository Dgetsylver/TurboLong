---
sidebar_position: 1
---

# Getting Started

This guide walks you through opening your first leveraged position on TurboLong.

## Prerequisites

1. **A Stellar wallet** — Freighter, xBull, Albedo, Lobstr, or Hana
2. **USDC or another supported asset** — At least $50 recommended
3. **XLM for fees** — A few stroops (~$0.0001) per transaction

## Step 1: Connect Your Wallet

1. Visit [turbolong.xyz](https://turbolong.xyz)
2. Click **"Connect Wallet"** in the top-right corner
3. Select your wallet provider
4. Approve the connection in your wallet extension

## Step 2: Choose Your Asset and Pool

1. On the main dashboard, click **"New Position"**
2. Select your desired asset (USDC, CETES, USTRY, TESOURO, or XLM)
3. Choose a pool:
   - **Etherfuse** — Largest liquidity, most stable rates
   - **Fixed** — Fixed-rate lending, predictable APY
   - **YieldBlox** — Community-managed pool

## Step 3: Enter Amount and Set Leverage

1. Enter the amount you want to supply as collateral
2. Use the **leverage slider** to select your multiplier (1–12.9×)
3. Watch the **Health Factor (HF)** update in real-time
   - **Green (>1.5):** Safe
   - **Yellow (1.2–1.5):** Caution
   - **Red (<1.2):** High liquidation risk

## Step 4: Review and Approve

1. Check the **transaction summary**:
   - Total collateral
   - Estimated borrow amount
   - Expected APY
   - Fees
2. Click **"Preview"** to simulate the transaction
3. Click **"Open Position"**
4. Approve in your wallet

## Step 5: Monitor Your Position

1. Your position is now live!
2. Watch your **Health Factor** — it adjusts as rates change
3. Check **Current APY** — updated every block
4. Monitor **Accrued Interest** — how much you've earned or owe

## Tips for Success

### Set Your Health Factor Target

A good HF depends on your risk tolerance:

- **HF > 2.0** — Very conservative, low liquidation risk, lower yield
- **HF 1.5–2.0** — Moderate risk, good balance
- **HF 1.2–1.5** — Aggressive, higher liquidation risk, max yield

### Understand Liquidation

If your HF drops below 1.05, your position is at risk of liquidation:

- A **liquidator** repays your debt and claims your collateral
- You lose some capital but the position doesn't disappear
- **Best practice:** Keep HF > 1.20 to avoid this

### Rebalance as Rates Change

Interest rates change as pool utilization fluctuates. If your HF drops:

1. **Add collateral** — Deposit more of the leveraged asset
2. **Reduce leverage** — Close part of your position
3. **Compound earnings** — Reinvest BLND rewards to boost HF

## Next Steps

- Learn about [Health Factors and Risk](user-guide.md)
- Explore [Interest Rate Mechanics](../architecture/leverage-mechanism.md)
- Check [Real-time APY Rates](https://turbolong.xyz)
