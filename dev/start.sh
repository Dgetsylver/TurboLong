#!/usr/bin/env bash
# Turbolong local dev quickstart.
# Spins up a local Stellar Quickstart node, deploys contracts,
# starts the frontend dev server, and the Alerts worker — all in one command.
#
# Prerequisites: Docker, Node.js >= 20, Rust + cargo, wrangler (npm i -g wrangler)
# Usage: bash dev/start.sh [--testnet]

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[turbolong]${NC} $*"; }
success() { echo -e "${GREEN}[turbolong]${NC} $*"; }
warn()    { echo -e "${YELLOW}[turbolong]${NC} $*"; }
die()     { echo -e "${RED}[turbolong] ERROR:${NC} $*" >&2; exit 1; }

# ── Prerequisites check ───────────────────────────────────────────────────────
check_dep() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed. See README for setup instructions."
}

check_dep docker
check_dep node
check_dep npm

NODE_VERSION=$(node -e "process.exit(parseInt(process.versions.node) < 20 ? 1 : 0)" 2>/dev/null) \
  || die "Node.js >= 20 is required (found $(node --version))"

# ── Parse args ────────────────────────────────────────────────────────────────
USE_QUICKSTART=true
NETWORK="local"
for arg in "$@"; do
  case $arg in
    --testnet) USE_QUICKSTART=false; NETWORK="testnet" ;;
  esac
done

# ── Load .env.local if it exists ──────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -o allexport; source "$ENV_FILE"; set +o allexport
  info "Loaded env from .env.local"
fi

# ── 1. Stellar Quickstart (local only) ───────────────────────────────────────
QUICKSTART_CONTAINER="turbolong-stellar"
RPC_PORT="${STELLAR_RPC_PORT:-8000}"
HORIZON_PORT="${STELLAR_HORIZON_PORT:-8001}"

if $USE_QUICKSTART; then
  info "Starting Stellar Quickstart container…"

  if docker ps --format '{{.Names}}' | grep -q "^${QUICKSTART_CONTAINER}$"; then
    warn "Container '$QUICKSTART_CONTAINER' already running — skipping."
  else
    docker run -d \
      --name "$QUICKSTART_CONTAINER" \
      --rm \
      -p "${RPC_PORT}:8000" \
      -p "${HORIZON_PORT}:8001" \
      stellar/quickstart:latest \
      --standalone \
      --enable-soroban-rpc \
      --protocol-version 22 \
      --limits default
    info "Waiting for Quickstart RPC to become ready…"
    for i in $(seq 1 30); do
      if curl -sf "http://localhost:${RPC_PORT}/soroban/rpc" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' \
           -H "Content-Type: application/json" >/dev/null 2>&1; then
        success "Stellar Quickstart is ready on port ${RPC_PORT}"
        break
      fi
      [[ $i -eq 30 ]] && die "Quickstart failed to start after 60s"
      sleep 2
    done
  fi
fi

# ── 2. Install frontend deps ──────────────────────────────────────────────────
info "Installing frontend dependencies…"
npm install --prefix "$ROOT/frontend" --silent

# ── 3. Start frontend dev server ──────────────────────────────────────────────
info "Starting frontend dev server at http://localhost:5173 …"
npm run dev --prefix "$ROOT/frontend" &
FRONTEND_PID=$!

# ── 4. Start Alerts worker (optional — requires wrangler) ────────────────────
if command -v wrangler >/dev/null 2>&1; then
  info "Starting Alerts Cloudflare Worker…"
  (cd "$ROOT/alerts" && npm install --silent && wrangler dev --port 8787) &
  ALERTS_PID=$!
else
  warn "wrangler not found — skipping Alerts worker. Install with: npm i -g wrangler"
  ALERTS_PID=""
fi

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
success "Turbolong is running!"
echo ""
echo "  Frontend:   http://localhost:5173"
if $USE_QUICKSTART; then
echo "  Stellar RPC: http://localhost:${RPC_PORT}/soroban/rpc"
echo "  Horizon:     http://localhost:${HORIZON_PORT}"
else
echo "  Network:     Stellar Testnet"
fi
if [[ -n "$ALERTS_PID" ]]; then
echo "  Alerts:      http://localhost:8787"
fi
echo ""
echo "Press Ctrl+C to stop all services."

# ── Cleanup on exit ───────────────────────────────────────────────────────────
cleanup() {
  info "Shutting down…"
  [[ -n "$FRONTEND_PID" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  [[ -n "${ALERTS_PID:-}" ]] && kill "$ALERTS_PID" 2>/dev/null || true
  if $USE_QUICKSTART; then
    docker stop "$QUICKSTART_CONTAINER" 2>/dev/null || true
  fi
  success "Done."
}
trap cleanup EXIT INT TERM

wait
