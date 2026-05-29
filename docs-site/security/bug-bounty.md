---
sidebar_position: 2
---

# Bug Bounty Program

TurboLong runs an active bug bounty program to reward security researchers for responsibly disclosing vulnerabilities.

## Program Details

### Scope

**In Scope:**

- TurboLong smart contracts (`contracts/strategies/blend_leverage/`)
- TurboLong frontend (`frontend/`)
- Alerts service (`alerts/`)
- Deployment infrastructure

**Out of Scope:**

- Blend Protocol (report to Blend Foundation)
- Stellar core protocol (report to Stellar Development Foundation)
- Third-party services (Cloudflare, Wrangler, etc.)
- Social engineering or physical attacks
- Vulnerabilities already known or publicly disclosed

### Eligible Vulnerabilities

#### Tier 1 — Critical (Bounty: $5,000–$50,000)

- Remote code execution in smart contracts
- Theft of user funds or collateral
- Smart contract logic errors causing permanent loss
- Complete system compromise

**Example:** A vulnerability allowing withdrawal of other users' collateral.

#### Tier 2 — High (Bounty: $1,000–$5,000)

- Significant issues affecting security or availability
- Denial of service attacks
- Information disclosure
- Unauthorized state modifications

**Example:** A bug allowing liquidation of positions at arbitrary HF levels.

#### Tier 3 — Medium (Bounty: $100–$1,000)

- Moderate security or privacy issues
- Logic errors with limited impact
- Configuration weaknesses

**Example:** A frontend vulnerability allowing CSRF attacks on transaction submission.

#### Tier 4 — Low (Bounty: $10–$100)

- Minor security issues
- Best practice violations
- Documentation gaps

**Example:** Hardcoded debugging keys in source code.

#### Not Eligible

- Theoretical attacks without proof of concept
- Social engineering or phishing
- Publicly known vulnerabilities
- Feature requests disguised as bugs
- Issues already reported by another researcher
- Vulnerabilities in outdated documentation

## Submission Process

### Step 1: Report Privately

**Email:** security@turbolong.xyz  
**Subject:** `[SECURITY] Description of vulnerability`

**Include:**

1. **Title** — Clear, 1-line description
2. **Severity** — Critical / High / Medium / Low
3. **Description** — What is the vulnerability? How does it manifest?
4. **Proof of Concept** — Steps to reproduce or code example
5. **Impact** — Who is affected? What could an attacker do?
6. **Fix Suggestion** (optional) — Your recommended mitigation

**Example submission:**

```
Subject: [SECURITY] Leverage contract allows re-entrancy in supply_collateral

Severity: Critical

Description:
The leverage contract calls external Blend pool's supply_collateral() without
checking for reentrancy. An attacker could recursively call back into the
leverage contract during supply, manipulating state.

Proof of Concept:
[... steps or code snippet ...]

Impact:
An attacker could drain the contract of all collateral or create
arbitrarily large positions without proper validation.

Suggested Fix:
Add ReentrancyGuard or follow checks-effects-interactions pattern.
```

### Step 2: Confirmation

We will confirm receipt within **24 hours** and provide:

- A ticket number (e.g., `SEC-001`)
- Our analysis and reproduction status
- Estimated timeline for fix

### Step 3: Collaboration

If we need clarification:

- We'll ask follow-up questions via email
- Keep the discussion in private email thread
- Do not share vulnerability details publicly

### Step 4: Fix Development

- We develop and test a patch
- (Optional) We invite you to verify the fix on testnet
- We schedule a mainnet deployment

### Step 5: Disclosure & Award

- We publish a security advisory
- We announce the bounty and researcher (if you consent)
- We process your reward payment

**Note:** If you've disclosed the vulnerability publicly before we patch, we may reduce or eliminate the bounty.

## Payment Terms

### Bounty Eligibility

1. Vulnerability must be **in scope** per above
2. You must be the **first to report** this specific vulnerability
3. Report must include **proof of concept** or reproducible steps
4. You must **not disclose publicly** until we've patched and released an advisory

### Payment Method

- **Mainnet XLM** sent to your Stellar wallet
- **Testnet XLM** for smaller bounties if you prefer
- **USDC** alternative (discuss with team)

### Timeline

- Award amount determined within 7 days of submission
- Payment issued within 14 days of vulnerability fix deployment
- We reserve the right to split awards if multiple researchers contribute to the same fix

### Tax Responsibility

Bounty recipients are responsible for tax implications in their jurisdiction. We provide documentation for your records.

## Hall of Fame

Recognized security researchers who have reported vulnerabilities:

| Researcher                    | Vulnerability | Bounty | Date |
| ----------------------------- | ------------- | ------ | ---- |
| (Program launched March 2026) | —             | —      | —    |

---

## Additional Resources

### Testing & Development

- **Testnet RPC:** https://soroban-rpc-testnet.stellar.org/
- **Friendbot:** https://friendbot.stellar.org (testnet XLM faucet)
- **Contracts:** [GitHub TurboLong](https://github.com/turbolong/turbolong)

### Tools

- **Stellar Lab:** https://lab.stellar.org (TX builder, no wallet needed)
- **Stellar Expert:** https://stellar.expert (contract viewer)

### Documentation

- [Architecture Overview](../architecture/overview.md)
- [Smart Contracts](../architecture/contracts.md)
- [Security & Vulnerabilities](index.md)

## FAQ

**Q: Can I report on behalf of an organization?**

A: Yes. Provide the organization name and primary contact. The bounty will be issued to the organization's wallet.

**Q: What if I find multiple vulnerabilities?**

A: Submit each separately. We'll evaluate each independently and may combine related issues.

**Q: Can I request an NDA?**

A: Yes. For particularly sensitive findings, we can sign an NDA to keep the vulnerability private during development.

**Q: What if Blend Foundation also pays a bounty for the same issue?**

A: You can collect both bounties. TurboLong's bounty is independent of Blend's program.

**Q: How long will my report stay private?**

A: Until we deploy a fix to mainnet and publish an advisory (typically 2–4 weeks).

**Q: Can I test on mainnet?**

A: Yes, but do so carefully. Avoid actions that would harm other users. If a bug causes loss of funds during research, we may adjust the bounty accordingly.

**Q: Who reviews submissions?**

A: TurboLong's security team (2–3 engineers) reviews each report. We may consult external auditors for complex issues.

---

## Contact

- **Security Issues:** security@turbolong.xyz
- **General Questions:** hello@turbolong.xyz

---

**Last updated:** March 2026

Thank you for helping keep TurboLong secure. 🔒
