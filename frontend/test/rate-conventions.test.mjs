import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const frontendRoot = resolve(here, "..");
const repoRoot = resolve(frontendRoot, "..");

async function readRepoFile(...parts) {
  return readFile(resolve(repoRoot, ...parts), "utf8");
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

test("rate labels explicitly distinguish APR and APY", async () => {
  const indexHtml = await readRepoFile("frontend", "index.html");

  assert.match(indexHtml, /Interest APY/);
  assert.match(indexHtml, /Net supply APY/);
  assert.match(indexHtml, /Interest cost APY/);
  assert.match(indexHtml, /Net borrow cost APY/);
  assert.equal(countMatches(indexHtml, /BLND emissions APR/g), 2);
  assert.doesNotMatch(indexHtml, /<span class="apr-key">Interest cost<\/span>/);
  assert.doesNotMatch(indexHtml, /<span class="apr-key">Net borrow cost <span/);
});

test("dynamic rate copy uses the selected convention", async () => {
  const mainTs = await readRepoFile("frontend", "src", "main.ts");

  assert.match(mainTs, /Net APY \$\{netApy >= 0 \? "\+" : ""\}/);
  assert.match(mainTs, /Interest spread APR:/);
  assert.match(mainTs, /Approximate APY/);
  assert.match(mainTs, /Actual net APR/);
});

test("glossary documents APR and APY behavior", async () => {
  const glossary = await readRepoFile("docs", "rate-glossary.md");

  assert.match(glossary, /BLND supply emissions/);
  assert.match(glossary, /BLND emissions are APR/);
  assert.match(glossary, /displayed APY =/);
  assert.match(glossary, /estimated net APY on equity/);
});
