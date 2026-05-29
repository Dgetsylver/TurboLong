---
sidebar_position: 1
---

# Contributing to TurboLong

Thanks for helping improve TurboLong. This guide covers branch, issue, commit, and pull request conventions for repository contributions.

## Before You Start

1. **Pick an open issue** that matches the change you want to make
2. **Check current work** — Ensure the issue has no assignee and no active linked pull request
3. **Comment on the issue** before starting so maintainers and other contributors know you're working on it
4. **Keep your change scoped** to the issue acceptance criteria unless a maintainer asks for more

## Branch Naming

Use short, descriptive branch names that include the issue number when there is one.

**Examples:**

```
docs/81-contributing-guide
fix/42-wallet-connect-error
feat/79-architecture-diagram
chore/update-alerts-deploy
```

**Format:** `<type>/<issue-number>-<description>` (lowercase, hyphen-separated)

**Types:**

- `feat/` — New feature
- `fix/` — Bug fix
- `docs/` — Documentation
- `test/` — Test coverage
- `chore/` — Maintenance, dependencies
- `refactor/` — Code restructuring

## Commits

Use clear, focused commits. Conventional Commits are encouraged:

- `docs: add contributing guide`
- `fix: handle missing wallet state`
- `feat: add pool architecture diagram`
- `test: cover leverage simulation edge case`
- `chore: update soroban-sdk to v25`

If a change spans multiple areas, split unrelated work into separate commits or separate pull requests.

**Atomic commits:** Each commit should be independently testable and not break the build.

## Local Checks

Run the checks that match the files you changed.

### For Rust contracts and simulations:

```bash
cd contracts/strategies/blend_leverage

# Run all tests
cargo test

# Run with logging
cargo test -- --nocapture

# Run a specific test
cargo test test_open_position_10x_leverage
```

### For the frontend:

```bash
cd frontend

# Install dependencies
npm install

# Development server
npm run dev

# Build for production
npm run build

# Type check
npx tsc --noEmit
```

### For alerts service:

```bash
cd alerts

npm install
npm run build

# Test locally with Wrangler
wrangler dev
```

### For documentation:

```bash
cd docs-site

npm install
npm run build

npm run start  # Preview locally
```

## Git Workflow

### 1. Create a branch from main

```bash
git checkout -u origin/main
git pull
git checkout -b feat/123-new-feature
```

### 2. Make your changes

Keep commits atomic and well-documented.

### 3. Push to your fork (if external contributor)

```bash
git push origin feat/123-new-feature
```

### 4. Open a pull request

Use the [PR template](.github/pull_request_template.md).

## Pull Request Checklist

Before opening a PR, ensure:

- [ ] Branch name follows convention (`type/issue-number-description`)
- [ ] All commits use clear, conventional messages
- [ ] You ran local checks (`cargo test`, `npm run build`, etc.)
- [ ] You added/updated tests if applicable
- [ ] You updated docs if the feature is user-facing
- [ ] No breaking changes (or documented in PR description)
- [ ] PR title is clear and links the issue

## PR Etiquette

- **One PR per issue** or closely related change
- **Link the issue** in the description with `Closes #<issue-number>` when fully resolved
- **Summarize what changed** and list the checks you ran
- **Include screenshots** for visual UI changes
- **Keep review threads** in the PR (don't move to Discord) so discussion is discoverable
- **Be responsive** to maintainer feedback
- **Avoid force-pushing** during active review (unless necessary for cleanup)

## Review Process

### What Maintainers Look For

1. **Code quality** — Clear, idiomatic, follows project patterns
2. **Testing** — New code includes tests; existing tests still pass
3. **Documentation** — User-facing changes documented; comments explain complex logic
4. **Security** — No hardcoded secrets, proper error handling
5. **Performance** — No obvious bottlenecks; frontend assets optimized

### Common Feedback

**Performance:** "This component renders on every state change. Use `shouldComponentUpdate` or memoization."

**Clarity:** "This logic is hard to follow. Can you extract it into a named helper function?"

**Testing:** "What happens if the RPC is down? Please add an error case test."

### Approval & Merge

- PRs require at least **1 approval** from a maintainer
- **Status checks** must pass (CI tests, lint, build)
- Maintainers will merge when ready (don't self-merge)

## Contributor License Agreement

This repository does not currently include a CLA (Contributor License Agreement). By submitting a PR, you agree that:

1. Your contributions are your own original work
2. You grant TurboLong an irrevocable license to use your contribution
3. You represent that you have the right to license the code

A formal CLA may be added in the future. Check the README or CONTRIBUTING.md for updates.

## Code of Conduct

This repository does not have a project-specific Code of Conduct. Until one is added, contributors are expected to follow the [GitHub Community Guidelines](https://docs.github.com/en/site-policy/github-terms/github-community-guidelines) and keep discussion respectful, focused, and constructive.

## Common Tasks

### Adding a New Pool to TurboLong

1. Update pool config in `frontend/src/blend.ts` (add pool contract address)
2. Update `contracts/strategies/blend_leverage/src/constants.rs` (pool metadata)
3. Update docs: [Blend Protocol Pools](../architecture/blend-protocol.md)
4. Add pool-specific tests to `test_integration.rs`
5. Update UI pool selector in `frontend/index.html`
6. PR should include: code changes, tests, docs, and screenshot of new pool in UI

### Fixing a Security Vulnerability

1. **Do not open a public PR** — Report privately via [security.txt](/.well-known/security.txt)
2. Maintainers will create a private security advisory
3. You and maintainers collaborate on a fix in a private branch
4. Once fixed and tested, the advisory is published
5. Public PR/commit is made referencing the advisory

### Adding a Feature for a New User Type

1. Check [UX Research](../analysis/ux-audit.md) for context on that persona
2. Implement the feature (code + tests)
3. Update [User Guide](../guides/user-guide.md) or create new guide
4. Link from relevant architecture or guide page
5. Update [UX Research](../analysis/ux-audit.md) with implementation notes

## Questions?

- **GitHub Issues** — For bugs or feature requests
- **Discord** — For questions and discussion
- **Email** — founders@turbolong.xyz for sensitive matters

Thanks for contributing! 🚀
