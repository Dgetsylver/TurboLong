// Swap asset registry tests — stellar.expert top-50 parsing + fallbacks.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSwapAssetList,
  getSwapAssets,
  FALLBACK_SWAP_ASSETS,
  type ExpertAssetRecord,
} from "../src/swap-assets.ts";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const YUSDC_ISSUER = "GDGTVWSM4MGS4T7Z6W4RPWOCHE2I6RDFCIFZGS3DOA63LWQTRNZNTTFF";
const AQUA_ISSUER = "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA";

const rec = (asset: string, rating = 9, domain?: string): ExpertAssetRecord => ({
  asset,
  domain,
  rating: { average: rating },
});

afterEach(() => vi.unstubAllGlobals());

describe("buildSwapAssetList", () => {
  it("strips the asset-type suffix and derives contract IDs", () => {
    const list = buildSwapAssetList([rec("XLM"), rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io")]);
    expect(list.map((a) => a.brokerId)).toEqual(["XLM", `USDC-${USDC_ISSUER}`]);
    // Known mainnet SAC addresses (previously the hand-maintained map).
    expect(list[0].contractId).toBe("CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA");
    expect(list[1].contractId).toBe("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75");
  });

  it("filters low ratings, missing domains and invalid issuers", () => {
    const list = buildSwapAssetList([
      rec("XLM"),
      rec(`AQUA-${AQUA_ISSUER}-1`, 5, "aqua.network"), // below rating floor
      rec(`SCAM-${AQUA_ISSUER}-1`, 9), // no verified domain
      rec("BAD-NOTANISSUER-1", 9, "bad.example"), // invalid issuer key
      rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io"),
    ]);
    expect(list.map((a) => a.symbol)).toEqual(["XLM", "USDC"]);
  });

  it("pins XLM and canonical USDC ahead of higher-rated records", () => {
    const list = buildSwapAssetList([
      rec(`yUSDC-${YUSDC_ISSUER}-2`, 9.9, "ultracapital.xyz"),
      rec("XLM"),
      rec(`USDC-${USDC_ISSUER}-1`, 9.0, "centre.io"),
    ]);
    expect(list.map((a) => a.symbol)).toEqual(["XLM", "USDC", "yUSDC"]);
  });

  it("prepends XLM when the source list somehow lacks it", () => {
    const list = buildSwapAssetList([rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io")]);
    expect(list[0].brokerId).toBe("XLM");
  });

  it("disambiguates colliding codes with the issuer domain", () => {
    const list = buildSwapAssetList([
      rec("XLM"),
      rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io"),
      rec(`USDC-${YUSDC_ISSUER}-1`, 9.0, "ultracapital.xyz"),
    ]);
    const labels = list.filter((a) => a.symbol === "USDC").map((a) => a.label);
    expect(labels).toEqual(["USDC · centre.io", "USDC · ultracapital.xyz"]);
    expect(list.find((a) => a.symbol === "XLM")?.label).toBe("XLM");
  });

  it("dedupes identical broker IDs", () => {
    const list = buildSwapAssetList([
      rec("XLM"),
      rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io"),
      rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io"),
    ]);
    expect(list).toHaveLength(2);
  });
});

describe("getSwapAssets", () => {
  it("falls back to the static list when the API is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    expect(await getSwapAssets()).toBe(FALLBACK_SWAP_ASSETS);
  });

  it("falls back on non-OK responses and near-empty lists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    expect(await getSwapAssets()).toBe(FALLBACK_SWAP_ASSETS);

    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ _embedded: { records: [] } }),
    })));
    // Only the auto-prepended XLM would remain — not a usable pair list.
    expect(await getSwapAssets()).toBe(FALLBACK_SWAP_ASSETS);
  });

  it("returns the parsed list on success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        _embedded: { records: [rec("XLM"), rec(`USDC-${USDC_ISSUER}-1`, 9.7, "centre.io")] },
      }),
    })));
    const list = await getSwapAssets();
    expect(list.map((a) => a.symbol)).toEqual(["XLM", "USDC"]);
  });
});
