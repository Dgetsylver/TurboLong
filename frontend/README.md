# Frontend

This directory contains the Vite front end for TurboLong's leveraged strategy dashboard.

## Purpose

The app connects to Stellar wallets, switches between supported networks, shows pool and vault state, and builds the transactions needed for deposits, withdrawals, swaps, and leverage actions.

## How To Run

From the repository root:

```bash
cd frontend
npm install
npm run dev
```

Useful commands:

```bash
npm run build
npm run test
npm run preview
```

Notes:

- `npm run dev` starts the Vite development server.
- `npm run build` produces a production bundle.
- `npm run test` runs the parity test suite.

## File Map

| File | Role |
| --- | --- |
| `index.html` | Vite entry HTML. |
| `package.json` | Front-end scripts and dependencies. |
| `vite.config.ts` | Vite configuration. |
| `public/favicon.svg` | Browser favicon. |
| `public/logo.svg` | Project logo asset. |
| `public/_redirects` | Deployment routing rules. |
| `src/main.ts` | Application bootstrap, wallet integration, and UI orchestration. |
| `src/blend.ts` | Blend pool data fetching, math, and transaction builders. |
| `src/defindex.ts` | DeFindex vault helpers and transaction builders. |
| `src/style.css` | App styling. |
| `test/parity.test.ts` | Rate parity test between the TypeScript and Rust calculators. |

