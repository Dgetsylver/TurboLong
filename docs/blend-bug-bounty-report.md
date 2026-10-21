# Blend Protocol v2 — Bug Bounty Report

**Submitted:** 2026-03-14
**Reporter:** [Your Name]
**Contact:** [Your Contact]
**Affected Contract:** Lending Pool (`submit` / `submit_with_allowance`)
**Network:** Stellar Mainnet
**Status:** Confirmed on mainnet — all test positions have been closed

---

## Summary

Three findings are reported. Finding 1 has been demonstrated on mainnet. Findings 2 and 3 are theoretical / observational.

| # | Title | Severity | Demonstrated |
|---|-------|----------|--------------|
| 1 | Utilization rate manipulation via same-asset leverage loops | **Critical** | Yes — mainnet |
| 2 | Compounded oracle + utilization drain on thin-market assets | **High** | No — theoretical |
| 3 | TVL inflation via same-asset leverage loops | **Medium** | Yes — observable from Finding 1 |

---

# Finding 1: Utilization Rate Manipulation via Same-Asset Leverage Loops

**Severity:** Critical
**Affected Contract:** Lending Pool
**Affected Pool:** Etherfuse (`CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI`)
**Affected Reserve:** USDC (`CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`)

## Description

A same-asset leverage loop (supply USDC, borrow USDC, re-supply, re-borrow, repeated N times in a single `submit_with_allowance` call) artificially dilutes a reserve's utilization rate. This allows a third party to withdraw liquidity that should be blocked by `max_util`, and pushes borrowing rates into the R_3 penalty zone (~450% APR on Etherfuse USDC), causing direct financial loss to all borrowers in the reserve.

## Root Cause

The utilization cap (`max_util`) is enforced via `require_utilization_below_max`, which is **only called from `apply_borrow`**. Withdrawals (`apply_withdraw`, `apply_withdraw_collateral`) are only checked against the hard 100% ceiling, not against `max_util`.

```
pool/src/pool/actions.rs:

Operation              | util < 100%  | util < max_util (#1207) | Health Check
-----------------------|--------------|-------------------------|-------------
Supply                 |     —        |          —              |     —
Withdraw               |    Yes       |         No              |     —
SupplyCollateral       |     —        |          —              |     —
WithdrawCollateral     |    Yes       |         No              |    Yes
Borrow                 |    Yes       |        Yes              |    Yes
Repay                  |     —        |          —              |     —
```

During a same-asset loop, each borrow is individually checked against `max_util`. Because each iteration increases both supply and borrows, the utilization after each step converges toward `c_factor`. When `c_factor ≈ max_util`, every individual borrow passes — even though the net effect is to mask the pool's true utilization.

The `check_max_util` set in `validate_submit` is only populated by `do_check_max_util`, which is only called from `apply_borrow`. Withdrawals never add to this set, so withdrawals executed after the loop bypass the cap entirely.

## Impact

### 1. Interest Rate Manipulation — Loss of Funds (Critical)

This is the primary impact. Pushing utilization above the target (80%) triggers the R_3 penalty slope. On Etherfuse USDC:

| Parameter | Value |
|-----------|-------|
| R_1 (base) | 5% APR |
| R_2 (below target) | 20% APR |
| R_3 (above target) | **500% APR** |
| Target utilization | 80% |
| Utilization cap | 95% |

At the post-exploit utilization of 97.21%:

```
rate = 5% + 20% + ((0.97 - 0.80) / (1 - 0.80)) × 500% = ~450% APR
```

All borrowers in the reserve pay this rate. Health factors deteriorate rapidly:

| Starting HF | Time to liquidation at 450% APR |
|--------------|--------------------------------|
| 1.02 | ~1 day |
| 1.05 | ~4 days |
| 1.10 | ~8 days |

**The attacker profits directly:** they hold a lending position (Wallet A) that earns the inflated APY. The loop/unloop (Wallet B) can execute within a single Stellar ledger (~5 seconds), so the attacker pays negligible borrowing interest. The only cost is gas fees.

Within hours of the test, users on the Blend Discord reported anomalous behavior on the Etherfuse USDC reserve.

### 2. Liquidity Drain (High)

Withdrawals executed during suppressed utilization remove real liquidity. Post-exploit:

```
Total Supply:        82,011.50 USDC
Total Borrows:       79,727.10 USDC
Available Liquidity:  2,284.40 USDC  (2.8% of supply)
Utilization:            97.21%
Configured max_util:    95.00%
```

### 3. Supplier Fund Lock (High)

Remaining suppliers cannot withdraw more than the available liquidity (2,284 USDC). They must wait for borrowers to repay.

### 4. Position Closure Deadlock (High)

If a looper's position remains open when the pool is above `max_util`, unwinding may fail with `Error(Contract, #1207)` because the repay-then-withdraw sequence can momentarily spike utilization further.

## Reproduction Steps

Two wallets are needed:
- **Wallet A** — existing lending position in the target pool
- **Wallet B** — will execute the leverage loop

### Step 1: Deploy leverage loop (Wallet B)

Build a `submit_with_allowance` transaction with N alternating `supply_collateral` + `borrow` requests for the same asset:

```
supply_collateral(USDC, 200.00)
borrow(USDC, 190.00)          // 200 × c_factor(0.95)
supply_collateral(USDC, 190.00)
borrow(USDC, 180.50)          // 190 × 0.95
...repeat 10-13 times...
```

Each individual borrow passes `require_utilization_below_max` because the preceding supply dilutes the utilization denominator.

### Step 2: Withdraw liquidity (Wallet A)

While the loop is active, withdraw collateral from the pool. The withdrawal passes because `apply_withdraw_collateral` only checks `require_utilization_below_100`, not `max_util`.

### Step 3: Unwind the loop (Wallet B)

Repay all borrows and withdraw all collateral. Utilization returns to its true level — now above `max_util` because real liquidity was removed in Step 2.

### Step 4: Collect interest (Wallet A)

The lending position now earns the inflated APY (up to 500% APR). Steps 1-3 can be repeated to maintain the elevated rate.

## On-Chain Proof of Concept

Demonstrated on Stellar Mainnet, 2026-03-12/13.

### Actors

| Wallet | Address | Role |
|--------|---------|------|
| A (Lender) | `GBHD3V2XKX6DXHYZDSHA2UYZTO4MKB2R6QNSCDT4XEKNGTLPXT7A36EA` | Lending position |
| B (Looper) | `GCR3VBVLYM5ZUBX63XMYBEY4EMAPVNCLORA4CWPA64CYEQQT53UCIQ36` | Leverage loops |

### Key Transactions

**Leverage loops (Wallet B):**

| TX Hash | Timestamp | Supply Added | Borrows Added | Leverage |
|---------|-----------|-------------|---------------|----------|
| `78f090d376bb54de...` | 2026-03-12 22:02 | 2,000 USDC | 1,800 USDC | 10x |
| `b040e55d32aaa9d3...` | 2026-03-12 22:36 | 1,860 USDC | 1,660 USDC | 9.3x |
| `1f1ad7e2283a4d53...` | 2026-03-13 00:38 | 1,860 USDC | 1,660 USDC | 9.3x |
| `a2d970953c6ec26e...` | 2026-03-13 22:49 | ~10,000 USDC | ~9,000 USDC | ~10x |
| `485e928372ab4891...` | 2026-03-13 22:52 | ~102,000 USDC | ~91,800 USDC | ~10x |

**Withdrawals during suppressed utilization (Wallet A):**

| TX Hash (prefix) | Timestamp | Amount |
|-------------------|-----------|--------|
| `c3b9fe7b...` | 22:19:22 | 318,131.16 USDC |
| `3cf3e120...` | 22:20:43 | 110,000.00 USDC |
| `f183e170...` | 22:22:19 | 27,000.00 USDC |
| `b2ee3423...` | 22:23:11 | 18,950.02 USDC |
| `8a2c6c84...` | 22:25:05 | 30,010.00 USDC |
| `eaf7bbbc...` | 22:25:51 | 25,106.92 USDC |
| `8f25cd9e...` | 22:54:36 | 5,614.15 USDC |

**Loop unwinding (Wallet B):**

| TX Hash (prefix) | Timestamp | Event |
|-------------------|-----------|-------|
| `62f8984f...` | 2026-03-12 22:32 | repay 1,800 + withdraw 2,000 |
| `7ebe93d7...` | 2026-03-13 00:20 | repay 1,660 + withdraw 1,660 |
| `b8997c65...` | 2026-03-13 07:09 | withdraw 1,260 |
| `b3668dfd...` | 2026-03-13 23:07 | repay 81,600 + withdraw 91,800 |

All positions are now closed. The pool remains at 97.21% utilization (above the 95% cap).

**Video recording of the exploit is available upon request.**

## Suggested Fix

Add `do_check_max_util` to both `apply_withdraw` and `apply_withdraw_collateral`:

```rust
fn apply_withdraw_collateral(/* ... */) {
    user.remove_collateral(e, &mut reserve, to_burn);
    reserve.require_utilization_below_100(e);
    actions.do_check_max_util(&reserve.asset);  // ADD THIS
    actions.add_for_pool_transfer(&reserve.asset, tokens_out);
    actions.do_check_health();
}
```

**Trade-off:** This would also block legitimate suppliers from withdrawing when utilization organically exceeds the cap. A more nuanced approach: only block withdrawals that would *increase* utilization above `max_util`.

Additional defense-in-depth options:
- Enforce `require_utilization_below_max` for **all reserves touched** in `validate_submit`, not just those that were borrowed from.
- Implement per-reserve supply caps.

## Historical Precedent

This attack pattern mirrors the **Aave V2 / CRV incident (November 2022)**, where leverage loops manipulated utilization rates on the CRV reserve, resulting in **~$1.6M in bad debt** absorbed by the Aave DAO. Aave subsequently implemented reserve-specific supply caps.

---

# Finding 2: Compounded Oracle + Utilization Attack on Thin-Market Assets

**Severity:** High
**Status:** Theoretical — not yet attempted
**Affected Contract:** Lending Pool + Oracle Adaptor
**Affected Pool:** Etherfuse

## Description

The utilization rate manipulation from Finding 1 can be combined with SDEX-based oracle price manipulation of thin-market Etherfuse assets (CETES, USTRY, TESOURO) to force liquidations of borrowers who are close to HF 1.05. While the Etherfuse pool's oracle adaptor includes a `max_dev=5%` circuit breaker that prevents the YieldBlox-style 100x manipulation, 5% is precisely the liquidation margin for max-leverage positions.

## Background: YieldBlox Exploit (February 22, 2026)

The YieldBlox DAO pool was exploited for ~$10.8M via USTRY oracle manipulation. The YieldBlox pool used a **raw Reflector oracle** with no circuit breakers — a $4 self-trade on SDEX inflated USTRY from ~$1.05 to ~$106, and the oracle accepted it.

Sources: [Halborn](https://www.halborn.com/blog/post/explained-the-yieldblox-hack-february-2026), [QuillAudits](https://dev.to/quillaudits/how-a-single-trade-caused-yieldblox-10m-loss-34hk)

## Key Difference: Etherfuse Oracle Adaptor

The Etherfuse pool does **not** use a raw Reflector oracle. It uses a custom oracle adaptor (`CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS`) with circuit breakers. On-chain inspection reveals:

| Asset | `max_dev` | Oracle Index | Underlying |
|-------|-----------|-------------|------------|
| CETES | 5% | 0 | Reflector (300s, 14 dec) |
| USTRY | 5% | 0 | Reflector (300s, 14 dec) |
| TESOURO | 5% | 0 | Reflector (300s, 14 dec) |
| USDC | 5% | 1 | Reflector (300s, 14 dec) |
| XLM | 10% | 1 | Reflector (300s, 14 dec) |

**MaxAge:** 600 seconds.

The `max_dev` circuit breaker rejects any price update deviating more than 5% from the previous accepted price. The YieldBlox-style 100x manipulation is **not possible**.

## Why `max_dev=5%` Is Still Exploitable

### 5% = liquidation threshold

For CETES and TESOURO (c_factor = 0.80), max leverage is ~5x, giving HF ≈ 1.05 at full leverage. A single 5% price drop liquidates these positions:

```
HF 1.05 × 0.95 = 0.9975 → liquidatable
```

### Price walking

If `max_dev` compares against the *last accepted price*, the price can be walked 5% every oracle resolution period (300 seconds):

| Time | Cumulative drop | Liquidates HF ≤ |
|------|-----------------|------------------|
| 5 min | -5.0% | 1.05 |
| 10 min | -9.75% | 1.10 |
| 30 min | -26.5% | 1.36 |
| 1 hour | -46.0% | Most positions |

### Near-zero SDEX depth

At the time of the YieldBlox exploit, TESOURO had ~$1.39 of bid depth on SDEX. Moving the price 5% costs less than $1. Walking the price for one hour: ~$12.

## Compounded Attack Scenario

**Phase 1:** Use Finding 1 to spike USDC borrowing rates to ~450% APR, eroding borrower health factors.

**Phase 2:** Manipulate the SDEX price of the collateral asset downward. The `max_dev=5%` limit is sufficient for the first wave of liquidations.

**Phase 3:** The two attacks compound multiplicatively:

| Starting HF | After 1 day interest | After 5% price drop | Combined HF | Status |
|-------------|---------------------|---------------------|-------------|--------|
| 1.05 | 1.037 | × 0.95 = 0.985 | **Liquidatable** | Immediate |
| 1.10 | 1.087 | × 0.95 = 1.033 | At risk | Days |
| 1.05 | — | × 0.95 = 0.998 | **Liquidatable** | Immediate |

A 5% price drop alone liquidates any borrower at HF ≤ 1.05 without needing the interest rate manipulation at all.

## Why This Remains a Risk

1. **`max_dev=5%` aligns with the liquidation threshold** for max-leverage c_factor 0.80 positions.
2. **Price walking** may extend the attack beyond 5% over multiple oracle periods.
3. **SDEX liquidity is near-zero** for Etherfuse stablebonds — manipulation costs are negligible.
4. **No minimum volume check** — a single self-trade on an empty order book is accepted.
5. **The utilization manipulation compounds the effect** — rate erosion weakens health factors before the oracle push.

## Suggested Mitigations

- **Fixed reference for `max_dev`:** Compare against a TWAP or median rather than the last accepted price to prevent price walking.
- **Minimum volume thresholds:** Reject oracle prices from periods with negligible SDEX volume.
- **Multi-source oracle feeds:** Require agreement between Reflector and a secondary source (e.g., RedStone, launched on Stellar March 4, 2026).
- **Tighter `max_dev` for high-leverage assets:** Reduce to 2-3% for assets with c_factor ≥ 0.80 so a single update cannot liquidate max-leverage positions.
- **Collateral value caps:** Limit maximum collateral value for thin-market assets.

---

# Finding 3: TVL Inflation via Same-Asset Leverage Loops

**Severity:** Medium
**Status:** Observable — demonstrated as a side-effect of Finding 1
**Affected Contract:** Lending Pool
**Affected Pool:** Any pool permitting same-asset supply + borrow

## Description

Same-asset leverage loops artificially inflate a pool's reported Total Value Locked (TVL). Because each loop iteration adds both supply and borrows, the pool's on-chain `total_supply` and `total_borrows` grow geometrically while the user's actual economic exposure remains constant. This misrepresents the pool's real size to depositors, analytics platforms, and risk models.

## Root Cause

Blend reports TVL as the sum of all bToken balances (supply positions). There is no mechanism to distinguish between "real" deposits backed by external capital and "synthetic" deposits created by re-supplying borrowed funds. A same-asset loop creates supply and borrow entries that net to zero economic exposure but inflate both sides of the balance sheet.

## Impact

### Misleading Pool Metrics

For a collateral factor **c**, a single user depositing **X** can inflate apparent TVL by up to:

```
TVL inflation factor = 1 / (1 - c)
```

| Asset | c_factor | Max TVL inflation | $200 deposit appears as |
|-------|----------|-------------------|------------------------|
| USDC | 0.95 | **20x** | $4,000 |
| USTRY | 0.90 | **10x** | $2,000 |
| CETES | 0.80 | **5x** | $1,000 |

### Observed On-Chain

The leverage loop transactions from Finding 1 demonstrate this directly:

| TX Hash (prefix) | Deposit | Apparent Supply Added | Apparent Borrows Added | Inflation |
|-------------------|---------|----------------------|----------------------|-----------|
| `78f090d3...` | 200 USDC | ~2,000 USDC | ~1,800 USDC | **10x** |
| `a2d97095...` | ~1,000 USDC | ~10,000 USDC | ~9,000 USDC | **~10x** |
| `485e9283...` | ~10,200 USDC | ~102,000 USDC | ~91,800 USDC | **~10x** |

A single user with ~11,400 USDC of real capital created ~114,000 USDC of apparent supply — inflating the pool's reported TVL by ~100,000 USDC.

### Downstream Consequences

1. **Depositor deception:** New depositors may perceive the pool as larger and more liquid than it actually is, leading to misallocation of capital.
2. **Risk model corruption:** Automated risk systems that use TVL as an input (e.g., for setting exposure limits or collateral parameters) will overestimate the pool's safety.
3. **Analytics distortion:** DeFi aggregators (DeFiLlama, etc.) report inflated TVL, misrepresenting the protocol's actual adoption and capital base.
4. **Governance manipulation:** If BLND token incentives or governance weight are tied to pool TVL, leverage loops can be used to farm rewards or influence votes disproportionately.

## Reproduction Steps

1. Deposit **X** USDC into the pool.
2. Execute a `submit_with_allowance` with N alternating `supply_collateral` + `borrow` requests for USDC (same steps as Finding 1).
3. Observe that the pool's reported `total_supply` has increased by ~`X / (1 - c)` while the user's net economic position is unchanged.
4. The inflated TVL persists for as long as the loop remains open.

## Suggested Fix

- **Compute effective TVL** by netting out self-referential positions: `effective_supply = total_supply - self_borrowed_supply`. This can be approximated by subtracting same-asset borrows from total supply per reserve.
- **Per-reserve supply caps** would limit the maximum inflation any single actor can create.
- **Display "net TVL"** on front-ends and analytics: `net_TVL = total_supply - total_borrows` gives a more accurate picture of real capital in the pool.

---

# Appendix A: Utilization Dilution Math

A user deposits **X** and loops **N** times with collateral factor **c**:

```
Added supply  = X × (1 - c^(N+1)) / (1 - c)
Added borrows = X × c × (1 - c^N) / (1 - c)

Ratio added_borrows / added_supply → c  as N → ∞
```

If the pool's current utilization **U > c**, the loop pulls utilization down toward **c**. When `c ≈ max_util`, this creates the exploitation window.

# Appendix B: Interest Rate Model

Blend's three-leg piecewise function with Rate Modifier (RM):

```
If utilization ≤ target:
    rate = R_1 + (utilization / target) × R_2

If utilization > target:
    rate = R_1 + R_2 + ((utilization - target) / (1 - target)) × R_3

Rate Modifier amplifies/dampens reactively based on sustained deviation from target.
```

# Appendix C: Affected Code Locations

**`apply_borrow`** — the only place `do_check_max_util` is called:
```rust
fn apply_borrow(/* ... */) {
    user.add_liabilities(e, &mut reserve, d_tokens_minted);
    reserve.require_utilization_below_100(e);
    actions.do_check_max_util(&reserve.asset);  // <-- ONLY here
    actions.add_for_pool_transfer(&reserve.asset, request.amount);
    actions.do_check_health();
}
```

**`apply_withdraw_collateral`** — missing `max_util` check:
```rust
fn apply_withdraw_collateral(/* ... */) {
    user.remove_collateral(e, &mut reserve, to_burn);
    reserve.require_utilization_below_100(e);  // only hard cap
    actions.add_for_pool_transfer(&reserve.asset, tokens_out);
    actions.do_check_health();
    // MISSING: actions.do_check_max_util(&reserve.asset);
}
```

**`validate_submit`** — only checks borrowed assets:
```rust
fn validate_submit(e: &Env, actions: &Actions) {
    for asset in &actions.check_max_util {  // only populated by apply_borrow
        let reserve = storage::get_reserve(e, asset);
        reserve.require_utilization_below_max(e);
    }
}
```
