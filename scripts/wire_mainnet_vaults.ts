/**
 * Wire the mainnet vault IDs into the frontend after deployment — SCF T1 D1.
 *
 * Reads deployed-vaults.mainnet.json (written by deploy_strategy_mainnet.ts) and
 * fills each MAINNET_VAULTS entry in frontend/src/defindex.ts with its deployed
 * strategy address (`vaultId`) and share-token address (`shareToken`), matched by
 * `assetSymbol`. Idempotent.
 *
 * Usage: npx tsx scripts/wire_mainnet_vaults.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deployedPath = path.resolve(here, "../deployed-vaults.mainnet.json");
const defindexPath = path.resolve(here, "../frontend/src/defindex.ts");

if (!fs.existsSync(deployedPath)) {
  console.error(`Missing ${deployedPath}. Run deploy_strategy_mainnet.ts first.`);
  process.exit(1);
}

const deployed: Record<string, { strategy: string; token: string }> = JSON.parse(
  fs.readFileSync(deployedPath, "utf-8"),
);

let src = fs.readFileSync(defindexPath, "utf-8");
let changed = 0;

for (const [symbol, ids] of Object.entries(deployed)) {
  if (!ids.strategy) {
    console.warn(`[${symbol}] no strategy address — skipping`);
    continue;
  }
  // Within the object whose assetSymbol is `symbol`, set vaultId. The `[^}]*?`
  // keeps the match inside one vault object (no nested braces in these entries).
  const vaultIdRe = new RegExp(
    `(vaultId:\\s*")[^"]*("[^}]*?assetSymbol:\\s*"${symbol}")`,
  );
  if (!vaultIdRe.test(src)) {
    console.warn(`[${symbol}] no MAINNET_VAULTS entry found — skipping`);
    continue;
  }
  src = src.replace(vaultIdRe, `$1${ids.strategy}$2`);

  // Set or insert shareToken in the same object (after the vaultId line).
  const hasShareToken = new RegExp(
    `vaultId:\\s*"${ids.strategy}"[^}]*?shareToken:\\s*"[^"]*"[^}]*?assetSymbol:\\s*"${symbol}"`,
  ).test(src);
  if (ids.token) {
    if (hasShareToken) {
      src = src.replace(
        new RegExp(`(shareToken:\\s*")[^"]*("[^}]*?assetSymbol:\\s*"${symbol}")`),
        `$1${ids.token}$2`,
      );
    } else {
      src = src.replace(
        new RegExp(`(vaultId:\\s*"${ids.strategy}",)`),
        `$1\n    shareToken: "${ids.token}",`,
      );
    }
  }
  changed++;
  console.log(`[${symbol}] vaultId=${ids.strategy} shareToken=${ids.token}`);
}

fs.writeFileSync(defindexPath, src);
console.log(`\nWired ${changed} vault(s) into ${defindexPath}. Run \`npm run build\` in frontend to verify.`);
