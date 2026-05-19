# Blend Leverage Strategy

This module contains the Soroban-side helpers for a Blend leverage-loop strategy. A deposit is expanded into an atomic sequence of Blend pool requests:

1. supply the initial asset as collateral,
2. borrow against the collateral,
3. re-supply the borrowed amount,
4. repeat until the configured loop target is reached,
5. finish with a final supply-only step.

The request sequence is built by `src/leverage.rs` and submitted through `src/blend_pool.rs`.

## Loop Cap

`MAX_LOOP_PAIRS` is set to 20, which produces at most 21 steps: 20 supply/borrow pairs plus one final supply-only step.

The cap is intentional rather than a precision limit. It keeps the request vector, WASM stack usage, and transaction gas bounded when a caller supplies `target_loops`. Without a cap, a large loop target could grow the Blend submit request list until it becomes too expensive or exceeds Soroban execution limits.

The cap also matches the fixed-size arrays used by the test-only `compute_loop_pairs` helper. Production code uses `compute_step` iteratively so it can build bounded request vectors without allocating larger arrays.

If this becomes configurable later, the init argument should still be validated against a conservative upper bound before any request vector is built.
