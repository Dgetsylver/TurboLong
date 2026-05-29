---
sidebar_position: 2
---

# User Guide & UX Research

This guide synthesizes insights from 100 user personas and distills best practices for using TurboLong effectively.

## Health Factor (HF) — Your Primary Metric

**Health Factor** is the ratio of collateral value to debt:

```
HF = (Collateral × Collateral Factor) / Debt
```

For USDC (c_factor = 0.95):

```
HF = (Supplied USDC × 0.95) / Borrowed USDC
```

### What HF Means

| HF Range | Status | Risk Level |
|----------|--------|-----------|
| **> 2.0** | Safe | Very low liquidation risk |
| **1.5–2.0** | Healthy | Good risk/reward balance |
| **1.2–1.5** | Risky | Monitor closely |
| **1.05–1.2** | Danger | Liquidation likely soon |
| **< 1.05** | Liquidatable | Position will be liquidated |

### Real-Time HF Monitoring

Your HF changes as:
1. **Interest rates fluctuate** — Higher borrow rates erode HF faster
2. **Pool utilization changes** — Affects the interest rate curve
3. **Your position adjusts** — Adding/removing collateral or leverage

Check your HF every time you adjust your position.

## Understanding Liquidation

### When Liquidation Happens

Your position is liquidated when HF < 1.05 (or the pool's liquidation threshold).

### What Happens

1. **A liquidator** sees your position is below the threshold
2. **They repay your debt** using their own capital
3. **They receive your collateral** as reward
4. **You receive the difference** (collateral − repaid debt − liquidation fee)

### Example

```
Your position:
  Supplied: $1,000 USDC
  Borrowed: $900 USDC
  HF = 1.056 (just barely safe)

Liquidation event:
  Liquidator repays: $900 USDC
  Liquidator receives: ~$950 USDC of your collateral
  You receive: $50 USDC (remainder)
  Your loss: $950 (the majority of your position)
```

### Prevention

To avoid liquidation:
- **Keep HF > 1.20** as a safety buffer
- **Reduce leverage** if rates spike
- **Add more collateral** if you see HF dropping
- **Use alerts** — Set up email alerts when HF approaches danger zones

## Interest Rates & APY

TurboLong interest rates follow Blend Protocol's three-kink model:

### Interest Rate Curve

| Utilization | Borrow APR | Supply APR | Net APY |
|-------------|-----------|-----------|--------|
| 50% (target) | 0.070% | 0.028% | -0.042% |
| 80% | 0.110% | 0.070% | -0.040% |
| 95% (max) | 0.190% | 0.144% | -0.046% |
| 97% | 2.19% | 1.70% | -0.49% |
| 99% | 4.19% | 3.32% | -0.87% |
| 100% | 5.19% | 4.15% | -1.04% |

### What This Means

- **At low utilization (50%):** You earn 0.028% APY on supplied funds but pay 0.070% APY on borrowed funds — **net cost of 0.042%/year**
- **At high utilization (95%+):** Rates spike dramatically — your HF erodes faster
- **Target utilization (80%):** Pool operates most efficiently here

### Expected APY

For a 10× leveraged position with $100 equity:

```
Supplied: $1,000 USDC
Borrowed: $900 USDC

At 50% utilization:
  Supply earnings:    $1,000 × 0.028% = $0.28/year
  Borrow costs:       $900 × 0.070% = $0.63/year
  Net interest loss:  -$0.35/year
  BLND emissions:     ~$31–312/year (depending on BLND price)
  Total APY:          ~31–312% (BLND-driven)

At 95% utilization:
  Supply earnings:    $1,000 × 0.144% = $1.44/year
  Borrow costs:       $900 × 0.190% = $1.71/year
  Net interest loss:  -$0.27/year
  BLND emissions:     ~$31–312/year
  Total APY:          ~31–312% (BLND-driven)
```

**Key insight:** Interest costs are tiny (~$0.35/year). Your return comes almost entirely from BLND emissions.

## Risk Management Strategies

### Conservative (HF Target > 2.0)

- Leverage: **2–3×**
- Best for: First-time users, risk-averse investors
- Annual APY: ~10–50% (mostly BLND)
- Liquidation risk: Very low

### Balanced (HF Target 1.5–2.0)

- Leverage: **5–8×**
- Best for: Experienced users, passive income seekers
- Annual APY: ~50–150%
- Liquidation risk: Moderate

### Aggressive (HF Target 1.2–1.5)

- Leverage: **10–12×**
- Best for: Yield optimizers, active managers
- Annual APY: ~150–300%
- Liquidation risk: High — requires active monitoring

### Rebalancing Rules of Thumb

1. **If HF > 2.0:** You can afford more leverage — consider moving to Balanced
2. **If HF 1.5–2.0:** Adjust as rates change; hold steady
3. **If HF 1.2–1.5:** Monitor weekly; reduce leverage if rates spike
4. **If HF 1.05–1.2:** Reduce leverage or add collateral immediately

## Position Sizing

### How Much Should You Deploy?

A common approach from the user research:

1. **Assess your risk tolerance** — How much can you afford to lose?
2. **Size for 1–2% portfolio loss at liquidation**
   - If liquidation costs you $50, risk only that much
3. **Example:** 
   - Portfolio: $10,000
   - Max acceptable loss: $100 (1%)
   - Position size: $100 at 10× leverage
   - You control $1,000 worth of assets

### Diversification Across Pools

Rather than deploying all capital to one asset at max leverage:

- **$300 in USDC at 10×** (conservative USDC loops)
- **$200 in CETES at 5×** (medium-risk Brazilian bonds)
- **$100 in USTRY at 3×** (high-risk emerging market debt)

Diversification reduces exposure to any single oracle or pool failure.

## Advanced: Rate Monitoring

### When to Adjust Your Position

**Rates are rising (HF eroding):**
- Check pool utilization — is it above 80%?
- Consider adding collateral or reducing leverage
- Long-term: switch to a less-crowded pool

**Rates are falling (HF improving):**
- You have more buffer — consider increasing leverage
- Or lock in gains by reducing your position

### Finding Rate Data

- **On-chain:** Query Blend Protocol directly via StellarExpert
- **Dashboard:** TurboLong displays real-time rates for each pool
- **Alerts:** Set up email alerts for rate crosses

## FAQs

**Q: Can I lose more than my initial investment?**

A: No. If your position is liquidated, the liquidator receives your collateral. You lose your principal but not more. There are no negative balances on DeFi protocols.

**Q: What happens if the pool has a smart contract bug?**

A: Blend Protocol has been audited, but no audit is 100% foolproof. TurboLong carries smart contract risk. Only use funds you can afford to lose. Check the [Security](../security/vulnerability-reports.md) section for known issues.

**Q: Can I withdraw my collateral while the position is open?**

A: No. Your collateral is locked until you close the position (repay debt and withdraw collateral). You can **add** more collateral but cannot remove it while borrowed.

**Q: How do I close my position?**

A: Click **"Close Position"** on your dashboard. This will:
1. Repay all your debt from your collateral
2. Return the remainder to your wallet

**Q: What's the minimum position size?**

A: There is no on-chain minimum, but practically:
- Fees are ~$0.0001–0.001 per transaction
- At least $50–100 makes sense to overcome fee drag

**Q: Do I have to reinvest my BLND rewards?**

A: No. BLND accumulates in your account and you can claim it anytime. But reinvesting compounds your returns — a common strategy among yield optimizers.
