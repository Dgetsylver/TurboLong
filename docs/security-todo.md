# Security TODO

## Rotated Credentials

### Testnet deployer key — leaked in source (closed by #43)

- **File affected**: `scripts/deploy_strategy.ts`
- **Issue**: Testnet deployer secret key was hardcoded in plain text.
- **Fix applied**: Key removed; script now reads `DEPLOY_SECRET_KEY` from the environment.
  Store the key in `.env.local` (git-ignored) and inject before running:
  ```
  DEPLOY_SECRET_KEY=S... npx tsx scripts/deploy_strategy.ts
  ```
- **Rotation required**: The key ending in `...E527` was exposed in git history and must be
  considered compromised. Generate a new testnet keypair and fund it via Friendbot before the
  next deploy. Do **not** reuse the leaked key even on testnet.
