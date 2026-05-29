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
import { sendVerificationEmail, sendApyAlert, sendHealthFactorAlert } from "./email.ts";

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
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  const { email, pool_id, asset_symbol, leverage_bracket, hf_threshold } = body;

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

  const hfThreshold = hf_threshold != null ? Number(hf_threshold) : null;
  if (hfThreshold !== null && (isNaN(hfThreshold) || hfThreshold < 1.0)) {
    return jsonResponse({ ok: false, error: "Health factor threshold must be at least 1.0" }, 400, env);
  }

  const verifyToken = generateToken();
  const unsubToken  = generateToken();

  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions (email, pool_id, asset_symbol, leverage_bracket, hf_threshold, verify_token, unsub_token, hf_breached)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET hf_threshold = ?5, verify_token = ?6, unsub_token = ?7, verified = 0, hf_breached = 0
    `).bind(email, pool_id, asset_symbol, lev, hfThreshold, verifyToken, unsubToken).run();
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

// ── Cron handler ─────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
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

        const cFactor = rates.cFactor || 0.9;
        const lFactor = rates.lFactor || 1.0;
        const currentHf = bracket <= 1 ? Infinity : (cFactor * bracket) / ((bracket - 1) / lFactor);

        // Find verified subscribers
        const subs = await env.DB.prepare(`
          SELECT id, email, unsub_token, hf_threshold, hf_breached, last_alerted_at
          FROM subscriptions
          WHERE pool_id = ?1
            AND asset_symbol = ?2
            AND leverage_bracket = ?3
            AND verified = 1
        `).bind(pool.id, asset.symbol, bracket).all();

        if (!subs.results?.length) continue;

        for (const sub of subs.results) {
          const hfThreshold = sub.hf_threshold != null ? Number(sub.hf_threshold) : null;
          const hfBreached = sub.hf_breached != null ? Number(sub.hf_breached) : 0;
          const lastAlertedAt = sub.last_alerted_at as string | null;

          const unsubUrl = `https://turbolong-alerts.workers.dev/unsubscribe?token=${sub.unsub_token}`;

          if (hfThreshold !== null) {
            // Health Factor Alert Logic
            if (currentHf < hfThreshold) {
              if (hfBreached === 0) {
                console.log(`[cron] Health Factor breach: ${asset.symbol}@${bracket}x on ${pool.name} = ${currentHf.toFixed(3)} (threshold: ${hfThreshold})`);

                const result = await sendHealthFactorAlert(
                  { RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM: env.RESEND_FROM },
                  sub.email as string,
                  {
                    poolName: pool.name,
                    assetSymbol: asset.symbol,
                    leverage: bracket,
                    currentHf,
                    threshold: hfThreshold,
                    unsubscribeUrl: unsubUrl,
                    appUrl: env.FRONTEND_ORIGIN,
                  }
                );

                if (result.ok) {
                  await env.DB.prepare(`
                    UPDATE subscriptions
                    SET last_alerted_at = datetime('now'),
                        hf_breached = 1
                    WHERE id = ?1
                  `).bind(sub.id).run();
                } else {
                  console.error(`[cron] Failed to send HF alert to ${sub.email}:`, result.error);
                }
              }
            } else {
              // currentHf >= hfThreshold -> Healed
              if (hfBreached === 1) {
                console.log(`[cron] Health Factor healed: ${asset.symbol}@${bracket}x on ${pool.name} = ${currentHf.toFixed(3)}`);
                await env.DB.prepare(`
                  UPDATE subscriptions
                  SET hf_breached = 0
                  WHERE id = ?1
                `).bind(sub.id).run();
              }
            }
          } else {
            // APY Alert Logic
            if (netApy < 0) {
              const isCoolDownOver = !lastAlertedAt ||
                (new Date().getTime() - new Date(lastAlertedAt).getTime() > 24 * 60 * 60 * 1000);

              if (isCoolDownOver) {
                console.log(`[cron] Negative APY: ${asset.symbol} at ${bracket}x on ${pool.name} = ${netApy.toFixed(2)}%`);

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
                  }
                );

                if (result.ok) {
                  await env.DB.prepare(`
                    UPDATE subscriptions
                    SET last_alerted_at = datetime('now')
                    WHERE id = ?1
                  `).bind(sub.id).run();
                } else {
                  console.error(`[cron] Failed to send APY alert to ${sub.email}:`, result.error);
                }
              }
            }
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

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
