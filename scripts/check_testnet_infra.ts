/**
 * Quick existence/symbol check for the testnet BLND token + Soroswap router used
 * by the strategy constructor, so the testnet deploy doesn't surprise us.
 * Read-only. Usage: npx tsx scripts/check_testnet_infra.ts
 */
import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  rpc as SorobanRpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const server = new SorobanRpc.Server(RPC_URL);

const BLND = "CB22KRA3YZVCNCQI64JQ5WE7UY2VAV7WFLK6A2JN3HEX56T2EDAFO7QF";
const ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

async function sim(op: xdr.Operation): Promise<any> {
  const acc = new Account(NULL_ACCOUNT, "0");
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: NETWORK })
    .addOperation(op)
    .setTimeout(30)
    .build();
  const res = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(res)) return { __error: true };
  return scValToNative(res.result!.retval);
}

async function main() {
  const blndSym = await sim(new Contract(BLND).call("symbol"));
  console.log(`BLND (${BLND}): symbol=${JSON.stringify(blndSym)}`);

  // Soroswap router exposes get_pair / router_get_amounts_out etc.; just probe a
  // cheap read that exists on the router to confirm the contract is live.
  const routerProbe = await sim(new Contract(ROUTER).call("get_factory"));
  console.log(`Router (${ROUTER}): get_factory=${JSON.stringify(routerProbe)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
