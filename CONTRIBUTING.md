# Contributing to TurboLong

Thanks for helping improve TurboLong. This guide covers the branch, issue, commit,
and pull request conventions for repository contributions, including Drips wave
issues.

## Before you start

1. Pick an open issue that matches the change you want to make.
2. For Drips wave work, prefer issues labeled `drips`, `Stellar Wave`, and a
   size label such as `size:S`.
3. Check that the issue has no assignee and no active linked pull request.
4. Confirm the work is not already merged. Branch your work from the latest
   `main`, and check that no open or merged PR already covers the issue before
   starting — a closed issue means the work is done, not available.
5. Comment on the issue before starting so maintainers and other contributors
   know you are working on it.
6. Keep the change scoped to the issue acceptance criteria unless a maintainer
   asks for more.

## Branch naming

Use short, descriptive branch names that include the issue number when there is
one. **Always work on a dedicated feature branch — never open a pull request
from your fork's `main` branch.** A PR from `main` mutates every time you push
to your fork and cannot be updated independently of unrelated work, so such PRs
will be closed with a request to resubmit from a feature branch.

Examples:

- `docs/81-contributing-guide`
- `fix/42-wallet-connect-error`
- `feat/79-architecture-diagram`
- `chore/update-alerts-deploy`

## What not to commit

Pull requests that contain any of the following will be closed without review:

- **Build artifacts or dependencies.** Never commit `node_modules/`, Rust
  `target/` directories, `dist/`, or other generated output. These are listed
  in `.gitignore`; run `git status` before committing and confirm your diff
  contains only source changes. A PR whose file count is dominated by
  `node_modules/` or `target/` is unreviewable.
- **Scratch or debug files.** Remove temporary scripts (`tmp_*.js`, one-off
  inspection files) before opening a PR.
- **Secrets.** Never commit private keys, `.env` files, or API tokens. The
  secret-scanning workflow will flag these, but it is your responsibility to
  keep them out.
- **Duplicate submissions.** Do not open the same change under multiple titles
  or branches. One change, one pull request.

## Commits

Use clear, focused commits. Conventional Commits are encouraged when they fit
the change:

- `docs: add contributing guide`
- `fix: handle missing wallet state`
- `feat: add pool architecture diagram`
- `test: cover leverage simulation edge case`

If a change spans multiple areas, split unrelated work into separate commits or
separate pull requests.

## Local checks

Run the checks that match the files you changed.

For Rust contracts and simulations:

```bash
cargo test
```

For the frontend:

```bash
cd frontend
npm install
npm run build
```

For alert worker changes:

```bash
cd alerts
npm install
npm run build
```

If a check cannot be run locally, explain why in the pull request.

## Pull request etiquette

- Open one pull request per issue or closely related change.
- Link the issue in the description with `Closes #<issue-number>` when the PR
  fully resolves it.
- Summarize what changed and list the checks you ran.
- Include screenshots or diagrams for visual UI or documentation changes.
- Keep review comments in the pull request thread so the discussion stays
  discoverable.
- Be responsive to maintainer feedback and avoid force-pushing during active
  review unless it is necessary.

## Drips wave workflow

Drips wave issues are public contribution opportunities. To keep that workflow
clear:

1. Claim the issue by commenting on it before starting work.
2. Mention the issue number in your branch name and pull request description.
3. Match the issue's acceptance criteria exactly before expanding the scope.
4. Mark the pull request as ready for review only after you have run the relevant
   checks or documented why a check was skipped.
5. Wait for maintainer review, merge, and any Drips-specific confirmation before
   assuming the contribution is eligible for a reward.

Any reward, payout, or Drips distribution should be handled through the official
project or Drips workflow requested by the maintainers.

## Code of Conduct and CLA

This repository does not currently include a project-specific Code of Conduct or
Contributor License Agreement. Until one is added, contributors are expected to
follow the [GitHub Community Guidelines][github-community-guidelines] and keep
discussion respectful, focused, and constructive.

If the project adds a CLA or a maintainer requests one for a contribution, complete
that process before the pull request is merged.

[github-community-guidelines]: https://docs.github.com/en/site-policy/github-terms/github-community-guidelines
