/**
 * Turbolong APY Alert Worker
 *
 * Routes:
 *   POST /subscribe              — register an email alert subscription
 *                                  (alert_type: 'apy' | 'hf' | 'liquidation';
 *                                  hf_threshold required for 'hf')
 *   GET  /verify?token=          — verify email
 *   GET  /unsubscribe?token=     — remove email subscription
 *   GET  /vapid-public-key       — VAPID public key for web push
 *   POST /push/subscribe         — register a web-push subscription
 *   GET  /push/unsubscribe?token= — remove web-push subscription
 *   GET  /snapshots              — paginated rate time-series
 *                                  (?pool_id=&asset=&limit=&before=)
 *   GET  /swap-routes            — Broker-vs-Soroswap A/B report
 *                                  (?network=&strategy_id=&limit=)
 *   POST /swap-routes            — keeper ingests one routing record
 *                                  (Authorization: Bearer KEEPER_INGEST_KEY)
 *   GET  /broker/ws              — WebSocket relay to api.stellar.broker that
 *                                  injects the partner key server-side
 *                                  (secret: STELLAR_BROKER_PARTNER_KEY)
 *
 * Cron (every 15 min):
 *   Fetch pool reserve rates → write a rate_snapshots row → APY-negative alerts
 *   → HF / liquidation-imminent alerts → prune snapshots past 365 days.
 */

import { POOLS, LEVERAGE_BRACKETS, POOL_NAMES, fetchReserveRates, computeNetApy, computeHealthFactor, type ReserveRates } from "./stellar.ts";
import { sendVerificationEmail, sendApyAlert, sendHfAlert } from "./email.ts";
import { sendApyPush } from "./push.ts";

/** Liquidation-imminent HF threshold. */
const LIQUIDATION_HF = 1.05;
/** Minimum hours between repeat HF/liquidation alerts for a subscription. */
const HF_ALERT_DEBOUNCE_HOURS = 6;
/** Snapshot retention window. */
const SNAPSHOT_RETENTION_DAYS = 365;

interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  FRONTEND_ORIGIN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT?: string;
  /** Shared secret the keeper sends to POST /swap-routes (Authorization: Bearer). */
  KEEPER_INGEST_KEY?: string;
  /** Stellar Broker partner key, injected into /broker/ws upstream connections (wrangler secret). */
  STELLAR_BROKER_PARTNER_KEY?: string;
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

function validateAlertTarget(
  pool_id: string,
  asset_symbol: string,
  leverage_bracket: unknown,
): { ok: true; lev: number } | { ok: false; error: string } {
  if (!KNOWN_POOL_IDS.has(pool_id)) {
    return { ok: false, error: "Unknown pool" };
  }
  if (!KNOWN_SYMBOLS.has(asset_symbol)) {
    return { ok: false, error: "Unknown asset" };
  }
  const lev = Number(leverage_bracket);
  if (!LEVERAGE_BRACKETS.includes(lev)) {
    return { ok: false, error: "Invalid leverage bracket. Must be one of: " + LEVERAGE_BRACKETS.join(", ") };
  }
  return { ok: true, lev };
}

// ── Email route handlers ─────────────────────────────────────────────────────

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  const { email, pool_id, asset_symbol, leverage_bracket } = body;

  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse({ ok: false, error: "Invalid email" }, 400, env);
  }

  const target = validateAlertTarget(pool_id, asset_symbol, leverage_bracket);
  if (!target.ok) return jsonResponse({ ok: false, error: target.error }, 400, env);

  // Alert channel + optional HF threshold.
  const alertType = (body.alert_type ?? "apy") as string;
  if (!["apy", "hf", "liquidation"].includes(alertType)) {
    return jsonResponse({ ok: false, error: "Invalid alert_type" }, 400, env);
  }
  let hfThreshold: number | null = null;
  if (alertType === "hf") {
    hfThreshold = Number(body.hf_threshold);
    if (!Number.isFinite(hfThreshold) || hfThreshold <= 1) {
      return jsonResponse({ ok: false, error: "hf_threshold must be > 1 for the 'hf' channel" }, 400, env);
    }
  }

  const verifyToken = generateToken();
  const unsubToken  = generateToken();

  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token, alert_type, hf_threshold)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket, alert_type) DO UPDATE
        SET verify_token = ?5, unsub_token = ?6, hf_threshold = ?8, verified = 0
    `).bind(email, pool_id, asset_symbol, target.lev, verifyToken, unsubToken, alertType, hfThreshold).run();
  } catch (e: any) {
    console.error("DB insert failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }

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

// ── Web-push route handlers ──────────────────────────────────────────────────

async function handleVapidPublicKey(env: Env): Promise<Response> {
  if (!env.VAPID_PUBLIC_KEY) {
    return jsonResponse({ ok: false, error: "VAPID not configured" }, 503, env);
  }
  return jsonResponse({ ok: true, publicKey: env.VAPID_PUBLIC_KEY }, 200, env);
}

async function handlePushSubscribe(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  const { subscription, pool_id, asset_symbol, leverage_bracket } = body;
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return jsonResponse({ ok: false, error: "Invalid push subscription" }, 400, env);
  }

  const target = validateAlertTarget(pool_id, asset_symbol, leverage_bracket);
  if (!target.ok) return jsonResponse({ ok: false, error: target.error }, 400, env);

  const unsubToken = generateToken();

  try {
    await env.DB.prepare(`
      INSERT INTO push_subscriptions (endpoint, p256dh, auth, pool_id, asset_symbol, leverage_bracket, unsub_token)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(endpoint, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET p256dh = ?2, auth = ?3, unsub_token = ?7, last_alerted_at = NULL
    `).bind(endpoint, p256dh, auth, pool_id, asset_symbol, target.lev, unsubToken).run();
  } catch (e: any) {
    console.error("Push DB insert failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }

  const base = workerUrl(request);
  return jsonResponse({
    ok: true,
    message: "Push alerts enabled for this position.",
    unsubscribeUrl: `${base}/push/unsubscribe?token=${unsubToken}`,
  }, 200, env);
}

async function handlePushUnsubscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");

  if (!token) return htmlResponse("<h2>Missing token.</h2>", 400);

  const result = await env.DB.prepare(
    "DELETE FROM push_subscriptions WHERE unsub_token = ?1"
  ).bind(token).run();

  if (!result.meta.changes) {
    return htmlResponse("<h2>Push subscription not found or already removed.</h2>", 404);
  }

  return htmlResponse(`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Unsubscribed</title></head>
<body style="font-family: -apple-system, sans-serif; text-align: center; padding: 60px 20px;">
  <h2>Push Unsubscribed</h2>
  <p>You will no longer receive push APY alerts for this subscription.</p>
</body>
</html>`);
}

// ── Cron handler ─────────────────────────────────────────────────────────────

async function alertEmailSubscribers(
  env: Env,
  pool: (typeof POOLS)[number],
  asset: (typeof POOLS)[number]["assets"][number],
  bracket: number,
  netApy: number,
  rates: ReserveRates,
  base: string,
): Promise<void> {
  const subs = await env.DB.prepare(`
    SELECT id, email, unsub_token
    FROM subscriptions
    WHERE pool_id = ?1
      AND asset_symbol = ?2
      AND leverage_bracket = ?3
      AND verified = 1
      AND (last_alerted_at IS NULL OR last_alerted_at < datetime('now', '-24 hours'))
  `).bind(pool.id, asset.symbol, bracket).all();

  if (!subs.results?.length) return;

  console.log(`[cron] Email alerting ${subs.results.length} subscriber(s) for ${asset.symbol}@${bracket}x on ${pool.name}`);

  for (const sub of subs.results) {
    const unsubUrl = `${base}/unsubscribe?token=${sub.unsub_token}`;
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
      console.error(`[cron] Failed to send email alert to ${sub.email}:`, result.error);
    }
  }
}

async function alertPushSubscribers(
  env: Env,
  pool: (typeof POOLS)[number],
  asset: (typeof POOLS)[number]["assets"][number],
  bracket: number,
  netApy: number,
): Promise<void> {
  if (!env.VAPID_PRIVATE_KEY) return;

  const subs = await env.DB.prepare(`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE pool_id = ?1
      AND asset_symbol = ?2
      AND leverage_bracket = ?3
      AND (last_alerted_at IS NULL OR last_alerted_at < datetime('now', '-24 hours'))
  `).bind(pool.id, asset.symbol, bracket).all();

  if (!subs.results?.length) return;

  console.log(`[cron] Push alerting ${subs.results.length} subscriber(s) for ${asset.symbol}@${bracket}x on ${pool.name}`);

  for (const sub of subs.results) {
    const result = await sendApyPush(
      env,
      {
        endpoint: sub.endpoint as string,
        p256dh: sub.p256dh as string,
        auth: sub.auth as string,
      },
      {
        poolName: pool.name,
        assetSymbol: asset.symbol,
        leverage: bracket,
        netApy,
        appUrl: env.FRONTEND_ORIGIN,
      },
    );

    if (result.ok) {
      await env.DB.prepare(
        "UPDATE push_subscriptions SET last_alerted_at = datetime('now') WHERE id = ?1"
      ).bind(sub.id).run();
    } else if (result.gone) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(sub.id).run();
      console.log(`[cron] Removed expired push subscription ${sub.id}`);
    } else {
      console.error(`[cron] Failed to send push alert to ${sub.endpoint}:`, result.error);
    }
  }
}

/** Persist a rate snapshot for the time-series endpoint + delta arrows. */
async function writeSnapshot(env: Env, pool: { id: string }, asset: { symbol: string }, rates: ReserveRates): Promise<void> {
  try {
    await env.DB.prepare(`
      INSERT INTO rate_snapshots
        (pool_id, asset_symbol, net_supply_apr, net_borrow_cost, interest_supply_apr, interest_borrow_apr, blnd_supply_apr, blnd_borrow_apr, util, c_factor)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
    `).bind(
      pool.id, asset.symbol, rates.netSupplyApr, rates.netBorrowCost,
      rates.interestSupplyApr, rates.interestBorrowApr, rates.blndSupplyApr,
      rates.blndBorrowApr, rates.util, rates.cFactor,
    ).run();
  } catch (e) {
    console.error(`[cron] snapshot insert failed for ${asset.symbol}:`, e);
  }
}

/** Fire HF / liquidation-imminent alerts for verified subscribers. */
async function alertHfSubscribers(
  env: Env,
  pool: { id: string; name: string },
  asset: { symbol: string },
  rates: ReserveRates,
  base: string,
): Promise<void> {
  let rows: any;
  try {
    rows = await env.DB.prepare(`
      SELECT id, email, leverage_bracket, alert_type, hf_threshold, unsub_token, last_fired_at
      FROM subscriptions
      WHERE verified = 1 AND pool_id = ?1 AND asset_symbol = ?2 AND alert_type IN ('hf','liquidation')
    `).bind(pool.id, asset.symbol).all();
  } catch (e) {
    console.error("[cron] HF subscriber query failed:", e);
    return;
  }

  const nowMs = Date.now();
  for (const row of rows?.results ?? []) {
    const lev = Number(row.leverage_bracket);
    const hf = computeHealthFactor(rates, lev);
    const liquidation = row.alert_type === "liquidation";
    const threshold = liquidation ? LIQUIDATION_HF : Number(row.hf_threshold);
    if (!Number.isFinite(threshold) || hf >= threshold) continue;

    // Debounce.
    if (row.last_fired_at) {
      const lastMs = Date.parse((row.last_fired_at as string).replace(" ", "T") + "Z");
      if (Number.isFinite(lastMs) && nowMs - lastMs < HF_ALERT_DEBOUNCE_HOURS * 3600_000) continue;
    }

    const result = await sendHfAlert(
      { RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM: env.RESEND_FROM },
      row.email,
      {
        poolName: pool.name,
        assetSymbol: asset.symbol,
        leverage: lev,
        hf,
        threshold,
        liquidation,
        unsubscribeUrl: `${base}/unsubscribe?token=${row.unsub_token}`,
        appUrl: env.FRONTEND_ORIGIN,
      },
    );
    if (result.ok) {
      await env.DB.prepare(`UPDATE subscriptions SET last_fired_at = datetime('now') WHERE id = ?1`).bind(row.id).run();
    }
  }
}

/** Delete snapshots older than the retention window. */
async function pruneSnapshots(env: Env): Promise<void> {
  try {
    await env.DB.prepare(
      `DELETE FROM rate_snapshots WHERE recorded_at < datetime('now', ?1)`,
    ).bind(`-${SNAPSHOT_RETENTION_DAYS} days`).run();
  } catch (e) {
    console.error("[cron] snapshot prune failed:", e);
  }
}

async function handleCron(env: Env, requestBase?: string): Promise<void> {
  console.log("[cron] rate snapshot + alert check starting...");
  const base = requestBase ?? "https://turbolong-alerts.turbolong.workers.dev";

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

      // Record the snapshot every tick (15 min).
      await writeSnapshot(env, pool, asset, rates);

      // APY-negative alerts.
      for (const bracket of LEVERAGE_BRACKETS) {
        const netApy = computeNetApy(rates, bracket);
        if (netApy >= 0) continue;
        console.log(`[cron] Negative APY: ${asset.symbol} at ${bracket}x on ${pool.name} = ${netApy.toFixed(2)}%`);
        await alertEmailSubscribers(env, pool, asset, bracket, netApy, rates, base);
        await alertPushSubscribers(env, pool, asset, bracket, netApy);
      }

      // Health-factor + liquidation-imminent alerts.
      await alertHfSubscribers(env, pool, asset, rates, base);
    }
  }

  await pruneSnapshots(env);
  console.log("[cron] rate snapshot + alert check complete.");
}

/**
 * Public GET /snapshots — paginated rate time-series.
 * Query: pool_id, asset (symbol), limit (≤500, default 100), before (id cursor).
 */
async function handleSnapshots(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const poolId = url.searchParams.get("pool_id");
  const asset = url.searchParams.get("asset");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);
  const before = url.searchParams.get("before");

  const where: string[] = [];
  const binds: any[] = [];
  if (poolId) { where.push(`pool_id = ?${binds.length + 1}`); binds.push(poolId); }
  if (asset) { where.push(`asset_symbol = ?${binds.length + 1}`); binds.push(asset); }
  if (before) { where.push(`id < ?${binds.length + 1}`); binds.push(Number(before)); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  try {
    const rows = await env.DB.prepare(
      `SELECT id, pool_id, asset_symbol, recorded_at, net_supply_apr, net_borrow_cost,
              interest_supply_apr, interest_borrow_apr, blnd_supply_apr, blnd_borrow_apr, util, c_factor
       FROM rate_snapshots ${whereSql}
       ORDER BY id DESC LIMIT ?${binds.length + 1}`,
    ).bind(...binds, limit).all();
    const results = rows?.results ?? [];
    const nextCursor = results.length === limit ? (results[results.length - 1] as any).id : null;
    return jsonResponse({ snapshots: results, nextCursor }, 200, env);
  } catch (e) {
    console.error("[snapshots] query failed:", e);
    return jsonResponse({ error: "Database error" }, 500, env);
  }
}

// ── Swap-route A/B telemetry (T2.1) ──────────────────────────────────────────

/**
 * POST /swap-routes — keeper ingests one Broker-vs-Soroswap routing record.
 * Auth: `Authorization: Bearer <KEEPER_INGEST_KEY>` (financial telemetry write).
 */
async function handleSwapRoutesPost(request: Request, env: Env): Promise<Response> {
  if (!env.KEEPER_INGEST_KEY) {
    return jsonResponse({ ok: false, error: "Ingestion not configured" }, 503, env);
  }
  const auth = request.headers.get("Authorization") ?? "";
  if (auth !== `Bearer ${env.KEEPER_INGEST_KEY}`) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401, env);
  }

  let b: any;
  try {
    b = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  // Required fields.
  for (const f of ["strategy_id", "asset_symbol", "amount_in", "chosen", "reason", "amount_out_min"]) {
    if (b[f] == null || b[f] === "") {
      return jsonResponse({ ok: false, error: `Missing field: ${f}` }, 400, env);
    }
  }
  if (!["broker", "soroswap"].includes(b.chosen)) {
    return jsonResponse({ ok: false, error: "chosen must be 'broker' or 'soroswap'" }, 400, env);
  }

  try {
    await env.DB.prepare(`
      INSERT INTO swap_routes
        (network, strategy_id, asset_symbol, amount_in, broker_quote, soroswap_quote,
         chosen, reason, executed_out, amount_out_min, slippage_bps, uplift_bps, tx_hash, keeper, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
    `).bind(
      b.network ?? "mainnet", b.strategy_id, b.asset_symbol, String(b.amount_in),
      b.broker_quote != null ? String(b.broker_quote) : null,
      b.soroswap_quote != null ? String(b.soroswap_quote) : null,
      b.chosen, b.reason,
      b.executed_out != null ? String(b.executed_out) : null,
      String(b.amount_out_min),
      b.slippage_bps != null ? Math.round(Number(b.slippage_bps)) : null,
      b.uplift_bps != null ? Math.round(Number(b.uplift_bps)) : null,
      b.tx_hash ?? null, b.keeper ?? null, b.status ?? "executed",
    ).run();
  } catch (e) {
    console.error("[swap-routes] insert failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }
  return jsonResponse({ ok: true }, 200, env);
}

/**
 * GET /swap-routes — public A/B report. Aggregates the Broker-vs-Soroswap
 * win-rate + uplift over executed mainnet harvests, plus the recent rows.
 * Query: network (default mainnet), strategy_id, limit (≤500).
 */
async function handleSwapRoutesGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const network = url.searchParams.get("network") ?? "mainnet";
  const strategyId = url.searchParams.get("strategy_id");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 500);

  const filter: string[] = [`network = ?1`];
  const binds: any[] = [network];
  if (strategyId) { filter.push(`strategy_id = ?${binds.length + 1}`); binds.push(strategyId); }
  const whereSql = `WHERE ${filter.join(" AND ")}`;

  try {
    const agg = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'executed' THEN 1 ELSE 0 END) AS executed,
        SUM(CASE WHEN status = 'executed' AND chosen = 'broker' THEN 1 ELSE 0 END) AS broker_wins,
        AVG(CASE WHEN status = 'executed' THEN uplift_bps END) AS avg_uplift_bps,
        AVG(CASE WHEN status = 'executed' THEN slippage_bps END) AS avg_slippage_bps
      FROM swap_routes ${whereSql}
    `).bind(...binds).first<any>();

    const rows = await env.DB.prepare(`
      SELECT id, ts, network, strategy_id, asset_symbol, amount_in, broker_quote, soroswap_quote,
             chosen, reason, executed_out, amount_out_min, slippage_bps, uplift_bps, tx_hash, status
      FROM swap_routes ${whereSql}
      ORDER BY id DESC LIMIT ?${binds.length + 1}
    `).bind(...binds, limit).all();

    const executed = Number(agg?.executed ?? 0);
    const brokerWins = Number(agg?.broker_wins ?? 0);
    return jsonResponse({
      report: {
        network,
        total: Number(agg?.total ?? 0),
        executed,
        broker_wins: brokerWins,
        broker_win_rate: executed > 0 ? brokerWins / executed : null,
        avg_uplift_bps: agg?.avg_uplift_bps ?? null,
        avg_slippage_bps: agg?.avg_slippage_bps ?? null,
      },
      rows: rows?.results ?? [],
    }, 200, env);
  } catch (e) {
    console.error("[swap-routes] query failed:", e);
    return jsonResponse({ error: "Database error" }, 500, env);
  }
}

// ── Worker entry ─────────────────────────────────────────────────────────────

// ── Stellar Broker WebSocket relay ────────────────────────────────────────────
// The swap UI's broker session connects here instead of api.stellar.broker so
// the partner key never ships in the frontend bundle. Cloudflare proxies the
// WebSocket transparently: we just rewrite the upstream URL, injecting the key.
const BROKER_UPSTREAM = "https://api.stellar.broker/ws";

async function handleBrokerWs(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "Expected WebSocket upgrade" }, 426, env);
  }
  if (!env.STELLAR_BROKER_PARTNER_KEY) {
    return jsonResponse({ error: "Broker relay not configured" }, 503, env);
  }
  // Keep other sites from riding our partner key through this relay. Browsers
  // always send Origin on WebSocket handshakes; non-browser clients gain
  // nothing here they couldn't get from api.stellar.broker directly.
  const origin = request.headers.get("Origin");
  const allowed = new Set([env.FRONTEND_ORIGIN, "http://localhost:5173", "http://127.0.0.1:5173"]);
  if (origin && !allowed.has(origin)) {
    return jsonResponse({ error: "Origin not allowed" }, 403, env);
  }
  const upstream = `${BROKER_UPSTREAM}?partner=${encodeURIComponent(env.STELLAR_BROKER_PARTNER_KEY)}`;
  return fetch(upstream, request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

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

      case "/vapid-public-key":
        if (request.method !== "GET") {
          return jsonResponse({ error: "Method not allowed" }, 405, env);
        }
        return handleVapidPublicKey(env);

      case "/push/subscribe":
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, 405, env);
        }
        return handlePushSubscribe(request, env);

      case "/push/unsubscribe":
        return handlePushUnsubscribe(request, env);

      case "/snapshots":
        if (request.method !== "GET") {
          return jsonResponse({ error: "Method not allowed" }, 405, env);
        }
        return handleSnapshots(request, env);

      case "/swap-routes":
        if (request.method === "POST") return handleSwapRoutesPost(request, env);
        if (request.method === "GET") return handleSwapRoutesGet(request, env);
        return jsonResponse({ error: "Method not allowed" }, 405, env);

      case "/broker/ws":
        return handleBrokerWs(request, env);

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
