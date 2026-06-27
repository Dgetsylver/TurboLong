# SCF #43 — Tranche 3 Completion Report (DRAFT)

> **Status: draft skeleton.** Code/prep deliverables are complete and linked
> below. Items marked ⛔ are **mainnet-gated** — they require the T1 D1 mainnet
> deploy and the post-launch 14-day watch, and will be filled in at launch.
> Do not file until the ⛔ rows have captured evidence.

**Project:** Turbolong — leveraged-long protocol on Stellar/Blend.
**Track:** Integration ($100k XLM). **Tranche 3.**
**Report date:** _TBD at filing._

---

## Deliverables

| # | Deliverable | Status | Evidence |
|---|-------------|--------|----------|
| T3.1 | Aquarius rate comparison + Best Rate UI | ✅ Built | PR #273 — `aquarius.ts` (find-path client), `history.ts` (server-backed trends), swap-view Aquarius rate + Best Rate badge |
| T3.2 | Aquarius SEP-41 receipt-token listing + trade UX | ✅ Built / ⛔ listing | PR #275 — vault "Trade on Aquarius" CTA + `aquarius_listings.ts` registry + `docs/aquarius-listing-runbook.md`. ⛔ Pool creation, liquidity, **5 verification trades** at launch |
| T3.3 | Compare Pools view (cross-pool APY + Aquarius + history) | ✅ Built | PR #274 — no-wallet Compare view, ranked leveraged net APY, Aquarius rates, 7D/30D/1Y history sparklines, Best Rate badge (issue #11) |
| T3.4 | Structured testing programme | ✅ Built | PR #276 — `docs/testing-programme.md` (6 layers, 80 contract tests, parity, e2e, release gate) |
| T3.5 | Mainnet launch (i18n, status page, onboarding, runbook, report) | ✅ Built / ⛔ launch | This PR — i18n EN/ES/PT-BR + language switcher, onboarding tour, `/status.html`, `docs/launch-runbook.md`, this report. ⛔ Go-live + 14-day-green watch |

## What shipped (verifiable now)

- **Internationalization** — `i18n.ts` runtime + `locales.ts` catalog (EN / ES /
  PT-BR), `data-i18n` wiring across nav, landing, Compare, vault trade card,
  settings; in-app language switcher; persisted choice.
- **Status page** — standalone `/status.html` with live reachability checks
  (Stellar RPC, alerts service, snapshot service, Aquarius API), auto-refresh,
  localized.
- **Onboarding tour** — first-visit multi-step overlay (localized,
  "don't show again").
- **Compare Pools, Aquarius rates, server-backed history** — see T3.1/T3.3.
- **Receipt-token trade UX + listing runbook** — see T3.2.
- **Testing programme** — see T3.4.

Build + lint verified clean on every PR (vite build incl. both HTML entries,
Biome).

## Mainnet-gated (fill at launch) ⛔

- [ ] 4 mainnet vault contract IDs + receipt-token addresses.
- [ ] Per-asset deposit → loop → withdraw tx hashes (Stellar Expert).
- [ ] Aquarius pools created (4) + liquidity seeded + **5 verification trade**
      hashes.
- [ ] Status page screenshot: all services operational.
- [ ] **14 consecutive days** of green operation: keeper healthy, no unhandled
      HF/liquidation alerts, snapshots accruing, TVL/flows logged.
- [ ] DeFindex co-sign; Ledger + iOS/Android wallet sign-offs.

## Links

- Launch runbook: `docs/launch-runbook.md`
- Mainnet deploy: `docs/mainnet-go-live-runbook.md`
- Migration/upgrade: `docs/migration-runbook.md`
- Aquarius listing: `docs/aquarius-listing-runbook.md`
- Testing programme: `docs/testing-programme.md`
- PRs: #273 (T3.1), #274 (T3.3), #275 (T3.2), #276 (T3.4), this PR (T3.5)
