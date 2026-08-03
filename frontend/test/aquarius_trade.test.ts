// T3.2 module unit tests — network-scoped Aquarius endpoints/listings and the
// receipt-token trade maths.
import { afterEach, describe, expect, it } from "vitest";
import { setNetwork } from "../src/blend.ts";
import { aquariusEndpoints, aquariusRouter } from "../src/aquarius.ts";
import { AQUARIUS_LISTINGS, getAquariusListing, aquariusSwapUrl } from "../src/aquarius_listings.ts";
import { applySlippage, priceImpactBps, parsePoolIndex, DEFAULT_SLIPPAGE_BPS } from "../src/aquarius_trade.ts";

// blend.ts holds the active network in module state; leave it as found.
afterEach(() => setNetwork("mainnet"));

const IDX = "a".repeat(64);

describe("aquariusEndpoints", () => {
  it("resolves the mainnet deployment by default", () => {
    setNetwork("mainnet");
    expect(aquariusEndpoints().api).toContain("amm-api.aqua.network");
    expect(aquariusRouter()).toBe("CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK");
  });

  it("switches host AND router with the network", () => {
    setNetwork("testnet");
    expect(aquariusEndpoints().api).toContain("amm-api-testnet.aqua.network");
    expect(aquariusRouter()).toBe("CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD");
  });

  it("never points the two networks at the same endpoint", () => {
    // Regression guard: quoting testnet addresses against the mainnet API 400s,
    // which the client maps to "no route" — every pair silently looks
    // untradeable instead of misdirected.
    setNetwork("mainnet");
    const main = aquariusEndpoints();
    setNetwork("testnet");
    const test = aquariusEndpoints();
    expect(test.api).not.toBe(main.api);
    expect(test.router).not.toBe(main.router);
  });

  it("uses a distinct swap URL per network", () => {
    setNetwork("mainnet");
    const main = aquariusSwapUrl();
    setNetwork("testnet");
    expect(aquariusSwapUrl()).not.toBe(main);
  });
});

describe("getAquariusListing", () => {
  // Snapshot/restore rather than deleting the probe keys, so these tests keep
  // working once the registry actually has listings in it.
  const snapshot = { mainnet: { ...AQUARIUS_LISTINGS.mainnet }, testnet: { ...AQUARIUS_LISTINGS.testnet } };
  afterEach(() => {
    AQUARIUS_LISTINGS.mainnet = { ...snapshot.mainnet };
    AQUARIUS_LISTINGS.testnet = { ...snapshot.testnet };
  });

  it("returns null for an unlisted asset", () => {
    setNetwork("testnet");
    expect(getAquariusListing("NOPE")).toBeNull();
  });

  it("does not leak a testnet listing into mainnet", () => {
    AQUARIUS_LISTINGS.testnet.TESTASSET = {
      shareToken: "CSHARE",
      pairedWith: "CUNDER",
      poolIndex: IDX,
      tokens: ["CSHARE", "CUNDER"],
    };
    setNetwork("testnet");
    expect(getAquariusListing("TESTASSET")?.shareToken).toBe("CSHARE");
    setNetwork("mainnet");
    expect(getAquariusListing("TESTASSET")).toBeNull();
  });
});

describe("applySlippage", () => {
  it("derives out_min from the quote", () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n); // 1%
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
  });

  it("stays in integer maths for amounts a float would lose", () => {
    // 2^53 + 1 stroops: representable as bigint, not as a JS number.
    const big = 9_007_199_254_740_993n;
    expect(applySlippage(big, 100)).toBe((big * 9900n) / 10_000n);
  });

  it("rejects nonsensical tolerances rather than inverting the limit", () => {
    expect(() => applySlippage(1_000n, -1)).toThrow(/out of range/);
    expect(() => applySlippage(1_000n, 10_000)).toThrow(/out of range/);
  });

  it("defaults to 1%", () => {
    expect(DEFAULT_SLIPPAGE_BPS).toBe(100);
  });
});

describe("priceImpactBps", () => {
  it("measures the rate gap between probe and sized trade", () => {
    // probe: 1 unit → 1.0 out. sized: 100 units → 99 out (1% worse per unit).
    expect(priceImpactBps(10_000_000n, 10_000_000n, 1_000_000_000n, 990_000_000n)).toBeCloseTo(100, 6);
  });

  it("clamps rounding-induced negatives to zero", () => {
    expect(priceImpactBps(10_000_000n, 10_000_000n, 1_000_000_000n, 1_000_000_001n)).toBe(0);
  });

  it("returns null when a leg is unusable, rather than implying zero impact", () => {
    expect(priceImpactBps(10_000_000n, 0n, 1_000n, 1_000n)).toBeNull();
    expect(priceImpactBps(0n, 10n, 1_000n, 1_000n)).toBeNull();
    expect(priceImpactBps(10_000_000n, 10n, 1_000n, 0n)).toBeNull();
  });
});

describe("parsePoolIndex", () => {
  it("accepts 32-byte hex with or without 0x", () => {
    expect(parsePoolIndex(IDX)).toHaveLength(32);
    expect(parsePoolIndex(`0x${IDX}`)).toHaveLength(32);
  });

  it("rejects malformed indexes before they reach the router", () => {
    // The router's own failure mode here is an opaque host error, so a
    // malformed registry entry has to be caught where the message is useful.
    expect(() => parsePoolIndex("abc")).toThrow(/32-byte hex/);
    expect(() => parsePoolIndex("z".repeat(64))).toThrow(/32-byte hex/);
    expect(() => parsePoolIndex("")).toThrow(/32-byte hex/);
  });
});
