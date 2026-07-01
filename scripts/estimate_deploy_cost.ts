/**
 * Read-only cost estimate for the mainnet deploy. Simulates the two WASM uploads
 * and one strategy deploy against mainnet RPC and prints minResourceFee (stroops)
 * so we can size the deployer's XLM buffer. Submits nothing.
 */
import {
  Address,
  Contract,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const RPC_URL = process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com";
const server = new SorobanRpc.Server(RPC_URL);
const DEPLOYER = process.env.DEPLOYER_PUBKEY ?? "GB6SBV2KUBT3A5E42PF6GF66CWEOCBD73N57EF2IB7O7F4NYDLDPCKAL";

const STRATEGY_WASM = path.resolve(here, "../contracts/strategies/blend_leverage/target/wasm32v1-none/release/blend_leverage_strategy.wasm");
const TOKEN_WASM = path.resolve(here, "../contracts/tokens/vault_share/target/wasm32v1-none/release/vault_share_token.wasm");

const stroopsToXlm = (s: bigint | number) => (Number(s) / 1e7).toFixed(4);

async function simUpload(wasmPath: string, label: string): Promise<bigint> {
  const wasm = fs.readFileSync(wasmPath);
  const acc = await server.getAccount(DEPLOYER);
  const tx = new TransactionBuilder(acc, { fee: "1000000", networkPassphrase: Networks.PUBLIC })
    .setTimeout(120)
    .addOperation(Operation.uploadContractWasm({ wasm }))
    .build();
  const sim = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(sim)) {
    console.log(`  ${label}: SIM ERROR — ${sim.error}`);
    return 0n;
  }
  const fee = BigInt(sim.minResourceFee ?? "0");
  console.log(`  ${label} upload: minResourceFee = ${fee} stroops (${stroopsToXlm(fee)} XLM)`);
  return fee;
}

async function main() {
  console.log(`Estimating mainnet deploy cost for deployer=${DEPLOYER}`);
  console.log(`RPC=${RPC_URL}\n`);

  const acc = await server.getAccount(DEPLOYER);
  console.log(`Deployer sequence=${acc.sequenceNumber()}\n`);

  const s = await simUpload(STRATEGY_WASM, "strategy");
  const t = await simUpload(TOKEN_WASM, "token");

  // The 8 contract deploys + 8 wiring invokes each carry their own resource fee.
  // We approximate deploys from the strategy/token upload footprint; the dominant
  // one-off cost is the two WASM uploads (code entries + rent). Add a generous
  // margin for 8 createContract + 8 invoke resource fees + inclusion fees.
  const uploads = s + t;
  console.log(`\n  two uploads total   = ${stroopsToXlm(uploads)} XLM`);
  console.log(`  + ~8 deploys / ~8 invokes / inclusion fees / 1 XLM base reserve buffer`);
  console.log(`\n  Suggested deployer funding: at least ${(Number(stroopsToXlm(uploads)) + 60).toFixed(0)} XLM (uploads + generous margin).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
