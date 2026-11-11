/**
 * Wallet layer — Stellar Wallets Kit init, connect/switch/disconnect, and the
 * sign→submit helpers. Nido's wallet submits its own transactions; the shared
 * confirmation path must not broadcast a returned transaction hash as XDR.
 */
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { FreighterModule } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule } from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule } from "@creit-tech/stellar-wallets-kit/modules/hana";
import { LedgerModule } from "@creit-tech/stellar-wallets-kit/modules/ledger";
import { ACCOUNT_SWITCH_REQUESTED } from "@nidohq/stellar-wallets-kit-module";
import { TurboLongNidoModule, type WalletSignResult } from "./nido-module";
import { isContractAccount } from "../nido";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";
import { Networks } from "@creit-tech/stellar-wallets-kit/types";
import {
  getNetworkPassphrase,
  getActiveNetwork,
  setNetwork,
  submitSignedXdr,
  submitClassicXdr,
  confirmSubmittedTransaction,
  verifyContractAccount,
  type NetworkMode,
} from "../blend";
import type { TxSeam } from "../e2e-harness";
import { getState, setState } from "./state";
import { toast } from "./chrome";
import { t } from "../i18n";

const WALLET_CONNECT_PROJECT_ID = import.meta.env.VITE_WALLET_CONNECT_PROJECT_ID as string | undefined;

function baseWalletModules(net: NetworkMode): ModuleInterface[] {
  const mods: ModuleInterface[] = [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new LobstrModule(),
    new HanaModule(),
    new LedgerModule(),
    new TurboLongNidoModule(net) as unknown as ModuleInterface,
  ];
  return mods;
}

function kitNetwork(net: NetworkMode): Networks {
  return net === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
}

async function maybeWalletConnectModule(net: NetworkMode): Promise<ModuleInterface | undefined> {
  if (!WALLET_CONNECT_PROJECT_ID) return undefined;
  try {
    const { WalletConnectModule, WalletConnectTargetChain } = await import(
      "@creit-tech/stellar-wallets-kit/modules/wallet-connect"
    );
    return new WalletConnectModule({
      projectId: WALLET_CONNECT_PROJECT_ID,
      allowedChains: [net === "testnet" ? WalletConnectTargetChain.TESTNET : WalletConnectTargetChain.PUBLIC],
      metadata: {
        name: "Turbolong",
        description: "Leveraged yield on Blend",
        url: typeof window !== "undefined" ? window.location.origin : "https://turbolong.app",
        icons: [typeof window !== "undefined" ? `${window.location.origin}/logo.svg` : ""],
      },
    }) as unknown as ModuleInterface;
  } catch (e) {
    console.warn("WalletConnect module unavailable — mobile deep-link disabled", e);
    return undefined;
  }
}

let kitGeneration = 0;
export function initWalletKit(net: NetworkMode): void {
  const generation = ++kitGeneration;
  const network = kitNetwork(net);
  StellarWalletsKit.init({ modules: baseWalletModules(net), network });
  void maybeWalletConnectModule(net).then((wc) => {
    if (!wc || generation !== kitGeneration) return;
    StellarWalletsKit.init({
      modules: [...baseWalletModules(net), wc],
      network,
    });
  });
}

// ── E2E seam ─────────────────────────────────────────────────────────────────
let txSeam: TxSeam | null = null;
export function getTxSeam(): TxSeam | null {
  return txSeam;
}
export async function installE2EHarness(): Promise<void> {
  const { isE2E, installKitMocks } = await import("../e2e-harness");
  if (!isE2E()) return;
  txSeam = installKitMocks(StellarWalletsKit, getNetworkPassphrase());
  // Expose the registered wallet module ids so the E2E suite can assert on them.
  const w = window as unknown as { __E2E__?: { registeredWallets?: string[] } };
  if (w.__E2E__) {
    w.__E2E__.registeredWallets = baseWalletModules(getActiveNetwork()).map(
      (m) => (m as unknown as { productId: string }).productId,
    );
  }
}

// ── Connect / switch / disconnect ─────────────────────────────────────────────
export function fmtAddr(addr: string): string {
  return addr.slice(0, 4) + "…" + addr.slice(-3);
}

async function verifyWalletNetwork(address: string): Promise<boolean> {
  const network = getActiveNetwork();
  try {
    const walletNet = await StellarWalletsKit.getNetwork();
    if (walletNet.networkPassphrase !== getNetworkPassphrase()) {
      const expected = getActiveNetwork() === "testnet" ? t("net.testnet") : t("net.mainnet");
      toast(t("toast.networkMismatch", { expected }), "error");
      return false;
    }
  } catch {
    // Some existing classic wallets do not implement getNetwork. Nido's
    // configured passphrase is not chain evidence, so C-accounts fail closed.
    if (isContractAccount(address)) return false;
  }
  if (isContractAccount(address)) {
    try {
      await verifyContractAccount(address);
    } catch {
      toast(t("wallet.accountUnavailable"), "error");
      return false;
    }
  }
  return network === getActiveNetwork();
}

/** Open the kit's wallet picker, connect, and update state. Returns the address or null. */
export async function connect(): Promise<string | null> {
  try {
    const result = await StellarWalletsKit.authModal();
    if (!(await verifyWalletNetwork(result.address))) {
      await disconnect();
      return null;
    }
    localStorage.setItem("walletAddress", result.address);
    setState({ userAddress: result.address, connected: true });
    return result.address;
  } catch (e) {
    if ((e as Error)?.message !== "User closed the modal") toast(t("toast.connectFailed"), "error");
    return null;
  }
}

export async function switchWallet(): Promise<string | null> {
  try {
    const result = await StellarWalletsKit.authModal();
    if (!(await verifyWalletNetwork(result.address))) {
      await disconnect();
      return null;
    }
    if (result.address === getState().userAddress) return result.address;
    localStorage.setItem("walletAddress", result.address);
    setState({ userAddress: result.address, connected: true });
    toast(t("toast.switchedWallet"), "success");
    return result.address;
  } catch (e) {
    if ((e as Error)?.message !== "User closed the modal") toast(t("toast.switchFailed"), "error");
    return null;
  }
}

export async function disconnect(): Promise<void> {
  try {
    await StellarWalletsKit.disconnect();
  } catch {
    /* ignore */
  }
  localStorage.removeItem("walletAddress");
  setState({ userAddress: null, connected: false });
}

/** Switch the active network: disconnect, re-init kit, reset connection state. */
export async function switchNetwork(net: NetworkMode): Promise<void> {
  if (getState().userAddress) {
    try {
      await StellarWalletsKit.disconnect();
    } catch {
      /* ignore */
    }
  }
  localStorage.removeItem("walletAddress");
  setNetwork(net);
  localStorage.setItem("networkMode", net);
  initWalletKit(net);
  setState({ userAddress: null, connected: false, network: net });
  const label = net === "testnet" ? t("net.testnet") : t("net.mainnetPublic");
  toast(t("toast.switchedNetwork", { label }), "info");
}

// ── Sign + submit ──────────────────────────────────────────────────────────────
async function sign(xdr: string): Promise<WalletSignResult> {
  if (txSeam) return txSeam.signTransaction(xdr);
  const address = getState().userAddress;
  const networkPassphrase = getNetworkPassphrase();
  if (!address || !(await verifyWalletNetwork(address))) throw new Error(t("wallet.reconnect"));
  if (address !== getState().userAddress || networkPassphrase !== getNetworkPassphrase()) {
    throw new Error(t("wallet.changedWhileSigning"));
  }
  try {
    const result: WalletSignResult = await StellarWalletsKit.signTransaction(xdr, { networkPassphrase, address });
    if (address !== getState().userAddress || networkPassphrase !== getNetworkPassphrase()) {
      throw new Error(t("wallet.changedWhileSigning"));
    }
    if (result.signerAddress && result.signerAddress !== address) throw new Error(t("wallet.reconnect"));
    return result;
  } catch (e) {
    if ((e as Error)?.name === ACCOUNT_SWITCH_REQUESTED) await disconnect();
    throw e;
  }
}

/**
 * Classic-wallet sign-only helper for flows that submit elsewhere (e.g. the Stellar Broker
 * mediator, which submits through its own Horizon call). Returns the signed XDR.
 */
export async function signXdr(xdr: string): Promise<string> {
  if (isContractAccount(getState().userAddress ?? "")) throw new Error(t("wallet.classicUnsupported"));
  const result = await sign(xdr);
  if (result.submitted) throw new Error(t("wallet.changedWhileSigning"));
  return result.signedTxXdr;
}

/** Confirm a Soroban tx via RPC, submitting signed XDR only if the wallet has not already submitted it. */
export async function signAndSubmit(xdr: string, label: string): Promise<string> {
  toast(t("toast.signInWallet", { label }), "info");
  const contractAccount = isContractAccount(getState().userAddress ?? "");
  const signed = await sign(xdr);
  if (signed.submitted) {
    const hash = await confirmSubmittedTransaction(signed.signedTxXdr);
    toast(t("toast.confirmed", { label }), "success", hash);
    return hash;
  }
  if (contractAccount) throw new Error(t("wallet.missingConfirmation"));
  toast(t("toast.submitting", { label }), "info");
  const hash = txSeam ? await txSeam.submitSoroban(signed.signedTxXdr) : await submitSignedXdr(signed.signedTxXdr);
  toast(t("toast.confirmed", { label }), "success", hash);
  return hash;
}

/** Sign a classic (Horizon) tx and submit. Used for changeTrust setup. */
export async function signAndSubmitClassic(xdr: string, label: string): Promise<string> {
  toast(t("toast.signInWallet", { label }), "info");
  const signed = await signXdr(xdr);
  toast(t("toast.submitting", { label }), "info");
  const hash = txSeam ? await txSeam.submitClassic(signed) : await submitClassicXdr(signed);
  toast(t("toast.confirmed", { label }), "success", hash);
  return hash;
}
