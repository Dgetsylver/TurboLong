/**
 * rateLimit.ts — Sliding-window rate limiter backed by D1.
 *
 * Two independent limits are enforced on every /subscribe call:
 *   1. Per-IP   — prevents one machine from spamming the endpoint
 *   2. Per-email — prevents the same address being re-subscribed in a loop
 *
 * Configuration (set in wrangler.toml [vars] or as Wrangler secrets):
 *
 *   RATE_LIMIT_IP_MAX        Max requests per IP  per window   (default: 5)
 *   RATE_LIMIT_IP_WINDOW_S   Window size in seconds for IP     (default: 900 = 15 min)
 *   RATE_LIMIT_EMAIL_MAX     Max requests per email per window (default: 3)
 *   RATE_LIMIT_EMAIL_WINDOW_S Window size in seconds for email (default: 3600 = 1 h)
 *
 * Algorithm: each hit is a row in `rate_limit_hits`. On every check we
 *   1. Delete rows older than the window (prune)
 *   2. Count remaining rows for the key
 *   3. If count >= max → reject (429)
 *   4. Otherwise insert a new hit row and allow
 *
 * The D1 operations are not atomic across the count+insert, but for a
 * lightweight abuse-prevention use-case the race window is acceptable.
 * A stricter implementation would use a single INSERT...RETURNING + trigger,
 * or Durable Objects.
 */

export interface RateLimitConfig {
  /** Maximum hits allowed inside the window. */
  max: number;
  /** Window duration in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  /** true → request is within limits and the hit has been recorded. */
  allowed: boolean;
  /** How many hits exist in the current window (after pruning, before this hit). */
  current: number;
  /** Configured maximum. */
  limit: number;
  /** Seconds until the oldest hit in the window expires (0 if allowed). */
  retryAfter: number;
}

interface D1Database {
  prepare(sql: string): D1PreparedStatement;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1Result>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

interface D1Result {
  meta: { changes: number };
}

/**
 * Check and record a rate-limit hit for `key` using the given D1 database.
 *
 * @param db      Bound D1Database instance
 * @param key     Namespaced key, e.g. "ip:1.2.3.4" or "email:user@example.com"
 * @param config  Window size and max hits
 */
export async function checkRateLimit(
  db: D1Database,
  key: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  const { max, windowSeconds } = config;

  // ISO timestamp for the start of the current window
  const windowStart = new Date(Date.now() - windowSeconds * 1000).toISOString();

  // 1. Prune hits outside the window
  await db
    .prepare("DELETE FROM rate_limit_hits WHERE key = ?1 AND hit_at < ?2")
    .bind(key, windowStart)
    .run();

  // 2. Count current hits in the window
  const row = await db
    .prepare("SELECT COUNT(*) AS cnt FROM rate_limit_hits WHERE key = ?1 AND hit_at >= ?2")
    .bind(key, windowStart)
    .first<{ cnt: number }>();

  const current = row?.cnt ?? 0;

  if (current >= max) {
    // Fetch the oldest hit timestamp to compute retry-after
    const oldest = await db
      .prepare(
        "SELECT hit_at FROM rate_limit_hits WHERE key = ?1 AND hit_at >= ?2 ORDER BY hit_at ASC LIMIT 1",
      )
      .bind(key, windowStart)
      .first<{ hit_at: string }>();

    const oldestMs = oldest ? new Date(oldest.hit_at).getTime() : Date.now();
    const retryAfter = Math.ceil((oldestMs + windowSeconds * 1000 - Date.now()) / 1000);

    return { allowed: false, current, limit: max, retryAfter: Math.max(0, retryAfter) };
  }

  // 3. Record this hit
  await db
    .prepare("INSERT INTO rate_limit_hits (key, hit_at) VALUES (?1, ?2)")
    .bind(key, new Date().toISOString())
    .run();

  return { allowed: true, current, limit: max, retryAfter: 0 };
}

/**
 * Run both IP and email checks. Returns the first failing result, or null
 * if both pass (hits have already been recorded).
 */
export async function checkSubscribeRateLimit(
  db: D1Database,
  ip: string,
  email: string,
  env: {
    RATE_LIMIT_IP_MAX?: string;
    RATE_LIMIT_IP_WINDOW_S?: string;
    RATE_LIMIT_EMAIL_MAX?: string;
    RATE_LIMIT_EMAIL_WINDOW_S?: string;
  },
): Promise<RateLimitResult | null> {
  const ipConfig: RateLimitConfig = {
    max:           Number(env.RATE_LIMIT_IP_MAX    ?? 5),
    windowSeconds: Number(env.RATE_LIMIT_IP_WINDOW_S ?? 900),
  };
  const emailConfig: RateLimitConfig = {
    max:           Number(env.RATE_LIMIT_EMAIL_MAX    ?? 3),
    windowSeconds: Number(env.RATE_LIMIT_EMAIL_WINDOW_S ?? 3600),
  };

  const ipResult = await checkRateLimit(db, `ip:${ip}`, ipConfig);
  if (!ipResult.allowed) return ipResult;

  const emailResult = await checkRateLimit(db, `email:${email.toLowerCase()}`, emailConfig);
  if (!emailResult.allowed) return emailResult;

  return null; // both passed
}
