// T2.2/T2.3 acceptance — offline rebalance-keeper simulation harness.
//
// Generates a deterministic dataset (7 degenerate fixtures + 100 random
// scenarios, seed 20260613) proving the partial-unwind / auto-rebalance
// behaviour without a mainnet/testnet deploy. The dry-run core is an
// i128-FAITHFUL BigInt mirror of the contract math
// (contracts/strategies/blend_leverage/src/{leverage,blend_pool,lib}.rs):
//
//   HF              = (B · c_factor) / D, floor division      (compute_health_factor)
//   partial unwind:   x = floor((B·c − target·D)/(c − target)) + 1, clamped ≤ D
//                                                             (compute_partial_unwind)
//   loop count:       ceil(x / layer), layer = D·(1−c), clamp 1..20
//   execution:        `loops` layers of min(layer, remaining debt)
//                                                             (submit_deleverage)
//   trigger policy:   fire when HF < orange_hf; unwind to orange_hf
//                                                             (rebalance / rebalance_keeper)
//   keeper rate-limit: REBALANCE_COOLDOWN_LEDGERS = 60        (constants.rs)
//
// All positions are in stroops (1 normalized unit = 1e7), rates pinned at 1.0
// so tokens == underlying — the same fixed-point regime as the chain. The
// contract-side counterpart is the Rust test
// `test_partial_unwind_dry_run_matches_onchain_within_rounding`, which proves
// this exact prediction model matches the executed Blend-pool result within a
// few stroops per layer.
//
// Run:  npx tsx scripts/rebalance_sim.ts
// Out:  docs/evidence/rebalance-sim-dataset.json + rebalance-sim-report.md

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../docs/evidence");

const COOLDOWN_LEDGERS = 60; // constants::REBALANCE_COOLDOWN_LEDGERS
const SCALAR_7 = 10_000_000n; // 1e7 — c_factor / HF / stroop scale
const UNIT = 10_000_000n; // 1 normalized unit = 1e7 stroops

// ── i128-faithful contract math (BigInt floor division, like Rust i128) ──────

/** compute_health_factor: HF = (B · c) / D in 1e7 scale; null = no debt (∞). */
function hfI(B: bigint, D: bigint, c: bigint): bigint | null {
  if (D <= 0n) return null;
  return (B * c) / D;
}

/**
 * compute_partial_unwind: minimal underlying x to repay (and withdraw) so that
 * HF is restored to `target`. Mirrors leverage.rs exactly: floor division,
 * +1 stroop to clear the threshold, clamped at the outstanding debt.
 * Returns { repay, loops } with loops derived from the layer size D·(1−c).
 */
function partialUnwindI(
  B: bigint,
  D: bigint,
  c: bigint,
  target: bigint,
): { repay: bigint; loops: number } {
  if (D <= 0n) return { repay: 0n, loops: 0 };
  const hf = hfI(B, D, c);
  if (hf === null || hf >= target) return { repay: 0n, loops: 0 };

  const numerator = B * c - target * D; // negative when HF < target
  const denom = target - c; // > 0 for any sane target
  if (denom <= 0n) throw new Error("target_hf <= c_factor: unreachable by partial unwind");

  let repay = -numerator / denom + 1n; // +1 stroop clears the threshold
  if (repay > D) repay = D; // clamp: full close, never over-repay

  const layer = (D * (SCALAR_7 - c)) / SCALAR_7;
  if (layer === 0n) return { repay, loops: 1 };
  const loops = Number((repay + layer - 1n) / layer);
  return { repay, loops: Math.min(Math.max(loops, 1), 20) };
}

/**
 * submit_deleverage execution model: `loops` HF-neutral layers of
 * min(layer, remaining debt) — withdraw == repay each layer.
 * Returns the total underlying actually repaid.
 */
function executeLayersI(D: bigint, c: bigint, loops: number): bigint {
  const layer = (D * (SCALAR_7 - c)) / SCALAR_7;
  let total = 0n;
  let remaining = D;
  for (let i = 0; i < Math.min(loops, 20); i++) {
    const amount = layer < remaining ? layer : remaining;
    if (amount <= 0n) break;
    total += amount;
    remaining -= amount;
  }
  return total;
}

// ── Deterministic PRNG (LCG) — reproducible, no Math.random ──────────────────
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Scenario {
  id: number | string;
  kind: "random" | "degenerate";
  note?: string;
  cFactor: number;
  orangeHf: number;
  minHf: number;
  shockedHf: number | null; // null = no debt (∞)
  triggered: boolean;
  repay: number; // minimal closed-form repay (units)
  loops: number;
  executedRepay: number; // layered execution total (units)
  postHf: number | null; // null = full close (∞)
  fullClose: boolean;
  unsalvageable: boolean; // underwater: on-chain unwind reverts, no state change
  restored: boolean;
  valid: boolean;
}

const C_FACTORS = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const MIN_HFS = [1.05, 1.1];
const ORANGE_HFS = [1.15, 1.2];

const toStroops = (x: number): bigint => BigInt(Math.round(x * Number(UNIT)));
const toUnits = (x: bigint): number => Number(x) / Number(UNIT);
const to1e7 = (x: number): bigint => BigInt(Math.round(x * 1e7));

/**
 * Run the contract's rebalance policy on a position: fire when HF < orange_hf
 * (the exact `rebalance()` / `rebalance_keeper()` trigger), unwind the minimal
 * loops to restore HF to orange_hf via the layered execution model.
 */
function runPolicy(
  id: number | string,
  kind: Scenario["kind"],
  B: bigint,
  D: bigint,
  c: bigint,
  orangeI: bigint,
  minHf: number,
  note?: string,
): Scenario {
  const shocked = hfI(B, D, c);
  const triggered = shocked !== null && shocked < orangeI;

  let repay = 0n;
  let loops = 0;
  let executed = 0n;
  if (triggered) {
    ({ repay, loops } = partialUnwindI(B, D, c, orangeI));
    executed = executeLayersI(D, c, loops);
  }

  // Underwater guard: each layer withdraws == repays, so a cumulative
  // withdrawal beyond the collateral makes the atomic on-chain submit revert.
  // The honest dry-run prediction for an underwater position (equity < 0) is
  // therefore "no state change" — partial unwind cannot rescue it.
  const unsalvageable = triggered && executed > B;
  if (unsalvageable) executed = 0n;

  const postB = B - executed;
  const postD = D - executed;
  const fullClose = triggered && !unsalvageable && postD === 0n;
  const post = hfI(postB, postD, c);

  const layer = (D * (SCALAR_7 - c)) / SCALAR_7;
  // Dust guard parity: submit_deleverage no-ops when the layer floors to 0
  // stroops, so a dust position stays untouched on-chain — the dry-run must
  // predict exactly that (executed == 0), not a restoration.
  const dustNoop = triggered && layer === 0n;
  // Minimality: one fewer layer must NOT cover the required repay.
  const minimal = !triggered || dustNoop || loops <= 1 || BigInt(loops - 1) * layer < repay;
  const restored =
    !triggered ||
    fullClose ||
    (dustNoop || unsalvageable ? executed === 0n : post !== null && post >= orangeI);
  const valid =
    repay >= 0n &&
    repay <= D &&
    executed <= D &&
    postD >= 0n &&
    (postD === 0n || postB > 0n) &&
    restored &&
    minimal &&
    // Reverts are only ever predicted for genuinely underwater positions.
    (!unsalvageable || B < D) &&
    // Never fire outside the orange zone (contract no-op parity).
    (triggered || repay === 0n);

  return {
    id,
    kind,
    note,
    cFactor: Number(c) / 1e7,
    orangeHf: Number(orangeI) / 1e7,
    minHf,
    shockedHf: shocked === null ? null : Number(shocked) / 1e7,
    triggered,
    repay: toUnits(repay),
    loops,
    executedRepay: toUnits(executed),
    postHf: post === null ? null : Number(post) / 1e7,
    fullClose,
    unsalvageable,
    restored,
    valid,
  };
}

// ── Degenerate fixtures (T2.2 acceptance: all degenerate cases) ──────────────
function degenerateScenarios(): Scenario[] {
  const c = to1e7(0.9);
  const orange = to1e7(1.15);
  return [
    runPolicy("D1-no-debt", "degenerate", toStroops(10), 0n, c, orange, 1.05, "no debt → HF ∞, no-op"),
    // HF exactly at target: B/D = 1.15/0.9 = 23/18 → exact boundary, no-op.
    runPolicy("D2-boundary-exact", "degenerate", toStroops(23), toStroops(18), c, orange, 1.05, "HF == orange_hf exactly → no-op"),
    // One stroop past the boundary → minimal repay of a few stroops.
    runPolicy("D3-one-stroop-below", "degenerate", toStroops(23), toStroops(18) + 1n, c, orange, 1.05, "HF one stroop below orange_hf"),
    // Zero equity (B == D): closed form clamps to a full close.
    runPolicy("D4-zero-equity", "degenerate", toStroops(10), toStroops(10), c, orange, 1.05, "zero equity → full close, never over-repay"),
    // Negative equity (B < D): repay clamps at the debt, but the withdrawal
    // side exceeds the collateral — the on-chain unwind reverts (no rescue).
    runPolicy("D5-negative-equity", "degenerate", toStroops(9), toStroops(10), c, orange, 1.05, "underwater → unwind cannot rescue, predicted revert/no-op"),
    // Dust position: layer floors to 0 stroops → single-loop unwind.
    runPolicy("D6-dust", "degenerate", 5n, 5n, to1e7(0.95), to1e7(1.15), 1.05, "dust position, layer rounds to 0"),
    // HF < 1.0 (liquidatable) but equity positive: rescued by a partial unwind.
    runPolicy("D7-hf-below-one", "degenerate", toStroops(1000), toStroops(940), c, orange, 1.05, "HF < 1.0 but salvageable"),
  ];
}

// ── Random scenarios ──────────────────────────────────────────────────────────
function generate(n: number): Scenario[] {
  const rnd = lcg(20260613);
  const out: Scenario[] = [];
  for (let i = 0; i < n; i++) {
    const c = C_FACTORS[Math.floor(rnd() * C_FACTORS.length)];
    const minHf = MIN_HFS[Math.floor(rnd() * MIN_HFS.length)];
    const orangeHf = ORANGE_HFS[Math.floor(rnd() * ORANGE_HFS.length)];

    // Max leverage that still clears the orange band at open: HF = c·L/(L−1) ≥ orange
    //   ⇒ L ≤ orange / (orange − c). Pick a leverage in [1.5 .. that] so the
    // position opens healthy, then a rate shock pushes it down.
    const maxLev = orangeHf / (orangeHf - c);
    const leverage = 1.5 + rnd() * Math.max(0.1, maxLev - 1.5);

    // Equity normalised to 1: supply value B = L, debt value D = L − 1.
    // Rate shock: debt accrues (borrow APR) and/or collateral value drifts down.
    const debtShock = rnd() * 0.35;
    const supplyDrift = rnd() * 0.08;
    const B = toStroops(leverage * (1 - supplyDrift));
    const D = toStroops((leverage - 1) * (1 + debtShock));

    out.push(runPolicy(i + 1, "random", B, D, to1e7(c), to1e7(orangeHf), minHf));
  }
  return out;
}

// ── Cooldown sub-simulation ──────────────────────────────────────────────────
interface CooldownEvent { ledger: number; fired: boolean; reason: string }
function simulateCooldown(): { events: CooldownEvent[]; spacingOk: boolean } {
  const rnd = lcg(424242);
  const events: CooldownEvent[] = [];
  let last = 0; // 0 = never
  const fires: number[] = [];
  for (let ledger = 1; ledger <= 300; ledger++) {
    // Random HF dips into the orange zone ~10% of ledgers.
    const dip = rnd() < 0.1;
    if (!dip) continue;
    const cooling = last !== 0 && ledger < last + COOLDOWN_LEDGERS;
    if (cooling) {
      events.push({ ledger, fired: false, reason: `cooldown (last=${last}, +${COOLDOWN_LEDGERS})` });
    } else {
      last = ledger;
      fires.push(ledger);
      events.push({ ledger, fired: true, reason: "rebalanced → orange_hf" });
    }
  }
  let spacingOk = true;
  for (let i = 1; i < fires.length; i++) if (fires[i] - fires[i - 1] < COOLDOWN_LEDGERS) spacingOk = false;
  return { events, spacingOk };
}

// ── Run + report ─────────────────────────────────────────────────────────────
const degenerate = degenerateScenarios();
const scenarios = generate(100);
const all = [...degenerate, ...scenarios];
const triggered = all.filter((s) => s.triggered);
const invalid = all.filter((s) => !s.valid);
const cooldown = simulateCooldown();
const fires = cooldown.events.filter((e) => e.fired).length;
const blocked = cooldown.events.filter((e) => !e.fired).length;

const pass = invalid.length === 0 && cooldown.spacingOk;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  resolve(OUT_DIR, "rebalance-sim-dataset.json"),
  JSON.stringify(
    { generatedBy: "scripts/rebalance_sim.ts", seed: 20260613, degenerate, scenarios, cooldown },
    null,
    2,
  ),
);

const report = `# T2.2/T2.3 Acceptance — Rebalance Simulation Dataset

Offline, deterministic (seed 20260613) simulation of the partial-unwind /
auto-rebalance keeper, using an **i128-faithful BigInt mirror** of the
contract's own fixed-point math (floor division, +1-stroop threshold clear,
debt clamp, layered \`submit_deleverage\` execution). Trigger policy matches the
contract exactly: fire when HF < \`orange_hf\`, unwind to \`orange_hf\`.
Reproduce: \`npx tsx scripts/rebalance_sim.ts\`.

## Result: ${pass ? "✅ PASS" : "❌ FAIL"}

| Metric | Value |
|--------|-------|
| Degenerate fixtures | ${degenerate.length} (${degenerate.filter((s) => s.valid).length} valid) |
| Random scenarios | ${scenarios.length} |
| Rebalance triggered (HF < orange_hf) | ${triggered.length} |
| Stayed healthy (no action) | ${all.length - triggered.length} |
| Restored to ≥ orange_hf (or full close) | ${triggered.filter((s) => s.restored).length}/${triggered.length} |
| Underwater (unwind cannot rescue, predicted revert) | ${all.filter((s) => s.unsalvageable).length} |
| Invariant violations | ${invalid.length} |
| Cooldown: rebalances fired | ${fires} |
| Cooldown: dips blocked by ${COOLDOWN_LEDGERS}-ledger limit | ${blocked} |
| Cooldown spacing ≥ ${COOLDOWN_LEDGERS} ledgers | ${cooldown.spacingOk ? "yes" : "NO"} |

## Degenerate coverage
${degenerate.map((s) => `- \`${s.id}\` — ${s.note}: ${s.valid ? "✅" : "❌"} (repay ${s.repay}, loops ${s.loops}, post-HF ${s.postHf ?? "∞"})`).join("\n")}

## Invariants checked per scenario
- repay ≥ 0 and ≤ debt (never over-repay; zero-equity clamps to a full close)
- layered execution never exceeds the debt; post-unwind supply > 0 unless fully closed
- when triggered, post-HF ≥ \`orange_hf\` (or full close / predicted underwater revert)
- minimality: one fewer unwind layer would NOT restore the target (no over-unwind)
- underwater positions (equity < 0) are only ever predicted as reverts, never rescues
- no action when HF ≥ \`orange_hf\` (contract no-op parity)

Full per-scenario rows: \`rebalance-sim-dataset.json\`.

> Parity chain: this harness mirrors \`compute_partial_unwind\` +
> \`submit_deleverage\` bit-for-bit in BigInt, and the contract test
> \`test_partial_unwind_dry_run_matches_onchain_within_rounding\` proves the same
> prediction model matches the **executed on-chain result** (real Blend pool,
> accrued rates) within a few stroops per layer. The on-testnet/mainnet live
> keeper runs remain the operational acceptance evidence.
`;
writeFileSync(resolve(OUT_DIR, "rebalance-sim-report.md"), report);

console.log(report);
console.log(`\nWrote docs/evidence/rebalance-sim-dataset.json (${all.length} scenarios)`);
if (!pass) process.exit(1);
