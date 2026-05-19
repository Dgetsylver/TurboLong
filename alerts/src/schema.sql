CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  asset_symbol TEXT NOT NULL,
  leverage_bracket REAL NOT NULL,
  verified INTEGER DEFAULT 0,
  verify_token TEXT,
  unsub_token TEXT,
  wallet_address TEXT,
  daily_summary_enabled INTEGER DEFAULT 0,
  summary_utc_hour INTEGER,
  summary_equity_usd REAL,
  last_summary_at TEXT,
  last_summary_net_apy REAL,
  last_summary_hf REAL,
  created_at TEXT DEFAULT (datetime('now')),
  last_alerted_at TEXT,
  UNIQUE(email, pool_id, asset_symbol, leverage_bracket)
);

CREATE INDEX IF NOT EXISTS idx_subs_pool_asset_lev
  ON subscriptions(pool_id, asset_symbol, leverage_bracket);

CREATE INDEX IF NOT EXISTS idx_subs_daily_summary
  ON subscriptions(daily_summary_enabled, summary_utc_hour, last_summary_at);
