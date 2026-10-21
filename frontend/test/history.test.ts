// T3.1/T3.3 module unit tests — history.ts fetchSnapshotSeries parsing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshotSeries, fetchSnapshotSeriesMulti } from "../src/history.ts";

function mockFetch(impl: () => unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchSnapshotSeries", () => {
  it("parses snapshots and flips newest-first → oldest-first", async () => {
    // Server returns newest-first.
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        snapshots: [
          { recorded_at: "2026-06-02 12:00:00", net_supply_apr: 5.5 },
          { recorded_at: "2026-06-01 12:00:00", net_supply_apr: 4.0 },
        ],
      }),
    }));
    const s = await fetchSnapshotSeries("CPOOL", "USDC", "net_supply_apr", 10);
    expect(s).toHaveLength(2);
    // oldest first after reverse
    expect(s[0].val).toBe(4.0);
    expect(s[1].val).toBe(5.5);
    expect(s[0].ts).toBe(Date.parse("2026-06-01T12:00:00Z"));
    expect(s[0].ts).toBeLessThan(s[1].ts);
  });

  it("reads the requested field (net_borrow_cost)", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ snapshots: [{ recorded_at: "2026-06-01 00:00:00", net_borrow_cost: 1.25 }] }),
    }));
    const s = await fetchSnapshotSeries("CPOOL", "USDC", "net_borrow_cost", 10);
    expect(s[0].val).toBe(1.25);
  });

  it("drops rows with non-finite value or unparseable timestamp", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        snapshots: [
          { recorded_at: "2026-06-01 00:00:00", net_supply_apr: 3.0 },
          { recorded_at: "2026-06-02 00:00:00" }, // missing field → NaN, dropped
          { recorded_at: "not-a-date", net_supply_apr: 9 }, // bad ts → dropped
        ],
      }),
    }));
    const s = await fetchSnapshotSeries("CPOOL", "USDC", "net_supply_apr", 10);
    expect(s).toHaveLength(1);
    expect(s[0].val).toBe(3.0);
  });

  it("returns [] on non-ok HTTP", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }));
    expect(await fetchSnapshotSeries("CPOOL", "USDC", "net_supply_apr")).toEqual([]);
  });

  it("returns [] when snapshots key is absent", async () => {
    mockFetch(() => ({ ok: true, json: async () => ({}) }));
    expect(await fetchSnapshotSeries("CPOOL", "USDC", "net_supply_apr")).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await fetchSnapshotSeries("CPOOL", "USDC", "net_supply_apr")).toEqual([]);
  });
});

// `dex_rate` is nullable: NULL on ticks where Aquarius had no quote, and on
// every row written before migration 0004. Number(null) is 0 — which is finite
// — so a naive parse would turn a gap in the rate history into a rate of zero
// and hand the trend arrows a -100% move.
describe("fetchSnapshotSeries — nullable dex_rate", () => {
  it("drops NULL dex_rate rows instead of reading them as zero", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        snapshots: [
          { recorded_at: "2026-06-03 00:00:00", net_supply_apr: 5, dex_rate: 0.18 },
          { recorded_at: "2026-06-02 00:00:00", net_supply_apr: 5, dex_rate: null }, // Aquarius down
          { recorded_at: "2026-06-01 00:00:00", net_supply_apr: 5 }, // pre-migration row
        ],
      }),
    }));
    const s = await fetchSnapshotSeries("CPOOL", "XLM", "dex_rate", 10);
    expect(s).toHaveLength(1);
    expect(s[0].val).toBe(0.18);
    expect(s.some((p) => p.val === 0)).toBe(false);
  });

  it("keeps a genuine zero out of the series but never invents one", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({ snapshots: [{ recorded_at: "2026-06-01 00:00:00", dex_rate: null }] }),
    }));
    expect(await fetchSnapshotSeries("CPOOL", "XLM", "dex_rate", 10)).toEqual([]);
  });
});

describe("fetchSnapshotSeriesMulti", () => {
  it("returns both columns from a single request", async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        snapshots: [
          { recorded_at: "2026-06-02 00:00:00", net_supply_apr: 5.5, dex_rate: 0.18 },
          { recorded_at: "2026-06-01 00:00:00", net_supply_apr: 4.0, dex_rate: 0.17 },
        ],
      }),
    }));
    vi.stubGlobal("fetch", spy);

    const s = await fetchSnapshotSeriesMulti("CPOOL", "XLM", ["net_supply_apr", "dex_rate"] as const, 10);
    expect(spy).toHaveBeenCalledTimes(1); // one HTTP call, two series
    expect(s.net_supply_apr.map((p) => p.val)).toEqual([4.0, 5.5]);
    expect(s.dex_rate.map((p) => p.val)).toEqual([0.17, 0.18]);
  });

  it("applies the null filter per column independently", async () => {
    mockFetch(() => ({
      ok: true,
      json: async () => ({
        snapshots: [
          { recorded_at: "2026-06-02 00:00:00", net_supply_apr: 5.5, dex_rate: null },
          { recorded_at: "2026-06-01 00:00:00", net_supply_apr: 4.0, dex_rate: 0.17 },
        ],
      }),
    }));
    const s = await fetchSnapshotSeriesMulti("CPOOL", "XLM", ["net_supply_apr", "dex_rate"] as const, 10);
    expect(s.net_supply_apr).toHaveLength(2); // APR unaffected by the missing rate
    expect(s.dex_rate).toHaveLength(1);
  });

  it("gives every column an empty series when the request fails", async () => {
    mockFetch(() => ({ ok: false, json: async () => ({}) }));
    const s = await fetchSnapshotSeriesMulti("CPOOL", "XLM", ["net_supply_apr", "dex_rate"] as const, 10);
    expect(s).toEqual({ net_supply_apr: [], dex_rate: [] });
  });
});
