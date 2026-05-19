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

import { POOLS, LEVERAGE_BRACKETS, POOL_NAMES, fetchReserveRates, computeNetApy, computeHealthFactor, type ReserveRates } from "./stellar.ts";
import { sendVerificationEmail, sendApyAlert, sendDailySummaryEmail, type DailySummaryRow } from "./email.ts";

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
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Known pool IDs for validation. */
const KNOWN_POOL_IDS = new Set(POOLS.flatMap(p => [p.id]));

/** All known asset symbols across pools. */
const KNOWN_SYMBOLS = new Set(POOLS.flatMap(p => p.assets.map(a => a.symbol)));
const STELLAR_ACCOUNT_RE = /^G[A-Z2-7]{55}$/;
const WORKER_ORIGIN = "https://turbolong-alerts.workers.dev";

let dailySummarySchemaReady = false;

async function ensureDailySummarySchema(env: Env): Promise<void> {
  if (dailySummarySchemaReady) return;
  const statements = [
    "ALTER TABLE subscriptions ADD COLUMN wallet_address TEXT",
    "ALTER TABLE subscriptions ADD COLUMN daily_summary_enabled INTEGER DEFAULT 0",
    "ALTER TABLE subscriptions ADD COLUMN summary_utc_hour INTEGER",
    "ALTER TABLE subscriptions ADD COLUMN summary_equity_usd REAL",
    "ALTER TABLE subscriptions ADD COLUMN last_summary_at TEXT",
    "ALTER TABLE subscriptions ADD COLUMN last_summary_net_apy REAL",
    "ALTER TABLE subscriptions ADD COLUMN last_summary_hf REAL",
    "CREATE INDEX IF NOT EXISTS idx_subs_daily_summary ON subscriptions(daily_summary_enabled, summary_utc_hour, last_summary_at)",
  ];

  for (const sql of statements) {
    try {
      await env.DB.prepare(sql).run();
    } catch (e: any) {
      const msg = String(e?.message ?? e).toLowerCase();
      if (!msg.includes("duplicate column")) {
        throw e;
      }
    }
  }
  dailySummarySchemaReady = true;
}

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

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  await ensureDailySummarySchema(env);

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

  const dailySummary = body.daily_summary === true || body.daily_summary === "true";
  const summaryHour = Number(body.summary_utc_hour);
  if (dailySummary && (!Number.isInteger(summaryHour) || summaryHour < 0 || summaryHour > 23)) {
    return jsonResponse({ ok: false, error: "Daily summary hour must be an integer from 0 to 23 UTC" }, 400, env);
  }

  const walletAddress = typeof body.wallet_address === "string" ? body.wallet_address.trim() : "";
  if (walletAddress && !STELLAR_ACCOUNT_RE.test(walletAddress)) {
    return jsonResponse({ ok: false, error: "Invalid Stellar wallet address" }, 400, env);
  }

  const equityUsd = Number(body.equity_usd);
  const summaryEquityUsd = dailySummary && Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd : null;

  const verifyToken = generateToken();
  const unsubToken  = generateToken();

  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (
        email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token,
        wallet_address, daily_summary_enabled, summary_utc_hour, summary_equity_usd
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET verify_token = ?5,
            unsub_token = ?6,
            verified = 0,
            wallet_address = ?7,
            daily_summary_enabled = ?8,
            summary_utc_hour = ?9,
            summary_equity_usd = ?10
    `).bind(
      email,
      pool_id,
      asset_symbol,
      lev,
      verifyToken,
      unsubToken,
      walletAddress || null,
      dailySummary ? 1 : 0,
      dailySummary ? summaryHour : null,
      summaryEquityUsd,
    ).run();
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
  <p>You'll receive alerts and any daily summaries you opted into.</p>
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

// ── Cron handler ─────────────────────────────────────────────────────────────

interface DailySummarySubscription {
  id: number;
  email: string;
  pool_id: string;
  asset_symbol: string;
  leverage_bracket: number;
  unsub_token: string;
  summary_utc_hour: number;
  summary_equity_usd: number | null;
  last_summary_net_apy: number | null;
  last_summary_hf: number | null;
}

function unsubscribeUrl(token: string): string {
  return `${WORKER_ORIGIN}/unsubscribe?token=${token}`;
}

async function sendDailySummaries(env: Env): Promise<void> {
  const hour = new Date().getUTCHours();
  const due = await env.DB.prepare(`
    SELECT id, email, pool_id, asset_symbol, leverage_bracket, unsub_token,
           summary_utc_hour, summary_equity_usd, last_summary_net_apy, last_summary_hf
    FROM subscriptions
    WHERE verified = 1
      AND daily_summary_enabled = 1
      AND summary_utc_hour = ?1
      AND (last_summary_at IS NULL OR last_summary_at < datetime('now', '-23 hours'))
    ORDER BY email, pool_id, asset_symbol, leverage_bracket
  `).bind(hour).all();

  const subscriptions = (due.results ?? []) as unknown as DailySummarySubscription[];
  if (!subscriptions.length) {
    console.log(`[daily-summary] No subscribers due for ${hour}:00 UTC`);
    return;
  }

  const grouped = new Map<string, { rows: DailySummaryRow[]; updates: { id: number; netApy: number; hf: number }[]; unsubToken: string }>();
  const rateCache = new Map<string, ReserveRates | null>();

  for (const sub of subscriptions) {
    const pool = POOLS.find(p => p.id === sub.pool_id);
    const asset = pool?.assets.find(a => a.symbol === sub.asset_symbol);
    if (!pool || !asset) {
      console.warn(`[daily-summary] Skipping unknown subscription ${sub.id}`);
      continue;
    }

    const cacheKey = `${pool.id}:${asset.symbol}`;
    let rates = rateCache.get(cacheKey);
    if (rates === undefined) {
      rates = await fetchReserveRates(pool, asset);
      rateCache.set(cacheKey, rates);
    }
    if (!rates) {
      console.warn(`[daily-summary] No rates for ${asset.symbol} on ${pool.name}`);
      continue;
    }

    const leverage = Number(sub.leverage_bracket);
    const netApy = computeNetApy(rates, leverage);
    const healthFactor = computeHealthFactor(rates, leverage);
    const lastHf = sub.last_summary_hf == null ? null : Number(sub.last_summary_hf);
    const equityUsd = sub.summary_equity_usd == null ? null : Number(sub.summary_equity_usd);
    const netYieldUsd = equityUsd !== null && Number.isFinite(equityUsd)
      ? equityUsd * (netApy / 100) / 365
      : null;

    const digest = grouped.get(sub.email) ?? { rows: [], updates: [], unsubToken: sub.unsub_token };
    digest.rows.push({
      poolName: pool.name,
      assetSymbol: asset.symbol,
      leverage,
      equityUsd,
      netApy,
      healthFactor,
      healthFactorDelta: lastHf === null ? null : healthFactor - lastHf,
      netYieldUsd,
    });
    digest.updates.push({ id: sub.id, netApy, hf: healthFactor });
    grouped.set(sub.email, digest);
  }

  for (const [email, digest] of grouped) {
    if (!digest.rows.length) continue;
    const result = await sendDailySummaryEmail(
      { RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM: env.RESEND_FROM },
      email,
      {
        summaryUtcHour: hour,
        rows: digest.rows,
        unsubscribeUrl: unsubscribeUrl(digest.unsubToken),
        appUrl: env.FRONTEND_ORIGIN,
      },
    );

    if (!result.ok) {
      console.error(`[daily-summary] Failed to send summary to ${email}:`, result.error);
      continue;
    }

    for (const update of digest.updates) {
      await env.DB.prepare(`
        UPDATE subscriptions
        SET last_summary_at = datetime('now'),
            last_summary_net_apy = ?2,
            last_summary_hf = ?3
        WHERE id = ?1
      `).bind(update.id, update.netApy, update.hf).run();
    }
    console.log(`[daily-summary] Sent ${digest.rows.length} row(s) to ${email}`);
  }
}

async function handleCron(env: Env): Promise<void> {
  await ensureDailySummarySchema(env);
  console.log("[cron] APY alert check starting...");

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
          const unsubUrl = unsubscribeUrl(sub.unsub_token as string);
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

  await sendDailySummaries(env);

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

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
