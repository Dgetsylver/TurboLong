import { checkSubscribeRateLimit } from "./rateLimit.ts";
import worker from "./index.ts";

// ── In-Memory Mock of D1 Database ───────────────────────────────────────────

class MockD1Database {
  public hits: { key: string; hit_at: string }[] = [];

  prepare(sql: string) {
    const cleanSql = sql.replace(/\s+/g, " ").trim();
    return {
      bind: (...args: any[]) => {
        return {
          run: async () => {
            if (cleanSql.startsWith("DELETE FROM rate_limit_hits")) {
              const [key, hit_at] = args;
              const beforeCount = this.hits.length;
              this.hits = this.hits.filter(h => !(h.key === key && h.hit_at < hit_at));
              const changes = beforeCount - this.hits.length;
              return { meta: { changes } };
            } else if (cleanSql.startsWith("INSERT INTO rate_limit_hits")) {
              const [key, hit_at] = args;
              this.hits.push({ key, hit_at });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          first: async <T>() => {
            if (cleanSql.includes("COUNT(*)")) {
              const [key, hit_at] = args;
              const count = this.hits.filter(h => h.key === key && h.hit_at >= hit_at).length;
              return { cnt: count } as unknown as T;
            } else if (cleanSql.includes("ORDER BY hit_at ASC")) {
              const [key, hit_at] = args;
              const filtered = this.hits.filter(h => h.key === key && h.hit_at >= hit_at);
              // Sort chronologically
              filtered.sort((a, b) => new Date(a.hit_at).getTime() - new Date(b.hit_at).getTime());
              return (filtered[0] || null) as unknown as T;
            }
            return null;
          },
          all: async () => {
            return { results: [] };
          }
        };
      }
    };
  }
}

// ── Test Runner Helper ──────────────────────────────────────────────────────

async function assertReject(promise: Promise<any>, message: string) {
  try {
    await promise;
    throw new Error(`Expected rejection but passed: ${message}`);
  } catch {
    // Pass
  }
}

function assertEquals(actual: any, expected: any, message: string) {
  if (actual !== expected) {
    throw new Error(`Assert failed: ${message}\nExpected: ${expected}\nActual:   ${actual}`);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function runTests() {
  console.log("🧪 Running Rate Limiter Unit and Integration Tests...\n");

  const db = new MockD1Database() as any;
  const env = {
    DB: db,
    RESEND_API_KEY: "re_dummy",
    RESEND_FROM: "alerts@turbolong.com",
    FRONTEND_ORIGIN: "https://app.turbolong.com",
    RATE_LIMIT_IP_MAX: "3",         // limit to 3 hits for easy testing
    RATE_LIMIT_IP_WINDOW_S: "10",   // short window of 10s
    RATE_LIMIT_EMAIL_MAX: "2",      // limit to 2 hits for email
    RATE_LIMIT_EMAIL_WINDOW_S: "20"
  };

  // Test 1: IP rate limit check (3 hits allowed)
  console.log("  - Test 1: IP rate limit bucket enforces limit of 3");
  const ip = "1.1.1.1";
  const email1 = "test1@example.com";

  // First hit
  let res = await checkSubscribeRateLimit(db, ip, email1, env);
  assertEquals(res, null, "1st hit should be allowed");

  // Second hit
  res = await checkSubscribeRateLimit(db, ip, "test2@example.com", env);
  assertEquals(res, null, "2nd hit should be allowed");

  // Third hit
  res = await checkSubscribeRateLimit(db, ip, "test3@example.com", env);
  assertEquals(res, null, "3rd hit should be allowed");

  // Fourth hit (should be blocked)
  res = await checkSubscribeRateLimit(db, ip, "test4@example.com", env);
  if (!res) throw new Error("4th hit should be blocked");
  assertEquals(res.allowed, false, "Allowed should be false");
  assertEquals(res.limit, 3, "Limit should match configuration");
  if (res.retryAfter <= 0) throw new Error("RetryAfter should be positive");

  // Test 2: Email rate limit check (2 hits allowed, independent of IP)
  console.log("  - Test 2: Email rate limit bucket enforces limit of 2");
  const email2 = "spam@example.com";
  // Reset DB
  db.hits = [];

  // Hit from IP A
  res = await checkSubscribeRateLimit(db, "2.2.2.2", email2, env);
  assertEquals(res, null, "Email hit 1 should be allowed");

  // Hit from IP B
  res = await checkSubscribeRateLimit(db, "3.3.3.3", email2, env);
  assertEquals(res, null, "Email hit 2 should be allowed");

  // Hit from IP C (should exceed limit)
  res = await checkSubscribeRateLimit(db, "4.4.4.4", email2, env);
  if (!res) throw new Error("Email hit 3 should be blocked");
  assertEquals(res.allowed, false, "Allowed should be false");
  assertEquals(res.limit, 2, "Email limit should match configuration");

  // Test 3: Integration test via worker fetch() handler
  console.log("  - Test 3: Worker fetch handler returns 429 and Retry-After header");
  db.hits = [];

  const makeRequest = (ipAddr: string, emailAddr: string) => {
    return new Request("https://turbolong-alerts.workers.dev/subscribe", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": ipAddr,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: emailAddr,
        pool_id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
        asset_symbol: "USDC",
        leverage_bracket: 2.0
      })
    });
  };

  // 1st request
  let response = await worker.fetch(makeRequest("5.5.5.5", "user@test.com"), env);
  // Note: verification email will try to send and fail because RESEND_API_KEY is dummy, returning 500.
  // But rate limiting happens BEFORE that, so let's verify it gets past rate limiter (status != 429).
  if (response.status === 429) {
    throw new Error("1st request should not be rate limited");
  }

  // 2nd request
  response = await worker.fetch(makeRequest("5.5.5.5", "user@test.com"), env);
  if (response.status === 429) {
    throw new Error("2nd request should not be rate limited");
  }

  // 3rd request (hits IP limit = 3)
  response = await worker.fetch(makeRequest("5.5.5.5", "user2@test.com"), env);
  if (response.status === 429) {
    throw new Error("3rd request should not be rate limited");
  }

  // 4th request (should return 429)
  response = await worker.fetch(makeRequest("5.5.5.5", "user3@test.com"), env);
  assertEquals(response.status, 429, "4th request should return 429");
  
  const body = await response.json() as any;
  assertEquals(body.ok, false, "JSON ok should be false");
  if (!body.error.includes("Too many requests")) {
    throw new Error("Unexpected error message: " + body.error);
  }
  
  const retryHeader = response.headers.get("Retry-After");
  if (!retryHeader || Number(retryHeader) <= 0) {
    throw new Error("Missing or invalid Retry-After header: " + retryHeader);
  }

  // Test 4: Sliding window pruning
  console.log("  - Test 4: Prunes expired entries correctly");
  db.hits = [];
  
  // Add an entry dated 30 seconds ago (expired)
  const expiredTime = new Date(Date.now() - 30 * 1000).toISOString();
  db.hits.push({ key: "ip:6.6.6.6", hit_at: expiredTime });
  
  // Call rate limiter (should prune the expired entry and allow)
  res = await checkSubscribeRateLimit(db, "6.6.6.6", "fresh@example.com", env);
  assertEquals(res, null, "Should allow request and prune old entry");
  assertEquals(db.hits.filter((h: any) => h.key === "ip:6.6.6.6").length, 1, "Should only have the new hit");

  console.log("\n✅ All tests passed successfully!");
}

runTests().catch(err => {
  console.error("\n❌ Test run failed!");
  console.error(err);
  process.exit(1);
});
