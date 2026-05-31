/**
 * Daily snapshot bot — posts net APY for each pool/asset to X (Twitter) and Farcaster.
 *
 * Environment variables:
 *   STELLAR_RPC_URL              (default: https://soroban-rpc.creit.tech/)
 *   BLND_PRICE_API               optional CoinGecko API key (no key = public tier)
 *   X_API_KEY                    Twitter API v2 consumer key
 *   X_API_SECRET                 Twitter API v2 consumer secret
 *   X_ACCESS_TOKEN               Twitter API v2 access token
 *   X_ACCESS_SECRET              Twitter API v2 access secret
 *   NEYNAR_API_KEY               Neynar API key
 *   NEYNAR_SIGNER_UUID           Neynar signer UUID
 *
 * Usage:
 *   npx tsx scripts/daily_post.ts
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

// ── Constants ────────────────────────────────────────────────────────────────

const RPC_URL = process.env.STELLAR_RPC_URL || "https://soroban-rpc.creit.tech/";
const NETWORK = Networks.PUBLIC;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const RATE_DEC = 1_000_000_000_000n;
const SCALAR = 10_000_000n;
const SCALAR_F = 10_000_000;
const SECONDS_PER_YEAR = 31_536_000;
const LEVERAGE_BRACKETS = [2, 3, 5, 8, 10];

const server = new SorobanRpc.Server(RPC_URL);

// ── Pool definitions (mainnet active pools) ──────────────────────────────────

interface AssetDef {
  id: string;
  symbol: string;
  reserveIndex: number;
}

interface PoolDef {
  id: string;
  name: string;
  oracleId: string;
  oracleDec: number;
  backstopFP: number;
  assets: AssetDef[];
}

const POOLS: PoolDef[] = [
  {
    id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
    name: "Etherfuse",
    oracleId: "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS",
    oracleDec: 1e14,
    backstopFP: 2_000_000,
    assets: [
      { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM", reserveIndex: 0 },
      { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC", reserveIndex: 1 },
      { id: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", symbol: "CETES", reserveIndex: 2 },
      { id: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", symbol: "USTRY", reserveIndex: 3 },
      { id: "CD6M4R2322BYCY2LNWM74PEBQAQ63SA3DUJLI3L4225U4ZVCLMSCBCIS", symbol: "TESOURO", reserveIndex: 4 },
    ],
  },
  {
    id: "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    name: "Fixed",
    oracleId: "CCVTVW2CVA7JLH4ROQGP3CU4T3EXVCK66AZGSM4MUQPXAI4QHCZPOATS",
    oracleDec: 1e7,
    backstopFP: 2_000_000,
    assets: [
      { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM", reserveIndex: 0 },
      { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC", reserveIndex: 1 },
      { id: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", symbol: "EURC", reserveIndex: 2 },
    ],
  },
];

// ── Soroban simulation helper ────────────────────────────────────────────────

async function simulate(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op).setTimeout(30).build();
  const result = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(result)) {
    return null;
  }
  return scValToNative(result.result!.retval);
}

// ── BLND price fetch ─────────────────────────────────────────────────────────

let _blndPrice: number | null = null;

async function fetchBlndPrice(): Promise<number> {
  if (_blndPrice !== null) return _blndPrice;
  try {
    const apiKey = process.env.BLND_PRICE_API || "";
    const url = apiKey
      ? `https://api.coingecko.com/api/v3/simple/price?ids=blend&vs_currencies=usd&x_cg_pro_api_key=${apiKey}`
      : "https://api.coingecko.com/api/v3/simple/price?ids=blend&vs_currencies=usd";
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json() as any;
      _blndPrice = data.blend?.usd ?? 0;
    }
  } catch (e) {
    console.error("Failed to fetch BLND price:", e);
  }
  if (_blndPrice === null) _blndPrice = 0;
  return _blndPrice;
}

// ── Reserve rates & APY computation ──────────────────────────────────────────

interface ReserveRates {
  netSupplyApr: number;
  netBorrowCost: number;
  interestSupplyApr: number;
  interestBorrowApr: number;
  blndSupplyApr: number;
  blndBorrowApr: number;
  totalSupply: number;
  totalBorrow: number;
  priceUsd: number;
  util: number;
}

async function fetchReserveRates(pool: PoolDef, asset: AssetDef): Promise<ReserveRates | null> {
  try {
    const poolContract = new Contract(pool.id);
    const oracle = new Contract(pool.oracleId);

    const [reserveRaw, priceRaw, supplyEmissions, borrowEmissions, blndPrice] = await Promise.all([
      simulate(poolContract.call("get_reserve", new Address(asset.id).toScVal())),
      simulate(oracle.call("lastprice", new Address(asset.id).toScVal())),
      simulate(poolContract.call("get_reserve_emissions", nativeToScVal(asset.reserveIndex * 2 + 1, { type: "u32" }))),
      simulate(poolContract.call("get_reserve_emissions", nativeToScVal(asset.reserveIndex * 2, { type: "u32" }))),
      fetchBlndPrice(),
    ]);

    if (!reserveRaw) return null;

    const priceUsd = priceRaw?.price != null
      ? Number(BigInt(priceRaw.price)) / pool.oracleDec
      : 0;

    const bRate = BigInt(reserveRaw.data?.b_rate ?? RATE_DEC);
    const dRate = BigInt(reserveRaw.data?.d_rate ?? RATE_DEC);
    const bSupply = BigInt(reserveRaw.data?.b_supply ?? 0);
    const dSupply = BigInt(reserveRaw.data?.d_supply ?? 0);

    const totalSupply = Number(bSupply * bRate / RATE_DEC) / SCALAR_F;
    const totalBorrow = Number(dSupply * dRate / RATE_DEC) / SCALAR_F;
    const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;

    const rBase_fp = reserveRaw.config?.r_base ?? 300_000;
    const rOne_fp = reserveRaw.config?.r_one ?? 400_000;
    const rTwo_fp = reserveRaw.config?.r_two ?? 1_200_000;
    const rThree_fp = reserveRaw.config?.r_three ?? 50_000_000;
    const utilOpt_fp = reserveRaw.config?.util ?? 5_000_000;
    const irMod_fp = reserveRaw.data?.ir_mod != null ? Number(BigInt(reserveRaw.data.ir_mod)) : 1_000_000;

    const curUtil_fp = Math.round(util * SCALAR_F);
    const FIXED_95PCT = 9_500_000;
    const BACKSTOP_FP = pool.backstopFP;

    let baseRate_fp: number;
    if (curUtil_fp <= utilOpt_fp) {
      baseRate_fp = rBase_fp + Math.ceil(rOne_fp * curUtil_fp / utilOpt_fp);
    } else if (curUtil_fp <= FIXED_95PCT) {
      const slope = Math.ceil((curUtil_fp - utilOpt_fp) * SCALAR_F / (FIXED_95PCT - utilOpt_fp));
      baseRate_fp = rBase_fp + rOne_fp + Math.ceil(rTwo_fp * slope / SCALAR_F);
    } else {
      const slope = Math.ceil((curUtil_fp - FIXED_95PCT) * SCALAR_F / (SCALAR_F - FIXED_95PCT));
      baseRate_fp = rBase_fp + rOne_fp + rTwo_fp + Math.ceil(rThree_fp * slope / SCALAR_F);
    }

    const curIr_fp = Math.ceil(baseRate_fp * irMod_fp / SCALAR_F);
    const interestBorrowApr = (curIr_fp / SCALAR_F) * 100;

    const supplyCapture_fp = Math.floor((SCALAR_F - BACKSTOP_FP) * curUtil_fp / SCALAR_F);
    const interestSupplyApr = (Math.floor(curIr_fp * supplyCapture_fp / SCALAR_F) / SCALAR_F) * 100;

    const supplyEps = supplyEmissions?.eps != null ? Number(BigInt(supplyEmissions.eps)) : 0;
    const borrowEps = borrowEmissions?.eps != null ? Number(BigInt(borrowEmissions.eps)) : 0;

    const supplyBlndYr = supplyEps * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;
    const borrowBlndYr = borrowEps * SECONDS_PER_YEAR / SCALAR_F / SCALAR_F;

    const totalSupplyUsd = totalSupply * priceUsd;
    const totalBorrowUsd = totalBorrow * priceUsd;

    const blndSupplyApr = totalSupplyUsd > 0 ? (supplyBlndYr * blndPrice / totalSupplyUsd) * 100 : 0;
    const blndBorrowApr = totalBorrowUsd > 0 ? (borrowBlndYr * blndPrice / totalBorrowUsd) * 100 : 0;

    return {
      netSupplyApr: interestSupplyApr + blndSupplyApr,
      netBorrowCost: interestBorrowApr - blndBorrowApr,
      interestSupplyApr,
      interestBorrowApr,
      blndSupplyApr,
      blndBorrowApr,
      totalSupply,
      totalBorrow,
      priceUsd,
      util,
    };
  } catch (e) {
    console.error(`[rates] Failed for ${asset.symbol} on ${pool.name}:`, e);
    return null;
  }
}

function computeNetApy(rates: ReserveRates, leverage: number): number {
  return rates.netSupplyApr * leverage - rates.netBorrowCost * (leverage - 1);
}

// ── Message formatting ──────────────────────────────────────────────────────

function formatApy(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function buildPostText(
  entries: { pool: string; asset: string; bracket: number; apy: number }[],
): string {
  const date = new Date().toISOString().slice(0, 10);

  let text = `📊 Turbolong Daily APY Snapshot — ${date}\n\n`;

  for (const e of entries) {
    text += `${e.pool} $${e.asset} @ ${e.bracket}x: ${formatApy(e.apy)}\n`;
  }

  text += `\nPowered by @blend_capital • turbolong.com`;

  if (text.length > 400) {
    text = `📊 Turbolong APY — ${date}\n\n`;
    for (const e of entries) {
      text += `${e.pool} $${e.asset} @ ${e.bracket}x: ${formatApy(e.apy)}\n`;
      if (text.length > 350) {
        text += `\n…`;
        break;
      }
    }
    text += `\n\nblend_capital • turbolong.com`;
  }

  return text;
}

// ── X (Twitter) posting ──────────────────────────────────────────────────────

async function postToX(text: string): Promise<boolean> {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    console.warn("[x] Missing env vars (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET) — skipping");
    return false;
  }

  try {
    const { TwitterApi } = await import("twitter-api-v2");
    const client = new TwitterApi({
      appKey: apiKey,
      appSecret: apiSecret,
      accessToken,
      accessSecret,
    });

    const result = await client.v2.tweet(text);
    console.log(`[x] Posted tweet: ${result.data.id}`);
    return true;
  } catch (e) {
    console.error("[x] Failed to post:", e);
    return false;
  }
}

// ── Farcaster posting (via Neynar) ───────────────────────────────────────────

async function postToFarcaster(text: string): Promise<boolean> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!apiKey || !signerUuid) {
    console.warn("[farcaster] Missing env vars (NEYNAR_API_KEY, NEYNAR_SIGNER_UUID) — skipping");
    return false;
  }

  try {
    const res = await fetch("https://api.neynar.com/v2/farcaster/cast", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api_key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        signer_uuid: signerUuid,
        text,
      }),
    });

    if (res.ok) {
      const data = await res.json() as any;
      console.log(`[farcaster] Posted cast: ${data.cast?.hash}`);
      return true;
    }
    console.warn(`[farcaster] API returned ${res.status}: ${await res.text()}`);
    return false;
  } catch (e) {
    console.error("[farcaster] Failed to post:", e);
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("[daily_post] Starting…");

  const entries: { pool: string; asset: string; bracket: number; apy: number }[] = [];

  for (const pool of POOLS) {
    for (const asset of pool.assets) {
      const rates = await fetchReserveRates(pool, asset);
      if (!rates) {
        console.warn(`[daily_post] No rates for ${asset.symbol} on ${pool.name}`);
        continue;
      }

      for (const bracket of LEVERAGE_BRACKETS) {
        const apy = computeNetApy(rates, bracket);
        entries.push({ pool: pool.name, asset: asset.symbol, bracket, apy });
      }
    }
  }

  if (entries.length === 0) {
    console.warn("[daily_post] No data collected — nothing to post");
    return;
  }

  const text = buildPostText(entries);
  console.log("── Post text ──");
  console.log(text);
  console.log("──────────────");

  const xOk = await postToX(text);
  const fcOk = await postToFarcaster(text);

  console.log(`[daily_post] Done. X: ${xOk ? "OK" : "skip/fail"}, Farcaster: ${fcOk ? "OK" : "skip/fail"}`);
}

main().catch((e) => {
  console.error("[daily_post] Fatal error:", e);
  process.exit(1);
});
