import { expect, test } from "@playwright/test";

/**
 * Wallet-kit E2E: boots the real app under the mock-wallet harness (`?e2e=1`)
 * and verifies the kit registers all six signing modules — the five supported
 * wallets plus the new Ledger hardware module — and that the harness installs
 * cleanly (the seam the app routes sign/submit through is active).
 *
 * No browser extension, hardware wallet, or live RPC is touched. Per-operation
 * classic/Soroban drives and live device/Ledger sign-off are tracked as the
 * next E2E increment (the harness + TxSeam already support them).
 */

const EXPECTED_WALLET_COUNT = 6; // Freighter, xBull, Albedo, Lobstr, Hana, Ledger

test.describe("Stellar Wallets Kit", () => {
  test("boots under the E2E harness and installs the mock seam", async ({ page }) => {
    await page.goto("/?e2e=1");
    await page.waitForFunction(() => window.__E2E__?.installed === true, null, {
      timeout: 30_000,
    });
    const installed = await page.evaluate(() => window.__E2E__?.installed);
    expect(installed).toBe(true);
  });

  test("registers all five wallets plus Ledger", async ({ page }) => {
    await page.goto("/?e2e=1");
    await page.waitForFunction(
      () => Array.isArray(window.__E2E__?.registeredWallets),
      null,
      { timeout: 30_000 },
    );
    const registered = await page.evaluate(() => window.__E2E__?.registeredWallets ?? []);

    // All six modules registered (the five base wallets + the Ledger module).
    expect(registered.length).toBe(EXPECTED_WALLET_COUNT);
    // Ledger must be present — it is the deliverable's new hardware module.
    expect(registered.some((id) => /ledger/i.test(id))).toBe(true);
  });

  test("exposes a submitted-tx ledger for sign->submit assertions", async ({ page }) => {
    await page.goto("/?e2e=1");
    await page.waitForFunction(() => window.__E2E__?.installed === true, null, {
      timeout: 30_000,
    });
    // The harness seeds an empty submitted[] array that the app appends to on
    // every signed classic/Soroban submit — the hook future op-level tests use.
    const submitted = await page.evaluate(() => window.__E2E__?.submitted);
    expect(Array.isArray(submitted)).toBe(true);
  });
});
