// T3.2 — Aquarius listing registry for Turbolong vault receipt (share) tokens.
//
// Each Turbolong vault mints a SEP-41 receipt token (the vault_share contract)
// that represents a depositor's leveraged position. T3.2 lists those receipt
// tokens on Aquarius so they trade permissionlessly against the vault's
// underlying — letting a depositor exit without unwinding the leverage loop
// on-chain.
//
// Listings are recorded per network. Aquarius runs an independent deployment on
// each, so a pool created on testnet has no bearing on mainnet and the two must
// be able to coexist here: testnet is where we rehearse the whole listing +
// trade path, mainnet is where the grant evidence is produced. See
// docs/aquarius-listing-runbook.md.

import { getActiveNetwork, type NetworkMode } from "./blend.ts";

/** Aquarius swap UI, per network. Only used as an out-of-app fallback — the
 *  vault view trades in-app against the router (see aquarius_trade.ts). */
const AQUARIUS_SWAP_URLS: Record<NetworkMode, string> = {
  mainnet: "https://aqua.network/swap",
  testnet: "https://testnet.aqua.network/swap",
};

/** @deprecated Use `aquariusSwapUrl()` — this constant is mainnet-only. */
export const AQUARIUS_SWAP_URL = AQUARIUS_SWAP_URLS.mainnet;

export function aquariusSwapUrl(): string {
  return AQUARIUS_SWAP_URLS[getActiveNetwork()];
}

export interface AquariusListing {
  /** SEP-41 receipt (share) token contract address. */
  shareToken: string;
  /** Counter asset the receipt token is paired against. */
  pairedWith: string;
  /**
   * Aquarius constant-product pool index (BytesN<32>, hex).
   *
   * Required to trade: `swap_chained` addresses a pool by index, and the
   * find-path API only knows a pool once its indexer has picked it up — which
   * lags pool creation. Recording the index here lets the UI trade a
   * freshly-created pool without waiting on the indexer.
   */
  poolIndex: string;
  /**
   * The `tokens` vector exactly as passed to `init_standard_pool`, in that
   * order. Every subsequent router call (`estimate_swap`, `swap_chained`,
   * `deposit`) must repeat this order.
   *
   * Stored rather than derived because Aquarius orders tokens by the raw 32-byte
   * contract ID, and sorting the `C…` strkeys as strings gives a *different*
   * answer — base32 maps A-Z→0-25 and 2-7→26-31, so ASCII order and value order
   * disagree. Replaying the order that created the pool avoids re-deriving it
   * (and getting it subtly wrong) on every call.
   */
  tokens: [string, string];
  /** Pool contract address returned by `init_standard_pool`, for explorer links. */
  poolAddress?: string;
}

/**
 * Keyed by network, then by vault `assetSymbol` (e.g. "USDC", "CETES").
 *
 * Populated by `scripts/aquarius_create_pool.ts`, which prints the exact entry
 * to paste after a successful pool creation. Empty entries degrade gracefully:
 * the vault view shows a "not yet listed" notice instead of the trade panel.
 */
export const AQUARIUS_LISTINGS: Record<NetworkMode, Record<string, AquariusListing>> = {
  mainnet: {
    // Filled at mainnet launch — gated on the T1 D1 deploy. See the runbook.
  },
  testnet: {
    // Filled by the testnet listing run (scripts/aquarius_create_pool.ts).
    USDC: {
      shareToken: "CDWADWK2AYWWCZOZAHAPAKJDYXAST4VSDAPTIKQZRX7ZLN4YKP5U2G5A",
      pairedWith: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      poolIndex: "9ac7a9cde23ac2ada11105eeaa42e43c2ea8332ca0aa8f41f58d7160274d718e",
      poolAddress: "CAFGRLG7UBWBNGZ4O7DMQWRCAMPWYLJT4EBBFSGMHH3BBXLGV7KZV25Q",
      tokens: ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "CDWADWK2AYWWCZOZAHAPAKJDYXAST4VSDAPTIKQZRX7ZLN4YKP5U2G5A"],
    }
  },
};

/** The active network's listing for a vault asset, or null when not yet listed. */
export function getAquariusListing(assetSymbol: string): AquariusListing | null {
  return AQUARIUS_LISTINGS[getActiveNetwork()][assetSymbol] ?? null;
}
