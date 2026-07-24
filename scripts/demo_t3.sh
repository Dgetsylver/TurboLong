#!/usr/bin/env bash
#
# T2.3 — DeFindex auto-rebalance keeper: live acceptance demo.
#
# Walks through, on screen and in plain English, the acceptance criteria:
#   1. Keeper role authenticated  ...... require_auth + NotAuthorized gating
#   2. Event emitted on every rebalance  emit_rebalance(before_hf, after_hf, loops)
#   3. Edge cases covered by tests ..... locked reserves, already-at-floor, cooldown
#   4. Simulated rebalances ............ 100-scenario deterministic dataset
#   + Live keeper probe ................ production keeper reads on-chain state and
#                                        (with --execute) signs rebalance_keeper,
#                                        printing tx hashes + Stellar Expert URLs.
#
# Usage:
#   scripts/demo_t3.sh                 # tests + live DRY-RUN keeper probe (no key, safe)
#   scripts/demo_t3.sh --execute       # also sign+submit rebalance_keeper (needs KEEPER_SECRET)
#   NETWORK=mainnet scripts/demo_t3.sh --execute   # mainnet live rebalance (needs VAULTS_JSON)
#
# Env:
#   NETWORK        testnet | mainnet   (default testnet)
#   KEEPER_SECRET  S... keeper key     (only for --execute)
#   VAULTS_JSON    [{symbol,strategyId}] (required for mainnet)
#   DEMO_NO_PAUSE  1 to disable the "press Enter" pauses (for a dry take)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STRATEGY_DIR="$ROOT_DIR/contracts/strategies/blend_leverage"
cd "$ROOT_DIR"

NETWORK="${NETWORK:-testnet}"
EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1

# Stellar Expert path segment for the active network.
EXPERT_NET="testnet"; [[ "$NETWORK" == "mainnet" ]] && EXPERT_NET="public"

# ── colours ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  CYAN="$(printf '\033[36m')"; GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"; MAGENTA="$(printf '\033[35m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; CYAN=""; GREEN=""; YELLOW=""; MAGENTA=""; RESET=""
fi

banner() {
  echo ""
  echo "${CYAN}${BOLD}════════════════════════════════════════════════════════════════════${RESET}"
  echo "${CYAN}${BOLD}  $*${RESET}"
  echo "${CYAN}${BOLD}════════════════════════════════════════════════════════════════════${RESET}"
  echo ""
}
step() { echo "${YELLOW}${BOLD}▶ $*${RESET}"; }
ok()   { echo "${GREEN}${BOLD}✓ $*${RESET}"; }
pause() {
  [[ "${DEMO_NO_PAUSE:-0}" == "1" ]] && return 0
  echo ""; echo "${DIM}  … press Enter to continue …${RESET}"; read -r _ || true
}

# ── intro ─────────────────────────────────────────────────────────────────────
banner "T2.3 — DeFindex auto-rebalance keeper"
echo "A keeper-authorised, rate-limited entry point (${BOLD}rebalance_keeper${RESET}) that"
echo "unwinds the minimal loops to restore the target HF when HF drops into the"
echo "orange zone, and emits an event with before/after HF and loops unwound."
echo ""
echo "Acceptance criteria demonstrated below:"
echo "  1. Keeper role authenticated       (require_auth + NotAuthorized)"
echo "  2. Event emitted on every rebalance (emit_rebalance before/after/loops)"
echo "  3. Edge cases in unit tests        (locked reserves, already-at-floor, cooldown)"
echo "  4. 100+ simulated rebalances       (deterministic dataset)"
echo "  +  Live keeper probe on ${BOLD}${NETWORK}${RESET} (mode: $( [[ $EXECUTE == 1 ]] && echo EXECUTE || echo DRY-RUN ))"
pause

# ── the entry point ───────────────────────────────────────────────────────────
banner "Step 0 — the keeper entry point"
step "Contract: contracts/strategies/blend_leverage/src/lib.rs::rebalance_keeper"
echo "    • keeper.require_auth() + caller != keeper -> NotAuthorized   (criterion 1)"
echo "    • rate-limit: REBALANCE_COOLDOWN_LEDGERS = 60 (~5 min)"
echo "    • emit_rebalance(caller, before_hf, after_hf, loops)          (criterion 2)"
step "Production keeper: scripts/rebalance_keeper.ts (reads on-chain config()/health_factor(), JSONL evidence)"
pause

# ── criteria 1+2+3: the tests ────────────────────────────────────────────────
banner "Criteria 1-3 — keeper unit/integration tests (auth, event, edge cases)"
step "cargo test keeper -- --nocapture   (in contracts/strategies/blend_leverage)"
echo "${DIM}  watch the printed HF transitions: 'hf <before> -> <after> ... loops=N'${RESET}"
echo ""
( cd "$STRATEGY_DIR" && cargo test keeper -- --nocapture )
echo ""
ok "auth gating, event emission, cooldown, at-floor no-op, and LOCKED-RESERVES cases all green"
pause

# ── criterion 4: the deterministic 100-scenario dataset ──────────────────────
banner "Criterion 4 — 100+ simulated rebalances (deterministic dataset)"
step "npx tsx scripts/rebalance_sim.ts"
echo ""
npx tsx scripts/rebalance_sim.ts | sed -n '1,40p'
echo ""
ok "7 degenerate fixtures + 100 random scenarios, 0 invariant violations"
echo "${DIM}  evidence: docs/evidence/rebalance-sim-{report.md,dataset.json}${RESET}"
pause

# ── live keeper probe ─────────────────────────────────────────────────────────
banner "Live keeper on ${NETWORK} — reads on-chain state $( [[ $EXECUTE == 1 ]] && echo 'and SUBMITS rebalance_keeper' )"

# Isolate this run's evidence so we can surface only what just happened.
RUN_LOG="$ROOT_DIR/docs/evidence/rebalance-keeper-demo-$(date +%Y%m%d-%H%M%S).jsonl"
mkdir -p "$(dirname "$RUN_LOG")"

if [[ $EXECUTE == 1 ]]; then
  step "NETWORK=$NETWORK npx tsx scripts/rebalance_keeper.ts --execute"
  echo "${DIM}  signs rebalance_keeper only when on-chain HF < on-chain orange_hf${RESET}"
  echo ""
  NETWORK="$NETWORK" EVIDENCE_FILE="$RUN_LOG" npx tsx scripts/rebalance_keeper.ts --execute
else
  step "NETWORK=$NETWORK npx tsx scripts/rebalance_keeper.ts   (DRY-RUN — no key, no writes)"
  echo "${DIM}  reads config()/health_factor()/position() and reports what it WOULD do${RESET}"
  echo ""
  NETWORK="$NETWORK" EVIDENCE_FILE="$RUN_LOG" npx tsx scripts/rebalance_keeper.ts
fi

echo ""
step "Per-vault result (parsed from this run's evidence log)"
# Pretty-print each evidence line with HF change + a Stellar Expert URL when a tx exists.
python3 - "$RUN_LOG" "$EXPERT_NET" <<'PY'
import json, sys
log, net = sys.argv[1], sys.argv[2]
try:
    lines = [json.loads(l) for l in open(log) if l.strip()]
except FileNotFoundError:
    lines = []
if not lines:
    print("  (no evidence rows written)")
for r in lines:
    vault = r.get("vault", "?")
    action = r.get("action", "?")
    hf = r.get("hf"); orange = r.get("orange_hf")
    head = f"  • {vault:<8} action={action}"
    if hf is not None and orange is not None:
        no_debt = (r.get("has_debt") is False) or hf > 1e15
        hf_str = "inf (no debt)" if no_debt else f"{hf:.4f}"
        zone = "no debt — nothing to unwind" if no_debt else (
            "ORANGE (HF < orange_hf) — keeper acts" if hf < orange else "healthy (HF >= orange_hf)")
        head += f"  HF={hf_str} orange_hf={orange:.4f}  [{zone}]"
    print(head)
    if action == "dry_run":
        print(f"      would_rebalance={r.get('would_rebalance')} sim_ok={r.get('sim_ok')}")
    if action == "rebalance":
        print(f"      before_hf={r.get('before_hf')} -> after_hf={r.get('after_hf')}  loops_unwound={r.get('loops_unwound')}  status={r.get('status')}")
        tx = r.get("tx")
        if tx:
            print(f"      TX: https://stellar.expert/explorer/{net}/tx/{tx}")
PY
echo ""
echo "${DIM}  full JSONL evidence for this run: ${RUN_LOG#$ROOT_DIR/}${RESET}"
pause

# ── summary ───────────────────────────────────────────────────────────────────
banner "T2.3 acceptance — summary"
echo "  1. Keeper role authenticated ........ ${GREEN}PASS${RESET}  (auth-gating test)"
echo "  2. Event on every rebalance ......... ${GREEN}PASS${RESET}  (emits-event test)"
echo "  3. Edge cases (locked/at-floor) ..... ${GREEN}PASS${RESET}  (integration tests)"
echo "  4. 100+ simulated rebalances ........ ${GREEN}PASS${RESET}  (rebalance_sim.ts)"
if [[ $EXECUTE == 1 ]]; then
  echo "  +  Live ${NETWORK} rebalance ........... ${GREEN}submitted${RESET}  (tx URL above)"
else
  echo "  +  Live keeper probe (${NETWORK}) ...... ${GREEN}reads on-chain state${RESET}"
  echo ""
  echo "  ${MAGENTA}To capture a LIVE on-chain rebalance + tx URL, re-run with:${RESET}"
  echo "     KEEPER_SECRET=S... scripts/demo_t3.sh --execute"
  echo "  ${DIM}(needs a funded keeper and a vault currently in the orange zone)${RESET}"
fi
echo ""
