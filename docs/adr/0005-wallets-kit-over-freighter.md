# ADR 0005 — Stellar Wallets Kit over Freighter-Only Integration

Date: 2026-05-30

## Status

Accepted

## Context

The Turbolong frontend needs to connect to Stellar wallets for transaction
signing. Two approaches were evaluated:

1. **Freighter-only** — integrate directly with the Freighter browser
   extension API (`@stellar/freighter-api`).
2. **Stellar Wallets Kit (SWK)** — use `@creit-tech/stellar-wallets-kit`,
   which provides a unified modal and adapter layer for multiple wallets
   (Freighter, xBull, Albedo, Lobstr, Hana, and others).

At the time of this decision, Freighter holds the majority of Stellar browser
wallet market share, but xBull and Albedo have meaningful user bases,
particularly among DeFi power users.

## Decision

Use **Stellar Wallets Kit** (`@creit-tech/stellar-wallets-kit`) as the sole
wallet integration layer. The following modules are registered:

- `FreighterModule`
- `xBullModule`
- `AlbedoModule`
- `LobstrModule`
- `HanaModule`

SWK's `authModal` is used for connection; `signTransaction` for signing.

## Consequences

**Positive**
- Single integration point supports five wallets with no per-wallet code.
- SWK's modal provides a consistent UX regardless of which wallet the user
  has installed.
- Adding new wallets requires only registering an additional module.

**Negative**
- Adds a dependency on `@creit-tech/stellar-wallets-kit`; if the library is
  abandoned, all wallet integrations are affected simultaneously.
- SWK abstracts wallet-specific features (e.g. hardware wallet flows in
  Ledger-enabled wallets) that may need custom handling in the future.
