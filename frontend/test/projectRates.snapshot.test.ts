import { describe, expect, it } from "vitest";

import {
  projectRates,
  type AssetInfo,
  type ProjectedRates,
  type RateConfig,
  type ReserveStats,
} from "../src/blend";

const TOTAL_SUPPLY = 1_000_000;

const RATE_CONFIG: RateConfig = {
  rBase: 300_000,
  rOne: 400_000,
  rTwo: 1_200_000,
  rThree: 50_000_000,
  utilOpt: 5_000_000,
  irMod: 10_000_000,
  backstopFP: 2_000_000,
};

const ASSET: AssetInfo = {
  id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 7,
  reserveIndex: 0,
  supplyTokenId: 1,
  borrowTokenId: 0,
  cFactor: 0.95,
  maxUtil: 0.95,
};

interface ProjectRateCase {
  name: string;
  utilization: number;
  addSupply?: number;
  addBorrow?: number;
}

function reserveStats(utilization: number): ReserveStats {
  const totalBorrow = TOTAL_SUPPLY * utilization;
  return {
    asset: ASSET,
    cFactor: ASSET.cFactor,
    lFactor: 1,
    priceUsd: 1,
    totalSupply: TOTAL_SUPPLY,
    totalBorrow,
    available: TOTAL_SUPPLY - totalBorrow,
    bRate: 1_000_000_000_000n,
    dRate: 1_000_000_000_000n,
    bSupply: BigInt(TOTAL_SUPPLY * 10_000_000),
    dSupply: BigInt(Math.round(totalBorrow * 10_000_000)),
    interestBorrowApr: 0,
    interestSupplyApr: 0,
    blndSupplyApr: 0,
    blndBorrowApr: 0,
    netSupplyApr: 0,
    netBorrowCost: 0,
    supplyEps: 0n,
    borrowEps: 0n,
    supplyEmission: null,
    borrowEmission: null,
    rateConfig: RATE_CONFIG,
  };
}

function roundedRates(rates: ProjectedRates): ProjectedRates {
  return {
    interestSupplyApr: round(rates.interestSupplyApr),
    interestBorrowApr: round(rates.interestBorrowApr),
    blndSupplyApr: round(rates.blndSupplyApr),
    blndBorrowApr: round(rates.blndBorrowApr),
    netSupplyApr: round(rates.netSupplyApr),
    netBorrowCost: round(rates.netBorrowCost),
  };
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

function projectedUtilization(
  utilization: number,
  addSupply = 0,
  addBorrow = 0,
): number {
  return round((TOTAL_SUPPLY * utilization + addBorrow) / (TOTAL_SUPPLY + addSupply));
}

describe("projectRates snapshots", () => {
  it("pins outputs around the target and 95 percent utilization kinks", () => {
    const cases: ProjectRateCase[] = [
      { name: "empty pool", utilization: 0 },
      { name: "low utilization", utilization: 0.25 },
      { name: "just below target kink", utilization: 0.4999 },
      { name: "at target kink", utilization: 0.5 },
      { name: "just above target kink", utilization: 0.5001 },
      { name: "mid second slope", utilization: 0.75 },
      { name: "just below 95 pct kink", utilization: 0.9499 },
      { name: "at 95 pct kink", utilization: 0.95 },
      { name: "just above 95 pct kink", utilization: 0.9501 },
      { name: "high utilization", utilization: 0.99 },
      { name: "full utilization", utilization: 1 },
      {
        name: "new leverage crosses target kink",
        utilization: 0.45,
        addSupply: 100_000,
        addBorrow: 150_000,
      },
    ];

    expect(cases).toHaveLength(12);
    expect(
      cases.map(({ name, utilization, addSupply = 0, addBorrow = 0 }) => ({
        name,
        utilization: projectedUtilization(utilization, addSupply, addBorrow),
        addSupply,
        addBorrow,
        rates: roundedRates(projectRates(reserveStats(utilization), addSupply, addBorrow)),
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "empty pool",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 3,
            "interestSupplyApr": 0,
            "netBorrowCost": 3,
            "netSupplyApr": 0,
          },
          "utilization": 0,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "low utilization",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 5,
            "interestSupplyApr": 1,
            "netBorrowCost": 5,
            "netSupplyApr": 1,
          },
          "utilization": 0.25,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "just below target kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 6.9992,
            "interestSupplyApr": 2.79912,
            "netBorrowCost": 6.9992,
            "netSupplyApr": 2.79912,
          },
          "utilization": 0.4999,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "at target kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 7,
            "interestSupplyApr": 2.8,
            "netBorrowCost": 7,
            "netSupplyApr": 2.8,
          },
          "utilization": 0.5,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "just above target kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 7.00267,
            "interestSupplyApr": 2.80162,
            "netBorrowCost": 7.00267,
            "netSupplyApr": 2.80162,
          },
          "utilization": 0.5001,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "mid second slope",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 13.66667,
            "interestSupplyApr": 8.2,
            "netBorrowCost": 13.66667,
            "netSupplyApr": 8.2,
          },
          "utilization": 0.75,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "just below 95 pct kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 18.99734,
            "interestSupplyApr": 14.43645,
            "netBorrowCost": 18.99734,
            "netSupplyApr": 14.43645,
          },
          "utilization": 0.9499,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "at 95 pct kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 19,
            "interestSupplyApr": 14.44,
            "netBorrowCost": 19,
            "netSupplyApr": 14.44,
          },
          "utilization": 0.95,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "just above 95 pct kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 20,
            "interestSupplyApr": 15.2016,
            "netBorrowCost": 20,
            "netSupplyApr": 15.2016,
          },
          "utilization": 0.9501,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "high utilization",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 419,
            "interestSupplyApr": 331.848,
            "netBorrowCost": 419,
            "netSupplyApr": 331.848,
          },
          "utilization": 0.99,
        },
        {
          "addBorrow": 0,
          "addSupply": 0,
          "name": "full utilization",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 519,
            "interestSupplyApr": 415.2,
            "netBorrowCost": 519,
            "netSupplyApr": 415.2,
          },
          "utilization": 1,
        },
        {
          "addBorrow": 150000,
          "addSupply": 100000,
          "name": "new leverage crosses target kink",
          "rates": {
            "blndBorrowApr": 0,
            "blndSupplyApr": 0,
            "interestBorrowApr": 8.21212,
            "interestSupplyApr": 3.58347,
            "netBorrowCost": 8.21212,
            "netSupplyApr": 3.58347,
          },
          "utilization": 0.54545455,
        },
      ]
    `);
  });
});
