# Security Policy

> **Program status:** Active — self-hosted. See the full program page at
> [https://turbolong.app/bug-bounty](https://turbolong.app/bug-bounty) for
> submission details and the current payout table.

---

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security reports.**

Send your report by encrypted email to:

```
security@turbolong.app
PGP key: https://turbolong.app/.well-known/security.txt
```

We will acknowledge receipt within **48 hours** and provide a triage decision
within **7 business days**.

### What to include

- Affected contract address or source file
- Step-by-step reproduction (transaction hashes, code snippets, or PoC)
- Impact assessment (funds at risk, scope of effect)
- Your preferred contact for follow-up

---

## In-Scope Targets

| Target | Identifier / Path | Notes |
|---|---|---|
| Blend Leverage Strategy contract | `contracts/strategies/blend_leverage/` | Primary in-scope target |
| Keeper / execute-loop binary | `src/bin/execute_loop.rs` | Off-chain automation |
| APY Alert Worker | `alerts/src/` | Cloudflare Worker + D1 |
| Landing page & frontend | `landing/`, `frontend/` | Front-end XSS / CSP only |

### Out of Scope

- Third-party Blend Protocol contracts (report those to Blend directly)
- Reflector oracle contracts
- Known, already-reported issues documented in `BLEND-BUG-BOUNTY-REPORT.md`
- Theoretical issues with no working proof-of-concept
- Issues in dependencies that are not exploitable in this codebase
- Social-engineering attacks against the team
- Denial-of-service attacks against infrastructure

---

## Severity Tiers & Payouts

Severity is determined following the **Immunefi Vulnerability Severity
Classification System v2.3** adapted for Stellar / Soroban smart contracts.

| Severity | Description | Payout (USDC) |
|---|---|---|
| **Critical** | Direct theft or permanent freeze of ≥ $50k user funds; smart-contract-level remote code execution | $5,000 – $15,000 |
| **High** | Loss or freeze of < $50k user funds; utilization-rate manipulation (similar to Finding 1 in BLEND-BUG-BOUNTY-REPORT.md) | $1,000 – $5,000 |
| **Medium** | Temporary freeze; governance / TVL manipulation; oracle price walking that requires sustained cost | $200 – $1,000 |
| **Low** | Best-practice violations; non-exploitable logic errors; front-end XSS with no fund access | $50 – $200 |
| **Informational** | Code quality, suggestions, gas optimisations with no security impact | Acknowledgement only |

Payouts are made in **USDC on Stellar mainnet** to an address you provide. We
reserve the right to adjust the final payout within the tier based on impact,
quality of the report, and whether a fix was suggested.

---

## Eligibility & Rules

1. You must be the first person to report the issue.
2. You must give us reasonable time to remediate before public disclosure
   (coordinated disclosure, minimum **90 days** unless we mutually agree on a
   shorter timeline).
3. You must not exploit the vulnerability beyond the minimum necessary to
   demonstrate it.
4. You must not perform automated testing against mainnet pools in a way that
   affects other users' funds.
5. Testnet and simulation (via `cargo test -- --nocapture`) are always acceptable.
6. Rewards are not available to residents of sanctioned jurisdictions or to
   current/former team members.

---

## Disclosure Timeline

```
Day 0   → Report received
Day 2   → Acknowledgement sent (48-hour SLA)
Day 7   → Triage decision (severity + in-scope/out-of-scope)
Day 30  → Fix developed and internally audited
Day 60  → Fix deployed to mainnet
Day 90  → Public disclosure (researcher may publish after this date)
```

Both parties may agree to compress or extend this timeline. Critical
vulnerabilities may be fast-tracked at our discretion.

---

## Safe Harbour

We commit that:

- We will not take legal action against researchers who act in good faith and
  comply with these rules.
- We will treat your report confidentially until coordinated disclosure.
- We will credit you in the public post-mortem unless you prefer to remain
  anonymous.

---

## Contact

| Channel | Address |
|---|---|
| Primary (encrypted preferred) | security@turbolong.app |
| Telegram (urgent) | @turbolong_security |
| PGP / security.txt | https://turbolong.app/.well-known/security.txt |

---

## Version

This policy was last updated **2026-05-29** and covers TurboLong v1.x.
