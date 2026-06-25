/**
 * Swap asset universe — sourced from the LOBSTR curated assets feed instead of
 * a hardcoded list. One entry yields everything the swap screen needs:
 *   - brokerId   ("CODE-ISSUER", or "XLM")  → estimateSwap()
 *   - contractId (C… StrKey)                → fetchAssetBalance / aquariusBestRate
 *   - icon / name / domain / decimals       → the asset picker UI
 *
 * The feed (`curated.json`) sends a 32-byte contract as raw hex; we encode it to
 * the canonical C… StrKey. XLM is native and absent from the feed, so we inject
 * a synthetic entry. On any fetch failure we fall back to a small built-in list
 * so the screen never dies.
 */
import { StrKey } from "@stellar/stellar-sdk";

export interface SwapAsset {
  symbol: string;     // asset code, e.g. "USDC"
  name: string;       // human name, e.g. "USD Coin"
  domain: string;     // home domain, e.g. "centre.io" ("" if unknown)
  icon: string;       // logo URL ("" if none)
  decimals: number;
  issuer: string;     // G… issuer ("" for native XLM)
  brokerId: string;   // "XLM" or "CODE-ISSUER" — the Stellar Broker asset id
  contractId: string; // C… StrKey Soroban contract id
}

const CURATED_URL = "https://lobstr.co/api/v1/sep/assets/curated.json";
const XLM_CONTRACT = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
const CACHE_KEY = "swapCuratedAssets:v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** Synthetic native entry — XLM is not in the curated feed. */
const XLM: SwapAsset = {
  symbol: "XLM",
  name: "Stellar Lumens",
  domain: "stellar.org",
  icon: "",
  decimals: 7,
  issuer: "",
  brokerId: "XLM",
  contractId: XLM_CONTRACT,
};

/** Last-resort list if the curated feed can't be reached (degraded, but usable). */
const FALLBACK: SwapAsset[] = [
  XLM,
  mk("USDC", "USD Coin", "centre.io", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"),
  mk("EURC", "Euro Coin", "centre.io", "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2", "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV"),
  mk("AQUA", "Aquarius", "aqua.network", "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK"),
];

function mk(symbol: string, name: string, domain: string, issuer: string, contractId: string): SwapAsset {
  return { symbol, name, domain, icon: "", decimals: 7, issuer, brokerId: `${symbol}-${issuer}`, contractId };
}

let cache: SwapAsset[] | null = null;
let inflight: Promise<SwapAsset[]> | null = null;

/** hex(32 bytes) → C… StrKey contract id, or null if malformed. */
function hexToContractId(hex: string): string | null {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  try {
    return StrKey.encodeContract(bytes);
  } catch {
    return null;
  }
}

interface CuratedEntry {
  contract?: string;
  code?: string;
  issuer?: string;
  name?: string;
  domain?: string;
  icon?: string;
  decimals?: number;
}

function mapEntry(a: CuratedEntry): SwapAsset | null {
  if (!a.code || !a.issuer || !a.contract) return null;
  const contractId = hexToContractId(a.contract);
  if (!contractId) return null;
  return {
    symbol: a.code,
    name: a.name || a.code,
    domain: a.domain || "",
    icon: a.icon || "",
    decimals: typeof a.decimals === "number" ? a.decimals : 7,
    issuer: a.issuer,
    brokerId: `${a.code}-${a.issuer}`,
    contractId,
  };
}

function dedupSorted(list: SwapAsset[]): SwapAsset[] {
  const seen = new Set<string>();
  const out: SwapAsset[] = [];
  for (const a of list) {
    if (seen.has(a.brokerId)) continue;
    seen.add(a.brokerId);
    out.push(a);
  }
  out.sort((x, y) => x.symbol.localeCompare(y.symbol));
  return out;
}

function readSession(): SwapAsset[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, list } = JSON.parse(raw) as { ts: number; list: SwapAsset[] };
    if (!Array.isArray(list) || !list.length) return null;
    if (Date.now() - ts > CACHE_TTL_MS) return null;
    return list;
  } catch {
    return null;
  }
}

function writeSession(list: SwapAsset[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), list }));
  } catch {
    /* quota / private mode — non-fatal */
  }
}

/** Fetch (once) + cache the curated asset list. Falls back on any failure. */
export async function loadSwapAssets(): Promise<SwapAsset[]> {
  if (cache) return cache;
  const cached = readSession();
  if (cached) {
    cache = cached;
    return cached;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(CURATED_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { assets?: CuratedEntry[] };
      const mapped = (json.assets ?? [])
        .map(mapEntry)
        .filter((a): a is SwapAsset => a !== null);
      if (!mapped.length) throw new Error("empty curated list");
      const list = [XLM, ...dedupSorted(mapped)];
      cache = list;
      writeSession(list);
      return list;
    } catch (e) {
      console.warn("Swap: curated asset fetch failed, using fallback —", e instanceof Error ? e.message : e);
      cache = FALLBACK;
      return FALLBACK;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Whatever's loaded so far — fallback list until the fetch resolves. */
export function swapAssetsSync(): SwapAsset[] {
  return cache ?? FALLBACK;
}

export function assetByBroker(brokerId: string): SwapAsset | undefined {
  return swapAssetsSync().find((a) => a.brokerId === brokerId);
}

export function symbolForBroker(brokerId: string): string {
  return assetByBroker(brokerId)?.symbol ?? brokerId;
}

export function contractForBroker(brokerId: string): string | undefined {
  return assetByBroker(brokerId)?.contractId;
}

/**
 * Filter the list by a free-text query. Matches code / name / domain / issuer
 * and the contract id — accepting both the C… StrKey and the raw 64-hex form.
 */
export function searchSwapAssets(list: SwapAsset[], query: string): SwapAsset[] {
  const s = query.trim().toLowerCase();
  if (!s) return list;
  // If the query is raw hex for a contract, compare against the encoded C… id.
  const asContract = /^[0-9a-f]{64}$/.test(s) ? hexToContractId(s)?.toLowerCase() : undefined;
  return list.filter((a) => {
    if (asContract && a.contractId.toLowerCase() === asContract) return true;
    return (
      a.symbol.toLowerCase().includes(s) ||
      a.name.toLowerCase().includes(s) ||
      a.domain.toLowerCase().includes(s) ||
      a.issuer.toLowerCase().includes(s) ||
      a.contractId.toLowerCase().includes(s)
    );
  });
}

/** True when the query looks like a contract id the user pasted (C… or hex). */
export function looksLikeContractId(query: string): boolean {
  const s = query.trim();
  return /^C[A-Z2-7]{55}$/.test(s) || /^[0-9a-fA-F]{64}$/.test(s);
}
