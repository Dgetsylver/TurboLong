/**
 * Aquarius (AQUA) AMM rate client — SCF T3.1.
 *
 * Aquarius exposes a public, auth-free REST API for best-route quotes across the
 * aggregated Stellar DEX surface. We use `POST /find-path/` (strict-send) to get
 * the best output for a pair; the on-chain router is the documented fallback.
 *
 * No npm SDK exists — plain HTTP + @stellar/stellar-sdk is the supported path.
 */

import { getActiveNetwork, type NetworkMode } from "./blend.ts";

export interface AquariusEndpoints {
  /** Base URL of the Aquarius AMM REST API (find-path lives under it). */
  api: string;
  /** Aquarius router contract — quotes resolve to it and swaps execute on it. */
  router: string;
}

/**
 * Aquarius runs a separate deployment per network, and they share no state: the
 * mainnet API 400s on a testnet contract ID (`Object with address=… does not
 * exist`) rather than returning "no route". Sending testnet addresses to the
 * mainnet endpoint therefore renders every pair as untradeable — which is what
 * happened before these were network-scoped.
 *
 * Both deployments expose an `external/v1` and an `external/v2` find-path that
 * return byte-identical payloads on the pairs we quote. We stay on v1: it is
 * what the T3.1 mainnet acceptance evidence was generated against
 * (`docs/evidence/aquarius-rate-report.md`), and v2 buys us nothing today.
 */
const AQUARIUS_ENDPOINTS: Record<NetworkMode, AquariusEndpoints> = {
  mainnet: {
    api: "https://amm-api.aqua.network/api/external/v1",
    router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  },
  testnet: {
    // Aquarius rotates the testnet router on network resets. This one is
    // documented (Feb 2026) as stable across resets, and is verified live — the
    // pre-2026 address in older docs (CDGX6Q3Z…) is dead. Re-verify with
    // `stellar contract info interface --id … --network testnet` before a
    // listing run; see docs/aquarius-listing-runbook.md.
    api: "https://amm-api-testnet.aqua.network/api/external/v1",
    router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
  },
};

/** Aquarius API + router for the currently selected network. */
export function aquariusEndpoints(): AquariusEndpoints {
  const net = getActiveNetwork();
  const base = AQUARIUS_ENDPOINTS[net];
  // The env override stays mainnet-only: it exists to point the app at a
  // proxy/mirror of the production API, and applying it on testnet too would
  // silently send testnet addresses to a mainnet-shaped override.
  const override = import.meta.env.VITE_AQUARIUS_API as string | undefined;
  return net === "mainnet" && override ? { ...base, api: override } : base;
}

/** Aquarius router contract for the active network (execution + on-chain reads). */
export function aquariusRouter(): string {
  return aquariusEndpoints().router;
}

export interface AquariusQuote {
  /** Best output amount, in stroops (7-dp). */
  amountOut: bigint;
  /** Output net of pool fees, in stroops. */
  amountWithFee: bigint;
  /** Pool contract IDs along the chosen path. */
  pools: string[];
  /** Human-readable token names along the path. */
  tokens: string[];
  /** Base64 swap-chain XDR — hand straight to the router to execute. */
  swapChainXdr: string;
}

/**
 * Best-rate (strict-send) quote: how much `tokenOut` you get for `amountIn` of
 * `tokenIn`. Token addresses are Soroban contract IDs (SAC for classic assets).
 * Returns null when Aquarius is unreachable or has no feasible route (caller
 * falls back to its other source / hides the Aquarius figure).
 */
export async function aquariusBestRate(
  tokenInId: string,
  tokenOutId: string,
  amountInStroops: bigint,
): Promise<AquariusQuote | null> {
  if (tokenInId === tokenOutId || amountInStroops <= 0n) return null;
  try {
    const res = await fetch(`${aquariusEndpoints().api}/find-path/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: tokenInId,
        token_out_address: tokenOutId,
        amount: amountInStroops.toString(),
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as Record<string, unknown>;
    if (!d.success || d.amount == null) return null;
    return {
      amountOut: BigInt(d.amount as string),
      amountWithFee: BigInt((d.amount_with_fee as string) ?? (d.amount as string)),
      pools: (d.pools as string[]) ?? [],
      tokens: (d.tokens as string[]) ?? [],
      swapChainXdr: (d.swap_chain_xdr as string) ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Effective price of `tokenIn` in `tokenOut` from Aquarius (out per 1 in), or
 * null. Quotes a 1-unit (1e7 stroops) trade by default — adjust `probe` for
 * depth-sensitive pricing.
 */
export async function aquariusPrice(
  tokenInId: string,
  tokenOutId: string,
  probeStroops = 10_000_000n,
): Promise<number | null> {
  const q = await aquariusBestRate(tokenInId, tokenOutId, probeStroops);
  if (!q) return null;
  return Number(q.amountOut) / Number(probeStroops);
}
