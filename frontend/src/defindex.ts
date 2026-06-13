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
  harvestApy: number | null; // Realized harvest APY from BLND swaps
  supplyApr: number | null;
  borrowApr: number | null;
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
    const healthFactor = hfRaw > 1e15 ? Number.POSITIVE_INFINITY : hfRaw / 1e7;

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

    // Fetch realized harvest APY (30-day lookback)
    const harvestApy = await fetchHarvestApy(vault, totalEquity);

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
      harvestApy,
      supplyApr,
      borrowApr,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch and annualize realized harvest revenue from on-chain logs.
 * Looks back 30 days.
 */
async function fetchHarvestApy(
  vault: VaultConfig,
  currentEquity: number
): Promise<number | null> {
  if (!vault.vaultId || currentEquity <= 0) return 0;

  try {
    // 1. Get current ledger to compute start point
    const latest = await blendServer.getLatestLedger();
    const curSeq = latest.sequence;

    // 2. Compute start ledger (~5s per ledger, 30 days = 518,400 ledgers)
    const LOOKBACK_LEDGERS = 518400;
    const startLedger = Math.max(1, curSeq - LOOKBACK_LEDGERS);

    // 3. Fetch events with topic "harvest_realized"
    const topicRealized = xdr.ScVal.scvSymbol("harvest_realized").toXDR("base64");

    const result = await blendServer.getEvents({
      startLedger,
      filters: [
        {
          type: "contract",
          contractIds: [vault.vaultId],
          topics: [[topicRealized]],
        },
      ],
    });

    let totalRealized = 0;
    for (const event of result.events) {
      const val = scValToNative(event.value);
      totalRealized += Number(val);
    }

    // 4. Annualize: (total_30d / current_equity) * (365 / 30)
    const scalar = 10 ** vault.decimals;
    const realizedUnderlying = totalRealized / scalar;
    const apy = (realizedUnderlying / currentEquity) * (365 / 30);

    return apy;
  } catch (e) {
    console.warn(`fetchHarvestApy: failed for ${vault.name}:`, e);
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
  decimals = 7,
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
  if (!Number.isFinite(hf) || hf > 100) return { text: "\u221e", cls: "hf-ok" };
  const text = hf.toFixed(4);
  if (hf >= 1.5) return { text, cls: "hf-ok" };
  if (hf >= 1.1) return { text, cls: "hf-warn" };
  return { text, cls: "hf-bad" };
}
