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
    expect(url.hostname).toBe(`${account.toLowerCase()}.${network === "mainnet" ? "nido.fyi" : "test.nido.fyi"}`);
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
  });
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
  await expect(new TurboLongNidoModule("mainnet").signTransaction("xdr")).rejects.toThrow(message);
});

it("clears the bound account when the user requests an account switch", async () => {
  popup.mockResolvedValue({ search: "?nido_sign=switch-account" });
  await expect(new TurboLongNidoModule("mainnet").signTransaction("xdr")).rejects.toMatchObject({
    name: "ACCOUNT_SWITCH_REQUESTED",
  });
  expect(loadCachedAddress()).toBeNull();
});

it("refuses a different signing account before any popup", async () => {
  await expect(
    new TurboLongNidoModule("mainnet").signTransaction("xdr", {
      address: StrKey.encodeContract(Buffer.alloc(32, 8)),
    }),
  ).rejects.toThrow(/different account/);
  expect(popup).not.toHaveBeenCalled();
});
