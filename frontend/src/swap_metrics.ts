/**
 * Swap quote comparison — SCF T3.1.
 *
 * Split out of views/swap.ts so the Broker-vs-Aquarius comparison can be tested
 * without a DOM or a live broker session. This is the arithmetic behind the
 * "Broker advantage" row and the "Best rate" marker.
 */

export type QuoteWinner = "broker" | "aquarius" | "tie";

export interface QuoteComparison {
  winner: QuoteWinner;
  /** brokerOut − aquariusOut, in units of the buy asset. Signed. */
  diff: number;
  /** `diff` as a percentage of the Aquarius quote. Signed. */
  pct: number;
}

/**
 * Below a basis point the two routes are the same trade in practice — calling a
 * winner there would dress noise up as a recommendation.
 */
export const TIE_EPS_PCT = 0.01;

/**
 * Compare two quotes for the SAME trade (same input amount, same direction,
 * quoted moments apart). Anything else makes the difference meaningless.
 *
 * Returns a tie when the gap is under a basis point, when either side is
 * missing/non-finite, or when the Aquarius quote is non-positive (no usable
 * baseline to take a percentage against) — never a fabricated winner.
 */
export function compareQuotes(brokerOut: number, aquariusOut: number): QuoteComparison {
  if (!Number.isFinite(brokerOut) || !Number.isFinite(aquariusOut) || aquariusOut <= 0) {
    return { winner: "tie", diff: 0, pct: 0 };
  }
  const diff = brokerOut - aquariusOut;
  const pct = (diff / aquariusOut) * 100;
  if (Math.abs(pct) < TIE_EPS_PCT) return { winner: "tie", diff, pct };
  return { winner: diff > 0 ? "broker" : "aquarius", diff, pct };
}
