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
  digest_enabled INTEGER DEFAULT 0,
  digest_hour    INTEGER DEFAULT NULL,
  last_digest_at TEXT    DEFAULT NULL,
  UNIQUE(email, pool_id, asset_symbol, leverage_bracket)
);

CREATE INDEX IF NOT EXISTS idx_subs_pool_asset_lev
  ON subscriptions(pool_id, asset_symbol, leverage_bracket);

CREATE INDEX IF NOT EXISTS idx_subs_digest
  ON subscriptions(digest_hour, digest_enabled, verified);

-- Migration for existing databases (safe to run multiple times on SQLite 3.37+)
ALTER TABLE subscriptions ADD COLUMN digest_enabled INTEGER DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN digest_hour    INTEGER DEFAULT NULL;
ALTER TABLE subscriptions ADD COLUMN last_digest_at TEXT    DEFAULT NULL;
