/**
 * Dashboard screen — wires the ts-port renderDashboard to real on-chain data.
 * Groups positions by POOL ACCOUNT (one card, one account-wide Account Health
 * via aggregatePoolAccount / PR #295) and lists vault holdings separately.
 */
import { el } from "../ui";
import {
  renderDashboard,
  type DashboardData,
  type PoolAccount,
  type Leg,
  type Role,
} from "./dashboard";
import {
  getKnownPools,
  fetchAllReserves,
  fetchUserPositions,
  aggregatePoolAccount,
  type AssetPosition,
} from "../blend";
import { getVaults, fetchVaultStats, fetchUserVaultBalance } from "../defindex";
import { getState, setState } from "../app/state";

function legsFromRows(
  rows: ReturnType<typeof aggregatePoolAccount>["rows"],
  priceBySymbol: Map<string, number>,
): Leg[] {
  return rows.map((r) => {
    const price = priceBySymbol.get(r.symbol) ?? 0;
    const role: Role = r.role === "loop" ? "Looped" : r.role === "collateral" ? "Collateral" : "Borrow";
    const amountUsd = (r.role === "borrow" ? r.borrowed : r.supplied) * price;
    const leg: Leg = { asset: r.symbol, assetId: r.assetId, role, amountUsd };
    if (r.role === "loop") leg.loopX = r.leverage;
    return leg;
  });
}

/** Fetch every pool account + vault holding for the connected wallet → DashboardData. */
export async function loadDashboardData(addr: string): Promise<DashboardData> {
  const poolAccounts: PoolAccount[] = [];

  await Promise.all(
    getKnownPools().map(async (pool) => {
      try {
        const reserves = await fetchAllReserves(pool, addr);
        const pos = await fetchUserPositions(pool, addr, reserves);
        const active: AssetPosition[] = [...pos.byAsset.values()].filter(
          (p) => p.collateral > 0 || p.debt > 0,
        );
        if (!active.length) return;
        const agg = aggregatePoolAccount(active, reserves);
        const priceBySymbol = new Map(reserves.map((rs) => [rs.asset.symbol, rs.priceUsd]));
        poolAccounts.push({
          pool: pool.name,
          poolId: pool.id,
          legs: legsFromRows(agg.rows, priceBySymbol),
          equityUsd: agg.equityUsd,
          netApy: agg.netApy,
          accountHealth: agg.poolHF,
          collateralUsd: agg.collateralUsd,
          debtUsd: agg.debtUsd,
          effLeverage: agg.effLeverage,
          liqDays: agg.liqDays,
        });
      } catch (e) {
        console.warn(`Dashboard: pool ${pool.name} load failed`, e);
      }
    }),
  );

  const vaults: DashboardData["vaults"] = [];
  await Promise.all(
    getVaults().map(async (vault) => {
      if (!vault.vaultId) return;
      try {
        const [stats, userPos] = await Promise.all([
          fetchVaultStats(vault),
          fetchUserVaultBalance(vault, addr),
        ]);
        if (!userPos || userPos.underlyingValue <= 0) return;
        const share =
          stats && stats.totalShares > 0
            ? `${((userPos.shares / stats.totalShares) * 100).toFixed(2)}%`
            : "—";
        vaults.push({
          name: vault.name,
          equityUsd: userPos.underlyingValue,
          share,
          netApy: stats?.netApy ?? 0,
          strategyHealth: stats?.healthFactor ?? 0,
        });
      } catch (e) {
        console.warn(`Dashboard: vault ${vault.name} load failed`, e);
      }
    }),
  );

  return { connected: true, poolAccounts, vaults };
}

const handlers = {
  onNewPosition: () => setState({ view: "trade", tradeTarget: null }),
  onManagePool: (poolId: string | undefined, assetId: string | undefined) =>
    setState({ view: "trade", tradeTarget: poolId ? { poolId, assetId } : null }),
  onAddLeg: (poolId: string | undefined) =>
    setState({ view: "trade", tradeTarget: poolId ? { poolId } : null }),
  onGoVault: () => setState({ view: "vault" }),
};

/** Build the Dashboard view. Renders immediately; fills with live data async. */
export function dashboardScreen(): HTMLElement {
  const root = el("div");
  const addr = getState().userAddress;

  if (!addr) {
    root.replaceChildren(renderDashboard({ connected: false, poolAccounts: [], vaults: [] }, handlers));
    return root;
  }

  // Optimistic skeleton while fetching.
  root.replaceChildren(
    el("div", { style: "padding:48px 0;text-align:center;color:var(--tl-text-3);font-size:var(--tl-text-base)" }, [
      "Loading your positions…",
    ]),
  );
  void loadDashboardData(addr)
    .then((data) => root.replaceChildren(renderDashboard(data, handlers)))
    .catch((e) => {
      console.warn("Dashboard load failed", e);
      root.replaceChildren(renderDashboard({ connected: true, poolAccounts: [], vaults: [] }, handlers));
    });

  return root;
}
