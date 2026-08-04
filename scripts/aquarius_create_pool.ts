/**
 * List a Turbolong vault receipt (share) token on Aquarius — SCF T3.2.
 *
 * Creates a constant-product pool pairing the vault's SEP-41 receipt token
 * against its underlying asset, seeds it with liquidity, and prints the
 * `AQUARIUS_LISTINGS` entry to paste into frontend/src/aquarius_listings.ts.
 *
 * Idempotent: if the pool already exists it is reused rather than re-created
 * (re-creating would burn the AQUA fee a second time for nothing).
 *
 * Usage — testnet rehearsal:
 *   SECRET_KEY=S... npx tsx scripts/aquarius_create_pool.ts --asset USDC \
 *     --seed-shares 100 --seed-underlying 100 --dry-run
 *   SECRET_KEY=S... npx tsx scripts/aquarius_create_pool.ts --asset USDC \
 *     --seed-shares 100 --seed-underlying 100
 *
 * Usage — mainnet (REAL FUNDS + AQUA pool-creation fee; requires CONFIRM=1):
 *   op run -- env SECRET_KEY=op://vault/turbolong-deployer/secret CONFIRM=1 \
 *     npx tsx scripts/aquarius_create_pool.ts --network mainnet --asset USDC \
 *     --seed-shares 1000 --seed-underlying 1000
 *
 * The signer must already hold: the receipt tokens to seed (deposit into the
 * vault first), the matching underlying, XLM for fees, and — on mainnet — the
 * AQUA pool-creation fee.
 *
 * Router ABI (verified live on both networks):
 *   init_standard_pool(user, tokens: Vec<Address>, fee_fraction: u32)
 *       -> (BytesN<32> pool_index, Address pool_address)
 *   get_pools(tokens: Vec<Address>) -> Map<BytesN<32>, Address>
 *   deposit(user, tokens, pool_index, desired_amounts: Vec<u128>, min_shares: u128)
 *       -> (Vec<u128>, u128)
 */
import {
  Contract,
  Keypair,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// ── Networks ─────────────────────────────────────────────────────────────────

interface NetCfg {
  passphrase: string;
  rpcUrl: string;
  router: string;
}

const NETWORKS: Record<string, NetCfg> = {
  mainnet: {
    passphrase: Networks.PUBLIC,
    rpcUrl: process.env.RPC_URL ?? "https://mainnet.sorobanrpc.com",
    router: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
  },
  testnet: {
    passphrase: Networks.TESTNET,
    rpcUrl: process.env.RPC_URL ?? "https://soroban-testnet.stellar.org",
    // Aquarius rotates this on testnet resets — re-verify before a listing run:
    //   stellar contract info interface --id <id> --network testnet
    router: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
  },
};

/**
 * Receipt token + underlying per vault, mirroring the TESTNET_VAULTS /
 * MAINNET_VAULTS tables in frontend/src/defindex.ts. Mainnet entries stay empty
 * until the T1 D1 deploy fills deployed-vaults.mainnet.json.
 */
const VAULT_TOKENS: Record<string, Record<string, { shareToken: string; underlying: string }>> = {
  testnet: {
    USDC: {
      shareToken: "CDWADWK2AYWWCZOZAHAPAKJDYXAST4VSDAPTIKQZRX7ZLN4YKP5U2G5A",
      underlying: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    },
    CETES: {
      shareToken: "CCUT4XNXJ6H4BFUY7V2QVKLA7UIXH2GAEGCVVTOSQW4M3APHZ3SQTGPE",
      underlying: "CC72F57YTPX76HAA64JQOEGHQAPSADQWSY5DWVBR66JINPFDLNCQYHIC",
    },
    XLM: {
      shareToken: "CDDA6LYKAJTUCB4NYS25BOUM7GRVK45ELKTB4KE3557EIHPRIHMELSTD",
      underlying: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    },
    TESOURO: {
      shareToken: "CDKEYTBUW6GTHZUWXBLSVCPMGISWHSB4IWETGWUTZMKXICEUGCW4EF7N",
      underlying: "CCKA3OUWLZPX3YT335UNHIFMKSYA37M66VKGD5XZOX4BA4IKTYP4WBEE",
    },
  },
  mainnet: {},
};

/** Aquarius volatile-pool fee tiers are 1/10000 — 30 = 0.30%. */
const FEE_FRACTION = 30;
const STROOPS = 10_000_000n; // 7 dp

/**
 * Aquarius charges a one-off pool-creation fee in AQUA, pulled from the signer
 * inside `init_standard_pool`. Verified on testnet by dry-run: the router
 * transfers 1.0 AQUA (asset AQUA:GAHPYWLK…, SAC CDNVQW44…) and fails with
 * Error(Contract, #13) / "trustline entry is missing" when the signer has no
 * AQUA trustline. Mainnet is documented at 300,000 AQUA per pool.
 *
 * These figures drive the preflight warning only — the simulation is always the
 * authority, so a changed fee surfaces as a failed dry-run rather than a
 * wrong-but-silent run.
 */
const AQUA_FEE: Record<string, { issuer: string; sac: string; amount: number }> = {
  testnet: {
    issuer: "GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER",
    sac: "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE",
    amount: 1,
  },
  mainnet: {
    issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA",
    sac: "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK",
    amount: 300_000,
  },
};

// ── Args ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(name);

const NETWORK = arg("--network") ?? "testnet";
const ASSET = arg("--asset") ?? "USDC";
const DRY_RUN = flag("--dry-run") || process.env.DRY_RUN === "1";
const FORCE = flag("--force");
const SEED_SHARES = Number(arg("--seed-shares") ?? "0");
const SEED_UNDERLYING = Number(arg("--seed-underlying") ?? "0");

const net = NETWORKS[NETWORK];
if (!net) {
  console.error(`Unknown --network ${NETWORK} (expected mainnet | testnet)`);
  process.exit(1);
}

const tokens0 = VAULT_TOKENS[NETWORK]?.[ASSET];
if (!tokens0) {
  const known = Object.keys(VAULT_TOKENS[NETWORK] ?? {}).join(", ") || "(none configured)";
  console.error(`No ${NETWORK} vault tokens for --asset ${ASSET}. Known: ${known}`);
  if (NETWORK === "mainnet") console.error("Mainnet entries are filled from deployed-vaults.mainnet.json after T1 D1.");
  process.exit(1);
}

const SECRET = process.env.SECRET_KEY;
if (!SECRET) {
  console.error("SECRET_KEY is required (use op run / a secrets manager; never inline a key).");
  process.exit(1);
}

// Mainnet spends the AQUA pool-creation fee and real liquidity — make that an
// explicit, separate act of intent rather than a --network typo away.
if (NETWORK === "mainnet" && !DRY_RUN && process.env.CONFIRM !== "1") {
  console.error("Refusing to run against mainnet without CONFIRM=1 (this spends the AQUA pool fee + real liquidity).");
  process.exit(1);
}

const keypair = Keypair.fromSecret(SECRET);
const user = keypair.publicKey();
const server = new SorobanRpc.Server(net.rpcUrl);
const router = new Contract(net.router);

// ── Helpers ──────────────────────────────────────────────────────────────────

const addr = (a: string) => nativeToScVal(a, { type: "address" });
const u128 = (v: bigint) => nativeToScVal(v, { type: "u128" });

/**
 * Aquarius keys a pool by its token set, and orders that set by the raw 32-byte
 * contract ID. Sorting the `C…` strkeys as strings is NOT equivalent: base32
 * maps A-Z→0-25 and 2-7→26-31, so ASCII order and value order disagree. Decode
 * to bytes and compare there.
 */
function canonicalOrder(a: string, b: string): [string, string] {
  const ba = Buffer.from(StrKey.decodeContract(a));
  const bb = Buffer.from(StrKey.decodeContract(b));
  return Buffer.compare(ba, bb) <= 0 ? [a, b] : [b, a];
}

const toStroops = (v: number) => BigInt(Math.round(v * Number(STROOPS)));

async function simulate(method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const acc = await server.getAccount(user);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: net.passphrase })
    .addOperation(router.call(method, ...args))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`${method} simulation failed: ${JSON.stringify(sim).slice(0, 400)}`);
  }
  return sim.result!.retval;
}

async function invoke(method: string, args: xdr.ScVal[], label: string): Promise<xdr.ScVal | null> {
  const acc = await server.getAccount(user);
  const tx = new TransactionBuilder(acc, { fee: "10000000", networkPassphrase: net.passphrase })
    .addOperation(router.call(method, ...args))
    .setTimeout(300)
    .build();

  const prepared = await server.prepareTransaction(tx);
  if (DRY_RUN) {
    console.log(`  [dry-run] ${label} simulated OK, not submitted`);
    return null;
  }

  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`${label} send failed: ${JSON.stringify(sent).slice(0, 400)}`);

  let res = await server.getTransaction(sent.hash);
  while (res.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1500));
    res = await server.getTransaction(sent.hash);
  }
  if (res.status !== "SUCCESS") throw new Error(`${label} failed: ${JSON.stringify(res).slice(0, 500)}`);
  console.log(`  ✓ ${label}  tx=${sent.hash}`);
  return res.returnValue ?? null;
}

/**
 * Existing pools for this token set, as { poolIndexHex: poolAddress }.
 *
 * Walks the raw ScVal map rather than going through `scValToNative`. The return
 * type is `Map<BytesN<32>, Address>`, and scValToNative lossily decodes the
 * 32-byte key into a JS string of char codes — stringifying that yields mojibake,
 * not hex, so the reused pool index would be corrupt and the follow-up `deposit`
 * would fail on a malformed BytesN<32>. `.bytes()` gives the buffer intact.
 */
async function existingPools(tokensVec: xdr.ScVal): Promise<Record<string, string>> {
  const retval = await simulate("get_pools", [tokensVec]);
  const out: Record<string, string> = {};
  for (const entry of retval.map() ?? []) {
    const hex = Buffer.from(entry.key().bytes()).toString("hex");
    out[hex] = scValToNative(entry.val()) as string;
  }
  return out;
}

/** SEP-41 `balance` of `who`, in stroops. Returns null if the token can't be read. */
async function tokenBalance(token: string, who: string): Promise<bigint | null> {
  try {
    const acc = await server.getAccount(user);
    const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: net.passphrase })
      .addOperation(new Contract(token).call("balance", addr(who)))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null;
    return BigInt(scValToNative(sim.result!.retval) as string | number | bigint);
  } catch {
    return null;
  }
}

const fmt = (v: bigint) => (Number(v) / Number(STROOPS)).toLocaleString(undefined, { maximumFractionDigits: 7 });

/**
 * Report what the signer is missing before anything is submitted. Advisory
 * only — simulation stays the authority — but it turns the router's opaque
 * `Error(Contract, #13)` into the actual instruction ("no AQUA trustline").
 */
async function preflight(needShares: bigint, needUnderlying: bigint): Promise<void> {
  console.log("\n[0/3] Preflight…");
  const fee = AQUA_FEE[NETWORK];
  const problems: string[] = [];

  const aqua = await tokenBalance(fee.sac, user);
  const needAqua = toStroops(fee.amount);
  if (aqua === null) {
    problems.push(
      `No AQUA trustline. The pool-creation fee (${fee.amount} AQUA) is pulled inside init_standard_pool.\n` +
        `      Add a trustline to AQUA:${fee.issuer}` +
        (NETWORK === "testnet"
          ? `, then buy some — on testnet ~2 AQUA costs well under 1 XLM via a\n      strict-receive path payment from native.`
          : `, then fund the account with ${fee.amount.toLocaleString()} AQUA.`),
    );
  } else if (aqua < needAqua) {
    problems.push(`AQUA balance ${fmt(aqua)} < pool-creation fee ${fee.amount}.`);
  } else {
    console.log(`  ✓ AQUA ${fmt(aqua)} (fee ${fee.amount})`);
  }

  if (needShares > 0n) {
    const bal = await tokenBalance(tokens0.shareToken, user);
    if (bal === null || bal < needShares) {
      problems.push(
        `Receipt-token balance ${bal === null ? "unreadable" : fmt(bal)} < seed ${fmt(needShares)}.\n` +
          `      Deposit into the ${ASSET} vault first — the shares you seed with are minted by that deposit.`,
      );
    } else {
      console.log(`  ✓ receipt ${fmt(bal)} (seeding ${fmt(needShares)})`);
    }
  }

  if (needUnderlying > 0n) {
    const bal = await tokenBalance(tokens0.underlying, user);
    if (bal === null || bal < needUnderlying) {
      problems.push(`${ASSET} balance ${bal === null ? "unreadable" : fmt(bal)} < seed ${fmt(needUnderlying)}.`);
    } else {
      console.log(`  ✓ ${ASSET} ${fmt(bal)} (seeding ${fmt(needUnderlying)})`);
    }
  }

  if (problems.length) {
    console.log("");
    for (const p of problems) console.log(`  ✗ ${p}`);
    if (FORCE) {
      console.log("\n  --force given: continuing despite the above.");
      return;
    }
    // Abort before submitting anything. Pool creation and seeding are separate
    // transactions, so continuing on a known-insufficient balance spends the
    // AQUA creation fee and *then* fails on the seed, leaving a created-but-
    // empty pool. Better to fix the balance and run once.
    console.log("\n  Aborting before any transaction is submitted. Fix the above and re-run");
    console.log("  (pass --force to override, e.g. to create a pool now and seed it later).");
    process.exit(1);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [t0, t1] = canonicalOrder(tokens0.shareToken, tokens0.underlying);
  const tokensVec = xdr.ScVal.scvVec([addr(t0), addr(t1)]);

  console.log(`\nAquarius listing — ${ASSET} receipt token on ${NETWORK}${DRY_RUN ? "  [DRY RUN]" : ""}`);
  console.log(`  router      ${net.router}`);
  console.log(`  signer      ${user}`);
  console.log(`  receipt     ${tokens0.shareToken}`);
  console.log(`  underlying  ${tokens0.underlying}`);
  console.log(`  tokens[]    ${t0}\n              ${t1}   (canonical byte order)`);

  await preflight(toStroops(SEED_SHARES), toStroops(SEED_UNDERLYING));

  // 1. Reuse an existing pool if one is already there.
  console.log("\n[1/3] Checking for an existing pool…");
  let pools = await existingPools(tokensVec);
  let poolIndex = Object.keys(pools)[0];
  let poolAddress = poolIndex ? pools[poolIndex] : undefined;

  if (poolIndex) {
    console.log(`  already listed — reusing pool ${poolIndex} at ${poolAddress}`);
  } else {
    console.log(`  none found — creating a ${FEE_FRACTION / 100}% constant-product pool`);
    const ret = await invoke(
      "init_standard_pool",
      [addr(user), tokensVec, nativeToScVal(FEE_FRACTION, { type: "u32" })],
      "init_standard_pool",
    );
    if (ret) {
      const [idx, address] = scValToNative(ret) as [Uint8Array, string];
      poolIndex = Buffer.from(idx).toString("hex");
      poolAddress = address;
      console.log(`  pool index   ${poolIndex}`);
      console.log(`  pool address ${poolAddress}`);
    } else {
      // Dry run: nothing was created, so there is nothing to seed or print.
      console.log("\n[dry-run] Pool creation simulated OK. Re-run without --dry-run to list.");
      return;
    }
  }

  // 2. Seed liquidity.
  if (SEED_SHARES > 0 && SEED_UNDERLYING > 0) {
    console.log("\n[2/3] Seeding liquidity…");
    // desired_amounts follows the same canonical order as tokens.
    const shareAmt = toStroops(SEED_SHARES);
    const underAmt = toStroops(SEED_UNDERLYING);
    const amounts = t0 === tokens0.shareToken ? [shareAmt, underAmt] : [underAmt, shareAmt];
    console.log(`  ${SEED_SHARES} receipt + ${SEED_UNDERLYING} ${ASSET}`);
    await invoke(
      "deposit",
      [
        addr(user),
        tokensVec,
        xdr.ScVal.scvBytes(Buffer.from(poolIndex!, "hex")),
        xdr.ScVal.scvVec(amounts.map(u128)),
        u128(0n), // min_shares: first deposit into an empty pool sets the price
      ],
      "deposit (seed liquidity)",
    );
  } else {
    console.log("\n[2/3] Skipping seed (pass --seed-shares and --seed-underlying to seed).");
  }

  // 3. Print the registry entry.
  console.log("\n[3/3] Add to frontend/src/aquarius_listings.ts → AQUARIUS_LISTINGS.%s:", NETWORK);
  console.log(
    `
    ${ASSET}: {
      shareToken: "${tokens0.shareToken}",
      pairedWith: "${tokens0.underlying}",
      poolIndex: "${poolIndex}",
      poolAddress: "${poolAddress}",
      tokens: ["${t0}", "${t1}"],
    },`,
  );
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
