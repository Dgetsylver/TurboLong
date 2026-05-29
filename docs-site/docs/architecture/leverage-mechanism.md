---
sidebar_position: 3
---

# Leverage Mechanism & Math

This page explains the mathematics behind TurboLong's leverage loops and the Blend Protocol's interest rate model.

## Leverage Loop Strategy

### The Concept

A leverage loop is a series of supply and borrow operations on the same asset, executed atomically:

```
iteration 0: supply X_0 as collateral
iteration 1: borrow X_0 × c, re-supply as collateral
iteration 2: borrow X_1 × c, re-supply as collateral
...
iteration n: borrow X_{n-1} × c, (final borrow, don't re-supply)
```

Where `c` is the collateral factor (e.g., 0.95 for USDC).

### Maximum Leverage

As iterations increase, the total supplied and borrowed approach a limit:

$$\text{max\_leverage} = \frac{1}{1-c}$$

For c = 0.95:
$$\text{max\_leverage} = \frac{1}{1-0.95} = \frac{1}{0.05} = 20×$$

But in practice, we don't loop forever. We stop at ~n=13 to maintain HF > 1.05:

| Leverage | c_factor | Formula                           |
| -------- | -------- | --------------------------------- |
| 1×       | any      | 1.0                               |
| 2×       | 0.95     | `1/(1-0.475)` ≈ 1.91              |
| 5×       | 0.95     | `log(5) / log(1/0.05)` ≈ 13 loops |
| 10×      | 0.95     | `log(10) / log(20)` ≈ 14 loops    |
| 20×      | 0.95     | `1/(1-0.95)` = theoretical max    |

### Health Factor Calculation

After n loops with initial capital X and c_factor c:

```
Total supplied = X × (1 - c^(n+1)) / (1 - c)
Total borrowed = X × c × (1 - c^n) / (1 - c)

HF = (supplied × c) / borrowed
   = (X × (1 - c^(n+1)) / (1 - c) × c) / (X × c × (1 - c^n) / (1 - c))
   = (1 - c^(n+1)) / (1 - c^n)
```

### Example: $100 USDC at 10× leverage

```
c = 0.95 (USDC collateral factor)
target_leverage = 10×

Solve: (1 - 0.95^(n+1)) / (1 - 0.95^n) = 10
      1 - 0.95^(n+1) = 10 × (1 - 0.95^n)
      1 - 0.95^(n+1) = 10 - 10 × 0.95^n
      1 - 0.95 × 0.95^n = 10 - 10 × 0.95^n
      9 × 0.95^n = 9
      0.95^n = 1.0
      n ≈ 0 (this doesn't converge to 10 exactly)

(Actually, we solve iteratively in the code)

Result (13 loops):
  Supplied ≈ $1,000.00
  Borrowed ≈ $950.00 (approximately)
  Leverage ≈ 10.0×
  HF = (1000 × 0.95) / 950 ≈ 1.0053
```

## Interest Rate Model (3-Kink)

### Piecewise Definition

Let util = total_borrow / total_supply.

```
If util ≤ u_target:
    r_borrow = r_base + r_one × (util / u_target)

Else if util ≤ max_util:
    r_borrow = r_base + r_one + r_two × ((util - u_target) / (max_util - u_target))

Else (util > max_util):
    r_borrow = r_base + r_one + r_two + r_three × ((util - max_util) / (1 - max_util))

r_supply = r_borrow × util × (1 - backstop_take_rate)
```

### Etherfuse USDC Parameters

| Parameter            | Value                   |
| -------------------- | ----------------------- |
| `r_base`             | 0.03%                   |
| `r_one`              | 0.04%                   |
| `r_two`              | 0.12%                   |
| `r_three`            | 5.0% (⚠️ penalty zone!) |
| `u_target`           | 50%                     |
| `max_util`           | 95%                     |
| `backstop_take_rate` | 20%                     |

### Calculating Rates for Different Utilizations

**At 50% utilization (target):**

```
r_borrow = 0.03% + 0.04% × (0.50 / 0.50) = 0.07% APR
r_supply = 0.07% × 0.50 × 0.80 = 0.028% APR
Spread = 0.042% APR (goes to backstop)
```

**At 80% utilization (high but safe):**

```
r_borrow = 0.03% + 0.04% + 0.12% × ((0.80 - 0.50) / (0.95 - 0.50))
         = 0.07% + 0.12% × (0.30 / 0.45)
         = 0.07% + 0.08%
         = 0.15% APR (approximately)
r_supply = 0.15% × 0.80 × 0.80 = 0.096% APR
Spread = 0.054% APR
```

**At 97% utilization (penalty zone):**

```
r_borrow = 0.03% + 0.04% + 0.12% + 5.0% × ((0.97 - 0.95) / (1 - 0.95))
         = 0.19% + 5.0% × (0.02 / 0.05)
         = 0.19% + 2.0%
         = 2.19% APR
r_supply = 2.19% × 0.97 × 0.80 = 1.70% APR
Spread = 0.49% APR (to backstop)
```

**At 100% utilization (extreme emergency):**

```
r_borrow = 0.03% + 0.04% + 0.12% + 5.0% × ((1.0 - 0.95) / (1 - 0.95))
         = 0.19% + 5.0%
         = 5.19% APR
r_supply = 5.19% × 1.0 × 0.80 = 4.15% APR
Spread = 1.04% APR
```

## Health Factor Erosion Over Time

With interest accruing, how fast does HF decline?

### Rate of HF Erosion

The HF erosion speed depends on the borrow-supply spread:

$$\text{erosion\_rate} = \text{spread\_rate} / \text{leverage}$$

### Example: $100 USDC at 10× leverage

```
Supplied: $1,000
Borrowed: $900
Leverage: 10×

At 50% utilization:
  Supply earnings:  $1,000 × 0.028% = $0.28/year
  Borrow costs:     $900 × 0.07% = $0.63/year
  Net drain:        $0.35/year
  Annual HF decline: $0.35 / $1,000 / 10 = 0.0035% per year
  (negligible — HF stays ~1.005 for ~5 years at this util)

At 95% utilization:
  Supply earnings:  $1,000 × 0.144% = $1.44/year
  Borrow costs:     $900 × 0.19% = $1.71/year
  Net drain:        $0.27/year
  Annual HF decline: similar to above (still <0.03% per year)

At 97% utilization (penalty):
  Supply earnings:  $1,000 × 1.70% = $17.00/year
  Borrow costs:     $900 × 2.19% = $19.71/year
  Net drain:        $2.71/year
  Annual HF decline: $2.71 / $1,000 / 10 = 0.027% per year
  Time to liquidation (HF 1.005 → 1.0): ~183 years
```

**Key insight:** Even at extreme utilization, interest-driven HF erosion is very slow. Liquidation risk comes from:

1. **You manually adjusting the position** (adding more debt)
2. **Oracle price movements** (collateral value drops — not applicable for same-asset loops)
3. **Interest rate spikes** beyond the models above (governance change)

## Compounding Effect of Leverage on Yield

### Setup

- Initial capital: $100
- Leverage: 10×
- Total supplied: $1,000
- Total borrowed: $900

### BLND Emissions Revenue

Blend distributes BLND tokens proportionally to deposit shares:

```
My share of supply pool = $1,000 / $115,000 = 0.87%
Annual BLND emissions (supply side) = $115K × 4.68% / BLND_price
  = $5,384 / BLND_price
My share = 0.87% × $5,384 / BLND_price = $47 / BLND_price

At BLND = $0.03: $47 / 0.03 = $1,566 APY on $100 equity = 1,566% 🤯
At BLND = $0.10: $47 / 0.10 = $470 APY on $100 equity = 470%
At BLND = $0.01: $47 / 0.01 = $4,700 APY on $100 equity = 4,700% 🤯
```

**This is why TurboLong works:** The emission distributions are multiplied by your leverage. But:

```
⚠️ RISK: BLND token value is volatile!
         Prices range $0.005–$0.10 historically
         If BLND crashes to $0.001, your returns vanish
```

## Safe Leverage Ranges

### Conservative (HF > 2.0)

```
For $100 equity at different leverage levels:
  Leverage 2×:  HF = (2×c - 1) / (2-1) = (1.90 - 1) / 1 = 1.90 → Safe
  Leverage 3×:  HF = (3×c - 1) / (3-1) = (2.85 - 1) / 2 = 0.925 → Liquidatable!
```

Max safe leverage for HF > 2.0 at c=0.95: **~2.3×**

### Moderate (HF 1.5–2.0)

Max leverage: **~4–5×**

### Aggressive (HF 1.2–1.5)

Max leverage: **~8–10×**

### Unsafe (HF < 1.05)

**Never enter this zone on purpose.** Liquidation is imminent.

## Formulas Reference

### From Initial Capital to Final Position

Given:

- Initial capital: $X
- Collateral factor: $c$
- Target leverage: $L$

Find number of loops $n$:

```
L = (1 - c^(n+1)) / (1 - c^n)
```

Solve numerically (binary search or Newton's method in code).

### Total Supplied and Borrowed

```
S_total = X × (1 - c^(n+1)) / (1 - c)
B_total = S_total - X = X × c × (1 - c^n) / (1 - c)
```

### Health Factor

```
HF = (S_total × c) / B_total
```

### Interest Costs (Annual)

```
Interest_cost = B_total × r_borrow_rate × 1_year
Interest_gain = S_total × r_supply_rate × 1_year
Net_interest  = Interest_gain - Interest_cost
```

### APY on Equity

```
APY_interest = Net_interest / X / 1_year

APY_total = APY_interest + (BLND_emissions_share / X / BLND_price)
```

## See Also

- [Blend Protocol Pools](blend-protocol.md)
- [User Guide — Risk Management](../guides/user-guide.md)
- [Profitability Analysis](../analysis/profitability.md)
