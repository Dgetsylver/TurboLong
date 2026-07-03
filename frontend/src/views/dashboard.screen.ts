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
  fetchPositionEvents,
  type AssetPosition,
  type PositionEvent,
} from "../blend";
import { getVaults, fetchVaultStats, fetchUserVaultBalance } from "../defindex";
import { getState, setState } from "../app/state";
import { toast } from "../app/chrome";

function legsFromRows(
  rows: ReturnType<typeof aggregatePoolAccount>["rows"],
  priceBySymbol: Map<string, number>,
): Leg[] {
  return rows.map((r) => {
    const price = priceBySymbol.get(r.symbol) ?? 0;
    const role: Role =
      r.role === "loop"
        ? "Looped"
        : r.role === "collateral"
          ? "Collateral"
          : "Borrow";
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
        const priceBySymbol = new Map(
          reserves.map((rs) => [rs.asset.symbol, rs.priceUsd]),
        );
        poolAccounts.push({
          pool: pool.name,
          poolId: pool.id,
          legs: legsFromRows(agg.rows, priceBySymbol),
          equityUsd: agg.equityUsd,
          netApy: agg.netApy,
          accountHealth: agg.poolHF,
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

interface ExportPayload {
  walletAddress: string;
  generatedAt: string;
  poolAccounts: Array<
    PoolAccount & { legs: Array<Leg & { events: PositionEvent[] }> }
  >;
  vaults: DashboardData["vaults"];
}

function formatShortAddress(addr: string): string {
  return addr.slice(0, 8);
}

function buildFilename(addr: string, ext: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `${formatShortAddress(addr)}_${date}.${ext}`;
}

function downloadText(
  content: string,
  mimeType: string,
  filename: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value).replace(/"/g, '""');
  return `"${s}"`;
}

function buildCsv(payload: ExportPayload): string {
  const headers = [
    "walletAddress",
    "generatedAt",
    "section",
    "pool",
    "poolId",
    "equityUsd",
    "netApy",
    "accountHealth",
    "legAsset",
    "legAssetId",
    "legRole",
    "legAmountUsd",
    "legLoopX",
    "eventKind",
    "eventHash",
    "eventTimestamp",
    "eventTimestampIso",
    "vaultName",
    "vaultShare",
    "vaultStrategyHealth",
  ];

  const rows = [headers.map(csvCell).join(",")];

  for (const pool of payload.poolAccounts) {
    for (const leg of pool.legs) {
      if (leg.events.length) {
        for (const event of leg.events) {
          rows.push(
            [
              payload.walletAddress,
              payload.generatedAt,
              "pool",
              pool.pool,
              pool.poolId ?? "",
              pool.equityUsd,
              pool.netApy,
              pool.accountHealth,
              leg.asset,
              leg.assetId ?? "",
              leg.role,
              leg.amountUsd,
              leg.loopX ?? "",
              event.kind,
              event.hash,
              event.timestamp,
              new Date(event.timestamp).toISOString(),
              "",
              "",
              "",
            ]
              .map(csvCell)
              .join(","),
          );
        }
      } else {
        rows.push(
          [
            payload.walletAddress,
            payload.generatedAt,
            "pool",
            pool.pool,
            pool.poolId ?? "",
            pool.equityUsd,
            pool.netApy,
            pool.accountHealth,
            leg.asset,
            leg.assetId ?? "",
            leg.role,
            leg.amountUsd,
            leg.loopX ?? "",
            "",
            "",
            "",
            "",
            "",
            "",
            "",
          ]
            .map(csvCell)
            .join(","),
        );
      }
    }
  }

  for (const vault of payload.vaults) {
    rows.push(
      [
        payload.walletAddress,
        payload.generatedAt,
        "vault",
        "",
        "",
        vault.equityUsd,
        vault.netApy,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        vault.name,
        vault.share,
        vault.strategyHealth,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return rows.join("\r\n");
}

async function buildExportPayload(
  data: DashboardData,
  addr: string,
): Promise<ExportPayload> {
  const poolsById = new Map(getKnownPools().map((pool) => [pool.id, pool]));
  const poolAccounts = await Promise.all(
    data.poolAccounts.map(async (account) => {
      const pool = account.poolId ? poolsById.get(account.poolId) : undefined;
      const legs = await Promise.all(
        account.legs.map(async (leg) => {
          const events =
            pool && leg.assetId
              ? await fetchPositionEvents(pool, addr, leg.assetId).catch(
                  () => [],
                )
              : [];
          return {
            ...leg,
            events: events.filter((event) => event.kind !== "harvest"),
          };
        }),
      );
      return { ...account, legs };
    }),
  );

  return {
    walletAddress: addr,
    generatedAt: new Date().toISOString(),
    poolAccounts,
    vaults: data.vaults,
  };
}

let latestDashboardData: DashboardData | null = null;

async function handleExport(type: "csv" | "json"): Promise<void> {
  const addr = getState().userAddress;
  if (!addr) {
    toast("Connect your wallet to export your dashboard data.", "error");
    return;
  }
  if (!latestDashboardData) {
    toast(
      "Dashboard data is still loading. Please wait and try again.",
      "error",
    );
    return;
  }

  try {
    const payload = await buildExportPayload(latestDashboardData, addr);
    if (type === "csv") {
      const csv = buildCsv(payload);
      downloadText(csv, "text/csv;charset=utf-8", buildFilename(addr, "csv"));
    } else {
      const json = JSON.stringify(payload, null, 2);
      downloadText(
        json,
        "application/json;charset=utf-8",
        buildFilename(addr, "json"),
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    toast(`Failed to export dashboard data: ${message}`, "error");
  }
}

const handlers = {
  onNewPosition: () => setState({ view: "trade", tradeTarget: null }),
  onExportCsv: () => void handleExport("csv"),
  onExportJson: () => void handleExport("json"),
  onManagePool: (poolId: string | undefined, assetId: string | undefined) =>
    setState({
      view: "trade",
      tradeTarget: poolId ? { poolId, assetId } : null,
    }),
  onAddLeg: (poolId: string | undefined) =>
    setState({ view: "trade", tradeTarget: poolId ? { poolId } : null }),
  onGoVault: () => setState({ view: "vault" }),
};

/** Build the Dashboard view. Renders immediately; fills with live data async. */
export function dashboardScreen(): HTMLElement {
  const root = el("div");
  const addr = getState().userAddress;

  if (!addr) {
    root.replaceChildren(
      renderDashboard(
        { connected: false, poolAccounts: [], vaults: [] },
        handlers,
      ),
    );
    return root;
  }

  latestDashboardData = null;
  // Optimistic skeleton while fetching.
  root.replaceChildren(
    el(
      "div",
      {
        style:
          "padding:48px 0;text-align:center;color:var(--tl-text-3);font-size:var(--tl-text-base)",
      },
      ["Loading your positions…"],
    ),
  );
  void loadDashboardData(addr)
    .then((data) => {
      latestDashboardData = data;
      root.replaceChildren(renderDashboard(data, handlers));
    })
    .catch((e) => {
      latestDashboardData = { connected: true, poolAccounts: [], vaults: [] };
      console.warn("Dashboard load failed", e);
      root.replaceChildren(renderDashboard(latestDashboardData, handlers));
    });

  return root;
}
