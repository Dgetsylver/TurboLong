-- ── Referral Codes ───────────────────────────────────────────────────────────
-- One referral code per wallet address. Code is deterministic but can be
-- re-registered (idempotent upsert).
CREATE TABLE IF NOT EXISTS referral_codes (
  code          TEXT PRIMARY KEY,          -- e.g. "GABS4a3f"
  owner_address TEXT NOT NULL UNIQUE,      -- G... Stellar address
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ref_codes_owner
  ON referral_codes(owner_address);

-- ── Referral Events ───────────────────────────────────────────────────────────
-- One row per referred deposit transaction found by the indexer.
CREATE TABLE IF NOT EXISTS referral_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT    NOT NULL,        -- FK → referral_codes.code
  depositor_address TEXT   NOT NULL,        -- G... address that made the tx
  tx_hash          TEXT    NOT NULL UNIQUE, -- Stellar tx hash
  memo_raw         TEXT    NOT NULL,        -- full memo string (e.g. "ref:GABS4a3f")
  pool_id          TEXT    NOT NULL,        -- Blend pool contract ID
  indexed_at       TEXT    DEFAULT (datetime('now')),
  FOREIGN KEY (code) REFERENCES referral_codes(code)
);

CREATE INDEX IF NOT EXISTS idx_ref_events_code
  ON referral_events(code);

CREATE INDEX IF NOT EXISTS idx_ref_events_depositor
  ON referral_events(depositor_address);

CREATE INDEX IF NOT EXISTS idx_ref_events_pool
  ON referral_events(pool_id);
