/**
 * Turbolong APY Alert Worker
 *
 * Routes:
 *   POST /subscribe       — register an alert subscription
 *   GET  /verify?token=   — verify email
 *   GET  /unsubscribe?token= — remove subscription
 *
 * Cron (every 15 min):
 *   Fetch pool reserve rates, compute APY per bracket, alert subscribers.
 */

import { POOLS, LEVERAGE_BRACKETS, POOL_NAMES, fetchReserveRates, computeNetApy, type ReserveRates } from "./stellar.ts";
import { sendVerificationEmail, sendApyAlert } from "./email.ts";

interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  FRONTEND_ORIGIN: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: object, status = 200, env?: Env): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(env ? corsHeaders(env) : {}),
    },
  });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html;charset=utf-8" },
  });
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": env.FRONTEND_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Known pool IDs for validation. */
const KNOWN_POOL_IDS = new Set(POOLS.flatMap(p => [p.id]));

/** All known asset symbols across pools. */
const KNOWN_SYMBOLS = new Set(POOLS.flatMap(p => p.assets.map(a => a.symbol)));

function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let token = "";
  for (const b of bytes) token += b.toString(16).padStart(2, "0");
  return token;
}

function workerUrl(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

const SNAPSHOT_RETENTION_DAYS = 365;
const DEFAULT_SNAPSHOT_WINDOW_DAYS = 7;
const MAX_SNAPSHOT_LIMIT = 5000;

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseWindowDays(value: string | null): number {
  if (!value) return DEFAULT_SNAPSHOT_WINDOW_DAYS;
  const match = value.trim().toLowerCase().match(/^(\d+)(d|w|m|y)?$/);
  if (!match) return DEFAULT_SNAPSHOT_WINDOW_DAYS;

  const amount = Number(match[1]);
  const unit = match[2] ?? "d";
  const days = unit === "y"
    ? amount * 365
    : unit === "m"
      ? amount * 30
      : unit === "w"
        ? amount * 7
        : amount;
  return Math.max(1, Math.min(days, SNAPSHOT_RETENTION_DAYS));
}

async function pruneOldRateSnapshots(env: Env): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM rate_snapshots WHERE captured_at < datetime('now', ?1)"
  ).bind(`-${SNAPSHOT_RETENTION_DAYS} days`).run();
}

async function insertRateSnapshot(
  env: Env,
  pool: typeof POOLS[number],
  asset: typeof POOLS[number]["assets"][number],
  rates: ReserveRates,
): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO rate_snapshots (
      pool_id,
      pool_name,
      asset_id,
      asset_symbol,
      supply_rate,
      borrow_rate,
      interest_supply_rate,
      interest_borrow_rate,
      blnd_supply_rate,
      blnd_borrow_rate,
      util,
      blnd_eps
    )
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
  `).bind(
    pool.id,
    pool.name,
    asset.id,
    asset.symbol,
    rates.netSupplyApr,
    rates.netBorrowCost,
    rates.interestSupplyApr,
    rates.interestBorrowApr,
    rates.blndSupplyApr,
    rates.blndBorrowApr,
    rates.utilization,
    rates.supplyEps + rates.borrowEps,
  ).run();
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  const { email, pool_id, asset_symbol, leverage_bracket } = body;

  // Validate
  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse({ ok: false, error: "Invalid email" }, 400, env);
  }
  if (!KNOWN_POOL_IDS.has(pool_id)) {
    return jsonResponse({ ok: false, error: "Unknown pool" }, 400, env);
  }
  if (!KNOWN_SYMBOLS.has(asset_symbol)) {
    return jsonResponse({ ok: false, error: "Unknown asset" }, 400, env);
  }
  const lev = Number(leverage_bracket);
  if (!LEVERAGE_BRACKETS.includes(lev)) {
    return jsonResponse({ ok: false, error: "Invalid leverage bracket. Must be one of: " + LEVERAGE_BRACKETS.join(", ") }, 400, env);
  }

  const verifyToken = generateToken();
  const unsubToken  = generateToken();

  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET verify_token = ?5, unsub_token = ?6, verified = 0
    `).bind(email, pool_id, asset_symbol, lev, verifyToken, unsubToken).run();
  } catch (e: any) {
    console.error("DB insert failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }

  // Send verification email
  const base = workerUrl(request);
  const verifyUrl = `${base}/verify?token=${verifyToken}`;

  const result = await sendVerificationEmail(
    { RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM: env.RESEND_FROM },
    email,
    verifyUrl,
  );

  if (!result.ok) {
    console.error("Failed to send verification email:", result.error);
    return jsonResponse({ ok: false, error: "Failed to send verification email" }, 500, env);
  }

  return jsonResponse({ ok: true, message: "Check your email to verify your subscription." }, 200, env);
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) return htmlResponse("<h2>Missing token.</h2>", 400);

  const row = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE verify_token = ?1"
  ).bind(token).first();

  if (!row) return htmlResponse("<h2>Invalid or expired token.</h2>", 404);

  await env.DB.prepare(
    "UPDATE subscriptions SET verified = 1, verify_token = NULL WHERE verify_token = ?1"
  ).bind(token).run();

  return htmlResponse(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Verified</title></head>
<body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px;">
  <h2 style="color: #2DE8A3;">Subscription Verified!</h2>
  <p>You'll receive an alert when your position's net APY turns negative.</p>
</body>
</html>`);
}

async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) return htmlResponse("<h2>Missing token.</h2>", 400);

  const result = await env.DB.prepare(
    "DELETE FROM subscriptions WHERE unsub_token = ?1"
  ).bind(token).run();

  if (!result.meta.changes) {
    return htmlResponse("<h2>Subscription not found or already removed.</h2>", 404);
  }

  return htmlResponse(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px;">
  <h2>Unsubscribed</h2>
  <p>You will no longer receive APY alerts for this subscription.</p>
</body>
</html>`);
}

async function handleRateSnapshots(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const windowDays = parseWindowDays(url.searchParams.get("window"));
  const limit = parsePositiveInt(url.searchParams.get("limit"), 500, MAX_SNAPSHOT_LIMIT);
  const poolId = url.searchParams.get("pool_id")?.trim();
  const assetSymbol = url.searchParams.get("asset_symbol")?.trim().toUpperCase();
  const assetId = url.searchParams.get("asset_id")?.trim();

  const binds: (string | number)[] = [`-${windowDays} days`];
  let sql = `
    SELECT
      pool_id,
      pool_name,
      asset_id,
      asset_symbol,
      supply_rate,
      borrow_rate,
      interest_supply_rate,
      interest_borrow_rate,
      blnd_supply_rate,
      blnd_borrow_rate,
      util,
      blnd_eps,
      captured_at
    FROM rate_snapshots
    WHERE captured_at >= datetime('now', ?1)
  `;

  if (poolId) {
    binds.push(poolId);
    sql += ` AND pool_id = ?${binds.length}`;
  }
  if (assetSymbol) {
    binds.push(assetSymbol);
    sql += ` AND asset_symbol = ?${binds.length}`;
  }
  if (assetId) {
    binds.push(assetId);
    sql += ` AND asset_id = ?${binds.length}`;
  }

  binds.push(limit);
  sql += ` ORDER BY captured_at ASC LIMIT ?${binds.length}`;

  const result = await env.DB.prepare(sql).bind(...binds).all();
  return jsonResponse({
    ok: true,
    window_days: windowDays,
    limit,
    filters: {
      pool_id: poolId ?? null,
      asset_symbol: assetSymbol ?? null,
      asset_id: assetId ?? null,
    },
    snapshots: result.results ?? [],
  }, 200, env);
}

// ── Cron handler ─────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  console.log("[cron] APY alert check starting...");

  try {
    await pruneOldRateSnapshots(env);
  } catch (e) {
    console.error("[cron] Failed to prune old rate snapshots:", e);
  }

  for (const pool of POOLS) {
    for (const asset of pool.assets) {
      let rates: ReserveRates | null = null;
      try {
        rates = await fetchReserveRates(pool, asset);
      } catch (e) {
        console.error(`[cron] Failed to fetch rates for ${asset.symbol} on ${pool.name}:`, e);
        continue;
      }

      if (!rates) {
        console.warn(`[cron] No rates returned for ${asset.symbol} on ${pool.name}`);
        continue;
      }

      try {
        await insertRateSnapshot(env, pool, asset, rates);
      } catch (e) {
        console.error(`[cron] Failed to snapshot rates for ${asset.symbol} on ${pool.name}:`, e);
      }

      for (const bracket of LEVERAGE_BRACKETS) {
        const netApy = computeNetApy(rates, bracket);

        if (netApy >= 0) continue; // APY is positive, no alert needed

        console.log(`[cron] Negative APY: ${asset.symbol} at ${bracket}x on ${pool.name} = ${netApy.toFixed(2)}%`);

        // Find verified subscribers who haven't been alerted in the last 24h
        const subs = await env.DB.prepare(`
          SELECT id, email, unsub_token
          FROM subscriptions
          WHERE pool_id = ?1
            AND asset_symbol = ?2
            AND leverage_bracket = ?3
            AND verified = 1
            AND (last_alerted_at IS NULL OR last_alerted_at < datetime('now', '-24 hours'))
        `).bind(pool.id, asset.symbol, bracket).all();

        if (!subs.results?.length) continue;

        console.log(`[cron] Alerting ${subs.results.length} subscriber(s) for ${asset.symbol}@${bracket}x on ${pool.name}`);

        for (const sub of subs.results) {
          const unsubUrl = `https://turbolong-alerts.workers.dev/unsubscribe?token=${sub.unsub_token}`;
          const result = await sendApyAlert(
            { RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM: env.RESEND_FROM },
            sub.email as string,
            {
              poolName: pool.name,
              assetSymbol: asset.symbol,
              leverage: bracket,
              netApy,
              supplyApr: rates.netSupplyApr,
              borrowCost: rates.netBorrowCost,
              unsubscribeUrl: unsubUrl,
              appUrl: env.FRONTEND_ORIGIN,
            },
          );

          if (result.ok) {
            await env.DB.prepare(
              "UPDATE subscriptions SET last_alerted_at = datetime('now') WHERE id = ?1"
            ).bind(sub.id).run();
          } else {
            console.error(`[cron] Failed to send alert to ${sub.email}:`, result.error);
          }
        }
      }
    }
  }

  console.log("[cron] APY alert check complete.");
}

// ── Worker entry ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    switch (url.pathname) {
      case "/subscribe":
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, 405, env);
        }
        return handleSubscribe(request, env);

      case "/verify":
        return handleVerify(request, env);

      case "/unsubscribe":
        return handleUnsubscribe(request, env);

      case "/rate-snapshots":
        if (request.method !== "GET") {
          return jsonResponse({ error: "Method not allowed" }, 405, env);
        }
        return handleRateSnapshots(request, env);

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
