/**
 * Deploy the Turbolong BlendLeverage vaults to Stellar MAINNET — SCF T1 D1.
 *
 * For each of the four assets (USDC, USTRY, CETES, XLM) on the Etherfuse pool it:
 *   1. deploys the blend_leverage strategy (10-arg constructor),
 *   2. deploys its SEP-41 vault-share token (minter = the strategy),
 *   3. wires strategy.set_share_token(token),
 *   4. wires strategy.set_swap_account(keeper) for the Broker harvest path,
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
const REWARD_THRESHOLD = 1_000_000_000n; // 100 BLND @ 7dp
interface AssetCfg {
  symbol: string;
  asset: string;
  cFactor: bigint;   // 1e7
  targetLoops: number;
  minHf: bigint;     // 1e7
  orangeHf: bigint;  // 1e7
}
const ASSETS: AssetCfg[] = [
  { symbol: "USDC",  asset: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", cFactor: 9_000_000n, targetLoops: 4, minHf: 10_500_000n, orangeHf: 11_500_000n },
  { symbol: "USTRY", asset: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", cFactor: 8_500_000n, targetLoops: 3, minHf: 10_500_000n, orangeHf: 11_500_000n },
  { symbol: "CETES", asset: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", cFactor: 7_500_000n, targetLoops: 3, minHf: 10_500_000n, orangeHf: 11_500_000n },
  { symbol: "XLM",   asset: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", cFactor: 7_000_000n, targetLoops: 2, minHf: 11_000_000n, orangeHf: 12_000_000n },
];

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

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Turbolong mainnet deploy ${DRY_RUN ? "(DRY-RUN)" : ""}`);
  console.log(`  deployer=${deployer} admin=${ADMIN} keeper=${KEEPER}`);
  console.log(`  pool=${POOL} router=${ROUTER}`);

  const strategyHash = await installWasm(STRATEGY_WASM, "strategy");
  const tokenHash = await installWasm(TOKEN_WASM, "token");
  console.log(`  strategy wasm=${strategyHash}\n  token wasm=${tokenHash}`);

  const out: Record<string, { strategy: string; token: string }> = {};

  for (const a of ASSETS) {
    console.log(`\n=== ${a.symbol} ===`);
    const initArgs = xdr.ScVal.scvVec([
      addr(POOL),                                          // [0] pool
      addr(BLND),                                          // [1] blend_token
      addr(ROUTER),                                        // [2] router
      nativeToScVal(REWARD_THRESHOLD, { type: "i128" }),   // [3] reward_threshold
      addr(KEEPER!),                                       // [4] keeper
      nativeToScVal(a.cFactor, { type: "i128" }),          // [5] c_factor
      nativeToScVal(a.targetLoops, { type: "u32" }),       // [6] target_loops
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

    out[a.symbol] = { strategy, token };
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
