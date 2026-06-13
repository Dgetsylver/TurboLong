/**
 * Browser polyfills that MUST run before any other module is evaluated.
 *
 * The Stellar Wallets Kit Ledger module pulls in `@ledgerhq/*` packages that
 * reference a global `Buffer` at module-evaluation time. ES module imports are
 * evaluated before any executable statement in the importing module, so the
 * polyfill cannot live as inline code in main.ts — it must be a side-effect
 * import placed first. Keep `import "./polyfills.ts"` as the very first import.
 */
import { Buffer as NodeBuffer } from "buffer";

const g = globalThis as { Buffer?: unknown };
if (typeof g.Buffer === "undefined") {
  g.Buffer = NodeBuffer;
}
