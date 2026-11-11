import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserContext, type Page, expect, test } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk";

/**
 * Grant mode, live on testnet: approve once, two actions inside the cap with no
 * wallet prompt, then one over the cap that the account refuses.
 *
 * 1. Make a throwaway Nido account on Nido's Perch dev preview (Friendbot funds
 *    it with 10,000 testnet XLM) with a CDP virtual passkey.
 * 2. In TurboLong (testnet), approve TurboLong's grant in Nido's popup: submit
 *    on the RegionalStarterPack pool, and XLM transfer paying only that pool,
 *    capped at 40 XLM a day. This is the one passkey approval.
 * 3. Open 10 XLM at 2x (pulls 20 XLM), then close it (repays ~10 XLM): both
 *    signed by TurboLong's session key, no popup.
 * 4. Open 10 XLM at 2x again: 20 XLM more is over the cap. The account refuses
 *    it in simulation and nothing is sent; TurboLong offers the main wallet.
 *
 * Evidence (screenshots, hashes) goes to DEMO_OUT (default test-results/grants-demo).
 */

const NIDO = "https://356.test.nido.fyi";
const OUT = process.env.DEMO_OUT ?? join(__dirname, "..", "test-results", "grants-demo");
const CAP_XLM = "40";

interface Evidence {
  account?: string;
  steps: { step: string; hash?: string; note?: string }[];
}
const evidence: Evidence = { steps: [] };

function record(step: string, extra: { hash?: string; note?: string } = {}) {
  evidence.steps.push({ step, ...extra });
  writeFileSync(join(OUT, "evidence.json"), JSON.stringify(evidence, null, 2));
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
}

/** A CDP virtual authenticator on `page`, optionally holding `credential`. */
async function passkeyOn(context: BrowserContext, page: Page, credential?: object) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (credential) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: credential as never });
  return { cdp, authenticatorId };
}

/** The tx hash of the newest toast's stellar.expert link, if it is still up. */
async function lastToastHash(page: Page): Promise<string | undefined> {
  const href = await page
    .locator("a.tl-toast__link")
    .last()
    .getAttribute("href", { timeout: 5_000 })
    .catch(() => null);
  return href?.split("/tx/")[1];
}

/** Every transaction this browser's grant fee payer sent, from Horizon: the
 * grant-signed calls, oldest first. The fee payer is a throwaway testnet key
 * that pays fees only. */
async function feePayerTransactions(page: Page): Promise<{ hash: string; successful: boolean }[]> {
  const secret = await page.evaluate(() => localStorage.getItem("turbolong:grant-fee-payer:testnet"));
  if (!secret) return [];
  const payer = Keypair.fromSecret(secret).publicKey();
  const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${payer}/transactions?order=asc&limit=20`);
  const body = (await res.json()) as {
    _embedded?: { records: { hash: string; successful: boolean; source_account: string }[] };
  };
  // Friendbot's funding transaction also touches the account; keep the payer's own.
  return (body._embedded?.records ?? [])
    .filter((t) => t.source_account === payer)
    .map(({ hash, successful }) => ({ hash, successful }));
}

async function openPosition(page: Page, xlm: string, leverage: number) {
  const action = page.locator(".trade-action");
  await action.locator("input[inputmode=decimal]").first().fill(xlm);
  await action.locator("input[type=range]").evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, leverage);
  await action.getByRole("button", { name: "Confirm & Open" }).click();
  const modal = page.locator(".trade-modal");
  await modal.locator("#trade-cp-understand").check();
  await modal.getByRole("button", { name: "Confirm & Open" }).click();
}

test("grant mode: approve once, two in-cap actions without prompts, one refused over the cap", async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const owner = await passkeyOn(context, page);

  // ── 1. A throwaway Nido account on the Perch dev preview ──────────────────
  await page.goto(`${NIDO}/new-account/?setup=1#salt=${randomBytes(32).toString("hex")}`);
  for (let i = 0; i < 60 && !/--356\.test\.nido\.fyi\/account\//.test(page.url()); i++) {
    for (const id of ["#preparing-continue", "#register-btn", "#enroll-continue"]) {
      const button = page.locator(id);
      if ((await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false)))
        await button.click().catch(() => {});
    }
    await page.waitForTimeout(3000);
  }
  const host = new URL(page.url()).hostname;
  const account = host.split("--")[0].toUpperCase();
  expect(account).toMatch(/^C[A-Z2-7]{55}$/);
  evidence.account = account;
  await expect(page.getByText("10,000 XLM").first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "1-nido-account");
  record("Nido account created and funded by Friendbot", { note: account });

  // Popups (Nido's grant page) get the owner's passkey too.
  const [credential] = (await owner.cdp.send("WebAuthn.getCredentials", { authenticatorId: owner.authenticatorId }))
    .credentials;
  let popups = 0;
  context.on("page", (popup) => {
    popups++;
    void passkeyOn(context, popup, credential);
  });

  // ── 2. TurboLong on testnet, connected to that account ────────────────────
  await page.goto("/?network=testnet");
  await page.evaluate((acct) => {
    localStorage.setItem("disclaimerAccepted", "1");
    localStorage.setItem("tl_tour_done", "1");
    localStorage.setItem("walletAddress", acct);
  }, account);
  await page.goto("/");
  await page
    .getByRole("button", { name: /^Trade$/ })
    .first()
    .click();
  const approve = page.locator("#grant-approve");
  await expect(approve).toBeEnabled({ timeout: 60_000 });
  await page.getByLabel("Spending cap in XLM").fill(CAP_XLM);
  // The details describe the cap being requested, not the default one.
  await page.getByText("What you're allowing").click();
  await expect(page.locator(".grant-scope")).toContainText(`up to ${CAP_XLM} XLM per day`);
  await page.getByLabel("Cap window").selectOption("week");
  await expect(page.locator(".grant-scope")).toContainText(`up to ${CAP_XLM} XLM per week`);
  await page.getByLabel("Cap window").selectOption("day");
  await expect(page.getByLabel("Spending cap in XLM")).toHaveValue(CAP_XLM);
  await shot(page, "2-grant-request");

  // ── 3. Approve once in Nido ───────────────────────────────────────────────
  const popupPromise = context.waitForEvent("page");
  await approve.click();
  const nido = await popupPromise;
  await nido.waitForLoadState();
  await expect(nido.locator("#approve")).toBeEnabled({ timeout: 60_000 });
  await nido.screenshot({ path: join(OUT, "3-nido-approval-sheet.png"), fullPage: true });
  await nido.locator("#approve").click();
  // Nido's /sign/ page: confirm with the owner's passkey; it submits apply_grant.
  await nido.waitForURL(/\/sign\//, { timeout: 60_000 });
  await expect(nido.locator("#approve")).toBeEnabled({ timeout: 60_000 });
  await nido.screenshot({ path: join(OUT, "3b-nido-sign.png"), fullPage: true });
  await nido.locator("#approve").click();
  await nido.waitForEvent("close", { timeout: 180_000 });
  await expect(page.locator("#grant-state")).toHaveText(/Active/, { timeout: 120_000 });
  await expect(page.locator("#grant-cap-left")).toContainText(`${CAP_XLM}.00 of ${CAP_XLM}.00 XLM`);
  await shot(page, "4-grant-active");
  record("Grant approved once in Nido (owner passkey)", { note: await page.locator("#grant-cap-left").innerText() });
  const popupsAfterApproval = popups;

  // ── 4. Two actions inside the cap, no prompt ──────────────────────────────
  await openPosition(page, "10", 2);
  await expect(page.getByText(/signed under TurboLong's grant/).first()).toBeVisible({ timeout: 180_000 });
  record("Open 10 XLM at 2x under the grant", { hash: await lastToastHash(page) });
  await expect(page.locator(".trade-position").getByRole("button", { name: "Close" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator("#grant-cap-left")).toContainText(`20.00 of ${CAP_XLM}.00 XLM`, { timeout: 60_000 });
  await shot(page, "5-opened");

  await page.locator(".trade-position").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Confirm Close" }).click();
  await expect(page.getByText(/Close XLM position: signed under TurboLong's grant/).first()).toBeVisible({
    timeout: 180_000,
  });
  record("Close the position under the grant", { hash: await lastToastHash(page) });
  await expect(page.locator(".trade-action input[inputmode=decimal]").first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "6-closed");
  expect(popups).toBe(popupsAfterApproval); // no wallet window for either action

  // ── 5. Over the cap: the account refuses, nothing is sent ─────────────────
  await openPosition(page, "10", 2);
  const fallback = page.locator("#grant-fallback");
  await expect(fallback).toBeVisible({ timeout: 180_000 });
  await expect(fallback).toContainText("Your account refused");
  await shot(page, "7-refused-over-cap");
  record("Open 10 XLM at 2x again: refused by the account over the cap", {
    note: await fallback.locator(".grant-refusal").innerText(),
  });
  await fallback.getByRole("button", { name: "Cancel" }).click();
  expect(popups).toBe(popupsAfterApproval);
  await expect(page.locator("#grant-refusal")).toContainText("Your account refused");
  await shot(page, "8-refusal-shown");

  // On chain: exactly the two grant-signed transactions, both successful.
  const sent = await feePayerTransactions(page);
  record("Grant-signed transactions on testnet (fee payer's history)", { note: JSON.stringify(sent) });
  expect(sent.filter((t) => t.successful)).toHaveLength(2);
});
