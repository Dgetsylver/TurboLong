/**
 * Wire the testnet vault IDs into the frontend after the testnet rehearsal deploy.
 *
 * Reads deployed-vaults.testnet.json (written by deploy_strategy_testnet.ts) and
 * fills each TESTNET_VAULTS entry in frontend/src/defindex.ts with its deployed
 * strategy address (`vaultId`) and share-token address (`shareToken`), matched by
 * `assetSymbol`. Idempotent.
 *
 * Replacement is scoped to the TESTNET_VAULTS array only, so it never touches the
 * MAINNET_VAULTS entries (which share asset symbols like USDC/CETES/XLM).
 *
 * Usage: npx tsx scripts/wire_testnet_vaults.ts
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const deployedPath = path.resolve(here, "../deployed-vaults.testnet.json");
const defindexPath = path.resolve(here, "../frontend/src/defindex.ts");

if (!fs.existsSync(deployedPath)) {
  console.error(`Missing ${deployedPath}. Run deploy_strategy_testnet.ts first.`);
  process.exit(1);
}

const deployed: Record<string, { strategy: string; token: string }> = JSON.parse(
  fs.readFileSync(deployedPath, "utf-8"),
);

const src = fs.readFileSync(defindexPath, "utf-8");

// Isolate the TESTNET_VAULTS array body so edits can't bleed into MAINNET_VAULTS.
const blockRe = /const TESTNET_VAULTS:\s*VaultConfig\[\]\s*=\s*\[([\s\S]*?)\n\];/;
const blockMatch = src.match(blockRe);
if (!blockMatch) {
  console.error("Could not locate the TESTNET_VAULTS array in defindex.ts.");
  process.exit(1);
}

let block = blockMatch[1];
let changed = 0;

for (const [symbol, ids] of Object.entries(deployed)) {
  if (!ids.strategy) {
    console.warn(`[${symbol}] no strategy address — skipping`);
    continue;
  }
  const vaultIdRe = new RegExp(
    `(vaultId:\\s*")[^"]*("[^}]*?assetSymbol:\\s*"${symbol}")`,
  );
  if (!vaultIdRe.test(block)) {
    console.warn(`[${symbol}] no TESTNET_VAULTS entry found — skipping`);
    continue;
  }
  block = block.replace(vaultIdRe, `$1${ids.strategy}$2`);

  const hasShareToken = new RegExp(
    `vaultId:\\s*"${ids.strategy}"[^}]*?shareToken:\\s*"[^"]*"[^}]*?assetSymbol:\\s*"${symbol}"`,
  ).test(block);
  if (ids.token) {
    if (hasShareToken) {
      block = block.replace(
        new RegExp(`(shareToken:\\s*")[^"]*("[^}]*?assetSymbol:\\s*"${symbol}")`),
        `$1${ids.token}$2`,
      );
    } else {
      block = block.replace(
        new RegExp(`(vaultId:\\s*"${ids.strategy}",)`),
        `$1\n    shareToken: "${ids.token}",`,
      );
    }
  }
  changed++;
  console.log(`[${symbol}] vaultId=${ids.strategy} shareToken=${ids.token}`);
}

const out = src.replace(blockRe, `const TESTNET_VAULTS: VaultConfig[] = [${block}\n];`);
fs.writeFileSync(defindexPath, out);
console.log(`\nWired ${changed} testnet vault(s) into ${defindexPath}. Run \`npm run build\` in frontend to verify.`);
