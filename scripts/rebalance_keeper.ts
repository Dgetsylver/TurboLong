/**
 * Turbolong auto-rebalance keeper — SCF #43 T2.3 production keeper.
 *
 * For each configured vault: read the ON-CHAIN risk config (`config()` — never
 * hardcoded copies), read `health_factor()`, and drive whichever side of the
 * position needs attention:
 *
 *   HF below the on-chain `orange_hf` → `rebalance_keeper(caller)`, the
 *     keeper-authorised, rate-limited entrypoint that unwinds the minimal loops
 *     to restore HF and emits a `rebalance` event with before/after HF and loops.
 *
 *   HF above it → `releverage(caller)`, which borrows against collateral the
 *     vault already holds to restore the leverage an earlier unwind removed.
 *     Without this the position is a ratchet: every unwind is permanent and
 *     holders keep earning the reduced yield (audit M-3). The keeper makes no
 *     judgement about *how much* — the contract derives the target from
 *     `target_loops` and refuses to land inside the rebalance band — so the
 *     keeper only has to ask, and a no-op costs nothing but a simulation.
 *
 * Modes:
 *   (default) DRY-RUN — reads state + simulates the call that applies; NO key
 *             needed, NO signing, NO on-chain writes. Safe for CI/cron probes.
 *   --execute Live: signs and submits `rebalance_keeper` when (and only when)
 *             the on-chain HF is below the on-chain orange_hf, or `releverage`
 *             when the simulation says it would restore leverage. Requires
 *             KEEPER_SECRET (the strategy's keeper account) — provide it via a
 *             secrets manager (`op run`), never commit it.
 *   --loop    Keep running: re-check every INTERVAL_S (default 300s ≈ the
 *             60-ledger on-chain cooldown). Combine with --execute for the
 *             production keeper service.
 *
 * Env:
 *   NETWORK          testnet | mainnet            (default testnet)
 *   RPC_URL          Soroban RPC                  (network default)
 *   VAULTS_JSON      JSON array [{symbol, strategyId}] (default: deployed-vaults.testnet.json / mainnet list)
 *   KEEPER_SECRET    S... keeper key              (only for --execute)
 *   INTERVAL_S       loop interval seconds        (default 300)
 *   EVIDENCE_FILE    JSONL evidence output        (default docs/evidence/rebalance-keeper-log.jsonl)
 *
 * Every action (probe, skip, rebalance, re-leverage, cooldown rejection) is
 * appended as a JSON line to EVIDENCE_FILE — the audit trail for the T2.3/T3
 * acceptance.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  rpc as SorobanRpc,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  scValToNative,
} from "@stellar/stellar-sdk";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── CLI / env ─────────────────────────────────────────────────────────────────

const NETWORK = (process.env.NETWORK ?? "testnet") as "testnet" | "mainnet";
if (NETWORK !== "testnet" && NETWORK !== "mainnet") {
  console.error(`invalid NETWORK '${NETWORK}' (testnet | mainnet)`);
  process.exit(1);
}
const EXECUTE = process.argv.includes("--execute");
const LOOP = process.argv.includes("--loop");
const INTERVAL_S = Number(process.env.INTERVAL_S ?? "300");

const RPC_URL =
  process.env.RPC_URL ??
  (NETWORK === "mainnet" ? "https://mainnet.sorobanrpc.com" : "https://soroban-testnet.stellar.org");
const PASSPHRASE = NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const EVIDENCE_FILE = resolve(
  HERE,
  process.env.EVIDENCE_FILE ?? "../docs/evidence/rebalance-keeper-log.jsonl",
);

const HF_SCALAR = 10_000_000n; // 1e7
// Read-only simulation source account (any funded account works; never signs).
const SIM_ACCOUNT = "GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA";

interface Vault {
  symbol: string;
  strategyId: string;
}

function loadVaults(): Vault[] {
  if (process.env.VAULTS_JSON) return JSON.parse(process.env.VAULTS_JSON);
  if (NETWORK === "testnet") {
    const raw = JSON.parse(
      readFileSync(resolve(HERE, "../deployed-vaults.testnet.json"), "utf-8"),
    ) as Record<string, { strategy: string }>;
    return Object.entries(raw).map(([symbol, v]) => ({ symbol, strategyId: v.strategy }));
  }
  console.error("mainnet requires VAULTS_JSON=[{symbol, strategyId}, ...] (no default list committed)");
  process.exit(1);
}

const server = new SorobanRpc.Server(RPC_URL);
const keeper = (() => {
  if (!EXECUTE) return null;
  const secret = process.env.KEEPER_SECRET;
  if (!secret) {
    console.error("--execute requires KEEPER_SECRET (provide via `op run` / secrets manager)");
    process.exit(1);
  }
  return Keypair.fromSecret(secret);
})();

// ── Evidence log ──────────────────────────────────────────────────────────────

function logEvidence(row: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), network: NETWORK, ...row };
  console.log(JSON.stringify(entry));
  mkdirSync(dirname(EVIDENCE_FILE), { recursive: true });
  appendFileSync(EVIDENCE_FILE, `${JSON.stringify(entry)}\n`);
}

// ── On-chain reads (simulation, no signing) ───────────────────────────────────

async function simRead(strategyId: string, method: string): Promise<unknown> {
  const acc = await server.getAccount(SIM_ACCOUNT);
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(strategyId).call(method))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const err = SorobanRpc.Api.isSimulationError(sim) ? sim.error : "unknown simulation failure";
    throw new Error(`${method} simulation failed: ${err}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

interface VaultState {
  hf: number; // health factor as a float
  minHf: number;
  orangeHf: number;
  targetLoops: number | null;
  hasDebt: boolean;
  hasCollateral: boolean;
  configSource: "on-chain" | "fallback";
}

// Fallback thresholds for deployments that predate the `config()` view.
// Overridable via env; the on-chain values always win when available.
const FALLBACK_MIN_HF = Number(process.env.FALLBACK_MIN_HF ?? "1.05");
const FALLBACK_ORANGE_HF = Number(process.env.FALLBACK_ORANGE_HF ?? "1.15");

async function readVaultState(v: Vault): Promise<VaultState> {
  // config() = (c_factor, target_loops, min_hf, orange_hf) — the on-chain
  // source of truth for thresholds (anti-drift: never hardcode these). Older
  // deployments don't expose it; fall back to env-configured thresholds. The
  // contract re-checks HF < orange_hf on-chain anyway, so a stale fallback can
  // only cause a harmless no-op call, never an over-unwind.
  let cfg: [bigint, number, bigint, bigint] | null = null;
  try {
    cfg = (await simRead(v.strategyId, "config")) as [bigint, number, bigint, bigint];
  } catch {
    // pre-config() deployment — use fallback thresholds
  }
  const hfRaw = (await simRead(v.strategyId, "health_factor")) as bigint;
  const pos = (await simRead(v.strategyId, "position")) as bigint[];
  return {
    hf: Number(hfRaw) / Number(HF_SCALAR),
    minHf: cfg ? Number(cfg[2]) / Number(HF_SCALAR) : FALLBACK_MIN_HF,
    orangeHf: cfg ? Number(cfg[3]) / Number(HF_SCALAR) : FALLBACK_ORANGE_HF,
    targetLoops: cfg ? Number(cfg[1]) : null,
    hasDebt: BigInt(pos[3]) > 0n,
    hasCollateral: BigInt(pos[2]) > 0n,
    configSource: cfg ? "on-chain" : "fallback",
  };
}

// ── Keeper entrypoint execution ───────────────────────────────────────────────

/**
 * Simulate a keeper entrypoint (`rebalance_keeper` / `releverage`) without
 * signing. Returns whether it would run and, for a success, its return value —
 * `0` means the contract decided there is nothing to do, which is the signal to
 * skip rather than spend a transaction.
 */
async function simulateKeeperCall(
  v: Vault,
  method: string,
  caller: string,
): Promise<{ ok: boolean; result?: number; error?: string }> {
  try {
    const acc = await server.getAccount(SIM_ACCOUNT);
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(new Contract(v.strategyId).call(method, new Address(caller).toScVal()))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationSuccess(sim)) {
      const retval = sim.result?.retval ? Number(scValToNative(sim.result.retval)) : null;
      return { ok: true, result: retval ?? undefined };
    }
    return { ok: false, error: SorobanRpc.Api.isSimulationError(sim) ? sim.error : "unknown" };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Sign + submit a keeper entrypoint; returns (txHash, returnValue, status).
 * The return value is loops unwound for `rebalance_keeper`, underlying borrowed
 * for `releverage`.
 */
async function executeKeeperCall(
  v: Vault,
  method: string,
  kp: Keypair,
): Promise<{ tx: string; result: number | null; status: string }> {
  const acc = await server.getAccount(kp.publicKey());
  const built = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(v.strategyId).call(method, new Address(kp.publicKey()).toScVal()))
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(built);
  prepared.sign(kp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    return { tx: sent.hash, result: null, status: `send_error: ${JSON.stringify(sent.errorResult ?? "")}` };
  }

  // Poll for the final result (the entrypoint's return value).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const res = await server.getTransaction(sent.hash);
    if (res.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      const result = res.returnValue ? Number(scValToNative(res.returnValue)) : null;
      return { tx: sent.hash, result, status: "success" };
    }
    if (res.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
      return { tx: sent.hash, result: null, status: "failed" };
    }
  }
  return { tx: sent.hash, result: null, status: "timeout" };
}

// ── Per-vault pass ────────────────────────────────────────────────────────────

async function processVault(v: Vault): Promise<void> {
  let state: VaultState;
  try {
    state = await readVaultState(v);
  } catch (e) {
    logEvidence({ vault: v.symbol, strategy: v.strategyId, action: "read_error", error: (e as Error).message });
    return;
  }

  const base = {
    vault: v.symbol,
    strategy: v.strategyId,
    hf: state.hf,
    min_hf: state.minHf,
    orange_hf: state.orangeHf,
    has_debt: state.hasDebt,
    config_source: state.configSource,
  };

  // HF in the orange zone with debt outstanding — unwind. This side is the
  // urgent one and always takes precedence.
  if (state.hasDebt && state.hf < state.orangeHf) {
    if (!EXECUTE) {
      const sim = await simulateKeeperCall(v, "rebalance_keeper", SIM_ACCOUNT);
      logEvidence({ ...base, action: "dry_run", would_rebalance: true, sim_ok: sim.ok, sim_error: sim.error ?? null });
      return;
    }

    const res = await executeKeeperCall(v, "rebalance_keeper", keeper!);
    let afterHf: number | null = null;
    try {
      afterHf = (await readVaultState(v)).hf;
    } catch {
      // best-effort post-read; the on-chain event remains the source of truth
    }
    logEvidence({
      ...base,
      action: "rebalance",
      before_hf: state.hf,
      after_hf: afterHf,
      loops_unwound: res.result,
      tx: res.tx,
      status: res.status,
    });
    return;
  }

  // Nothing to unwind. Is there leverage to put back? Ask the contract rather
  // than deciding here: it owns the target (design leverage, floored clear of
  // the rebalance band), the cooldown and the safety checks, and a simulated
  // `0` is the authoritative "nothing to do".
  if (!state.hasCollateral) {
    logEvidence({ ...base, action: "skip", reason: "no_position" });
    return;
  }

  const sim = await simulateKeeperCall(v, "releverage", EXECUTE ? keeper!.publicKey() : SIM_ACCOUNT);
  if (!sim.ok) {
    // Expected and harmless in steady state: `DeadlineExpired` inside the
    // re-leverage cooldown, or a pre-M-3 deployment with no such entrypoint.
    logEvidence({ ...base, action: "skip", reason: "releverage_unavailable", sim_error: sim.error ?? null });
    return;
  }
  if (!sim.result) {
    logEvidence({ ...base, action: "skip", reason: "hf_at_or_above_target" });
    return;
  }

  if (!EXECUTE) {
    logEvidence({ ...base, action: "dry_run", would_releverage: true, would_borrow: sim.result });
    return;
  }

  const res = await executeKeeperCall(v, "releverage", keeper!);
  let afterHf: number | null = null;
  try {
    afterHf = (await readVaultState(v)).hf;
  } catch {
    // best-effort post-read; the on-chain event remains the source of truth
  }
  logEvidence({
    ...base,
    action: "releverage",
    before_hf: state.hf,
    after_hf: afterHf,
    borrowed: res.result,
    tx: res.tx,
    status: res.status,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function pass(vaults: Vault[]): Promise<void> {
  for (const v of vaults) {
    try {
      await processVault(v);
    } catch (e) {
      logEvidence({ vault: v.symbol, strategy: v.strategyId, action: "error", error: (e as Error).message });
    }
  }
}

async function main(): Promise<void> {
  const vaults = loadVaults();
  console.log(
    `rebalance_keeper — network=${NETWORK} mode=${EXECUTE ? "EXECUTE" : "DRY-RUN"}${LOOP ? ` loop=${INTERVAL_S}s` : ""} vaults=${vaults.map((v) => v.symbol).join(",")}${keeper ? ` keeper=${keeper.publicKey()}` : ""}`,
  );
  await pass(vaults);
  while (LOOP) {
    await new Promise((r) => setTimeout(r, INTERVAL_S * 1_000));
    await pass(vaults);
  }
}

main().catch((e) => {
  console.error("rebalance_keeper failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
