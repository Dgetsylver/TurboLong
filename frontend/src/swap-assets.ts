/**
 * Swap asset registry — top Stellar assets ranked by stellar.expert's composite
 * rating (liquidity, 7d volume, trustlines, age, interop). A CoinGecko-style
 * "top 50 crypto" list would be useless here: StellarBroker only routes classic
 * Stellar assets, and asset codes are not unique on Stellar (anyone can issue
 * a "BTC"), so trust comes from the rating + verified home domain, not the code.
 *
 * The list is fetched once per day (localStorage cache) and falls back to a
 * static top-assets list when stellar.expert is unreachable, so the swap screen
 * always renders. Soroban contract IDs (for balance + Aquarius lookups) are
 * derived deterministically from CODE-ISSUER via Asset.contractId(), which
 * removes the hand-maintained broker→contract map and its typo class of bugs.
 */
import { Asset, Networks } from "@stellar/stellar-sdk";

export interface SwapAsset {
  /** Display code, e.g. "USDC". */
  symbol: string;
  /** Select label — `symbol`, or `symbol · domain` when the code collides. */
  label: string;
  /** StellarBroker asset id: "XLM" or "CODE-ISSUER". */
  brokerId: string;
  /** Soroban SAC contract id on mainnet (balances, Aquarius quotes). */
  contractId: string;
  /** Verified home domain from the issuer's stellar.toml (absent for XLM). */
  domain?: string;
}

const EXPERT_TOP_ASSETS_URL = "https://api.stellar.expert/explorer/public/asset?sort=rating&order=desc&limit=50";
const CACHE_KEY = "tl_swap_assets_v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Composite-rating floor — filters thin/abandoned assets out of the list. */
const MIN_RATING = 7;

const ISSUER_RE = /^G[A-Z2-7]{55}$/;
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function contractIdFor(brokerId: string): string {
  if (brokerId === "XLM") return Asset.native().contractId(Networks.PUBLIC);
  const [code, issuer] = brokerId.split("-");
  return new Asset(code, issuer).contractId(Networks.PUBLIC);
}

function makeAsset(brokerId: string, domain?: string): SwapAsset {
  const symbol = brokerId === "XLM" ? "XLM" : brokerId.split("-")[0];
  return { symbol, label: symbol, brokerId, contractId: contractIdFor(brokerId), domain };
}

/** Static fallback — the screen's previous hand-curated list, always available. */
export const FALLBACK_SWAP_ASSETS: SwapAsset[] = [
  makeAsset("XLM"),
  makeAsset(`USDC-${USDC_ISSUER}`, "centre.io"),
  makeAsset("EURC-GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2", "circle.com"),
  makeAsset("AQUA-GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", "aqua.network"),
  makeAsset("BLND-GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY", "blend.capital"),
  makeAsset("yXLM-GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55", "ultracapital.xyz"),
  makeAsset("USDGLO-GBBS25EGYQPGEZCGCFBKG4OAGFXU6DSOQBGTHELLJT3HZXZJ34HWS6XV", "glodollar.org"),
];

/** Shape of one stellar.expert asset record (fields we consume). */
export interface ExpertAssetRecord {
  /** "XLM" or "CODE-ISSUER-TYPE" (TYPE = 1 alphanum4 / 2 alphanum12). */
  asset: string;
  domain?: string;
  rating?: { average?: number };
}

/**
 * Turn stellar.expert records into the swap list: filter (rating floor, verified
 * domain, valid issuer), strip the trailing asset-type suffix, dedupe, pin
 * XLM + USDC as the default pair, and disambiguate colliding codes with the
 * issuer's domain. Exported for tests.
 */
export function buildSwapAssetList(records: ExpertAssetRecord[]): SwapAsset[] {
  const out: SwapAsset[] = [];
  const seen = new Set<string>();

  for (const rec of records) {
    if ((rec.rating?.average ?? 0) < MIN_RATING) continue;

    let brokerId: string;
    let domain: string | undefined;
    if (rec.asset === "XLM") {
      brokerId = "XLM";
    } else {
      // "CODE-ISSUER-TYPE" → "CODE-ISSUER" (broker format has no type suffix).
      const [code, issuer] = rec.asset.split("-");
      if (!code || !issuer || !ISSUER_RE.test(issuer)) continue;
      if (!rec.domain) continue; // unverified issuer — not worth the scam surface
      brokerId = `${code}-${issuer}`;
      domain = rec.domain;
    }
    if (seen.has(brokerId)) continue;
    seen.add(brokerId);
    out.push(makeAsset(brokerId, domain));
  }

  // Pin the default pair up front: XLM first, canonical USDC second.
  const pinRank = (a: SwapAsset) => (a.brokerId === "XLM" ? 0 : a.brokerId === `USDC-${USDC_ISSUER}` ? 1 : 2);
  out.sort((a, b) => pinRank(a) - pinRank(b)); // stable sort keeps rating order within rank 2
  if (out[0]?.brokerId !== "XLM") out.unshift(makeAsset("XLM"));

  // Same code twice (e.g. USDC vs yUSDC issuers)? Disambiguate with the domain.
  const codeCounts = new Map<string, number>();
  for (const a of out) codeCounts.set(a.symbol, (codeCounts.get(a.symbol) ?? 0) + 1);
  for (const a of out) {
    if ((codeCounts.get(a.symbol) ?? 0) > 1 && a.domain) a.label = `${a.symbol} · ${a.domain}`;
  }

  return out;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface CacheEntry {
  ts: number;
  assets: SwapAsset[];
}

function readCache(): SwapAsset[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!Array.isArray(entry.assets) || entry.assets.length < 2) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry.assets;
  } catch {
    return null;
  }
}

function writeCache(assets: SwapAsset[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), assets } satisfies CacheEntry));
  } catch {
    /* storage full/unavailable — cache is best-effort */
  }
}

/**
 * The top-50 swap list: 24h localStorage cache → stellar.expert → static
 * fallback. Never throws; always returns a usable list.
 */
export async function getSwapAssets(): Promise<SwapAsset[]> {
  const cached = readCache();
  if (cached) return cached;
  try {
    const res = await fetch(EXPERT_TOP_ASSETS_URL, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`swap-assets: stellar.expert returned ${res.status} — using the static fallback list`);
      return FALLBACK_SWAP_ASSETS;
    }
    const data = (await res.json()) as { _embedded?: { records?: ExpertAssetRecord[] } };
    const assets = buildSwapAssetList(data._embedded?.records ?? []);
    if (assets.length < 2) {
      console.warn("swap-assets: top-50 response parsed to an unusable list — using the static fallback");
      return FALLBACK_SWAP_ASSETS;
    }
    writeCache(assets);
    return assets;
  } catch (e) {
    console.warn("swap-assets: fetch failed — using the static fallback list:", e instanceof Error ? e.message : e);
    return FALLBACK_SWAP_ASSETS;
  }
}
