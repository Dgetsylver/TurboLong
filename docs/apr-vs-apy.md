# APR vs APY — Rate Convention Glossary

This document defines how Turbolong labels every user-facing rate and explains
the underlying math.

---

## Definitions

### APR — Annual Percentage Rate (simple / linear)

A rate that does **not** assume reinvestment of earnings.  
`earnings = principal × APR × time`

Used for: BLND token emissions, because the protocol distributes a fixed number
of tokens per second and does not auto-compound them.

### APY — Annual Percentage Yield (continuously compounded)

A rate that **does** assume continuous reinvestment.  
`APY = e^APR − 1`

Used for: Blend interest rates, because the protocol accrues interest
continuously via the `b_rate` / `d_rate` exchange rates.

---

## Conversion used in the codebase

```ts
// frontend/src/main.ts
const aprToApy = (apr: number) => (Math.exp(apr / 100) - 1) * 100;
```

The Blend rate model returns an **APR** (the `curIr` value in fixed-point).
`aprToApy` converts it to the APY that users see.

---

## Rate labels by display location

| Location | Label | Convention | Notes |
|---|---|---|---|
| Pool stats — Interest (supply) | APY | APY | `aprToApy(interestSupplyApr)` |
| Pool stats — Interest (borrow) | APY | APY | `aprToApy(interestBorrowApr)` |
| Pool stats — BLND emissions (supply) | APR | APR | Linear; no compounding |
| Pool stats — BLND emissions (borrow) | APR | APR | Linear; no compounding |
| Pool stats — Net supply | APY* | Mixed | APY interest + APR BLND |
| Pool stats — Net borrow cost | APY* | Mixed | APY interest − APR BLND |
| Position — Net APY | APY* | Mixed | Same mixed convention |
| Hero — Net APY | APY* | Mixed | Same mixed convention |
| Preview — Est. net APY | APY* | Mixed | Same mixed convention |
| Vault — Net APY | APY* | Mixed | `aprToApy(stats.netApy)` |
| Vault — Supply APY | APY | APY | `aprToApy(stats.supplyApr)` |
| Vault — Borrow APY | APY | APY | `aprToApy(stats.borrowApr)` |
| Overview table — Net APY | APY* | Mixed | Same mixed convention |

**APY\*** means the row combines APY-compounded interest with APR-linear BLND
emissions. This is a slight overestimate of true compounded yield because the
BLND component is not reinvested. The footnote on the pool stats card explains
this to users.

---

## Why "mixed" net rows are still useful

True compounded yield would require knowing the exact reinvestment schedule for
BLND emissions, which depends on user behaviour. The APY* approximation:

- Overestimates by at most a few basis points at typical BLND emission rates.
- Is consistent with how most DeFi frontends display blended rates.
- Is clearly disclosed via the `*` badge and the footnote.

---

## Tooltips

Every rate display carries a tooltip (the `?` icon) that explains the
convention inline. The tooltip text for net rows reads:

> "Approximate APY — Blend interest does not auto-compound. Actual net APR: X%"

The "Actual net APR" figure in the tooltip is the raw APR before the
`aprToApy` conversion, giving power users the underlying number.
