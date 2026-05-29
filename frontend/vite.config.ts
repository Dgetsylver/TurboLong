import { defineConfig } from "vite";

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
});
