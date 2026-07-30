// T3.1 / T3.3 — Compare Pools ranking + 24h/7d trend maths.
//
// Covers the acceptance-relevant invariants: rank 1 (★) is the argmax of
// leveraged net APY, the "Best Rate" badge is the argmax of that yield *after*
// the Aquarius round-trip cost of entering and exiting, and the 24h/7d arrows
// are computed from the T2 snapshot series (and stay silent when the window is
// too thin to claim one).
import { describe, expect, it } from "vitest";
import {
  bestRateRowIndex,
  bestRowIndex,
  compareSortRows,
  deltaOverHours,
  FLAT_EPS,
  FLAT_EPS_PCT,
  HOLD_YEARS,
  NET_TIE_EPS_PP,
  netOfCostApy,
  pctChangeOverHours,
  resample,
  roundTripCostPp,
  trendOf,
  trendOfDelta,
  windowSlice,
} from "../src/compare_metrics.ts";
import type { SnapshotPoint } from "../src/history.ts";

const NOW = Date.UTC(2026, 6, 29, 12, 0, 0);
const H = 3_600_000;

/** 15-min snapshot series, oldest→newest, spanning `hours` back from NOW. */
function series(hours: number, valAt: (hoursAgo: number) => number): SnapshotPoint[] {
  const out: SnapshotPoint[] = [];
  for (let h = hours; h >= 0; h -= 0.25) out.push({ ts: NOW - h * H, val: valAt(h) });
  return out;
}

describe("compareSortRows / bestRowIndex — rank 1 (★)", () => {
  const rows = [
    { name: "a", levApy: 4.2 },
    { name: "b", levApy: 18.9 },
    { name: "c", levApy: -3.1 },
    { name: "d", levApy: 11.0 },
  ];

  it("ranks by leveraged net APY, descending", () => {
    expect(compareSortRows(rows).map((r) => r.name)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not mutate the input array", () => {
    const before = rows.map((r) => r.name);
    compareSortRows(rows);
    expect(rows.map((r) => r.name)).toEqual(before);
  });

  it("badges exactly the argmax row", () => {
    const ranked = compareSortRows(rows);
    const idx = bestRowIndex(ranked);
    expect(idx).toBe(0);
    expect(ranked[idx].name).toBe("b");
    const max = Math.max(...rows.map((r) => r.levApy));
    expect(ranked[idx].levApy).toBe(max);
  });

  it("badges the sole row when there is only one", () => {
    const one = compareSortRows([{ name: "solo", levApy: -9 }]);
    expect(bestRowIndex(one)).toBe(0);
  });

  it("badges nothing when there are no rows", () => {
    expect(bestRowIndex([])).toBe(-1);
  });

  it("still badges the top row when every APY is negative", () => {
    const ranked = compareSortRows([
      { name: "x", levApy: -12 },
      { name: "y", levApy: -2 },
    ]);
    expect(ranked[bestRowIndex(ranked)].name).toBe("y");
  });
});

describe("netOfCostApy — yield after Aquarius round-trip cost", () => {
  it("subtracts both legs of the trade, annualised over the holding period", () => {
    // 44.1 bps each way = 88.2 bps = 0.882pp off a 26.01% APY.
    expect(roundTripCostPp(44.1)).toBeCloseTo(0.882 / HOLD_YEARS, 9);
    expect(netOfCostApy(26.01, 44.1)).toBeCloseTo(26.01 - 0.882 / HOLD_YEARS, 9);
  });

  it("is a no-op at zero cost", () => {
    expect(netOfCostApy(19.15, 0)).toBe(19.15);
  });

  it("lets a large enough cost turn a positive yield negative", () => {
    // TESOURO: 1497.9 bps round trip is ~30pp — it eats a 6.14% yield whole.
    expect(netOfCostApy(6.14, 1497.9)).toBeCloseTo(6.14 - 29.958, 6);
    expect(netOfCostApy(6.14, 1497.9)).toBeLessThan(0);
  });
});

describe("bestRateRowIndex — the Aquarius-driven Best Rate badge", () => {
  // Live figures from docs/evidence/aquarius-rate-report.md + a real render.
  const live = [
    { name: "EURC", levApy: 26.01, dexImpactBps: 44.1 }, // net 25.13
    { name: "USDC", levApy: 19.15, dexImpactBps: 0 }, // net 19.15
    { name: "USTRY", levApy: 11.58, dexImpactBps: 122.5 }, // net  9.13
    { name: "PYUSD", levApy: 7.19, dexImpactBps: 1.2 }, // net  7.17
    { name: "TESOURO", levApy: 6.14, dexImpactBps: 1497.9 }, // net -23.82
    { name: "CETES", levApy: 4.18, dexImpactBps: 88.9 }, // net  2.40
    { name: "XLM", levApy: 2.55, dexImpactBps: 46.2 }, // net  1.63
  ];

  it("badges the best yield net of cost on live-shaped data", () => {
    const idx = bestRateRowIndex(live);
    expect(live[idx].name).toBe("EURC");
    const nets = live.map((r) => netOfCostApy(r.levApy, r.dexImpactBps));
    expect(nets[idx]).toBe(Math.max(...nets));
  });

  it("lets trading cost overturn the highest headline APY", () => {
    // TESOURO leads on APY but its round trip costs ~30pp; USDC wins on net.
    const ranked = [
      { name: "TESOURO", levApy: 20.0, dexImpactBps: 1497.9 },
      { name: "USDC", levApy: 8.0, dexImpactBps: 0 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("USDC");
    // ...and the ★ still goes to the APY leader — the two deliberately diverge.
    expect(compareSortRows(ranked)[bestRowIndex(compareSortRows(ranked))].name).toBe("TESOURO");
  });

  it("does not simply badge the cheapest row to trade", () => {
    // PYUSD is near-frictionless but yields far less; EURC wins on net despite
    // paying 44 bps each way. This is the case that separates option E from a
    // pure impact ranking.
    const ranked = [
      { name: "EURC", levApy: 26.01, dexImpactBps: 44.1 },
      { name: "PYUSD", levApy: 7.19, dexImpactBps: 1.2 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("EURC");
  });

  it("is row-level: the same asset in two pools is ranked by its own APY", () => {
    // One Aquarius rate, three levApy — the badge lands for a reason, not by
    // tiebreak, which a pure asset-level impact ranking could not do.
    const ranked = [
      { name: "XLM@YieldBlox", levApy: 2.55, dexImpactBps: 46.2 },
      { name: "XLM@Fixed", levApy: 0.06, dexImpactBps: 46.2 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("XLM@YieldBlox");
  });

  it("badges exactly one row", () => {
    const idx = bestRateRowIndex(live);
    expect(live.map((_, i) => i === idx).filter(Boolean)).toHaveLength(1);
  });

  it("ignores rows with no impact measurement", () => {
    // nulls are unquotable pairs — a missing cost must not read as a free trade.
    const ranked = [
      { name: "unquotable", levApy: 99, dexImpactBps: null },
      { name: "quoted", levApy: 12, dexImpactBps: 10 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("quoted");
  });

  it("badges nothing when Aquarius gave no impact for any row", () => {
    expect(bestRateRowIndex([{ levApy: 5, dexImpactBps: null }, { levApy: 1, dexImpactBps: null }])).toBe(-1);
    expect(bestRateRowIndex([])).toBe(-1);
  });

  it("does not fall back to rank 1 during an Aquarius outage", () => {
    // An outage must badge nothing rather than implying we priced the entry cost.
    const ranked = [
      { levApy: 18.9, dexImpactBps: null },
      { levApy: 4.2, dexImpactBps: null },
    ];
    expect(bestRateRowIndex(ranked)).toBe(-1);
  });

  it("ignores non-finite inputs", () => {
    expect(bestRateRowIndex([{ levApy: 9, dexImpactBps: Number.NaN }, { levApy: 3, dexImpactBps: 5 }])).toBe(1);
    expect(
      bestRateRowIndex([{ levApy: 9, dexImpactBps: Number.POSITIVE_INFINITY }, { levApy: 3, dexImpactBps: 5 }]),
    ).toBe(1);
    expect(bestRateRowIndex([{ levApy: Number.NaN, dexImpactBps: 0 }, { levApy: 3, dexImpactBps: 5 }])).toBe(1);
  });

  it("still badges the top row when every net return is negative", () => {
    const ranked = [
      { name: "less bad", levApy: -2, dexImpactBps: 10 },
      { name: "worse", levApy: -12, dexImpactBps: 10 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("less bad");
  });

  it("breaks a sub-tolerance tie toward the higher-APY (earlier) row", () => {
    // Rows arrive APY-sorted; a dead heat on net should not flicker tick to tick.
    const ranked = [
      { name: "a", levApy: 10.0, dexImpactBps: 0 },
      { name: "b", levApy: 10.02, dexImpactBps: 0 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("a");
  });

  it("still moves the badge when the gap clears the tie band", () => {
    const ranked = [
      { name: "a", levApy: 10.0, dexImpactBps: 0 },
      { name: "b", levApy: 10.0 + NET_TIE_EPS_PP * 3, dexImpactBps: 0 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("b");
  });

  it("requires a third row to beat the real maximum, not the incumbent", () => {
    // a and b tie; c must beat b's net, not a's.
    const ranked = [
      { name: "a", levApy: 10.0, dexImpactBps: 0 },
      { name: "b", levApy: 10.04, dexImpactBps: 0 },
      { name: "c", levApy: 10.02, dexImpactBps: 0 },
    ];
    expect(ranked[bestRateRowIndex(ranked)].name).toBe("a");
  });

  it("treats a zero-cost row as eligible, not as missing data", () => {
    // USDC needs no swap in either direction; that is a real zero, not a null.
    expect(bestRateRowIndex([{ levApy: 1, dexImpactBps: null }, { levApy: 2, dexImpactBps: 0 }])).toBe(1);
  });
});

describe("deltaOverHours — 24h / 7d arrows from the T2 snapshot table", () => {
  it("measures the change across the trailing 24h window only", () => {
    // Flat at 3% until 24h ago, then a linear climb to 5%.
    const s = series(72, (hoursAgo) => (hoursAgo > 24 ? 3 : 3 + (2 * (24 - hoursAgo)) / 24));
    expect(deltaOverHours(s, 24, NOW)).toBeCloseTo(2, 1);
  });

  it("measures the 7d window over a longer baseline", () => {
    const s = series(24 * 10, (hoursAgo) => 10 - hoursAgo * 0.01);
    // 7d window: oldest point is ~168h ago, newest is now → +1.68pp.
    expect(deltaOverHours(s, 24 * 7, NOW)).toBeCloseTo(1.68, 1);
  });

  it("is negative when the rate fell", () => {
    const s = series(48, (hoursAgo) => 5 + hoursAgo * 0.05);
    const d = deltaOverHours(s, 24, NOW);
    expect(d).not.toBeNull();
    expect(d as number).toBeLessThan(0);
  });

  it("returns null when the window holds fewer than two points", () => {
    const stale: SnapshotPoint[] = [{ ts: NOW - 40 * H, val: 4 }];
    expect(deltaOverHours(stale, 24, NOW)).toBeNull();
    expect(deltaOverHours([], 24, NOW)).toBeNull();
  });

  it("ignores points outside the window", () => {
    const s: SnapshotPoint[] = [
      { ts: NOW - 200 * H, val: 99 }, // way outside 24h — must not become the baseline
      { ts: NOW - 20 * H, val: 4 },
      { ts: NOW - 1 * H, val: 4.5 },
    ];
    expect(deltaOverHours(s, 24, NOW)).toBeCloseTo(0.5, 6);
  });
});

describe("pctChangeOverHours — 24h / 7d DEX-rate movement", () => {
  it("reports percent change, not absolute, so cheap and dear assets compare", () => {
    // AQUA-scale price and EURC-scale price, both up exactly 10%.
    const cheap: SnapshotPoint[] = [
      { ts: NOW - 20 * H, val: 0.0003 },
      { ts: NOW - 1 * H, val: 0.00033 },
    ];
    const dear: SnapshotPoint[] = [
      { ts: NOW - 20 * H, val: 1.16 },
      { ts: NOW - 1 * H, val: 1.276 },
    ];
    expect(pctChangeOverHours(cheap, 24, NOW)).toBeCloseTo(10, 6);
    expect(pctChangeOverHours(dear, 24, NOW)).toBeCloseTo(10, 6);
  });

  it("is negative when the rate fell", () => {
    const s: SnapshotPoint[] = [
      { ts: NOW - 20 * H, val: 1.0 },
      { ts: NOW - 1 * H, val: 0.95 },
    ];
    expect(pctChangeOverHours(s, 24, NOW)).toBeCloseTo(-5, 6);
  });

  it("scopes 24h and 7d independently", () => {
    const s: SnapshotPoint[] = [
      { ts: NOW - 6 * 24 * H, val: 1.0 }, // inside 7d, outside 24h
      { ts: NOW - 20 * H, val: 2.0 }, // inside both
      { ts: NOW - 1 * H, val: 2.2 },
    ];
    expect(pctChangeOverHours(s, 24, NOW)).toBeCloseTo(10, 6); // 2.0 → 2.2
    expect(pctChangeOverHours(s, 24 * 7, NOW)).toBeCloseTo(120, 6); // 1.0 → 2.2
  });

  it("returns null when the window is too thin", () => {
    expect(pctChangeOverHours([{ ts: NOW - 1 * H, val: 1 }], 24, NOW)).toBeNull();
    expect(pctChangeOverHours([], 24, NOW)).toBeNull();
  });

  it("returns null rather than infinity when the baseline is zero or negative", () => {
    const zero: SnapshotPoint[] = [
      { ts: NOW - 20 * H, val: 0 },
      { ts: NOW - 1 * H, val: 0.5 },
    ];
    expect(pctChangeOverHours(zero, 24, NOW)).toBeNull();
  });

  it("uses the looser flat band for rates than for APRs", () => {
    // A 0.08% rate wobble is noise; the same number as APR pp would be a trend.
    expect(trendOfDelta(0.08, FLAT_EPS_PCT)).toBe("flat");
    expect(trendOfDelta(0.08, FLAT_EPS)).toBe("up");
    expect(FLAT_EPS_PCT).toBeGreaterThan(FLAT_EPS);
  });
});

describe("windowSlice", () => {
  it("keeps only points inside the trailing window", () => {
    const s: SnapshotPoint[] = [
      { ts: NOW - 10 * 24 * H, val: 1 },
      { ts: NOW - 3 * 24 * H, val: 2 },
      { ts: NOW - 1 * H, val: 3 },
    ];
    expect(windowSlice(s, 7, NOW).map((p) => p.val)).toEqual([2, 3]);
    expect(windowSlice(s, 365, NOW)).toHaveLength(3);
  });
});

describe("trendOfDelta / trendOf", () => {
  it("treats sub-threshold moves as flat", () => {
    expect(trendOfDelta(0)).toBe("flat");
    expect(trendOfDelta(FLAT_EPS / 2)).toBe("flat");
    expect(trendOfDelta(-FLAT_EPS / 2)).toBe("flat");
  });

  it("signs real moves", () => {
    expect(trendOfDelta(0.5)).toBe("up");
    expect(trendOfDelta(-0.5)).toBe("down");
  });

  it("is flat for a non-finite delta rather than guessing a direction", () => {
    expect(trendOfDelta(Number.NaN)).toBe("flat");
  });

  it("reads a series first → last", () => {
    expect(trendOf([1, 2, 3])).toBe("up");
    expect(trendOf([3, 2, 1])).toBe("down");
    expect(trendOf([2])).toBe("flat");
    expect(trendOf([])).toBe("flat");
  });
});

describe("resample", () => {
  it("returns n points and pins both ends", () => {
    const out = resample([0, 10], 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(10);
    expect(out[2]).toBeCloseTo(5, 6);
  });

  it("passes through series too short to resample", () => {
    expect(resample([7], 12)).toEqual([7]);
    expect(resample([], 12)).toEqual([]);
  });
});
