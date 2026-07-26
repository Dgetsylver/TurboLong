#!/usr/bin/env bash
#
# T2.2 / T2.3 — Partial-unwind liquidation protection: live acceptance demo.
#
# Runs, on screen, the two proofs that map 1:1 to the completion criteria:
#   1. Algorithm verified against a fixture set covering all degenerate cases
#      -> scripts/rebalance_sim.ts (7 degenerate fixtures + 100 random scenarios)
#   2. Dry-run simulation matches the on-chain result within rounding
#      -> contract test test_partial_unwind_dry_run_matches_onchain_within_rounding
#
# Usage:
#   scripts/demo_t2.sh          # sim + parity test (fast, ~1 min after warm build)
#   scripts/demo_t2.sh --full   # also run the full contract test suite
#
# Designed to be screen-recorded: each step prints a clear banner and pauses
# briefly so the viewer can read it. Set DEMO_NO_PAUSE=1 to disable pauses.

set -euo pipefail

# ── locate repo root (this script lives in <root>/scripts) ───────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STRATEGY_DIR="$ROOT_DIR/contracts/strategies/blend_leverage"
cd "$ROOT_DIR"

RUN_FULL=0
[[ "${1:-}" == "--full" ]] && RUN_FULL=1

# ── colours (fall back to plain text if not a tty) ───────────────────────────
if [[ -t 1 ]]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  CYAN="$(printf '\033[36m')"; GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; CYAN=""; GREEN=""; YELLOW=""; RESET=""
fi

banner() {
  echo ""
  echo "${CYAN}${BOLD}════════════════════════════════════════════════════════════════════${RESET}"
  echo "${CYAN}${BOLD}  $*${RESET}"
  echo "${CYAN}${BOLD}════════════════════════════════════════════════════════════════════${RESET}"
  echo ""
}

step() { echo "${YELLOW}${BOLD}▶ $*${RESET}"; }

pause() {
  [[ "${DEMO_NO_PAUSE:-0}" == "1" ]] && return 0
  echo ""
  echo "${DIM}  … press Enter to continue …${RESET}"
  read -r _ || true
}

# ── intro ────────────────────────────────────────────────────────────────────
banner "T2 — DeFindex partial-unwind liquidation protection"
echo "When the Health Factor drops into the configurable ${BOLD}orange zone${RESET}"
echo "(Config.orange_hf), the keeper unwinds ${BOLD}just enough loops${RESET} to restore"
echo "the target HF — never a full close. Minimises user cost & pool impact."
echo ""
echo "Completion is proven by two things, shown live below:"
echo "  1. algorithm verified against a degenerate-case fixture set"
echo "  2. dry-run prediction matches the on-chain result within rounding"
pause

# ── the code under test ───────────────────────────────────────────────────────
banner "Step 0 — the algorithm & the configurable threshold"
step "Closed-form minimal unwind: contracts/strategies/blend_leverage/src/leverage.rs::compute_partial_unwind"
step "Orange-zone threshold config: contracts/strategies/blend_leverage/src/storage.rs (Config.min_hf / Config.orange_hf)"
step "Trigger policy (fire when HF < orange_hf, unwind to orange_hf): src/lib.rs::rebalance / rebalance_keeper / partial_unwind"
pause

# ── proof 1: degenerate fixture set ───────────────────────────────────────────
banner "Proof 1/2 — algorithm vs degenerate-case fixture set (offline, deterministic)"
step "npx tsx scripts/rebalance_sim.ts"
echo "${DIM}  i128-faithful BigInt mirror of the contract math; seed 20260613${RESET}"
echo ""
npx tsx scripts/rebalance_sim.ts
echo ""
echo "${GREEN}${BOLD}✓ 7 degenerate fixtures (D1..D7) + 100 random scenarios, 0 invariant violations${RESET}"
echo "${DIM}  evidence written to docs/evidence/rebalance-sim-{report.md,dataset.json}${RESET}"
pause

# ── proof 2: dry-run == on-chain within rounding ──────────────────────────────
banner "Proof 2/2 — dry-run prediction == executed on-chain result (within rounding)"
step "cargo test test_partial_unwind_dry_run_matches_onchain_within_rounding -- --nocapture"
echo "${DIM}  runs the real Blend pool with accrued rates; compares predicted vs actual${RESET}"
echo ""
( cd "$STRATEGY_DIR" && cargo test test_partial_unwind_dry_run_matches_onchain_within_rounding -- --nocapture )
echo ""
echo "${GREEN}${BOLD}✓ pred_supply == actual_supply, pred_hf == after_hf, debt within a few stroops${RESET}"
pause

# ── optional: full contract suite ─────────────────────────────────────────────
if [[ "$RUN_FULL" == "1" ]]; then
  banner "Bonus — full contract test suite (partial-unwind + keeper integration)"
  step "cargo test  (in $STRATEGY_DIR)"
  echo ""
  ( cd "$STRATEGY_DIR" && cargo test )
  echo ""
  echo "${GREEN}${BOLD}✓ full suite green${RESET}"
  pause
fi

# ── outro ─────────────────────────────────────────────────────────────────────
banner "Done — T2 partial-unwind liquidation protection: acceptance demonstrated"
echo "  • Degenerate fixture set .......... ${GREEN}PASS${RESET}  (scripts/rebalance_sim.ts)"
echo "  • Dry-run == on-chain (rounding) .. ${GREEN}PASS${RESET}  (contract parity test)"
echo ""
echo "Evidence files:"
echo "  - docs/evidence/rebalance-sim-report.md"
echo "  - docs/evidence/rebalance-sim-dataset.json"
echo ""
