# Security TODO

- 2026-05-19: Removed the committed testnet deployer seed from strategy scripts and retired it from all scripted deploy/test flows. Treat the old testnet key as compromised and do not fund or reuse it. Generate and fund a fresh testnet account, then keep the replacement seed only in `TESTNET_SECRET` via a local `.env.local` file or shell environment.
