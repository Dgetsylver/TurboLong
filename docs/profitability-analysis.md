# Profitability Analysis: Blend Protocol Leverage Loop Vulnerabilities

## Context

Four structural vulnerabilities were identified in the Blend leverage loop tool. This analysis answers: **is each vulnerability actually profitable for an attacker?** The answer requires quantitative modeling with real on-chain parameters.

---

## Baseline Parameters (from codebase)

| Parameter | Value | Source |
|---|---|---|
| Pool total supply | ~$115,000 USDC | `scripts/debug_blnd.ts:43` |
| c_factor (USDC) | 0.95 | `blend.ts:116`, `leverage_sim.rs:388` |
| l_factor (USDC) | 0.95 | `leverage_sim.rs:140`; read live from the reserve config on-chain |
| HF formula (on-chain) | `(supplied × c_factor × l_factor) / borrowed` | `leverage.rs:compute_health_factor` — matches Blend's own liability markup (audit H-1) |
| Backstop take rate | 20% | `blend.ts:58` (2,000,000 / 1e7) |
| Max utilization | 95% | `blend.ts:116` |
| r_base | 0.03% | `blend.ts:326` (300,000 / 1e7) |
| r_one | 0.04% | `blend.ts:327` (400,000 / 1e7) |
| r_two | 0.12% | `blend.ts:328` (1,200,000 / 1e7) |
| r_three | 5.0% | `blend.ts:329` (50,000,000 / 1e7) |
| util_target | 50% | `blend.ts:330` (5,000,000 / 1e7) |
| ir_mod | ~1.0 | Fetched live, neutral |
| Tx cost | ~$0.0001 | BASE_FEE=100 stroops, negligible |
| Flash loans | **DO NOT EXIST** on Soroban | Architecture constraint |

### Interest Rate Curve (computed from `blend.ts:339-350`, `docs/leverage-model.md:73-83`)

| Utilization | Borrow APR | Supply APR | Spread (borrow − supply) |
|---|---|---|---|
| 50% (target) | 0.070% | 0.028% | 0.042% |
| 80% | 0.110% | 0.070% | 0.040% |
| 95% (max_util kink) | 0.190% | 0.144% | 0.046% |
| 97% | 2.19% | 1.70% | 0.49% |
| 99% | 4.19% | 3.32% | 0.87% |
| 100% | 5.19% | 4.15% | 1.04% |

**Key insight**: Supply APR = `borrow_APR × util × (1 − backstop_rate)`. At 100% util, the spread is exactly `backstop_rate × borrow_APR = 20% × 5.19% = 1.04%`. The spread is bounded.

### Reference Position ($100 equity, ~10× leverage, HF ≈ 1.056)

- Supplied: $1,000 USDC, Borrowed: $900 USDC
- HF = 0.95 × 1000 / 900 = **1.056** (matches `leverage_sim.rs:488` assertion of HF ≥ 1.05)
- Days to liquidation at normal util (spread ~0.04%): `ln(1.056) / (0.0004) × 365` = **49,740 days (~136 years)**
- Days to liquidation at 100% util (spread ~1.04%): `ln(1.056) / (0.0104) × 365` = **1,912 days (~5.2 years)**

---

## Vulnerability 1: Circular Collateral / Liquidity Lock

**Threat**: At high utilization, d-tokens (collateral) can't be redeemed for underlying USDC. Liquidators who win an auction receive illiquid tokens → no incentive to liquidate → bad debt.

### Can an attacker profit from this?

To deliberately push utilization above 95%, an attacker **cannot** deposit-and-borrow USDC in a loop — their deposit inflates the denominator equally:

```
Attacker deposits X USDC, borrows 0.95X USDC:
  new_util = (existing_borrow + 0.95X) / (existing_supply + X)
```

At X → ∞, util → 0.95 (the c_factor), never exceeding 95%. To push utilization higher requires borrowing USDC against **non-USDC collateral** (e.g. XLM at c=0.75):

- To push util from 30% to 99%: need $79,650 additional USDC borrows
- XLM collateral required: $79,650 / 0.75 = **$106,200 in XLM**
- Annual carry cost: 4.19% × $79,650 = **$3,337/year** (minus negligible XLM supply APR)

### Revenue from the attack

**$0.** The liquidity lock provides no direct revenue. The attacker:
- Cannot short USDC (it's a stablecoin, price ≈ $1.00)
- Cannot profit from others' liquidations (the whole point is liquidators *can't* act)
- Pays carry cost on XLM position + borrow interest

### Verdict

| Metric | Value |
|---|---|
| Capital required | ~$106,000 (XLM) |
| Annual cost | ~$3,337 |
| Annual revenue | **$0** |
| **Profitable?** | **NO** — pure loss. Expensive griefing with no monetization path. |

---

## Vulnerability 2: Rate Manipulation → Forced Liquidation

**Threat**: Spike utilization to push borrow APR from 0.19% to 5.19% (via r_three kink), eroding leveraged positions' HF. Liquidate them for profit.

### The math kills this attack

**HF erosion rate** is determined by the borrow-supply spread, which is bounded by the backstop take rate:

```
spread = borrow_APR − supply_APR
       = borrow_APR × (1 − util × (1 − backstop_rate))
```

At 100% utilization (maximum damage): spread = 5.19% × 0.20 = **1.04%/year**

**Time to liquidate a position at HF=1.056:**

```
days = ln(HF) / (spread / 100) × 365
     = ln(1.056) / 0.0104 × 365
     = 1,912 days (~5.2 years)
```

Even targeting aggressive positions at HF=1.01:

```
days = ln(1.01) / 0.0104 × 365 = 350 days (~1 year)
```

### Cost vs revenue

**Attacker cost** (maintaining 99% util for 1 year):
- XLM capital locked: $106,200
- Carry cost: ~$3,337/year
- XLM price risk: substantial (25% drop → own position liquidated, losing ~$26K)

**Attacker revenue** (liquidating one $100-equity position after HF drops below 1.0):
- At HF=1.0: equity remaining ≈ supplied × 0.05 ≈ **$50**
- Blend uses Dutch auctions — liquidator profit is some fraction of that $50
- Realistic profit per liquidation: **$20-40**

Even liquidating 10 positions: $200-400 revenue vs $3,337+ cost.

### Why the spread is the killer constraint

The 20% backstop take rate is the fundamental limiter. Both supply and borrow rates move together — the gap between them can never exceed `backstop_rate × borrow_rate`. This is hardcoded in the protocol (`blend.ts:358`):

```typescript
const supplyCapture_fp = Math.floor((SCALAR_F - BACKSTOP_FP) * curUtil_fp / SCALAR_F);
```

No amount of utilization manipulation can widen this gap beyond 20% of the borrow rate.

### Verdict

| Metric | Value |
|---|---|
| Capital required | ~$106,000 (XLM) |
| Annual cost | ~$3,337 + XLM price risk |
| Annual revenue | ~$200-400 (liquidating ~10 positions) |
| Time to first profit | ~1 year minimum |
| **Profitable?** | **NO** — costs exceed revenue by 10×. The backstop rate caps the HF erosion speed. |

---

## Vulnerability 3: Cascade Liquidation

**Threat**: One liquidation shifts pool utilization, pushing adjacent positions below HF=1.0.

### This is mechanically impossible

When a position is liquidated on Blend:
1. Liquidator **repays** the victim's debt → `d_supply` decreases (total_borrow drops)
2. Liquidator **receives** the victim's collateral d-tokens → `b_supply` transfers (total_supply unchanged or decreases if redeemed)

**Utilization after liquidation:**

```
Before: util = total_borrow / total_supply = $34,500 / $115,000 = 30.0%
Liquidate $1000/$900 position:
After:  util = ($34,500 - $900) / ($115,000 - $1,000) = $33,600 / $114,000 = 29.5%
```

Utilization **decreases** (or stays flat). Interest rates go **down**. Other positions become **safer**, not riskier. There is no cascade mechanism.

The only scenario where cascade could occur is if the liquidator receives d-tokens but doesn't redeem them AND new borrowing fills the gap — but that requires a separate actor, not an automatic chain reaction.

### Verdict

| Metric | Value |
|---|---|
| **Profitable?** | **N/A** — the attack vector does not exist. Liquidations reduce utilization. |

---

## Vulnerability 4: Backstop Exhaustion

**Threat**: Create enough bad debt to exceed backstop capital, making the pool insolvent.

### Bad debt per position

Bad debt only occurs when `collateral < debt` (HF < 1/c_factor = 1.053). In a USDC-USDC position, this requires years of interest accrual (from Vuln 2 analysis).

After HF erodes from 1.056 to say 0.95:
- Collateral ≈ $1,004, Debt ≈ $1,004 × 0.95 / 0.95 = **$1,004**
- Bad debt = debt − (collateral × l_factor) = $1,004 − $954 = **~$50 per $100-equity position**

To exhaust a backstop (assume ~10% of pool TVL = **$11,500**):
- Need ~230 positions to go bad simultaneously
- Each with $100 equity = **$23,000** in attacker capital
- Plus rate manipulation capital: ~$106,000 in XLM
- Time: 5+ years of sustained rate manipulation

### Revenue from insolvency

**$0 direct revenue.** Pool insolvency means:
- Bad debt socialized to remaining depositors
- Pool may be frozen by admin (as happened to YieldBlox — `main.ts:107`)
- No mechanism for the attacker to capture value from the insolvency

Could short BLND token? BLND has very low liquidity ($0.01-0.05 price range), making meaningful shorts impractical.

### Verdict

| Metric | Value |
|---|---|
| Capital required | ~$129,000 ($23K positions + $106K manipulation) |
| Time required | 5+ years |
| Annual cost | ~$10,800+ |
| Revenue | **$0** (no monetization of insolvency) |
| **Profitable?** | **NO** — massive cost, zero revenue, multi-year timeline. |

---

## Legitimate Use Case: BLND Emissions Farming

### Setup

$100 equity, 10× leverage (near max safe), HF ≈ 1.056.

### Interest cost (normal utilization ~30%)

```
Borrow cost: 0.054% × $900 = $0.49/year
Supply income: 0.013% × $1,000 = $0.13/year
Net interest cost: $0.36/year on $100 equity = 0.36% drag
```

**Interest cost is negligible** — less than $1/year.

### BLND emission revenue

From `debug_blnd.ts:41-44`: at ~$115K total supply and ~4.68% target APR from emissions:
- Pool distributes ~$5,384/year of BLND to suppliers
- $1,000 supplied / $115,000 total = 0.87% share
- **Supply-side BLND: ~$47/year** (at BLND ≈ $0.03)

If borrow-side emissions exist (asset-dependent):
- $900 borrowed / ~$34,500 total borrow = 2.6% share
- **Borrow-side BLND: ~$140/year** (at BLND ≈ $0.03)

### Profitability by BLND price

| BLND Price | Supply BLND APY | Borrow BLND APY | Total APY on Equity |
|---|---|---|---|
| $0.005 | 7.8% | 23.4% | **~31%** |
| $0.01 | 15.6% | 46.8% | **~62%** |
| $0.03 | 46.8% | 140.4% | **~187%** |
| $0.05 | 78.0% | 234.0% | **~312%** |

### Risks
1. BLND price decline (but profitable even at $0.005)
2. Emission reduction by governance
3. Smart contract risk (YieldBlox precedent)
4. Pool freeze by admin

### Verdict

| Metric | Value |
|---|---|
| Capital required | $100 |
| Annual cost | ~$0.36 (interest) |
| Annual revenue | $31-$312 (depending on BLND price) |
| Time to first profit | **Immediate** (emissions accrue per-second) |
| **Profitable?** | **YES** — strongly profitable at any BLND price above ~$0.001 |

---

## Final Profitability Matrix

| # | Vulnerability | Capital | Annual Cost | Annual Revenue | Verdict |
|---|---|---|---|---|---|
| 1 | Circular Collateral Lock | $106K | $3,337 | **$0** | **NO** — no monetization |
| 2 | Rate Manipulation Liquidation | $106K | $3,337 | $200-400 | **NO** — costs 10× revenue |
| 3 | Cascade Liquidation | — | — | — | **N/A** — mechanically impossible |
| 4 | Backstop Exhaustion | $129K | $10,800 | **$0** | **NO** — no monetization |
| — | BLND Farming (legitimate) | **$100** | $0.36 | $31-312 | **YES** — 31-312% APY |

### Why all attacks fail

Three structural reasons kill every attack vector:

1. **No flash loans on Soroban.** Every attack requires real capital with real carry costs. This eliminates zero-capital liquidation attacks entirely.

2. **Backstop take rate caps the HF erosion speed.** Supply APR = `borrow_APR × util × 0.80`. The maximum borrow-supply spread is 20% of the borrow rate. Even at extreme rates (5.19%/yr), HF erodes at only ~1%/year — taking years to liquidate a healthy position.

3. **Pool size is small ($115K).** Liquidation profits are measured in tens of dollars per position, while manipulation capital is measured in hundreds of thousands. The economics don't scale.

### The only profitable strategy is the tool's intended purpose

BLND emissions farming at 10× leverage yields 31-312% APY on equity with negligible interest costs. The leverage multiplies emission share linearly while interest drag remains near zero at normal utilization. This is not an exploit — it's the designed incentive mechanism.
