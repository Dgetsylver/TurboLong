# BlendLeverageStrategy

A Soroban smart contract that implements a single-asset leveraged yield strategy on the Blend Protocol (Stellar).

## How it works

The strategy accepts a deposit of an underlying asset (e.g., USDC) and amplifies yield by repeatedly supplying and borrowing the same asset through the Blend pool:

```
Deposit $1,000 (c = 0.95, 8 loops)
  Loop 0: supply $1,000  → borrow $950
  Loop 1: supply $950    → borrow $902.5
  …
  Loop 8: supply ~$663   → borrow 0  (final supply, no borrow)

  Total supplied ≈ $8,025   Total borrowed ≈ $7,025   Equity = $1,000
```

Yield is earned on the leveraged supply position minus the cost of the leveraged borrow position. BLND emissions on both sides are harvested and re-compounded via Soroswap.

## Loop cap rationale

`leverage::loop_step_count` hard-caps the number of iterations at **20 loops** (`MAX_LOOPS` in `constants.rs`). This limit exists for three reasons:

### 1. Soroban instruction budget

Each loop step submits two Blend pool operations (supply-collateral + borrow) as host-function calls. Soroban enforces a per-transaction CPU-instruction limit. At 20 loops (40 pool calls + overhead) the transaction is near the practical ceiling; exceeding it causes the transaction to abort with a resource-exhaustion error.

### 2. Diminishing returns

The leverage series is geometric: each loop's supply equals `initial × c^n`. With c = 0.95:

| Loop | Marginal supply | Cumulative leverage |
|------|----------------|---------------------|
| 1    | 0.95 × initial | 1.95×               |
| 5    | 0.77 × initial | 6.23×               |
| 10   | 0.60 × initial | 10.09×              |
| 20   | 0.36 × initial | 15.08×              |
| ∞    | 0              | 20.00×              |

Beyond loop 20, the marginal gain is less than 4% of the total position while the risk of hitting the instruction budget grows sharply.

### 3. Safety ceiling vs. operator knob

`target_loops` in `Config` is the operator-configurable parameter set at initialisation. It must be ≤ `MAX_LOOPS`. The constant is a **hard safety ceiling** that prevents a misconfigured or maliciously set `target_loops` from issuing unbounded on-chain requests even if the init-time validation is absent or bypassed.

## Initialisation parameters

| Index | Name              | Type      | Description                                   |
|-------|-------------------|-----------|-----------------------------------------------|
| 0     | `pool`            | `Address` | Blend pool address                            |
| 1     | `blend_token`     | `Address` | BLND token address                            |
| 2     | `router`          | `Address` | Soroswap router address                       |
| 3     | `reward_threshold`| `i128`    | Minimum BLND to trigger harvest swap          |
| 4     | `keeper`          | `Address` | Authorised harvest caller                     |
| 5     | `c_factor`        | `i128`    | Collateral factor (1e7 scaled, e.g. 9_500_000)|
| 6     | `target_loops`    | `u32`     | Number of leverage loops (≤ 20)               |
| 7     | `min_hf`          | `i128`    | Minimum health factor (1e7 scaled)            |
| 8     | `admin`           | `Address` | Admin address for emergency pause             |

## Emergency pause

The admin can halt new deposits and new leverage operations without blocking withdrawals. This protects users during pool-freeze events or if a vulnerability is discovered.

```
BlendLeverageStrategy::pause()    — blocks deposit + harvest (admin only)
BlendLeverageStrategy::unpause()  — resumes normal operation (admin only)
```

A `PauseStateChange` event is emitted on every state transition.

## Key invariants

- `total_supply - total_borrow = initial_deposit` (net equity preserved through loops)
- `health_factor = (b_tokens × b_rate × c_factor) / (d_tokens × d_rate)` ≥ `min_hf`
- Leverage ≤ `1 / (1 - c_factor)` (geometric series upper bound)
- Deposits are blocked when pool utilisation ≥ 95%
