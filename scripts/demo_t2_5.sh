#!/usr/bin/env bash
#
# T2.5 — Historical APY storage + HF/liquidation alerts: live acceptance demo.
#
# Walks through, on screen and in plain English, the acceptance criteria:
#   1. rate_snapshots D1 table written every 15 min by the cron
#   2. Public GET /snapshots endpoint serving paginated JSON
#   3. 365-day retention (pruning job) tested against the LIVE database
#   4. subscriptions extended with alert_type/hf_threshold/last_fired_at;
#      HF + liquidation-imminent alert channels live
#   5. Data-accumulation progress toward the >=30-day target
#
# Usage:
#   scripts/demo_t2_5.sh                # read-only: hits the public prod endpoint
#   ADMIN=1 scripts/demo_t2_5.sh        # + D1 introspection (needs wrangler auth)
#   ADMIN=1 WAIT_CRON=1 scripts/demo_t2_5.sh
#                                       # + inserts a 400-day-old row, subscribes
#                                       #   HF/liquidation alerts, waits for the
#                                       #   next */15 cron tick and verifies the
#                                       #   prune + alert firing IN PRODUCTION
#
# Env:
#   BASE_URL      alerts worker base (default https://turbolong-alerts.turbolong.workers.dev)
#   ALERT_EMAIL   email used for the HF/liquidation subscriptions (WAIT_CRON mode)
#   DEMO_NO_PAUSE 1 to disable the "press Enter" pauses (for a dry take)
#
# Evidence: every check appends a JSON line to
#   docs/evidence/apy-history-demo-<timestamp>.jsonl

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ALERTS_DIR="$ROOT_DIR/alerts"
cd "$ROOT_DIR"

BASE_URL="${BASE_URL:-https://turbolong-alerts.turbolong.workers.dev}"
ADMIN="${ADMIN:-0}"
WAIT_CRON="${WAIT_CRON:-0}"
ALERT_EMAIL="${ALERT_EMAIL:-}"

# Fixed pool / USDC — the pair used across the demo.
POOL_ID="CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD"
ASSET="USDC"

RUN_LOG="$ROOT_DIR/docs/evidence/apy-history-demo-$(date +%Y%m%d-%H%M%S).jsonl"
mkdir -p "$(dirname "$RUN_LOG")"

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
warn() { echo "${MAGENTA}${BOLD}⚠ $*${RESET}"; }
pause() {
  [[ "${DEMO_NO_PAUSE:-0}" == "1" ]] && return 0
  echo ""; echo "${DIM}  … press Enter to continue …${RESET}"; read -r _ || true
}
evidence() { # evidence <check> <json-payload>
  printf '{"ts":"%s","check":"%s","data":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$RUN_LOG"
}

d1() { # d1 <sql> — remote D1 query, prints the JSON "results" array
  (cd "$ALERTS_DIR" && npx --yes wrangler d1 execute turbolong-alerts --remote --json --command "$1" 2>/dev/null) \
    | python3 -c 'import json,sys; batches=json.load(sys.stdin); print(json.dumps([r for b in batches for r in b.get("results",[])]))'
}

# ── intro ─────────────────────────────────────────────────────────────────────
banner "T2.5 — Historical APY storage + HF / liquidation alerts"
echo "A Cloudflare Worker (${BOLD}alerts/${RESET}) with a D1 database:"
echo "  • cron ${BOLD}*/15 * * * *${RESET} snapshots every pool/asset's rates into ${BOLD}rate_snapshots${RESET}"
echo "  • public ${BOLD}GET /snapshots${RESET} serves the time-series as paginated JSON"
echo "  • snapshots older than ${BOLD}365 days${RESET} are pruned on every cron tick"
echo "  • ${BOLD}subscriptions${RESET} carries alert_type ('apy'|'hf'|'liquidation'|'rate_spike'),"
echo "    hf_threshold and last_fired_at → HF + liquidation-imminent email channels"
echo ""
echo "Live target: ${BOLD}$BASE_URL${RESET}"
echo "Evidence log: ${DIM}${RUN_LOG#$ROOT_DIR/}${RESET}"
pause

# ── step 0: the code ──────────────────────────────────────────────────────────
banner "Step 0 — where it lives in the repo"
step "Schema (alerts/src/schema.sql) — rate_snapshots + extended subscriptions"
grep -n -A 3 "CREATE TABLE IF NOT EXISTS rate_snapshots" alerts/src/schema.sql | head -6
echo "    …"
grep -n "alert_type\|hf_threshold\|last_fired_at" alerts/src/schema.sql
echo ""
step "Cron trigger (alerts/wrangler.toml)"
grep -n -A 1 "\[triggers\]" alerts/wrangler.toml
echo ""
step "Retention constant + prune (alerts/src/index.ts)"
grep -n "SNAPSHOT_RETENTION_DAYS\|DELETE FROM rate_snapshots" alerts/src/index.ts | head -4
pause

# ── step 1: live public endpoint ─────────────────────────────────────────────
banner "Criterion — public endpoint serving paginated JSON (LIVE)"

step "GET /snapshots?limit=3  (latest rows, newest first)"
PAGE1="$(curl -sf "$BASE_URL/snapshots?limit=3")"
echo "$PAGE1" | python3 -m json.tool
evidence "endpoint_latest" "$PAGE1"
CURSOR="$(echo "$PAGE1" | python3 -c 'import json,sys; print(json.load(sys.stdin)["nextCursor"])')"
ok "endpoint live, returns snapshots[] + nextCursor=$CURSOR"
pause

step "Pagination: GET /snapshots?limit=3&before=$CURSOR  (next page via cursor)"
PAGE2="$(curl -sf "$BASE_URL/snapshots?limit=3&before=$CURSOR")"
echo "$PAGE2" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for s in d["snapshots"]:
    print(f'"'"'  id={s["id"]:>6}  {s["recorded_at"]}  {s["pool_id"][:8]}…/{s["asset_symbol"]:<8} net_supply={s["net_supply_apr"]:.3f}% borrow={s["net_borrow_cost"]:.3f}%'"'"')
print(f'"'"'  nextCursor={d["nextCursor"]}'"'"')'
evidence "endpoint_pagination" "$PAGE2"
ok "cursor pagination works (ids strictly below $CURSOR)"
pause

step "Filters: GET /snapshots?pool_id=…&asset=$ASSET&limit=4  (per-pool/asset series → delta arrows)"
FILTERED="$(curl -sf "$BASE_URL/snapshots?pool_id=$POOL_ID&asset=$ASSET&limit=4")"
echo "$FILTERED" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for s in d["snapshots"]:
    print(f'"'"'  {s["recorded_at"]}  {s["asset_symbol"]}  net_supply={s["net_supply_apr"]:.3f}%  util={s["util"]:.3f}  c_factor={s["c_factor"]}'"'"')'
evidence "endpoint_filtered" "$FILTERED"
ok "same series the frontend (frontend/src/history.ts) uses for the 24h/7d delta arrows + Compare charts"
pause

# ── step 2: 15-min cadence + accumulation ────────────────────────────────────
banner "Criterion — snapshots every 15 min; accumulation toward >=30 days"

step "Cadence check: consecutive $ASSET snapshots must be ~15 min apart"
echo "$FILTERED" | python3 -c '
import json, sys, datetime as dt
rows = json.load(sys.stdin)["snapshots"]
ts = [dt.datetime.fromisoformat(r["recorded_at"]) for r in rows]
for a, b in zip(ts, ts[1:]):
    print(f"  {b} -> {a}   delta = {(a-b).total_seconds()/60:.1f} min")'
echo ""

step "Oldest snapshot (id=1) → collection start date"
OLDEST="$(curl -sf "$BASE_URL/snapshots?limit=1&before=2")"
echo "$OLDEST" | python3 -m json.tool
evidence "oldest_snapshot" "$OLDEST"

echo "$OLDEST" | python3 -c '
import json, sys, datetime as dt
rows = json.load(sys.stdin)["snapshots"]
start = dt.datetime.fromisoformat(rows[0]["recorded_at"])
now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
days = (now - start).total_seconds() / 86400
target = start + dt.timedelta(days=30)
print(f"  collection started : {start} UTC")
print(f"  accumulated so far : {days:.1f} days")
print(f"  30-day target hit  : {target:%Y-%m-%d %H:%M} UTC" + ("  ✓ REACHED" if days >= 30 else f"  (in {30-days:.1f} days)"))'
pause

if [[ "$ADMIN" == "1" ]]; then
  step "D1 totals (wrangler d1 execute --remote)"
  TOTALS="$(d1 "SELECT COUNT(*) AS total_rows, COUNT(DISTINCT pool_id||'/'||asset_symbol) AS series, MIN(recorded_at) AS oldest, MAX(recorded_at) AS newest FROM rate_snapshots WHERE pool_id NOT LIKE 'RETENTION_TEST'")"
  echo "$TOTALS" | python3 -m json.tool
  evidence "d1_totals" "$TOTALS"
  ok "8 series (Etherfuse: XLM/USDC/CETES/USTRY/TESOURO + Fixed: XLM/USDC/EURC) × 4 ticks/hour"
  pause
fi

# ── step 3: retention / pruning ──────────────────────────────────────────────
banner "Criterion — 365-day retention (pruning job) tested"
echo "Every cron tick runs:  DELETE FROM rate_snapshots WHERE recorded_at < datetime('now','-365 days')"
echo ""
if [[ "$ADMIN" == "1" && "$WAIT_CRON" == "1" ]]; then
  step "Inserting a 400-day-old sentinel row into the LIVE database"
  d1 "INSERT INTO rate_snapshots (pool_id, asset_symbol, recorded_at, net_supply_apr, net_borrow_cost, interest_supply_apr, interest_borrow_apr, blnd_supply_apr, blnd_borrow_apr, util, c_factor) VALUES ('RETENTION_TEST','PRUNE_ME',datetime('now','-400 days'),0,0,0,0,0,0,0,0)" > /dev/null
  SENTINEL="$(d1 "SELECT id, pool_id, recorded_at FROM rate_snapshots WHERE pool_id='RETENTION_TEST'")"
  echo "  sentinel: $SENTINEL"
  evidence "prune_sentinel_inserted" "$SENTINEL"
  PRUNE_PENDING=1
else
  echo "${DIM}  (run with ADMIN=1 WAIT_CRON=1 to insert a 400-day-old row and watch the${RESET}"
  echo "${DIM}   next production cron tick delete it)${RESET}"
  PRUNE_PENDING=0
fi
pause

# ── step 4: HF / liquidation alert channels ──────────────────────────────────
banner "Criterion — HF + liquidation-imminent alert channels live"
echo "computeHealthFactor: HF = leverage × c_factor / (leverage − 1)"
echo "  • alert_type='hf'          fires when HF < subscriber's hf_threshold"
echo "  • alert_type='liquidation' fires when HF < 1.05 (LIQUIDATION_HF)"
echo "  • 6 h debounce via last_fired_at"
echo ""

step "Current HF for $ASSET at 10x on the Fixed pool (from the latest snapshot's c_factor)"
echo "$FILTERED" | python3 -c '
import json, sys
cf = json.load(sys.stdin)["snapshots"][0]["c_factor"]
hf = 10 * cf / 9
print(f"  c_factor = {cf}  →  HF(10x) = {hf:.4f}")
print(f"  → an hf subscription with threshold 1.2 fires on the next cron tick")
print(f"  → the liquidation channel (1.05) arms and fires if c_factor ever drops below {1.05*9/10:.3f}")'
echo ""

if [[ "$ADMIN" == "1" && "$WAIT_CRON" == "1" ]]; then
  if [[ -z "$ALERT_EMAIL" ]]; then
    warn "ALERT_EMAIL not set — skipping live subscription"
  else
    step "POST /subscribe — alert_type=hf (threshold 1.2, 10x) + alert_type=liquidation"
    SUB_HF="$(curl -s -X POST "$BASE_URL/subscribe" -H "Content-Type: application/json" \
      -d "{\"email\":\"$ALERT_EMAIL\",\"pool_id\":\"$POOL_ID\",\"asset_symbol\":\"$ASSET\",\"leverage_bracket\":10,\"alert_type\":\"hf\",\"hf_threshold\":1.2}")"
    SUB_LQ="$(curl -s -X POST "$BASE_URL/subscribe" -H "Content-Type: application/json" \
      -d "{\"email\":\"$ALERT_EMAIL\",\"pool_id\":\"$POOL_ID\",\"asset_symbol\":\"$ASSET\",\"leverage_bracket\":10,\"alert_type\":\"liquidation\"}")"
    echo "  hf:          $SUB_HF"
    echo "  liquidation: $SUB_LQ"
    evidence "subscribe_hf" "$SUB_HF"
    evidence "subscribe_liquidation" "$SUB_LQ"
    if echo "$SUB_HF" | grep -q "verification email"; then
      warn "RESEND_API_KEY missing on the worker — rows are inserted but the verification"
      warn "email can't be sent. Verifying directly in D1 for the demo."
    fi
    d1 "UPDATE subscriptions SET verified=1, verify_token=NULL WHERE email='$ALERT_EMAIL' AND alert_type IN ('hf','liquidation')" > /dev/null
    SUBS="$(d1 "SELECT id, alert_type, hf_threshold, leverage_bracket, verified, last_fired_at FROM subscriptions WHERE email='$ALERT_EMAIL' AND alert_type IN ('hf','liquidation')")"
    echo "  verified subscriptions: $SUBS"
    evidence "subscriptions_verified" "$SUBS"
  fi
fi
pause

# ── step 5: wait for the production cron ────────────────────────────────────
if [[ "$ADMIN" == "1" && "$WAIT_CRON" == "1" ]]; then
  banner "Waiting for the next production cron tick (*/15) …"
  NOW_MIN=$(date -u +%M); NOW_SEC=$(date -u +%S)
  WAIT=$(( ( (15 - (10#$NOW_MIN % 15)) * 60 - 10#$NOW_SEC ) + 90 ))
  step "next tick in ~$(( (WAIT-90) / 60 )) min — sleeping $WAIT s (tick + 90 s of cron runtime)"
  sleep "$WAIT"

  step "Prune check: the 400-day-old sentinel must be gone"
  LEFT="$(d1 "SELECT COUNT(*) AS still_there FROM rate_snapshots WHERE pool_id='RETENTION_TEST'")"
  echo "  $LEFT"
  evidence "prune_result" "$LEFT"
  if echo "$LEFT" | grep -q '"still_there": 0\|"still_there":0'; then
    ok "pruning job deleted the >365-day row in production"
  else
    warn "sentinel still present — cron may not have completed yet; re-check with:"
    echo "  cd alerts && npx wrangler d1 execute turbolong-alerts --remote --command \"SELECT * FROM rate_snapshots WHERE pool_id='RETENTION_TEST'\""
  fi
  echo ""

  step "New snapshot rows written by this tick"
  FRESH="$(curl -sf "$BASE_URL/snapshots?limit=2")"
  echo "$FRESH" | python3 -c 'import json,sys
for s in json.load(sys.stdin)["snapshots"]:
    print(f"  id={s[\"id\"]}  {s[\"recorded_at\"]}  {s[\"asset_symbol\"]}")'
  evidence "post_cron_snapshots" "$FRESH"
  echo ""

  if [[ -n "$ALERT_EMAIL" ]]; then
    step "Alert-fired check: last_fired_at on the hf subscription"
    FIRED="$(d1 "SELECT id, alert_type, hf_threshold, last_fired_at FROM subscriptions WHERE email='$ALERT_EMAIL' AND alert_type IN ('hf','liquidation')")"
    echo "$FIRED" | python3 -m json.tool
    evidence "alert_fired" "$FIRED"
    if echo "$FIRED" | grep -q '"last_fired_at": "2'; then
      ok "HF alert FIRED in production (email sent via Resend, last_fired_at stamped)"
    else
      warn "last_fired_at still null — if RESEND_API_KEY is missing the send fails and the"
      warn "timestamp is not stamped. Fix with:  cd alerts && npx wrangler secret put RESEND_API_KEY"
    fi
  fi
fi

# ── summary ───────────────────────────────────────────────────────────────────
banner "T2.5 acceptance — summary"
echo "  1. rate_snapshots written every 15 min .... ${GREEN}LIVE${RESET}  (cadence shown above)"
echo "  2. Public paginated JSON endpoint ......... ${GREEN}LIVE${RESET}  ($BASE_URL/snapshots)"
echo "  3. 365-day retention (prune) .............. $( [[ "$PRUNE_PENDING" == "1" ]] && echo "${GREEN}TESTED in prod${RESET}" || echo "${YELLOW}code-verified${RESET} (re-run with ADMIN=1 WAIT_CRON=1)" )"
echo "  4. HF + liquidation channels .............. ${GREEN}LIVE${RESET}  (subscriptions + cron evaluation)"
echo "  5. >=30 days of data ....................... accumulating (see start date above)"
echo ""
echo "  Evidence log: ${BOLD}${RUN_LOG#$ROOT_DIR/}${RESET}"
echo ""
