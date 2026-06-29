/**
 * Query the testnet Blend pool reserves to know which assets are available
 * before deploying the 4-asset testnet rehearsal vaults.
 *
 * Lists the pool's reserve list and, for each reserve, the token symbol/name +
 * reserve index + collateral factor. Read-only (simulation), no key needed.
 *
 * Usage: npx tsx scripts/query_testnet_pool.ts
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Networks,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const POOL = process.env.POOL ?? "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW";

const server = new SorobanRpc.Server(RPC_URL);
const big = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const res = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(res)) {
    return { __error: (res as any).error ?? "simulation failed" };
  }
  return scValToNative(res.result!.retval);
}

async function main() {
  console.log(`Testnet pool query — ${POOL}\n  rpc=${RPC_URL}\n`);

  const pool = new Contract(POOL);

  const reserveList = await sim(pool.call("get_reserve_list"));
  if (reserveList?.__error) {
    console.error("get_reserve_list failed — pool may not exist (testnet reset?).");
    console.error(JSON.stringify(reserveList.__error, big, 2));
    process.exit(2);
  }
  console.log(`Reserves (${reserveList.length}):`);

  for (const assetId of reserveList as string[]) {
    const token = new Contract(assetId);
    const symbol = await sim(token.call("symbol"));
    const name = await sim(token.call("name"));
    const reserve = await sim(pool.call("get_reserve", new Address(assetId).toScVal()));
    const idx = reserve?.config?.index;
    const cFactor = reserve?.config?.c_factor;
    console.log(
      `  - ${String(symbol).padEnd(8)} idx=${idx ?? "?"} c_factor=${cFactor ?? "?"}  ${assetId}  (${name})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
