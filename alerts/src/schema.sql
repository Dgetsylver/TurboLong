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

-- Historical APY snapshots (one row per pool/asset per 15-min tick)
CREATE TABLE IF NOT EXISTS rate_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id      TEXT    NOT NULL,
  asset_symbol TEXT    NOT NULL,
  supply_rate  REAL    NOT NULL,  -- netSupplyApr  (%)
  borrow_rate  REAL    NOT NULL,  -- netBorrowCost (%)
  util         REAL    NOT NULL,  -- utilisation ratio 0-1
  blnd_eps     REAL    NOT NULL,  -- supply-side BLND eps (raw)
  ts           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_pool_asset_ts
  ON rate_snapshots(pool_id, asset_symbol, ts);
