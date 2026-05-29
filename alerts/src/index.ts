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
import { sendVerificationEmail, sendApyAlert, sendDailyDigest, type DigestPosition } from "./email.ts";

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

  // Parse and validate optional digest_hour
  const rawDigestHour = body.digest_hour;
  let digestEnabled = 0;
  let digestHour: number | null = null;

  if (rawDigestHour !== undefined && rawDigestHour !== null) {
    const dh = Number(rawDigestHour);
    if (!Number.isInteger(dh) || dh < 0 || dh > 23) {
      return jsonResponse(
        { ok: false, error: "digest_hour must be an integer between 0 and 23 (UTC hour)" },
        400,
        env,
      );
    }
    digestEnabled = 1;
    digestHour = dh;
  }

  try {
    await env.DB.prepare(`
      INSERT INTO subscriptions
        (email, pool_id, asset_symbol, leverage_bracket, verify_token, unsub_token,
         digest_enabled, digest_hour)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(email, pool_id, asset_symbol, leverage_bracket) DO UPDATE
        SET verify_token   = ?5,
            unsub_token    = ?6,
            verified       = 0,
            digest_enabled = ?7,
            digest_hour    = ?8
    `).bind(email, pool_id, asset_symbol, lev, verifyToken, unsubToken, digestEnabled, digestHour).run();
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

// ── Digest cron handler ───────────────────────────────────────────────────────

async function handleDigestCron(env: Env): Promise<void> {
  const currentHour = new Date().getUTCHours();
  console.log(`[digest] Starting daily digest for UTC hour ${currentHour}...`);

  // Query all verified subscribers due for a digest at this hour.
  // The 23-hour guard prevents duplicate sends if the cron fires more than once per hour.
  let rows: any[];
  try {
    const result = await env.DB.prepare(`
      SELECT id, email, pool_id, asset_symbol, leverage_bracket, unsub_token
      FROM subscriptions
      WHERE verified = 1
        AND digest_enabled = 1
        AND digest_hour = ?1
        AND (last_digest_at IS NULL OR last_digest_at < datetime('now', '-23 hours'))
      ORDER BY email
    `).bind(currentHour).all();
    rows = result.results ?? [];
  } catch (e) {
    console.error("[digest] DB query failed:", e);
    return;
  }

  if (!rows.length) {
    console.log("[digest] No subscribers due for a digest this hour.");
    return;
  }

  // Group rows by email
  const byEmail = new Map<string, typeof rows>();
  for (const row of rows) {
    const email = row.email as string;
    if (!byEmail.has(email)) byEmail.set(email, []);
    byEmail.get(email)!.push(row);
  }

  console.log(`[digest] Sending digests to ${byEmail.size} subscriber(s)...`);

  // Build a pool+asset lookup for fast access
  const poolMap = new Map<string, typeof POOLS[0]>();
  for (const pool of POOLS) poolMap.set(pool.id, pool);

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const [email, emailRows] of byEmail) {
    // Fetch rates for each position and build digest data
    const positions: DigestPosition[] = [];

    for (const row of emailRows) {
      const pool = poolMap.get(row.pool_id as string);
      const asset = pool?.assets.find(a => a.symbol === (row.asset_symbol as string));

      if (!pool || !asset) {
        console.warn(`[digest] Unknown pool/asset for row id=${row.id}: ${row.pool_id}/${row.asset_symbol}`);
        positions.push({
          poolName: (row.pool_id as string).slice(0, 8) + "…",
          assetSymbol: row.asset_symbol as string,
          leverage: row.leverage_bracket as number,
          hf: null,
          yield24h: null,
          netApy: null,
        });
        continue;
      }

      let rates: ReserveRates | null = null;
      try {
        rates = await fetchReserveRates(pool, asset);
      } catch (e) {
        console.error(`[digest] fetchReserveRates failed for ${asset.symbol} on ${pool.name}:`, e);
      }

      if (!rates) {
        positions.push({
          poolName: pool.name,
          assetSymbol: asset.symbol,
          leverage: row.leverage_bracket as number,
          hf: null,
          yield24h: null,
          netApy: null,
        });
        continue;
      }

      const leverage = row.leverage_bracket as number;
      const netApy   = computeNetApy(rates, leverage);
      const yield24h = netApy / 365;
      const hf       = rates.totalBorrow > 0
        ? rates.totalSupply / rates.totalBorrow
        : Infinity;

      positions.push({ poolName: pool.name, assetSymbol: asset.symbol, leverage, hf, yield24h, netApy });
    }

    // Use the first row's unsub_token — all rows share the same email
    const unsubToken = emailRows[0].unsub_token as string;
    const unsubUrl   = `https://turbolong-alerts.workers.dev/unsubscribe?token=${unsubToken}`;

    const result = await sendDailyDigest(
      { RESEND_API_KEY: env.RESEND_API_KEY, RESEND_FROM: env.RESEND_FROM },
      email,
      { date: today, positions, unsubscribeUrl: unsubUrl, appUrl: env.FRONTEND_ORIGIN },
    );

    if (result.ok) {
      // Update last_digest_at for all rows in this email group
      const ids = emailRows.map(r => r.id as number);
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(", ");
      await env.DB.prepare(
        `UPDATE subscriptions SET last_digest_at = datetime('now') WHERE id IN (${placeholders})`
      ).bind(...ids).run();
      console.log(`[digest] Sent digest to ${email} (${positions.length} position(s))`);
    } else {
      console.error(`[digest] Failed to send digest to ${email}:`, result.error);
    }
  }

  console.log("[digest] Daily digest run complete.");
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

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case "*/15 * * * *":
        ctx.waitUntil(handleCron(env));
        break;
      case "0 * * * *":
        ctx.waitUntil(handleDigestCron(env));
        break;
      default:
        console.warn(`[scheduled] Unknown cron expression: ${event.cron}`);
    }
  },
};
