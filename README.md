# TurboLong

TurboLong is a multi-module Stellar project that combines a Soroban leverage strategy, alerting infrastructure, CLI utilities, and a Vite front end.

## Module Docs

| Directory | README | Purpose |
| --- | --- | --- |
| `contracts/` | [contracts/README.md](contracts/README.md) | Soroban strategy contract for the leveraged Blend vault. |
| `alerts/` | [alerts/README.md](alerts/README.md) | Cloudflare Worker that sends APY alerts and manages subscriptions. |
| `scripts/` | [scripts/README.md](scripts/README.md) | Helper scripts for debugging, deployment, oracle lookups, and simulations. |
| `src/` | [src/README.md](src/README.md) | Rust CLI binaries for simulations, rate calculations, and execution flows. |
| `frontend/` | [frontend/README.md](frontend/README.md) | Browser UI for interacting with the leveraged strategy. |

## Quick Start

1. Open the README for the area you want to work on.
2. Install the dependencies for that module.
3. Run the module-specific command listed in its README.

If you are exploring the project for the first time, start with:

- [contracts/README.md](contracts/README.md)
- [frontend/README.md](frontend/README.md)
- [src/README.md](src/README.md)
