# Implementation Plan: Dependabot + cargo-audit

## Overview

Create two YAML configuration files: `.github/dependabot.yml` to enable weekly automated dependency PRs across all four ecosystems, and `.github/workflows/rust-ci.yml` to add a Rust CI workflow with cargo-audit, caching, build, and test steps.

## Tasks

- [x] 1. Create `.github/dependabot.yml`
  - [x] 1.1 Write the Dependabot configuration file
    - Create `.github/dependabot.yml` using schema version 2
    - Add a `cargo` entry targeting directory `/` with `schedule.interval: weekly` and `schedule.day: monday`
    - Add an `npm` entry targeting `frontend/` with the same weekly Monday schedule
    - Add an `npm` entry targeting `alerts/` with the same weekly Monday schedule
    - Add an `npm` entry targeting `scripts/` with the same weekly Monday schedule
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

- [x] 2. Create `.github/workflows/rust-ci.yml`
  - [x] 2.1 Write the workflow trigger and permissions block
    - Set `on.push.branches: [main]` and `on.pull_request.branches: [main]`
    - Set `permissions.contents: read` at the workflow level
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 2.2 Write the toolchain and checkout steps
    - Add `actions/checkout@v4` as the first step
    - Add `dtolnay/rust-toolchain@stable` to install the stable Rust toolchain
    - _Requirements: 3.1_

  - [x] 2.3 Write the cargo-audit install and cache steps
    - Define a workflow-level env var `CARGO_AUDIT_VERSION` (e.g. `"0.21.0"`)
    - Add an `actions/cache@v4` restore step with id `cache-audit`; cache key `${{ runner.os }}-cargo-audit-${{ env.CARGO_AUDIT_VERSION }}`; cached paths `~/.cargo/bin/cargo-audit`, `~/.cargo/.crates.toml`, `~/.cargo/.crates2.json`
    - Add a `cargo install cargo-audit --locked` step gated with `if: steps.cache-audit.outputs.cache-hit != 'true'`
    - Add an `actions/cache@v4` save step after install, using the same key and paths
    - _Requirements: 3.4_

  - [x] 2.4 Write the cargo-audit execution step
    - Add a step that runs `cargo audit` with `continue-on-error: true`
    - Ensure this step comes after toolchain install and before build/test steps
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 4.4_

  - [x] 2.5 Write the build and test steps
    - Add a `cargo build` step after the audit step
    - Add a `cargo test` step after the build step
    - _Requirements: 3.1_

- [x] 3. Checkpoint — review both files
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- No tasks are marked optional (`*`) because there are no test sub-tasks — this feature consists entirely of static YAML configuration files with no business logic to unit-test or property-test.
- Each task references specific requirements for traceability.
- The cache key design ensures a version bump in `CARGO_AUDIT_VERSION` automatically invalidates the old cache entry.
- `continue-on-error: true` on the audit step means advisories surface as a visible failure while still allowing build and test output to appear in the same run.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1"] },
    { "id": 1, "tasks": ["2.2"] },
    { "id": 2, "tasks": ["2.3"] },
    { "id": 3, "tasks": ["2.4"] },
    { "id": 4, "tasks": ["2.5"] }
  ]
}
```
