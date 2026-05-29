CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  user_address TEXT,
  webhook_url TEXT,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  leverage_bracket REAL NOT NULL,
  verified INTEGER DEFAULT 0,
  verify_token TEXT,
  unsub_token TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  last_alerted_at TEXT,
  last_liquidation_alert_at TEXT,
  UNIQUE(email, user_address, pool_id, asset_symbol, leverage_bracket)
);

CREATE INDEX IF NOT EXISTS idx_subs_pool_asset_lev
  ON subscriptions(pool_id, asset_symbol, leverage_bracket);
