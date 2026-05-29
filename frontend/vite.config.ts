import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_PAGES ? "/over_leveraging/" : "/",
  define: {
    // Some Stellar SDK internals check for global
    global: "globalThis",
  },
  build: {
    target: "es2020",
    rollupOptions: {
      external: ["rxjs", "rxjs/operators"],
    },
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "es2020",
    },
  },
});
