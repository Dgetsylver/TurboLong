import { expect, test } from "@playwright/test";

/**
 * Swap screen — the curated-asset picker + custom slippage (issue #318).
 * Boots the real app under the E2E harness, navigates to Swap, and exercises:
 * pills + Custom chip render, the searchable picker filters by code, selecting
 * updates the pill, and custom-slippage validation flags out-of-range input.
 * Deterministic — the search target (USDC) is in the built-in fallback list, so
 * it passes whether or not the live LOBSTR feed is reachable.
 */
test.describe("Swap curated picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem("disclaimerAccepted", "1");
    });
  });

  test("renders picker + custom slippage, search filters, validation works", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/?e2e=1");
    await page.waitForFunction(() => (window as any).__E2E__?.installed === true, null, { timeout: 30_000 });

    // Navigate to Swap via the nav tab.
    await page.getByRole("button", { name: "Swap", exact: true }).first().click();
    await page.waitForSelector(".tl-swap__card", { timeout: 15_000 });

    // Two asset pills + the Custom slippage chip exist.
    await expect(page.locator(".tl-swap__pill")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Custom" })).toBeVisible();

    // Open the buy-side picker → search modal appears with rows.
    await page.locator(".tl-swap__pill").nth(1).click();
    await page.waitForSelector(".tl-ap__list .tl-ap__row", { timeout: 10_000 });
    const before = await page.locator(".tl-ap__row").count();
    expect(before).toBeGreaterThan(1);

    // Search by code narrows the list to USDC.
    await page.locator(".tl-ap__input").fill("usdc");
    await page.waitForTimeout(200);
    await expect(page.locator(".tl-ap__row").first()).toContainText("USDC");

    // Pick it; pill reflects USDC; modal closes.
    await page.locator(".tl-ap__row").first().click();
    await expect(page.locator(".tl-ap")).toHaveCount(0);
    await expect(page.locator(".tl-swap__pill").nth(1)).toContainText("USDC");

    // Custom slippage: valid value accepted, out-of-range flagged invalid.
    await page.getByRole("button", { name: "Custom" }).click();
    const slipInput = page.locator(".tl-swap__slip-input");
    await slipInput.fill("2.4");
    await expect(slipInput).not.toHaveClass(/is-invalid/);
    await slipInput.fill("80");
    await expect(slipInput).toHaveClass(/is-invalid/);
    await expect(page.locator(".tl-swap__slip-warn.is-error")).toBeVisible();

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
