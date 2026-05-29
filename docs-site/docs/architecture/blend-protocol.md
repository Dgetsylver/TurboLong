---
sidebar_position: 2
---

# Blend Protocol & Pools

This page documents the Blend Protocol integration and available pools on TurboLong.

## What is Blend?

Blend is a **lending protocol on Stellar** that enables users to:

- **Supply** assets as collateral and earn interest
- **Borrow** other assets by posting collateral
- **Participate in governance** via BLND token holders

Learn more: [blend.capital](https://blend.capital)

## Pools on TurboLong

TurboLong integrates with three main Blend pools:

### 1. Etherfuse (Recommended for New Users)

| Property            | Value                                       |
| ------------------- | ------------------------------------------- |
| **Operator**        | Blend Foundation                            |
| **Total Liquidity** | ~$600K                                      |
| **Assets**          | USDC, CETES, USTRY, TESOURO, XLM            |
| **Best For**        | Low-cap assets, high APY, active management |
| **Status**          | Operational                                 |

**Supported Assets:**

| Asset   | c_factor | Max Leverage | 30-day APY |
| ------- | -------- | ------------ | ---------- |
| USDC    | 0.95     | 20.0×        | ~5–10%     |
| CETES   | 0.80     | 5.0×         | ~15–25%    |
| USTRY   | 0.80     | 5.0×         | ~12–18%    |
| TESOURO | 0.80     | 5.0×         | ~10–16%    |
| XLM     | 0.75     | 4.0×         | ~3–8%      |

**Interest Rate Curve:**

```
r_base = 0.03% (minimum)
r_one = 0.04% (below target)
r_two = 0.12% (above target)
r_three = 5.0% (penalty zone >95% utilization)
Target utilization = 50%
Max utilization = 95%
```

### 2. Fixed (Predictable Rates)

| Property            | Value                                      |
| ------------------- | ------------------------------------------ |
| **Operator**        | YieldBlox (Stellar DAO)                    |
| **Total Liquidity** | ~$400K                                     |
| **Assets**          | USDC, XLM                                  |
| **Best For**        | Stable interest rates, long-term positions |
| **Status**          | Operational (post-YieldBlox recovery)      |

**Note:** The YieldBlox pool was exploited in February 2026 for ~$10.8M via oracle manipulation. It has since recovered with enhanced circuit breakers.

### 3. YieldBlox (Community Managed)

| Property            | Value                                |
| ------------------- | ------------------------------------ |
| **Operator**        | YieldBlox DAO governance             |
| **Total Liquidity** | ~$150K                               |
| **Assets**          | USDC, CETES, XLM                     |
| **Best For**        | Community participation, DAO rewards |
| **Status**          | Limited exposure (post-exploit)      |

## Interest Rate Model

Blend uses a **three-kink piecewise linear interest rate model**:

### Rate Calculation

For a reserve with utilization U and configured parameters:

```
If U ≤ util_target:
    r_borrow = r_base + r_one × (U / util_target)

Else If U ≤ max_util:
    r_borrow = r_base + r_one + r_two × ((U - util_target) / (max_util - util_target))

Else:
    r_borrow = r_base + r_one + r_two + r_three × ((U - max_util) / (1 - max_util))

r_supply = r_borrow × U × (1 - backstop_take_rate)
```

### Etherfuse USDC Example

With 70% utilization:

```
U = 0.70
r_borrow = 0.03% + 0.04% × (0.70 / 0.50)
         = 0.03% + 0.04% × 1.4
         = 0.03% + 0.056%
         = 0.086% APR

r_supply = 0.086% × 0.70 × (1 - 0.20)
         = 0.086% × 0.70 × 0.80
         = 0.048% APR

Net spread = 0.086% - 0.048% = 0.038% (to backstop)
```

## Collateral Factors (c_factor)

The **collateral factor** determines the maximum borrow amount for each asset:

```
max_borrow = supplied_amount × c_factor
```

For example, supplying $1,000 USDC with c_factor=0.95 allows borrowing up to $950 USDC.

**Current collateral factors:**

| Asset   | c_factor | l_factor | Max LTV |
| ------- | -------- | -------- | ------- |
| USDC    | 0.95     | 0.95     | 95%     |
| CETES   | 0.80     | 0.80     | 80%     |
| USTRY   | 0.80     | 0.80     | 80%     |
| TESOURO | 0.80     | 0.80     | 80%     |
| XLM     | 0.75     | 0.75     | 75%     |

Lower c_factors = higher collateral factor = conservative (lower max leverage).

## Liquidation Thresholds

When does liquidation occur?

```
liquidation_threshold = 1 / c_factor

For USDC (c=0.95): threshold = 1.053 (HF < 1.05 triggers liquidation)
For CETES (c=0.80): threshold = 1.25 (HF < 1.25 triggers liquidation)
```

**Note:** Different pools may have different liquidation mechanics. Blend uses "Dutch auctions" where liquidators progressively receive collateral discounts over time.

## BLND Token & Emissions

Blend distributes **BLND tokens** as incentives to suppliers and borrowers.

### Emission Rates

| Asset | Pool      | Supply APY | Borrow APY |
| ----- | --------- | ---------- | ---------- |
| USDC  | Etherfuse | ~4.68%     | ~2.34%     |
| CETES | Etherfuse | ~2.5%      | ~1.25%     |
| XLM   | Fixed     | ~1.2%      | ~0.6%      |

**Note:** Emission rates are governance-controlled and can change. These are approximate as of March 2026.

### BLND Utility

- **Governance:** Vote on protocol parameters
- **Utility (future):** Potential fee discounts or other benefits
- **Trading:** Available on SoroSwap

## Pool Governance

Each pool is governed by its operators via voting:

- **Etherfuse** → Blend Foundation
- **Fixed** → YieldBlox DAO (BLND holders)
- **YieldBlox** → Community governance

Proposals can change:

- Collateral factors
- Interest rate parameters
- Liquidation mechanics
- Fee structures

Monitor governance channels if you have large positions.

## Risk Parameters by Pool

### Etherfuse

| Risk Factor       | Value                       | Status                  |
| ----------------- | --------------------------- | ----------------------- |
| Total TVL         | ~$600K                      | Moderate size           |
| Largest Reserve   | USDC ($115K)                | Small, concentrated     |
| Utilization (avg) | ~40%                        | Safe                    |
| Max utilization   | 95%                         | Standard                |
| Oracle            | Reflector + circuit breaker | Safe (5% deviation cap) |

### Fixed / YieldBlox

| Risk Factor         | Value                    | Status              |
| ------------------- | ------------------------ | ------------------- |
| Total TVL           | ~$400K–550K              | Smaller             |
| Post-Exploit Status | Recovering               | Enhanced monitoring |
| Utilization (avg)   | ~35%                     | Safe                |
| Oracle              | (Post-fix audit pending) | Improved            |

## Switching Between Pools

Prefer a different pool for better rates? You can:

1. **Close position on Pool A** → repay debt, withdraw collateral
2. **Open new position on Pool B** → supply collateral, borrow same amount

Cost: ~$0.0002–0.0005 in fees (same leverage, new pool).

## Further Reading

- [Interest Rate Mechanics](leverage-mechanism.md) — Deep dive on the math
- [Pool Contracts](contracts.md) — Smart contract architecture
- [Security Reports](../security/vulnerability-reports.md) — Known risks and mitigations
