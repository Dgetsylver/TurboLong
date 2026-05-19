# TurboLong

TurboLong contains the Stellar frontend, alert worker, simulator, and Blend leverage strategy code for the project.

## Pre-commit Hooks

This repo uses an opt-in [Lefthook](https://lefthook.dev/) config to run the same local checks before commit that contributors should run before opening a PR.

Install the hooks from the repo root:

```sh
npx --yes lefthook install
```

The pre-commit hook runs staged-file scoped checks:

- Frontend changes run `npm run build` and `npm run typecheck` from `frontend/`.
- Rust changes under `src/`, `contracts/`, or `tests/` run `rustfmt --check` on the staged Rust files.

For emergency commits, bypass hooks with either:

```sh
git commit --no-verify
```

or:

```sh
LEFTHOOK=0 git commit
```
