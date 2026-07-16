/**
 * Turbolong harvest routing report — SCF T2.1 proof & demo tool.
 *
 * Pulls the Broker-vs-Soroswap A/B dataset from the alerts Worker (D1
 * `swap_routes`), verifies every executed tx on-chain via Horizon, prints a
 * human-readable audit of each routing decision, and computes the post-tranche
 * analysis figures (win rate, average uplift, fallback correctness, progress
 * toward the 50-harvest acceptance target).
 *
 * Usage (from scripts/):
 *   npx tsx harvest_report.ts                # full report, on-chain verification
 *   npx tsx harvest_report.ts --no-verify    # skip Horizon lookups (offline/fast)
 *   npx tsx harvest_report.ts --limit 500    # rows to fetch (default 500, max 500)
 *   npx tsx harvest_report.ts --md report.md # also write a markdown report
 *
 * Env (falls back to scripts/deploy/harvest-keeper.env for non-secret values):
 *   SWAP_ROUTES_URL   alerts Worker base URL
 *   NETWORK           D1 network filter (default mainnet)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Env (auto-load the keeper env file for convenience; secrets unused) ──────
function loadKeeperEnv(): void {
  const p = resolve(HERE, "deploy/harvest-keeper.env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] != null) continue;
    process.env[k] = raw.replace(/^['"]|['"]$/g, "");
  }
}
loadKeeperEnv();

const WORKER_URL = (process.env.SWAP_ROUTES_URL ?? "https://turbolong-alerts.turbolong.workers.dev").replace(/\/$/, "");
const NETWORK = process.env.NETWORK ?? "mainnet";
const HORIZON = "https://horizon.stellar.org";
const EXPERT = "https://stellar.expert/explorer/public/tx";

const argAfter = (flag: string): string | null => {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};
const LIMIT = Math.min(Number(argAfter("--limit") ?? 500), 500);
const VERIFY = !process.argv.includes("--no-verify");
const MD_OUT = argAfter("--md");

// ── ANSI helpers (degrade gracefully when piped) ─────────────────────────────
const tty = process.stdout.isTTY;
const paint = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1"), dim = paint("2"), green = paint("32"), yellow = paint("33"), red = paint("31"), cyan = paint("36"), magenta = paint("35");

// ── Types (mirror the D1 swap_routes row) ────────────────────────────────────
interface Row {
  id: number;
  ts: string;
  network: string;
  strategy_id: string;
  asset_symbol: string;
  amount_in: string;
  broker_quote: string | null;
  soroswap_quote: string | null;
  chosen: "broker" | "soroswap";
  reason: string;
  executed_out: string | null;
  amount_out_min: string;
  slippage_bps: number | null;
  uplift_bps: number | null;
  tx_hash: string | null;
  status: string;
}

// All on-chain amounts are 7-decimal stroop strings.
const fmt = (stroops: string | null, symbol = ""): string => {
  if (stroops == null) return dim("—");
  const n = Number(stroops) / 1e7;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 7 })}${symbol ? " " + symbol : ""}`;
};

const bps = (v: number | null): string => (v == null ? dim("—") : `${v > 0 ? "+" : ""}${v} bps`);

// Mirrors Decision.reason in harvest_router.ts.
const REASONS: Record<string, string> = {
  best: "Broker quoted best (or was the only quote)",
  fallback_worse: "fallback: Broker quote was worse than Soroswap",
  fallback_unavailable: "fallback: Broker unavailable (no quote / not executable / trade failed)",
};

const STATUS_PAINT: Record<string, (s: string) => string> = {
  executed: green,
  quote_only: cyan,
  failed: red,
  deferred_threshold: yellow,
  noop_threshold: yellow,
};

// ── On-chain verification via Horizon ────────────────────────────────────────
interface TxCheck { ok: boolean; ledger?: number; created?: string; note: string }

async function verifyTx(hash: string): Promise<TxCheck> {
  try {
    const res = await fetch(`${HORIZON}/transactions/${hash}`);
    if (res.status === 404) return { ok: false, note: "NOT FOUND on-chain" };
    if (!res.ok) return { ok: false, note: `Horizon HTTP ${res.status}` };
    const tx = (await res.json()) as { successful: boolean; ledger: number; created_at: string };
    return {
      ok: tx.successful,
      ledger: tx.ledger,
      created: tx.created_at,
      note: tx.successful ? "confirmed on-chain" : "on-chain but FAILED",
    };
  } catch (e) {
    return { ok: false, note: `verify error: ${(e as Error).message}` };
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(bold(`\n══ Turbolong harvest routing report — Stellar Broker vs Soroswap ══`));
  console.log(dim(`worker: ${WORKER_URL}  network: ${NETWORK}  limit: ${LIMIT}  verify: ${VERIFY ? "on (Horizon)" : "off"}\n`));

  const res = await fetch(`${WORKER_URL}/swap-routes?network=${NETWORK}&limit=${LIMIT}`);
  if (!res.ok) throw new Error(`GET /swap-routes → HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { report: Record<string, unknown>; rows: Row[] };
  const rows = [...body.rows].sort((a, b) => a.id - b.id); // chronological

  if (rows.length === 0) {
    console.log(yellow("No rows in the dataset yet — run the keeper first (harvest_router.ts)."));
    return;
  }

  // ── Per-decision audit log ──────────────────────────────────────────────────
  console.log(bold(`── Routing decisions (${rows.length} rows) ─────────────────────────────`));
  const verified: Record<number, TxCheck> = {};

  for (const r of rows) {
    const statusPaint = STATUS_PAINT[r.status] ?? ((s: string) => s);
    console.log(`\n${bold(`#${r.id}`)}  ${dim(r.ts + " UTC")}  ${bold(r.asset_symbol)}  ${statusPaint(`[${r.status}]`)}`);
    console.log(`  strategy      ${dim(r.strategy_id)}`);
    console.log(`  amount in     ${fmt(r.amount_in, "BLND")}`);
    console.log(`  broker quote  ${r.broker_quote != null ? fmt(r.broker_quote, r.asset_symbol) : dim("unavailable")}`);
    console.log(`  soroswap quote ${r.soroswap_quote != null ? fmt(r.soroswap_quote, r.asset_symbol) : dim("unavailable")}`);
    if (r.broker_quote != null && r.soroswap_quote != null) {
      const b = Number(r.broker_quote), s = Number(r.soroswap_quote);
      const delta = s > 0 ? Math.round(((b - s) / s) * 10_000) : 0;
      const better = b > s ? "broker" : b < s ? "soroswap" : "tie";
      console.log(`  quote delta   ${bps(delta)} ${dim(`(better: ${better})`)}`);
      // Acceptance check: chosen must match the better quote (ties go either way).
      const consistent = better === "tie" || r.chosen === better || r.reason === "fallback_unavailable";
      console.log(`  selection     ${consistent ? green("✓ best-route selection consistent with quotes") : red("✗ INCONSISTENT with quotes")}`);
    }
    console.log(`  chosen        ${r.chosen === "broker" ? magenta("BROKER") : cyan("SOROSWAP")} ${dim(`— ${REASONS[r.reason] ?? r.reason}`)}`);
    console.log(`  min out       ${fmt(r.amount_out_min, r.asset_symbol)} ${dim("(slippage floor)")}`);
    if (r.executed_out != null && Number(r.executed_out) === 0 && r.status === "executed") {
      console.log(`  executed out  ${yellow("0 — contract reward_threshold no-op (BLND kept for the next harvest)")}`);
    } else if (r.executed_out != null) {
      console.log(`  executed out  ${fmt(r.executed_out, r.asset_symbol)}  slippage vs quote: ${bps(r.slippage_bps)}`);
    }
    if (r.uplift_bps != null) console.log(`  uplift        ${bps(r.uplift_bps)} ${dim("(chosen route vs the alternative)")}`);
    if (r.tx_hash) {
      console.log(`  tx            ${EXPERT}/${r.tx_hash}`);
      if (VERIFY) {
        const check = await verifyTx(r.tx_hash);
        verified[r.id] = check;
        const paintFn = check.ok ? green : red;
        console.log(`  on-chain      ${paintFn(`${check.ok ? "✓" : "✗"} ${check.note}`)}${check.ledger ? dim(`  ledger ${check.ledger} @ ${check.created}`) : ""}`);
      }
    }
  }

  // ── Aggregate analysis ──────────────────────────────────────────────────────
  const both = rows.filter((r) => r.broker_quote != null && r.soroswap_quote != null);
  const brokerBetter = both.filter((r) => Number(r.broker_quote) > Number(r.soroswap_quote));
  // A tx that swapped nothing (contract reward_threshold no-op) is not a real
  // execution — keep it out of win-rate/slippage stats.
  const executed = rows.filter((r) => r.status === "executed" && r.executed_out != null && Number(r.executed_out) > 0);
  const execBroker = executed.filter((r) => r.chosen === "broker");
  const execSoroswap = executed.filter((r) => r.chosen === "soroswap");
  const fallbacks = rows.filter((r) => r.reason.startsWith("fallback"));
  const upliftVals = rows.map((r) => r.uplift_bps).filter((v): v is number => v != null);
  const avgUplift = upliftVals.length ? upliftVals.reduce((a, b) => a + b, 0) / upliftVals.length : null;
  const slipVals = executed.map((r) => r.slippage_bps).filter((v): v is number => v != null);
  const avgSlip = slipVals.length ? slipVals.reduce((a, b) => a + b, 0) / slipVals.length : null;
  const txChecks = Object.values(verified);
  const perAsset = new Map<string, number>();
  for (const r of rows) perAsset.set(r.asset_symbol, (perAsset.get(r.asset_symbol) ?? 0) + 1);

  const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

  console.log(bold(`\n── Analysis (acceptance criteria) ──────────────────────────────────`));
  console.log(`  dataset size            ${bold(String(rows.length))} rows  ${dim(`(${[...perAsset].map(([k, v]) => `${k}: ${v}`).join(", ")})`)}`);
  const target = 50;
  const progress = Math.min(both.length, target);
  const bar = "█".repeat(Math.round((progress / target) * 30)).padEnd(30, "░");
  console.log(`  harvests w/ BOTH quotes ${bold(String(both.length))} / ${target}  ${both.length >= target ? green(bar) : yellow(bar)}`);
  console.log(`  broker quote win rate   ${bold(pct(brokerBetter.length, both.length))} ${dim(`(${brokerBetter.length}/${both.length} rows where Broker quoted higher)`)}`);
  console.log(`  executed                ${executed.length}  ${dim(`broker: ${execBroker.length}, soroswap: ${execSoroswap.length}`)}`);
  console.log(`  executed via broker     ${pct(execBroker.length, executed.length)}`);
  console.log(`  fallback triggers       ${fallbacks.length} ${dim(`(reason=${[...new Set(fallbacks.map((r) => r.reason))].join(", ") || "—"})`)}`);
  console.log(`  avg uplift (chosen)     ${avgUplift != null ? bps(Math.round(avgUplift)) : dim("— (needs rows with both quotes)")}`);
  console.log(`  avg realized slippage   ${avgSlip != null ? bps(Math.round(avgSlip)) : dim("—")}`);
  if (VERIFY) {
    const okCount = txChecks.filter((c) => c.ok).length;
    const paintFn = okCount === txChecks.length ? green : red;
    console.log(`  on-chain verification   ${paintFn(`${okCount}/${txChecks.length} tx confirmed via Horizon`)}`);
  }
  console.log(dim(`\n  Worker aggregate (D1): ${JSON.stringify(body.report)}\n`));

  // ── Optional markdown report (post-tranche deliverable) ────────────────────
  if (MD_OUT) {
    const md: string[] = [
      `# Broker-vs-Soroswap routing report (${NETWORK})`,
      ``,
      `Generated ${new Date().toISOString()} from ${WORKER_URL}/swap-routes`,
      ``,
      `## Summary`,
      ``,
      `| Metric | Value |`,
      `|---|---|`,
      `| Dataset rows | ${rows.length} |`,
      `| Harvests with both quotes logged | ${both.length} / ${target} |`,
      `| Broker quote win rate | ${pct(brokerBetter.length, both.length)} (${brokerBetter.length}/${both.length}) |`,
      `| Executed swaps | ${executed.length} (broker ${execBroker.length}, soroswap ${execSoroswap.length}) |`,
      `| Fallback triggers | ${fallbacks.length} |`,
      `| Average uplift (chosen vs alternative) | ${avgUplift != null ? Math.round(avgUplift) + " bps" : "—"} |`,
      `| Average realized slippage | ${avgSlip != null ? Math.round(avgSlip) + " bps" : "—"} |`,
      ...(VERIFY ? [`| On-chain verification | ${txChecks.filter((c) => c.ok).length}/${txChecks.length} tx confirmed |`] : []),
      ``,
      `## Decisions`,
      ``,
      `| id | ts | asset | in (BLND) | broker quote | soroswap quote | chosen | reason | status | out | tx |`,
      `|---|---|---|---|---|---|---|---|---|---|---|`,
      ...rows.map((r) =>
        `| ${r.id} | ${r.ts} | ${r.asset_symbol} | ${fmt(r.amount_in)} | ${r.broker_quote != null ? fmt(r.broker_quote) : "—"} | ${r.soroswap_quote != null ? fmt(r.soroswap_quote) : "—"} | ${r.chosen} | ${r.reason} | ${r.status} | ${r.executed_out != null ? fmt(r.executed_out) : "—"} | ${r.tx_hash ? `[${r.tx_hash.slice(0, 8)}…](${EXPERT}/${r.tx_hash})` : "—"} |`,
      ),
      ``,
    ];
    const out = resolve(process.cwd(), MD_OUT);
    writeFileSync(out, md.join("\n"));
    console.log(green(`markdown report written → ${out}\n`));
  }
}

main().catch((e) => {
  console.error(red((e as Error).message));
  process.exit(1);
});
