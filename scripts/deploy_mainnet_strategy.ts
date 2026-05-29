/**
 * Deploy the BlendLeverageStrategy contract to mainnet.
 *
 * Usage: 
 * MAINNET_SECRET=S... \
 * WASM_HASH=... \
 * MAINNET_ROUTER=... \
 * MAINNET_KEEPER=... \
 * npx tsx scripts/deploy_mainnet_strategy.ts
 */
import {
  Contract,
  Keypair,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import * as crypto from "crypto";

const RPC_URL = "https://soroban-rpc.creit.tech/";
const PASSPHRASE = Networks.PUBLIC;

// Ensure required environment variables are set
const SECRET = process.env.MAINNET_SECRET;
const WASM_HASH = process.env.WASM_HASH;
const ROUTER = process.env.MAINNET_ROUTER;
const KEEPER = process.env.MAINNET_KEEPER;

if (!SECRET) throw new Error("MAINNET_SECRET environment variable is required");
if (!WASM_HASH) throw new Error("WASM_HASH environment variable is required");
if (!ROUTER) throw new Error("MAINNET_ROUTER environment variable is required");
if (!KEEPER) throw new Error("MAINNET_KEEPER environment variable is required");

const keypair = Keypair.fromSecret(SECRET);
const account = keypair.publicKey();
const server = new SorobanRpc.Server(RPC_URL);

// Constructor args for mainnet
const ASSET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"; // USDC
const POOL = "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI"; // Etherfuse
const BLND = "CD25MNVTZDL4Y3XBCPCJXGXATV5WUHHOWMYFF4YBEGU5FCPGMYTVG5JY";

async function main() {
  console.log(`Deploying to MAINNET with wasm hash: ${WASM_HASH}`);
  console.log(`Deployer: ${account}`);
  console.log(`Asset (USDC): ${ASSET}`);
  console.log(`Pool (Etherfuse): ${POOL}`);
  console.log(`Router: ${ROUTER}`);
  console.log(`Keeper: ${KEEPER}`);

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
    wasmHash: Buffer.from(WASM_HASH, "hex"),
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
      console.log(`\n\n>>> Update frontend/src/defindex.ts MAINNET_VAULTS vaultId with: ${addr.toString()}`);
    }
  } else {
    console.error("Deployment failed:", JSON.stringify(result, null, 2).slice(0, 3000));
  }
}

main().catch(console.error);
