/**
 * Wallet layer — Stellar Wallets Kit init, connect/switch/disconnect, and the
 * sign→submit helpers. Ported verbatim from the original main.ts so the
 * money-path behaviour is unchanged; only the UI wiring moved to state + chrome.
 */
import { StellarWalletsKit } from "@creit-tech/stellar-wallets-kit/sdk";
import { FreighterModule } from "@creit-tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit-tech/stellar-wallets-kit/modules/xbull";
import { AlbedoModule } from "@creit-tech/stellar-wallets-kit/modules/albedo";
import { LobstrModule } from "@creit-tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule } from "@creit-tech/stellar-wallets-kit/modules/hana";
import { LedgerModule } from "@creit-tech/stellar-wallets-kit/modules/ledger";
import { NidoModule } from "@nidohq/stellar-wallets-kit-module";
import type { ModuleInterface } from "@creit-tech/stellar-wallets-kit/types";
import { Networks } from "@creit-tech/stellar-wallets-kit/types";
import {
  getNetworkPassphrase,
  getActiveNetwork,
  setNetwork,
  submitSignedXdr,
  submitClassicXdr,
  type NetworkMode,
} from "../blend";
import type { TxSeam, E2EHook } from "../e2e-harness";
import { getState, setState } from "./state";
import { toast } from "./chrome";
import { t } from "../i18n";

const WALLET_CONNECT_PROJECT_ID = import.meta.env.VITE_WALLET_CONNECT_PROJECT_ID as string | undefined;
const NIDO_BASE = (import.meta.env.VITE_NIDO_BASE as string | undefined) ?? "https://nido.fyi";

function baseWalletModules(net: NetworkMode): ModuleInterface[] {
  const mods: ModuleInterface[] = [
    new FreighterModule(),
    new xBullModule(),
    new AlbedoModule(),
    new LobstrModule(),
    new HanaModule(),
    new LedgerModule(),
  ];
  if (net === "testnet") mods.push(new NidoModule({ base: NIDO_BASE }) as unknown as ModuleInterface);
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

export function initWalletKit(net: NetworkMode): void {
  const network = kitNetwork(net);
  StellarWalletsKit.init({ modules: baseWalletModules(net), network });
  void maybeWalletConnectModule(net).then((wc) => {
    if (!wc) return;
    StellarWalletsKit.init({ modules: [...baseWalletModules(net), wc], network });
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
  const w = window as unknown as { __E2E__?: E2EHook };
  if (w.__E2E__) {
    // Expose the registered wallet module ids so the E2E suite can assert on them.
    w.__E2E__.registeredWallets = baseWalletModules(getActiveNetwork()).map(
      (m) => (m as unknown as { productId: string }).productId,
    );
    // Test-only drivers: let the suite exercise the *real* kit-native sign→submit
    // path (sign() → txSeam) for both classic and Soroban ops, per wallet.
    w.__E2E__.drive = {
      signSoroban: (xdr: string, label = "e2e") => signAndSubmit(xdr, label),
      signClassic: (xdr: string, label = "e2e") => signAndSubmitClassic(xdr, label),
    };
  }
}

// ── Connect / switch / disconnect ─────────────────────────────────────────────
export function fmtAddr(addr: string): string {
  return addr.slice(0, 4) + "…" + addr.slice(-3);
}

async function verifyWalletNetwork(): Promise<boolean> {
  try {
    const walletNet = await StellarWalletsKit.getNetwork();
    if (walletNet.networkPassphrase !== getNetworkPassphrase()) {
      const expected = getActiveNetwork() === "testnet" ? t("net.testnet") : t("net.mainnet");
      toast(t("toast.networkMismatch", { expected }), "error");
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/** Open the kit's wallet picker, connect, and update state. Returns the address or null. */
export async function connect(): Promise<string | null> {
  try {
    const result = await StellarWalletsKit.authModal({ network: kitNetwork(getActiveNetwork()) });
    if (!(await verifyWalletNetwork())) {
      await StellarWalletsKit.disconnect();
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
    const result = await StellarWalletsKit.authModal({ network: kitNetwork(getActiveNetwork()) });
    if (result.address === getState().userAddress) return result.address;
    if (!(await verifyWalletNetwork())) return null;
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
async function sign(xdr: string): Promise<string> {
  if (txSeam) return (await txSeam.signTransaction(xdr)).signedTxXdr;
  const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: getNetworkPassphrase(),
    address: getState().userAddress!,
  });
  return signedTxXdr;
}

/** Sign a Soroban tx and submit via RPC. Toasts through the flow. Returns the tx hash. */
export async function signAndSubmit(xdr: string, label: string): Promise<string> {
  toast(t("toast.signInWallet", { label }), "info");
  const signed = await sign(xdr);
  toast(t("toast.submitting", { label }), "info");
  const hash = txSeam ? await txSeam.submitSoroban(signed) : await submitSignedXdr(signed);
  toast(t("toast.confirmed", { label }), "success", hash);
  return hash;
}

/** Sign a classic (Horizon) tx and submit. Used for changeTrust setup. */
export async function signAndSubmitClassic(xdr: string, label: string): Promise<string> {
  toast(t("toast.signInWallet", { label }), "info");
  const signed = await sign(xdr);
  toast(t("toast.submitting", { label }), "info");
  const hash = txSeam ? await txSeam.submitClassic(signed) : await submitClassicXdr(signed);
  toast(t("toast.confirmed", { label }), "success", hash);
  return hash;
}
