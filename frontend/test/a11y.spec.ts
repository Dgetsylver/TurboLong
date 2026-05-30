/**
 * Axe-core accessibility check for key pages.
 *
 * Runs against the built static site (vite preview).
 * Fails on any critical or serious WCAG 2.1 AA violations.
 */

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:4173";

test.describe("WCAG 2.1 AA — zero critical/serious violations", () => {
  test("landing page (connect prompt)", async ({ page }) => {
    // Pre-accept disclaimer so the modal doesn't block the page
    await page.goto(BASE);
    await page.evaluate(() => localStorage.setItem("disclaimerAccepted", "1"));
    await page.reload();

    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
  });

  test("disclaimer modal", async ({ page }) => {
    await page.goto(BASE);
    // Disclaimer should be visible (no localStorage key)
    await page.evaluate(() => localStorage.removeItem("disclaimerAccepted"));
    await page.reload();

    const results = await new AxeBuilder({ page })
      .include("#disclaimer-overlay")
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
  });
});
