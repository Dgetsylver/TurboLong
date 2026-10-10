// A9 Compare Pools — model unit tests: history windows, leverage brackets,
// cross-pool ranking, chart geometry, and the <100 ms render budget.
import { describe, expect, it } from "vitest";
import {
  ARROW,
  BRACKETS,
  WIN_POINTS,
  aprToApy,
  axisTicks,
  baseApy,
  bracketApy,
  bracketLabel,
  chartGeometry,
  netApyAtLeverage,
  rankRows,
  resample,
  sliceWindow,
  trendDelta,
  trendOf,
  type CompareRowData,
} from "../src/compare_model.ts";
import type { SnapshotPoint } from "../src/history.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-03T12:00:00Z");

/** A series of `days` daily points ending at NOW, value = f(dayIndex). */
function series(days: number, f: (i: number) => number): SnapshotPoint[] {
  const out: SnapshotPoint[] = [];
  for (let i = 0; i < days; i++) {
    out.push({ ts: NOW - (days - 1 - i) * DAY, val: f(i) });
  }
  return out;
}

function row(over: Partial<CompareRowData> = {}): CompareRowData {
  return {
    poolName: "Pool A",
    poolId: "CPOOLA",
    assetSymbol: "USDC",
    assetId: "CUSDC",
    netSupplyApr: 6,
    netBorrowCost: 3,
    safeLev: 5,
    dexRate: 1,
    series: [],
    ...over,
  };
}

describe("sliceWindow", () => {
  const s = series(400, (i) => i);

  it("slices 7D / 30D / 1Y to different lengths", () => {
    // The window chips used to only change resample density — every chip drew
    // the same full series. Each window must now cover a distinct span.
    const w7 = sliceWindow(s, "7D", NOW);
    const w30 = sliceWindow(s, "30D", NOW);
    const w1y = sliceWindow(s, "1Y", NOW);
    expect(w7.length).toBe(8); // 7 days back, inclusive of both endpoints
    expect(w30.length).toBe(31);
    expect(w1y.length).toBe(366);
    expect(w7.length).toBeLessThan(w30.length);
    expect(w30.length).toBeLessThan(w1y.length);
  });

  it("keeps only points at or after the cutoff, oldest→newest", () => {
    const w7 = sliceWindow(s, "7D", NOW);
    expect(w7[0].ts).toBeGreaterThanOrEqual(NOW - 7 * DAY);
    expect(w7[w7.length - 1].ts).toBe(NOW);
    for (let i = 1; i < w7.length; i++) expect(w7[i].ts).toBeGreaterThan(w7[i - 1].ts);
  });

  it("returns empty when every point predates the window", () => {
    const stale = series(5, () => 4).map((p) => ({ ...p, ts: p.ts - 400 * DAY }));
    expect(sliceWindow(stale, "30D", NOW)).toHaveLength(0);
  });

  it("windows can disagree on direction — the point of scoping the arrow", () => {
    // Rose over the year, fell over the last week.
    const s2 = [...series(400, (i) => i * 0.1).slice(0, 393), ...series(7, (i) => 40 - i)];
    expect(trendOf(sliceWindow(s2, "1Y", NOW).map((p) => p.val))).toBe("up");
    expect(trendOf(sliceWindow(s2, "7D", NOW).map((p) => p.val))).toBe("down");
  });
});

describe("trendOf / trendDelta", () => {
  it("flags up, down and flat", () => {
    expect(trendOf([1, 2, 3])).toBe("up");
    expect(trendOf([3, 2, 1])).toBe("down");
    expect(trendOf([2, 9, 2.01])).toBe("flat"); // end-to-end move under epsilon
    expect(trendOf([5])).toBe("flat");
    expect(trendOf([])).toBe("flat");
  });

  it("delta is end-to-end, in percentage points", () => {
    expect(trendDelta([4, 9, 6.5])).toBeCloseTo(2.5, 10);
    expect(trendDelta([7])).toBe(0);
  });

  it("has an arrow glyph for every trend", () => {
    expect(ARROW.up).toBe("▲");
    expect(ARROW.down).toBe("▼");
    expect(ARROW.flat).toBe("—");
  });
});

describe("resample", () => {
  it("resamples to exactly n points and preserves the endpoints", () => {
    const out = resample([0, 10], 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0);
    expect(out[4]).toBe(10);
    expect(out[2]).toBeCloseTo(5, 10);
  });

  it("does not read past the end of the input", () => {
    const out = resample([1, 2, 3], 7);
    expect(out).toHaveLength(7);
    expect(out.every(Number.isFinite)).toBe(true);
    expect(out[6]).toBe(3);
  });

  it("passes short series through untouched", () => {
    expect(resample([4], 10)).toEqual([4]);
    expect(resample([], 10)).toEqual([]);
  });
});

describe("APR to APY", () => {
  it("uses daily compounding", () => {
    expect(aprToApy(6)).toBeCloseTo(6.1831, 4);
    expect(aprToApy(6)).not.toBeCloseTo((Math.exp(0.06) - 1) * 100, 4);
  });
});

describe("leverage brackets", () => {
  it("1× equals the base APY", () => {
    const r = row({ netSupplyApr: 6 });
    expect(netApyAtLeverage(r, 1)).toBeCloseTo(baseApy(r), 10);
    expect(baseApy(r)).toBeCloseTo(aprToApy(6), 10);
  });

  it("positive carry: APY grows with leverage", () => {
    const r = row({ netSupplyApr: 6, netBorrowCost: 3, safeLev: 10 });
    const a2 = bracketApy(r, 2).apy;
    const a3 = bracketApy(r, 3).apy;
    const a5 = bracketApy(r, 5).apy;
    expect(a2).toBeLessThan(a3);
    expect(a3).toBeLessThan(a5);
    // 3× on 6% supply / 3% borrow = 18 − 6 = 12% APR.
    expect(a3).toBeCloseTo(aprToApy(12), 10);
  });

  it("negative carry: 'max' stays unlevered at 1×", () => {
    const r = row({ netSupplyApr: 2, netBorrowCost: 9, safeLev: 5 });
    const m = bracketApy(r, "max");
    expect(m.lev).toBe(1);
    expect(m.apy).toBeCloseTo(baseApy(r), 10);
    expect(m.capped).toBe(false);
    // A fixed bracket still reports the (worse) leveraged reality.
    expect(bracketApy(r, 3).apy).toBeLessThan(m.apy);
  });

  it("positive carry: 'max' uses the safeLev ceiling", () => {
    const r = row({ netSupplyApr: 6, netBorrowCost: 3, safeLev: 4.2 });
    expect(bracketApy(r, "max").lev).toBeCloseTo(4.2, 10);
  });

  it("clamps a bracket above safeLev and flags it", () => {
    const r = row({ netSupplyApr: 6, netBorrowCost: 3, safeLev: 3.2 });
    const b = bracketApy(r, 10);
    expect(b.capped).toBe(true);
    expect(b.lev).toBeCloseTo(3.2, 10);
    expect(b.apy).toBeCloseTo(netApyAtLeverage(r, 3.2), 10);
    expect(bracketApy(r, 2).capped).toBe(false);
  });

  it("never evaluates below 1×, even on a malformed safeLev", () => {
    const r = row({ safeLev: 0 });
    for (const b of BRACKETS) expect(bracketApy(r, b).lev).toBeGreaterThanOrEqual(1);
  });

  it("labels every bracket", () => {
    expect(BRACKETS.map(bracketLabel)).toEqual(["2×", "3×", "5×", "10×", "Max"]);
  });
});

describe("rankRows — cross-pool ranking", () => {
  const rows = [
    // Low base, high ceiling — wins once leverage is stacked on.
    row({ poolName: "Pool A", poolId: "CA", assetSymbol: "USDC", assetId: "C1", netSupplyApr: 4, netBorrowCost: 1, safeLev: 10 }),
    // High base, low ceiling — wins at low leverage only.
    row({ poolName: "Pool B", poolId: "CB", assetSymbol: "XLM", assetId: "C2", netSupplyApr: 9, netBorrowCost: 8, safeLev: 2 }),
  ];

  it("ranks best net APY first and numbers from 1", () => {
    const out = rankRows(rows, 2);
    expect(out[0].rank).toBe(1);
    expect(out[1].rank).toBe(2);
    expect(out[0].result.apy).toBeGreaterThanOrEqual(out[1].result.apy);
  });

  it("the winner changes with the bracket", () => {
    // At 2×: B = 9*2 − 8 = 10% vs A = 4*2 − 1 = 7% → B wins.
    expect(rankRows(rows, 2)[0].row.assetSymbol).toBe("XLM");
    // At 5×: A = 4*5 − 1*4 = 16% vs B (capped at 2×) = 10% → A wins.
    expect(rankRows(rows, 5)[0].row.assetSymbol).toBe("USDC");
  });

  it("marks the capped row at a bracket it cannot reach", () => {
    const b = rankRows(rows, 5).find((r) => r.row.assetSymbol === "XLM");
    expect(b?.result.capped).toBe(true);
    expect(b?.result.lev).toBe(2);
  });

  it("is a pure function of its input", () => {
    const before = JSON.stringify(rows);
    rankRows(rows, "max");
    expect(JSON.stringify(rows)).toBe(before);
  });

  it("breaks ties deterministically on lower leverage, then name", () => {
    // Same APY at 2×: supply 5 / borrow 5 → 5% at any leverage.
    const flat = [
      row({ poolName: "Z", poolId: "CZ", assetSymbol: "B", assetId: "C4", netSupplyApr: 5, netBorrowCost: 5, safeLev: 5 }),
      row({ poolName: "A", poolId: "CA2", assetSymbol: "B", assetId: "C5", netSupplyApr: 5, netBorrowCost: 5, safeLev: 5 }),
    ];
    expect(rankRows(flat, 2).map((r) => r.row.poolName)).toEqual(["A", "Z"]);
  });

  it("handles an empty table", () => {
    expect(rankRows([], "max")).toEqual([]);
  });
});

describe("chartGeometry", () => {
  it("builds line and closed area paths inside the viewBox", () => {
    const g = chartGeometry([1, 5, 3], 100, 40);
    expect(g).not.toBeNull();
    if (!g) return;
    expect(g.line.startsWith("M")).toBe(true);
    expect(g.area.endsWith("Z")).toBe(true);
    expect(g.min).toBe(1);
    expect(g.max).toBe(5);
    expect(g.first).toBe(1);
    expect(g.last).toBe(3);
    const coords = g.line.slice(1).split(/[ML]/).map((p) => p.split(",").map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(100);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(40);
    }
  });

  it("centres a flat series instead of pinning it to an edge", () => {
    const g = chartGeometry([4, 4, 4], 100, 40);
    expect(g).not.toBeNull();
    expect(g?.lastY).toBeCloseTo(20, 5); // pad 3 + innerH/2 = 3 + 17
  });

  it("returns null when there is nothing to draw", () => {
    expect(chartGeometry([1], 100, 40)).toBeNull();
    expect(chartGeometry([], 100, 40)).toBeNull();
    expect(chartGeometry([1, 2], 4, 40)).toBeNull();
  });
});

describe("axisTicks", () => {
  it("returns evenly spaced labels spanning the window", () => {
    const ticks = axisTicks(series(30, (i) => i), 3);
    expect(ticks).toHaveLength(3);
    expect(new Set(ticks).size).toBe(3);
  });

  it("degrades safely on thin input", () => {
    expect(axisTicks([], 3)).toEqual([]);
    expect(axisTicks(series(1, () => 1), 3)).toHaveLength(1);
  });
});

describe("render budget", () => {
  // Acceptance criterion: charts render in < 100 ms. The DOM-free work — window
  // slicing, resampling, ranking and path building — is the part that scales
  // with the table, so it is what we bound here.
  it("ranks and builds every chart for a full table in well under 100 ms", () => {
    const POOLS = 6;
    const ASSETS = 8; // 48 rows — larger than any live Blend deployment
    const hist = series(365, (i) => 5 + Math.sin(i / 9) * 2);
    const rows: CompareRowData[] = [];
    for (let p = 0; p < POOLS; p++) {
      for (let a = 0; a < ASSETS; a++) {
        rows.push(
          row({
            poolName: `Pool ${p}`,
            poolId: `CP${p}`,
            assetSymbol: `A${a}`,
            assetId: `CA${p}_${a}`,
            netSupplyApr: 3 + a * 0.7,
            netBorrowCost: 1 + p * 0.3,
            safeLev: 2 + a * 0.5,
            series: hist,
          }),
        );
      }
    }

    const t0 = performance.now();
    let drawn = 0;
    for (const bracket of BRACKETS) {
      for (const win of ["7D", "30D", "1Y"] as const) {
        for (const rr of rankRows(rows, bracket)) {
          const vals = sliceWindow(rr.row.series, win, NOW).map((p) => p.val);
          const g = chartGeometry(resample(vals, WIN_POINTS[win]), 320, 96);
          axisTicks(sliceWindow(rr.row.series, win, NOW), 3);
          trendOf(vals);
          if (g) drawn++;
        }
      }
    }
    const elapsed = performance.now() - t0;

    expect(drawn).toBe(rows.length * BRACKETS.length * 3);
    // 720 chart builds; a single view render is 48 of them.
    expect(elapsed).toBeLessThan(100 * BRACKETS.length * 3);
    // Per-render budget, the number the acceptance criterion actually names.
    expect(elapsed / (BRACKETS.length * 3)).toBeLessThan(100);
  });
});
