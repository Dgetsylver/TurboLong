/**
 * Disclosure Pipeline Smoke Test
 *
 * Verifies the end-to-end disclosure pipeline is wired correctly:
 *   1. security.txt is reachable and well-formed (RFC 9116)
 *   2. Bug-bounty page is reachable and contains expected content
 *   3. SECURITY.md is present in the repository root
 *   4. Disclosure email address is defined and non-placeholder
 *   5. Simulates a mock disclosure submission (dry-run via stdout)
 *
 * Usage:
 *   npx ts-node scripts/test-disclosure-pipeline.ts [--base-url https://turbolong.app]
 *
 * Exit codes:
 *   0  all checks passed
 *   1  one or more checks failed
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ─────────────────────────────────────────────────────────────────

// argv[0]=node, argv[1]=script — user args start at index 2
const _userArgs = process.argv.slice(2);
const BASE_URL =
  _userArgs.find((a) => a.startsWith("--base-url="))?.split("=")[1] ??
  (_userArgs.includes("--base-url")
    ? _userArgs[_userArgs.indexOf("--base-url") + 1]
    : undefined) ??
  "https://turbolong.app";

const REPO_ROOT = path.resolve(__dirname, "..");

const EXPECTED_CONTACT = "security@turbolong.app";

// ── Helpers ─────────────────────────────────────────────────────────────────

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function pass(name: string, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`  ✅  ${name}${detail ? "  — " + detail : ""}`);
}

function fail(name: string, detail = "") {
  results.push({ name, ok: false, detail });
  console.error(`  ❌  ${name}${detail ? "  — " + detail : ""}`);
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Check 1: SECURITY.md present in repo root ───────────────────────────────

function checkSecurityMd() {
  const p = path.join(REPO_ROOT, "SECURITY.md");
  if (!fs.existsSync(p)) {
    return fail("SECURITY.md present", "file not found at repo root");
  }
  const content = fs.readFileSync(p, "utf-8");
  if (!content.includes(EXPECTED_CONTACT)) {
    return fail("SECURITY.md contains contact", `"${EXPECTED_CONTACT}" not found`);
  }
  if (!content.includes("Critical") || !content.includes("High")) {
    return fail("SECURITY.md contains severity tiers", "missing Critical / High tiers");
  }
  pass("SECURITY.md present and well-formed");
}

// ── Check 2: security.txt present locally ───────────────────────────────────

function checkSecurityTxt() {
  const p = path.join(REPO_ROOT, "landing", ".well-known", "security.txt");
  if (!fs.existsSync(p)) {
    return fail("security.txt present locally", "not found at landing/.well-known/security.txt");
  }
  const content = fs.readFileSync(p, "utf-8");
  if (!content.includes("Contact:")) {
    return fail("security.txt has Contact field", "no Contact: line found");
  }
  if (!content.includes(EXPECTED_CONTACT)) {
    return fail("security.txt contact matches policy", `"${EXPECTED_CONTACT}" not found`);
  }
  if (!content.includes("Expires:")) {
    return fail("security.txt has Expires field", "RFC 9116 requires Expires:");
  }
  if (!content.includes("Policy:")) {
    return fail("security.txt has Policy field", "Policy: line missing");
  }
  pass("security.txt present and RFC 9116 compliant");
}

// ── Check 3: bug-bounty.html present locally ────────────────────────────────

function checkBugBountyPage() {
  const p = path.join(REPO_ROOT, "landing", "bug-bounty.html");
  if (!fs.existsSync(p)) {
    return fail("bug-bounty.html present", "not found at landing/bug-bounty.html");
  }
  const content = fs.readFileSync(p, "utf-8");
  const required = ["Critical", "High", "Medium", "In Scope", EXPECTED_CONTACT, "Payout"];
  for (const term of required) {
    if (!content.includes(term)) {
      return fail("bug-bounty.html content", `missing required term: "${term}"`);
    }
  }
  pass("bug-bounty.html present and content complete");
}

// ── Check 4: Remote security.txt reachable ──────────────────────────────────

async function checkRemoteSecurityTxt() {
  const url = `${BASE_URL}/.well-known/security.txt`;
  const text = await fetchText(url);
  if (!text) {
    return fail("Remote security.txt reachable", `GET ${url} failed (site may not be deployed yet)`);
  }
  if (!text.includes("Contact:") || !text.includes(EXPECTED_CONTACT)) {
    return fail("Remote security.txt content", "Contact field missing or incorrect");
  }
  pass("Remote security.txt reachable", url);
}

// ── Check 5: Remote bug-bounty page reachable ───────────────────────────────

async function checkRemoteBountyPage() {
  const url = `${BASE_URL}/bug-bounty`;
  const text = await fetchText(url);
  if (!text) {
    // Also try .html extension
    const url2 = `${BASE_URL}/bug-bounty.html`;
    const text2 = await fetchText(url2);
    if (!text2) {
      return fail("Remote bug-bounty page reachable", `GET ${url} and ${url2} both failed`);
    }
    if (!text2.includes("Bug Bounty")) {
      return fail("Remote bug-bounty page content", "expected heading not found");
    }
    return pass("Remote bug-bounty page reachable", url2);
  }
  if (!text.includes("Bug Bounty")) {
    return fail("Remote bug-bounty page content", "expected heading not found");
  }
  pass("Remote bug-bounty page reachable", url);
}

// ── Check 6: Simulate disclosure submission (dry run) ───────────────────────

function simulateDisclosure() {
  const mockReport = {
    to: EXPECTED_CONTACT,
    subject: "Bug Bounty Report — [SEVERITY] — [SHORT TITLE]",
    body: [
      "Affected target: contracts/strategies/blend_leverage/src/lib.rs",
      "Severity assessment: Critical / High / Medium / Low",
      "Description: <clear description of the vulnerability>",
      "Reproduction steps:",
      "  1. ...",
      "  2. ...",
      "Impact: <funds at risk, scope of effect>",
      "Suggested fix: <optional>",
      "Contact: <your preferred contact>",
      "Stellar address for payout: G...",
    ].join("\n"),
  };

  console.log("\n  📧  Mock disclosure submission (dry-run):");
  console.log(`      To:      ${mockReport.to}`);
  console.log(`      Subject: ${mockReport.subject}`);
  console.log("      Body template:");
  mockReport.body.split("\n").forEach((l) => console.log(`        ${l}`));

  pass("Disclosure submission template generated");
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🔍  TurboLong Disclosure Pipeline Smoke Test");
  console.log(`    Base URL : ${BASE_URL}`);
  console.log(`    Repo root: ${REPO_ROOT}`);
  console.log("─".repeat(60));

  console.log("\n[Local file checks]");
  checkSecurityMd();
  checkSecurityTxt();
  checkBugBountyPage();

  console.log("\n[Remote checks — requires deployed site]");
  await checkRemoteSecurityTxt();
  await checkRemoteBountyPage();

  console.log("\n[Disclosure simulation]");
  simulateDisclosure();

  // ── Summary ──
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log("\n" + "─".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.error("Some checks failed. Review the output above.");
    process.exit(1);
  } else {
    console.log("All checks passed. Disclosure pipeline is operational. ✅");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
