# Implementation Plan: Trustline Auto-Setup on First Deposit

## Overview

Implement trustline auto-setup so that on first deposit, `changeTrust` operations for b_token, d_token, and BLND are bundled into the same signed transaction. Changes are confined to `frontend/src/blend.ts` (new helpers) and `frontend/src/main.ts` (deposit flow update).

## Tasks

- [ ] 1. Add MissingTrustlineResult interface to blend.ts
  - Add `export interface MissingTrustlineResult { missing: Asset[]; currentCount: number; }` to `frontend/src/blend.ts`
  - Place it alongside the other exported interfaces near the top of the file

- [ ] 2. Implement getMissingTrustlines in blend.ts
  - Add `export async function getMissingTrustlines(pool: PoolDef, userAddress: string, assetId: string): Promise<MissingTrustlineResult>` to `frontend/src/blend.ts`
  - Call `simulate(poolContract.call("get_reserve", new Address(assetId).toScVal()))` and throw if null
  - Extract `reserveRaw.config.b_token` and `reserveRaw.config.d_token` contract IDs
  - Simulate `symbol()` and `issuer()` on each token contract; skip the asset if issuer is null/empty (native)
  - Build the required asset list: b_token Asset, d_token Asset, `_cfg.blndClassic`; filter out native assets
  - Call `horizon.loadAccount(userAddress)` — propagate any error; build a Set of existing trustlines as `"CODE:ISSUER"` strings
  - Filter required assets to find those not in the existing set
  - Set `currentCount` to the number of non-native balances on the account
  - Return `{ missing, currentCount }`

- [ ] 3. Implement prependTrustlineOps in blend.ts
  - Add `export async function prependTrustlineOps(submitXdr: string, missingAssets: Asset[], userAddress: string): Promise<string>` to `frontend/src/blend.ts`
  - Return `submitXdr` immediately when `missingAssets.length === 0`
  - Deserialise with `TransactionBuilder.fromXDR(submitXdr, _cfg.passphrase)` cast to `Transaction`
  - Load account via `server.getAccount(userAddress)`; construct `Account` with sequence decremented by 1
  - Build new `TransactionBuilder` with same `fee`, `networkPassphrase`, `memo`, and `timebounds`
  - Prepend `Operation.changeTrust({ asset, limit: "922337203685.4775807" })` for each missing asset
  - Append all original operations from the deserialised transaction
  - Return `builder.build().toXDR()`
  - Ensure `Transaction` type is imported from `@stellar/stellar-sdk` (add to existing import if absent)

- [ ] 4. Update openPosition in main.ts
  - Import `getMissingTrustlines`, `prependTrustlineOps`, and `MissingTrustlineResult` from `./blend.ts`
  - After the approve step and before `buildOpenPositionXdr`, call `getMissingTrustlines(selectedPool, userAddress, liveAsset.id)`
  - If `currentCount + missing.length > 1000`, show a descriptive toast and return early without building the submit XDR
  - Update TX stepper labels: `["Approve", "Setup Trustlines + Submit"]` when `missing.length > 0`, else `["Approve", "Submit"]`
  - After `buildOpenPositionXdr` returns `submitXdr`, call `prependTrustlineOps(submitXdr, missing, userAddress)` to get `bundledXdr`
  - Pass `bundledXdr` to `signAndSubmit` instead of `submitXdr`
  - Update the step label for the submit step to include `"(+ trustlines)"` suffix when `missing.length > 0`

- [ ] 5. Build and type-check
  - Run `npm run build` or `tsc --noEmit` in `frontend/` and fix any TypeScript errors
  - Confirm no new package dependencies are introduced
  - Confirm the no-op path: when all trustlines exist, `prependTrustlineOps` returns the original XDR and the stepper shows `["Approve", "Submit"]`

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1] },
    { "wave": 2, "tasks": [2, 3] },
    { "wave": 3, "tasks": [4] },
    { "wave": 4, "tasks": [5] }
  ],
  "dependencies": {
    "2": [1],
    "3": [1],
    "4": [2, 3],
    "5": [4]
  }
}
```

Tasks 1, 2, and 3 are in `blend.ts` and can be done sequentially. Task 4 depends on 2 and 3. Task 5 validates everything.

## Notes

- `Transaction` (not `FeeBumpTransaction`) is the type returned by `buildOpenPositionXdr` — the cast in task 3 is safe.
- The sequence number decrement-by-1 trick is necessary because `TransactionBuilder` always increments the sequence on `build()`. The original XDR already has the correct sequence, so we reconstruct it by starting one lower.
- Native XLM never needs a trustline — skip any b_token or d_token whose `issuer()` simulation returns null.
- The `horizon` variable in `blend.ts` is module-level and already used by `buildSwapBlndXdr` — no new Horizon client is needed.
