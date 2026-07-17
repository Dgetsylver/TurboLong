#!/usr/bin/env bash
#
# T2.3 — Auto-rebalance keeper: MAINNET live-rebalance acceptance.
#
# The "≥ 1 live mainnet rebalance during the tranche" criterion. This drives the
# production keeper (scripts/rebalance_keeper.ts) against mainnet, prints each
# vault's on-chain HF vs orange_hf, and — in --execute mode — signs the
# keeper-authorised rebalance_keeper on any vault in the orange zone, capturing
# before/after HF, loops unwound, the tx hash, and its Stellar Expert URL. It
# then writes a tranche-ready evidence doc.
#
# Usage:
#   scripts/demo_t3_mainnet.sh            # DRY-RUN probe (no key, no writes)
#   KEEPER_SECRET=S... scripts/demo_t3_mainnet.sh --execute   # live mainnet rebalance
#
# Vault source (first that is set wins):
#   VAULTS_JSON='[{"symbol":"USDC","strategyId":"C..."}]'      # explicit, or
#   deployed-vaults.mainnet.json  ({ "USDC": { "strategy": "C...", "token": "C..." } })
#
# Env:
#   KEEPER_SECRET  S... funded keeper key   (only for --execute)
#   RPC_URL        mainnet Soroban RPC       (optional; keeper has a default)
#   DEMO_NO_PAUSE  1 to skip the "press Enter" pauses

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

EXECUTE=0
[[ "${1:-}" == "--execute" ]] && EXECUTE=1

DEPLOYED_JSON="$ROOT_DIR/deployed-vaults.mainnet.json"
EVIDENCE_MD="$ROOT_DIR/docs/evidence/rebalance-mainnet-live.md"

# ── colours ───────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  CYAN="$(printf '\033[36m')"; GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"; MAGENTA="$(printf '\033[35m')"; RESET="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; CYAN=""; GREEN=""; YELLOW=""; RED=""; MAGENTA=""; RESET=""
fi
banner() { echo ""; echo "${CYAN}${BOLD}════════════════════════════════════════════════════════════════════${RESET}"; echo "${CYAN}${BOLD}  $*${RESET}"; echo "${CYAN}${BOLD}════════════════════════════════════════════════════════════════════${RESET}"; echo ""; }
step() { echo "${YELLOW}${BOLD}▶ $*${RESET}"; }
ok()   { echo "${GREEN}${BOLD}✓ $*${RESET}"; }
warn() { echo "${RED}${BOLD}! $*${RESET}"; }
pause() { [[ "${DEMO_NO_PAUSE:-0}" == "1" ]] && return 0; echo ""; echo "${DIM}  … press Enter to continue …${RESET}"; read -r _ || true; }

# ── resolve the mainnet vault list into VAULTS_JSON ───────────────────────────
if [[ -z "${VAULTS_JSON:-}" ]]; then
  if [[ -f "$DEPLOYED_JSON" ]]; then
    VAULTS_JSON="$(python3 - "$DEPLOYED_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
out = [{"symbol": s, "strategyId": v["strategy"]} for s, v in d.items() if v.get("strategy")]
print(json.dumps(out))
PY
)"
  fi
fi

banner "T2.3 — MAINNET auto-rebalance keeper (live acceptance)"
if [[ -z "${VAULTS_JSON:-}" || "$VAULTS_JSON" == "[]" ]]; then
  warn "No mainnet vaults found."
  echo ""
  echo "The mainnet vaults are not deployed/wired yet. Provide them one of two ways:"
  echo ""
  echo "  ${BOLD}A)${RESET} After deploy, ${DIM}deployed-vaults.mainnet.json${RESET} exists (written by"
  echo "     scripts/deploy_strategy_mainnet.ts) — just re-run this script."
  echo ""
  echo "  ${BOLD}B)${RESET} Pass them explicitly:"
  echo "     ${DIM}VAULTS_JSON='[{\"symbol\":\"USDC\",\"strategyId\":\"C...\"}]' scripts/demo_t3_mainnet.sh${RESET}"
  echo ""
  echo "See docs/mainnet-go-live-runbook.md §6 for the full go-live sequence."
  exit 2
fi

echo "Network:  ${BOLD}mainnet${RESET}"
echo "Mode:     ${BOLD}$( [[ $EXECUTE == 1 ]] && echo 'EXECUTE (signs rebalance_keeper)' || echo 'DRY-RUN (no key, no writes)' )${RESET}"
echo "Vaults:   $(echo "$VAULTS_JSON" | python3 -c 'import json,sys; print(", ".join(v["symbol"] for v in json.load(sys.stdin)))')"
if [[ $EXECUTE == 1 ]]; then
  echo "Keeper:   ${BOLD}rebalance_keeper${RESET} fires only when on-chain HF < on-chain orange_hf (60-ledger cooldown)"
fi
pause

# Isolate this run's evidence.
RUN_LOG="$ROOT_DIR/docs/evidence/rebalance-mainnet-$(date +%Y%m%d-%H%M%S).jsonl"
mkdir -p "$(dirname "$RUN_LOG")"

# ── run the keeper ────────────────────────────────────────────────────────────
if [[ $EXECUTE == 1 ]]; then
  if [[ -z "${KEEPER_SECRET:-}" ]]; then
    warn "--execute requires KEEPER_SECRET (the funded mainnet keeper key)."
    echo "Provide it via a secrets manager, e.g.:  ${DIM}op run -- env KEEPER_SECRET=... scripts/demo_t3_mainnet.sh --execute${RESET}"
    exit 1
  fi
  banner "Live keeper — reads mainnet state AND submits rebalance_keeper"
  step "NETWORK=mainnet npx tsx scripts/rebalance_keeper.ts --execute"
  echo ""
  NETWORK=mainnet VAULTS_JSON="$VAULTS_JSON" EVIDENCE_FILE="$RUN_LOG" \
    npx tsx scripts/rebalance_keeper.ts --execute
else
  banner "Live probe — reads mainnet state (no signing)"
  step "NETWORK=mainnet npx tsx scripts/rebalance_keeper.ts   (DRY-RUN)"
  echo "${DIM}  reads config()/health_factor()/position() and reports what it WOULD do${RESET}"
  echo ""
  NETWORK=mainnet VAULTS_JSON="$VAULTS_JSON" EVIDENCE_FILE="$RUN_LOG" \
    npx tsx scripts/rebalance_keeper.ts
fi

# ── parse + report ────────────────────────────────────────────────────────────
echo ""
step "Per-vault result (parsed from this run's evidence log)"
python3 - "$RUN_LOG" <<'PY'
import json, sys
try:
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except FileNotFoundError:
    rows = []
if not rows:
    print("  (no evidence rows written)")
for r in rows:
    vault = r.get("vault", "?"); action = r.get("action", "?")
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
            print(f"      TX: https://stellar.expert/explorer/public/tx/{tx}")
PY

# ── write the tranche acceptance doc when a live rebalance happened ────────────
if [[ $EXECUTE == 1 ]]; then
  echo ""
  step "Writing tranche acceptance evidence -> ${EVIDENCE_MD#$ROOT_DIR/}"
  python3 - "$RUN_LOG" "$EVIDENCE_MD" <<'PY'
import json, sys, datetime
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
reb = [r for r in rows if r.get("action") == "rebalance"]
md = []
md.append("# T2.3 Acceptance — Live Mainnet Rebalance\n")
md.append(f"Generated: {datetime.datetime.utcnow().isoformat()}Z\n")
md.append("Produced by `scripts/demo_t3_mainnet.sh --execute`, driving the production "
          "keeper `scripts/rebalance_keeper.ts` against mainnet. Each row is the "
          "keeper-authorised, rate-limited `rebalance_keeper` call firing when the "
          "on-chain HF dropped below the on-chain `orange_hf`.\n")
if not reb:
    md.append("## Result: no rebalance fired this run\n")
    md.append("All mainnet vaults were healthy (HF ≥ orange_hf) or had no debt, so the "
              "keeper correctly took no action. Re-run when a vault is in the orange zone "
              "to capture the live rebalance.\n")
    md.append("### Probe rows\n")
    md.append("| Vault | HF | orange_hf | Action |\n|---|---|---|---|")
    for r in rows:
        hf = r.get("hf"); orange = r.get("orange_hf")
        hf_s = "inf" if (hf is not None and hf > 1e15) else (f"{hf:.4f}" if hf is not None else "—")
        md.append(f"| {r.get('vault')} | {hf_s} | {orange} | {r.get('action')}/{r.get('reason','')} |")
else:
    md.append("## Result: ✅ live mainnet rebalance(s) captured\n")
    md.append("| Vault | Before HF | After HF | Loops | Status | Transaction |\n|---|---|---|---|---|---|")
    for r in reb:
        tx = r.get("tx") or ""
        url = f"[{tx[:8]}…](https://stellar.expert/explorer/public/tx/{tx})" if tx else "—"
        md.append(f"| {r.get('vault')} | {r.get('before_hf')} | {r.get('after_hf')} | "
                  f"{r.get('loops_unwound')} | {r.get('status')} | {url} |")
    md.append("\n## What this proves")
    md.append("- **Keeper role authenticated**: only the keeper account can sign "
              "`rebalance_keeper` (contract gates on `require_auth` + `NotAuthorized`).")
    md.append("- **Event emitted**: each successful rebalance emits `rebalance(before_hf, "
              "after_hf, loops)` on-chain (see the tx above on Stellar Expert → Events).")
    md.append("- **Live mainnet rebalance during tranche**: the transactions above are the "
              "on-chain acceptance artifact.")
md.append("\n---\n*Full JSONL evidence appended to `docs/evidence/rebalance-keeper-log.jsonl` "
          "by the production keeper on every run.*")
open(sys.argv[2], "w").write("\n".join(md) + "\n")
print("  wrote", sys.argv[2])
PY
fi

# ── summary ───────────────────────────────────────────────────────────────────
banner "Summary"
if [[ $EXECUTE == 1 ]]; then
  HAD_REB="$(python3 -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if l.strip() and json.loads(l).get("action")=="rebalance"))' "$RUN_LOG" 2>/dev/null || echo 0)"
  if [[ "$HAD_REB" != "0" ]]; then
    ok "Live mainnet rebalance captured — see the TX URL(s) above and ${EVIDENCE_MD#$ROOT_DIR/}"
  else
    echo "  ${MAGENTA}No vault was in the orange zone, so no rebalance fired (keeper correctly idle).${RESET}"
    echo "  Re-run when a mainnet vault's HF drops below orange_hf to capture the live tx."
  fi
else
  echo "  Probe complete. To capture the live mainnet rebalance + tx URL:"
  echo "     ${DIM}KEEPER_SECRET=S... scripts/demo_t3_mainnet.sh --execute${RESET}"
fi
echo ""
echo "${DIM}  this run's JSONL: ${RUN_LOG#$ROOT_DIR/}${RESET}"
echo ""
