# TurboLong APY Alert Worker & Throttling System

A Cloudflare Worker that monitors Blend leverage strategy APYs and sends email alerts to subscribers when rates drop below zero.

---

## Rate Limiting & Throttling (H2)

To prevent abuse such as email-bombing, the `/subscribe` endpoint enforces a sliding-window rate limiter backed by Cloudflare D1 database.

### Enforcement Strategy

Every `/subscribe` request triggers two independent rate limit checks:

1. **Per-IP Rate Limiting:** Prevents single-client/IP spam.
2. **Per-Email Rate Limiting:** Prevents repeatedly subscribing the same email address.

If either limit is exceeded, the worker returns a `429 Too Many Requests` status code with:
- A JSON body describing the block.
- A `Retry-After` HTTP header indicating how many seconds until the block expires.

---

## Configuration

The rate limiting limits are fully configurable via environment variables in `wrangler.toml` under the `[vars]` section (or set as Cloudflare environment variables/secrets):

| Variable | Description | Default |
|---|---|---|
| `RATE_LIMIT_IP_MAX` | Maximum number of hits allowed per IP window | `5` |
| `RATE_LIMIT_IP_WINDOW_S` | Window duration in seconds for IP limit | `900` (15 minutes) |
| `RATE_LIMIT_EMAIL_MAX` | Maximum number of hits allowed per Email window | `3` |
| `RATE_LIMIT_EMAIL_WINDOW_S` | Window duration in seconds for Email limit | `3600` (1 hour) |

---

## Database Schema

The rate-limiting system records hits in the `rate_limit_hits` table:

```sql
CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  key        TEXT    NOT NULL,  -- e.g. "ip:<ip>" or "email:<email>"
  hit_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rl_key_hit_at ON rate_limit_hits(key, hit_at);
```

On each check, expired hits outside the sliding window are pruned automatically.

---

## Running Tests

Verify the rate limiter functionality, sliding-window pruning, and status code / headers outputs using the test suite:

```bash
cd alerts
npx tsx src/test-rate-limit.ts
```
