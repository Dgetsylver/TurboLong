CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  leverage_bracket REAL NOT NULL,
  verified INTEGER DEFAULT 0,
  verify_token TEXT,
  unsub_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_alerted_at TEXT,
  UNIQUE(email, pool_id, asset_symbol, leverage_bracket)
);

CREATE INDEX IF NOT EXISTS idx_subs_pool_asset_lev
  ON subscriptions(pool_id, asset_symbol, leverage_bracket);

-- Aggregate protocol stats written by cron every 15 min
CREATE TABLE IF NOT EXISTS pool_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tvl_usd REAL NOT NULL DEFAULT 0,
  volume_24h_usd REAL NOT NULL DEFAULT 0,
  avg_leverage REAL NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Per-asset breakdown for the Top Assets table
CREATE TABLE IF NOT EXISTS asset_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_symbol TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  tvl_usd REAL NOT NULL DEFAULT 0,
  net_supply_apr REAL NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now'))
);
