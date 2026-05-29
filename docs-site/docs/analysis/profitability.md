---
sidebar_position: 1
---

# Profitability Analysis

This analysis examines whether the known leverage loop vulnerabilities in Blend Protocol are actually profitable for attackers, or if protocol design prevents exploitation.

## Executive Summary

| Vulnerability                          | Capital Required | Annual Cost | Annual Revenue | Profitable?          |
| -------------------------------------- | ---------------- | ----------- | -------------- | -------------------- |
| **1. Circular Collateral Lock**        | $106K            | $3,337      | **$0**         | ❌ NO                |
| **2. Rate Manipulation → Liquidation** | $106K            | $3,337      | $200–400       | ❌ NO                |
| **3. Cascade Liquidation**             | —                | —           | —              | ❌ N/A (impossible)  |
| **4. Backstop Exhaustion**             | $129K            | $10,800     | **$0**         | ❌ NO                |
| **🟢 BLND Farming (Legitimate)**       | **$100**         | $0.36       | $31–312        | ✅ YES (31–312% APY) |

## The Core Economics

### Why Attacks Fail: Three Structural Reasons

#### 1. No Flash Loans on Soroban

Every attack requires real capital locked up with real carry costs. Flash loans (zero-capital atomic borrows) do not exist on Stellar/Soroban. This eliminates entire attack classes.

#### 2. Backstop Take Rate Caps HF Erosion

The 20% backstop take rate hardcodes the maximum supply-borrow spread:

```
spread = borrow_APR × (1 − util × (1 − backstop_rate))
```

Even at 100% utilization, spread ≤ 20% of borrow rate. At 5% annual borrow rate, that's only 1% max spread — causing HF to erode at ~1%/year, taking years to trigger liquidation.

#### 3. Pool Size is Small (~$115K USDC)

Liquidation profits are tens of dollars per position, while manipulation capital is hundreds of thousands. The cost-benefit doesn't scale.

## Vulnerability 1: Circular Collateral / Liquidity Lock

**Concept:** Push utilization above 95% to lock collateral as illiquid d-tokens, breaking liquidation incentives.

### Can We Push Util Above 95% for Free?

No. To deposit-and-borrow the same asset $1,000:

- Deposit increases numerator (supply) by 1,000
- Borrow increases denominator impact (borrow) by ~950

Result: utilization stays at ~95% × (1,000 / (1,000 + existing_supply)).

To actually exceed 95%, need **non-USDC collateral** (e.g., XLM at c=0.75).

### Capital & Costs

```
To push from 30% → 99% utilization on USDC:
  Need to borrow: ~$79,650 additional USDC
  XLM collateral required: $79,650 / 0.75 = $106,200

Annual carry cost: 4.19% × $79,650 = $3,337/year
```

### Revenue from This Attack

**$0.**

There's no mechanism to monetize a liquidity lock. You can't:

- Short USDC (it's a stablecoin = $1.00)
- Profit from others' liquidations (the whole point is they _can't_ liquidate)
- Redeem d-tokens (they're locked at high utilization)

**Verdict:** Expensive griefing, zero revenue.

---

## Vulnerability 2: Rate Manipulation → Forced Liquidation

**Concept:** Push utilization to spike borrow APR from 0.19% to 5.19% (500% penalty zone), eroding others' health factors until liquidation.

### The Erosion Math

Health factor erosion speed is limited by the spread:

$$\text{time\_to\_liquidation} = \frac{\ln(\text{HF})}{\text{spread\_rate}} \times 365$$

For a position at HF=1.056 (just-safe):

```
At 100% util (worst case):
  Spread = 5.19% × 0.20 = 1.04%/year
  Time = ln(1.056) / 0.0104 × 365 = 1,912 days ≈ 5.2 years

For aggressive position at HF=1.01:
  Time = ln(1.01) / 0.0104 × 365 = 350 days ≈ 1 year
```

Even at extreme rates, it takes **years** to liquidate a healthy position.

### Attacker Cost vs Revenue

**Cost:**

- XLM capital locked: $106,200
- Carry cost (1 year at 4.19%): $3,337
- XLM price risk: substantial (25% drop = $26K loss)

**Revenue** (liquidating 10 positions after 1 year):

- Per liquidation profit: $20–40
- Total revenue: $200–400/year

**ROI:** -89% (losing $3K to make $300)

**Verdict:** Costs exceed revenue by 10×. Not profitable.

---

## Vulnerability 3: Cascade Liquidation

**Concept:** One liquidation's supply/borrow shift pushes other positions into liquidation.

### Why It's Impossible

Liquidation **decreases** utilization:

```
Before liquidation:
  util = 34,500 / 115,000 = 30.0%

Liquidate $900 debt + $1,000 collateral:
  util = (34,500 - 900) / (115,000 - 1,000)
       = 33,600 / 114,000 = 29.5%

Utilization DOWN → interest rates DOWN → other positions SAFER
```

There is no cascade mechanism. Liquidations improve pool health, not degrade it.

**Verdict:** The attack vector does not exist.

---

## Vulnerability 4: Backstop Exhaustion

**Concept:** Create enough bad debt to exceed the backstop's capital, making the pool insolvent.

### Bad Debt Calculation

Bad debt only occurs when `collateral < debt` (after liquidation). For a USDC position, this requires years of interest accrual from Vuln #2 (not feasible).

To generate $50 bad debt per position at $100 equity:

- Need ~230 positions to hit backstop limit (~$11,500)
- Capital required: $23,000 in positions + $106,000 manipulation = **$129,000 total**
- Time: 5+ years
- Annual cost: ~$10,800

### Revenue from Insolvency

**$0 direct monetization.**

If the pool becomes insolvent:

- Bad debt is socialized to remaining depositors
- Pool may be frozen by Blend Foundation
- No mechanism for attacker to capture value
- BLND shorting is impractical (illiquid token)

**Verdict:** Multi-year effort, massive capital, zero revenue.

---

## The Legitimate Path: BLND Emissions Farming

The **only** profitable strategy is what TurboLong is designed for:

### Setup: $100 Equity, 10× Leverage

```
Supplied: $1,000 USDC
Borrowed: $900 USDC
Health Factor: 1.056 (safe)
```

### Interest Costs (Negligible)

```
At 50% utilization:
  Supply earnings:  $1,000 × 0.028% = $0.28/year
  Borrow costs:     $900 × 0.070% = $0.63/year
  Net interest:     -$0.35/year

Interest cost is negligible (<0.1% of returns).
```

### BLND Emissions (Primary Return)

From on-chain observation (Etherfuse params):

```
Pool total supply: ~$115,000 USDC
Emission rate: ~4.68% APR in BLND

My share: $1,000 / $115,000 = 0.87%
Annual BLND: 0.87% × $115,000 × 4.68% / BLND_price
           = $47 / BLND_price
```

### APY by BLND Price

| BLND Price | Supply-side BLND APY | Borrow-side BLND APY | Total Effective APY |
| ---------- | -------------------- | -------------------- | ------------------- |
| $0.005     | 7.8%                 | 23.4%                | **~31%**            |
| $0.010     | 15.6%                | 46.8%                | **~62%**            |
| $0.030     | 46.8%                | 140.4%               | **~187%**           |
| $0.050     | 78.0%                | 234.0%               | **~312%**           |
| $0.100     | 156.0%               | 468.0%               | **~624%**           |

**Takeaway:** Even at conservative $0.005 BLND, the position earns 31% APY on $100 equity ($31/year) — offsetting interest costs by 100×.

### Profitability Verdict

| Metric               | Value                              |
| -------------------- | ---------------------------------- |
| Capital required     | **$100**                           |
| Annual interest cost | $0.36                              |
| Annual BLND revenue  | $31–$312 (depending on price)      |
| Time to first profit | **Immediate** (per-second accrual) |
| **Profitable?**      | **✅ YES — 31–312% annual return** |

**Why this works:**

1. Leverage multiplies your emission share linearly (10× capital → 10× share)
2. Interest costs remain constant (minimal spread at normal utilization)
3. BLND emissions scale with your position size
4. No capital locks or carry costs

---

## Risk Factors (Legitimate Strategy)

Even though the emissions farming is profitable, risks exist:

### 1. BLND Price Volatility

BLND has traded $0.005–$0.10 historically. A 90% crash to $0.001 would reduce APY from 186% to 1.86%.

**Mitigation:** Only deploy capital you can afford to lose. Diversify across assets.

### 2. Emission Rate Reduction

Blend governance can vote to reduce emission rates. The current 4.68% supply APY could drop to 2%.

**Mitigation:** Monitor governance; adjust leverage accordingly.

### 3. Smart Contract Risk

No code is 100% safe. Blend and TurboLong have been audited, but exploits could occur.

**Mitigation:** Use only funds you can afford to lose. Check security reports regularly.

### 4. Liquidation Risk

If HF drops below 1.05, your position will be liquidated.

**Mitigation:** Monitor HF weekly. Keep it > 1.20 as a safety buffer.

---

## Conclusion

**All four attacks fail on protocol fundamentals:**

- No flash loans = real capital requirements
- Backstop rate caps spread = slow HF erosion
- Small pool = tiny liquidation profits

**The designed incentive mechanism works:**

- Leverage multiplies emission share
- Interest costs stay negligible
- ROI of 30–300% is achievable

Use TurboLong for what it's designed for (BLND emissions farming), not for exploiting vulnerabilities. The math doesn't support exploitation — only legitimate yield generation.

**For more on vulnerabilities and mitigations, see:**

- [Security Reports](../security/vulnerability-reports.md)
- [Architecture: Blend Protocol](../architecture/blend-protocol.md)
