// Issue #288 — unit tests for the proportional partial unwind ("Remove Funds").
//
// Exercises the PURE math helper `removeFundsAmounts`, which `buildRemoveFundsXdr`
// uses to derive REPAY / WITHDRAW amounts. The invariant under test: removing a
// fraction f of equity scales the whole position by (1−f), so leverage and HF
// stay constant and the wallet nets exactly f × equity (= the requested amount).
import { describe, expect, it } from "vitest";
import { removeFundsAmounts, type AssetPosition } from "../src/blend.ts";

// Sample leveraged position: equity 100, debt 200, collateral 300 → leverage 3.
// HF/c are illustrative (c = 0.9) — the helper passes them through unchanged.
const pos = {
  collateral: 300,
  debt:       200,
  equity:     100,
  leverage:   3,
  hf:         1.35,
} as AssetPosition;

describe("removeFundsAmounts (proportional unwind at constant leverage)", () => {
  it("removing 30 of 100 equity repays 60, withdraws 90, nets 30", () => {
    const r = removeFundsAmounts(pos, 30);
    // f = 30 / 100 = 0.3 → repay = 0.3·200, withdraw = 0.3·300
    expect(r.repay).toBeCloseTo(60, 10);
    expect(r.withdraw).toBeCloseTo(90, 10);
    // Net to wallet = withdraw − repay = f × equity = the requested amount.
    expect(r.netToUser).toBeCloseTo(30, 10);
  });

  it("leverage and health factor are unchanged by the unwind", () => {
    const r = removeFundsAmounts(pos, 30);
    expect(r.newLeverage).toBeCloseTo(3, 10);
    expect(r.newHf).toBeCloseTo(1.35, 10);
  });

  it("net to user always equals the requested amount for any 0<f<1", () => {
    for (const amt of [1, 25, 50, 99.9]) {
      expect(removeFundsAmounts(pos, amt).netToUser).toBeCloseTo(amt, 9);
    }
  });

  it("removing the full equity throws (use Close instead)", () => {
    expect(() => removeFundsAmounts(pos, 100)).toThrow(/Close/);
    expect(() => removeFundsAmounts(pos, 150)).toThrow(/Close/);
  });

  it("removing zero or a negative amount guards", () => {
    expect(() => removeFundsAmounts(pos, 0)).toThrow(/positive/);
    expect(() => removeFundsAmounts(pos, -5)).toThrow(/positive/);
  });

  it("guards a position with no equity", () => {
    const empty = { collateral: 0, debt: 0, equity: 0, leverage: 0, hf: 0 } as AssetPosition;
    expect(() => removeFundsAmounts(empty, 10)).toThrow(/No equity/);
  });

  it("a debt-free position withdraws collateral only (no repay)", () => {
    const unlevered = { collateral: 100, debt: 0, equity: 100, leverage: 1, hf: Number.POSITIVE_INFINITY } as AssetPosition;
    const r = removeFundsAmounts(unlevered, 40);
    expect(r.repay).toBe(0);
    expect(r.withdraw).toBeCloseTo(40, 10);
    expect(r.netToUser).toBeCloseTo(40, 10);
  });
});
