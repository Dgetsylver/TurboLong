# Contributing to Turbolong

Thanks for helping improve Turbolong. This repository includes frontend code, alert worker code, Soroban contracts, analysis scripts, and public docs. Keep changes focused and easy to review.

## Claiming Drips wave issues

1. Find an open Drips wave issue that is not already claimed in the comments.
2. Comment on the issue before starting work. State that you are taking it and summarize the planned approach.
3. Wait only if the issue owner explicitly asks contributors to wait for assignment. Otherwise, keep the work small and submit a PR quickly.
4. If you stop working on the issue, comment again so another contributor can pick it up.
5. Do not submit duplicate implementations for an issue that already has an active PR unless the maintainer asks for an alternate approach.

## Branch naming

Use short, descriptive branch names:

```text
<type>/<issue-number>-<short-description>
```

Examples:

```text
fix/42-vault-health-factor
docs/81-contributing-guide
feat/66-subscribe-rate-limit
```

For bounty or Drips work, including the issue number in the branch name is required.

## Commit messages

Conventional commits are not currently enforced in this repo. Prefer concise, imperative commit messages:

```text
Add APY source breakdown
Fix vault health factor display
Document local quickstart
```

If a conventional prefix helps reviewers, use one of `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.

## Pull request etiquette

Open one PR per issue or tightly related change set. A good PR includes:

- A link to the issue it resolves.
- A short summary of user-visible behavior or documentation changes.
- The exact commands you ran for verification.
- Screenshots or browser smoke notes for UI changes.
- Notes about known existing failures, with enough detail to distinguish them from regressions caused by the PR.

Before opening a PR:

1. Rebase or refresh from the current `main` branch when practical.
2. Keep unrelated formatting churn out of the diff.
3. Do not change secrets, deployment credentials, or workflow permissions unless the issue explicitly asks for it.
4. Confirm generated files and build artifacts are intentionally tracked before committing them.

## Local verification

Run the narrow checks that match the files you changed.

Frontend changes:

```sh
cd frontend
npm run build
```

Alert worker changes:

```sh
cd alerts
npm ci
npx tsc --noEmit
```

Contract and Rust changes:

```sh
cargo test
```

If a broad check fails because of an existing repository issue, include the exact failure in the PR body.

## Code of conduct

This repository does not currently include a dedicated `CODE_OF_CONDUCT.md`. Until one is added, contributors are expected to follow the [GitHub Community Guidelines](https://docs.github.com/en/site-policy/github-terms/github-community-guidelines) and keep issue and PR discussions technical, respectful, and focused.

## CLA

No contributor license agreement is currently required. By opening a PR, you confirm that you have the right to contribute the code or documentation you submit under the repository's existing license terms.

## Security and disclosures

Do not report security-sensitive findings in public issues if they include an exploit path, private key, credential, or reproducible loss scenario. Use the disclosure channel documented by the repository maintainers when available. If no private channel is published yet, ask maintainers where to send a private report without posting exploit details.
