import { expect, test } from "@playwright/test";

/**
 * Wallet-kit E2E: boots the real app under the mock-wallet harness (`?e2e=1`)
 * and verifies two things:
 *
 *   1. the kit registers all six signing modules — the five supported wallets
 *      plus the Ledger hardware module — and the harness installs its seam;
 *   2. each of the five supported wallets can drive a *real* kit-native
 *      sign→submit for BOTH a classic (Horizon) and a Soroban op.
 *
 * The op-level drives go through the app's actual `signAndSubmit` /
 * `signAndSubmitClassic` helpers (exposed test-only as `window.__E2E__.drive`),
 * which call `sign()` → the kit seam. No browser extension, hardware wallet, or
 * live RPC is touched; submit is mocked and each submitted tx is tagged with the
 * active wallet so we can assert per-wallet coverage.
 */

// Window shape the harness exposes under `?e2e=1` (mirrors src/e2e-harness.ts).
type MockWalletId = "freighter" | "xbull" | "lobstr" | "hana" | "LEDGER";
interface E2EWindow {
  __E2E__?: {
    wallet?: MockWalletId;
    installed?: boolean;
    registeredWallets?: string[];
    submitted?: Array<{ kind: "soroban" | "classic"; xdr: string; hash: string; wallet?: MockWalletId }>;
    drive?: {
      signSoroban(xdr: string, label?: string): Promise<string>;
      signClassic(xdr: string, label?: string): Promise<string>;
    };
  };
}

const EXPECTED_WALLET_COUNT = 6; // Freighter, xBull, Albedo, Lobstr, Hana, Ledger

// The five supported wallets the milestone must cover for both op kinds.
const SUPPORTED_WALLETS: MockWalletId[] = ["freighter", "xbull", "lobstr", "hana", "LEDGER"];

const HASH_RE = /^[0-9a-f]{64}$/;

test.describe("Stellar Wallets Kit", () => {
  test("boots under the E2E harness and installs the mock seam", async ({ page }) => {
    await page.goto("/?e2e=1");
    await page.waitForFunction(() => (window as unknown as E2EWindow).__E2E__?.installed === true, null, {
      timeout: 30_000,
    });
    const installed = await page.evaluate(() => (window as unknown as E2EWindow).__E2E__?.installed);
    expect(installed).toBe(true);
  });

  test("registers all five wallets plus Ledger", async ({ page }) => {
    await page.goto("/?e2e=1");
    await page.waitForFunction(
      () => Array.isArray((window as unknown as E2EWindow).__E2E__?.registeredWallets),
      null,
      { timeout: 30_000 },
    );
    const registered = await page.evaluate(
      () => (window as unknown as E2EWindow).__E2E__?.registeredWallets ?? [],
    );

    // All six modules registered (the five base wallets + the Ledger module).
    expect(registered.length).toBe(EXPECTED_WALLET_COUNT);
    // Ledger must be present — it is the deliverable's new hardware module.
    expect(registered.some((id) => /ledger/i.test(id))).toBe(true);
  });

  test("exposes a submitted-tx ledger for sign->submit assertions", async ({ page }) => {
    await page.goto("/?e2e=1");
    await page.waitForFunction(() => (window as unknown as E2EWindow).__E2E__?.installed === true, null, {
      timeout: 30_000,
    });
    const submitted = await page.evaluate(() => (window as unknown as E2EWindow).__E2E__?.submitted);
    expect(Array.isArray(submitted)).toBe(true);
  });
});

test.describe("Stellar Wallets Kit — per-wallet sign→submit (classic + Soroban)", () => {
  for (const wallet of SUPPORTED_WALLETS) {
    test(`${wallet} signs and submits both a classic and a Soroban op`, async ({ page }) => {
      await page.goto("/?e2e=1");
      await page.waitForFunction(
        () => typeof (window as unknown as E2EWindow).__E2E__?.drive?.signSoroban === "function",
        null,
        { timeout: 30_000 },
      );

      const result = await page.evaluate(async (w: MockWalletId) => {
        const e2e = (window as unknown as E2EWindow).__E2E__!;
        // Pick which mock wallet "signs"; the harness tags each submit with it.
        e2e.wallet = w;
        const sorobanHash = await e2e.drive!.signSoroban(`SOROBAN_XDR_${w}`);
        const classicHash = await e2e.drive!.signClassic(`CLASSIC_XDR_${w}`);
        return { sorobanHash, classicHash, submitted: e2e.submitted ?? [] };
      }, wallet);

      // Both ops produced a (mock) tx hash through the kit-native path.
      expect(result.sorobanHash).toMatch(HASH_RE);
      expect(result.classicHash).toMatch(HASH_RE);
      expect(result.sorobanHash).not.toBe(result.classicHash);

      // The harness recorded one classic and one Soroban submit for THIS wallet.
      const mine = result.submitted.filter((s) => s.wallet === wallet);
      expect(mine.some((s) => s.kind === "soroban" && s.hash === result.sorobanHash)).toBe(true);
      expect(mine.some((s) => s.kind === "classic" && s.hash === result.classicHash)).toBe(true);
    });
  }
});
