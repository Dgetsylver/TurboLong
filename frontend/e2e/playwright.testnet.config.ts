import { defineConfig, devices } from "@playwright/test";

/**
 * Live testnet demo of grant mode (`npm run test:e2e:testnet`). Not part of CI:
 * it creates a throwaway Nido account on Nido's Perch dev preview
 * (https://356.test.nido.fyi, Friendbot-funded), approves TurboLong's grant
 * with a virtual passkey, and sends real testnet transactions. Nothing here
 * touches mainnet.
 */
export default defineConfig({
  testDir: "./testnet",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 15 * 60_000,
  use: {
    baseURL: "http://localhost:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm --prefix .. run build && npm --prefix .. run preview -- --port 4174 --strictPort",
    url: "http://localhost:4174",
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
