# Security Policy

TurboLong is a Stellar/Blend leverage strategy project. This policy defines a draft public bug-bounty surface for issue #88 and gives researchers a safe disclosure path while the maintainers choose the final platform and fund the program.

## Program status

This policy is **not a promise to pay until maintainers publish the final external program URL and funding source**. Until then, please treat the table below as the proposed reward schedule for launch planning.

| Item | Status |
| --- | --- |
| External platform | TBD by maintainers: Immunefi, HackerOne, or a self-hosted intake |
| Disclosure contact | TBD by maintainers; use the platform inbox once live |
| Launch scope | `contracts/strategies/blend_leverage`, keeper/loop execution scripts, rate/health-factor math, and deployment configuration |
| Out of scope by default | Social engineering, phishing, physical attacks, spam, denial-of-service against public RPCs, vulnerabilities that require leaked secrets, and issues only present in local debug/test fixtures |

## In-scope assets

The initial launch scope should stay narrow enough to triage well:

- `contracts/strategies/blend_leverage/**`
  - leverage/repay/withdraw accounting
  - Blend pool and reserve integration assumptions
  - oracle/rate-health-factor math used for safety decisions
- `src/bin/execute_loop.rs` and `src/bin/simulate.rs`
  - transaction construction and signer safety
  - unsafe loop/repay sequencing
  - simulation/readiness checks before submitting transactions
- `scripts/mainnet_loop.ts`, `scripts/testnet_loop.ts`, and deployment scripts
  - keeper automation behavior
  - environment validation
  - accidental mainnet/testnet mix-ups
- Public documentation that could cause users to take materially unsafe actions.

## Severity guide

| Severity | Examples | Proposed reward tier |
| --- | --- | --- |
| Critical | Direct loss of user funds; unauthorized withdrawal/borrow; strategy action that can force liquidation from a normal user position; signer/key exposure path in production flow | USD 10,000-50,000 |
| High | Incorrect health-factor/rate math that can trigger unsafe leverage; keeper/deployment bug that can submit harmful transactions; oracle/reserve mismatch with credible loss path | USD 2,500-10,000 |
| Medium | Safety check bypass with limited preconditions; inaccurate risk display that can materially mislead users; denial of strategy closure without fund loss | USD 500-2,500 |
| Low | Hardening gaps, missing validation, confusing docs, or issues with no direct user-fund impact | USD 100-500 |

Maintainers should set final amounts before launch and record whether rewards are paid in fiat, XLM, USDC, or another asset.

## Safe harbor

Researchers acting in good faith should:

1. Use local tests, simulations, forks, or testnet deployments whenever possible.
2. Avoid accessing, modifying, draining, or locking funds they do not own.
3. Avoid disrupting public RPC endpoints, frontend hosting, or third-party services.
4. Report privately through the chosen program inbox before public disclosure.
5. Give maintainers a reasonable remediation window before publication.

The maintainers should not pursue legal action against good-faith research that follows this policy and avoids harm. This is a draft safe-harbor statement and should be reviewed before the external program goes live.

## Report template

A useful report should include:

- Affected commit, contract, script, or deployment target.
- Severity estimate and why it matters economically.
- Preconditions and exact reproduction steps.
- Minimal proof of concept using local tests, simulation, fork, or testnet where possible.
- Expected vs actual behavior.
- Impact estimate: funds at risk, affected users, liquidation/interest-rate effect, or operational failure mode.
- Suggested fix or mitigation, if known.
- Reporter contact and payout preference once the program is live.

## Disclosure-pipeline launch test

Before marking issue #88 done, run one dry-run report through the selected intake channel:

1. Create a harmless test report titled `Disclosure pipeline test - no vulnerability`.
2. Confirm the report reaches the triage owner.
3. Confirm severity, duplicate, and payout decisions can be recorded.
4. Confirm private notes are not exposed publicly.
5. Confirm the final public advisory path is documented.

## Maintainer launch checklist

- [ ] Choose platform: Immunefi, HackerOne, or self-hosted.
- [ ] Publish the final disclosure contact or platform URL.
- [ ] Confirm reward currency, funding source, and maximum payout.
- [ ] Confirm the in-scope commit/tag and deployed contract addresses.
- [ ] Confirm coordinated-disclosure timelines and embargo rules.
- [ ] Run the disclosure-pipeline launch test above.
