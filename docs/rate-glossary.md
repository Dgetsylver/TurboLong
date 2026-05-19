# Rate Glossary

Turbolong uses explicit APR/APY labels so users can tell which values compound and which are linear estimates.

## APR

APR is a simple annualized rate. It does not assume compounding.

Turbolong shows these as APR:

- BLND supply emissions
- BLND borrow emissions
- interest spread used for liquidation runway estimates
- tooltip-only "actual net APR" values behind APY displays

BLND emissions are APR because rewards accrue linearly and Blend does not automatically compound them.

## APY

APY is the displayed annual percentage yield after applying the app's compounding approximation:

```text
displayed APY = (e^(APR / 100) - 1) * 100
```

Turbolong shows these as APY:

- supply interest APY
- net supply APY
- borrow interest cost APY
- net borrow cost APY
- estimated net APY on equity
- portfolio, position, overview, and vault headline rate values

When BLND emissions are combined with interest APY, the emissions side remains a linear APR approximation. Tooltips keep the underlying APR visible where this matters.
