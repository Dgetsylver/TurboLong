interface Env {
  DB: D1Database;
  FRONTEND_ORIGIN: string;
  HORIZON_URL: string;
  POOL_IDS: string;
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

function corsHeaders(env: Env): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*", // Allow all origins for the public API, or restrict to FRONTEND_ORIGIN
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ── Route handlers ───────────────────────────────────────────────────────────

async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400, env);
  }

  const { address, code } = body;

  if (!address || typeof address !== "string" || !address.startsWith("G") || address.length !== 56) {
    return jsonResponse({ ok: false, error: "Invalid address" }, 400, env);
  }

  if (!code || typeof code !== "string" || code.length < 4 || code.length > 15) {
    return jsonResponse({ ok: false, error: "Invalid code" }, 400, env);
  }

  try {
    // Upsert code. If address already has a code, return it. If code already exists for another address, return error.
    const existing = await env.DB.prepare(
      "SELECT code, owner_address FROM referral_codes WHERE owner_address = ?1 OR code = ?2"
    ).bind(address, code).all();

    if (existing.results && existing.results.length > 0) {
      const matchAddress = existing.results.find((r: any) => r.owner_address === address);
      if (matchAddress) {
        return jsonResponse({ ok: true, code: matchAddress.code, message: "Code already registered for this address" }, 200, env);
      }
      // If we got here, the code belongs to someone else
      return jsonResponse({ ok: false, error: "Referral code already taken" }, 400, env);
    }

    await env.DB.prepare(
      "INSERT INTO referral_codes (code, owner_address) VALUES (?1, ?2)"
    ).bind(code, address).run();

    return jsonResponse({ ok: true, code, message: "Referral code successfully registered" }, 200, env);
  } catch (e: any) {
    console.error("DB insert failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }
}

async function handleGetCode(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");

  if (!address) {
    return jsonResponse({ ok: false, error: "Missing address" }, 400, env);
  }

  try {
    const row = await env.DB.prepare(
      "SELECT code FROM referral_codes WHERE owner_address = ?1"
    ).bind(address).first();

    if (!row) {
      return jsonResponse({ ok: true, code: null }, 200, env);
    }

    return jsonResponse({ ok: true, code: row.code }, 200, env);
  } catch (e: any) {
    console.error("DB select failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }
}

async function handleGetStats(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");

  if (!code) {
    return jsonResponse({ ok: false, error: "Missing code" }, 400, env);
  }

  try {
    // Fetch overview stats
    const totalReferrals = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM referral_events WHERE code = ?1"
    ).bind(code).first();

    const uniqueDepositors = await env.DB.prepare(
      "SELECT COUNT(DISTINCT depositor_address) as count FROM referral_events WHERE code = ?1"
    ).bind(code).first();

    // Fetch breakdown per pool
    const poolBreakdown = await env.DB.prepare(
      "SELECT pool_id, COUNT(*) as count, COUNT(DISTINCT depositor_address) as unique_depositors FROM referral_events WHERE code = ?1 GROUP BY pool_id"
    ).bind(code).all();

    // Fetch recent events
    const recentEvents = await env.DB.prepare(
      "SELECT depositor_address, tx_hash, pool_id, indexed_at FROM referral_events WHERE code = ?1 ORDER BY indexed_at DESC LIMIT 10"
    ).bind(code).all();

    return jsonResponse({
      ok: true,
      stats: {
        totalReferrals: totalReferrals?.count ?? 0,
        uniqueDepositors: uniqueDepositors?.count ?? 0,
        poolBreakdown: poolBreakdown.results ?? [],
        recentEvents: recentEvents.results ?? []
      }
    }, 200, env);
  } catch (e: any) {
    console.error("DB stats query failed:", e);
    return jsonResponse({ ok: false, error: "Database error" }, 500, env);
  }
}

// ── Cron Indexer ─────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  console.log("[cron] Referral indexer starting...");
  const poolIds = env.POOL_IDS.split(",");

  for (const poolId of poolIds) {
    if (!poolId) continue;
    console.log(`[cron] Indexing pool: ${poolId}`);

    try {
      // Scrape recent transactions on pool contract account from Horizon
      const horizonUrl = `${env.HORIZON_URL}/accounts/${poolId}/transactions?order=desc&limit=50`;
      const res = await fetch(horizonUrl);
      if (!res.ok) {
        console.error(`[cron] Failed to fetch transactions from Horizon for ${poolId}: ${res.statusText}`);
        continue;
      }

      const data = await res.json() as any;
      const txs = data._embedded?.records ?? [];

      for (const tx of txs) {
        if (tx.memo_type !== "text" || !tx.memo) continue;

        const memoVal = tx.memo.trim();
        if (!memoVal.startsWith("ref:")) continue;

        const referralCode = memoVal.replace("ref:", "").trim();
        if (!referralCode) continue;

        // Verify that this code exists
        const codeRow = await env.DB.prepare(
          "SELECT code FROM referral_codes WHERE code = ?1"
        ).bind(referralCode).first();

        if (!codeRow) {
          // Unregistered code, skip
          continue;
        }

        // Get tx sender (depositor)
        const depositor = tx.source_account;
        const txHash = tx.hash;

        try {
          await env.DB.prepare(`
            INSERT INTO referral_events (code, depositor_address, tx_hash, memo_raw, pool_id)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(tx_hash) DO NOTHING
          `).bind(referralCode, depositor, txHash, memoVal, poolId).run();
        } catch (dbErr) {
          console.error(`[cron] Failed to record event for tx ${txHash}:`, dbErr);
        }
      }
    } catch (e) {
      console.error(`[cron] Exception while indexing ${poolId}:`, e);
    }
  }

  console.log("[cron] Referral indexer complete.");
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
      case "/referrals/register":
        if (request.method !== "POST") {
          return jsonResponse({ error: "Method not allowed" }, 405, env);
        }
        return handleRegister(request, env);

      case "/referrals/code":
        return handleGetCode(request, env);

      case "/referrals/stats":
        return handleGetStats(request, env);

      default:
        return jsonResponse({ error: "Not found" }, 404);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleCron(env));
  },
};
