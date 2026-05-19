/**
 * Test the BlendLeverageStrategy contract on testnet.
 *
 * Steps:
 *   1. Acquire USDC via testnet DEX (XLM → USDC)
 *   2. Deposit into the strategy contract
 *   3. Check balance & health factor
 *   4. Withdraw
 *
 * Usage:
 *   TESTNET_SECRET=S... npx tsx scripts/test_strategy.ts
 *   # or put TESTNET_SECRET=S... in .env.local / scripts/.env.local
 */

import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  rpc as SorobanRpc,
  TransactionBuilder,
  xdr,
  Address,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import * as fs from "fs";

// ── Constants ────────────────────────────────────────────────────────────────

const STRATEGY_ID = "CDOETIUHCETALQMBMYUXGFJFA34KDTV74AMHTWXJLY2XUVNZ23JDLJZA";
const POOL_ID     = "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW";
const USDC_ID     = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const RPC_URL     = "https://soroban-testnet.stellar.org";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE  = Networks.TESTNET;

function loadEnvLocal() {
  for (const file of [".env.local", "scripts/.env.local"]) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  }
}

function getTestnetKeypair(): Keypair {
  loadEnvLocal();
  const secret = process.env.TESTNET_SECRET?.trim();
  if (!secret) {
    console.error("Missing TESTNET_SECRET. Add it to your shell env or local .env.local file; never commit secret keys.");
    process.exit(1);
  }
  try {
    return Keypair.fromSecret(secret);
  } catch {
    console.error("Invalid TESTNET_SECRET. Expected a Stellar secret seed beginning with S.");
    process.exit(1);
  }
}

const keypair = getTestnetKeypair();
const account = keypair.publicKey();

const server  = new SorobanRpc.Server(RPC_URL);
const horizon = new Horizon.Server(HORIZON_URL);

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sendTx(tx: any): Promise<any> {
  const prepared = await server.prepareTransaction(tx);
  (prepared as any).sign(keypair);
  const response = await server.sendTransaction(prepared);
  console.log(`  tx: ${response.hash}`);

  let result = await server.getTransaction(response.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise(r => setTimeout(r, 1000));
    result = await server.getTransaction(response.hash);
  }

  if (result.status === "SUCCESS") {
    return result;
  } else {
    console.error("  ❌ Transaction failed:", JSON.stringify(result, null, 2));
    throw new Error(`Transaction failed: ${result.status}`);
  }
}

async function ensureUsdc(needed: number): Promise<void> {
  const usdcAsset = new Asset("USDC", USDC_ISSUER);
  const acc = await horizon.loadAccount(account);

  const usdcBal = acc.balances.find(
    (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
  );
  const current = usdcBal ? parseFloat(usdcBal.balance) : 0;
  console.log(`Classic USDC balance: ${current}`);

  if (current >= needed) {
    console.log("✓ Sufficient USDC");
    return;
  }

  const toBuy = needed - current + 1; // +1 buffer
  console.log(`Buying ${toBuy} USDC via DEX...`);

  const txBuilder = new TransactionBuilder(acc, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  }).setTimeout(60);

  if (!usdcBal) {
    txBuilder.addOperation(
      Operation.changeTrust({ asset: usdcAsset, limit: "1000000" })
    );
  }

  // Path payment: send max 500 XLM, receive at least toBuy USDC
  txBuilder.addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: Asset.native(),
      sendMax: "500",
      destination: account,
      destAsset: usdcAsset,
      destAmount: toBuy.toFixed(7),
    })
  );

  const tx = txBuilder.build();
  tx.sign(keypair);
  const resp = await horizon.submitTransaction(tx);
  console.log(`✓ DEX swap complete: ${(resp as any).hash}`);
}

async function wrapUsdc(): Promise<void> {
  // Wrap classic USDC to Soroban via SAC
  // This is done by calling the USDC SAC contract's `transfer` to the strategy
  // Actually, `deposit` on the strategy calls `token.transfer(from, strategy, amount)`
  // which works with SAC if the user has classic balance + trustline
  console.log("USDC SAC should auto-wrap on Soroban transfer");
}

// ── Main test flow ───────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== BlendLeverageStrategy Testnet Test ===`);
  console.log(`Account:  ${account}`);
  console.log(`Strategy: ${STRATEGY_ID}`);
  console.log(`Pool:     ${POOL_ID}\n`);

  // Step 1: Get USDC
  await ensureUsdc(10);

  // Step 2: Check strategy state before deposit
  console.log("\n--- Pre-deposit state ---");
  const strategyContract = new Contract(STRATEGY_ID);
  const acc = await server.getAccount(account);

  // Check balance
  {
    const tx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(30)
      .addOperation(
        strategyContract.call(
          "balance",
          new Address(account).toScVal(),
        )
      )
      .build();

    const sim = await server.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      console.log(`Strategy balance: ${scValToNative(sim.result.retval)}`);
    }
  }

  // Check health factor
  {
    const tx = new TransactionBuilder(acc, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(30)
      .addOperation(
        strategyContract.call("health_factor")
      )
      .build();

    const sim = await server.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      const hf = BigInt(scValToNative(sim.result.retval));
      if (hf > 1000000000n) {
        console.log(`Health factor: ∞ (no debt)`);
      } else {
        console.log(`Health factor: ${Number(hf) / 10_000_000}`);
      }
    }
  }

  // Step 3: Deposit 5 USDC (50_000_000 stroops)
  const depositAmount = 50_000_000n; // 5 USDC
  console.log(`\n--- Depositing ${Number(depositAmount) / 10_000_000} USDC ---`);

  {
    const acc2 = await server.getAccount(account);
    const tx = new TransactionBuilder(acc2, {
      fee: "10000000", // 1 XLM fee for complex tx
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(120)
      .addOperation(
        strategyContract.call(
          "deposit",
          nativeToScVal(depositAmount, { type: "i128" }),
          new Address(account).toScVal(),
        )
      )
      .build();

    try {
      const result = await sendTx(tx);
      if (result.returnValue) {
        console.log(`✓ Deposit result (underlying balance): ${scValToNative(result.returnValue)}`);
      }
    } catch (e: any) {
      console.error(`❌ Deposit failed: ${e.message}`);

      // Try simulation to get more details
      const acc3 = await server.getAccount(account);
      const tx2 = new TransactionBuilder(acc3, {
        fee: "10000000",
        networkPassphrase: PASSPHRASE,
      })
        .setTimeout(120)
        .addOperation(
          strategyContract.call(
            "deposit",
            nativeToScVal(depositAmount, { type: "i128" }),
            new Address(account).toScVal(),
          )
        )
        .build();

      const sim = await server.simulateTransaction(tx2);
      console.log("Simulation:", JSON.stringify(sim, null, 2).slice(0, 2000));
      return;
    }
  }

  // Step 4: Check post-deposit state
  console.log("\n--- Post-deposit state ---");
  {
    const acc3 = await server.getAccount(account);
    const tx = new TransactionBuilder(acc3, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(30)
      .addOperation(
        strategyContract.call(
          "balance",
          new Address(account).toScVal(),
        )
      )
      .build();

    const sim = await server.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      console.log(`Strategy balance: ${scValToNative(sim.result.retval)}`);
    }
  }

  {
    const acc3 = await server.getAccount(account);
    const tx = new TransactionBuilder(acc3, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(30)
      .addOperation(
        strategyContract.call("health_factor")
      )
      .build();

    const sim = await server.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      const hf = BigInt(scValToNative(sim.result.retval));
      console.log(`Health factor: ${Number(hf) / 10_000_000}`);
    }
  }

  {
    const acc3 = await server.getAccount(account);
    const tx = new TransactionBuilder(acc3, {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(30)
      .addOperation(
        strategyContract.call("position")
      )
      .build();

    const sim = await server.simulateTransaction(tx);
    if ("result" in sim && sim.result) {
      const pos = scValToNative(sim.result.retval);
      console.log(`Position:`, pos);
    }
  }

  // Step 5: Withdraw half
  console.log("\n--- Withdrawing 2.5 USDC ---");
  {
    const withdrawAmount = 25_000_000n; // 2.5 USDC
    const acc4 = await server.getAccount(account);
    const tx = new TransactionBuilder(acc4, {
      fee: "10000000",
      networkPassphrase: PASSPHRASE,
    })
      .setTimeout(120)
      .addOperation(
        strategyContract.call(
          "withdraw",
          nativeToScVal(withdrawAmount, { type: "i128" }),
          new Address(account).toScVal(),
          new Address(account).toScVal(),
        )
      )
      .build();

    try {
      const result = await sendTx(tx);
      if (result.returnValue) {
        console.log(`✓ Withdraw result (remaining balance): ${scValToNative(result.returnValue)}`);
      }
    } catch (e: any) {
      console.error(`❌ Withdraw failed: ${e.message}`);
    }
  }

  console.log("\n=== Test Complete ===\n");
}

main().catch(console.error);
