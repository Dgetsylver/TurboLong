import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Asset,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import {
  buildApproveXdr,
  buildClaimXdr,
  buildOpenPositionXdr,
  buildSwapBlndXdr,
  buildTrustlineXdr,
  confirmSubmittedTransaction,
  getMissingTrustlines,
  getPoolAssets,
  getKnownPools,
  setNetwork,
  verifyContractAccount,
} from "../src/blend";
import { buildVaultDepositXdr, buildVaultWithdrawXdr, buildVaultRebalanceXdr, getVaults } from "../src/defindex";
import { buildAquariusSwapXdr } from "../src/aquarius_trade";
import { nidoConfig } from "../src/nido";

const contractAccount = StrKey.encodeContract(Buffer.alloc(32, 7));
const classicAccount = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 8));
const hash = "a".repeat(64);
const listing = {
  shareToken: StrKey.encodeContract(Buffer.alloc(32, 1)),
  pairedWith: StrKey.encodeContract(Buffer.alloc(32, 2)),
  poolIndex: "a".repeat(64),
  tokens: [StrKey.encodeContract(Buffer.alloc(32, 1)), StrKey.encodeContract(Buffer.alloc(32, 2))] as [string, string],
};
const classicBuilders: [string, (owner: string) => Promise<string>, string][] = [
  ["claim before conversion", (owner) => buildClaimXdr(getKnownPools()[0], owner, [0, 1]), "claim"],
  ["vault deposit", (owner) => buildVaultDepositXdr(getVaults()[0], owner, 1), "deposit"],
  ["vault withdrawal", (owner) => buildVaultWithdrawXdr(getVaults()[0], owner, 1), "withdraw"],
  ["vault rebalance", (owner) => buildVaultRebalanceXdr(getVaults()[0], owner), "rebalance"],
  [
    "receipt-token sale",
    (owner) => buildAquariusSwapXdr(owner, listing, listing.shareToken, listing.pairedWith, 10n, 9n),
    "swap_chained",
  ],
  [
    "receipt-token purchase",
    (owner) => buildAquariusSwapXdr(owner, listing, listing.pairedWith, listing.shareToken, 10n, 9n),
    "swap_chained",
  ],
];

beforeEach(() => {
  vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (address) => new Account(address, "42"));
  vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({
    sequence: 1000,
  } as never);
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async (tx) => {
    const op = (tx as Transaction).operations[0];
    if (op.type !== "invokeHostFunction") throw new Error("Expected a contract call");
    const args = op.func.invokeContract();
    return {
      _parsed: true,
      id: "simulation",
      latestLedger: 1000,
      events: [],
      minResourceFee: "100",
      transactionData: new SorobanDataBuilder(),
      result: {
        retval: nativeToScVal(null),
        auth: args.functionName().toString() === "rebalance" ? [] : [
          new xdr.SorobanAuthorizationEntry({
            credentials: (tx as Transaction).source === classicAccount
              ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
              : xdr.SorobanCredentials.sorobanCredentialsAddress(
              new xdr.SorobanAddressCredentials({
                address: new Address(contractAccount).toScAddress(),
                nonce: xdr.Int64.fromString("1"),
                signatureExpirationLedger: 0,
                signature: xdr.ScVal.scvVoid(),
              }),
            ),
            rootInvocation: new xdr.SorobanAuthorizedInvocation({
              function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(args),
              subInvocations: [],
            }),
          }),
        ],
      },
    } as rpc.Api.SimulateTransactionSuccessResponse;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setNetwork("mainnet");
});

describe.each(["mainnet", "testnet"] as const)("%s smart-account builders", (network) => {
  it.each([contractAccount, classicAccount])("keeps owner %s in approval and Blend arguments", async (owner) => {
    setNetwork(network);
    const pool = getKnownPools()[0];
    const asset = getPoolAssets(pool)[0];
    const passphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    const approval = TransactionBuilder.fromXDR(
      await buildApproveXdr(pool, owner, asset.id, 10000001n),
      passphrase,
    ) as Transaction;
    const position = TransactionBuilder.fromXDR(
      await buildOpenPositionXdr(pool, owner, asset, 10000000n, 1.5),
      passphrase,
    ) as Transaction;
    const source = owner === contractAccount ? nidoConfig(network).simulationSource : owner;
    for (const tx of [approval, position]) {
      expect(tx.source).toBe(source);
      expect(tx.networkPassphrase).toBe(passphrase);
      expect(tx.signatures).toHaveLength(0);
      const op = tx.operations[0];
      if (op.type !== "invokeHostFunction") throw new Error("Expected Soroban operation");
      expect(scValToNative(op.func.invokeContract().args()[0])).toBe(owner);
      expect(op.auth).toHaveLength(1);
    }
    const approveOp = approval.operations[0] as Extract<
      (typeof approval.operations)[number],
      { type: "invokeHostFunction" }
    >;
    expect(approveOp.func.invokeContract().args().map(scValToNative)).toEqual([owner, pool.id, 10000001n, 1120]);
    const positionOp = position.operations[0] as typeof approveOp;
    expect(positionOp.func.invokeContract().functionName().toString()).toBe("submit_with_allowance");
    expect(positionOp.func.invokeContract().args().slice(0, 3).map(scValToNative)).toEqual([owner, owner, owner]);
    expect(rpc.Server.prototype.getAccount).not.toHaveBeenCalledWith(contractAccount);
  });

  it("skips classic trustlines for contract accounts", async () => {
    setNetwork(network);
    expect(await getMissingTrustlines(getKnownPools()[0], contractAccount, getKnownPools()[0].assetIds[0])).toEqual({
      missing: [],
      currentCount: 0,
    });
    expect(rpc.Server.prototype.simulateTransaction).not.toHaveBeenCalled();
  });

  it.each(classicBuilders)("rejects %s before any RPC for a contract account", async (_name, build) => {
    setNetwork(network);
    await expect(build(contractAccount)).rejects.toThrow(/classic Stellar wallet/);
    expect(rpc.Server.prototype.getAccount).not.toHaveBeenCalled();
    expect(rpc.Server.prototype.simulateTransaction).not.toHaveBeenCalled();
  });
});

it.each(classicBuilders)("preserves classic-wallet %s", async (_name, build, method) => {
  setNetwork("testnet");
  const tx = TransactionBuilder.fromXDR(await build(classicAccount), Networks.TESTNET) as Transaction;
  expect(tx.source).toBe(classicAccount);
  expect(rpc.Server.prototype.getAccount).toHaveBeenCalledWith(classicAccount);
  const op = tx.operations[0];
  if (op.type !== "invokeHostFunction") throw new Error("Expected Soroban operation");
  expect(op.func.invokeContract().functionName().toString()).toBe(method);
  const args = op.func.invokeContract().args().map(scValToNative);
  if (method === "claim") expect(args).toEqual([classicAccount, [0, 1], classicAccount]);
  if (method === "deposit") expect(args).toEqual([10000000n, classicAccount]);
  if (method === "withdraw") expect(args).toEqual([10000000n, classicAccount, classicAccount]);
  if (method === "rebalance") {
    expect(args).toEqual([]);
    expect(op.auth).toEqual([]);
  }
  if (method === "swap_chained") expect(args[0]).toBe(classicAccount);
});

it("propagates approval simulation failure", async () => {
  vi.mocked(rpc.Server.prototype.simulateTransaction).mockResolvedValue({
    error: "denied",
  } as never);
  await expect(
    buildApproveXdr(getKnownPools()[0], contractAccount, getKnownPools()[0].assetIds[0], 1n),
  ).rejects.toThrow("denied");
});

it("rejects classic operations for contract accounts before Horizon access", async () => {
  await expect(buildTrustlineXdr([new Asset("TEST", classicAccount)], contractAccount)).rejects.toThrow(/classic/);
  await expect(buildSwapBlndXdr(contractAccount, 1, getKnownPools()[0].assetIds[0])).rejects.toThrow(/classic/);
});

it("requires the connected contract to exist on the active RPC network", async () => {
  const read = vi.spyOn(rpc.Server.prototype, "getContractData").mockRejectedValue(new Error("missing contract"));
  await expect(verifyContractAccount(contractAccount)).rejects.toThrow("missing contract");
  expect(read).toHaveBeenCalledWith(contractAccount, xdr.ScVal.scvLedgerKeyContractInstance());
});

it.each(["SUCCESS", "FAILED"] as const)("reads wallet confirmation %s without broadcasting", async (status) => {
  const read = vi.spyOn(rpc.Server.prototype, "getTransaction").mockResolvedValue({ status } as never);
  const send = vi.spyOn(rpc.Server.prototype, "sendTransaction");
  if (status === "SUCCESS") expect(await confirmSubmittedTransaction(hash)).toBe(hash);
  else await expect(confirmSubmittedTransaction(hash)).rejects.toThrow("On-chain failure");
  expect(read).toHaveBeenCalledWith(hash);
  expect(send).not.toHaveBeenCalled();
});
