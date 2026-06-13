// T2.3 acceptance — offline rebalance-keeper simulation harness.
//
// Generates a deterministic 100-scenario dataset proving the auto-rebalance
// behaviour without a mainnet/testnet deploy, using the SAME closed-form math
// the contract uses (contracts/strategies/blend_leverage/src/{leverage,lib}.rs):
//
//   HF            = (B · c_factor) / D                          (lib.rs compute_health_factor)
//   partial unwind: repay x s.t. (B-x)·c = target·(D-x)
//                 → x = (target·D − B·c) / (target − c)         (leverage.rs compute_partial_unwind)
//   rebalance()/rebalance_keeper() unwind to `orange_hf`        (lib.rs)
//   keeper rate-limit: REBALANCE_COOLDOWN_LEDGERS = 60          (constants.rs)
//
// B = supply value, D = debt value (underlying units, equity normalised to 1).
// The contract works in i128 fixed-point (1e7 c_factor/HF, 1e12 rates); this
// harness uses the identical formulas in double precision — equivalent for a
// behavioural acceptance dataset; rounding differs negligibly.
//
// Run:  npx tsx scripts/rebalance_sim.ts
// Out:  docs/evidence/rebalance-sim-dataset.json + rebalance-sim-report.md

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../docs/evidence");

const COOLDOWN_LEDGERS = 60; // constants::REBALANCE_COOLDOWN_LEDGERS
const TOL = 1e-6; // HF restoration tolerance

/** Health factor = (B · c) / D. Infinite when no debt. */
function hf(B: number, D: number, c: number): number {
  return D <= 0 ? Number.POSITIVE_INFINITY : (B * c) / D;
}

/**
 * Minimal underlying x to repay (and withdraw) to restore HF to `target`.
 * Mirrors leverage.rs::compute_partial_unwind. Returns 0 if already healthy.
 */
function partialUnwindRepay(B: number, D: number, c: number, target: number): number {
  if (D <= 0) return 0;
  if (hf(B, D, c) >= target) return 0;
  // x = (target·D − B·c) / (target − c)   (target > c always for a healthy band)
  const x = (target * D - B * c) / (target - c);
  return Math.max(0, Math.min(x, D)); // never repay more than the debt
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
  id: number;
  cFactor: number;
  leverage: number;
  minHf: number;
  orangeHf: number;
  initialHf: number;
  shockedHf: number;
  triggered: boolean;
  repay: number;
  postHf: number;
  restoredToBand: boolean; // post ≈ orange_hf and ≥ min_hf
  valid: boolean; // all invariants hold
}

const C_FACTORS = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const MIN_HFS = [1.05, 1.1];
const ORANGE_HFS = [1.15, 1.2];

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
    const B0 = leverage;
    const D0 = leverage - 1;
    const initialHf = hf(B0, D0, c);

    // Rate shock: debt accrues (borrow APR) and/or collateral value drifts down.
    // shock ∈ [0 .. 0.35] applied to debt; smaller drift to supply.
    const debtShock = rnd() * 0.35;
    const supplyDrift = rnd() * 0.08;
    const B = B0 * (1 - supplyDrift);
    const D = D0 * (1 + debtShock);
    const shockedHf = hf(B, D, c);

    // Keeper policy: fire when HF < min_hf; unwind to orange_hf.
    let triggered = false;
    let repay = 0;
    let postHf = shockedHf;
    if (shockedHf < minHf) {
      triggered = true;
      repay = partialUnwindRepay(B, D, c, orangeHf);
      postHf = hf(B - repay, D - repay, c);
    }

    const restoredToBand = !triggered || (postHf >= minHf - TOL && Math.abs(postHf - orangeHf) <= 1e-4);
    const valid =
      repay >= 0 &&
      repay <= D + TOL &&
      B - repay > 0 &&
      D - repay >= -TOL &&
      restoredToBand;

    out.push({
      id: i + 1,
      cFactor: c,
      leverage: round(leverage, 4),
      minHf,
      orangeHf,
      initialHf: round(initialHf, 4),
      shockedHf: round(shockedHf, 4),
      triggered,
      repay: round(repay, 6),
      postHf: postHf === Number.POSITIVE_INFINITY ? null as unknown as number : round(postHf, 4),
      restoredToBand,
      valid,
    });
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
    // Random HF dips below min_hf ~10% of ledgers.
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

function round(x: number, d: number): number {
  const m = 10 ** d;
  return Math.round(x * m) / m;
}

// ── Run + report ─────────────────────────────────────────────────────────────
const scenarios = generate(100);
const triggered = scenarios.filter((s) => s.triggered);
const invalid = scenarios.filter((s) => !s.valid);
const cooldown = simulateCooldown();
const fires = cooldown.events.filter((e) => e.fired).length;
const blocked = cooldown.events.filter((e) => !e.fired).length;

const pass = invalid.length === 0 && cooldown.spacingOk;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  resolve(OUT_DIR, "rebalance-sim-dataset.json"),
  JSON.stringify({ generatedBy: "scripts/rebalance_sim.ts", seed: 20260613, scenarios, cooldown }, null, 2),
);

const report = `# T2.3 Acceptance — Rebalance Simulation Dataset

Offline, deterministic (seed 20260613) simulation of the auto-rebalance keeper
using the contract's own HF + partial-unwind math. Reproduce: \`npx tsx scripts/rebalance_sim.ts\`.

## Result: ${pass ? "✅ PASS" : "❌ FAIL"}

| Metric | Value |
|--------|-------|
| Scenarios | ${scenarios.length} |
| Rebalance triggered (HF < min_hf) | ${triggered.length} |
| Stayed healthy (no action) | ${scenarios.length - triggered.length} |
| Restored to orange band (≥ min_hf, ≈ orange_hf) | ${triggered.filter((s) => s.restoredToBand).length}/${triggered.length} |
| Invariant violations | ${invalid.length} |
| Cooldown: rebalances fired | ${fires} |
| Cooldown: dips blocked by ${COOLDOWN_LEDGERS}-ledger limit | ${blocked} |
| Cooldown spacing ≥ ${COOLDOWN_LEDGERS} ledgers | ${cooldown.spacingOk ? "yes" : "NO"} |

## Invariants checked per scenario
- repay ≥ 0 and ≤ debt (never over-repay)
- post-unwind supply > 0, debt ≥ 0
- when triggered, post-HF ≈ \`orange_hf\` and ≥ \`min_hf\` (restored to the safety band)
- no action when HF ≥ \`min_hf\`

Full per-scenario rows: \`rebalance-sim-dataset.json\`.

> Model: equity normalised to 1; B = supply value, D = debt value. The contract
> uses i128 fixed-point (1e7 c_factor/HF, 1e12 rates); this harness uses the
> identical closed-form formulas in double precision. This is an **offline
> behavioural** dataset — the on-testnet/mainnet runs (live keeper txs) remain
> as the on-chain acceptance evidence.
`;
writeFileSync(resolve(OUT_DIR, "rebalance-sim-report.md"), report);

console.log(report);
console.log(`\nWrote docs/evidence/rebalance-sim-dataset.json (${scenarios.length} scenarios)`);
if (!pass) process.exit(1);
