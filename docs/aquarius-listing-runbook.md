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

## 2. Aquarius entry points

| Item | Mainnet | Testnet |
|------|---------|---------|
| AMM router | `CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK` | `CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD` |
| AMM REST API | `https://amm-api.aqua.network/api/external/v1` | `https://amm-api-testnet.aqua.network/api/external/v1` |
| Swap UI | https://aqua.network/swap | https://testnet.aqua.network/swap |
| Pool-creation fee | 300,000 AQUA | **1 AQUA** |
| AQUA issuer | `GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA` | `GAHPYWLK6YRN7CVYZOO4H3VDRZ7PVF5UJGLZCSPAEIKJE2XSWF5LAGER` |
| Pool type | Constant-product (volatile) | same |
| Fee tier | 0.1% / 0.3% / 1% — **use 0.3%** (`fee_fraction: 30`) | same |

Both deployments also serve `external/v2`; it returns byte-identical payloads to
v1 on the pairs we quote, so the client stays on v1 (which the T3.1 acceptance
evidence was generated against).

> **Testnet router rotation.** Aquarius rotates the testnet router on network
> resets. The address above is documented as reset-stable (Feb 2026) and was
> verified live; the pre-2026 address in older docs (`CDGX6Q3Z…`) is **dead**.
> Always re-verify before a listing run:
> `stellar contract info interface --id <router> --network testnet`

### ABI — read off the deployed contracts, not the docs

```
fn init_standard_pool(user: Address, tokens: Vec<Address>, fee_fraction: u32)
       -> (BytesN<32>, Address)                     // (pool_index, pool_address)
fn get_pools(tokens: Vec<Address>) -> Map<BytesN<32>, Address>
fn deposit(user: Address, tokens: Vec<Address>, pool_index: BytesN<32>,
           desired_amounts: Vec<u128>, min_shares: u128) -> (Vec<u128>, u128)
fn estimate_swap(tokens: Vec<Address>, token_in: Address, token_out: Address,
                 pool_index: BytesN<32>, in_amount: u128) -> u128
fn swap_chained(user: Address, swaps_chain: Vec<(Vec<Address>, BytesN<32>, Address)>,
                token_in: Address, in_amount: u128, out_min: u128) -> u128
```

Two corrections against earlier revisions of this runbook, both found by reading
the live spec:

- `init_standard_pool` **is** published on-chain, so pool creation is scriptable
  and does not require the Aquarius UI (`scripts/aquarius_create_pool.ts`).
- `get_pools` returns a **`Map<BytesN<32>, Address>`**, not a
  `Vec<(BytesN<32>, Address)>`. Code written against the old shape breaks.

### Token ordering

Aquarius keys a pool by its token set and orders that set **by the raw 32-byte
contract ID**. Sorting the `C…` strkeys as strings is *not* equivalent — base32
maps A–Z→0–25 and 2–7→26–31, so ASCII order and value order disagree. The script
decodes to bytes and sorts there, then records the resulting order in the
listing registry so every later call (`estimate_swap`, `swap_chained`,
`deposit`) replays exactly the order that created the pool.

## 3. List a receipt token

`scripts/aquarius_create_pool.ts` does creation + seeding + prints the registry
entry. It is **idempotent** — an existing pool is reused, not re-created (which
would burn the AQUA fee twice).

**Prerequisites for the signer**, all checked by the script's preflight:

- An **AQUA trustline** and the creation fee. The fee is pulled *inside*
  `init_standard_pool`; with no trustline the call fails as
  `Error(Contract, #13)` / "trustline entry is missing" — which is what the
  preflight exists to translate.
  - **Testnet:** `SECRET_KEY=S... npx tsx fund_testnet_aqua.ts --amount 3`
    adds the trustline and buys AQUA off the live XLM→AQUA book. Verified:
    3 AQUA cost **0.0503 XLM**.
  - **Mainnet:** 300,000 AQUA is a treasury decision, not a script. Source it
    before the listing window.
- **Receipt tokens to seed** — obtained by depositing into the vault first. The
  shares you seed with are minted by that deposit.
  - **Testnet:** `SECRET_KEY=S... npx tsx deposit_testnet_vault.ts --asset USDC
    --amount 100` does trustline → buy USDC off the testnet DEX → deposit →
    reports the minted receipt balance. Verified: 20 USDC in → 20.0263 shares.
- Matching **underlying** for the other side, plus XLM for fees.

> The dry run stops after `init_standard_pool` — seeding can't be simulated
> against a pool that doesn't exist yet, so `deposit` is first exercised on the
> real run.

```bash
cd scripts

# 1. Dry run — simulates everything, submits nothing.
SECRET_KEY=S... npx tsx aquarius_create_pool.ts --asset USDC \
  --seed-shares 100 --seed-underlying 100 --dry-run

# 2. Execute (testnet).
SECRET_KEY=S... npx tsx aquarius_create_pool.ts --asset USDC \
  --seed-shares 100 --seed-underlying 100

# 3. Mainnet — real funds + 300k AQUA. Requires CONFIRM=1 as a separate act of intent.
op run -- env SECRET_KEY=op://vault/turbolong-deployer/secret CONFIRM=1 \
  npx tsx aquarius_create_pool.ts --network mainnet --asset USDC \
  --seed-shares 1000 --seed-underlying 1000
```

Paste the printed entry into `AQUARIUS_LISTINGS[<network>]` in
`frontend/src/aquarius_listings.ts`, rebuild, deploy. The vault view's trade
panel activates automatically for that asset on that network.

Seed enough depth that a depositor can realistically exit — size to expected
position turnover, not to the minimum that makes a quote appear.

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

- ✅ **Built and verified**: network-scoped Aquarius endpoints (`aquarius.ts`);
  per-network listing registry (`aquarius_listings.ts`); in-app trade panel in
  the vault view — live `estimate_swap` quote, slippage-derived `out_min`, price
  impact, wallet sign + submit (`aquarius_trade.ts`); pool creation/seeding
  script with preflight (`scripts/aquarius_create_pool.ts`); ABI + fee + token
  ordering verified against the live contracts on both networks; 15 unit tests
  (`frontend/test/aquarius_trade.test.ts`).
- ✅ **Testnet money path proven**: with AQUA funded, `init_standard_pool`
  **simulates clean** against the live testnet router — ABI, token ordering and
  fee all confirmed. Only submission is left.
- ⏳ **Testnet listing run**: needs a signer holding receipt tokens (deposit into
  the vault first) plus matching underlying to seed with.
- ⛔ **Mainnet-gated**: T1 D1 deploy (no mainnet share tokens exist yet), 300k
  AQUA/pool, liquidity seeding, and the 5 acceptance trades.

> **Scope note for the grant.** T3.2's acceptance is "at least 5 **external**
> trades executed against the market." Testnet trades are a rehearsal, not
> evidence: a testnet market has no external participants, and testnet resets
> eventually wipe the pool and its history. Confirm with SCF whether "external"
> means third-party trades — if so, the mainnet listing needs a demand plan
> (depositors, or AQUA reward-gauge emissions to attract arbitrage), which has
> weeks of lead time and cannot be manufactured at launch.
