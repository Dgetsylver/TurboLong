/**
 * Acquire a testnet vault position — SCF T3.2 listing prerequisite.
 *
 * The Aquarius pool is seeded with receipt tokens, and receipt tokens only
 * exist by depositing into the vault. This does the whole chain: classic
 * trustline for the underlying, buy it off the testnet DEX, deposit into the
 * strategy, then report the minted receipt-token balance.
 *
 * Testnet only — it buys assets off a testnet orderbook and assumes friendbot
 * XLM. On mainnet you already hold the underlying.
 *
 * Usage:
 *   cd scripts
 *   SECRET_KEY=S... npx tsx deposit_testnet_vault.ts --asset USDC --amount 100
 */
import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";

/** Testnet vaults, mirroring TESTNET_VAULTS in frontend/src/defindex.ts. */
const VAULTS: Record<string, { strategy: string; shareToken: string; underlying: string; issuer: string }> = {
  USDC: {
    strategy: "CCGM3FT4HKLXGTD5FZYSIWTOPR4REIEMTTC23GU6PHSLBXBADKFQPEKR",
    shareToken: "CDWADWK2AYWWCZOZAHAPAKJDYXAST4VSDAPTIKQZRX7ZLN4YKP5U2G5A",
    underlying: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
};

const argv = process.argv.slice(2);
const argOf = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ASSET = argOf("--asset") ?? "USDC";
const AMOUNT = Number(argOf("--amount") ?? "100");
const SKIP_BUY = argv.includes("--skip-buy");
/** Buy the underlying and stop — for topping up the seed side of the pool,
 *  which needs underlying held in the wallet, not deposited into the vault. */
const BUY_ONLY = argv.includes("--buy-only");

const vault = VAULTS[ASSET];
if (!vault) {
  console.error(`No testnet vault for --asset ${ASSET}. Known: ${Object.keys(VAULTS).join(", ")}`);
  process.exit(1);
}

const SECRET = process.env.SECRET_KEY;
if (!SECRET) {
  console.error("SECRET_KEY is required.");
  process.exit(1);
}
const kp = Keypair.fromSecret(SECRET);
const user = kp.publicKey();
const horizon = new Horizon.Server(HORIZON);
const server = new SorobanRpc.Server(RPC_URL);

const STROOPS = 10_000_000n;
const asset = new Asset(ASSET, vault.issuer);

async function tokenBalance(token: string): Promise<bigint> {
  const acc = await server.getAccount(user);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(new Contract(token).call("balance", nativeToScVal(user, { type: "address" })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) return 0n;
  return BigInt(scValToNative(sim.result!.retval) as string | number | bigint);
}

const fmt = (v: bigint) => (Number(v) / Number(STROOPS)).toFixed(4);

async function main() {
  console.log(`\nSeeding a ${ASSET} vault position for ${user}`);

  // 1. Trustline for the classic underlying.
  const account = await horizon.loadAccount(user);
  const has = account.balances.some(
    (b) => "asset_code" in b && b.asset_code === ASSET && b.asset_issuer === vault.issuer,
  );
  if (has) {
    console.log(`  ✓ ${ASSET} trustline already present`);
  } else {
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const r = await horizon.submitTransaction(tx);
    console.log(`  ✓ ${ASSET} trustline  tx=${(r as { hash: string }).hash}`);
  }

  // 2. Buy the underlying off the testnet DEX.
  if (!SKIP_BUY) {
    // --buy-only tops up the wallet exactly; the deposit path adds headroom so
    // rounding can't leave the deposit short.
    const want = (BUY_ONLY ? AMOUNT : AMOUNT * 1.02).toFixed(7);
    const paths = await horizon
      .strictReceivePaths([Asset.native()], asset, want)
      .call()
      .then((r) => r.records);
    if (!paths.length) {
      console.error(`\n✗ No XLM→${ASSET} path for ${want}. Try a smaller --amount, or --skip-buy if already funded.`);
      process.exit(1);
    }
    const best = paths.reduce((a, b) => (Number(a.source_amount) <= Number(b.source_amount) ? a : b));
    const sendMax = (Number(best.source_amount) * 1.5).toFixed(7);
    console.log(`  buying ${want} ${ASSET} for ~${best.source_amount} XLM`);

    const fresh = await horizon.loadAccount(user);
    const tx = new TransactionBuilder(fresh, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax,
          destination: user,
          destAsset: asset,
          destAmount: want,
          path: best.path.map((p) =>
            p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
          ),
        }),
      )
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const r = await horizon.submitTransaction(tx);
    console.log(`  ✓ bought ${ASSET}  tx=${(r as { hash: string }).hash}`);
  }

  if (BUY_ONLY) {
    console.log(`\n  --buy-only: ${ASSET} is in the wallet, not deposited.`);
    return;
  }

  // 3. Deposit into the strategy — this is what mints the receipt tokens.
  const before = await tokenBalance(vault.shareToken);
  const amountStroops = BigInt(Math.round(AMOUNT * Number(STROOPS)));
  console.log(`\n  depositing ${AMOUNT} ${ASSET} into ${vault.strategy}`);

  const acc = await server.getAccount(user);
  const tx = new TransactionBuilder(acc, { fee: "10000000", networkPassphrase: Networks.TESTNET })
    .addOperation(
      new Contract(vault.strategy).call(
        "deposit",
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(user, { type: "address" }),
      ),
    )
    .setTimeout(300)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`deposit send failed: ${JSON.stringify(sent).slice(0, 400)}`);
  let res = await server.getTransaction(sent.hash);
  while (res.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1500));
    res = await server.getTransaction(sent.hash);
  }
  if (res.status !== "SUCCESS") throw new Error(`deposit failed: ${JSON.stringify(res).slice(0, 600)}`);
  console.log(`  ✓ deposited  tx=${sent.hash}`);

  const after = await tokenBalance(vault.shareToken);
  console.log(`\n  receipt tokens: ${fmt(before)} → ${fmt(after)}  (+${fmt(after - before)})`);
  console.log(`\n  Next: seed the Aquarius pool with these shares —`);
  console.log(
    `    SECRET_KEY=... npx tsx aquarius_create_pool.ts --asset ${ASSET} \\\n` +
      `      --seed-shares ${fmt(after - before)} --seed-underlying <matching ${ASSET}> --dry-run`,
  );
}

main().catch((e) => {
  const detail = e?.response?.data?.extras?.result_codes ?? e?.message ?? e;
  console.error(`\n✗ ${typeof detail === "object" ? JSON.stringify(detail) : detail}`);
  process.exit(1);
});
