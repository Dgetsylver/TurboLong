import { StrKey } from "@stellar/stellar-sdk";

export interface SwapAsset {
  symbol: string;
  name: string;
  domain: string;
  icon?: string;
  decimals?: number;
  issuer?: string;
  brokerId: string;
  contractId: string;
  rawContract?: string;
}

const CURATED_URL =
  "https://lobstr.co/api/v1/sep/assets/curated.json";

const CACHE_KEY = "turbolong.swap.assets";
const TTL_MS = 30_000;

let memoryCache:
  | {
      ts: number;
      assets: SwapAsset[];
    }
  | null = null;

const FALLBACK_ASSETS: SwapAsset[] = [
  {
    symbol: "XLM",
    name: "Stellar Lumens",
    domain: "stellar.org",
    brokerId: "XLM",
    contractId:
      "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  },
  {
    symbol: "USDC",
    brokerId:
      "USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    contractId:
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    name: "USD Coin",
    domain: "circle.com",
  },
];

function contractHexToStrKey(hex: string): string {
  return StrKey.encodeContract(Buffer.from(hex, "hex"));
}

function createXlmAsset(): SwapAsset {
  return {
    symbol: "XLM",
    name: "Stellar Lumens",
    domain: "stellar.org",
    brokerId: "XLM",
    contractId:
      "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  };
}

export async function loadSwapAssets(): Promise<SwapAsset[]> {
  const now = Date.now();

  if (memoryCache && now - memoryCache.ts < TTL_MS) {
    return memoryCache.assets;
  }

  try {
    const cached = sessionStorage.getItem(CACHE_KEY);

    if (cached) {
      const parsed = JSON.parse(cached);

      if (now - parsed.ts < TTL_MS) {
        memoryCache = parsed;
        return parsed.assets;
      }
    }

    const res = await fetch(CURATED_URL);

    if (!res.ok) {
      throw new Error("Failed curated fetch");
    }

    const json = await res.json();

    const assets: SwapAsset[] = [
      createXlmAsset(),
      ...json.assets.map((asset: any) => ({
        symbol: asset.code,
        name: asset.name,
        domain: asset.domain,
        icon: asset.icon,
        decimals: asset.decimals,
        issuer: asset.issuer,
        brokerId: `${asset.code}-${asset.issuer}`,
        contractId: contractHexToStrKey(asset.contract),
        rawContract: asset.contract,
      })),
    ];

    const payload = {
      ts: now,
      assets,
    };

    memoryCache = payload;
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));

    return assets;
  } catch {
    return FALLBACK_ASSETS;
  }
}

export function findAsset(
  assets: SwapAsset[],
  query: string,
): SwapAsset | undefined {
  const q = query.trim().toLowerCase();

  return assets.find((a) => {
    return (
      a.symbol.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.domain.toLowerCase().includes(q) ||
      a.contractId.toLowerCase() === q ||
      a.rawContract?.toLowerCase() === q
    );
  });
}
