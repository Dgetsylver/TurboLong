# Requirements Document

## Introduction

This feature adds automated dependency maintenance and security auditing to the TurboLong project. It covers two complementary concerns:

1. **Dependabot** — GitHub's built-in dependency update bot, configured to open weekly pull requests for both the npm packages (`frontend/`, `alerts/`, `scripts/`) and the Cargo workspace.
2. **cargo-audit** — a Rust security advisory scanner that runs as a step inside the existing Rust CI job, blocking merges when known vulnerabilities are detected in Cargo dependencies.

Together these ensure that dependency drift and known CVEs are surfaced automatically without manual intervention.

---

## Glossary

- **Dependabot**: GitHub service that monitors dependency manifests and opens pull requests when newer or patched versions are available.
- **cargo-audit**: CLI tool from the RustSec project that checks `Cargo.lock` against the RustSec Advisory Database for known vulnerabilities.
- **CI_Job**: The GitHub Actions workflow job that compiles and tests Rust code.
- **Dependabot_Config**: The `.github/dependabot.yml` file that controls Dependabot's schedule and scope.
- **Cargo_Workspace**: The root `Cargo.toml` and its member crates, including `contracts/strategies/blend_leverage`.
- **npm_Ecosystem**: The three npm package manifests located at `frontend/package.json`, `alerts/package.json`, and `scripts/package.json`.
- **Advisory_Database**: The RustSec Advisory Database consulted by cargo-audit to identify vulnerable crate versions.
- **PR**: A GitHub pull request.

---

## Requirements

### Requirement 1: Dependabot Configuration File

**User Story:** As a maintainer, I want a committed Dependabot configuration file, so that GitHub automatically opens weekly dependency-update PRs without any manual setup.

#### Acceptance Criteria

1. THE Dependabot_Config SHALL exist at `.github/dependabot.yml` in the repository root.
2. THE Dependabot_Config SHALL declare a `cargo` ecosystem entry targeting the repository root directory (`/`) on a weekly schedule with `day: monday`.
3. THE Dependabot_Config SHALL declare an `npm` ecosystem entry targeting the `frontend/` directory on a weekly schedule with `day: monday`.
4. THE Dependabot_Config SHALL declare an `npm` ecosystem entry targeting the `alerts/` directory on a weekly schedule with `day: monday`.
5. THE Dependabot_Config SHALL declare an `npm` ecosystem entry targeting the `scripts/` directory on a weekly schedule with `day: monday`.
6. WHEN Dependabot evaluates the configuration, THE Dependabot_Config SHALL be valid according to the GitHub Dependabot configuration schema version 2.

---

### Requirement 2: Automated Weekly Dependency PRs

**User Story:** As a maintainer, I want Dependabot to open pull requests on a weekly cadence, so that dependency updates are batched and reviewable rather than arriving continuously.

#### Acceptance Criteria

1. WHEN a newer version of a Cargo dependency is available, THE Dependabot SHALL open a PR against the default branch no more than once per week per package ecosystem.
2. WHEN a newer version of an npm dependency is available in any of the three npm directories (`alerts/`, `frontend/`, `scripts/`), THE Dependabot SHALL open a PR against the default branch no more than once per week per directory.
3. WHILE a Dependabot PR for a specific dependency update (same package, same target version) is already open, THE Dependabot SHALL not open a duplicate PR for that same dependency update.
4. IF a week has passed and a newer version of a dependency is available at a version greater than the version targeted by any currently open Dependabot PR for that dependency, THE Dependabot SHALL open a new PR for that newer version.
5. WHEN Dependabot evaluates whether a newer version is available, THE Dependabot SHALL consider a version "newer" only if it is a non-pre-release semver version strictly greater than the currently resolved version in the lock file.

---

### Requirement 3: cargo-audit Step in Rust CI

**User Story:** As a maintainer, I want cargo-audit to run automatically on every push and pull request, so that known Rust dependency vulnerabilities are caught before code is merged.

#### Acceptance Criteria

1. THE CI_Job SHALL include a `cargo-audit` step that executes after the Rust toolchain is installed and before the build/test steps, triggered on both `push` and `pull_request` events.
2. WHEN `cargo audit` detects one or more advisories matching dependencies in the root `Cargo.lock`, THE CI_Job SHALL mark the `cargo-audit` step as failed (non-zero exit code) using `continue-on-error: true` so that all remaining steps in the job continue to execute.
3. WHEN `cargo audit` detects no advisories, THE CI_Job SHALL complete the audit step with exit code 0 and continue to subsequent steps.
4. THE CI_Job SHALL install `cargo-audit` using `cargo install cargo-audit --locked`, and MAY cache the resulting binary under a cache key that includes the `cargo-audit` version to avoid redundant installs on repeated runs.
5. WHEN the `cargo-audit` step fails, THE CI_Job SHALL surface the advisory details (affected crate name, advisory ID, and severity) in the GitHub Actions step log so that maintainers can identify the affected crate and advisory ID.

---

### Requirement 4: CI Workflow Trigger Coverage

**User Story:** As a maintainer, I want the Rust CI job (including cargo-audit) to run on all pull requests and pushes to the main branch, so that no vulnerable code can be merged undetected.

#### Acceptance Criteria

1. WHEN a push event occurs on the `main` branch, THE CI_Job SHALL be triggered and execute all steps including `cargo-audit`.
2. WHEN a pull request targeting the `main` branch is opened or updated, THE CI_Job SHALL be triggered and execute all steps including `cargo-audit`.
3. WHEN a Dependabot PR is opened for a Cargo dependency, THE CI_Job SHALL run on that PR with `read` permissions granted to the `contents` scope so that the workflow can access the updated `Cargo.lock` and execute the `cargo-audit` step.
4. WHEN the `cargo-audit` step detects one or more advisories, THE CI_Job SHALL exit with a non-zero status code, causing the overall workflow run to be marked as failed and blocking merge of the triggering PR.
