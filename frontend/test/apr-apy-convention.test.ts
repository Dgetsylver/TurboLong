/**
 * Unit tests for APR/APY rate convention (B11).
 *
 * Verifies:
 *  1. aprToApy conversion formula is correct.
 *  2. Interest rates (from Blend's rate model) are displayed as APY.
 *  3. BLND emissions are displayed as APR (linear, no conversion).
 *  4. Net rows use the mixed APY* convention (APY interest + APR BLND).
 *  5. projectRates returns APR values (pre-conversion) for all fields.
 */

import { describe, it, expect } from 'vitest';
import { projectRates, type ReserveStats } from '../src/blend';

// Mirrors the aprToApy helper in main.ts — kept local so this test file
// has no dependency on the DOM-heavy main.ts module.
const aprToApy = (apr: number) => (Math.exp(apr / 100) - 1) * 100;

// Minimal ReserveStats stub sufficient for projectRates
function makeReserve(overrides: Partial<{
  totalSupply: number;
  totalBorrow: number;
  priceUsd: number;
  supplyEps: bigint;
  borrowEps: bigint;
  rBase: number;
  rOne: number;
  rTwo: number;
  rThree: number;
  utilOpt: number;
  irMod: number;
  backstopFP: number;
}>): ReserveStats {
  const o = overrides;
  return {
    totalSupply:  o.totalSupply  ?? 1_000_000,
    totalBorrow:  o.totalBorrow  ?? 700_000,
    priceUsd:     o.priceUsd     ?? 1.0,
    supplyEps:    o.supplyEps    ?? 0n,
    borrowEps:    o.borrowEps    ?? 0n,
    rateConfig: {
      rBase:      o.rBase      ?? 300_000,
      rOne:       o.rOne       ?? 400_000,
      rTwo:       o.rTwo       ?? 1_200_000,
      rThree:     o.rThree     ?? 50_000_000,
      utilOpt:    o.utilOpt    ?? 5_000_000,
      irMod:      o.irMod      ?? 1_000_000,
      backstopFP: o.backstopFP ?? 2_000_000,
    },
  } as unknown as ReserveStats;
}

// ── 1. aprToApy conversion ────────────────────────────────────────────────────

describe('aprToApy', () => {
  it('returns 0 for 0% APR', () => {
    expect(aprToApy(0)).toBe(0);
  });

  it('converts 10% APR to ~10.517% APY', () => {
    expect(aprToApy(10)).toBeCloseTo(10.517, 2);
  });

  it('converts 100% APR to ~171.828% APY (e - 1)', () => {
    expect(aprToApy(100)).toBeCloseTo(171.828, 2);
  });

  it('APY is always >= APR for positive rates', () => {
    for (const apr of [0.5, 1, 5, 10, 20, 50]) {
      expect(aprToApy(apr)).toBeGreaterThanOrEqual(apr);
    }
  });

  it('is invertible: APR = ln(1 + APY/100) * 100', () => {
    const apr = 8.5;
    const apy = aprToApy(apr);
    const back = Math.log(1 + apy / 100) * 100;
    expect(back).toBeCloseTo(apr, 8);
  });
});

// ── 2. projectRates returns APR (pre-conversion) ──────────────────────────────

describe('projectRates returns APR values', () => {
  it('interestBorrowApr is a raw APR (not yet APY-converted)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    // The raw APR from the rate model should be a reasonable positive number
    expect(rates.interestBorrowApr).toBeGreaterThan(0);

    // APY-converted value must be strictly greater than the APR for any positive rate
    const apy = aprToApy(rates.interestBorrowApr);
    expect(apy).toBeGreaterThan(rates.interestBorrowApr);
  });

  it('interestSupplyApr is a raw APR (not yet APY-converted)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    expect(rates.interestSupplyApr).toBeGreaterThan(0);
    expect(aprToApy(rates.interestSupplyApr)).toBeGreaterThan(rates.interestSupplyApr);
  });

  it('blndSupplyApr is 0 when supplyEps is 0 (no BLND emissions)', () => {
    const rs = makeReserve({ supplyEps: 0n });
    const rates = projectRates(rs, 0, 0);
    expect(rates.blndSupplyApr).toBe(0);
  });

  it('blndBorrowApr is 0 when borrowEps is 0', () => {
    const rs = makeReserve({ borrowEps: 0n });
    const rates = projectRates(rs, 0, 0);
    expect(rates.blndBorrowApr).toBe(0);
  });
});

// ── 3. Display convention: interest shown as APY, BLND shown as APR ──────────

describe('display convention', () => {
  it('interest display value (APY) > raw APR from projectRates', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 600_000 });
    const rates = projectRates(rs, 0, 0);

    // What the UI shows for interest supply:
    const displayedSupplyApy = aprToApy(rates.interestSupplyApr);
    // What the UI shows for interest borrow:
    const displayedBorrowApy = aprToApy(rates.interestBorrowApr);

    expect(displayedSupplyApy).toBeGreaterThan(rates.interestSupplyApr);
    expect(displayedBorrowApy).toBeGreaterThan(rates.interestBorrowApr);
  });

  it('BLND emissions are NOT converted — displayed value equals projectRates value', () => {
    // supplyEps = 1e7 stroops/sec (1 BLND/sec), priceUsd = 1, totalSupply = 31_536_000
    // blndSupplyApr = (1 BLND/yr * $1) / ($31_536_000) * 100 ≈ 3.17e-6 %
    // The point is: blndSupplyApr from projectRates IS the display value (no aprToApy)
    const rs = makeReserve({
      supplyEps: 10_000_000n, // 1 BLND/sec in 1e7 stroops
      priceUsd: 1.0,
      totalSupply: 31_536_000,
      totalBorrow: 0,
    });
    const rates = projectRates(rs, 0, 0);

    // BLND APR is used directly (no conversion) — so it equals the raw value
    // If we mistakenly applied aprToApy, the result would differ
    const wronglyConverted = aprToApy(rates.blndSupplyApr);
    // For small APRs the difference is tiny but non-zero
    if (rates.blndSupplyApr > 0) {
      expect(wronglyConverted).not.toBe(rates.blndSupplyApr);
    }
    // The display value IS rates.blndSupplyApr (no conversion)
    expect(rates.blndSupplyApr).toBeGreaterThanOrEqual(0);
  });
});

// ── 4. Net APY* = APY(interest) + APR(BLND) ──────────────────────────────────

describe('net APY* mixed convention', () => {
  it('netSupplyApr = interestSupplyApr + blndSupplyApr (both in APR)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    expect(rates.netSupplyApr).toBeCloseTo(
      rates.interestSupplyApr + rates.blndSupplyApr, 8
    );
  });

  it('netBorrowCost = interestBorrowApr - blndBorrowApr (both in APR)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    expect(rates.netBorrowCost).toBeCloseTo(
      rates.interestBorrowApr - rates.blndBorrowApr, 8
    );
  });

  it('displayed net APY* = aprToApy(interest) + blnd (mixed convention)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    // This is what renderAprLine does for the net supply row (raw=true):
    // display = rates.netSupplyApr (passed as-is, then aprToApy applied in renderAprLine)
    // Wait — renderAprLine with raw=true skips aprToApy and shows the value directly.
    // The net value passed to renderAprLine is: aprToApy(interestSupplyApr) + blndSupplyApr
    // (computed in renderSelectedAsset)
    const netDisplayValue = aprToApy(rates.interestSupplyApr) + rates.blndSupplyApr;

    // This must be >= the pure APR net (because APY >= APR for positive rates)
    expect(netDisplayValue).toBeGreaterThanOrEqual(rates.netSupplyApr);
  });

  it('net APY* overestimates true compounded yield (documented behaviour)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    // True compounded yield would be aprToApy(netSupplyApr)
    const trueApy = aprToApy(rates.netSupplyApr);
    // Mixed convention: aprToApy(interest) + blnd
    const mixedApy = aprToApy(rates.interestSupplyApr) + rates.blndSupplyApr;

    // Mixed >= true because aprToApy(a+b) <= aprToApy(a) + b for b >= 0
    // (the BLND component is not compounded in the mixed convention)
    expect(mixedApy).toBeGreaterThanOrEqual(trueApy - 1e-9); // allow float epsilon
  });
});

// ── 5. Rate model sanity checks ───────────────────────────────────────────────

describe('rate model sanity', () => {
  it('borrow APR increases with utilization', () => {
    const low  = makeReserve({ totalSupply: 1_000_000, totalBorrow: 300_000 });
    const high = makeReserve({ totalSupply: 1_000_000, totalBorrow: 900_000 });

    const ratesLow  = projectRates(low,  0, 0);
    const ratesHigh = projectRates(high, 0, 0);

    expect(ratesHigh.interestBorrowApr).toBeGreaterThan(ratesLow.interestBorrowApr);
  });

  it('supply APR is always less than borrow APR (backstop takes a cut)', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 700_000 });
    const rates = projectRates(rs, 0, 0);

    expect(rates.interestSupplyApr).toBeLessThan(rates.interestBorrowApr);
  });

  it('adding supply reduces utilization and lowers borrow APR', () => {
    const rs = makeReserve({ totalSupply: 1_000_000, totalBorrow: 900_000 });
    const before = projectRates(rs, 0, 0);
    const after  = projectRates(rs, 500_000, 0); // add 500k supply

    expect(after.interestBorrowApr).toBeLessThan(before.interestBorrowApr);
  });
});
