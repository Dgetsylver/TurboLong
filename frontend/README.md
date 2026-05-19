# Frontend

## Purpose

This module is the Vite/TypeScript browser app for Turbolong. It provides wallet connection, Blend leverage actions, DeFindex vault controls, swaps through Stellar Broker, dashboard views, testnet support, and alert subscription UI.

## How To Run

```bash
cd frontend
npm install
npm run dev
```

Production build and preview:

```bash
npm run build
npm run preview
```

`vite.config.ts` uses `/over_leveraging/` as the base path when `GITHUB_PAGES` is set.

## File Map

- `index.html`: app shell, navigation, modals, and static UI structure.
- `src/main.ts`: UI state, wallet flows, view rendering, transaction actions, dashboard, swaps, vault UI, and alerts.
- `src/blend.ts`: Blend pool configuration, reserve fetching, position actions, safety checks, and transaction builders.
- `src/defindex.ts`: DeFindex vault configuration, stats, balances, and transaction builders.
- `src/style.css`: theme variables, layout, component styles, responsive behavior, and modal styling.
- `public/`: static assets served by Vite.
- `vite.config.ts`: Vite build configuration.
