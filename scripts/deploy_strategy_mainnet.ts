/**
 * Deploy the Turbolong BlendLeverage vaults to Stellar MAINNET — SCF T1 D1.
 *
 * For each of the four assets (USDC, USTRY, CETES, XLM) on the Etherfuse pool it:
 *   1. deploys the blend_leverage strategy (10-arg constructor),
 *   2. deploys its SEP-41 vault-share token (minter = the strategy),
 *   3. wires strategy.set_share_token(token),
 *   4. wires strategy.set_swap_account(keeper) for the Broker harvest path,
 *   5. wires strategy.set_min_harvest_rate(rate) — the harvest floor the Broker
 *      path is gated on (audit M-4) and the trait harvest's default slippage
 *      bound (audit M-5); omitted assets keep both unfloored calls closed,
 * then writes every deployed contract ID to deployed-vaults.mainnet.json.
 *
 * REAL FUNDS. Never commit a mainnet key. Run with a secure signer, e.g.:
 *   op run -- env DEPLOY_SECRET_KEY=op://vault/turbolong-deployer/secret \
 *     ADMIN_PUBKEY=G... KEEPER_PUBKEY=G... npx tsx scripts/deploy_strategy_mainnet.ts
 *
 * Env:
 *   DEPLOY_SECRET_KEY  S... deployer (pays fees, installs WASM, deploys)
 *   ADMIN_PUBKEY       G... admin (upgrade + set_share_token/set_swap_account); default = deployer
 *   KEEPER_PUBKEY      G... keeper (harvest + rebalance_keeper + pulls BLND); REQUIRED
 *   MIN_HARVEST_RATE_<SYMBOL>  harvest floor per asset (see MIN_HARVEST_RATES);
 *                      omit to leave that vault's Broker path closed and its
 *                      trait `harvest` dependent on a caller-supplied floor
 *   DRY_RUN=1          simulate only, do not submit
 *
 * Pre-req: build both wasms first —
 *   (cd contracts/strategies/blend_leverage && cargo build --target wasm32v1-none --release)
 *   (cd contracts/tokens/vault_share        && cargo build --target wasm32v1-none --release)
 */
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const PASSPHRASE = Networks.PUBLIC;
const DRY_RUN = process.env.DRY_RUN === "1";

const SECRET = process.env.DEPLOY_SECRET_KEY;
if (!SECRET) {
  console.error("DEPLOY_SECRET_KEY is required (use op run / a secrets manager; never inline a mainnet key).");
  process.exit(1);
}
const keypair = Keypair.fromSecret(SECRET);
const deployer = keypair.publicKey();
const ADMIN = process.env.ADMIN_PUBKEY ?? deployer;
const KEEPER = process.env.KEEPER_PUBKEY;
if (!KEEPER) {
  console.error("KEEPER_PUBKEY is required (the account that runs harvest/rebalance).");
  process.exit(1);
}

const server = new SorobanRpc.Server(RPC_URL);

// ── Mainnet constants (sourced) ────────────────────────────────────────────────
const POOL = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI";   // Etherfuse pool
const BLND = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";   // mainnet BLND
const ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH"; // Soroswap mainnet router

// Per-asset config. `c_factor` is the strategy's own collateral factor (≤ the
// pool's, leaving a borrow/HF buffer); pool c_factors read live were USDC 0.95,
// USTRY 0.90, CETES 0.80, XLM 0.75. Risk params (loops/min_hf/orange_hf) are
// proposed defaults — review before running. reward_threshold = 100 BLND.
//
// `c_factor <= pool c_factor` is not just convention: the strategy's health
// factor now carries the pool's `l_factor`, and that inequality is what makes
// the reported HF a lower bound on Blend's own solvency ratio (so `min_hf > 1.0`
// is a floor in Blend's terms). The constructor asserts it, and `preflight()`
// below checks it — plus prints each reserve's live `l_factor` — before any
// funds-bearing contract is deployed.
//
// `target_hf` is the health factor a deposit is levered to, in Blend's terms
// (the pool's live `l_factor` included), so it *is* the vault's leverage:
// `B/E = target_hf / (target_hf − c_factor × l_factor)`. The contract refuses a
// target below `orange_hf + 0.02` (its re-leverage buffer) — a deposit opening
// inside the rebalance band would be unwound by the first `rebalance()` — and
// `preflight()` checks the same thing before anything is deployed.
//
// The Etherfuse pool's l_factors equal its c_factors (USDC 0.95, USTRY 0.90,
// CETES 0.80, XLM 0.75). USTRY, CETES and XLM therefore sit at the lowest target
// their bands allow, `orange_hf + 0.02`; USDC keeps the 4.1× it was sized for.
// USDC and CETES run orange_hf at 1.10 rather than 1.15: the rebalance trigger
// sits 0.10 above liquidation, a defensible trade *because these are same-asset
// loops* — collateral and debt are the same token, so the margin only absorbs
// interest-rate drift (~the borrow/supply spread), never an oracle divergence
// between the two legs.
const REWARD_THRESHOLD = 1_000_000_000n; // 100 BLND @ 7dp
interface AssetCfg {
  symbol: string;
  asset: string;
  cFactor: bigint;   // 1e7
  targetHf: bigint;  // 1e7
  minHf: bigint;     // 1e7
  orangeHf: bigint;  // 1e7
  swapVia?: string;  // intermediate of the on-chain Soroswap harvest route (set_swap_via)
}
const ASSETS: AssetCfg[] = [
  { symbol: "USDC",  asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", cFactor: 9_000_000n, targetHf: 11_300_000n, minHf: 10_500_000n, orangeHf: 11_000_000n }, // 4.11× @ l=0.95
  { symbol: "USTRY", asset: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", cFactor: 8_500_000n, targetHf: 11_700_000n, minHf: 10_500_000n, orangeHf: 11_500_000n, swapVia: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" }, // 2.89× @ l=0.90
  { symbol: "CETES", asset: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", cFactor: 7_500_000n, targetHf: 11_200_000n, minHf: 10_500_000n, orangeHf: 11_000_000n, swapVia: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" }, // 2.15× @ l=0.80
  { symbol: "XLM",   asset: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", cFactor: 7_000_000n, targetHf: 12_200_000n, minHf: 11_000_000n, orangeHf: 12_000_000n, swapVia: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75" }, // 1.76× @ l=0.75
];

/**
 * Harvest floor rates (audit M-4, M-5), read from `MIN_HARVEST_RATE_<SYMBOL>` —
 * the minimum underlying the strategy will accept back per 1e7 BLND stroops, in
 * the underlying's own stroops. One rate, both harvest routes: it is the
 * settlement floor `harvest_reinvest` measures the Broker's return against, and
 * the `amount_out_min` the trait `harvest` sends to Soroswap when the caller
 * supplies no stricter one of its own. Every asset here
 * is 7-decimal, so the number is just the BLND price *in that underlying*,
 * 1e7-scaled, with a safety haircut:
 *
 *     rate = floor( (BLND_price / underlying_price) × 1e7 × (1 − haircut) )
 *
 * BLND at $0.02 against a $1 stablecoin with a 50% haircut → 100_000. The
 * haircut is what keeps the floor out of the way of ordinary spread, Broker fee
 * and drift between claim and settlement; the floor is meant to catch a
 * settlement that comes back at a fraction of the BLND's worth, not to price
 * the trade. Re-derive from live prices at deploy time — the rate is admin
 * settable afterwards via `set_min_harvest_rate`.
 *
 * Not hardcoded in ASSETS on purpose: c_factor and the HF thresholds are
 * risk-design constants that belong under review, while this one is a price
 * observation that would be stale the day it was committed.
 */
const MIN_HARVEST_RATES: Record<string, bigint | undefined> = Object.fromEntries(
  ASSETS.map((a) => {
    const raw = process.env[`MIN_HARVEST_RATE_${a.symbol}`];
    if (!raw) return [a.symbol, undefined];
    const rate = BigInt(raw);
    if (rate <= 0n) throw new Error(`MIN_HARVEST_RATE_${a.symbol} must be positive, got ${raw}`);
    return [a.symbol, rate];
  }),
);

const STRATEGY_WASM = path.resolve(here, "../contracts/strategies/blend_leverage/target/wasm32v1-none/release/blend_leverage_strategy.wasm");
const TOKEN_WASM = path.resolve(here, "../contracts/tokens/vault_share/target/wasm32v1-none/release/vault_share_token.wasm");

// ── Helpers ────────────────────────────────────────────────────────────────────

function addr(a: string): xdr.ScVal {
  return a.startsWith("C") ? new Contract(a).address().toScVal() : new Address(a).toScVal();
}

async function signSubmit(tx: any, label: string): Promise<SorobanRpc.Api.GetSuccessfulTransactionResponse> {
  const prepared = await server.prepareTransaction(tx);
  if (DRY_RUN) {
    console.log(`  [dry-run] ${label} prepared (not submitted)`);
    throw new Error("DRY_RUN");
  }
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  let res = await server.getTransaction(sent.hash);
  while (res.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1500));
    res = await server.getTransaction(sent.hash);
  }
  if (res.status !== "SUCCESS") {
    throw new Error(`${label} failed: ${JSON.stringify(res).slice(0, 500)}`);
  }
  console.log(`  ✓ ${label}  tx=${sent.hash}`);
  return res;
}

async function installWasm(wasmPath: string, label: string): Promise<string> {
  const wasm = fs.readFileSync(wasmPath);
  const acc = await server.getAccount(deployer);
  const tx = new TransactionBuilder(acc, { fee: "10000000", networkPassphrase: PASSPHRASE })
    .setTimeout(120)
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .build();
  const res = await signSubmit(tx, `install ${label} wasm`);
  const hash = (res.returnValue as xdr.ScVal).bytes().toString("hex");
  return hash;
}

async function deploy(wasmHash: string, constructorArgs: xdr.ScVal[], label: string): Promise<string> {
  const acc = await server.getAccount(deployer);
  const salt = crypto.randomBytes(32);
  const op = Operation.createCustomContract({
    wasmHash: Buffer.from(wasmHash, "hex"),
    address: new Address(deployer),
    salt,
    constructorArgs,
  });
  const tx = new TransactionBuilder(acc, { fee: "10000000", networkPassphrase: PASSPHRASE })
    .setTimeout(120)
    .addOperation(op)
    .build();
  const res = await signSubmit(tx, `deploy ${label}`);
  return Address.fromScVal(res.returnValue as xdr.ScVal).toString();
}

async function invoke(contractId: string, method: string, args: xdr.ScVal[], label: string): Promise<void> {
  const acc = await server.getAccount(deployer);
  const tx = new TransactionBuilder(acc, { fee: "10000000", networkPassphrase: PASSPHRASE })
    .setTimeout(120)
    .addOperation(new Contract(contractId).call(method, ...args))
    .build();
  await signSubmit(tx, label);
}

// ── Pre-flight: live pool risk parameters ──────────────────────────────────────

/**
 * Read the pool's reserve config for every asset and check the risk parameters
 * we are about to deploy against it. Aborts before the first deploy if anything
 * fails, so a misconfigured asset never reaches mainnet.
 *
 * Checks, per asset:
 *   - strategy c_factor <= pool c_factor  (makes the reported HF conservative)
 *   - the deposit floor `min_hf` clears 1.0 in Blend's own terms, i.e. a
 *     position opened exactly at min_hf survives `B × pool_c × l >= D`.
 *   - `target_hf` clears `orange_hf` by the contract's re-leverage buffer
 *     (0.02) — the constructor refuses it otherwise, because every deposit
 *     would open inside the rebalance band and be unwound by the first
 *     `rebalance()`, which anyone may call.
 */

/**
 * The collateral/equity ratio a deposit levered to `targetHf` builds at the
 * pool's live `l_factor`: `h / (h − c × l)`, all 1e7-scaled.
 */
function leverageAt(targetHf: bigint, cFactor: bigint, lFactor: bigint): number {
  const cl = (cFactor * lFactor) / 10_000_000n;
  return targetHf > cl ? Number(targetHf) / Number(targetHf - cl) : Number.POSITIVE_INFINITY;
}

/** Contract-side `RELEVERAGE_HF_BUFFER` (constants.rs), 1e7-scaled. */
const RELEVERAGE_HF_BUFFER = 200_000n; // 0.02
async function preflight(): Promise<void> {
  console.log("\n── pre-flight: live reserve risk parameters ──");
  const acc = await server.getAccount(deployer);
  const failures: string[] = [];

  for (const a of ASSETS) {
    const tx = new TransactionBuilder(acc, { fee: "10000000", networkPassphrase: PASSPHRASE })
      .setTimeout(60)
      .addOperation(new Contract(POOL).call("get_reserve", addr(a.asset)))
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim) || !sim.result) {
      failures.push(`${a.symbol}: get_reserve simulation failed`);
      continue;
    }
    const reserve = scValToNative(sim.result.retval) as {
      config: { c_factor: number; l_factor: number };
    };
    const poolC = BigInt(reserve.config.c_factor);
    const lFactor = BigInt(reserve.config.l_factor);

    // A position sitting exactly at min_hf has B/D = min_hf / c_factor, so
    // Blend's ratio is (min_hf / c_factor) × pool_c × l. Compute it in 1e7.
    const blendRatio = (a.minHf * poolC * lFactor) / (a.cFactor * 10_000_000n);

    console.log(
      `  ${a.symbol.padEnd(5)} strategy_c=${Number(a.cFactor) / 1e7}` +
        ` pool_c=${Number(poolC) / 1e7} l_factor=${Number(lFactor) / 1e7}` +
        ` min_hf=${Number(a.minHf) / 1e7} → Blend ratio at min_hf=${(Number(blendRatio) / 1e7).toFixed(4)}`,
    );

    if (a.cFactor > poolC) {
      failures.push(
        `${a.symbol}: strategy c_factor ${a.cFactor} exceeds pool c_factor ${poolC} — the constructor will reject this`,
      );
    }
    if (blendRatio <= 10_000_000n) {
      failures.push(
        `${a.symbol}: min_hf does not clear 1.0 in Blend's terms (ratio ${Number(blendRatio) / 1e7}) — raise min_hf or lower c_factor`,
      );
    }

    // Where a fresh deposit lands, and the leverage that is at the live l_factor.
    console.log(
      `        target_hf=${Number(a.targetHf) / 1e7} → ${leverageAt(a.targetHf, a.cFactor, lFactor).toFixed(3)}×` +
        ` vs orange_hf=${Number(a.orangeHf) / 1e7}`,
    );
    if (a.targetHf < a.orangeHf + RELEVERAGE_HF_BUFFER) {
      failures.push(
        `${a.symbol}: target_hf ${Number(a.targetHf) / 1e7} is less than 0.02 above orange_hf ` +
          `${Number(a.orangeHf) / 1e7} — the constructor will reject it. Raise target_hf or lower orange_hf.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("\npre-flight FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("  ✓ all assets clear Blend's liquidation threshold at min_hf");
  console.log("  ✓ all assets open clear of their rebalance band at target_hf");
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Turbolong mainnet deploy ${DRY_RUN ? "(DRY-RUN)" : ""}`);
  console.log(`  deployer=${deployer} admin=${ADMIN} keeper=${KEEPER}`);
  console.log(`  pool=${POOL} router=${ROUTER}`);

  await preflight();

  const strategyHash = await installWasm(STRATEGY_WASM, "strategy");
  const tokenHash = await installWasm(TOKEN_WASM, "token");
  console.log(`  strategy wasm=${strategyHash}\n  token wasm=${tokenHash}`);

  // Persist the risk params alongside the addresses so the JSON documents the
  // configuration that was ACTUALLY deployed (human floats, not 1e7 ints).
  const out: Record<
    string,
    { strategy: string; token: string; cFactor: number; targetHf: number; minHf: number; orangeHf: number }
  > = {};

  for (const a of ASSETS) {
    console.log(`\n=== ${a.symbol} ===`);
    const initArgs = xdr.ScVal.scvVec([
      addr(POOL),                                          // [0] pool
      addr(BLND),                                          // [1] blend_token
      addr(ROUTER),                                        // [2] router
      nativeToScVal(REWARD_THRESHOLD, { type: "i128" }),   // [3] reward_threshold
      addr(KEEPER!),                                       // [4] keeper
      nativeToScVal(a.cFactor, { type: "i128" }),          // [5] c_factor
      nativeToScVal(a.targetHf, { type: "i128" }),         // [6] target_hf
      nativeToScVal(a.minHf, { type: "i128" }),            // [7] min_hf
      nativeToScVal(a.orangeHf, { type: "i128" }),         // [8] orange_hf
      addr(ADMIN),                                         // [9] admin
    ]);
    const strategy = await deploy(strategyHash, [addr(a.asset), initArgs], `${a.symbol} strategy`);
    console.log(`  strategy=${strategy}`);

    const token = await deploy(
      tokenHash,
      [
        addr(ADMIN),                                              // admin
        addr(strategy),                                           // minter = strategy
        nativeToScVal(7, { type: "u32" }),                        // decimals
        nativeToScVal(`BlendLeverage ${a.symbol} Share`, { type: "string" }),
        nativeToScVal(`blv${a.symbol}`, { type: "string" }),
      ],
      `${a.symbol} token`,
    );
    console.log(`  token=${token}`);

    await invoke(strategy, "set_share_token", [addr(token)], `${a.symbol} set_share_token`);
    await invoke(strategy, "set_swap_account", [addr(KEEPER!)], `${a.symbol} set_swap_account`);

    // Harvest floor (audit M-4, M-5). Price-dependent and therefore not baked
    // into this table — see MIN_HARVEST_RATE_* above. Left unset the strategy
    // refuses to approve BLND pulls and refuses an unfloored trait `harvest`,
    // so an omitted rate costs a swap venue and makes the keeper pass its own
    // `amount_out_min` — it never costs safety.
    const minHarvestRate = MIN_HARVEST_RATES[a.symbol];
    if (minHarvestRate) {
      await invoke(
        strategy,
        "set_min_harvest_rate",
        [nativeToScVal(minHarvestRate, { type: "i128" })],
        `${a.symbol} set_min_harvest_rate`,
      );
    } else {
      console.warn(`  ⚠ ${a.symbol}: MIN_HARVEST_RATE_${a.symbol} unset — Broker harvest path left CLOSED, trait harvest needs an explicit amount_out_min`);
    }

    // No BLND pair on Soroswap (USTRY, CETES) or a thin one (XLM): route the
    // on-chain harvest swap through USDC.
    if (a.swapVia) {
      await invoke(strategy, "set_swap_via", [addr(a.swapVia)], `${a.symbol} set_swap_via`);
    }

    out[a.symbol] = {
      strategy,
      token,
      cFactor: Number(a.cFactor) / 1e7,
      targetHf: Number(a.targetHf) / 1e7,
      minHf: Number(a.minHf) / 1e7,
      orangeHf: Number(a.orangeHf) / 1e7,
    };
  }

  const file = path.resolve(here, "../deployed-vaults.mainnet.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nDeployed vaults written to ${file}`);
  console.log("Next: wire frontend/src/defindex.ts MAINNET_VAULTS, verify deposit→loop→withdraw on Stellar Expert, get DeFindex co-sign.");
}

main().catch((e) => {
  if (e.message === "DRY_RUN") { console.log("dry-run complete (no submissions)."); return; }
  console.error(e);
  process.exit(1);
});
