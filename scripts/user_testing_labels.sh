#!/usr/bin/env bash
# Milestone 4 (Testing) — creates or updates the GitHub labels user-testing
# findings are triaged with (docs/user-testing/README.md § Triage). Idempotent:
# `--force` updates colour/description on labels that already exist.
#
# Run: bash scripts/user_testing_labels.sh            (repo inferred from git remote)
#      bash scripts/user_testing_labels.sh -R owner/repo
set -euo pipefail

label() { gh label create "$1" --color "$2" --description "$3" --force "${@:4}"; }

label "user-testing"         "1d76db" "Finding from a moderated user-testing session (Milestone 4)" "$@"

label "severity:S1-critical" "b60205" "Fund-loss/liquidation risk, misread risk, or blocks the journey — fix before next release" "$@"
label "severity:S2-high"     "d93f0b" "Task failed or needed help; serious confusion — fix this cycle" "$@"
label "severity:S3-medium"   "fbca04" "Friction or self-recovered error — schedule" "$@"
label "severity:S4-low"      "c5def5" "Cosmetic, wording, translation polish — backlog" "$@"

label "flow:onboard"         "bfdadc" "Landing, wallet connect, network, tour, language" "$@"
label "flow:deposit"         "bfdadc" "Opening a leveraged position or depositing into a vault" "$@"
label "flow:monitor"         "bfdadc" "Dashboard, health factor, APY/PnL, alerts, status" "$@"
label "flow:exit"            "bfdadc" "Remove funds, close position, vault withdraw, receipt-token trade" "$@"
