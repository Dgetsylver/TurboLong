/**
 * Snapshot tests for projectRates.
 *
 * Each case pins the exact output of projectRates at a specific utilization
 * point so any accidental regression in the rate model is caught immediately.
 *
 * Update snapshots:  npx vitest run --reporter=verbose frontend/test/rates.snapshot.test.ts
 * Regenerate file:   node -e "require('./scripts/gen_snapshots')" (or just re-run with UPDATE=1)
 *
 * One-line update:   UPDATE_SNAPSHOTS=1 npm test
 */

import { describe, it, expect } from "vitest";
import { projectRates } from "../src/blend";

// ── Minimal ReserveStats stub (only fields projectRates reads) ────────────────

function makeRs(
  totalSupply: number,
  totalBorrow: number,
  rateConfig: {
    rBase: number; rOne: number; rTwo: number; rThree: number;
    utilOpt: number; irMod: number; backstopFP: number;
  },
  priceUsd = 1.0,
  supplyEps = 0n,
  borrowEps = 0n,
) {
  return {
    totalSupply, totalBorrow, rateConfig, priceUsd, supplyEps, borrowEps,
    // unused by projectRates — present to satisfy the type
    asset: {} as any, cFactor: 0, lFactor: 1, available: 0,
    bRate: 0n, dRate: 0n, bSupply: 0n, dSupply: 0n,
    interestBorrowApr: 0, interestSupplyApr: 0,
    blndSupplyApr: 0, blndBorrowApr: 0, netSupplyApr: 0, netBorrowCost: 0,
    supplyEmission: null, borrowEmission: null,
  } as any;
}

// Typical Blend USDC-like rate config (all values in 1e7 fixed-point)
const USDC_RATES = {
  rBase: 0, rOne: 500_000, rTwo: 4_000_000, rThree: 15_000_000,
  utilOpt: 8_000_000, irMod: 10_000_000, backstopFP: 2_000_000,
};

// Higher-risk asset config (CETES-like)
const CETES_RATES = {
  rBase: 200_000, rOne: 800_000, rTwo: 5_000_000, rThree: 20_000_000,
  utilOpt: 7_500_000, irMod: 10_000_000, backstopFP: 2_000_000,
};

// ── Snapshot helper ───────────────────────────────────────────────────────────

function snap(
  label: string,
  totalSupply: number,
  totalBorrow: number,
  addSupply: number,
  addBorrow: number,
  rates = USDC_RATES,
  priceUsd = 1.0,
  supplyEps = 0n,
  borrowEps = 0n,
) {
  it(label, () => {
    const rs = makeRs(totalSupply, totalBorrow, rates, priceUsd, supplyEps, borrowEps);
    const result = projectRates(rs, addSupply, addBorrow);
    expect(result).toMatchSnapshot();
  });
}

// ── Cases ─────────────────────────────────────────────────────────────────────

describe("projectRates snapshots", () => {
  // ── Zero utilization ──────────────────────────────────────────────────────
  snap("util=0% no position", 1_000_000, 0, 0, 0);

  // ── Just below utilOpt (kink 1) ───────────────────────────────────────────
  snap("util=79.9% (just below kink1)", 1_000_000, 799_000, 0, 0);

  // ── Exactly at utilOpt ────────────────────────────────────────────────────
  snap("util=80% (at kink1)", 1_000_000, 800_000, 0, 0);

  // ── Just above utilOpt ────────────────────────────────────────────────────
  snap("util=80.1% (just above kink1)", 1_000_000, 801_000, 0, 0);

  // ── Mid-range between kink1 and 95% ──────────────────────────────────────
  snap("util=87.5% (mid kink1-kink2)", 1_000_000, 875_000, 0, 0);

  // ── Just below 95% (kink 2) ───────────────────────────────────────────────
  snap("util=94.9% (just below kink2)", 1_000_000, 949_000, 0, 0);

  // ── Exactly at 95% ────────────────────────────────────────────────────────
  snap("util=95% (at kink2)", 1_000_000, 950_000, 0, 0);

  // ── Just above 95% ────────────────────────────────────────────────────────
  snap("util=95.1% (just above kink2)", 1_000_000, 951_000, 0, 0);

  // ── Near-full utilization ─────────────────────────────────────────────────
  snap("util=99% (near full)", 1_000_000, 990_000, 0, 0);

  // ── Position impact: deposit pushes util across kink1 ────────────────────
  snap("deposit crosses kink1 (75%→82%)", 1_000_000, 750_000, 100_000, 70_000);

  // ── Position impact: deposit pushes util across kink2 ────────────────────
  snap("deposit crosses kink2 (93%→97%)", 1_000_000, 930_000, 50_000, 40_000);

  // ── CETES rate config, mid utilization ───────────────────────────────────
  snap("CETES util=60%", 500_000, 300_000, 0, 0, CETES_RATES, 0.95);

  // ── CETES just below kink1 (75%) ─────────────────────────────────────────
  snap("CETES util=74.9% (just below kink1)", 500_000, 374_500, 0, 0, CETES_RATES, 0.95);

  // ── CETES just above kink1 ────────────────────────────────────────────────
  snap("CETES util=75.1% (just above kink1)", 500_000, 375_500, 0, 0, CETES_RATES, 0.95);

  // ── BLND emissions active ─────────────────────────────────────────────────
  snap(
    "util=50% with BLND emissions",
    1_000_000, 500_000, 0, 0,
    USDC_RATES, 1.0,
    /* supplyEps= */ 1_000_000n,   // 0.1 BLND/s (in 1e7)
    /* borrowEps= */ 500_000n,
  );

  // ── irMod != 1.0 (rate modifier active) ──────────────────────────────────
  snap("util=80% irMod=1.2", 1_000_000, 800_000, 0, 0, {
    ...USDC_RATES, irMod: 12_000_000,
  });
});
