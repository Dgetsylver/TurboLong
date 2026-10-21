-- One alert per episode: latch column for edge-triggered alerting.
--
-- Before this, alerts were level-triggered — the cron re-sent an email every
-- 24h (APY) / 6h (HF) for as long as the condition held, so a position that
-- stayed negative for a week mailed the subscriber every day. `alert_active`
-- latches on the send and only clears once the metric recovers past the re-arm
-- margin, so each breach episode produces exactly one email/push.
--
-- Run ONCE against the existing production D1 database (fresh deploys get the
-- full schema from src/schema.sql instead):
--   wrangler d1 execute turbolong-alerts --remote \
--     --file=migrations/0003_edge_triggered_alerts.sql
--
-- SQLite has no ADD COLUMN IF NOT EXISTS; if a column already exists the
-- statement errors harmlessly — skip it.

ALTER TABLE subscriptions ADD COLUMN alert_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN alert_active INTEGER NOT NULL DEFAULT 0;

-- Existing rows that already alerted inside the old debounce window start
-- latched, so nobody gets a duplicate for an episode they were mailed about;
-- the latch clears on the first recovery tick.
UPDATE subscriptions
   SET alert_active = 1
 WHERE (last_alerted_at IS NOT NULL AND last_alerted_at > datetime('now', '-24 hours'))
    OR (last_fired_at  IS NOT NULL AND last_fired_at  > datetime('now', '-6 hours'));

UPDATE push_subscriptions
   SET alert_active = 1
 WHERE last_alerted_at IS NOT NULL AND last_alerted_at > datetime('now', '-24 hours');
