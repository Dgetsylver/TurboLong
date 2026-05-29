---
slug: /
---

# Security & Vulnerability Reports

TurboLong takes security seriously. This section documents known vulnerabilities, our responsible disclosure process, and our bug bounty program.

## Reporting Security Issues

**Do not open a public GitHub issue for security vulnerabilities.**

Instead:

1. **Email:** security@turbolong.xyz
2. **GPG Key:** [Available at /.well-known/security.txt](/security.txt)
3. **Response time:** We aim to respond within 24 hours

### Responsible Disclosure

We follow the [Coordinated Vulnerability Disclosure](https://www.cisa.gov/coordinated-vulnerability-disclosure) process:

1. You report a vulnerability privately
2. We confirm receipt and begin investigation
3. We develop and test a fix
4. We release a security patch
5. We publish a disclosure advisory

### Non-Disclosure Agreement (NDA)

For particularly sensitive findings, we can sign an NDA to keep the vulnerability private during development.

## Known Vulnerabilities

### Current (Active)

None. All discovered vulnerabilities have been patched.

### Patched (Historical)

- **CVE-2026-XXXXX** — [Blend Protocol Utilization Rate Manipulation](vulnerability-reports.md) (Fixed March 14, 2026)
- **CVE-2026-XXXXX** — YieldBlox Oracle Manipulation (Fixed February 22, 2026)

## Audit History

| Date    | Auditor          | Scope                                                    | Report                                           |
| ------- | ---------------- | -------------------------------------------------------- | ------------------------------------------------ |
| Q1 2026 | [Audit Firm TBD] | Leverage contract, fork-test against live Etherfuse pool | [Link](https://turbolong.xyz/audits/q1-2026.pdf) |
| Q2 2026 | [Pending]        | Full suite (contracts, frontend, alerts)                 | Pending                                          |

## Bug Bounty Program

See [Bug Bounty](bug-bounty.md) for details on eligible vulnerabilities, reward tiers, and submission process.

### Quick Stats

- **Total Bounties Paid:** $0 (program launched March 2026)
- **Pending Submissions:** 0
- **Average Response Time:** < 24 hours

## Security Best Practices for Users

### Personal Security

1. **Never share your private key** — Not even with TurboLong team
2. **Use a hardware wallet** — Ledger, Trezor, or equivalent
3. **Verify URLs** — Always check `turbolong.xyz` in address bar
4. **Test first** — Try positions on testnet before mainnet
5. **Monitor your position** — Check health factor weekly

### Position Management

1. **Keep HF > 1.20** — Never let it drop to 1.05
2. **Diversify assets** — Don't put all capital in one pool
3. **Size appropriately** — Only deploy what you can afford to lose
4. **Monitor rates** — Watch for rate spikes that could liquidate you

## Infrastructure Security

### Smart Contracts

- **Immutable:** Deployed via Soroban; cannot be modified after deployment
- **Audited:** Third-party security review completed
- **Testnet-first:** All features tested extensively before mainnet

### Frontend

- **HTTPS only:** All traffic encrypted
- **Content Security Policy:** Strict CSP headers prevent injection attacks
- **No tracking cookies:** We don't collect personal data

### Data Storage

- **Alerts database:** Encrypted at rest; automatic daily backups
- **No private keys:** We never store or access your wallet keys
- **Cloudflare Workers:** Isolated, serverless execution

## Incident Response

If we discover a security issue affecting users:

1. We **immediately disable the affected feature** (if possible)
2. We **investigate the root cause** and develop a fix
3. We **test extensively** on testnet
4. We **deploy the fix** to mainnet
5. We **publish a security advisory** with impact assessment and guidance

### Recent Incidents

None yet (program launched March 2026).

## Compliance

- **Not a financial institution** — TurboLong is a smart contract UI; we don't hold your funds
- **Not FDIC insured** — Smart contract risks cannot be insured by traditional means
- **Not financial advice** — We don't recommend positions; you choose your own leverage
- **User responsibility** — You assume all risks when using TurboLong

## Disclaimers

**⚠️ High Risk:** Leverage trading carries extreme liquidation risk. You can lose your entire position.

**⚠️ Smart Contract Risk:** No code is 100% safe. TurboLong and Blend Protocol carry smart contract risk.

**⚠️ Oracle Risk:** Price feeds could be manipulated or delayed. Always verify prices from multiple sources.

**⚠️ Liquidity Risk:** Pools could become illiquid, preventing position closure.

Use only funds you can afford to lose. Do not use leverage unless you understand the mechanics and risks.

## Security Contacts

| Role                  | Contact                |
| --------------------- | ---------------------- |
| **Security Issues**   | security@turbolong.xyz |
| **General Inquiries** | hello@turbolong.xyz    |
| **Legal**             | legal@turbolong.xyz    |

---

**Last updated:** March 2026

[← Back to Security Reports](vulnerability-reports.md) | [Bug Bounty →](bug-bounty.md)
