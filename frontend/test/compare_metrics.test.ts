// T3.1 / T3.3 — Compare Pools ranking + 24h/7d trend maths.
//
// Covers the two acceptance-relevant invariants: the "Best Rate" badge lands on
// the argmax of leveraged net APY, and the 24h/7d arrows are computed from the
// T2 snapshot series (and stay silent when the window is too thin to claim one).
import { describe, expect, it } from "vitest";
import {
  bestRowIndex,
  compareSortRows,
  deltaOverHours,
  FLAT_EPS,
  FLAT_EPS_PCT,
  pctChangeOverHours,
  resample,
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

describe("compareSortRows / bestRowIndex — Best Rate badge", () => {
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
