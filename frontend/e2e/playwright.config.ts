import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Turbolong frontend E2E suite.
 *
 * Tests run against a `vite preview` of the built `dist/` (served on :4173).
 * Everything is hermetic: the app is loaded with `?e2e=1` so its mock-wallet
 * harness (frontend/src/e2e-harness.ts) replaces all wallet + RPC calls — no
 * extension, hardware wallet, or live network is touched.
 */
// Port for the preview server. Defaults to 4173 but is overridable via E2E_PORT
// so the suite can dodge a busy port (e.g. an unrelated dev server) locally.
const PORT = Number(process.env.E2E_PORT ?? 4173);

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
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
    // Build first so `vite preview` serves fresh assets, then preview on $PORT.
    command: `npm --prefix .. run build && npm --prefix .. run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
