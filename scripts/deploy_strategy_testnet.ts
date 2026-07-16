/**
 * Deploy the Turbolong BlendLeverage vaults to Stellar TESTNET — the full-flow
 * rehearsal for the mainnet D1 deploy. Mirrors deploy_strategy_mainnet.ts so the
 * testnet run exercises the exact same path (install both WASMs → per asset:
 * deploy strategy + deploy vault_share token + set_share_token + set_swap_account)
 * before any real funds are touched on mainnet.
 *
 * The testnet Blend pool exposes 4 reserves: XLM (native), USDC, CETES, TESOURO.
 * USTRY (a mainnet-only asset) does not exist on testnet, so TESOURO stands in as
 * the 4th vault for the rehearsal. The other three mirror the mainnet scope.
 *
 * Testnet only — no real funds. Use a funded testnet key (Friendbot), e.g.:
 *   DEPLOY_SECRET_KEY=S... npx tsx scripts/deploy_strategy_testnet.ts
 *
 * Env:
 *   DEPLOY_SECRET_KEY  S... deployer (pays fees, installs WASM, deploys); REQUIRED
 *   ADMIN_PUBKEY       G... admin; default = deployer
 *   KEEPER_PUBKEY      G... keeper; default = deployer (fine for a testnet rehearsal)
 *   DRY_RUN=1          simulate the first WASM install only, submit nothing
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

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;
const DRY_RUN = process.env.DRY_RUN === "1";

const SECRET = process.env.DEPLOY_SECRET_KEY;
if (!SECRET) {
  console.error("DEPLOY_SECRET_KEY is required (a funded testnet S... key; use Friendbot).");
  process.exit(1);
}
const keypair = Keypair.fromSecret(SECRET);
const deployer = keypair.publicKey();
const ADMIN = process.env.ADMIN_PUBKEY ?? deployer;
const KEEPER = process.env.KEEPER_PUBKEY ?? deployer;

const server = new SorobanRpc.Server(RPC_URL);

// ── Testnet constants (verified live via scripts/query_testnet_pool.ts +
//    scripts/check_testnet_infra.ts) ─────────────────────────────────────────
const POOL = "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW";   // Blend testnet pool
const BLND = "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF";   // testnet BLND
const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD"; // Soroswap testnet router

// Per-asset config. Strategy `c_factor` sits below the pool's live c_factor
// (XLM/USDC/CETES = 0.98, TESOURO = 0.90) to leave an HF buffer. Loops/min_hf/
// orange_hf mirror the mainnet readiness table where the asset matches.
const REWARD_THRESHOLD = 10_000_000n; // 1 BLND @ 7dp (low, so harvest triggers easily on testnet)
interface AssetCfg {
  symbol: string;
  asset: string;
  cFactor: bigint;   // 1e7
  targetLoops: number;
  minHf: bigint;     // 1e7
  orangeHf: bigint;  // 1e7
}
const ASSETS: AssetCfg[] = [
  { symbol: "USDC",    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", cFactor: 9_000_000n, targetLoops: 4, minHf: 10_500_000n, orangeHf: 11_500_000n },
  { symbol: "CETES",   asset: "CC72F57YTPX76HAA64JQOEGHQAPSADQWSY5DWVBR66JINPFDLNCQYHIC", cFactor: 7_500_000n, targetLoops: 3, minHf: 10_500_000n, orangeHf: 11_500_000n },
  { symbol: "XLM",     asset: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC", cFactor: 7_000_000n, targetLoops: 2, minHf: 11_000_000n, orangeHf: 12_000_000n },
  { symbol: "TESOURO", asset: "CCKA3OUWLZPX3YT335UNHIFMKSYA37M66VKGD5XZOX4BA4IKTYP4WBEE", cFactor: 8_000_000n, targetLoops: 3, minHf: 10_500_000n, orangeHf: 11_500_000n },
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
  console.log(`Turbolong TESTNET deploy ${DRY_RUN ? "(DRY-RUN)" : ""}`);
  console.log(`  deployer=${deployer} admin=${ADMIN} keeper=${KEEPER}`);
  console.log(`  pool=${POOL} router=${ROUTER}`);

  const strategyHash = await installWasm(STRATEGY_WASM, "strategy");
  const tokenHash = await installWasm(TOKEN_WASM, "token");
  console.log(`  strategy wasm=${strategyHash}\n  token wasm=${tokenHash}`);

  // Persist the risk params alongside the addresses so the JSON documents the
  // configuration that was ACTUALLY deployed (human floats, not 1e7 ints).
  const out: Record<
    string,
    { strategy: string; token: string; cFactor: number; targetLoops: number; minHf: number; orangeHf: number }
  > = {};

  for (const a of ASSETS) {
    console.log(`\n=== ${a.symbol} ===`);
    const initArgs = xdr.ScVal.scvVec([
      addr(POOL),                                          // [0] pool
      addr(BLND),                                          // [1] blend_token
      addr(ROUTER),                                        // [2] router
      nativeToScVal(REWARD_THRESHOLD, { type: "i128" }),   // [3] reward_threshold
      addr(KEEPER),                                        // [4] keeper
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
    await invoke(strategy, "set_swap_account", [addr(KEEPER)], `${a.symbol} set_swap_account`);

    out[a.symbol] = {
      strategy,
      token,
      cFactor: Number(a.cFactor) / 1e7,
      targetLoops: a.targetLoops,
      minHf: Number(a.minHf) / 1e7,
      orangeHf: Number(a.orangeHf) / 1e7,
    };
  }

  const file = path.resolve(here, "../deployed-vaults.testnet.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nDeployed testnet vaults written to ${file}`);
  console.log("Next: wire frontend/src/defindex.ts TESTNET_VAULTS, then deposit→loop→withdraw per asset on testnet.");
}

main().catch((e) => {
  if (e.message === "DRY_RUN") { console.log("dry-run complete (no submissions)."); return; }
  console.error(e);
  process.exit(1);
});
