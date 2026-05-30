#!/usr/bin/env node
/**
 * Verifies that es.json and pt-BR.json contain exactly the same keys as en.json.
 * Run via: npm run lint:i18n
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const i18nDir = resolve(__dir, "../src/i18n");

function flatKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) => {
    const full = prefix ? `${prefix}.${k}` : k;
    return typeof v === "object" && v !== null ? flatKeys(v, full) : [full];
  });
}

const en = JSON.parse(readFileSync(`${i18nDir}/en.json`, "utf8"));
const es = JSON.parse(readFileSync(`${i18nDir}/es.json`, "utf8"));
const ptBR = JSON.parse(readFileSync(`${i18nDir}/pt-BR.json`, "utf8"));

const enKeys = new Set(flatKeys(en));
let errors = 0;

for (const [locale, obj] of [["es", es], ["pt-BR", ptBR]]) {
  const keys = new Set(flatKeys(obj));
  for (const k of enKeys) {
    if (!keys.has(k)) {
      console.error(`[${locale}] Missing key: ${k}`);
      errors++;
    }
  }
  for (const k of keys) {
    if (!enKeys.has(k)) {
      console.warn(`[${locale}] Extra key not in en.json: ${k}`);
    }
  }
}

if (errors === 0) {
  console.log("✓ All i18n locale files are in sync.");
} else {
  console.error(`\n✗ ${errors} missing key(s) found.`);
  process.exit(1);
}
