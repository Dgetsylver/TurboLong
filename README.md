# Turbolong

Leveraged yield positions on [Blend Protocol](https://blend.capital) pools — single-click recursive lending loops on Stellar.

## Quick start (5 minutes)

**Prerequisites:** Docker, Node.js ≥ 20, Git.

```bash
git clone https://github.com/Dgetsylver/TurboLong.git
cd TurboLong
bash dev/start.sh
```

Open **http://localhost:5173** in your browser. That's it.

`dev/start.sh` will:
1. Pull and start a `stellar/quickstart` container (Soroban RPC on port 8000, Horizon on 8001).
2. Install frontend dependencies.
3. Launch the Vite dev server at `http://localhost:5173`.
4. Start the Alerts Cloudflare Worker at `http://localhost:8787` (requires `wrangler` — skipped if absent).

To skip the local node and use Stellar Testnet instead:

```bash
bash dev/start.sh --testnet
```

### Environment variables

Copy `dev/.env.example` to `.env.local` in the repo root and fill in any overrides:

| Variable | Default | Description |
|---|---|---|
| `STELLAR_RPC_PORT` | `8000` | Local Quickstart Soroban RPC port |
| `STELLAR_HORIZON_PORT` | `8001` | Local Quickstart Horizon port |
| `VITE_RPC_URL` | _(network default)_ | Override RPC URL in the frontend |
| `VITE_HORIZON_URL` | _(network default)_ | Override Horizon URL in the frontend |
| `CLOUDFLARE_ACCOUNT_ID` | — | Needed to deploy the Alerts worker |
| `CLOUDFLARE_API_TOKEN` | — | Needed to deploy the Alerts worker |

---

## Project layout

```
frontend/      Vite + TypeScript UI
  src/
    main.ts    App entry — wallet, views, interactions
    blend.ts   Blend Protocol pool helpers
    defindex.ts DefIndex vault helpers
  .storybook/  Storybook config
  src/stories/ Component stories

alerts/        Cloudflare Worker — position health alerts
scripts/       Off-chain utility scripts (Node.js)
src/           Rust binaries (rate_calc, simulate, execute_loop)
dev/           Local dev quickstart scripts
e2e/           Playwright end-to-end tests
.github/       CI workflows
```

---

## Running tests

### Unit tests (Vitest)

```bash
cd frontend && npm test
```

### Rust parity tests

```bash
cargo test
```

### End-to-end tests (Playwright)

```bash
cd e2e
npm install
npm run test:e2e
```

Screenshots are captured automatically on failure and saved to `e2e/test-results/`.

---

## Storybook

Isolate and iterate on UI components in isolation:

```bash
cd frontend
npm install
npm run storybook        # dev server at http://localhost:6006
npm run build-storybook  # static build
```

Components covered: HF Badge, Leverage Slider, Pool Card, Asset Picker, APR Card, Toast, Stat Card.

---

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `rust-lint.yml` | Push/PR touching `src/**` or `Cargo.toml` | `cargo clippy -D warnings` + `cargo fmt --check` |
| `parity.yml` | Pull request | Rust parity test suite |
| `e2e.yml` | Push/PR touching `frontend/**` or `e2e/**` | Playwright E2E suite; uploads screenshots on failure |
| `deploy.yml` | Push to non-main branches touching `frontend/**` | Deploys frontend to GitHub Pages |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
