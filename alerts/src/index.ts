/**
 * Turbolong APY Alert Worker
 *
 * Routes:
 *   POST /subscribe              — register an email alert subscription
 *   GET  /verify?token=          — verify email
 *   GET  /unsubscribe?token=     — remove email subscription
 *   GET  /vapid-public-key       — VAPID public key for web push
 *   POST /push/subscribe         — register a web-push subscription
 *   GET  /push/unsubscribe?token= — remove web-push subscription
 *
 * Cron (every 15 min):
 *   Fetch pool reserve rates, compute APY per bracket, alert email + push subscribers.
 */

import { POOLS, LEVERAGE_BRACKETS, POOL_NAMES, fetchReserveRates, computeNetApy, type ReserveRates } from "./stellar.ts";
import { sendVerificationEmail, sendApyAlert } from "./email.ts";
import { sendApyPush } from "./push.ts";

interface Env {
  DB: D1Database;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  FRONTEND_ORIGIN: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT?: string;
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

  const verifyToken = generateToken();
  const unsubToken  = generateToken();

  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET verify_token = ?5, unsub_token = ?6, verified = 0
    `).bind(email, pool_id, asset_symbol, target.lev, verifyToken, unsubToken).run();
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

async function handleCron(env: Env, requestBase?: string): Promise<void> {
  console.log("[cron] APY alert check starting...");
  const base = requestBase ?? "https://turbolong-alerts.workers.dev";

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

        if (netApy >= 0) continue;

        console.log(`[cron] Negative APY: ${asset.symbol} at ${bracket}x on ${pool.name} = ${netApy.toFixed(2)}%`);

        await alertEmailSubscribers(env, pool, asset, bracket, netApy, rates, base);
        await alertPushSubscribers(env, pool, asset, bracket, netApy);
      }
    }
  }

  console.log("[cron] APY alert check complete.");
}

// ── Worker entry ─────────────────────────────────────────────────────────────

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

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
