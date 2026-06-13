// T3.2 — Aquarius listing registry for Turbolong vault receipt (share) tokens.
//
// Each Turbolong vault mints a SEP-41 receipt token (the vault_share contract)
// that represents a depositor's leveraged position. T3.2 lists those receipt
// tokens on Aquarius so they trade permissionlessly against USDC — letting a
// depositor exit without unwinding the leverage loop on-chain.
//
// This registry is populated AFTER the mainnet vaults + their share tokens are
// deployed (T1 D1) and each is listed on Aquarius — see
// docs/aquarius-listing-runbook.md. Until then the vault view shows a
// "listing after mainnet" notice and degrades gracefully.

/** Aquarius swap UI. The exact per-token deep-link param is not publicly
 * documented, so the UI links here and surfaces the copyable token contract ID. */
export const AQUARIUS_SWAP_URL = "https://aqua.network/swap";

export interface AquariusListing {
  /** SEP-41 receipt (share) token contract address. */
  shareToken: string;
  /** Counter asset the receipt token is paired against (usually USDC). */
  pairedWith: string;
  /** Aquarius constant-product pool index (BytesN<32> hex) once created, if known. */
  poolIndex?: string;
}

/** Keyed by vault assetSymbol (e.g. "USDC", "CETES"). Empty until mainnet listing. */
export const AQUARIUS_LISTINGS: Record<string, AquariusListing> = {
  // "USDC": { shareToken: "C…", pairedWith: "USDC", poolIndex: "…" },
};

export function getAquariusListing(assetSymbol: string): AquariusListing | null {
  return AQUARIUS_LISTINGS[assetSymbol] ?? null;
}
