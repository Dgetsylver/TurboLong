-- SCF T2.1 — Broker-vs-Soroswap A/B routing telemetry.
--
-- Run ONCE against the existing production D1 (fresh deploys get it from
-- src/schema.sql):
--   wrangler d1 execute turbolong-alerts --remote \
--     --file=migrations/0002_swap_routes.sql

CREATE TABLE IF NOT EXISTS swap_routes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  network        TEXT NOT NULL DEFAULT 'mainnet',
  strategy_id    TEXT NOT NULL,
  asset_symbol   TEXT NOT NULL,
  amount_in      TEXT NOT NULL,
  broker_quote   TEXT,
  soroswap_quote TEXT,
  chosen         TEXT NOT NULL,
  reason         TEXT NOT NULL,
  executed_out   TEXT,
  amount_out_min TEXT NOT NULL,
  slippage_bps   INTEGER,
  uplift_bps     INTEGER,
  tx_hash        TEXT,
  keeper         TEXT,
  status         TEXT NOT NULL DEFAULT 'executed'
);

CREATE INDEX IF NOT EXISTS idx_swap_routes_ts ON swap_routes(ts);
CREATE INDEX IF NOT EXISTS idx_swap_routes_net_strat ON swap_routes(network, strategy_id);
