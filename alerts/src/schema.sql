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
  -- Alert channel: 'apy' (default, net-APY went negative), 'hf'
  -- (health factor below hf_threshold), 'liquidation' (HF < 1.05),
  -- 'rate_spike' (reserved).
  alert_type TEXT NOT NULL DEFAULT 'apy',
  -- HF threshold for the 'hf' channel (e.g. 1.10).
  hf_threshold REAL,
  -- Last time any alert fired for this row (debounce).
  last_fired_at TEXT,
  UNIQUE(email, pool_id, asset_symbol, leverage_bracket, alert_type)
);

CREATE INDEX IF NOT EXISTS idx_subs_pool_asset_lev
  ON subscriptions(pool_id, asset_symbol, leverage_bracket);

CREATE INDEX IF NOT EXISTS idx_subs_alert_type
  ON subscriptions(alert_type);

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

-- Historical rate snapshots, written every cron tick (15 min). Powers the
-- public time-series endpoint and the 24h/7d delta arrows (Tranche 3) and the
-- Aquarius comparison view. Pruned to a 365-day retention window.
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
