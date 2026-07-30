// T3.1 module unit tests — aquarius.ts best-rate client.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aquariusBestRate,
  aquariusBestRateResult,
  aquariusPrice,
  aquariusPriceResult,
  aquariusRateWithImpact,
  IMPACT_NOTIONAL,
} from "../src/aquarius.ts";

const IN = "CAAA_IN";
const OUT = "CBBB_OUT";

function mockFetchOnce(impl: () => unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => impl()));
}

/** Reply to successive find-path calls with `amount` read from the request's own
 *  probe size, so a fake can express a rate that degrades with trade size. */
function mockFetchByAmount(rateFor: (probeStroops: bigint) => number | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      const probe = BigInt(JSON.parse(init.body).amount as string);
      const rate = rateFor(probe);
      if (rate == null) return { ok: true, status: 200, json: async () => ({ success: false }) };
      return { ok: true, status: 200, json: async () => ({ success: true, amount: String(Math.round(rate * Number(probe))) }) };
    }),
  );
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

// The live mainnet API returns `amount` as a JSON *number*, not a string —
// locking that in so a float-vs-bigint slip can't silently blank the rate.
describe("response shape", () => {
  it("accepts a numeric amount (live mainnet shape)", async () => {
    mockFetchOnce(() => ({
      ok: true,
      json: async () => ({ success: true, amount: 1747183, amount_with_fee: 1747183 }),
    }));
    const q = await aquariusBestRate(IN, OUT, 10_000_000n);
    expect(q?.amountOut).toBe(1_747_183n);
    expect(q?.amountWithFee).toBe(1_747_183n);
  });

  it("rejects a non-numeric amount instead of throwing", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ success: true, amount: "not-a-number" }) }));
    const r = await aquariusBestRateResult(IN, OUT, 10_000_000n);
    expect(r.quote).toBeNull();
    expect(r.status).toBe("no_route");
  });
});

// The Compare/Swap views render "no route" and "unavailable" differently — a
// pair Aquarius refuses is not the same user-facing fact as Aquarius being down.
describe("status reporting", () => {
  it("reports ok on a successful quote", async () => {
    mockFetchOnce(() => ({ ok: true, json: async () => ({ success: true, amount: "20000000" }) }));
    expect(await aquariusPriceResult(IN, OUT, 10_000_000n)).toEqual({ price: 2, status: "ok" });
  });

  it("reports unreachable when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    const r = await aquariusPriceResult(IN, OUT);
    expect(r).toEqual({ price: null, status: "unreachable" });
  });

  it("reports unreachable on a 5xx", async () => {
    mockFetchOnce(() => ({ ok: false, status: 502, json: async () => ({}) }));
    expect((await aquariusBestRateResult(IN, OUT, 10_000_000n)).status).toBe("unreachable");
  });

  it("reports no_route on a 4xx", async () => {
    mockFetchOnce(() => ({ ok: false, status: 400, json: async () => ({}) }));
    expect((await aquariusBestRateResult(IN, OUT, 10_000_000n)).status).toBe("no_route");
  });

  it("reports no_route when Aquarius answers with success=false", async () => {
    mockFetchOnce(() => ({ ok: true, status: 200, json: async () => ({ success: false }) }));
    expect((await aquariusBestRateResult(IN, OUT, 10_000_000n)).status).toBe("no_route");
  });

  it("reports no_route for a same-token pair without calling out", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect((await aquariusBestRateResult(IN, IN, 10_000_000n)).status).toBe("no_route");
    expect(spy).not.toHaveBeenCalled();
  });
});

// The two probes behind the Compare "Best Rate" badge. The badge ranks on
// impactBps, so a wrong sign or a silent null here mis-badges the table.
describe("aquariusRateWithImpact", () => {
  it("measures impact as the per-unit rate lost at notional size", async () => {
    // 1 unit quotes 2.0; the sized probe quotes 1.98 — a 1% (100 bps) drop.
    mockFetchByAmount((probe) => (probe === 10_000_000n ? 2.0 : 1.98));
    const r = await aquariusRateWithImpact(IN, OUT);
    expect(r.status).toBe("ok");
    expect(r.rate).toBeCloseTo(2.0, 9);
    expect(r.impactBps).toBeCloseTo(100, 6);
  });

  it("sizes the second probe to the notional, not to a unit count", async () => {
    const seen: bigint[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: { body: string }) => {
        const probe = BigInt(JSON.parse(init.body).amount as string);
        seen.push(probe);
        return { ok: true, status: 200, json: async () => ({ success: true, amount: String(Number(probe) * 4) }) };
      }),
    );
    await aquariusRateWithImpact(IN, OUT);
    // rate = 4.0, so IMPACT_NOTIONAL of output needs notional/4 units in.
    expect(seen[0]).toBe(10_000_000n);
    expect(seen[1]).toBe(BigInt((IMPACT_NOTIONAL / 4) * 1e7));
  });

  it("reports zero impact, not a negative, when a bigger trade quotes better", async () => {
    // Mainnet returns small negatives on deep stable pairs; that is rounding,
    // and a negative would win the badge outright.
    mockFetchByAmount((probe) => (probe === 10_000_000n ? 1.0 : 1.0001));
    const r = await aquariusRateWithImpact(IN, OUT);
    expect(r.impactBps).toBe(0);
  });

  it("keeps the reference rate but drops impact when the sized probe has no route", async () => {
    // A pair that quotes 1 unit and nothing bigger must render its rate and stay
    // unbadgeable, rather than being badged on a rate nobody can trade.
    mockFetchByAmount((probe) => (probe === 10_000_000n ? 0.5 : null));
    const r = await aquariusRateWithImpact(IN, OUT);
    expect(r.rate).toBeCloseTo(0.5, 9);
    expect(r.impactBps).toBeNull();
  });

  it("returns a null rate and null impact when the reference probe fails", async () => {
    mockFetchOnce(() => ({ ok: false, status: 502, json: async () => ({}) }));
    const r = await aquariusRateWithImpact(IN, OUT);
    expect(r.rate).toBeNull();
    expect(r.impactBps).toBeNull();
    expect(r.status).toBe("unreachable");
  });

  it("skips the second probe when the sized trade is not bigger than the reference", async () => {
    const spy = vi.fn(async (_u: string, init: { body: string }) => {
      const probe = BigInt(JSON.parse(init.body).amount as string);
      return { ok: true, status: 200, json: async () => ({ success: true, amount: String(Number(probe) * 1e9) }) };
    });
    vi.stubGlobal("fetch", spy);
    // An absurdly valuable input asset: 1 unit already exceeds the notional.
    const r = await aquariusRateWithImpact(IN, OUT);
    expect(r.impactBps).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never throws when the network dies mid-probe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    await expect(aquariusRateWithImpact(IN, OUT)).resolves.toEqual({
      rate: null,
      impactBps: null,
      status: "unreachable",
    });
  });
});
