---
sidebar_position: 5
---

# Frontend Integration

TurboLong frontend is a vanilla HTML/CSS/JavaScript application with no framework dependencies, optimized for Stellar wallet integration and real-time market data.

## Tech Stack

| Component   | Technology                                   | Purpose                           |
| ----------- | -------------------------------------------- | --------------------------------- |
| **Build**   | Vite                                         | Instant HMR, <1s reload           |
| **UI**      | Vanilla HTML + CSS                           | No dependency bloat               |
| **State**   | JavaScript event listeners                   | Client-side state                 |
| **Wallets** | StellarSDK + Freighter/xBull/Albedo adapters | Multi-wallet support              |
| **Data**    | Horizon API + Blend SDK                      | Real-time rates and history       |
| **Hosting** | Cloudflare Pages                             | Global CDN, automatic deployments |

## Project Structure

```
frontend/
├── index.html               # Main entry point
├── vite.config.ts          # Build config
├── tsconfig.json           # TypeScript config
├── package.json            # Dependencies
├── src/
│   ├── main.ts             # App bootstrap
│   ├── blend.ts            # Blend Protocol client
│   ├── defindex.ts         # Vault (DeFindex) client
│   ├── sessionReplay.ts    # Session replay (Cloudflare)
│   └── style.css           # Responsive CSS
└── public/
    └── _redirects          # Cloudflare routing
```

## Key Files

### `main.ts` — App Initialization

```typescript
import { initWalletConnector } from "./wallets";
import { fetchRates } from "./blend";
import { renderDashboard } from "./ui";

// On page load
window.addEventListener("DOMContentLoaded", async () => {
  // 1. Initialize wallet connection
  const wallet = await initWalletConnector();

  // 2. Fetch current rates
  const rates = await fetchRates();

  // 3. Render UI
  renderDashboard(rates, wallet);

  // 4. Set up polling for rate updates
  setInterval(async () => {
    const newRates = await fetchRates();
    updateDashboard(newRates);
  }, 5000); // Update every 5 seconds
});

// Handle position open
document.getElementById("open-btn").addEventListener("click", async () => {
  const amount = document.getElementById("amount").value;
  const leverage = document.getElementById("leverage").value;

  await openPosition(wallet, amount, leverage);
  renderDashboard(); // Refresh
});
```

### `blend.ts` — Protocol Client

```typescript
import { Address, Contract, xdr, nativeToScVal } from "@stellar/js-sdk";
import BlendPoolSDK from "blend-contract-sdk";

export async function fetchRates(pool: string) {
  const client = new BlendPoolSDK(HORIZON_RPC_URL);

  const reserve = await client.getReserve(USDC_CONTRACT);

  return {
    borrow_rate: reserve.borrow_rate,
    supply_rate: reserve.supply_rate,
    utilization: reserve.utilization,
    total_supplied: reserve.total_supplied,
    total_borrowed: reserve.total_borrowed,
    last_updated_at: Date.now(),
  };
}

export async function openPosition(
  wallet: StellarWallet,
  amount: string,
  leverage: number,
) {
  // 1. Build transaction
  const txBuilder = new TransactionBuilder({
    source: wallet.publicKey,
    baseFee: BASE_FEE,
    network: NETWORK,
  });

  // 2. Invoke leverage contract
  const contract = new Contract(LEVERAGE_CONTRACT);
  txBuilder.addOperation(
    contract.call("open_position", [
      wallet.publicKey,
      USDC_CONTRACT,
      nativeToScVal(amount * 1e6),
      nativeToScVal(leverage),
      ETHERFUSE_POOL,
    ]),
  );

  const tx = txBuilder.build();
  const xdrTx = tx.toEnvelope().toXDR("base64");

  // 3. Sign with wallet
  const signedTx = await wallet.signTransaction(xdrTx);

  // 4. Submit to Stellar
  const server = new Server(HORIZON_URL);
  const result = await server.submitTransaction(signedTx);

  console.log("Position opened!", result.id);
  return result;
}

export async function getPosition(positionId: number) {
  const contract = new Contract(LEVERAGE_CONTRACT);
  const result = await contract.call("get_position", [positionId]);

  return parsePosition(result);
}
```

### `defindex.ts` — Vault Automation

```typescript
import DefindexSDK from "defindex-sdk";

export async function getVaultInfo() {
  const client = new DefindexSDK(HORIZON_RPC_URL);

  const vaults = await client.getAllVaults();

  return vaults
    .filter((v) => v.underlying_asset === USDC_CONTRACT)
    .map((v) => ({
      id: v.id,
      name: v.name,
      apy: v.current_apy,
      tvl: v.total_value_locked,
      rebalance_frequency: v.rebalance_frequency,
      auto_delever_at_hf: v.auto_delever_threshold,
    }));
}

export async function depositToVault(
  wallet: StellarWallet,
  vault_id: string,
  amount: string,
) {
  // Similar flow to openPosition but targets vault contract
  // Vault automatically manages leverage and rebalancing
}
```

### `style.css` — Responsive Design

```css
/* Mobile-first, progressive enhancement */

:root {
  --primary: #2563eb;
  --danger: #dc2626;
  --success: #16a34a;
  --bg-light: #f3f4f6;
  --bg-dark: #1f2937;
  --text-light: #374151;
  --text-dark: #111827;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: var(--bg-dark);
    --text: var(--text-dark);
  }
}

.dashboard {
  display: grid;
  gap: 1rem;
  padding: 1rem;
  max-width: 1200px;
  margin: 0 auto;
}

.card {
  background: var(--bg-light);
  border-radius: 0.5rem;
  padding: 1rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.leverage-slider {
  width: 100%;
  height: 8px;
  border-radius: 5px;
  background: linear-gradient(90deg, #16a34a, #fbbf24, #dc2626);
  outline: none;
  -webkit-appearance: none;
}

.leverage-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--primary);
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

/* Health factor color coding */
.health-factor {
  font-size: 2rem;
  font-weight: bold;
}

.health-factor.safe {
  color: var(--success);
}

.health-factor.caution {
  color: #f59e0b; /* amber */
}

.health-factor.danger {
  color: var(--danger);
}

/* Responsive grid */
@media (min-width: 768px) {
  .dashboard {
    grid-template-columns: repeat(3, 1fr);
  }

  .card:first-child {
    grid-column: 1 / -1; /* Full width */
  }
}
```

## State Management Pattern

No external state library — we use Vanilla JavaScript with event-based updates:

```typescript
// Global app state
const state = {
  wallet: null,
  positions: [],
  rates: {},
  selectedAsset: "USDC",
  selectedPool: "etherfuse",
};

// Update state and re-render
function setState(newState: Partial<typeof state>) {
  Object.assign(state, newState);
  renderDashboard(); // Trigger re-render
}

// Example: Listen for rate updates
async function pollRates() {
  const rates = await fetchRates(state.selectedPool);
  setState({ rates });

  // Re-run HF calculations
  updateHealthFactors();
}

setInterval(pollRates, 5000);
```

## Wallet Integration

### Supported Wallets

| Wallet        | SDK                      | Status       |
| ------------- | ------------------------ | ------------ |
| **Freighter** | `@stellar/freighter-api` | ✅ Primary   |
| **xBull**     | `@xbull-wallet/sdk`      | ✅ Supported |
| **Albedo**    | `@albedo-link/sdk`       | ✅ Supported |
| **Lobstr**    | `@lobstr/vault-sdk`      | ✅ Supported |
| **Hana**      | `@hana-wallet/sdk`       | ✅ Supported |

### Connection Flow

```typescript
async function connectWallet() {
  // Try wallets in order of popularity
  for (const walletProvider of WALLET_PROVIDERS) {
    try {
      const wallet = await walletProvider.connect();
      state.wallet = wallet;
      return wallet;
    } catch (e) {
      // Wallet not installed, try next
    }
  }

  throw new Error(
    "No wallet detected. Install Freighter or compatible wallet.",
  );
}
```

## Performance Optimizations

### Code Splitting

```javascript
// Lazy-load features only when needed
const openVault = await import("./vault.js");
document.getElementById("vault-btn").addEventListener("click", async () => {
  await openVault.openVaultUI();
});
```

### Caching

```typescript
const rateCache = new Map();

async function fetchRates(pool: string) {
  const cacheKey = `rates:${pool}`;
  const cached = rateCache.get(cacheKey);

  // Return cached if <5 seconds old
  if (cached && Date.now() - cached.ts < 5000) {
    return cached.data;
  }

  const rates = await fetchRatesFromChain(pool);
  rateCache.set(cacheKey, { data: rates, ts: Date.now() });
  return rates;
}
```

### Asset Optimization

- **CSS:** Single file, inline critical styles
- **JS:** Minified, tree-shaken (via Vite)
- **Images:** Optimized SVGs or BASE64-encoded
- **Fonts:** System fonts only (no external font loads)

## Building & Deployment

### Build

```bash
cd frontend
npm run build
# Output: dist/

# Vite production optimizations:
# - Code splitting
# - Tree shaking
# - Minification
# - Source map generation
```

### Deploy to Cloudflare Pages

```bash
# Automatic via GitHub Actions on push to main
# Or manual:
wrangler pages deploy dist/
```

### Environment Variables

```bash
# .env
VITE_RPC_URL=https://stellar-rpc.publicnode.com
VITE_LEVERAGE_CONTRACT=CA...
VITE_ETHERFUSE_POOL=C...
VITE_NETWORK=public  # or testnet
```

## Testing

### Unit Tests (Vitest)

```typescript
import { describe, it, expect } from "vitest";
import { calculateHF } from "./blend";

describe("Health Factor Calculation", () => {
  it("should calculate HF correctly", () => {
    const hf = calculateHF(1000, 900, 0.95);
    expect(hf).toBeCloseTo(1.0556, 3);
  });
});
```

### E2E Tests (Playwright)

```typescript
import { test, expect } from "@playwright/test";

test("Open position flow", async ({ page }) => {
  await page.goto("http://localhost:5173");

  // Connect wallet
  await page.click('button:has-text("Connect Wallet")');
  // ... simulate wallet popup

  // Fill position form
  await page.fill('[name="amount"]', "100");
  await page.fill('[name="leverage"]', "10");

  // Submit
  await page.click('button:has-text("Open Position")');

  // Wait for success
  await expect(page.locator("text=Position opened!")).toBeVisible();
});
```

## Browser Support

- **Chrome/Edge:** Latest 2 versions
- **Firefox:** Latest 2 versions
- **Safari:** Latest 2 versions
- **Mobile:** iOS Safari 13+, Chrome Android

(Soroban SDK requires ES2020 support)

## See Also

- [Architecture Overview](overview.md)
- [Smart Contracts](contracts.md)
- [Security Reports](../security/vulnerability-reports.md)
