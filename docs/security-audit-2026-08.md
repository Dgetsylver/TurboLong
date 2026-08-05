# Security Audit — TurboLong Soroban Contracts

**Date:** 2026-08-04 (revised 2026-08-05 after verification pass)
**Branch:** `feat/aquarius-token` @ `1d66c4e`
**Scope:**
- `contracts/strategies/blend_leverage` (lib, blend_pool, leverage, reserves, storage, soroswap, constants)
- `contracts/tokens/vault_share` (lib, storage)

Out of scope: `frontend/`, `scripts/` (read only for deployed parameter values),
`alerts/`, the off-chain keeper, the Blend pool itself, and Soroswap.

**Build status:** `cargo check --tests` clean. `overflow-checks = true` on both release
profiles, so wraparound is not a concern.

**Revision note.** The first draft of this report was written against `doc.md`'s 20×
leverage discussion. The actual deployed parameters
(`scripts/deploy_strategy_mainnet.ts:78-83`) are far more conservative — `target_loops`
of 2–4 and `c_factor` deliberately set below the pool's. Several severities are lower as
a result, and one finding was withdrawn. Corrections are marked inline.

---

## Summary

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| H-1 | High | HF formula omits Blend's `l_factor`; safety margin is unverified per asset | **Fixed** 2026-08-05 |
| M-1 | Medium | `partial_unwind` accepts unbounded `target_hf` — anyone can force a full deleverage | **Fixed** 2026-08-05 |
| M-2 | Medium | Stored reserves never reconcile with the real Blend position | **Fixed** 2026-08-05 |
| M-3 | Medium | No re-leverage path — leverage ratchets monotonically down | **Fixed** 2026-08-05 |
| M-4 | Medium | Broker harvest path has no on-chain settlement floor | Open |
| M-5 | Medium | Trait `harvest` defaults to zero slippage protection | Open |
| L-1 | Low | Public `burn`/`burn_from` strand equity and break the supply invariant | Open |
| L-2 | Low | `set_share_token` re-pointable (subsumed by `upgrade`) | Open |
| L-3 | Low | Silent `unwrap_or` fallbacks degrade the deposit safety projection | Open |
| L-4 | Low | `MAX_RATE_SPREAD` guard declared but never implemented | Open |
| L-5 | Low | Full close approves the pool for `i64::MAX` of the underlying | Open |
| L-6 | Low | No events on privileged state changes; no pause switch | Open |
| L-7 | Low | `harvest` panics on malformed `data`; cooldown returns `NotAuthorized` | Open |
| L-8 | Low | `Administratable::admin()` uses `unwrap_unchecked` | Open |
| — | Withdrawn | Deposit gate divergence (was M-5) — folded into M-2 | — |
| — | Unverified | Withdrawal liquidity at 95% utilization (was M-6) — see *Open questions* | — |

---

## High

### H-1 — HF formula omits Blend's `l_factor`; safety margin is unverified per asset

**Files:** `contracts/strategies/blend_leverage/src/leverage.rs:145-178`,
`contracts/strategies/blend_leverage/src/test_integration.rs:114`,
`scripts/deploy_strategy_mainnet.ts:78-83`

`compute_health_factor` weights collateral by `c_factor` and applies nothing to the
liability side:

```rust
let weighted_supply = supply_value.checked_mul(c_factor)?;   // B × c
let debt_value      = d_tokens.fixed_mul_floor(d_rate, SCALAR_12)?;
weighted_supply.checked_div(debt_value)                      // HF = B·c / D
```

Blend's own health check marks liabilities *up* by dividing by `l_factor`:
`effective_collateral = B × pool_c_factor`, `effective_liabilities = D / l_factor`, with
liquidation available once the former falls below the latter. The strategy's HF is
therefore systematically **optimistic relative to the number that actually governs
liquidation**, by a factor of `pool_c_factor × l_factor / strategy_c_factor`.

The project is already aware of this — `profitability_analysis.md:15-16` records
"l_factor (USDC) 0.95 … printed, not used in HF formula" and "no l_factor in
denominator". It is documented as an observation, but the on-chain formula still omits
it, and nothing in the contract enforces that the gap is covered.

**What actually protects the position today** is an operator convention, not code: the
deploy script sets the strategy's `c_factor` *below* the pool's, "leaving a borrow/HF
buffer" (`deploy_strategy_mainnet.ts:68-70`). Working the USDC numbers — strategy
`c = 0.90`, pool `c = 0.95`, `l = 0.95`, `min_hf = 1.05`:

```
strategy HF 1.05  ⇒  B/D = 1.05 / 0.90 = 1.1667
Blend's ratio     =  1.1667 × 0.95 × 0.95 = 1.053   → ~5% real buffer, safe
```

So **USDC as deployed is fine.** The concern is that this is a coincidence of parameter
choice rather than a derived invariant, and it is not uniform across assets. Running the
same arithmetic for XLM (strategy `c = 0.70`, pool `c = 0.75`, `min_hf = 1.10`):

```
Blend's ratio = (1.10 / 0.70) × 0.75 × l_factor = 1.1786 × l_factor
               → breaks even at l_factor ≈ 0.85, liquidatable below it
```

I could not confirm XLM's live `l_factor` from the repo, so I am **not** claiming the XLM
vault is currently unsafe — I am claiming nobody can tell from the contract, and no test
would catch it if it were. The integration fixture pins `l_factor = 10_000_000` (1.0)
with the comment "no liability markup" (`test_integration.rs:114`), which makes the
entire suite blind to this term by construction.

**Recommendation.** Read `l_factor` from the reserve config in `__constructor` alongside
`c_factor`, store it, and divide the debt side by it in `compute_health_factor`. Then
assert at deploy time that `min_hf` clears 1.0 *in Blend's own terms*. Failing that, at
minimum add an integration test with `l_factor < 1.0` and document the required buffer
as an explicit deployment invariant rather than a comment. Verify each live asset's
`l_factor` before the next mainnet deploy — XLM and CETES are the ones worth checking.

**Resolution (2026-08-05).** Fixed, with one deliberate deviation from the
recommendation: `l_factor` is read **live** from the reserve config on every
health-factor computation rather than cached in `Config` at construction. Blend
governance can re-parameterise a reserve (`queue_set_reserve`), and a stored copy would
go stale in exactly the unsafe direction. It costs nothing —
`blend_pool::get_rates_and_l_factor` returns it from the `get_reserve` call the HF paths
already made — and it keeps `Config` decodable across upgrades.

- `compute_health_factor` now reports `HF = B × c_factor × l_factor / D`
  (`leverage.rs:145-207`). `compute_partial_unwind` solves its closed form against the
  same effective factor `cl = c_factor × l_factor`; the unwind *layer* sizing still uses
  the raw `c_factor`, which describes the borrow loop's geometry and is unaffected by how
  the pool weights liabilities.
- The safety margin is now derived rather than conventional. `__constructor` asserts
  `c_factor <= pool_c_factor` (`lib.rs:119-152`), which makes the reported HF a lower
  bound on Blend's own ratio `B × pool_c_factor × l_factor / D`. With that inequality,
  the existing `min_hf > 1.0` assertion *is* the "clears 1.0 in Blend's terms" check, for
  every asset, without a per-asset buffer convention. The deploy script keeps setting
  `c_factor` below the pool's for borrow headroom, but solvency no longer depends on it.
- `scripts/deploy_strategy_mainnet.ts` gained a `preflight()` that simulates
  `get_reserve` for all four assets before the first deploy, prints each live `l_factor`,
  and aborts if any asset's `c_factor` exceeds the pool's or its `min_hf` fails to clear
  1.0 in Blend's terms. This is the "verify each live asset's `l_factor`" step, run
  automatically rather than by hand.
- A `risk_factors()` view returns `(strategy_c_factor, pool_c_factor, l_factor)` from the
  live reserve, so operators and `alerts/` can watch the pool-side inputs directly.
- Two off-chain copies of the HF formula were fixed alongside the contract, both outside
  this report's original scope but the same defect at a second site. `alerts/`'s
  `computeHealthFactor` (`stellar.ts:276-296`) drives subscriber HF and **liquidation**
  alerts off `L × c_factor / (L−1)`, so those alerts were firing late; it now carries
  `l_factor`. The frontend's deposit preview (`views/vault.ts:475-495`) projected the
  post-deposit HF with the old formula while displaying a "before" value read from
  `health_factor()` — after the contract fix those two would have disagreed, showing a
  deposit as *raising* HF. It now reads `l_factor` from `risk_factors()` via
  `VaultStats.lFactor`.
- Tests: the integration fixture is now parameterised
  (`setup_blend_env_with_l_factor`), and two integration tests run against a reserve with
  a real markup, asserting the strategy's HF against **Blend's own health check** — the
  pool refuses a liquidation auction while HF ≥ 1.0, and accepts one once a governance
  `l_factor` cut pushes HF below 1.0 (which also proves the value is read live). Unit
  tests cover the markup arithmetic, the liquidation boundary, the lower-bound property,
  and a regression case using this finding's XLM numbers where the old formula passed the
  deposit gate on a position Blend would liquidate.

The `l_factor` values themselves were still **not** queried from mainnet — no network
access in this workspace — but that verification is now enforced by `preflight()` at
deploy time and by the constructor at contract-creation time, rather than left to a
reviewer's checklist.

---

## Medium

### M-1 — `partial_unwind` accepts unbounded `target_hf`; anyone can force a full deleverage

**File:** `contracts/strategies/blend_leverage/src/lib.rs:469-496`

```rust
if hf >= config.orange_hf {
    let keeper = storage::get_keeper(&e);
    if caller != keeper { return Err(StrategyError::NotAuthorized); }
}
caller.require_auth();
let effective_target = target_hf.max(config.orange_hf);   // floored, never capped
```

Once HF dips below `orange_hf` the keeper check is skipped and **any address** may call
with an arbitrarily large `target_hf`. Tracing a large target through
`compute_partial_unwind` (`leverage.rs:264-338`): `x` clamps to `debt_value` (full
repay), `layer_size = debt × (1 − c_factor)`, and `loops` saturates the `clamp(1, 20)`
ceiling. `submit_deleverage` then issues 20 withdraw/repay pairs bounded only by
`remaining_debt`, retiring the entire debt.

I checked whether the conservative production `target_loops` (2–4) limits this: it does
not. `submit_deleverage` sizes its layers from `c_factor` and caps iterations at 20
independently of `target_loops`, so a full unwind is reachable on every deployed vault.

Principal is not at risk — this destroys yield, not deposits. But it is unauthenticated,
costs only a transaction fee, and combined with M-3 the damage does not self-heal.

**Recommendation.** Cap `effective_target` at `config.orange_hf` for non-keeper callers.
`rebalance()` already implements exactly the right restricted behaviour; the
permissionless branch of `partial_unwind` should be no more powerful than it.

**Resolution (2026-08-05).** Fixed as recommended (`lib.rs:499-544`). The keeper identity
is now resolved once, before the auth gate, and drives both decisions:

```rust
let is_keeper = caller == storage::get_keeper(&e);
if hf >= config.orange_hf && !is_keeper {
    return Err(StrategyError::NotAuthorized);
}
caller.require_auth();

let effective_target = if is_keeper {
    target_hf.max(config.orange_hf)   // keeper: own target, floored
} else {
    config.orange_hf                  // anyone: exactly rebalance()'s behaviour
};
```

A permissionless caller's `target_hf` is now ignored outright rather than floored, so the
unauthenticated branch is bounded by construction — it cannot express anything
`rebalance()` cannot. The keeper path is unchanged: it is a trusted role and still gets
the target it asks for, so it can deleverage past `orange_hf` when it judges that
necessary. Cost is one extra storage read on the permissionless path (the keeper address
was previously read only above the orange zone).

No off-chain caller is affected — the keeper drives `rebalance_keeper`, and the only other
references to `partial_unwind` outside the contract are `scripts/rebalance_sim.ts`'s mirror
of the pure `compute_partial_unwind` math, which is untouched.

Three integration tests in `test_integration.rs` pin the behaviour against the real Blend
pool, using the existing 8-loop stressed fixture (HF ≈ 1.076, inside the orange zone so no
keeper role is needed):

- `test_partial_unwind_ignores_target_from_permissionless_caller` — the finding's exact
  attack: a stranger calls with `target_hf` = 100. Debt survives and HF lands at the
  floor (1.1507 against `orange_hf` 1.15); under the old code the closed form clamped to a
  full repay and retired the position. The follow-up assertions pin the "no more powerful
  than `rebalance()`" property: a subsequent `rebalance()` is a no-op, and the stranger's
  retry is now rejected outright, since restoring HF puts the position back outside the
  permissionless window.
- `test_partial_unwind_honours_keeper_target_above_orange` — the keeper asking for
  `orange_hf + 0.20` still gets it, so the cap did not disarm the trusted path.
- `test_partial_unwind_rejects_non_keeper_above_orange_zone` — the pre-existing auth gate,
  pinned so it is not lost while the target bounding moves around it.

The caveat about permanence in this finding was resolved separately by M-3, which adds
the keeper-gated `releverage` path: what a stranger forces off is now bounded to one
rebalance's worth *and* is recoverable, rather than bounded but permanent.

### M-2 — Stored reserves never reconcile with the real Blend position

**Files:** `contracts/strategies/blend_leverage/src/reserves.rs:15-21`, `:42-109`,
`:201-219`, `:226-267`

`total_b_tokens` / `total_d_tokens` are maintained purely as a running ledger of deltas
the strategy itself caused. `get_strategy_reserves_updated` refreshes **only** the rates,
never the position, even though `blend_pool::get_strategy_positions` exists and is used
by `health_factor()` and `unwind_to()`. There is no reconciliation entrypoint.

Any position change the strategy did not initiate — liquidation, Blend bad-debt
socialization — is therefore invisible to share pricing. `compute_equity` would overstate
equity, `withdraw` would price shares off the inflated figure, and the shortfall would
land entirely on the last holders (first-come, first-served).

*Severity correction from the first draft:* I originally rated this High on the strength
of a near-liquidation 20× position. With `target_loops` of 2–4 and `min_hf` of 1.05–1.10
as actually deployed, liquidation is a much less likely trigger, so the finding is better
read as a latent correctness gap than an imminent one. It is still worth fixing, because
the failure is silent and the contract has no way to detect that it has occurred. It also
interacts with H-1: if the real liquidation threshold is closer than the strategy's HF
suggests, the trigger becomes correspondingly more likely.

**Recommendation.** Take the pool as the source of truth for `total_b_tokens` /
`total_d_tokens` in `get_strategy_reserves_updated`, keeping only `total_shares` local.
If that is too invasive, add a permissionless `sync_reserves()` that clamps stored totals
down to the measured position and emits an event on any downward correction, so the
`alerts/` stack can detect a liquidation.

*(The first draft listed a separate M-5 for `deposit`'s safety gate reading stored
accounting rather than the live position. That is the same defect observed at a second
site, not an independent finding, so it is folded in here.)*

**Resolution (2026-08-05).** Both halves of the recommendation are implemented, because
they do different jobs: reconciliation on read makes the *pricing* correct, and
`sync_reserves()` makes the correction *visible*.

Reconciliation is now a single rule, applied wherever the position is read
(`reserves.rs:22-95`):

```rust
reserves.total_b_tokens = reserves.total_b_tokens.min(pool_b);
reserves.total_d_tokens = reserves.total_d_tokens.min(pool_d);
```

`get_strategy_reserves_updated` fetches `blend_pool::get_strategy_positions` alongside the
rates it already fetched and clamps through `reconcile`. Every consumer inherits it —
`balance`, `position`, `withdraw`'s pricing, and `deposit`'s safety gate, which closes the
folded-in second site without a separate change. It deliberately does **not** persist:
`balance` and `position` are views, and a view must not write.

**The clamp is downward-only, and that asymmetry is the load-bearing part.** Following the
pool *up* would mean any collateral credited to the strategy's position moved the share
price, which is precisely the lever an inflation attack needs — and it would invalidate
this report's own "not exploitable" entry that a donation cannot move the share price. As
things stand there is no such path: Blend's `submit` routes `to` to outgoing transfers
only, so a `SupplyCollateral` sent with `to = strategy` credits the *sender*. The test
below pins that observation, then constructs the upward gap directly and pins the rule
that would contain it if the assumption ever stopped holding.

One asymmetry is worth stating rather than hiding: a third party *repaying* the
strategy's debt lowers `pool_d`, which does clamp down and does raise equity. That is a
donation of value that moves the share price, but it is bounded by the vault's own
outstanding debt rather than unbounded like a collateral donation — and the alternative,
leaving `total_d_tokens` high after a liquidation, would systematically under-price every
holder's shares until the position closed.

Two consequential changes fell out of making the read path live:

- `reserves::harvest` and `reserves::deleverage` used to re-read reserves *after* their
  pool operation had settled and then apply the delta again. Against a stored-only ledger
  that was harmless; against a reconciled read it double-counts. Both now take the
  pre-operation snapshot as a parameter, exactly as `deposit` and `commit_withdraw`
  already did, so the whole crate follows one discipline: `stored = reconcile(previous) ±
  measured delta`. `unwind_to` builds its snapshot from the pool values it had already
  read, so this costs no extra cross-contract call on the rebalance path.
- `deleverage` switched from `checked_sub` to `saturating_sub`, matching `commit_withdraw`.
  The measured removal comes from the pool while the snapshot is clamped to the pool's
  pre-unwind position, so if the tracked total ever sat below the pool's the subtraction
  could underflow — and a revert there would brick liquidation protection.

`sync_reserves()` (`lib.rs:490-521`) is the observability half: permissionless (like
`rebalance`, it can only move the accounting towards the truth), it persists the write-down
and emits `reserves_sync` with `(b_before, b_after, d_before, d_after)`, returning the
correction. It is idempotent and silent when there is nothing to correct. Pricing does not
depend on anyone calling it — that is what the read path is for; its job is to leave an
on-chain trace that the position moved without the strategy asking.

Three integration tests against the real Blend fixture (`test_integration.rs`), all driven
through the production entrypoints. They model the seizure as a direct pool
`WithdrawCollateral` submitted as the strategy — not a liquidation auction, but the same
event as far as the strategy's accounting is concerned:

- `test_seized_collateral_is_priced_into_balance_immediately` — the finding itself. After
  ~10% of collateral leaves, the test first asserts the raw stored ledger is *unchanged*
  (otherwise it would be proving nothing), then that `position()` reports the pool's
  collateral, that equity and the holder's `balance()` both fall, and that the write-down
  equals the underlying value of exactly the collateral that left.
- `test_sync_reserves_writes_down_seizure_and_emits_event` — no correction and no event on
  a healthy position; after the seizure, stored totals are written down to the pool's, the
  event payload matches the transition, the return value is the amount written down, and a
  second call is a no-op.
- `test_reconciliation_never_revises_the_position_upward` — the anti-donation property
  described above.

**Not done, and deliberately.** The recommendation's rationale for the event was "so the
`alerts/` stack can detect a liquidation". `alerts/` has no event ingestion at all today —
it simulates pool `get_reserve`/`lastprice` calls on a schedule and computes HF from a
config leverage number. Consuming `reserves_sync` means building event subscription there,
which is a separate piece of work rather than part of this fix. The contract now emits the
signal; nothing yet listens for it.

### M-3 — No re-leverage path; leverage ratchets monotonically down

The only operations that *add* leverage are `deposit`, `harvest`, and
`harvest_reinvest`, each levering only the new capital it brings in. Every HF-restoring
operation (`rebalance`, `rebalance_keeper`, `partial_unwind`) only removes it. Since
borrow rate exceeds supply rate structurally on a same-asset loop, HF decays, rebalance
fires, leverage drops — and never recovers.

Reported APY is derived from `config.target_loops`, so it will progressively overstate
what holders actually earn as realized leverage drifts below target. M-1 turns this slow
drift into an instant, attacker-triggered outcome.

**Recommendation.** Add a keeper-gated `releverage()` with its own cooldown that loops
back toward `target_loops` when HF sits comfortably above `orange_hf`. Alternatively,
have the frontend derive displayed APY from *measured* current leverage.

**Resolution (2026-08-05).** Fixed as recommended: `releverage(caller)`
(`lib.rs:591-753`) is keeper-gated, cooldown-limited, and borrows against collateral the
vault already holds — one atomic `[Borrow x, SupplyCollateral x]` pair
(`blend_pool.rs:420-510`) — to restore the leverage an earlier unwind removed. Both legs
are the same amount, so equity `B − D` is invariant and no share price moves; the
accounting entry (`reserves::releverage`) is the measured-delta discipline the other
paths use, and is deliberately a named wrapper over `harvest`'s so the call site records
that the equity is *not* new.

**The keeper gets no discretion over the amount.** That is the asymmetry with
`partial_unwind`, where the keeper's `target_hf` is trusted precisely because it can only
make the position safer. Adding leverage is the unsafe direction, so the target is
derived entirely on-chain from values the keeper cannot influence:

```rust
let design_hf = design_health_factor(config.c_factor, config.target_loops, l_factor)?;
let target_hf = design_hf.max(config.orange_hf + RELEVERAGE_HF_BUFFER);
```

`design_health_factor` (`leverage.rs:214-236`) runs the *same* `compute_totals` the
deposit path runs, so "the leverage this restores" and "the leverage a deposit builds"
cannot drift apart. Capping an HF is capping leverage exactly, not approximately: at
`HF = h` the ratio `B/D` is pinned to `h/cl`, hence `B/E = h/(h − cl)` — the identity is
pinned by `test_design_hf_is_the_leverage_the_deposit_loop_builds` across 60
(c_factor, l_factor, loops) combinations. Both sides carry the same live `l_factor`, so
the restored ratio matches the design regardless of the pool's liability markup.

`compute_releverage` (`leverage.rs:411-481`) is `compute_partial_unwind`'s closed form
with the denominator negated — same numerator `B×cl − t×D`, positive when there is slack
to re-lever, negative when there is debt to repay — rounded a stroop *down* rather than
up, so it lands at or just above the target and never below it.

The floor is the other half. `rebalance` restores HF to exactly `orange_hf`, so a
re-leverage that targeted `orange_hf` would land on the trigger and the next interest
accrual would hand the position straight back — ping-pong every cooldown, for nothing but
fees and rounding. `RELEVERAGE_HF_BUFFER` (0.02) is required both *above* the target
before the entrypoint acts and *below* the current HF for it to be worth acting, so a
position hovering near the band is left alone. 0.02 is sized against what it has to
outlast: HF decays at roughly the borrow/supply spread, so at 4 points that band is ~5
months of drift.

Beyond that: the deposit-path `check_deposit_safety` applies unchanged (re-leveraging
adds borrow demand to the pool exactly as a deposit does, and a pool above 95%
utilization refuses both); the settled position is re-read after the submit and the whole
transaction reverts unless HF actually landed at or above `orange_hf`, rather than
trusting the projection; and the rate limit is one call per `RELEVERAGE_COOLDOWN_LEDGERS`
(~1 day — deleveraging is an emergency, re-levering never is). The cap is a *level*, not
a rate, so repeated calls converge rather than compound. A no-op does not consume the
cooldown.

The cooldown rejection is `DeadlineExpired`, not `NotAuthorized`. The caller *is*
authorized, it is simply too early — L-7's complaint about `rebalance_keeper` — and the
new code does not repeat it. (`StrategyError` is a shared upstream enum with no
"too early" variant; `DeadlineExpired` is the closest honest fit.)

Twelve tests pin the behaviour. Seven pure-math (`test_leverage.rs`): the HF↔leverage
identity above, design HF falling monotonically with loops and scaling with `l_factor`,
landing on the target without moving equity across five positions including a debt-free
one and two under liability markup, the round-trip against `compute_partial_unwind`, the
at/below-target and empty-vault no-ops, the unreachable-target error, and behaviour under
accrued rates. Five integration against the real Blend pool (`test_integration.rs`):

- `test_releverage_restores_design_leverage_after_an_emergency_unwind` — the finding
  itself. Deleverage the 3-loop fixture hard (HF 1.269 → 1.823), show `rebalance` cannot
  undo it (HF unchanged — it only ever unwinds), then `releverage` back to `12690036`
  against a design HF of `12690036` (1e7-scaled — exact to the stroop), with equity and
  the leverage ratio both matching a fresh deposit's.
- `test_releverage_floor_keeps_the_position_clear_of_the_rebalance_band` — on the
  stressed 8-loop fixture, whose design HF (≈1.076) sits *inside* the band, the floor
  binds instead of the design cap, and a `rebalance()` immediately afterwards is a no-op:
  the anti-ping-pong property, asserted rather than argued.
- `test_releverage_noop_without_slack_does_not_consume_cooldown`,
  `test_releverage_cooldown_rate_limits_on_chain` (asserting `DeadlineExpired`
  specifically), `test_releverage_rejects_non_keeper`.

Full suite: 104 passed, 0 failed.

**Off-chain.** `scripts/rebalance_keeper.ts` now drives both sides of the position: below
`orange_hf` it rebalances as before, above it it simulates `releverage` and submits only
when the contract says it would borrow something. It makes no judgement about how much —
a simulated `0` is the authoritative "nothing to do" — so the keeper cannot drift from
the on-chain policy.

**On the APY half of the finding — a correction.** Net APY is *already* derived from
measured leverage, not `target_loops`: `frontend/src/defindex.ts:302` computes
`leverage = collateralValue / totalEquity` from the live position and feeds that to the
APY formula. What did display the configured figure was the vault page's leverage stat
card, which showed `targetLoops` alone; it now shows realized against target
(`3.87× / 4.10×`, `views/vault.ts:360-370`), so the drift is visible rather than implied
away.

**A deployment-parameter defect this surfaced — now fixed.** Building the design HF made
it checkable, and the proposed mainnet parameters did not clear it. At USDC's `l_factor`
of 0.95, `c_factor = 0.90` with `target_loops = 4` opens at HF **1.1312**, below the
configured `orange_hf` of **1.15** — so every fresh deposit would have landed *inside*
the rebalance band, and the first permissionless `rebalance()` would have unwound the
leverage the deposit just built. Running the other three at that same 0.95 (their live
`l_factor`s are still not in the repo, which is why the check reads them from the pool
rather than a table): CETES 1.1233 failed the same way, USTRY 1.1768 and XLM 1.2238
cleared it. Only USDC's figure rests on a confirmed `l_factor`; the rest move with
whatever the pool actually reports.

This was not caused by the M-3 fix — it is pre-existing, and it is a side effect of H-1:
folding `l_factor` into the HF lowered every reported HF by ~5%, which pushed these two
design points under an `orange_hf` chosen before the change.

Resolved by lowering `orange_hf` **1.15 → 1.10** for USDC and CETES in
`deploy_strategy_mainnet.ts` (headroom 0.0312 and 0.0233 against the 0.02 buffer), rather
than by dropping a loop. The trade is explicit: the rebalance trigger now sits 0.10 above
liquidation instead of 0.15, in exchange for keeping 4.10× and 2.73×. It is defensible
*because these are same-asset loops* — collateral and debt are the same token, so that
margin only has to absorb interest-rate drift at roughly the borrow/supply spread, never
an oracle divergence between the two legs, and the keeper polls every ~5 minutes against
a process that moves in months. USTRY and XLM keep 1.15/1.20, but clear the buffer by
only 0.0068 and 0.0038 at an assumed `l_factor` — the preflight against live values is
what settles them.

`preflight()` computes the design HF against each reserve's *live* `l_factor` and fails
the deploy if it does not clear `orange_hf`, with a warning tier for configurations that
clear it by less than the re-leverage buffer. So this class of mistake cannot reach
mainnet again, whatever Blend governance later does to a reserve's `l_factor`.

One operational consequence worth stating plainly: `orange_hf` is written by
`__constructor` and has no setter, so this change applies to *future* deploys only. The
four already-deployed testnet vaults keep 1.15 until redeployed
(`deployed-vaults.testnet.json`); no mainnet vault is deployed yet. Adding an admin
setter for the risk params was considered and rejected here — it would hand the admin a
lever to force deleveraging or to disable rebalancing entirely, which is a larger
privileged surface than the problem warrants.

### M-4 — Broker harvest path has no on-chain settlement floor

**Files:** `lib.rs:648-674`, `:686-734`, `blend_pool.rs:486-499`

`harvest_claim` approves the admin-set `swap_account` for the **entire** claimed BLND
balance with a ~1 day expiry (`saturating_add(17_280)`). The matching
`harvest_reinvest(via_soroswap = false)` leg only checks that the strategy *currently
holds* `amount_in` of the underlying — nothing ties the amount returned to the amount of
BLND that left, and the allowance outlives the transaction by ~17,280 ledgers.

*Severity correction:* originally rated High. It is bounded to harvested yield rather
than principal, and the swap account is a deliberately trusted role, so Medium is the
honest rating. The asymmetry is still the point: the Soroswap leg correctly mandates
`amount_out_min > 0` (`lib.rs:704-706`); the Broker leg has no equivalent floor.

**Recommendation.** Record the claimed BLND amount and a minimum acceptable return at
`harvest_claim` time; assert in `harvest_reinvest` that the underlying balance grew by at
least that floor. Scope the approval to a few ledgers and revoke it at the start of the
next claim.

### M-5 — Trait `harvest` defaults to zero slippage protection

**File:** `lib.rs:259-267`

`harvest(from, None)` — the natural call for any DeFindex-trait caller unaware of this
contract's private 16-byte encoding — swaps the full BLND balance with
`amount_out_min = 0`.

Stellar has no public mempool in the Ethereum sense, so this is meaningfully harder to
exploit than the equivalent on an EVM chain; I would not claim routine sandwich risk. The
argument for fixing it is the asymmetry: `harvest_reinvest` already refuses
`amount_out_min <= 0`, and `harvest` is the older path doing the same swap with the guard
removed.

**Recommendation.** Reject `None`/empty `data`, or derive a floor on-chain from
`router_get_amounts_out` minus a stored max-slippage bps. Deprecating `harvest` in favour
of `harvest_reinvest` is also reasonable.

---

## Low

**L-1 — Public `burn`/`burn_from` strand equity.** `vault_share/lib.rs:185-219` decrement
`total_supply` without the strategy's `total_shares` following, so a self-burner's equity
becomes permanently unclaimable and the invariant asserted at
`test_integration.rs:2317-2321` is silently violated. *Downgraded from Medium:* there is
no attacker profit and no victim other than the burner, and voluntary burn is arguably
correct SEP-41 behaviour. Worth a regression test regardless.

**L-2 — `set_share_token` is re-pointable.** `lib.rs:584-589` is documented as "one-time
wiring" but never consults the existing `has_share_token` helper. *Downgraded from High:*
the strategy is `Upgradable` under the same admin key, so an admin who wanted to drain
the vault would simply upgrade the WASM — re-pointing the token adds no marginal
capability. The real residue is a documentation defect: `vault_share/lib.rs:295-297`
tells holders their balances "can never be rewritten by an admin upgrade", which is not
true while the strategy can be pointed at a different ledger and `set_minter` exists. Fix
the guard (cheap) and fix the comment (important).

**L-3 — Silent fallbacks in the deposit projection.** `lib.rs:176-195` uses
`.unwrap_or(0)` on the scaling multiply and `.unwrap_or(reserves.total_b_tokens)` on the
add, so an overflow silently degrades the projection to "no new supply" — weakening the
check it feeds. Propagate `ArithmeticError`.

**L-4 — `MAX_RATE_SPREAD` is dead code.** `constants.rs:11-15` reserves a 15% spread cap
for `check_deposit_safety` and marks it `#[allow(dead_code)]`. Rate divergence is the
strategy's primary economic risk; implement it or delete it.

**L-5 — `i64::MAX` allowance on full close.** `blend_pool.rs:197` flows into `total_repay`
and hence the `approve` at `:258-263`. It expires at `sequence + 1` with the pool as sole
spender, so exposure is narrow, but capping at outstanding debt is strictly better.

**L-6 — No events on privileged changes; no pause.** `set_keeper`, `admin_set_keeper`,
`set_share_token`, `set_swap_account`, and `set_admin` emit nothing, so `alerts/` cannot
detect a takeover. No emergency pause exists for a pool incident.

**L-7 — Malformed `data` panics.** `Bytes::copy_into_slice` (`lib.rs:263`) panics unless
`data` is exactly 16 bytes — validate length first. Separately, `rebalance_keeper` returns
`NotAuthorized` for a cooldown violation (`lib.rs:452`), which misleads operators.

**L-8 — `unwrap_unchecked` in `admin-sep`.** UB rather than a clean panic if no admin is
set. Both constructors seed it, so it is unreachable today.

---

## Open questions I could not resolve from the repo

**Does Blend net token transfers across a `submit`, or move them per request?** This
matters for withdrawal availability at high utilization. If transfers are per-request,
each `[withdraw, repay]` leg in `submit_unwind` momentarily needs free pool liquidity,
and `MAX_SAFE_UTILIZATION = 0.95` would leave withdrawals fragile exactly when depositors
want out. If Blend nets at the end of `submit`, only the net equity outflow needs
liquidity and the concern largely evaporates.

The code comments contradict each other on this: `blend_pool.rs:22-27` says "for each
supply request it pulls tokens, for each borrow request it sends tokens", while
`blend_pool.rs:46-47` says "the pool sums all supply amounts and does one transfer_from
for the total". The vendored `blend-contract-sdk` is bindings only, so I could not settle
it from source. **I withdrew this as a finding rather than assert it either way** — worth
five minutes against the Blend v2 pool implementation, and worth correcting whichever
comment is wrong.

---

## What holds up well

Recorded because these close common failure modes in this contract class:

- **Measured deltas throughout.** `deposit`, `harvest`, `commit_withdraw`, and
  `deleverage` price off b/d-token deltas read back from the pool rather than intended
  amounts. This defeats the usual class of share-minting rounding attacks.
- **Unit conversion is correct.** `submit_unwind` and `submit_deleverage` convert
  b/d-token quantities to underlying via live rates (`blend_pool.rs:161-171`, `:337-345`)
  instead of assuming rate 1.0.
- **Withdraw rounding runs the right way.** `shares_to_burn` uses `fixed_mul_ceil` while
  token removals use `fixed_mul_floor` (`reserves.rs:150-164`) — against the withdrawer.
- **Inflation attack is structurally dead.** Equity derives from tracked b/d tokens, not
  the contract's token balance, so a donation cannot move the share price. *(M-2's fix
  reconciles those tracked totals against the pool. It clamps downward only, specifically
  so this entry keeps holding — see that Resolution for the reasoning and the test that
  pins it.)*
- **Constructor validates risk parameters** (`lib.rs:119-128`), including the
  `orange_hf > min_hf > 1.0 > c_factor` ordering `compute_partial_unwind` depends on.
- **Deployed parameters are genuinely conservative** — `target_loops` 2–4 against a
  documented ceiling of 20, and `c_factor` set below the pool's on every asset. Much of
  the tail risk in `doc.md`'s 20× discussion is not actually taken.

---

## Suggested remediation order

1. ~~**M-1** — cap `target_hf` for non-keeper callers~~ — done, see *Resolution* above.
2. ~~**H-1** — add `l_factor` to the HF formula~~ — done, see *Resolution* above.
3. ~~**M-2** — reconcile reserves against the pool~~ — done, see *Resolution* above. The
   `alerts/` side of it (consume `reserves_sync`) is still outstanding.
4. **M-4 / M-5** — settlement floor on the Broker path, mandatory slippage on `harvest`.
5. **M-3** — `releverage()`, or make displayed APY track measured leverage. Now the top
   remaining item: with M-1 capped, the ratchet is the residual half of that pair.
6. Lows as cleanup; **L-2**'s comment fix is worth doing promptly since it is a claim made
   to holders.

## Methodology and limits

Source-level review by a single reviewer, no fuzzing, no formal verification, no economic
simulation of the loop under adversarial rate paths. Not a substitute for a professional
audit before mainnet funds are at risk. Deployed parameters were read from
`scripts/deploy_strategy_mainnet.ts`; live pool values (notably per-asset `l_factor`)
were **not** queried and should be confirmed independently.

The `tests-snapshot-source` mainnet-fork harness is the right vehicle for H-1 (fixture
with `l_factor < 1.0`, assert the strategy's HF against Blend's own health check), M-1
(call `partial_unwind` from a stranger with a large target, assert leverage survives), and
M-2 (simulate a liquidation, assert `balance()` against the real pool position). All three
have since been covered this way against the in-repo Blend fixture. M-2's tests model the
seizure as a direct collateral withdrawal rather than a real liquidation auction; running
the same assertions through an actual auction on a mainnet fork would be a stronger proof
and is the one piece still worth adding.
