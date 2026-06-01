/**
 * DeFindex Vault interaction helpers.
 *
 * Wraps the DeFindex vault contract (Soroban) for the leverage strategy.
 * Uses the same RPC and wallet signing patterns as blend.ts.
 */

import {
  Contract,
  TransactionBuilder,
  Account,
  rpc as SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

import {
  server as blendServer,
  getNetworkPassphrase,
  getActiveNetwork,
  fetchAllReserves,
  type ReserveStats,
} from "./blend.ts";

// ── Vault configuration ──────────────────────────────────────────────────────

export interface VaultConfig {
  /** Strategy contract address */
  vaultId: string;
  /** Underlying asset contract address (e.g. USDC) */
  assetId: string;
  /** Blend pool contract address (for APR lookups) */
  poolId: string;
  /** Human-readable name */
  name: string;
  /** Asset symbol (e.g. "USDC") */
  assetSymbol: string;
  /** Asset decimals */
  decimals: number;
  /** Strategy c_factor (1e7 scaled) */
  cFactor: number;
  /** Number of leverage loops */
  targetLoops: number;
  /** Minimum HF before rebalance triggers (1e7 scaled) */
  minHf: number;
}

const MAINNET_VAULTS: VaultConfig[] = [
  {
    vaultId: "", // TODO: set after mainnet deployment
    assetId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // USDC
    poolId: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
    name: "Leveraged USDC (Etherfuse)",
    assetSymbol: "USDC",
    decimals: 7,
    cFactor: 0.90,
    targetLoops: 3,
    minHf: 1.05,
  },
];

const TESTNET_VAULTS: VaultConfig[] = [
  {
    vaultId: "CDOETIUHCETALQMBMYUXGFJFA34KDTV74AMHTWXJLY2XUVNZ23JDLJZA",
    assetId: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", // USDC
    poolId: "CAPBMXIQTICKWFPWFDJWMAKBXBPJZUKLNONQH3MLPLLBKQ643CYN5PRW",
    name: "Leveraged USDC (Testnet)",
    assetSymbol: "USDC",
    decimals: 7,
    cFactor: 0.90,
    targetLoops: 3,
    minHf: 1.05,
  },
];

export function getVaults(): VaultConfig[] {
  return getActiveNetwork() === "testnet" ? TESTNET_VAULTS : MAINNET_VAULTS;
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface VaultStats {
  totalEquity: number;     // Total vault equity in underlying terms
  totalShares: number;     // Total dfToken shares outstanding
  sharePrice: number;      // Price per share in underlying
  bTokens: bigint;         // Strategy b-tokens
  dTokens: bigint;         // Strategy d-tokens
  bRate: bigint;
  dRate: bigint;
  healthFactor: number;    // Strategy HF (1e7 scaled → float)
  collateralValue: number; // b_tokens * b_rate in underlying
  debtValue: number;       // d_tokens * d_rate in underlying
  leverage: number;        // collateralValue / equity
  netApy: number | null;   // Estimated leveraged APY (null if unavailable)
  supplyApr: number | null;
  borrowApr: number | null;
  // Realized harvest annualized APR (derived from on-chain harvest events)
  realizedHarvestApy?: number; // expressed as APR percent (e.g. 1.23 => 1.23%)
  realizedHarvest30d?: number; // sum of underlying realized in last 30 days (units = underlying)
}

export interface UserVaultPosition {
  shares: number;          // User's dfToken balance
  underlyingValue: number; // Current value in underlying
  vault: VaultConfig;
}

// ── RPC helpers ──────────────────────────────────────────────────────────────

async function invokeRead(contractId: string, method: string, args: xdr.ScVal[] = []): Promise<xdr.ScVal> {
  const account = new Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "0"
  );

  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Simulation failed`);
  }
  return sim.result!.retval;
}

// ── Vault queries ────────────────────────────────────────────────────────────

/**
 * Fetch vault stats from the strategy contract's `position()` method.
 * Optionally enriches with pool APR data for net APY calculation.
 */
export async function fetchVaultStats(
  vault: VaultConfig,
  poolReserves?: ReserveStats[]
): Promise<VaultStats | null> {
  if (!vault.vaultId) return null;

  try {
    const result = await invokeRead(vault.vaultId, "position");

    // position() returns (equity, total_shares, b_tokens, d_tokens, b_rate, d_rate)
    const tuple = result.value() as xdr.ScVal[];
    const scalar = 10 ** vault.decimals;

    const totalEquity = Number(scValToNative(tuple[0])) / scalar;
    const totalShares = Number(scValToNative(tuple[1]));
    const bTokens = BigInt(scValToNative(tuple[2]).toString());
    const dTokens = BigInt(scValToNative(tuple[3]).toString());
    const bRate = BigInt(scValToNative(tuple[4]).toString());
    const dRate = BigInt(scValToNative(tuple[5]).toString());

    const sharePrice = totalShares > 0 ? totalEquity / (totalShares / scalar) : 1;

    // Compute collateral/debt in underlying
    const collateralValue = Number(bTokens * bRate / BigInt(1e12)) / scalar;
    const debtValue = Number(dTokens * dRate / BigInt(1e12)) / scalar;
    const leverage = totalEquity > 0 ? collateralValue / totalEquity : 1;

    // Fetch HF
    const hfResult = await invokeRead(vault.vaultId, "health_factor");
    const hfRaw = Number(scValToNative(hfResult));
    const healthFactor = hfRaw > 1e15 ? Infinity : hfRaw / 1e7;

    // Compute leveraged net APY from pool reserve data
    let netApy: number | null = null;
    let supplyApr: number | null = null;
    let borrowApr: number | null = null;

    if (poolReserves) {
      const assetReserve = poolReserves.find(r => r.asset.id === vault.assetId);
      if (assetReserve) {
        supplyApr = assetReserve.netSupplyApr;
        borrowApr = assetReserve.netBorrowCost;
        // Net APY = supply_apr × leverage - borrow_apr × (leverage - 1)
        netApy = supplyApr * leverage - borrowApr * (leverage - 1);
      }
    }

    // Fetch realized harvest revenue from on-chain events (last 30 days)
    let realizedHarvestApy: number | undefined = undefined;
    let realizedHarvest30d: number | undefined = undefined;
    try {
      const res = await fetchHarvestRealized30d(vault, 30);
      realizedHarvest30d = res.sum30;
      if (realizedHarvest30d > 0 && totalEquity > 0) {
        const annualized = (realizedHarvest30d / totalEquity) * (365 / 30);
        // Keep same units as netApy (APR percent)
        realizedHarvestApy = annualized * 100;
      }
    } catch { /* ignore event failures */ }

    return {
      totalEquity,
      totalShares,
      sharePrice,
      bTokens,
      dTokens,
      bRate,
      dRate,
      healthFactor,
      collateralValue,
      debtValue,
      leverage,
      netApy,
      supplyApr,
      borrowApr,
      realizedHarvestApy,
      realizedHarvest30d,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a user's vault balance via the strategy's `balance()` method.
 */
export async function fetchUserVaultBalance(
  vault: VaultConfig,
  userAddress: string
): Promise<UserVaultPosition | null> {
  if (!vault.vaultId) return null;

  try {
    const addressVal = nativeToScVal(userAddress, { type: "address" });
    const result = await invokeRead(vault.vaultId, "balance", [addressVal]);
    const underlying = Number(scValToNative(result));
    const scalar = 10 ** vault.decimals;

    return {
      shares: underlying / scalar, // balance() returns underlying value
      underlyingValue: underlying / scalar,
      vault,
    };
  } catch {
    return null;
  }
}

// ── Transaction builders ─────────────────────────────────────────────────────

/**
 * Build a deposit transaction XDR for the vault.
 */
export async function buildVaultDepositXdr(
  vault: VaultConfig,
  userAddress: string,
  amount: number
): Promise<string> {
  const scalar = 10 ** vault.decimals;
  const amountStroops = BigInt(Math.round(amount * scalar));

  const account = await blendServer.getAccount(userAddress);
  const contract = new Contract(vault.vaultId);

  const tx = new TransactionBuilder(account, {
    fee: "10000000", // 1 XLM fee budget for complex tx
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      contract.call(
        "deposit",
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(userAddress, { type: "address" })
      )
    )
    .setTimeout(300)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const errDetail = 'error' in sim ? JSON.stringify((sim as any).error).slice(0, 300) : 'unknown';
    throw new Error(`Deposit simulation failed: ${errDetail}`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

/**
 * Build a withdraw transaction XDR for the vault.
 */
export async function buildVaultWithdrawXdr(
  vault: VaultConfig,
  userAddress: string,
  amount: number
): Promise<string> {
  const scalar = 10 ** vault.decimals;
  const amountStroops = BigInt(Math.round(amount * scalar));

  const account = await blendServer.getAccount(userAddress);
  const contract = new Contract(vault.vaultId);

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      contract.call(
        "withdraw",
        nativeToScVal(amountStroops, { type: "i128" }),
        nativeToScVal(userAddress, { type: "address" }),
        nativeToScVal(userAddress, { type: "address" }) // to = from
      )
    )
    .setTimeout(300)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    const errDetail = 'error' in sim ? JSON.stringify((sim as any).error).slice(0, 300) : 'unknown';
    throw new Error(`Withdraw simulation failed: ${errDetail}`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

/**
 * Build a rebalance transaction XDR.
 * Permissionless — callable by anyone when HF < min_hf.
 */
export async function buildVaultRebalanceXdr(
  vault: VaultConfig,
  userAddress: string,
): Promise<string> {
  const account = await blendServer.getAccount(userAddress);
  const contract = new Contract(vault.vaultId);

  const tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call("rebalance"))
    .setTimeout(300)
    .build();

  const sim = await blendServer.simulateTransaction(tx);
  if (!SorobanRpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Rebalance simulation failed — HF may already be healthy`);
  }

  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  return prepared.toXDR();
}

// ── Token balance helper ────────────────────────────────────────────────────

/**
 * Fetch a token balance using the same RPC path as vault queries.
 * Works around blend.ts fetchAssetBalance silently returning 0.
 */
export async function fetchTokenBalance(
  tokenContractId: string,
  userAddress: string,
  decimals: number = 7,
): Promise<number> {
  try {
    const addressVal = nativeToScVal(userAddress, { type: "address" });
    const result = await invokeRead(tokenContractId, "balance", [addressVal]);
    const raw = Number(scValToNative(result));
    return raw / (10 ** decimals);
  } catch {
    return 0;
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatUsd(n: number, decimals = 2): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatHf(hf: number): { text: string; cls: string } {
  if (!isFinite(hf) || hf > 100) return { text: "\u221e", cls: "hf-ok" };
  const text = hf.toFixed(4);
  if (hf >= 1.5) return { text, cls: "hf-ok" };
  if (hf >= 1.1) return { text, cls: "hf-warn" };
  return { text, cls: "hf-bad" };
}

// ── Harvest event helpers (on-chain realized revenue) ───────────────────────

function b64ToBytes(b64: string): Uint8Array {
  // browser-friendly atob
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch (e) {
    return new Uint8Array();
  }
}

function bytesToBigIntBE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < b.length; i++) {
    v = (v << 8n) + BigInt(b[i]);
  }
  // interpret as signed if high bit set
  if (b.length > 0 && (b[0] & 0x80) !== 0) {
    const bits = BigInt(b.length * 8);
    v = v - (1n << bits);
  }
  return v;
}

/**
 * Fetch harvest events for a vault and sum realized underlying over `days`.
 * Returns sum in underlying units (float) and raw count.
 */
export async function fetchHarvestRealized30d(vault: VaultConfig, days = 30): Promise<{ sum30: number; count: number }>
{
  try {
    const rpcBase = getActiveNetwork() === "testnet"
      ? "https://soroban-testnet.stellar.org"
      : "https://soroban-rpc.creit.tech";
    const url = rpcBase.replace(/\/$/, "") + "/soroban/events?contract_id=" + encodeURIComponent(vault.vaultId) + "&limit=1000";
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { sum30: 0, count: 0 };
    const data = await res.json();
    const events = data.events ?? [];
    const cutoff = Date.now() - days * 24 * 3600 * 1000;

    let sumRaw = 0n;
    let count = 0;
    for (const ev of events) {
      try {
        if (!ev.ledgerClosedAt) continue;
        const ts = Date.parse(ev.ledgerClosedAt);
        if (isNaN(ts) || ts < cutoff) continue;

        // Try to identify harvest-like topics: decode first topic and look for 'harv' or 'fee'
        const topics: string[] = ev.topic ?? [];
        if (!topics.length) continue;
        const t0 = topics[0];
        const t0Bytes = b64ToBytes(t0);
        const t0Text = new TextDecoder().decode(t0Bytes).toLowerCase();
        if (!(t0Text.includes("harv") || t0Text.includes("fee") || t0Text.includes("harvest"))) continue;

        // Decode value as big-endian i128/unsigned integer
        const vB64 = ev.value as string;
        if (!vB64) continue;
        const vb = b64ToBytes(vB64);
        if (vb.length === 0) continue;
        const vBig = bytesToBigIntBE(vb);

        sumRaw += vBig;
        count += 1;
      } catch (e) {
        // ignore parse errors for individual events
        continue;
      }
    }

    // Convert raw (assumed stroops with vault.decimals) to float underlying
    const scalar = BigInt(10) ** BigInt(vault.decimals);
    const sum30 = Number(sumRaw) / Number(scalar || 1n);
    return { sum30, count };
  } catch (e) {
    return { sum30: 0, count: 0 };
  }
}

