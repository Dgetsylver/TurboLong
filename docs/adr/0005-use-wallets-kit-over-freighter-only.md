# 0005: Use Stellar Wallets Kit Instead Of Freighter-Only Wallet Support

## Status

Accepted

## Context

Freighter is an important Stellar wallet, but Turbolong is intended for a wider group of Stellar users. Restricting wallet support to a single extension would exclude users who prefer Lobstr, xBull, Albedo, Hana, or other compatible wallets.

The frontend also needs a consistent API for connect, disconnect, account switching, network selection, and transaction signing across mainnet and testnet.

## Decision

Turbolong will use Stellar Wallets Kit as the primary wallet integration layer instead of building a Freighter-only flow. Freighter remains supported through the kit, but it is not the only wallet path.

Wallet-specific behavior should be hidden behind the kit where possible. The app should still verify the selected network and surface clear errors when a wallet cannot sign or is on the wrong network.

## Consequences

This improves wallet reach and reduces future integration work as the wallet ecosystem changes. It also makes the UI less dependent on one provider's extension API.

The tradeoff is another dependency and a need to test across multiple wallet modules. Connection errors, network mismatches, and unsupported wallet capabilities must be handled consistently so broader support does not create ambiguous transaction failures.
