# Design Document: Trustline Auto-Setup on First Deposit

## Overview

When a user opens a leveraged position for the first time, their Stellar account may be missing trustlines for the pool's b_token, d_token, and BLND classic assets. Without these trustlines the on-chain transaction fails with a "no trustline" error. This feature detects missing trustlines before the deposit is submitted and prepends the necessary `changeTrust` operations to the same transaction envelope, so the user signs once and the deposit succeeds atomically.

The implementation touches two files:
- **`frontend/src/blend.ts`** — adds `getMissingTrustlines` and `prependTrustlineOps` exports
- **`frontend/src/main.ts`** — calls those helpers inside `openPosition()` before the submit step

---

## Components and Interfaces

### getMissingTrustlines (blend.ts)

Queries the pool contract for the reserve's b_token and d_token contract IDs, calls `symbol()` and `issuer()` on each to derive the classic `Asset`, adds the network's `blndClassic` asset, then loads the user's Horizon account to find which of those three assets lack a trustline. Returns a `MissingTrustlineResult` containing the list of missing assets and the current trustline count (for limit checking).

```typescript
export interface MissingTrustlineResult {
  /** Classic assets that need a trustline created. Empty = no-op. */
  missing: Asset[];
  /** Current number of non-native trustlines on the account. */
  currentCount: number;
}

export async function getMissingTrustlines(
  pool: PoolDef,
  userAddress: string,
  assetId: string,
): Promise<MissingTrustlineResult>
```

### prependTrustlineOps (blend.ts)

Deserialises the existing Soroban transaction XDR, prepends one `Operation.changeTrust` per missing asset (limit = Stellar max `"922337203685.4775807"`), rebuilds the transaction, and returns the new XDR. If `missingAssets` is empty it returns the original XDR unchanged.

```typescript
export async function prependTrustlineOps(
  submitXdr: string,
  missingAssets: Asset[],
  userAddress: string,
): Promise<string>
```

### openPosition (main.ts)

After building the approve XDR and before building the submit XDR, calls `getMissingTrustlines`. If the projected trustline count would exceed 1,000 it throws and shows a user-facing error. Otherwise it calls `prependTrustlineOps` on the submit XDR and passes the bundled result to `signAndSubmit`.

---

## Data Models

### MissingTrustlineResult

| Field | Type | Description |
|---|---|---|
| `missing` | `Asset[]` | Classic Stellar assets that need `changeTrust` ops. Empty when all trustlines exist. |
| `currentCount` | `number` | Number of non-native trustlines currently on the account. Used for limit check. |

### Trustline check key format

Existing trustlines are indexed as `"CODE:ISSUER"` strings built from Horizon balance records where `asset_type !== "native"`. This matches the format returned by `Asset.getCode()` and `Asset.getIssuer()`.

---

## Architecture

### Data Flow

```
openPosition() [main.ts]
  │
  ├─ buildApproveXdr()          ← unchanged (step 0)
  │
  ├─ getMissingTrustlines()     ← NEW (blend.ts)
  │     │
  │     ├─ get_reserve(assetId) → reserveRaw.config.b_token, .d_token
  │     ├─ b_token.symbol() + b_token.issuer()  → classic Asset
  │     ├─ d_token.symbol() + d_token.issuer()  → classic Asset
  │     ├─ cfg.blndClassic                       → BLND classic Asset
  │     ├─ horizon.loadAccount(userAddress)      → existing trustlines
  │     └─ returns MissingTrustlineResult
  │
  ├─ [if limit exceeded] → throw, abort
  │
  ├─ buildOpenPositionXdr()     ← unchanged (produces Soroban XDR)
  │
  ├─ prependTrustlineOps()      ← NEW (blend.ts)
  │     │
  │     ├─ TransactionBuilder.fromXDR(submitXdr)
  │     ├─ prepend changeTrust ops for each missing asset
  │     └─ returns new XDR string (or original if nothing missing)
  │
  └─ signAndSubmit(bundledXdr)  ← single wallet signature
```

---

## Implementation Details

### Deriving b_token and d_token classic assets

The Blend pool's `get_reserve` RPC call returns a `reserveRaw` object. Its `config` field contains `b_token` and `d_token` as Soroban contract IDs. Each is a Soroban-wrapped classic asset contract that exposes `symbol()` and `issuer()` entry points.

```typescript
const reserveRaw = await simulate(
  poolContract.call("get_reserve", new Address(assetId).toScVal())
);
const bTokenId: string = reserveRaw.config.b_token;
const dTokenId: string = reserveRaw.config.d_token;

const bSymbol: string = await simulate(new Contract(bTokenId).call("symbol"));
const bIssuer: string = await simulate(new Contract(bTokenId).call("issuer"));
const dSymbol: string = await simulate(new Contract(dTokenId).call("symbol"));
const dIssuer: string = await simulate(new Contract(dTokenId).call("issuer"));
```

**Note on XLM (native asset):** XLM does not require a trustline. If `bIssuer` or `dIssuer` is null/empty (indicating a native-wrapped token), that asset is skipped.

### Checking existing trustlines

```typescript
const acc = await horizon.loadAccount(userAddress);
const existing = new Set(
  acc.balances
    .filter((b: any) => b.asset_type !== "native")
    .map((b: any) => `${b.asset_code}:${b.asset_issuer}`)
);
const required = [bAsset, dAsset, _cfg.blndClassic].filter(a => !a.isNative());
const missing  = required.filter(a => !existing.has(`${a.getCode()}:${a.getIssuer()}`));
const currentCount = acc.balances.filter((b: any) => b.asset_type !== "native").length;
```

### Trustline limit check (main.ts)

```typescript
const STELLAR_TRUSTLINE_LIMIT = 1000;
const { missing, currentCount } = await getMissingTrustlines(selectedPool, userAddress, liveAsset.id);
if (currentCount + missing.length > STELLAR_TRUSTLINE_LIMIT) {
  throw new Error(
    `Adding ${missing.length} trustline(s) would exceed the Stellar limit of 1,000. ` +
    `You currently have ${currentCount}. Remove unused trustlines before depositing.`
  );
}
```

### Prepending changeTrust ops

```typescript
export async function prependTrustlineOps(
  submitXdr: string,
  missingAssets: Asset[],
  userAddress: string,
): Promise<string> {
  if (missingAssets.length === 0) return submitXdr;

  const MAX_TRUSTLINE_LIMIT = "922337203685.4775807";
  const original = TransactionBuilder.fromXDR(submitXdr, _cfg.passphrase) as Transaction;
  const acc = await server.getAccount(userAddress);
  const adjustedAcc = new Account(userAddress, (BigInt(acc.sequenceNumber()) - 1n).toString());

  const builder = new TransactionBuilder(adjustedAcc, {
    fee: original.fee,
    networkPassphrase: _cfg.passphrase,
    memo: original.memo,
    timebounds: original.timeBounds ?? undefined,
  });

  for (const asset of missingAssets) {
    builder.addOperation(Operation.changeTrust({ asset, limit: MAX_TRUSTLINE_LIMIT }));
  }
  for (const op of original.operations) {
    builder.addOperation(op);
  }

  return builder.build().toXDR();
}
```

**Sequence number handling:** `buildOpenPositionXdr` calls `server.getAccount(userAddress)` to get the current sequence. `prependTrustlineOps` is called after that XDR is built, so the sequence in the original XDR is already correct. We reconstruct the transaction using the same sequence by decrementing by 1 before passing to `TransactionBuilder` (which auto-increments).

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Horizon account load fails | `getMissingTrustlines` throws; `openPosition` catches, shows toast, aborts |
| `get_reserve` returns null | `getMissingTrustlines` throws with descriptive message |
| b_token/d_token `issuer` sim returns null | Asset skipped (treated as native, no trustline needed) |
| Projected trustline count > 1,000 | `openPosition` throws before building submit XDR; toast shown |
| All trustlines already present | Returns `missing: []`; `prependTrustlineOps` returns original XDR unchanged |

---

## Correctness Properties

Property 1: **Atomicity** — trustline creation and the Soroban deposit are in the same transaction envelope; both succeed or both fail together.
**Validates: Requirements 2.1, 2.4**

Property 2: **No-op transparency** — when `missing.length === 0`, `prependTrustlineOps` returns the original XDR string without reconstruction; the transaction is byte-for-byte identical to what `buildOpenPositionXdr` produced.
**Validates: Requirements 4.1, 4.2, 4.3**

Property 3: **Idempotency** — running the flow a second time (all trustlines now exist) produces the same no-op result.
**Validates: Requirements 4.1, 4.3**

Property 4: **Limit safety** — the check `currentCount + missing.length > 1000` is evaluated before any transaction is built, so the user is never presented with a transaction that would fail on-chain due to the trustline limit.
**Validates: Requirements 3.1, 3.2, 3.3**

---

## Testing Strategy

Manual verification steps:
1. **First deposit (no trustlines):** connect a fresh testnet account, open a position — confirm the wallet shows a single transaction containing `changeTrust` ops followed by the Soroban `submit_with_allowance` call.
2. **Second deposit (trustlines exist):** open a second position on the same asset — confirm the wallet shows only the Soroban ops with no `changeTrust` ops.
3. **Trustline limit:** use a testnet account with 999 trustlines and attempt a first deposit requiring 2 new trustlines — confirm the error toast appears and no wallet prompt is shown.
4. **RPC failure:** simulate a Horizon outage (e.g. wrong URL) — confirm the deposit is aborted with a descriptive error toast.

---

## Affected Files

| File | Change |
|---|---|
| `frontend/src/blend.ts` | Add `MissingTrustlineResult` interface, `getMissingTrustlines`, `prependTrustlineOps` exports |
| `frontend/src/main.ts` | Import new exports; update `openPosition` to call them between approve and submit steps |
