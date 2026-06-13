# Aquarius Listing & Trade Runbook — Turbolong Vault Receipt Tokens

**SCF #43 Tranche 3, deliverable T3.2.** Lists each Turbolong vault's SEP-41
receipt (share) token on Aquarius so depositors can trade their leveraged
position against USDC permissionlessly — exiting without unwinding the loop
on-chain.

> **Mainnet-gated.** Pool creation, liquidity seeding, and the 5 verification
> trades move real funds and require the mainnet vaults + share tokens from T1
> D1 to be live first. This runbook is the procedure; execute it at launch.

---

## 0. What gets listed

Every Turbolong vault mints a **separate SEP-41 token** (the `vault_share`
contract, wired into each strategy via `set_share_token` in
`scripts/deploy_strategy_mainnet.ts`). A holder's share balance is their claim on
the leveraged position. Listing that token on Aquarius gives a secondary exit:
sell shares for USDC instead of calling `withdraw` (which unwinds the loop).

The frontend reads listings from `frontend/src/aquarius_listings.ts`
(`AQUARIUS_LISTINGS`, keyed by vault `assetSymbol`). The vault view shows a
"Trade on Aquarius" CTA + copyable token ID once a listing exists; until then it
shows a "listing after mainnet" notice.

## 1. Prerequisites

- [ ] T1 D1 done: 4 mainnet vaults deployed, each with its share token deployed
      and `set_share_token` confirmed (`deployed-vaults.mainnet.json`).
- [ ] Listing wallet funded with **AQUA** for the pool-creation fee:
      **300,000 AQUA per pool** (4 pools → 1,200,000 AQUA).
- [ ] Listing wallet funded with seed liquidity: receipt tokens (obtained by
      depositing into each vault) **and** matching USDC for the other side.
- [ ] Signer via `op run` / `op read` (1Password) per repo guardrails — never
      inline a secret key.

## 2. Aquarius mainnet entry point

| Item | Value |
|------|-------|
| AMM router / entry-point contract | `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK` |
| Pool type for receipt↔USDC | Constant-product (volatile) |
| Fee tiers (volatile) | 0.1%, 0.3%, 1% — **use 0.3%** |
| Pool-creation fee | 300,000 AQUA |

Verified contract functions (Aquarius Soroban docs):

```
fn get_pools(e: Env, tokens: Vec<Address>) -> Vec<(BytesN<32>, Address)>
fn deposit(e: Env, user: Address, tokens: Vec<Address>, pool_index: BytesN<32>,
           desired_amounts: Vec<u128>, min_shares: u128)
fn swap_chained(e: Env, user: Address, swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
                token_in: Address, in_amount: u128, out_min: u128)
```

> ⚠️ The pool-**creation** entrypoint signature (`init_*_pool`) is **not**
> published in the Aquarius developer docs. Create pools through the Aquarius UI
> (https://aqua.network) — which handles the create + AQUA fee — **or** confirm
> the exact `init_standard_pool` ABI against the live contract before scripting
> it. Do **not** ship a guessed money-path tx-builder.

## 3. List each receipt token (per asset: USDC, USTRY, CETES, XLM)

For each vault share token `S` and counter asset USDC `U`:

1. **Create the pool** (Aquarius UI, recommended): connect the listing wallet,
   create a Volatile pool for `S` / `U` at the 0.3% fee tier, pay the 300k AQUA
   fee. Note the resulting **pool index** (`BytesN<32>`).
   - Tokens vectors are **sorted by contract address** — keep `tokens`,
     `desired_amounts` in the same canonical order Aquarius expects.
2. **Look up the pool index** programmatically to confirm:
   `get_pools([S, U])` → `Vec<(pool_index, pool_address)>`.
3. **Seed liquidity**: `deposit(listingWallet, [S, U], pool_index,
   [sharesAmount, usdcAmount], min_shares)`. Seed enough depth that a depositor
   can realistically exit (size to expected position turnover).
4. **Record** the listing in `frontend/src/aquarius_listings.ts`:
   ```ts
   export const AQUARIUS_LISTINGS: Record<string, AquariusListing> = {
     USDC:  { shareToken: "C…", pairedWith: "C…USDC", poolIndex: "…" },
     USTRY: { shareToken: "C…", pairedWith: "C…USDC", poolIndex: "…" },
     CETES: { shareToken: "C…", pairedWith: "C…USDC", poolIndex: "…" },
     XLM:   { shareToken: "C…", pairedWith: "C…USDC", poolIndex: "…" },
   };
   ```
   Rebuild + deploy the frontend; the vault view CTA goes live automatically.

## 4. Acceptance verification — 5 trades (grant requirement)

For at least one listed pair (USDC receipt ↔ USDC recommended), execute **5
swaps** with small live amounts and capture evidence:

1. `swap_chained(trader, [([S,U], pool_index, U)], S, inAmount, out_min)` — sell
   shares for USDC. (And the reverse `U → S` for buys.)
2. Capture each **tx hash** and confirm on Stellar Expert: token deltas, the
   pool's reserves moved, the trader received within `out_min`.
3. Confirm the realized price aligns with the strategy's reported share price
   (`fetchVaultStats` → share price) within slippage + fee.
4. Record the 5 hashes in the **T3 completion report**.

## 5. Safety

- Real funds. Use **small** amounts for the verification trades.
- Seed liquidity is at risk to impermanent loss vs. the share's NAV drift —
  size deliberately; this is protocol-owned or team liquidity, document it.
- Log any dev shortcut taken during listing to `SECURITY-TODO.md`.

---

### Status

- ✅ Built now: receipt-token concept + `aquarius_listings.ts` registry; vault
  view "Trade on Aquarius" CTA (copyable token ID, Explorer link) with graceful
  pre-listing notice; this runbook.
- ⛔ Mainnet-gated: pool creation (needs share tokens live + 300k AQUA/pool),
  liquidity seeding, the 5 verification trades, populating `AQUARIUS_LISTINGS`.
