import { defineConfig } from "@playwright/test";

export default defineConfig({
  testMatch: "test/a11y.spec.ts",
  use: { baseURL: process.env.BASE_URL ?? "http://localhost:4173" },
  webServer: {
    command: "npm run preview -- --port 4173",
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
});
