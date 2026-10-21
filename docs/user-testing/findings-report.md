# Turbolong User Testing — Findings Report

**Milestone 4 — Testing.** Results of the moderated testing programme defined in
[`README.md`](README.md): sessions weighted toward LatAm and DeFi-native users,
covering the full deposit → monitor → exit journey.

> **Status: awaiting sessions.** The *Results* section is generated from the
> session records and the `user-testing` issues. Everything else is written at
> synthesis (README § Synthesis). Replace each _italic prompt_ below, and delete
> this note when the report is final.

**Sessions run:** _YYYY-MM-DD → YYYY-MM-DD_ · **Facilitators:** _initials_ ·
**Network:** _testnet / mainnet_ · **App build:** _commit SHA tested_

---

## 1. Summary

_Three to five sentences a reviewer can act on: whether people can get through
deposit → monitor → exit unaided, where they can't, and whether they understand
the liquidation risk they're taking. Quote the headline numbers from §3: end-to-end
unaided completion, the weakest task, risk-comprehension correct rate, mean SUS,
and S1/S2 counts._

## 2. Method

- Protocol, tasks and scoring as in [`README.md`](README.md); task catalogue in
  [`protocol.json`](protocol.json).
- _Deviations from the plan (dropped or reordered tasks, sessions on a different
  network or build, recruitment shortfalls) and why._
- Raw records: [`sessions/`](sessions/) (pseudonymised). Findings:
  [`user-testing` issues](https://github.com/Dgetsylver/TurboLong/issues?q=label%3Auser-testing).

## 3. Results

Regenerate with `npx tsx scripts/user_testing_report.ts` after every session
and after every triage pass.

<!-- BEGIN GENERATED: scripts/user_testing_report.ts — do not edit by hand -->

_Generated 2026-10-21 from 0 session record(s) (0 completed, 0 partial, 0 no-show) and 0 `user-testing` issue(s)._

### Milestone gates

| Gate | Target | Actual | Status |
|---|---|---|---|
| Completed sessions | ≥ 12 | 0 | ❌ FAIL |
| LatAm share | ≥ 60% | 0/0 (—) | ❌ FAIL |
| DeFi-native share | ≥ 60% | 0/0 (—) | ❌ FAIL |
| Sessions in es | ≥ 4 | 0 | ❌ FAIL |
| Sessions in pt-BR | ≥ 3 | 0 | ❌ FAIL |
| Mobile sessions | ≥ 3 | 0 | ❌ FAIL |
| Every assisted/failed task traced to a finding | 0 untraced | 0 | ✅ PASS |
| Every finding has 1 severity + ≥1 flow label | 0 unlabelled | 0 | ✅ PASS |

_No sessions recorded yet — sample, task and SUS tables appear once records land in `docs/user-testing/sessions/`._

<!-- END GENERATED -->

## 4. Key findings

_One entry per S1 and S2 finding, most severe and most frequent first. S3/S4 stay
in the generated table above._

<!--
### [S1] <short problem statement> — #<issue>
- **Seen in:** n/N sessions (cohorts). **Task:** D2.
- **What happened:** observed behaviour plus one verbatim quote (original + translation).
- **Why it matters:** the consequence on real funds or on trust.
- **Recommendation:** the fix, and how we'll know it worked (which task or check should improve).
-->

## 5. Audit hypotheses: confirmed or not?

These hypotheses come from two places, and neither involved real users: the
heuristic persona audit in #282, and the code inspection in the README (§9
*Known issues going in*). The sessions test the ones that matter most for this
journey. Mark each one **Confirmed** (observed, with the linked `user-testing`
issue), **Not observed**, or **Contradicted** (users handled it fine).

| Hypothesis | Source | Watched in | Verdict | Evidence |
|---|---|---|---|---|
| Jargon (HF, c_factor, liquidation) not understood before choosing leverage | #282 | D2, C1, C2 | _—_ | _—_ |
| Pre-transaction preview doesn't make liquidation risk clear | #282 | D2, C2 | _—_ | _—_ |
| Alerts are hard to find (only under ⚙ → *Set up alerts*) | #282 | M3 | _—_ | _—_ |
| Users believe alerts watch their own position (they model a leverage bracket) | README §9 | C4 | _—_ | _—_ |
| Auto-rebalance keeper not understood by depositors | #282 | M2, C3 | _—_ | _—_ |
| Screens stay "disconnected" after connecting a wallet or switching network | README §9 | O1 | _—_ | _—_ |
| Extra trustline signature and 2–3 wallet pop-ups confuse first-time openers | README §9 | D2 | _—_ | _—_ |
| Missing / mixed-language strings in ES and PT-BR | #282 | all ES/PT sessions | _—_ | _—_ |
| Layout or signing breaks at phone width | #282 | mobile sessions | _—_ | _—_ |
| Dashboard vault "Net APY +0.0%" alarms or misleads | README §9 | M1, M2 | _—_ | _—_ |
| Status page not discoverable | #282 | M5 | _—_ | _—_ |

## 6. What worked

_Things participants did unaided and liked. Keep these so fixes don't regress them._

## 7. Recommendations and next steps

_Prioritised: S1 fixes before the next release, then S2 work this cycle, then
anything to re-test. Link each item to its issue._

## 8. Limitations

- _Small n: intervals are wide; read differences under ~20 points as directional._
- _Testnet: no real money at stake, so risk behaviour may be bolder than on mainnet._
- _Recruitment through our own channels skews toward people already friendly to Stellar._
- _Facilitators are also the builders. Mitigated by the neutral script and a second note-taker._
