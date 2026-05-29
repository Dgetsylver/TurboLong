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

-- E3: rate-spike subscriptions
CREATE TABLE IF NOT EXISTS rate_spike_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  threshold_pp REAL NOT NULL DEFAULT 2.0,  -- percentage-point jump to trigger alert
  verified INTEGER DEFAULT 0,
  verify_token TEXT,
  unsub_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_alerted_at TEXT,
  UNIQUE(email, pool_id, asset_symbol)
);

CREATE INDEX IF NOT EXISTS idx_spike_subs_pool_asset
  ON rate_spike_subscriptions(pool_id, asset_symbol);

-- E3: borrow rate snapshots (one row per pool/asset per cron tick, kept 24h)
CREATE TABLE IF NOT EXISTS rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  borrow_apr REAL NOT NULL,
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_pool_asset_time
  ON rate_snapshots(pool_id, asset_symbol, recorded_at);
