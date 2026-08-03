/**
 * Acquire testnet AQUA for the Aquarius pool-creation fee — SCF T3.2 helper.
 *
 * `init_standard_pool` pulls its fee in AQUA from the signer, so a listing run
 * needs both an AQUA trustline and a balance. On testnet the fee is 1 AQUA and
 * there is a live XLM→AQUA orderbook, so this is a trustline plus a
 * strict-receive path payment — a couple of hundredths of an XLM.
 *
 * Mainnet has no equivalent: 300,000 AQUA is a treasury decision, not a script.
 *
 * Usage:
 *   cd scripts
 *   SECRET_KEY=S... npx tsx fund_testnet_aqua.ts            # buys 2 AQUA
 *   SECRET_KEY=S... npx tsx fund_testnet_aqua.ts --amount 5
 */
import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder, BASE_FEE } from "@stellar/stellar-sdk";

const HORIZON = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const AQUA_ISSUER = "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER";
const AQUA = new Asset("AQUA", AQUA_ISSUER);

const argv = process.argv.slice(2);
const argOf = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const AMOUNT = argOf("--amount") ?? "2";

const SECRET = process.env.SECRET_KEY;
if (!SECRET) {
  console.error("SECRET_KEY is required.");
  process.exit(1);
}
const kp = Keypair.fromSecret(SECRET);
const server = new Horizon.Server(HORIZON);

/** Slippage headroom on the quoted cost, so a moving book doesn't fail the tx. */
const SEND_MAX_MULTIPLIER = 1.5;

async function main() {
  console.log(`\nAcquiring ${AMOUNT} AQUA on testnet for ${kp.publicKey()}`);

  const account = await server.loadAccount(kp.publicKey());
  const hasTrustline = account.balances.some(
    (b) => "asset_code" in b && b.asset_code === "AQUA" && b.asset_issuer === AQUA_ISSUER,
  );

  // 1. Trustline. Separate tx: the path payment below cannot credit an asset
  //    the account has no line for, so this must already be committed.
  if (hasTrustline) {
    console.log("  ✓ AQUA trustline already present");
  } else {
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: AQUA }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    const res = await server.submitTransaction(tx);
    console.log(`  ✓ trustline created  tx=${(res as { hash: string }).hash}`);
  }

  // 2. Quote the buy off the live orderbook.
  const paths = await server
    .strictReceivePaths([Asset.native()], AQUA, AMOUNT)
    .call()
    .then((r) => r.records);
  if (!paths.length) {
    console.error(`\n✗ No XLM→AQUA path for ${AMOUNT} AQUA. Try a smaller --amount.`);
    process.exit(1);
  }
  const best = paths.reduce((a, b) => (Number(a.source_amount) <= Number(b.source_amount) ? a : b));
  const sendMax = (Number(best.source_amount) * SEND_MAX_MULTIPLIER).toFixed(7);
  console.log(`  quote: ${best.source_amount} XLM  (sendMax ${sendMax})`);

  // 3. Buy.
  const fresh = await server.loadAccount(kp.publicKey());
  const tx = new TransactionBuilder(fresh, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: kp.publicKey(),
        destAsset: AQUA,
        destAmount: AMOUNT,
        path: best.path.map((p) =>
          p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
        ),
      }),
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const res = await server.submitTransaction(tx);
  console.log(`  ✓ bought ${AMOUNT} AQUA  tx=${(res as { hash: string }).hash}`);

  const after = await server.loadAccount(kp.publicKey());
  const bal = after.balances.find((b) => "asset_code" in b && b.asset_code === "AQUA");
  console.log(`\n  AQUA balance: ${bal && "balance" in bal ? bal.balance : "?"}`);
}

main().catch((e) => {
  const detail = e?.response?.data?.extras?.result_codes ?? e?.message ?? e;
  console.error(`\n✗ ${typeof detail === "object" ? JSON.stringify(detail) : detail}`);
  process.exit(1);
});
