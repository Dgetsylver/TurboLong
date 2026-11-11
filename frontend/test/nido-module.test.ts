import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Networks, StrKey } from "@stellar/stellar-sdk";

vi.mock("@creit-tech/stellar-wallets-kit", () => ({
  ModuleType: { HOT_WALLET: "HOT_WALLET" },
}));
vi.mock("@nidohq/stellar-wallets-kit-module", async (original) => ({
  ...(await original<typeof import("@nidohq/stellar-wallets-kit-module")>()),
  openCeremonyPopup: vi.fn(),
}));

import { openCeremonyPopup, saveCachedAddress, loadCachedAddress } from "@nidohq/stellar-wallets-kit-module";
import { TurboLongNidoModule } from "../src/app/nido-module";
import { nidoConfig } from "../src/nido";

const account = StrKey.encodeContract(Buffer.alloc(32, 7));
const hash = "a".repeat(64);
const popup = vi.mocked(openCeremonyPopup);

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  vi.stubGlobal("window", {
    location: {
      origin: "http://localhost:5173",
      href: "http://localhost:5173/",
    },
  });
  saveCachedAddress(account);
  popup.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["mainnet", "testnet"] as const)("Nido %s handover", (network) => {
  it("requests the matching network and accepts a submitted hash from the account origin", async () => {
    const module = new TurboLongNidoModule(network);
    const config = nidoConfig(network);
    expect(await module.getNetwork()).toMatchObject({
      networkPassphrase: config.networkPassphrase,
    });
    popup.mockResolvedValue({ search: `?nido_submitted=${hash}&kind=tx` });
    expect(await module.signTransaction("unsigned-xdr", { address: account })).toEqual({
      signedTxXdr: hash,
      signerAddress: account,
      submitted: true,
    });
    const [request, origin] = popup.mock.calls[0];
    const url = new URL(request);
    expect(url.origin).toBe(origin);
    expect(url.hostname).toBe(`${account.toLowerCase()}.${network === "mainnet" ? "nido.fyi" : "356.test.nido.fyi"}`);
    expect(url.searchParams.get("network")).toBe(config.networkPassphrase);
    expect(url.searchParams.get("xdr")).toBe("unsigned-xdr");
    expect(url.searchParams.get("dapp")).toBe("http://localhost:5173");
  });

  it("rejects another network before opening the approval popup", async () => {
    const module = new TurboLongNidoModule(network);
    await expect(
      module.signTransaction("xdr", {
        networkPassphrase: network === "mainnet" ? Networks.TESTNET : Networks.PUBLIC,
      }),
    ).rejects.toThrow(/network/);
    expect(popup).not.toHaveBeenCalled();
    popup.mockResolvedValue({ search: `?nido_submitted=${hash}&kind=tx` });
    await expect(module.signTransaction("retry")).resolves.toMatchObject({ signedTxXdr: hash });
  });
});

it.each(["same instance", "replacement instance", "different network"])(
  "rejects overlapping approvals from the %s without disturbing the pending action",
  async (variant) => {
    const module = new TurboLongNidoModule("mainnet");
    const other = variant === "same instance"
      ? module
      : new TurboLongNidoModule(variant === "different network" ? "testnet" : "mainnet");
    let complete!: (value: { search: string }) => void;
    const adjustmentHash = "b".repeat(64);
    popup.mockResolvedValue({ search: `?nido_submitted=${adjustmentHash}&kind=tx` });
    popup.mockImplementationOnce(() => new Promise((resolve) => {
      complete = resolve;
    }));
    const close = module.signTransaction("close");
    try {
      await expect(other.signTransaction("adjust")).rejects.toThrow(/approval.*in progress/);
      await expect(module.signTransaction("adjust-again")).rejects.toThrow(/approval.*in progress/);
      expect(popup).toHaveBeenCalledOnce();
      expect(new URL(popup.mock.calls[0][0]).searchParams.get("xdr")).toBe("close");
    } finally {
      complete({ search: `?nido_submitted=${hash}&kind=tx` });
      await expect(close).resolves.toMatchObject({ signedTxXdr: hash, submitted: true });
    }
    await expect(other.signTransaction("adjust-after-close")).resolves.toMatchObject({
      signedTxXdr: adjustmentHash,
      submitted: true,
    });
    expect(popup).toHaveBeenCalledTimes(2);
  },
);

it("allows another approval after the popup rejects", async () => {
  popup.mockRejectedValueOnce(new Error("Popup closed"));
  const module = new TurboLongNidoModule("mainnet");
  await expect(module.signTransaction("close")).rejects.toThrow("Popup closed");
  popup.mockResolvedValue({ search: `?nido_submitted=${hash}&kind=tx` });
  await expect(module.signTransaction("retry")).resolves.toMatchObject({ signedTxXdr: hash });
});

it.each([
  ["?nido_sign=cancelled", "cancelled"],
  ["?nido_sign=error&nido_error=Simulation+failed", "Simulation failed"],
  ["?nido_submitted=not-a-hash&kind=tx", "invalid transaction confirmation"],
  [`?nido_submitted=${hash}&kind=message`, "invalid transaction confirmation"],
  ["?nido_signed=old-unsigned-envelope&kind=tx", "no transaction confirmation"],
  ["", "no transaction confirmation"],
])("fails safely for response %s", async (search, message) => {
  popup.mockResolvedValue({ search });
  const module = new TurboLongNidoModule("mainnet");
  await expect(module.signTransaction("xdr")).rejects.toThrow(message);
  popup.mockResolvedValue({ search: `?nido_submitted=${hash}&kind=tx` });
  await expect(module.signTransaction("retry")).resolves.toMatchObject({ signedTxXdr: hash });
});

it("clears the bound account when the user requests an account switch", async () => {
  popup.mockResolvedValue({ search: "?nido_sign=switch-account" });
  await expect(new TurboLongNidoModule("mainnet").signTransaction("xdr")).rejects.toMatchObject({
    name: "ACCOUNT_SWITCH_REQUESTED",
  });
  expect(loadCachedAddress()).toBeNull();
  saveCachedAddress(account);
  popup.mockResolvedValue({ search: `?nido_submitted=${hash}&kind=tx` });
  await expect(new TurboLongNidoModule("mainnet").signTransaction("retry")).resolves.toMatchObject({ signedTxXdr: hash });
});

it("refuses a different signing account before any popup", async () => {
  await expect(
    new TurboLongNidoModule("mainnet").signTransaction("xdr", {
      address: StrKey.encodeContract(Buffer.alloc(32, 8)),
    }),
  ).rejects.toThrow(/different account/);
  expect(popup).not.toHaveBeenCalled();
  popup.mockResolvedValue({ search: `?nido_submitted=${hash}&kind=tx` });
  await expect(new TurboLongNidoModule("mainnet").signTransaction("retry")).resolves.toMatchObject({ signedTxXdr: hash });
});
