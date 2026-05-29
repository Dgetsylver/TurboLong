---
sidebar_position: 1
---

# Architecture Overview

TurboLong is built as a composable stack on top of Stellar's Blend Protocol, with three main layers:

## Layer 1: Smart Contracts (Soroban)

**Language:** Rust (Soroban SDK v25)

### Leverage Strategy Contract

Located in [`contracts/strategies/blend_leverage/`](https://github.com/turbolong/turbolong/tree/main/contracts/strategies/blend_leverage)

**Purpose:** Execute atomic leverage loops — supply + N recursive borrows in a single transaction.

**Key modules:**

| Module                                    | Purpose                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| `lib.rs`                                  | Entry point; exposes `open_position`, `close_position`, `adjust_leverage` |
| `leverage.rs`                             | Core loop logic — iteratively borrow and re-supply                        |
| `blend_pool.rs`                           | Blend Protocol client — reads rates, manages positions                    |
| `soroswap.rs`                             | Optional asset swaps via SoroSwap (for xfer collateral types)             |
| `storage.rs`                              | Persistent state — position tracking, user accounting                     |
| `constants.rs`                            | Configuration — max loops, fee structure, liquidation thresholds          |
| `test_leverage.rs`, `test_integration.rs` | Comprehensive unit and integration tests                                  |

**Execution flow:**

```
User calls open_position(amount=1000 USDC, leverage=10x)
  ↓
Loop N times (where N ≈ 10):
  1. Transfer user_amount from wallet to contract
  2. Call blend_pool.supply(user_amount, as_collateral=true)
  3. Call blend_pool.borrow(user_amount × c_factor × 0.95)
  4. Re-supply borrowed amount as collateral
  ↓
Final state:
  Supplied: ~10,000 USDC
  Borrowed: ~9,000 USDC
  User collateral: 1,000 USDC
  Leverage: 10×
```

### Performance Characteristics

| Metric                   | Value                      |
| ------------------------ | -------------------------- |
| Bytes compiled           | ~120KB (optimized)         |
| Base cost (1× loop)      | ~1,500 stroops (~$0.00015) |
| Cost per additional loop | ~150 stroops each          |
| Total for 10× leverage   | ~$0.0015–0.002             |
| Execution time           | <1 second                  |

## Layer 2: Frontend (TypeScript/Vite)

**Location:** [`frontend/`](https://github.com/turbolong/turbolong/tree/main/frontend)

**Stack:**

- **UI Framework:** Vanilla HTML + CSS (no framework)
- **Build Tool:** Vite (sub-second HMR)
- **Wallet Integration:** StellarSDK + Freighter/xBull/Albedo adapters
- **State Management:** Vanilla JavaScript with event listeners

### Key Files

| File               | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `main.ts`          | App initialization, event routing                        |
| `blend.ts`         | Blend Protocol client — reads rates, builds transactions |
| `defindex.ts`      | DeFindex vault automation client                         |
| `sessionReplay.ts` | Optional session replay for debugging (Cloudflare)       |
| `style.css`        | Responsive CSS (mobile-first, no dependencies)           |

### User Flows

1. **Connect Wallet:** Use `StellarSDK` + wallet provider to obtain public key and transaction signing
2. **Fetch Rates:** Query Blend pools via `blend_pool_client` SDK
3. **Build Position:** Calculate leverage needed, assemble transaction
4. **Sign & Submit:** User signs with wallet, transaction broadcasts to Stellar
5. **Poll Results:** Watch for transaction confirmation on Stellar horizon

## Layer 3: Backend Services

### Alerts Service (Cloudflare Workers)

**Location:** [`alerts/`](https://github.com/turbolong/turbolong/tree/main/alerts)

**Purpose:** Monitor on-chain positions and email users when APY drops or HF risks liquidation.

**Stack:**

- **Runtime:** Cloudflare Workers (serverless)
- **Database:** Cloudflare D1 (SQLite)
- **Triggers:** Cron (polls every 5 minutes)

**Flow:**

```
Cron trigger (every 5 min)
  ↓
Query all subscribed positions from D1
  ↓
For each position:
  - Fetch current rates from Blend via Stellar RPC
  - Check if APY dropped below user's threshold
  - Check if HF dropped below user's danger threshold
  ↓
Send email alerts for triggered conditions
```

**Schema** (`schema.sql`):

```sql
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  pool TEXT NOT NULL,
  asset TEXT NOT NULL,
  apy_threshold REAL,
  hf_threshold REAL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### Scripts & Utilities

**Location:** [`scripts/`](https://github.com/turbolong/turbolong/tree/main/scripts)

| Script               | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `deploy_strategy.ts` | Deploy the leverage contract to Stellar       |
| `test_strategy.ts`   | Test the contract on testnet                  |
| `debug_blnd.ts`      | Debug script — print pool state and rates     |
| `get_oracle.ts`      | Fetch current oracle prices                   |
| `identify_tokens.ts` | Identify token contracts from USDC/XLM spread |

## Data Flow Diagram

```
┌─────────────────┐
│   User Wallet   │
└────────┬────────┘
         │
         │ (signs transaction)
         ▼
┌──────────────────────────────┐
│   TurboLong Frontend (Vite)   │
│  ┌──────────────────────────┐ │
│  │ blend.ts (rate fetching) │ │
│  │ main.ts (UI state)       │ │
│  └──────────────────────────┘ │
└────────┬───────────────────────┘
         │
         │ (broadcasts XDR transaction)
         ▼
┌──────────────────────────────┐
│  Stellar Blockchain (Testnet │
│        or Mainnet)           │
│  ┌──────────────────────────┐ │
│  │ Soroban Smart Contracts  │ │
│  │  - Leverage Strategy     │ │
│  │  - Blend Pool (invoked)  │ │
│  └──────────────────────────┘ │
└────────┬───────────────────────┘
         │
         │ (transaction confirmation)
         ▼
┌──────────────────────────────┐
│  Alerts Service              │
│  (Cloudflare Workers + D1)   │
│  ┌──────────────────────────┐ │
│  │ stellar.ts (XDR decode)  │ │
│  │ index.ts (polling loop)  │ │
│  └──────────────────────────┘ │
└────────┬───────────────────────┘
         │
         │ (emails user on alerts)
         ▼
┌─────────────────┐
│  User's Email   │
└─────────────────┘
```

## Deployment Topology

### Testnet

- **Contracts:** Deployed to Stellar Testnet
- **Frontend:** Hosted at staging.turbolong.xyz (Cloudflare Pages)
- **Alerts:** Cloudflare Workers (staging environment)

### Mainnet

- **Contracts:** Deployed to Stellar Mainnet
- **Frontend:** Hosted at turbolong.xyz (Cloudflare Pages)
- **Alerts:** Cloudflare Workers (production environment)

## Security Considerations

### Smart Contract Risk

- **Leverage loops are atomic** — if any step fails, the entire transaction reverts
- **No reentrancy risk** — Soroban uses a different model than EVM contracts
- **Audited by:** [Audit company] — [Report link]

### Oracle Risk

- TurboLong uses **Blend Protocol's oracle adapters** for prices
- Blend uses **Reflector oracle feeds** with 5-minute resolution
- Circuit breakers prevent price movements >5% per update

### Liquidation Risk

- Positions can be liquidated if HF < 1.05
- Liquidation is **not automatic** — depends on liquidators monitoring the pool
- No "auto-liquidation" means a small window exists between HF<1.05 and actual liquidation

See [Security Reports](../security/vulnerability-reports.md) for detailed risk analysis.
