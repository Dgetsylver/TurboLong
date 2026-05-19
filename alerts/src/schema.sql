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

CREATE TABLE IF NOT EXISTS rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id TEXT NOT NULL,
  pool_name TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  supply_rate REAL NOT NULL,
  borrow_rate REAL NOT NULL,
  interest_supply_rate REAL NOT NULL,
  interest_borrow_rate REAL NOT NULL,
  blnd_supply_rate REAL NOT NULL,
  blnd_borrow_rate REAL NOT NULL,
  util REAL NOT NULL,
  blnd_eps REAL NOT NULL,
  captured_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_snapshots_pool_asset_time
  ON rate_snapshots(pool_id, asset_symbol, captured_at);
