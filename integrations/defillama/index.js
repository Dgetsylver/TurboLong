/**
 * Turbolong DefiLlama TVL Adapter
 *
 * Measures TVL locked in Turbolong's DeFindex leveraged-yield vaults on Stellar.
 * Each vault holds user deposits as collateral in a Blend Protocol supply/borrow
 * loop. TVL = total collateral supplied to Blend by the strategy contract
 * (gross collateral, not net equity), which represents the full value of assets
 * the protocol is responsible for.
 *
 * Methodology: sum of collateral balances held by each Turbolong strategy
 * contract inside the corresponding Blend pool, denominated in the underlying
 * asset (USDC). Borrowed amounts are reported separately under `borrowed`.
 */

const { get } = require("../helper/http");

// Stellar Soroban RPC endpoint (public mainnet)
const SOROBAN_RPC = "https://mainnet.stellar.validationcloud.io/v1/soroban/rpc";

// Blend pool contract IDs that Turbolong strategies use
const POOLS = [
  {
    poolId: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI", // Etherfuse
    strategyId: "", // TODO: set after mainnet deployment
    assetId: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", // USDC
    assetSymbol: "USDC",
    decimals: 7,
    cgId: "usd-coin",
  },
];

/**
 * Call a Soroban contract view function via JSON-RPC simulateTransaction.
 * Returns the decoded i128 value (as a JS number, safe for TVL amounts).
 */
async function sorobanCall(contractId, method, args = []) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "simulateTransaction",
    params: {
      transaction: buildInvokeXdr(contractId, method, args),
    },
  };
  const res = await get(SOROBAN_RPC, { method: "POST", body: JSON.stringify(body) });
  if (res.error) throw new Error(`Soroban RPC error: ${JSON.stringify(res.error)}`);
  // Parse the first result entry's xdr value
  const xdrVal = res.result?.results?.[0]?.xdr;
  if (!xdrVal) return 0;
  return decodeI128Xdr(xdrVal);
}

/**
 * Minimal XDR builder for a no-auth read-only contract invocation.
 * Uses the Stellar SDK's base64 XDR format expected by simulateTransaction.
 * For a production adapter, use @stellar/stellar-sdk to build proper XDR.
 * Here we use the Blend pool's HTTP API instead (simpler, no XDR needed).
 */
function buildInvokeXdr(_contractId, _method, _args) {
  // Placeholder — actual XDR construction requires @stellar/stellar-sdk.
  // The tvl() function below uses the Blend HTTP API instead.
  return "";
}

function decodeI128Xdr(_xdr) {
  // Placeholder — actual decoding requires @stellar/stellar-sdk.
  return 0;
}

/**
 * Fetch pool reserve data from the Blend Protocol public API.
 * Returns { collateral, borrowed } in the underlying asset's native units.
 */
async function fetchStrategyPosition(pool) {
  if (!pool.strategyId) return { collateral: 0, borrowed: 0 };

  // Blend exposes pool positions via its public REST API
  const url = `https://api.blend.capital/v1/pool/${pool.poolId}/positions/${pool.strategyId}`;
  try {
    const data = await get(url);
    // data.positions is an array of { asset, collateral, liability }
    const pos = (data.positions ?? []).find((p) => p.asset === pool.assetId);
    if (!pos) return { collateral: 0, borrowed: 0 };
    const scale = 10 ** pool.decimals;
    return {
      collateral: Number(pos.collateral ?? 0) / scale,
      borrowed: Number(pos.liability ?? 0) / scale,
    };
  } catch {
    return { collateral: 0, borrowed: 0 };
  }
}

async function tvl() {
  const balances = {};
  for (const pool of POOLS) {
    const { collateral } = await fetchStrategyPosition(pool);
    if (collateral > 0) {
      const key = `coingecko:${pool.cgId}`;
      balances[key] = (balances[key] ?? 0) + collateral;
    }
  }
  return balances;
}

async function borrowed() {
  const balances = {};
  for (const pool of POOLS) {
    const { borrowed: debt } = await fetchStrategyPosition(pool);
    if (debt > 0) {
      const key = `coingecko:${pool.cgId}`;
      balances[key] = (balances[key] ?? 0) + debt;
    }
  }
  return balances;
}

module.exports = {
  timetravel: false,
  misrepresentedTokens: false,
  methodology:
    "TVL counts the total collateral deposited by Turbolong strategy contracts " +
    "into Blend Protocol pools on Stellar. Each strategy runs a leveraged USDC " +
    "supply/borrow loop; TVL reflects gross collateral (not net equity). " +
    "Borrowed amounts are reported separately.",
  stellar: {
    tvl,
    borrowed,
  },
};
