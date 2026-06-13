import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Turbolong frontend E2E suite.
 *
 * Tests run against a `vite preview` of the built `dist/` (served on :4173).
 * Everything is hermetic: the app is loaded with `?e2e=1` so its mock-wallet
 * harness (frontend/src/e2e-harness.ts) replaces all wallet + RPC calls — no
 * extension, hardware wallet, or live network is touched.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Build first so `vite preview` serves fresh assets, then preview on :4173.
    command: "npm --prefix .. run build && npm --prefix .. run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
