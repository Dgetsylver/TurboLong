import './style.css';
import {
  Contract, Address, Networks,
  Account, BASE_FEE, TransactionBuilder,
  rpc as SorobanRpc, scValToNative, nativeToScVal,
} from "@stellar/stellar-sdk";

// ── Config ───────────────────────────────────────────────────────────────────

const STATS_API = "https://turbolong-alerts.workers.dev/stats";
const RPC_URL   = "https://soroban-rpc.creit.tech/";
const PASSPHRASE = Networks.PUBLIC;
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 min

const server = new SorobanRpc.Server(RPC_URL);

// Mainnet pools (Etherfuse + Fixed)
const POOLS = [
  {
    id:        "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
    name:      "Etherfuse",
    oracleId:  "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS",
    oracleDec: 1e14,
    assets: [
      { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM",     name: "Stellar Lumens" },
      { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC",    name: "USD Coin" },
      { id: "CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV", symbol: "CETES",   name: "CETES" },
      { id: "CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR", symbol: "USTRY",   name: "US Treasury" },
    ],
  },
  {
    id:        "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD",
    name:      "Fixed",
    oracleId:  "CCVTVW2CVA7JLH4ROQGP3CU4T3EXVCK66AZGSM4MUQPXAI4QHCZPOATS",
    oracleDec: 1e7,
    assets: [
      { id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", symbol: "XLM",  name: "Stellar Lumens" },
      { id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", symbol: "USDC", name: "USD Coin" },
      { id: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", symbol: "EURC", name: "Euro Coin" },
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(v: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
}

function fmtNum(v: number): string {
  return new Intl.NumberFormat("en-US").format(v);
}

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function setVal(id: string, val: string, animate = true): void {
  const e = el(id);
  if (!e) return;
  e.textContent = val;
  if (animate) {
    e.classList.remove("fade-in");
    void e.offsetWidth; // force reflow
    e.classList.add("fade-in");
  }
}

// ── On-chain RPC fetch ────────────────────────────────────────────────────────

async function simulate(contractId: string, method: string, args: ReturnType<typeof nativeToScVal>[]): Promise<unknown> {
  try {
    const acc = new Account(NULL_ACCOUNT, "0");
    const contract = new Contract(contractId);
    const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
      .addOperation(contract.call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (!SorobanRpc.Api.isSimulationSuccess(sim)) return null;
    return scValToNative(sim.result!.retval);
  } catch {
    return null;
  }
}

interface AssetStats {
  symbol: string;
  name: string;
  pool: string;
  tvlUsd: number;
  netSupplyApr: number;
}

async function fetchOnChain(): Promise<{ tvl: number; assets: AssetStats[] }> {
  const RATE_DEC = 1_000_000_000_000n;
  const SCALAR   = 10_000_000;

  const seen = new Set<string>();
  const results: AssetStats[] = [];
  let totalTvl = 0;

  for (const pool of POOLS) {
    const oracle = new Contract(pool.oracleId);

    for (const asset of pool.assets) {
      const key = `${pool.id}:${asset.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const [reserveRaw, priceRaw] = await Promise.all([
          simulate(pool.id, "get_reserve", [new Address(asset.id).toScVal()]),
          simulate(pool.oracleId, "lastprice", [
            // oracle Asset::Stellar(addr) variant
            (() => {
              const _ = oracle; // keep import used
              return nativeToScVal(["Stellar", asset.id], { type: "vec" });
            })(),
          ]),
        ]);

        if (!reserveRaw) continue;

        const rv = reserveRaw as Record<string, Record<string, unknown>>;
        const bRate   = BigInt(rv.data?.b_rate as string ?? "1000000000000");
        const dRate   = BigInt(rv.data?.d_rate as string ?? "1000000000000");
        const bSupply = BigInt(rv.data?.b_supply as string ?? "0");
        const dSupply = BigInt(rv.data?.d_supply as string ?? "0");

        const totalSupply = Number(bSupply * bRate / RATE_DEC) / SCALAR;
        const totalBorrow = Number(dSupply * dRate / RATE_DEC) / SCALAR;

        const pv = priceRaw as Record<string, unknown> | null;
        const priceUsd = pv?.price != null ? Number(BigInt(pv.price as string)) / pool.oracleDec : 0;

        const util = totalSupply > 0 ? totalBorrow / totalSupply : 0;
        const backstop = 0.2;
        const interestSupplyApr = util * (1 - backstop) * 4.5; // simple linear approx

        const assetTvl = totalSupply * priceUsd;
        totalTvl += assetTvl;

        results.push({ symbol: asset.symbol, name: asset.name, pool: pool.name, tvlUsd: assetTvl, netSupplyApr: interestSupplyApr });
      } catch {
        // skip failed assets silently
      }
    }
  }

  results.sort((a, b) => b.tvlUsd - a.tvlUsd);
  return { tvl: totalTvl, assets: results };
}

// ── D1 / Worker API fetch ────────────────────────────────────────────────────

interface StatsResponse {
  ok: boolean;
  tvl: number;
  volume24h: number;
  avgLeverage: number;
  activeUsers: number;
  updatedAt: string | null;
  topAssets: { asset_symbol: string; pool_name: string; tvl_usd: number; net_supply_apr: number }[];
}

async function fetchWorkerStats(): Promise<StatsResponse | null> {
  try {
    const res = await fetch(STATS_API, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json() as StatsResponse;
  } catch {
    return null;
  }
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderAssets(assets: { symbol: string; name?: string; pool?: string; tvlUsd?: number; netSupplyApr?: number; tvl_usd?: number; net_supply_apr?: number; pool_name?: string; asset_symbol?: string }[]): void {
  const listEl = el("top-assets-list");
  if (!listEl) return;

  if (!assets.length) {
    listEl.innerHTML = `<div class="loading-state">No on-chain data available yet.</div>`;
    return;
  }

  listEl.innerHTML = assets.slice(0, 8).map((a, i) => {
    const symbol = a.symbol ?? a.asset_symbol ?? "?";
    const name   = a.name ?? a.pool_name ?? "";
    const tvl    = a.tvlUsd ?? a.tvl_usd ?? 0;
    const apr    = a.netSupplyApr ?? a.net_supply_apr ?? 0;
    const colors = ["#2DE8A3", "#6366f1", "#f59e0b", "#ef4444", "#3b82f6", "#8b5cf6", "#10b981", "#f97316"];
    return `
      <div class="asset-item fade-in" style="animation-delay:${i * 60}ms">
        <div class="asset-left">
          <div class="asset-icon" style="background:${colors[i % colors.length]}22;color:${colors[i % colors.length]}">${symbol[0]}</div>
          <div class="asset-info">
            <span class="asset-symbol">${symbol}</span>
            <span class="asset-name">${name}</span>
          </div>
        </div>
        <div class="asset-right">
          <div class="asset-tvl">${tvl > 0 ? fmt(tvl) : "—"}</div>
          <div class="asset-apr">${apr > 0 ? apr.toFixed(2) + "% APY" : "—"}</div>
        </div>
      </div>`;
  }).join("");
}

async function updateDashboard(): Promise<void> {
  // Try worker API first (has D1 user count + cached TVL)
  const workerData = await fetchWorkerStats();

  if (workerData?.ok) {
    setVal("users-value",   fmtNum(workerData.activeUsers));
    setVal("leverage-value", workerData.avgLeverage > 0 ? workerData.avgLeverage.toFixed(1) + "×" : "—");
    setVal("volume-value",   workerData.volume24h > 0 ? fmt(workerData.volume24h) : "—");

    if (workerData.topAssets.length > 0) {
      setVal("tvl-value", fmt(workerData.tvl));
      renderAssets(workerData.topAssets);
      return;
    }
  } else {
    // D1 unavailable — show placeholder for off-chain metrics
    setVal("users-value",    "—");
    setVal("leverage-value", "—");
    setVal("volume-value",   "—");
  }

  // Fall through to live on-chain RPC for TVL + top assets
  el("top-assets-list").innerHTML = `<div class="loading-state">Querying Soroban RPC…</div>`;
  const { tvl, assets } = await fetchOnChain();
  setVal("tvl-value", tvl > 0 ? fmt(tvl) : "—");
  renderAssets(assets);
}

// ── Countdown timer ───────────────────────────────────────────────────────────

function startRefreshTimer(): void {
  const countEl = el("next-refresh");
  if (!countEl) return;

  let secondsLeft = REFRESH_INTERVAL_MS / 1000;

  const tick = (): void => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      secondsLeft = REFRESH_INTERVAL_MS / 1000;
      updateDashboard();
    }
    const m = Math.floor(secondsLeft / 60).toString().padStart(2, "0");
    const s = (secondsLeft % 60).toString().padStart(2, "0");
    countEl.textContent = `Refreshing in ${m}:${s}`;
  };

  setInterval(tick, 1000);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

updateDashboard();
startRefreshTimer();
