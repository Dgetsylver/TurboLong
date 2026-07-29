// T3.1 — Broker-vs-Aquarius quote comparison behind the "Broker advantage" row
// and the "Best rate" marker.
import { describe, expect, it } from "vitest";
import { compareQuotes, TIE_EPS_PCT } from "../src/swap_metrics.ts";

describe("compareQuotes", () => {
  it("gives it to the broker when it quotes more output", () => {
    const c = compareQuotes(101, 100);
    expect(c.winner).toBe("broker");
    expect(c.diff).toBeCloseTo(1, 9);
    expect(c.pct).toBeCloseTo(1, 9);
  });

  it("gives it to Aquarius when it quotes more — no home-team bias", () => {
    const c = compareQuotes(99, 100);
    expect(c.winner).toBe("aquarius");
    expect(c.diff).toBeCloseTo(-1, 9);
    expect(c.pct).toBeCloseTo(-1, 9);
  });

  it("calls a sub-basis-point gap a tie rather than a winner", () => {
    const c = compareQuotes(100.005, 100); // 0.005% — under the 0.01% band
    expect(c.winner).toBe("tie");
    expect(Math.abs(c.pct)).toBeLessThan(TIE_EPS_PCT);
  });

  it("calls it just above the band", () => {
    expect(compareQuotes(100.02, 100).winner).toBe("broker");
    expect(compareQuotes(99.98, 100).winner).toBe("aquarius");
  });

  it("is a tie for identical quotes", () => {
    const c = compareQuotes(42, 42);
    expect(c.winner).toBe("tie");
    expect(c.diff).toBe(0);
  });

  // With one side missing there is nothing to compare — the row must not imply
  // the broker won by default.
  it("ties rather than guessing when a quote is missing or non-finite", () => {
    expect(compareQuotes(Number.NaN, 100).winner).toBe("tie");
    expect(compareQuotes(100, Number.NaN).winner).toBe("tie");
    expect(compareQuotes(Number.POSITIVE_INFINITY, 100).winner).toBe("tie");
  });

  it("ties rather than dividing by a zero or negative baseline", () => {
    const c = compareQuotes(100, 0);
    expect(c.winner).toBe("tie");
    expect(Number.isFinite(c.pct)).toBe(true); // never Infinity
    expect(compareQuotes(100, -5).winner).toBe("tie");
  });

  it("keeps percentages meaningful across wildly different price scales", () => {
    // AQUA-scale amounts and EURC-scale amounts, both 2% in the broker's favour.
    expect(compareQuotes(0.000102, 0.0001).pct).toBeCloseTo(2, 6);
    expect(compareQuotes(1173.6, 1150).pct).toBeCloseTo(2.052, 3);
  });

  it("reports diff in buy-asset units, signed from the broker's perspective", () => {
    expect(compareQuotes(1.2345, 1.2).diff).toBeCloseTo(0.0345, 9);
    expect(compareQuotes(1.2, 1.2345).diff).toBeCloseTo(-0.0345, 9);
  });
});
