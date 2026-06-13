-- SCF T2.5 — historical APY storage + HF/liquidation alert channels.
--
-- Run ONCE against the existing production D1 database (fresh deploys get the
-- full schema from src/schema.sql instead):
--   wrangler d1 execute turbolong-alerts --remote \
--     --file=migrations/0001_t2_historical_apy_hf_alerts.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; if a column already exists the
-- statement errors harmlessly — skip it.

ALTER TABLE subscriptions ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'apy';
ALTER TABLE subscriptions ADD COLUMN hf_threshold REAL;
ALTER TABLE subscriptions ADD COLUMN last_fired_at TEXT;

CREATE INDEX IF NOT EXISTS idx_subs_alert_type
  ON subscriptions(alert_type);

CREATE TABLE IF NOT EXISTS rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  net_supply_apr REAL NOT NULL,
  net_borrow_cost REAL NOT NULL,
  interest_supply_apr REAL NOT NULL,
  interest_borrow_apr REAL NOT NULL,
  blnd_supply_apr REAL NOT NULL,
  blnd_borrow_apr REAL NOT NULL,
  util REAL NOT NULL,
  c_factor REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_pool_asset_time
  ON rate_snapshots(pool_id, asset_symbol, recorded_at);
