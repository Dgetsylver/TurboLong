/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/over_leveraging/" : "/",
  envPrefix: ["VITE_"],
  define: {
    // Some Stellar SDK internals check for global
    global: "globalThis",
  },
  build: {
    target: "es2020",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2020",
    },
  },
  test: {
    // Playwright specs live under e2e/ and use @playwright/test; keep them out
    // of the vitest unit run (parity.yml), which only owns test/**.
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
