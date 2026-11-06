import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Networks, StrKey } from "@stellar/stellar-sdk";

const kit = vi.hoisted(() => ({
  init: vi.fn(),
  authModal: vi.fn(),
  disconnect: vi.fn(),
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock("@creit-tech/stellar-wallets-kit/sdk", () => ({
  StellarWalletsKit: kit,
}));
vi.mock("@creit-tech/stellar-wallets-kit/modules/freighter", () => ({
  FreighterModule: class {},
}));
vi.mock("@creit-tech/stellar-wallets-kit/modules/xbull", () => ({
  xBullModule: class {},
}));
vi.mock("@creit-tech/stellar-wallets-kit/modules/albedo", () => ({
  AlbedoModule: class {},
}));
vi.mock("@creit-tech/stellar-wallets-kit/modules/lobstr", () => ({
  LobstrModule: class {},
}));
vi.mock("@creit-tech/stellar-wallets-kit/modules/hana", () => ({
  HanaModule: class {},
}));
vi.mock("@creit-tech/stellar-wallets-kit/modules/ledger", () => ({
  LedgerModule: class {},
}));
vi.mock("@nidohq/stellar-wallets-kit-module", () => ({
  ACCOUNT_SWITCH_REQUESTED: "ACCOUNT_SWITCH_REQUESTED",
}));
vi.mock("../src/app/nido-module", () => ({
  TurboLongNidoModule: class {
    productId = "nido";
    constructor(public network: string) {}
  },
}));
vi.mock("../src/app/chrome", () => ({ toast: vi.fn() }));
vi.mock("../src/blend", async (original) => ({
  ...(await original<typeof import("../src/blend")>()),
  verifyContractAccount: vi.fn(),
  confirmSubmittedTransaction: vi.fn(),
  submitSignedXdr: vi.fn(),
  submitClassicXdr: vi.fn(),
}));

import { connect, switchWallet, switchNetwork, signAndSubmit, signAndSubmitClassic, signXdr } from "../src/app/wallet";
import { getState, setState } from "../src/app/state";
import { toast } from "../src/app/chrome";
import {
  confirmSubmittedTransaction,
  getActiveNetwork,
  setNetwork,
  submitClassicXdr,
  submitSignedXdr,
  verifyContractAccount,
} from "../src/blend";

const account = StrKey.encodeContract(Buffer.alloc(32, 7));
const classic = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 8));
const hash = "a".repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { setItem: vi.fn(), removeItem: vi.fn() });
  setNetwork("mainnet");
  setState({ connected: false, userAddress: null, network: "mainnet" });
  kit.getNetwork.mockResolvedValue({ networkPassphrase: Networks.PUBLIC });
  kit.authModal.mockResolvedValue({ address: account });
  kit.signTransaction.mockResolvedValue({
    submitted: true,
    signedTxXdr: hash,
    signerAddress: account,
  });
  vi.mocked(verifyContractAccount).mockResolvedValue();
  vi.mocked(confirmSubmittedTransaction).mockResolvedValue(hash);
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["mainnet", "testnet"] as const)("wallet on %s", (network) => {
  it("registers Nido, connects the contract account and verifies it on the selected chain", async () => {
    await switchNetwork(network);
    const passphrase = network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
    kit.getNetwork.mockResolvedValue({ networkPassphrase: passphrase });
    expect(kit.init.mock.lastCall?.[0].modules).toEqual(
      expect.arrayContaining([expect.objectContaining({ productId: "nido", network })]),
    );
    expect(await connect()).toBe(account);
    expect(kit.authModal).toHaveBeenCalledOnce();
    expect(verifyContractAccount).toHaveBeenCalledWith(account);
    expect(getState()).toMatchObject({ connected: true, userAddress: account });
  });
});

it("rejects a contract missing from the selected network", async () => {
  vi.mocked(verifyContractAccount).mockRejectedValue(new Error("not deployed"));
  expect(await connect()).toBeNull();
  expect(getState().connected).toBe(false);
  expect(kit.disconnect).toHaveBeenCalled();
});

it("checks a network mismatch even when switching to the same address", async () => {
  setState({ connected: true, userAddress: account });
  kit.getNetwork.mockResolvedValue({ networkPassphrase: Networks.TESTNET });
  expect(await switchWallet()).toBeNull();
  expect(getState().userAddress).toBeNull();
});

it("clears the previous connection on network switch", async () => {
  setState({ connected: true, userAddress: account });
  await switchNetwork("testnet");
  expect(kit.disconnect).toHaveBeenCalledOnce();
  expect(getState()).toMatchObject({
    connected: false,
    userAddress: null,
    network: "testnet",
  });
  expect(getActiveNetwork()).toBe("testnet");
});

it("fails closed when a contract wallet cannot report its network", async () => {
  kit.getNetwork.mockRejectedValue(new Error("network unavailable"));
  expect(await connect()).toBeNull();
});

it("preserves classic wallets that lack network reporting", async () => {
  kit.authModal.mockResolvedValue({ address: classic });
  kit.getNetwork.mockRejectedValue(new Error("not supported"));
  expect(await connect()).toBe(classic);
  expect(verifyContractAccount).not.toHaveBeenCalled();
});

it("reads back Nido's submitted hash without a second submission", async () => {
  await connect();
  expect(await signAndSubmit("unsigned", "Approve XLM")).toBe(hash);
  expect(kit.signTransaction).toHaveBeenCalledWith("unsigned", {
    networkPassphrase: Networks.PUBLIC,
    address: account,
  });
  expect(confirmSubmittedTransaction).toHaveBeenCalledWith(hash);
  expect(submitSignedXdr).not.toHaveBeenCalled();
  expect(submitClassicXdr).not.toHaveBeenCalled();
});

it("does not sign if the connected account changes during network validation", async () => {
  await connect();
  vi.mocked(verifyContractAccount).mockImplementation(async () => {
    setState({ userAddress: classic, connected: true });
  });
  await expect(signAndSubmit("unsigned", "Approve XLM")).rejects.toThrow();
  expect(kit.signTransaction).not.toHaveBeenCalled();
});

it.each(["approval cancelled", "simulation failed", "relayer failed"])(
  "propagates %s without broadcasting",
  async (message) => {
    await connect();
    kit.signTransaction.mockRejectedValue(new Error(message));
    await expect(signAndSubmit("unsigned", "Approve XLM")).rejects.toThrow(message);
    expect(submitSignedXdr).not.toHaveBeenCalled();
    expect(confirmSubmittedTransaction).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "success", expect.anything());
  },
);

it("never reports a failed chain confirmation as success", async () => {
  await connect();
  vi.mocked(confirmSubmittedTransaction).mockRejectedValue(new Error("On-chain failure"));
  await expect(signAndSubmit("unsigned", "Approve XLM")).rejects.toThrow("On-chain failure");
  expect(toast).not.toHaveBeenCalledWith(expect.anything(), "success", expect.anything());
  expect(submitSignedXdr).not.toHaveBeenCalled();
});

it("does not broadcast an unsigned source envelope returned for a C-address", async () => {
  await connect();
  kit.signTransaction.mockResolvedValue({ signedTxXdr: "old-response" });
  await expect(signAndSubmit("unsigned", "Approve XLM")).rejects.toThrow(/no transaction confirmation/);
  expect(submitSignedXdr).not.toHaveBeenCalled();
});

it("disconnects after an account-switch request instead of retrying the old transaction", async () => {
  await connect();
  kit.signTransaction.mockRejectedValue(Object.assign(new Error("switch"), { name: "ACCOUNT_SWITCH_REQUESTED" }));
  await expect(signAndSubmit("unsigned", "Approve XLM")).rejects.toThrow("switch");
  expect(getState().userAddress).toBeNull();
  expect(kit.signTransaction).toHaveBeenCalledOnce();
});

it("rejects classic and external-submission paths before asking Nido to sign", async () => {
  await connect();
  await expect(signAndSubmitClassic("classic", "Trustline")).rejects.toThrow(/classic/);
  await expect(signXdr("broker")).rejects.toThrow(/classic/);
  expect(kit.signTransaction).not.toHaveBeenCalled();
});

it("preserves signed-XDR submission for classic wallets", async () => {
  kit.authModal.mockResolvedValue({ address: classic });
  await connect();
  kit.signTransaction.mockResolvedValue({
    signedTxXdr: "signed",
    signerAddress: classic,
  });
  vi.mocked(submitSignedXdr).mockResolvedValue(hash);
  vi.mocked(submitClassicXdr).mockResolvedValue(hash);
  expect(await signAndSubmit("unsigned", "Approve")).toBe(hash);
  expect(submitSignedXdr).toHaveBeenCalledWith("signed");
  expect(await signAndSubmitClassic("unsigned", "Trustline")).toBe(hash);
  expect(submitClassicXdr).toHaveBeenCalledWith("signed");
  expect(confirmSubmittedTransaction).not.toHaveBeenCalled();
});
