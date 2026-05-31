/**
 * Deploy the BlendLeverageStrategy contract to testnet.
 *
 * Usage: npx tsx scripts/deploy_strategy.ts
 */
import {
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
  StrKey,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as crypto from "crypto";

const RPC_URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

const SECRET = process.env.DEPLOY_SECRET_KEY;
if (!SECRET) {
  console.error(
    "Error: DEPLOY_SECRET_KEY is not set.\n" +
    "Create a .env.local file with:\n" +
    "  DEPLOY_SECRET_KEY=S...\n" +
    "Then run: DEPLOY_SECRET_KEY=$(grep DEPLOY_SECRET_KEY .env.local | cut -d= -f2) npx tsx scripts/deploy_strategy.ts"
  );
  process.exit(1);
}

const keypair = Keypair.fromSecret(SECRET);
const account = keypair.publicKey();
const server = new SorobanRpc.Server(RPC_URL);

// Constructor args
const ASSET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const POOL = "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW";
const BLND = "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF";
const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";
const KEEPER = "GBKC77KT5S3ZKLDQSKBPMRKFDNFOU4OMFFS73ZX65LB2R633X6JJZYKN";

async function main() {
  // Step 1: Read the WASM hash (already installed)
  const wasmHash = "f70473bdd2431faa8486f76473b1bbd0a63f1dde4294bec2b0f4bd65c92823e7";

  console.log(`Deploying with wasm hash: ${wasmHash}`);
  console.log(`Deployer: ${account}`);

  // Helper to create ScVal for any address (G... or C...)
  function addrScVal(addr: string): xdr.ScVal {
    if (addr.startsWith("C")) {
      // Contract address
      return new Contract(addr).address().toScVal();
    }
    // Account address (G...)
    return new Address(addr).toScVal();
  }

  // Build init_args Vec<Val>
  const initArgs = xdr.ScVal.scvVec([
    addrScVal(POOL),                              // [0] pool
    addrScVal(BLND),                              // [1] blend_token
    addrScVal(ROUTER),                            // [2] router
    nativeToScVal(10_000_000n, { type: "i128" }), // [3] reward_threshold (1 BLND)
    addrScVal(KEEPER),                            // [4] keeper
    nativeToScVal(9_000_000n, { type: "i128" }),  // [5] c_factor (0.90)
    nativeToScVal(3, { type: "u32" }),            // [6] target_loops
    nativeToScVal(10_500_000n, { type: "i128" }), // [7] min_hf (1.05)
  ]);

  // Step 2: Build deploy transaction with constructor
  const acc = await server.getAccount(account);
  const salt = Buffer.alloc(32);
  crypto.randomFillSync(salt);

  const deployOp = Operation.createCustomContract({
    wasmHash: Buffer.from(wasmHash, "hex"),
    address: new Address(account),
    salt,
    constructorArgs: [
      addrScVal(ASSET), // asset
      initArgs,         // init_args
    ],
  });

  const tx = new TransactionBuilder(acc, {
    fee: "10000000", // 1 XLM
    networkPassphrase: PASSPHRASE,
  })
    .setTimeout(120)
    .addOperation(deployOp)
    .build();

  // Simulate
  console.log("Simulating...");
  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) {
    console.error("Simulation error:", (sim as any).error);
    return;
  }

  // Prepare and sign
  const prepared = await server.prepareTransaction(tx);
  (prepared as any).sign(keypair);

  // Submit
  console.log("Submitting...");
  const response = await server.sendTransaction(prepared);
  console.log(`Transaction hash: ${response.hash}`);

  // Wait for result
  let result = await server.getTransaction(response.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise(r => setTimeout(r, 1000));
    result = await server.getTransaction(response.hash);
  }

  if (result.status === "SUCCESS") {
    // Extract contract ID from the result
    const contractId = result.returnValue;
    console.log("Contract deployed successfully!");
    if (contractId) {
      const addr = Address.fromScVal(contractId);
      console.log(`Contract ID: ${addr.toString()}`);
    }
  } else {
    console.error("Deployment failed:", JSON.stringify(result, null, 2).slice(0, 3000));
  }
}

main().catch(console.error);
