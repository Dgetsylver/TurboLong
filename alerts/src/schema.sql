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

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  leverage_bracket REAL NOT NULL,
  unsub_token TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_alerted_at TEXT,
  UNIQUE(endpoint, pool_id, asset_symbol, leverage_bracket)
);

CREATE INDEX IF NOT EXISTS idx_push_subs_pool_asset_lev
  ON push_subscriptions(pool_id, asset_symbol, leverage_bracket);
