// T3.1 module unit tests — aquarius.ts best-rate client.
import { afterEach, describe, expect, it, vi } from "vitest";
import { aquariusBestRate, aquariusPrice } from "../src/aquarius.ts";

const IN = "CAAA_IN";
const OUT = "CBBB_OUT";

function mockFetchOnce(impl: () => unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

afterEach(() => vi.unstubAllGlobals());

describe("aquariusBestRate", () => {
  it("parses a successful find-path response", async () => {
    mockFetchOnce(() => ({
      ok: true,
      json: async () => ({
        success: true,
        amount: "12345678",
        amount_with_fee: "12300000",
        pools: ["CPOOL1"],
        tokens: ["IN", "OUT"],
        swap_chain_xdr: "AAAA",
      }),
    }));
    const q = await aquariusBestRate(IN, OUT, 10_000_000n);
    expect(q).not.toBeNull();
    expect(q?.amountOut).toBe(12_345_678n);
    expect(q?.amountWithFee).toBe(12_300_000n);
    expect(q?.pools).toEqual(["CPOOL1"]);
    expect(q?.swapChainXdr).toBe("AAAA");
  });

  it("defaults amountWithFee to amount when absent", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ success: true, amount: "500" }) }));
    const q = await aquariusBestRate(IN, OUT, 1_000n);
    expect(q?.amountWithFee).toBe(500n);
    expect(q?.pools).toEqual([]);
  });

  it("returns null for identical in/out token (no fetch)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await aquariusBestRate(IN, IN, 10_000_000n)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null for non-positive amount (no fetch)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(await aquariusBestRate(IN, OUT, 0n)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns null on non-ok HTTP", async () => {
    mockFetchOnce(() => ({ ok: false, json: async () => ({}) }));
    expect(await aquariusBestRate(IN, OUT, 10_000_000n)).toBeNull();
  });

  it("returns null when success=false or no route", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ success: false }) }));
    expect(await aquariusBestRate(IN, OUT, 10_000_000n)).toBeNull();
  });

  it("returns null when fetch throws (unreachable)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    expect(await aquariusBestRate(IN, OUT, 10_000_000n)).toBeNull();
  });
});

describe("aquariusPrice", () => {
  it("computes out-per-in ratio from the probe", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ success: true, amount: "20000000" }) }));
    // 20_000_000 out for a 10_000_000 probe = 2.0
    expect(await aquariusPrice(IN, OUT, 10_000_000n)).toBeCloseTo(2.0, 9);
  });

  it("returns null when there is no quote", async () => {
    mockFetchOnce(() => ({ ok: false, json: async () => ({}) }));
    expect(await aquariusPrice(IN, OUT)).toBeNull();
  });
});
