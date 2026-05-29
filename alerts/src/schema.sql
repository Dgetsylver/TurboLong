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

-- ── Rate-limit hits ───────────────────────────────────────────────────────────
-- Sliding-window counters for /subscribe abuse prevention.
-- key   = "ip:<ip>" | "email:<email>"
-- Each row is one hit timestamp; old rows are pruned on every check.
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL,
  hit_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rl_key_hit_at
  ON rate_limit_hits(key, hit_at);
