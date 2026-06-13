/**
 * E2E test harness — TEST-ONLY mock wallet + network seam.
 *
 * This module is **never** imported by the production code path. `main.ts`
 * dynamically imports it only when {@link isE2E} returns true (the page was
 * loaded with `?e2e=1`, or `window.__E2E__` was pre-set by a test runner such
 * as Playwright via `addInitScript`). It lets headless E2E tests drive the full
 * sign → submit → history pipeline of the real app without a browser extension,
 * hardware wallet, or live Stellar RPC.
 *
 * It deliberately stays small and explicit: it patches the public
 * `StellarWalletsKit` surface (so every kit call in the app is mocked) and
 * exposes a `TxSeam` whose methods the app calls instead of touching the
 * network directly. Tests can pick which mock wallet "signs" via
 * `window.__E2E__.wallet`.
 */

/** Shape of the test hook a runner may set before the app boots. */
export interface E2EHook {
  /** Which mock wallet is "connected". Mirrors the kit module ids + LEDGER. */
  wallet?: "freighter" | "xbull" | "albedo" | "lobstr" | "hana" | "LEDGER";
  /** Override the mock account address. */
  address?: string;
  /** Populated by the harness once installed, so tests can introspect. */
  installed?: boolean;
  /** Every tx the harness "submitted", newest last. Tests assert on this. */
  submitted?: Array<{ kind: "soroban" | "classic"; xdr: string; hash: string }>;
  /** The wallet ids the app registered with the kit (for assertions). */
  registeredWallets?: string[];
}

declare global {
  interface Window {
    __E2E__?: E2EHook;
  }
}

const DEFAULT_MOCK_ADDRESS = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGBCGFJ3SHRGZ7GGNKDQY2";

/** True when the app should run in E2E mode. */
export function isE2E(): boolean {
  if (typeof window === "undefined") return false;
  if (window.__E2E__) return true;
  try {
    return new URLSearchParams(window.location.search).get("e2e") === "1";
  } catch {
    return false;
  }
}

/** Read (creating if needed) the test hook object. */
function hook(): E2EHook {
  if (!window.__E2E__) window.__E2E__ = {};
  if (!window.__E2E__.submitted) window.__E2E__.submitted = [];
  return window.__E2E__;
}

/** Deterministic 64-hex tx hash derived from the input so tests can assert it. */
function fakeHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const seed = (h >>> 0).toString(16).padStart(8, "0");
  return (seed + input.length.toString(16).padStart(2, "0")).repeat(8).slice(0, 64);
}

/**
 * The network seam the app routes its tx operations through when in E2E mode.
 * In production these delegate straight to the real implementations; under the
 * harness they return deterministic mock data without hitting the network.
 */
export interface TxSeam {
  /** True — lets the app branch on "are we mocked" cheaply. */
  active: boolean;
  signTransaction(xdr: string): Promise<{ signedTxXdr: string }>;
  submitSoroban(signedXdr: string): Promise<string>;
  submitClassic(signedXdr: string): Promise<string>;
  /**
   * Mock trustline lookup. Forces exactly one missing trustline (using the
   * caller-supplied real `Asset`) so the classic `changeTrust` step is
   * exercised, without hitting Horizon. `T` is `@stellar/stellar-sdk`'s `Asset`.
   */
  getMissingTrustlines<T>(forcedAsset: T): Promise<{ missing: T[]; currentCount: number }>;
  /** Mock an XDR-build call (which would otherwise simulate against RPC). */
  buildXdr(): Promise<string>;
  /** The mock account address to use as the connected wallet. */
  address(): string;
}

/** Build a {@link TxSeam} backed by the mock wallet. */
export function makeSeam(): TxSeam {
  return {
    active: true,
    address: () => hook().address ?? DEFAULT_MOCK_ADDRESS,
    async signTransaction(xdr: string) {
      // Echo the XDR back as the "signed" payload; submit is mocked too so the
      // payload never needs to be a real signature.
      return { signedTxXdr: xdr };
    },
    async submitSoroban(signedXdr: string) {
      const h = fakeHash("soroban:" + signedXdr);
      hook().submitted!.push({ kind: "soroban", xdr: signedXdr, hash: h });
      return h;
    },
    async submitClassic(signedXdr: string) {
      const h = fakeHash("classic:" + signedXdr);
      hook().submitted!.push({ kind: "classic", xdr: signedXdr, hash: h });
      return h;
    },
    async getMissingTrustlines<T>(forcedAsset: T) {
      // Force one missing trustline so the classic changeTrust step runs.
      return { missing: [forcedAsset], currentCount: 1 };
    },
    async buildXdr() {
      // A non-empty placeholder XDR; never decoded because submit is mocked.
      return "AAAAMOCKXDR==";
    },
  };
}

/**
 * Patch the static {@link StellarWalletsKit} so connect / sign / network calls
 * resolve against the mock wallet. Returns the seam the app should use for its
 * build / submit operations.
 */
export function installKitMocks(kit: any, networkPassphrase: string): TxSeam {
  const h = hook();
  const address = h.address ?? DEFAULT_MOCK_ADDRESS;

  kit.authModal = async () => ({ address });
  kit.getAddress = async () => ({ address });
  kit.fetchAddress = async () => ({ address });
  kit.setWallet = () => {};
  kit.disconnect = async () => {};
  kit.getNetwork = async () => ({ network: "mock", networkPassphrase });
  kit.signTransaction = async (xdr: string) => ({ signedTxXdr: xdr, signerAddress: address });

  h.installed = true;
  return makeSeam();
}
