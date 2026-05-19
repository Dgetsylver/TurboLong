/**
 * Daily social-rate poster for Turbolong.
 *
 * Credentials are read only from env:
 * - X_BEARER_TOKEN: OAuth2 user-context bearer token for POST /2/tweets
 * - NEYNAR_API_KEY and NEYNAR_SIGNER_UUID: Farcaster cast credentials
 *
 * Run `npm run daily-post:dry-run` to preview the X/Farcaster-safe posts
 * without sending anything.
 */
import { POOLS, LEVERAGE_BRACKETS, computeNetApy, fetchReserveRates, type PoolDef, type ReserveRates } from "../alerts/src/stellar.ts";

interface PostDraft {
  pool: string;
  text: string;
}

interface PostResult {
  channel: "x" | "farcaster";
  ok: boolean;
  error?: string;
}

const MAX_POST_LENGTH = 280;
const BOT_NAME = "Turbolong Daily Rates";

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function chunkLines(header: string, lines: string[]): string[] {
  const chunks: string[] = [];
  let current = header;
  for (const line of lines) {
    const next = `${current}\n${line}`;
    if (next.length <= MAX_POST_LENGTH) {
      current = next;
    } else {
      chunks.push(current);
      current = `${header}\n${line}`;
    }
  }
  chunks.push(current);
  return chunks;
}

function formatPoolPosts(pool: PoolDef, rows: { symbol: string; rates: ReserveRates }[]): PostDraft[] {
  const header = `${BOT_NAME} ${todayUtc()}\n${pool.name} net APY`;
  const lines = rows.map(({ symbol, rates }) => {
    const ratesByLev = LEVERAGE_BRACKETS.map(lev => `${lev}x ${pct(computeNetApy(rates, lev))}`).join(" | ");
    return `${symbol}: ${ratesByLev}`;
  });
  return chunkLines(header, lines).map(text => ({ pool: pool.name, text }));
}

export async function buildDailyRatePosts(): Promise<PostDraft[]> {
  const drafts: PostDraft[] = [];
  for (const pool of POOLS) {
    const rows: { symbol: string; rates: ReserveRates }[] = [];
    for (const asset of pool.assets) {
      const rates = await fetchReserveRates(pool, asset);
      if (!rates) {
        console.warn(`[daily-post] Skipping ${asset.symbol} on ${pool.name}: rates unavailable`);
        continue;
      }
      rows.push({ symbol: asset.symbol, rates });
    }
    if (rows.length) drafts.push(...formatPoolPosts(pool, rows));
  }
  return drafts;
}

async function postToX(text: string): Promise<PostResult> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return { channel: "x", ok: false, error: "X_BEARER_TOKEN is not set" };

  try {
    const res = await fetch("https://api.twitter.com/2/tweets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { channel: "x", ok: false, error: `X API ${res.status}: ${await res.text()}` };
    return { channel: "x", ok: true };
  } catch (error) {
    return { channel: "x", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function postToFarcaster(text: string): Promise<PostResult> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;
  if (!apiKey || !signerUuid) {
    return { channel: "farcaster", ok: false, error: "NEYNAR_API_KEY or NEYNAR_SIGNER_UUID is not set" };
  }

  try {
    const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: {
        "api_key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ signer_uuid: signerUuid, text }),
    });
    if (!res.ok) return { channel: "farcaster", ok: false, error: `Neynar ${res.status}: ${await res.text()}` };
    return { channel: "farcaster", ok: true };
  } catch (error) {
    return { channel: "farcaster", ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function publishDrafts(drafts: PostDraft[], dryRun: boolean): Promise<PostResult[]> {
  if (dryRun) {
    for (const [i, draft] of drafts.entries()) {
      console.log(`\n--- post ${i + 1}/${drafts.length} (${draft.pool}, ${draft.text.length} chars) ---`);
      console.log(draft.text);
    }
    return [];
  }

  const results: PostResult[] = [];
  for (const draft of drafts) {
    const channelResults = await Promise.all([postToX(draft.text), postToFarcaster(draft.text)]);
    for (const result of channelResults) {
      results.push(result);
      if (result.ok) {
        console.log(`[daily-post] Posted ${draft.pool} update to ${result.channel}`);
      } else {
        console.warn(`[daily-post] ${result.channel} post failed for ${draft.pool}: ${result.error}`);
      }
    }
  }
  return results;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const drafts = await buildDailyRatePosts();
  if (!drafts.length) {
    console.warn("[daily-post] No post drafts generated.");
    return;
  }

  const tooLong = drafts.filter(draft => draft.text.length > MAX_POST_LENGTH);
  if (tooLong.length) {
    throw new Error(`Generated ${tooLong.length} post(s) over ${MAX_POST_LENGTH} chars`);
  }

  await publishDrafts(drafts, dryRun);
}

main().catch(error => {
  console.error("[daily-post] Fatal:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
