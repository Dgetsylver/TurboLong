/// <reference types="vitest/config" />
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/over_leveraging/" : "/",
  envPrefix: ["VITE_"],
  define: {
    // Some Stellar SDK internals check for global
    global: "globalThis",
  },
  build: {
    target: "es2020",
    rollupOptions: {
      input: {
        // Main app + standalone status page (T3.5) as separate entries.
        main: resolve(root, "index.html"),
        status: resolve(root, "status.html"),
      },
    },
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
