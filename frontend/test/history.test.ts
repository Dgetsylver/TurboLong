// T3.1/T3.3 module unit tests — history.ts fetchSnapshotSeries parsing.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSnapshotSeries } from "../src/history.ts";

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
