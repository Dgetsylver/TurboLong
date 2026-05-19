import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  DEFAULT_SUBSCRIBE_RATE_LIMIT_CONFIG,
  decideSubscribeRateLimit,
  type Env,
} from "../src/index.ts";
import { LEVERAGE_BRACKETS, POOLS } from "../src/stellar.ts";

interface RateLimitPayload {
  ok: boolean;
  rate_limit: {
    scope: "email" | "ip";
  };
}

class FakePreparedStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: FakeD1Database,
    private readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakePreparedStatement {
    this.args = args;
    return this;
  }

  async first(column?: string): Promise<unknown> {
    if (this.sql.includes("WHERE email = ?1")) {
      return column ? this.db.emailAttempts : { count: this.db.emailAttempts };
    }
    if (this.sql.includes("WHERE ip_hash = ?1")) {
      return column ? this.db.ipAttempts : { count: this.db.ipAttempts };
    }
    throw new Error(`Unexpected first() SQL: ${this.sql}`);
  }

  async run(): Promise<{ success: boolean; meta: { changes: number } }> {
    if (this.sql.includes("DELETE FROM subscribe_attempts")) {
      return { success: true, meta: { changes: 0 } };
    }
    if (this.sql.includes("INSERT INTO subscribe_attempts")) {
      this.db.insertedAttempts.push(this.args);
      return { success: true, meta: { changes: 1 } };
    }
    throw new Error(`Unexpected run() SQL: ${this.sql}`);
  }
}

class FakeD1Database {
  readonly insertedAttempts: unknown[][] = [];

  constructor(
    readonly emailAttempts: number,
    readonly ipAttempts: number,
  ) {}

  prepare(sql: string): FakePreparedStatement {
    return new FakePreparedStatement(this, sql);
  }
}

function envWithDb(db: FakeD1Database): Env {
  return {
    DB: db as unknown as D1Database,
    RESEND_API_KEY: "test-key",
    RESEND_FROM: "alerts@example.com",
    FRONTEND_ORIGIN: "https://app.example.com",
    SUBSCRIBE_RATE_LIMIT_WINDOW_SECONDS: "3600",
    SUBSCRIBE_RATE_LIMIT_EMAIL_MAX: "5",
    SUBSCRIBE_RATE_LIMIT_IP_MAX: "20",
  };
}

function subscribeRequest(): Request {
  const pool = POOLS[0];
  return new Request("https://alerts.example.com/subscribe", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.42",
    },
    body: JSON.stringify({
      email: "USER@example.com",
      pool_id: pool.id,
      asset_symbol: pool.assets[0].symbol,
      leverage_bracket: LEVERAGE_BRACKETS[0],
    }),
  });
}

test("rejects subscribe requests once the email reaches the configured limit", async () => {
  const db = new FakeD1Database(5, 0);
  const response = await worker.fetch(subscribeRequest(), envWithDb(db));
  const payload = await response.json() as RateLimitPayload;

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "3600");
  assert.equal(payload.ok, false);
  assert.equal(payload.rate_limit.scope, "email");
  assert.equal(db.insertedAttempts.length, 0);
});

test("rejects subscribe requests once the IP reaches the configured limit", async () => {
  const db = new FakeD1Database(0, 20);
  const response = await worker.fetch(subscribeRequest(), envWithDb(db));
  const payload = await response.json() as RateLimitPayload;

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "3600");
  assert.equal(payload.ok, false);
  assert.equal(payload.rate_limit.scope, "ip");
  assert.equal(db.insertedAttempts.length, 0);
});

test("allows a reasonable burst below both configured limits", () => {
  const decision = decideSubscribeRateLimit(
    4,
    19,
    DEFAULT_SUBSCRIBE_RATE_LIMIT_CONFIG,
  );

  assert.equal(decision.allowed, true);
});
