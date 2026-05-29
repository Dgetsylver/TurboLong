---
sidebar_position: 3
---

# Research & Resources

## Aquarius DEX Crosslisting Research

This page links to research on Stellar DEX opportunities and cross-chain asset integration.

### Aquarius Protocol Overview

**Aquarius** is a cross-chain bridge and liquidity protocol on Stellar. It enables:

- Bridging assets from Ethereum, Solana, and other chains
- Native yield farming on Stellar via leverage
- Cross-chain arbitrage opportunities

### Key Insights for TurboLong

1. **USDC Liquidity** — Aquarius bridges USDC from Ethereum, making it available on Stellar Mainnet
2. **Stable Pair Opportunities** — Cross-chain stablecoin pairs enable low-risk yield arbitrage
3. **Bridge Risk** — Aquarius smart contracts carry execution risk; understand bridge mechanisms before using

### Further Reading

- [Aquarius Documentation](https://aquarius.fi)
- [Stellar Bridge Overview](https://developers.stellar.org/docs/)
- [Related internal research](../../docs/aquarius-dex-crosslisting-research.md)

## Blend Protocol Resources

### Official Links

- **[Blend Protocol Mainpage](https://blend.capital)** — Protocol overview and governance
- **[Blend Documentation](https://blend-docs.stellar.org)** — Developer guide
- **[Blend Governance Forum](https://governance.blend.capital)** — Proposal voting

### Interest Rate Model

Blend uses a **three-kink piecewise linear model** with:

- Base rate (`r_base`)
- Two slope parameters (`r_one`, `r_two`)
- Penalty slope (`r_three`) above max utilization
- Rate modifier (dynamic adjustment based on time spent above target)

For detailed math, see: [Leverage Mechanism & Math](../architecture/leverage-mechanism.md)

### Recent Governance Decisions

| Date     | Proposal                    | Impact                              |
| -------- | --------------------------- | ----------------------------------- |
| Mar 2026 | Utilization cap enforcement | Added max_util check to withdrawals |
| Feb 2026 | Post-YieldBlox recovery     | Enhanced oracle circuit breakers    |
| Jan 2026 | BLND emissions increase     | +2% supply APY on core pools        |

Monitor governance: [https://governance.blend.capital](https://governance.blend.capital)

## Stellar Ecosystem

### Developer Resources

- **[Stellar Developers](https://developers.stellar.org)** — Full SDK documentation
- **[Soroban Smart Contracts](https://developers.stellar.org/docs/learn/smart-contracts)** — Rust contract dev
- **[Stellar Horizon API](https://developers.stellar.org/docs/data/rpc/)** — RPC endpoints for querying

### Tools

| Tool                                                 | Purpose                                |
| ---------------------------------------------------- | -------------------------------------- |
| [Stellar Expert](https://stellar.expert)             | Block explorer + contract viewer       |
| [Stellar Lab](https://lab.stellar.org)               | Transaction builder (no wallet needed) |
| [SoroSwap](https://soroswap.finance)                 | DEX for asset swaps                    |
| [Friendbot (Testnet)](https://friendbot.stellar.org) | Free testnet XLM faucet                |

### Networks

- **Mainnet** (Production)
  - RPC: https://soroban-rpc.stellar.org/
  - Network: `Public Global Stellar Network ; September 2015`

- **Testnet** (Development)
  - RPC: https://soroban-rpc-testnet.stellar.org/
  - Network: `Test SDF Network ; September 2015`
  - Faucet: [Friendbot](https://friendbot.stellar.org)

## Security & Audits

### TurboLong Audits

- **[Security Audit Report](../security/vulnerability-reports.md)** — Known vulnerabilities and mitigations
- **[Bug Bounty Program](../security/bug-bounty.md)** — How to report security issues

### Blend Protocol Security

- **Blend Contract Audits** — [Available at Blend governance](https://governance.blend.capital)
- **Known Issues** — See [Vulnerability Reports](../security/vulnerability-reports.md) for recent findings

### Best Practices

- Always test on testnet before mainnet
- Monitor your health factor weekly
- Never use funds you can't afford to lose
- Keep wallet private keys in a secure location

## Related Projects

### Similar Protocols

| Protocol      | Chain                       | Focus                        |
| ------------- | --------------------------- | ---------------------------- |
| **Aave**      | Ethereum, Polygon, Arbitrum | Largest lending protocol     |
| **Compound**  | Ethereum                    | Algorithmic interest rates   |
| **dYdX**      | Ethereum, Solana            | Derivatives + margin trading |
| **YieldBlox** | Stellar                     | Community-managed pools      |

### On Stellar

- **[YieldBlox](https://yieldblox.finance)** — DAO-governed lending (post-recovery)
- **[SoroSwap](https://soroswap.finance)** — Automated market maker (AMM)
- **[Aquarius](https://aquarius.fi)** — Bridge + cross-chain liquidity

## Community

- **[Discord](https://discord.gg/turbolong)** — TurboLong community
- **[Stellar Discord](https://discord.gg/stellar)** — Stellar dev community
- **[Blend Discord](https://discord.gg/blend)** — Blend protocol chat

## Research Papers & Articles

- **[The Three-Kink Interest Rate Model](https://governance.blend.capital/t/interest-rate-model-design/123)** — Blend's rate function explained
- **[Liquidation Mechanisms in DeFi](https://arxiv.org/abs/2104.02443)** — Academic research on liquidation economics
- **[Oracle Security in Lending Protocols](https://blog.compound.finance/oracle-security-design/)** — Compound's approach (relevant to Blend)

---

**Note:** This research section is maintained as-is from the existing codebase. For the latest findings and resources, check governance forums and community channels.
