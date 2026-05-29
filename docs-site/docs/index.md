---
slug: /
---

# TurboLong

Welcome to TurboLong — leveraged trading on Stellar via Blend Protocol.

## What is TurboLong?

TurboLong is a **leveraged trading platform built on Stellar's Blend Protocol**. It enables users to open amplified long positions on Stellar-native assets (USDC, CETES, USTRY, TESOURO, XLM, etc.) through atomic recursive supply/borrow loops — all in a single transaction.

### Key Capabilities

- **Up to 12.9× leverage** on supported assets across multiple Blend pools (Etherfuse, Fixed, YieldBlox)
- **Vault automation** (DeFindex-powered) for managed, auto-rebalancing leverage positions
- **APY alerts** via Cloudflare Workers + D1 subscriptions
- **Multi-wallet support** (Freighter, xBull, Albedo, Lobstr, Hana)
- **Sub-5-second finality** thanks to Stellar's fast settlement
- Built with TypeScript/Vite frontend, Soroban (Rust) smart contracts, and responsive CSS-only UI

## Quick Links

- [Getting Started](guides/getting-started.md) — Set up your first leveraged position
- [How It Works](architecture/leverage-mechanism.md) — Understand the leverage math
- [Risk Management](guides/user-guide.md) — Learn about health factors and liquidation
- [Security Reports](../security/vulnerability-reports.md) — Audit findings and advisories

## Supported Assets

| Asset   | Pool(s)                     | Max Leverage | Pool Depth |
| ------- | --------------------------- | ------------ | ---------- |
| USDC    | Etherfuse, Fixed, YieldBlox | 12.9×        | ~$115K     |
| CETES   | Etherfuse                   | 6.25×        | ~$45K      |
| USTRY   | Etherfuse                   | 6.25×        | ~$12K      |
| TESOURO | Etherfuse                   | 6.25×        | ~$8K       |
| XLM     | Fixed, YieldBlox            | 4×           | ~$80K      |

## How to Start

1. **Connect a wallet** — Support for Freighter, xBull, Albedo, Lobstr, and Hana
2. **Select an asset** — Choose from USDC, CETES, USTRY, TESOURO, or XLM
3. **Set leverage** — Use the slider to choose 1–12.9× (depending on asset and pool)
4. **Monitor health factor** — Keep your HF > 1.05 to avoid liquidation
5. **Earn yield** — Borrow interest + BLND emissions

## Documentation

- **[Guides](guides/)** — Tutorials and how-tos
- **[Architecture](architecture/)** — Technical deep dives
- **[Analysis](analysis/)** — Profitability studies, UX research, risk analysis
- **[Contributing](contributing/guidelines.md)** — How to contribute

## Community

- **Discord** — [Join our community](https://discord.gg/turbolong)
- **GitHub** — [View source code](https://github.com/turbolong/turbolong)
- **Twitter** — [@turbolong](https://twitter.com/turbolong)

---

**Disclaimer:** TurboLong is a leveraged trading tool. Leverage amplifies both gains and losses. Borrowed positions can be liquidated, resulting in partial or total loss of principal. Do not use funds you cannot afford to lose.
