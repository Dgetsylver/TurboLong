# Turbolong UX/UI Audit — 100 User Personas

## What Is Turbolong?

Turbolong is a **leveraged trading platform built on Stellar's Blend Protocol**. It enables users to open amplified long positions on Stellar-native assets (USDC, CETES, USTRY, TESOURO, XLM, etc.) through atomic recursive supply/borrow loops — all in a single transaction. Key capabilities:

- **Up to 12.9× leverage** on supported assets across multiple Blend pools (Etherfuse, Fixed, YieldBlox)
- **Vault automation** (DeFindex-powered) for managed, auto-rebalancing leverage positions
- **APY alerts** via Cloudflare Workers + D1 subscriptions
- **Multi-wallet support** (Freighter, xBull, Albedo, Lobstr, Hana)
- **Sub-5-second finality** thanks to Stellar's fast settlement
- Built with a TypeScript/Vite frontend, Soroban (Rust) smart contracts, and a responsive CSS-only UI

The interface centers on a trade view with asset tabs, a leverage slider, real-time health-factor (HF) monitoring, interest-rate curves, and a vault dashboard.

---

## The 100 Personas

Organized into 13 categories. Each persona includes: **background/personality**, **what they look for**, and **specific UX/UI improvement suggestions**.

---

## Category 1 — DeFi Power Users (Personas 1–10)

These users have deep DeFi experience, often across multiple chains. They want speed, data density, and precision controls.

---

### 1. Marcus — The Yield Optimizer
**Background:** 32-year-old ex-quant trader turned full-time DeFi participant. Manages $500k+ across 6 protocols simultaneously. Uses spreadsheets to track positions hourly.
**Looking for:** Maximum data density, granular controls, exportable data, no hand-holding.
**UX/UI Suggestions:**
- Add a **keyboard shortcut system** (e.g., `L` to open leverage slider, `C` to close position) — removes mouse dependency for fast actions.
- Surface the **3-kink interest rate curve parameters** (r_base, r_two, util_target) in a toggleable "Advanced Stats" panel without needing to read docs/leverage-model.md.
- Provide a **CSV/JSON position export** button in the dashboard for external analysis.
- Show **projected liquidation price** as a dollar/asset value alongside the health factor number.

---

### 2. Priya — The Multi-Chain Arbitrageur
**Background:** 28-year-old developer who runs bots across Ethereum, Solana, and now Stellar. Moves quickly; abandons UIs that require more than 3 clicks.
**Looking for:** API surface, low-latency interface, no loading spinners blocking action.
**UX/UI Suggestions:**
- Add a **public REST/GraphQL API** for position reads so bots can monitor without scraping the UI.
- Replace full-page loading states with **skeleton screens** so the UI layout is stable while data loads.
- Show **estimated transaction fee** before submission, not just success/failure post-submission.
- Add a **"Copy TX hash"** button directly on the transaction confirmation toast.

---

### 3. Diego — The Leverage Connoisseur
**Background:** 35-year-old who treats leverage trading as his primary income. Has blown up accounts before and now obsesses over HF management.
**Looking for:** Real-time HF updates as he adjusts leverage, clear liquidation warnings, granular position sizing.
**UX/UI Suggestions:**
- The leverage slider should update the **HF preview in real-time** (before submission) — currently it may only show final state.
- Add **color-coded HF zones**: green (>2.0), yellow (1.5–2.0), orange (1.2–1.5), red (<1.2) with persistent visual indicator in the header while a position is open.
- Allow **manual HF target input**: type `1.8` and the slider auto-sets to the corresponding leverage.
- Add a **"Safe Max"** button that auto-sets leverage to the maximum that keeps HF above a user-defined threshold.

---

### 4. Kenji — The Gas Optimizer
**Background:** 40-year-old DeFi veteran from Ethereum who moved to Stellar specifically for low fees. Extremely cost-aware; tracks fee-to-profit ratios.
**Looking for:** Fee transparency, batch operations, cost breakdowns.
**UX/UI Suggestions:**
- Display **total XLM fee cost** for each operation (open loop, close loop, increase/decrease) prominently — not buried in transaction details.
- Add a **fee history tab** showing total fees paid over time.
- Offer a **"Dry run" mode** that simulates the transaction and shows exact fee without submitting.
- Show **net APY after fees** as the default metric, not gross APY.

---

### 5. Fatima — The Protocol Researcher
**Background:** 29-year-old who works at a DeFi analytics firm. Uses Turbolong to test strategies and validate on-chain data against her own models.
**Looking for:** Raw data access, protocol stats transparency, audit-friendly UI.
**UX/UI Suggestions:**
- Add a **"Protocol Stats" page** showing pool utilization rates, total supplied/borrowed per asset, and backstop balance — accessible without connecting a wallet.
- Surface **contract addresses** for every pool/asset directly in the UI with one-click copy.
- Include a **"Verify on-chain"** link that opens the relevant Stellar Expert transaction for every operation.
- Show **timestamp and block number** on all historical position events.

---

### 6. Aleksandr — The Algorithmic Strategist
**Background:** 36-year-old who runs fully automated trading systems. Uses UI only to verify bot outputs and spot anomalies.
**Looking for:** Consistent layout (no UI shuffles on data updates), reliable state, clear error codes.
**UX/UI Suggestions:**
- Assign **stable DOM IDs** to all key data fields (HF value, APY, TVL) to make scraping/automation reliable.
- Return **structured error objects** (not just toast messages) with machine-readable error codes for failed transactions.
- Add a **webhook URL field** in settings where users can receive position event notifications.
- Show a **"Last updated"** timestamp on all cached values so bots can detect stale data.

---

### 7. Yuki — The Volatility Trader
**Background:** 31-year-old who actively opens and closes positions multiple times a day based on rate fluctuations. Speed is everything.
**Looking for:** One-click close, rapid re-entry, minimal confirmation steps for trusted actions.
**UX/UI Suggestions:**
- Add **"Quick Close" as a single prominent button** on open positions — not buried in a submenu.
- Implement **"Repeat last action"** functionality — e.g., re-open the same position with the same parameters.
- Allow **saving position presets** (asset + pool + leverage combination) for one-click re-entry.
- Show **estimated close proceeds** before confirming a close operation.

---

### 8. Lena — The Cross-Protocol Optimizer
**Background:** 33-year-old who actively compares rates between Blend, Aqua, and other Stellar protocols. Switches allocation weekly.
**Looking for:** Comparative rate data, protocol comparison tools, easy pool switching.
**UX/UI Suggestions:**
- Add a **"Compare Pools" view** that shows side-by-side APY and HF requirements for the same asset across Etherfuse, Fixed, and YieldBlox pools.
- Show **rate trend arrows** (↑↓) next to APY values, with 24h and 7d change percentages.
- Allow **pool switching without closing position** (where protocol mechanics allow) or at least show the migration cost.
- Integrate a **"Best Rate" badge** on the pool/asset combination offering the highest net APY.

---

### 9. Carlos — The Leverage Scalper
**Background:** 27-year-old day trader who opens dozens of small positions to scalp funding rate differentials. Hates pagination; wants everything on one screen.
**Looking for:** Dense position list, bulk operations, minimal navigation depth.
**UX/UI Suggestions:**
- Add **bulk position management**: select multiple positions, close all, or adjust all leverage simultaneously.
- Make the **position table sortable** by asset, leverage, HF, and unrealized P&L.
- Add **"Collapse to compact view"** for the position list (single row per position vs. expanded card).
- Show a **portfolio-level aggregate HF** that weights all positions together.

---

### 10. Niamh — The Testnet Power User
**Background:** 30-year-old smart contract auditor who uses testnet to validate edge cases before recommending the protocol to clients.
**Looking for:** Testnet parity with mainnet, clear environment labeling, easy environment switching.
**UX/UI Suggestions:**
- Add a **persistent banner/badge** in testnet mode that's impossible to miss (current network switcher is subtle).
- Ensure **all mainnet features have testnet equivalents** — the vault automation should be testable on testnet.
- Add a **"Reset testnet position"** button that automates the Friendbot + trustline setup flow.
- Show **testnet explorer links** (not mainnet) when in testnet mode — currently may link to the wrong network.

---

## Category 2 — DeFi Beginners (Personas 11–20)

Users new to DeFi or crypto. Need clear explanations, safety guardrails, and confidence-building UX.

---

### 11. Tyler — The Curious Newcomer
**Background:** 22-year-old college student who heard about crypto yield. Has a Coinbase account but has never used a non-custodial wallet.
**Looking for:** Plain-language explanations, guided onboarding, no jargon overload.
**UX/UI Suggestions:**
- Add an **interactive onboarding tour** (6–8 steps) that walks through: connect wallet → understand HF → open a small position → monitor it.
- Replace all acronyms (HF, APY, TVL, c_factor) with **hover tooltips** that explain them in one plain sentence.
- Add a **"What does this mean?"** expandable section beneath each metric on the dashboard.
- Implement a **"Beginner Mode"** that hides Expert features and limits leverage to 2× until the user opts in.

---

### 12. Sophie — The Passive Income Seeker (Entry Level)
**Background:** 26-year-old nurse who wants her savings to earn more than a bank account. Has $5k to deploy. Risk-averse but open to learning.
**Looking for:** Simple "put money in, get yield out" UX, clear risk disclosure, no math required.
**UX/UI Suggestions:**
- Lead with the **Vault product** for this persona — reframe the vault landing page as "Earn enhanced yield automatically" rather than "Managed leverage."
- Show **expected monthly dollar return** on a user-specified deposit amount, not just APY%.
- Add a **risk rating system** (1–5 stars with explanation) for each pool/asset combination.
- Place a **"Start with $X, earn ~$Y/month"** calculator prominently on the homepage.

---

### 13. Jordan — The Crypto-Curious Student
**Background:** 20-year-old finance student. Understands TradFi margin trading but has never used Stellar or Soroban.
**Looking for:** Familiar financial concepts mapped to DeFi equivalents, learning resources.
**UX/UI Suggestions:**
- Add **"This is like [TradFi concept]"** analogies throughout — e.g., "Health Factor works like a margin maintenance requirement."
- Include a **"How Turbolong Works" explainer page** with a step-by-step diagram of the supply/borrow loop.
- Add a **simulated paper trading mode** so beginners can practice without real funds.
- Link to **Stellar and Blend documentation** contextually (e.g., when the user first encounters the pool selector).

---

### 14. Amara — The First-Time DeFi User
**Background:** 35-year-old teacher who attended a crypto workshop and wants to try Blend-based yield.
**Looking for:** Step-by-step guidance, safety confirmation at every step, easy exit path.
**UX/UI Suggestions:**
- Add **"Is this safe for me?" checklist** before the first transaction: Do you understand leverage risk? Do you have funds to maintain the position?
- Show a **"What happens if I don't act?"** section near the HF warning — explain auto-liquidation in plain terms.
- Make the **disclaimer modal** more visual — a simple 3-panel "What could go wrong" flow instead of dense text.
- Add a prominent **"Close my position safely"** guide accessible from the dashboard at all times.

---

### 15. Ben — The Skeptic
**Background:** 29-year-old software developer unfamiliar with DeFi. Distrusts anything that sounds "too good to be true." Reads every line of UI text critically.
**Looking for:** Honesty about risks, no hidden fees, source of yield clearly explained.
**UX/UI Suggestions:**
- Add a **"Where does the yield come from?"** explainer page — honest about the mechanics of leverage loops and borrowing interest arbitrage.
- Show **both upside and downside scenarios** in the APY calculator: "If rates move against you, your net yield could be negative."
- Make **smart contract addresses and audit reports** findable from the UI in one click.
- Remove any language that sounds like guaranteed returns — replace with ranges and "estimated" qualifiers.

---

### 16. Clara — The Cautious Experimenter
**Background:** 42-year-old accountant who wants to dip a toe in DeFi with $200 max. Afraid of making an irreversible mistake.
**Looking for:** Small-amount minimums, undo/cancel flow, clear pre-confirmation summaries.
**UX/UI Suggestions:**
- Show a **clear pre-transaction summary** screen: "You are about to supply X, borrow Y, at Z× leverage. This will cost W XLM in fees."
- Add **minimum deposit labeling** so users know the smallest viable position size.
- Make the **"Cancel"** button on every modal as prominent as "Confirm."
- Add a **"What if I change my mind?"** FAQ item on the confirmation screen explaining how to unwind.

---

### 17. Mohammed — The Mobile-First Beginner
**Background:** 23-year-old in a developing market; his smartphone is his primary internet device. First crypto experience.
**Looking for:** Mobile-optimized UI, minimal data usage, works on slow connections.
**UX/UI Suggestions:**
- **Optimize the critical path** (connect wallet → open position) to work on 3G speeds — lazy-load interest rate chart data.
- Make all **tap targets at least 48px** to prevent mis-taps on small screens.
- Add an **offline-capable state** that shows cached position data even without a connection.
- Translate the UI to **top 5 user languages** (Spanish, Portuguese, Mandarin, French, Arabic) with a language selector.

---

### 18. Isabella — The Yield Chaser (No Background)
**Background:** 31-year-old who saw Turbolong advertised on a Stellar forum. Has a wallet but has only ever held XLM.
**Looking for:** "What's the best thing to do right now" guidance, minimal decision fatigue.
**UX/UI Suggestions:**
- Add a **"Best opportunity today"** banner on the homepage: "CETES at 18% net APY — [Open Position]."
- Implement a **recommendation engine** that suggests pool/asset/leverage based on user risk preference (collected via a 3-question onboarding quiz).
- Remove the need to understand pool names (Etherfuse, Fixed, YieldBlox) upfront — abstract them as "Conservative Pool," "Balanced Pool," "High Yield Pool."
- Add an **expected APY tracker** that shows whether current rates are above or below historical average.

---

### 19. Raj — The Spreadsheet-First Analyst (Beginner)
**Background:** 38-year-old retail investor who models everything in Excel before acting. Not comfortable with live execution until he's validated his model.
**Looking for:** Parameter simulation tools, downloadable rate history, "what if" calculator.
**UX/UI Suggestions:**
- Add a **leverage simulator**: input asset, leverage, capital — output monthly yield, liquidation threshold, and break-even rate move.
- Provide **downloadable historical rate data** (CSV) for each pool/asset going back to launch.
- Show an **interest rate sensitivity table**: "If utilization goes from 70% to 90%, your net APY changes from X% to Y%."
- Add a **"Model this scenario"** button that pre-fills the simulator with current live rates.

---

### 20. Elena — The TikTok-Referred User
**Background:** 19-year-old who discovered Turbolong through a crypto influencer. Expects things to "just work" and has no patience for errors.
**Looking for:** Frictionless onboarding, instant visual feedback, shareable results.
**UX/UI Suggestions:**
- Add **"Share your position"** functionality — a shareable card showing "I'm earning X% APY on Turbolong."
- Make wallet connection a **single-tap flow** — the current multi-step wallet selection modal can be collapsed for returning users.
- Add **success animations** (subtle) when a position is opened successfully — satisfying positive feedback.
- Ensure all **error messages** are human-readable ("Your wallet doesn't have enough XLM for fees" not "insufficient_fee_error").

---

## Category 3 — Traditional Finance Background (Personas 21–30)

Users from banking, institutional finance, or traditional investing who bring TradFi mental models.

---

### 21. Richard — The Retired Banker
**Background:** 58-year-old former commercial banker. Understands credit risk, interest rate spreads, and balance sheet mechanics intimately.
**Looking for:** Familiar financial framing, counterparty risk disclosure, institutional-grade documentation.
**UX/UI Suggestions:**
- Frame the HF as a **"Coverage Ratio"** with a TradFi analogy — "Similar to a loan-to-value ratio; keep above 1.5 for safety."
- Add a **risk disclosure document** (PDF-downloadable) that reads like an institutional term sheet.
- Surface **counterparty risk information**: who operates each Blend pool, what the backstop mechanism is, smart contract audit links.
- Show **net interest margin** (supply rate minus borrow rate) as a first-class metric.

---

### 22. Victoria — The Investment Banker
**Background:** 34-year-old VP at a bulge-bracket bank. Evaluates Turbolong as a potential personal investment vehicle. Extremely time-constrained.
**Looking for:** Executive summary view, key risk metrics above the fold, no need to read documentation.
**UX/UI Suggestions:**
- Add an **"At a Glance" dashboard panel**: 3 numbers (current APY, current HF, unrealized P&L) readable in 5 seconds.
- Make the **landing page** communicate the value proposition in 2 sentences without requiring scroll.
- Add **email/calendar alerts** for HF dropping below a user-defined threshold — not just the Cloudflare APY alerts.
- Show **annualized return vs. benchmark** (e.g., US T-bill rate) to contextualize yield.

---

### 23. Harold — The Hedge Fund Analyst
**Background:** 42-year-old fund analyst researching Stellar DeFi for a small allocation. Needs to justify the investment to a committee.
**Looking for:** Audit trails, protocol TVL/volume data, risk-adjusted return metrics.
**UX/UI Suggestions:**
- Add a **Protocol Statistics** page with TVL history (chart), daily volume, number of active positions — without needing to connect a wallet.
- Show **Sharpe ratio** (or equivalent risk-adjusted metric) based on historical APY volatility.
- Include a **"Due Diligence" section** in the UI linking to audits, the team's GitHub, and on-chain activity.
- Provide a **monthly report PDF** generation that summarizes position history, fees paid, and yield earned.

---

### 24. Maria — The Family Office Treasurer
**Background:** 50-year-old managing $20M family office. Needs clear compliance documentation and avoids anything that could be construed as speculative gambling.
**Looking for:** Conservative framing, regulatory clarity, no gamification.
**UX/UI Suggestions:**
- Remove any **casino/game-like UI elements** (animations, badges, "win streaks") — frame everything as portfolio management.
- Add a **"Compliance Export"** that generates transaction histories in CSV format suitable for accounting software.
- Include a **jurisdiction-based legal disclaimer** selector in settings.
- Provide a **"Conservative Vault"** option with leverage capped at 2× and automatic deleveraging at HF 1.5.

---

### 25. Tom — The Stock Options Trader
**Background:** 45-year-old who has traded equity options for 15 years. Comfortable with leverage and Greeks but new to DeFi.
**Looking for:** Familiar risk metrics, dynamic breakeven calculation, P&L visualization.
**UX/UI Suggestions:**
- Add a **P&L chart** showing position performance over time (vs. simply holding the asset).
- Show **breakeven interest rate** — the rate at which the position turns unprofitable.
- Add **scenario analysis**: "If supply rate drops 2%, new net APY = X%."
- Display **time-weighted return** in addition to simple APY so duration of position is factored in.

---

### 26. Olivia — The Fixed Income Investor
**Background:** 55-year-old bond portfolio manager. Drawn to CETES/USTRY yields as they resemble government bond dynamics on-chain.
**Looking for:** Bond-like metrics (duration, yield-to-maturity equivalent), stability over flashy features.
**UX/UI Suggestions:**
- Surface **average duration** of underlying borrowing rates and how often they reset.
- Add a **"Stable Yield" filter** that surfaces only assets with low rate volatility over the past 30 days.
- Show the **underlying asset backing** (e.g., CETES = Mexican T-bills) with a one-sentence description per asset.
- Make the **rate history chart** the default view when selecting an asset — not a secondary tab.

---

### 27. James — The Real Estate Investor
**Background:** 48-year-old who uses leverage regularly on property (LTV ratios, mortgage refi). Understands collateral concepts intuitively.
**Looking for:** Familiar collateral/LTV framing, long-duration thinking, stress-test scenarios.
**UX/UI Suggestions:**
- Show **LTV** alongside HF — "Your current LTV is 65%" maps to TradFi intuition.
- Add a **"Stress Test" button** showing position status if supply rates drop 5% or borrow rates rise 5%.
- Use **real estate analogies** in help text: "This is like re-mortgaging to invest — you earn on the borrowed capital."
- Add a **long-term projection chart** showing projected value at 6-month and 12-month horizons.

---

### 28. Susan — The Wealth Manager
**Background:** 52-year-old RIA (Registered Investment Advisor) considering Turbolong as a satellite allocation for tech-savvy clients.
**Looking for:** Client reporting tools, portfolio context, suitability assessments.
**UX/UI Suggestions:**
- Add **multi-account/wallet support** so advisors can monitor multiple client wallets from one login.
- Provide a **suitability questionnaire** in onboarding that results in a recommended max leverage level.
- Add **"Share position report"** with a secure read-only link for clients.
- Show **allocation as a % of wallet value** to contextualize position size against total holdings.

---

### 29. Patrick — The Forex Trader
**Background:** 39-year-old retail forex trader. Comfortable with 10–50× leverage but used to stop-losses and limit orders.
**Looking for:** Stop-loss equivalent, automatic deleveraging, familiar order types.
**UX/UI Suggestions:**
- Add **"Auto-deleverage at HF X"** functionality — equivalent to a stop-loss that partially closes the position.
- Show **leverage in familiar "X:1" format** alongside the raw multiplier — "3.2× (or 3.2:1)."
- Add a **target HF field** on position open that auto-selects the correct leverage.
- Show **estimated time to liquidation** at current rate trajectory (e.g., "At current borrow rate growth, margin call in ~14 days").

---

### 30. Diana — The Commodities Trader
**Background:** 46-year-old who trades oil and metals futures. Values precise position sizing and margin efficiency.
**Looking for:** Position sizing tools, margin efficiency metrics, roll cost analysis.
**UX/UI Suggestions:**
- Show **capital efficiency**: how much net yield is generated per dollar of collateral deployed.
- Add a **position sizing calculator**: "To earn $500/month at current rates, deposit $X."
- Show **"Cost of carry"** — the net interest expense if the yield turns negative.
- Add **notional value display**: "Your $10k position controls $32k in assets at 3.2× leverage."

---

## Category 4 — Accessibility-Focused Users (Personas 31–38)

Users with visual, motor, cognitive, or other disabilities. Require WCAG-compliant and inclusive design.

---

### 31. David — Low Vision User
**Background:** 60-year-old with age-related macular degeneration. Uses a screen magnifier at 200%.
**Looking for:** High-contrast mode, scalable text, no information conveyed by color alone.
**UX/UI Suggestions:**
- Add a **"High Contrast Mode"** (not just light/dark) — true high-contrast with WCAG AAA contrast ratios.
- Ensure **all text scales** correctly up to 200% zoom without content overflow or clipping.
- Never use **color as the only indicator** (e.g., red HF warning must also have a text label/icon).
- Support **OS-level font size overrides** — don't lock font size in pixels.

---

### 32. Maria — Screen Reader User
**Background:** 44-year-old blind user who relies on VoiceOver/NVDA. Has crypto holdings and wants to use DeFi tools.
**Looking for:** Full keyboard navigation, proper ARIA labels, logical heading structure.
**UX/UI Suggestions:**
- Add **`aria-label` attributes** to all interactive elements — the leverage slider, pool tabs, wallet button.
- Ensure the **leverage slider is keyboard-navigable** with arrow keys and announces current value to screen readers.
- Implement **live region announcements** (`aria-live`) for dynamic values like HF updates and transaction status.
- Provide a **logical heading hierarchy** (h1 → h2 → h3) so screen readers can navigate by heading.

---

### 33. Kevin — Motor Impairment User
**Background:** 38-year-old with limited hand mobility due to arthritis. Uses a keyboard and switch access device.
**Looking for:** Full keyboard operability, large click targets, no time-pressured interactions.
**UX/UI Suggestions:**
- Ensure **all actions are keyboard-accessible** — no drag-only interactions (the leverage slider must work with arrow keys).
- Make all **interactive targets at least 44×44px** (WCAG 2.5.5 AAA target) — especially on mobile.
- Remove any **hover-only tooltip** patterns — all hover content must also be accessible on focus.
- Add **"Skip to main content"** link at the top of the page for keyboard users.

---

### 34. Aisha — Cognitive Load User
**Background:** 52-year-old with ADHD. Gets overwhelmed by information density. Can focus deeply but needs visual hierarchy help.
**Looking for:** Reduced visual noise, step-by-step flows, distraction-free modes.
**UX/UI Suggestions:**
- Add a **"Focus Mode"** that hides all secondary panels and shows only the current action (e.g., "Open Position" step 2 of 3).
- Replace long forms with **multi-step wizards** with a clear progress indicator.
- Use **consistent visual weight** for actions — one primary CTA per screen, secondary actions visually subordinate.
- Add **confirmation before navigation** away from a partially filled form to prevent accidental loss of state.

---

### 35. Carlos — Color Blind User (Deuteranopia)
**Background:** 33-year-old with red-green color blindness. Common charts and traffic-light color systems are invisible to him.
**Looking for:** Color-blind-safe palettes, text labels on all color indicators, pattern differentiation.
**UX/UI Suggestions:**
- Replace the **HF color scale** (green/yellow/red) with a color-blind-safe palette (blue/orange/pink) plus icon indicators.
- Add **pattern fills** to chart elements in addition to color (hatching, dots) so the interest rate curve is readable without color.
- Test all **UI states** using a deuteranopia simulator before release.
- Add **text labels** ("Safe," "Warning," "Danger") next to all color-coded indicators.

---

### 36. Preethi — Dyslexic User
**Background:** 27-year-old software developer with dyslexia. Reads more slowly; dense text blocks are hard to parse.
**Looking for:** Short sentences, generous line spacing, no justified text, readable fonts.
**UX/UI Suggestions:**
- Add a **"Dyslexia-Friendly Font"** toggle (OpenDyslexic or similar).
- Ensure **line-height is at least 1.5** and paragraphs are broken into short chunks.
- Never use **justified text** — left-align all body copy.
- Replace **long label text** with icons + short labels (e.g., "HF: 1.8 ✅" rather than "Your current Health Factor is 1.8 which is considered safe").

---

### 37. Robert — Elderly User (Accessibility)
**Background:** 72-year-old retiree with some crypto exposure. Slower processing speed; needs more time to read confirmations.
**Looking for:** No time-limited actions, larger fonts by default, simple language.
**UX/UI Suggestions:**
- Remove any **auto-dismissing notifications** — all alerts should persist until manually dismissed.
- Set a larger **default font size** (18px minimum) rather than 14–16px typical for crypto UIs.
- Add **"What does this mean?"** inline help on every non-obvious number.
- Ensure **confirmation dialogs do not auto-close** on a timer.

---

### 38. Nina — Anxiety/Mental Health-Aware User
**Background:** 31-year-old who has been advised by her therapist to avoid anxiety-inducing financial products. Still interested in DeFi yield.
**Looking for:** Calm design language, no urgency patterns, risk presented without alarm.
**UX/UI Suggestions:**
- Remove **flashing or pulsing animations** on price/rate changes — use static or slow fade transitions.
- Avoid **red/alarm language** for normal HF ranges — neutral language until genuinely urgent.
- Add a **"Calm Mode"** that removes all live-updating numbers and shows data only on user request.
- Do not use **fear-based messaging** in risk warnings — factual and calm tone throughout.

---

## Category 5 — Mobile-First Users (Personas 39–46)

Users whose primary or exclusive device is a smartphone.

---

### 39. Kwame — The African Market Mobile User
**Background:** 25-year-old in Accra, Ghana. Uses a mid-range Android phone (4GB RAM) with intermittent LTE.
**Looking for:** Fast load times, small data footprint, works with mobile wallets.
**UX/UI Suggestions:**
- **Compress and lazy-load** all assets — target <500KB initial page load.
- Optimize the **interest rate chart** for mobile (either hide by default or use a simplified sparkline).
- Ensure **Lobstr wallet** (popular in African markets) integration is prominently featured.
- Add **offline caching** of last-known position state for users with spotty connections.

---

### 40. Maria — The Commuter Trader
**Background:** 29-year-old who checks and adjusts positions on her phone during her 45-minute subway commute.
**Looking for:** One-handed usability, bottom-sheet navigation, critical actions reachable by thumb.
**UX/UI Suggestions:**
- Move primary **CTAs (Open, Close, Adjust)** to the bottom of the screen — within thumb reach.
- Use **bottom sheet modals** instead of top/center modals for action confirmation on mobile.
- Add a **"Positions" quick-access tab** in the mobile navigation bar for instant portfolio overview.
- Minimize **required scrolling** to complete core actions — key info should be above the fold on mobile.

---

### 41. Jake — The iPhone Power User
**Background:** 34-year-old who has all his crypto on iOS via the Freighter mobile app. Expects Apple-quality UX.
**Looking for:** Native-app-like experience, haptic feedback (via web), pull-to-refresh.
**UX/UI Suggestions:**
- Implement **pull-to-refresh** on the position dashboard.
- Use **`navigator.vibrate()`** (Android) and appropriate CSS animations for satisfying interaction feedback.
- Add a **PWA (Progressive Web App) manifest** so users can add Turbolong to their home screen with an icon.
- Ensure the **"Add to Home Screen"** experience surfaces contextually when a user visits for the 3rd+ time.

---

### 42. Rosa — The WhatsApp-Based Finance User
**Background:** 38-year-old in Latin America who does most financial activity through messaging apps. Expects simplicity comparable to WhatsApp Pay.
**Looking for:** Simple, app-like experience; minimal jargon; large, obvious buttons.
**UX/UI Suggestions:**
- Reduce the **mobile onboarding to 3 screens maximum**: connect wallet → pick asset → set amount.
- Use **large, full-width buttons** for primary actions — no small icons requiring precision taps.
- Add a **WhatsApp-share button** for sending position details to a trusted contact.
- Show **amounts in local currency** alongside USD (using an exchange rate API).

---

### 43. Amir — The Portfolio-on-Phone User
**Background:** 31-year-old in the Middle East who manages all investments from his phone. Uses multiple DeFi apps.
**Looking for:** Consistent mobile UX across platforms, quick context-switching support.
**UX/UI Suggestions:**
- Add a **persistent mini-position widget** at the bottom of every page showing current HF and APY — so users don't need to navigate to dashboard.
- Support **deep linking** so pushing a notification takes the user directly to the relevant position.
- Ensure the **wallet connection persists** across browser refreshes on mobile (many mobile apps lose state).
- Optimize for **Safari on iOS** — many DeFi apps break on iOS Safari; test and fix wallet popup flows.

---

### 44. Fatou — The Low-Data Budget User
**Background:** 24-year-old in Dakar, Senegal, on a metered data plan. Monitors every MB of data used.
**Looking for:** Data-light mode, deferred asset loading, no auto-playing content.
**UX/UI Suggestions:**
- Add a **"Data Saver Mode"** toggle that disables chart animations, reduces polling frequency, and defers image loads.
- Show **estimated data usage** for each page load in the settings.
- Implement **efficient WebSocket/SSE polling** rather than polling every second for rate updates.
- Cache static assets aggressively using **service workers**.

---

### 45. Tobias — The Tablet User
**Background:** 40-year-old who uses an iPad for financial management. Expects the layout to use the extra screen real estate.
**Looking for:** Tablet-optimized layout (not just mobile or desktop), split-pane views.
**UX/UI Suggestions:**
- Add a **split-pane layout** for tablet (iPad) sizes: position list on left, detail on right.
- Scale the **leverage slider** to use the full tablet width for more precise control.
- Show the **interest rate chart and position card** side-by-side on tablet without requiring scroll.
- Support **iPad multitasking** (Slide Over / Split View) by ensuring the UI is functional at narrow widths.

---

### 46. Yara — The Nighttime Trader (Mobile)
**Background:** 27-year-old who checks positions in bed before sleep. Needs a comfortable dark mode that doesn't wake her partner.
**Looking for:** True dark mode (OLED-black), auto dark mode following OS settings, reduced brightness animations.
**UX/UI Suggestions:**
- Implement **OLED-optimized dark mode** with true black (#000000) backgrounds — not just dark gray.
- Respect the **`prefers-color-scheme: dark` media query** automatically.
- Reduce **animation intensity** and avoid white flashes when navigating in dark mode.
- Add a **"Bedtime Mode"** that reduces all notification sounds and bright alerts.

---

## Category 6 — Risk Management Focus (Personas 47–54)

Users for whom capital preservation is paramount.

---

### 47. Helen — The Risk-First Investor
**Background:** 55-year-old who lost money in the 2022 crypto crash. Approaches new products with extreme caution.
**Looking for:** Clear downside scenarios, exit path prominence, no hidden risks.
**UX/UI Suggestions:**
- Show **"Worst case in 30 days"** simulation alongside expected APY on every position open screen.
- Make the **"Close Position" button** equally prominent to "Open Position" — do not bury exit flows.
- Add a **"Protocol Risk" section** that explains smart contract risk, oracle risk, and liquidity risk for each pool.
- Show a **"Could I lose my principal?"** FAQ with an honest answer in the onboarding flow.

---

### 48. Andrew — The Max Drawdown Manager
**Background:** 43-year-old who uses maximum drawdown as his primary risk metric in all portfolios.
**Looking for:** Historical drawdown data, VaR-equivalent metrics, stress testing.
**UX/UI Suggestions:**
- Show **historical worst-case HF** for each pool (max drawdown in HF terms) based on historical rate data.
- Add a **"If borrow rates spike to X%, your position is liquidated in Y days"** stress test calculator.
- Provide **Value-at-Risk** (or a DeFi-appropriate equivalent) in the position summary.
- Offer an **"Emergency Deleverage"** button that partially closes the position to a safer HF in one click.

---

### 49. Yumiko — The Stop-Loss Purist
**Background:** 36-year-old trained in traditional risk management who relies on stop-losses for every position.
**Looking for:** Automated protection orders, configurable HF floor, no manual babysitting required.
**UX/UI Suggestions:**
- Implement **on-chain keeper integration** (or off-chain alert + bot) for automatic partial closing when HF drops below a threshold.
- Let users set **"Auto-rebalance at HF X"** directly from the UI with a wallet signature for pre-authorized transactions.
- Show **estimated time to liquidation** under current rate trajectory — a countdown-style metric.
- Send **SMS/email alerts** (not just in-app) when HF enters a warning zone.

---

### 50. Bernard — The Concentration Risk Avoider
**Background:** 62-year-old who follows strict portfolio concentration rules (no more than 10% in any single strategy).
**Looking for:** Portfolio allocation views, concentration warnings, diversification nudges.
**UX/UI Suggestions:**
- Show **position as a % of connected wallet balance** on the position open screen.
- Add a **"Concentration warning"** if a single position exceeds 25% of wallet holdings.
- Implement **multi-position portfolio view** with total capital at risk shown in aggregate.
- Offer a **position size recommendation** based on wallet size and risk tolerance setting.

---

### 51. Miriam — The Compliance-Driven Risk Officer
**Background:** 49-year-old ex-risk officer at a bank. Applies institutional risk frameworks to personal DeFi.
**Looking for:** Audit logs, immutable position history, risk category tags.
**UX/UI Suggestions:**
- Provide a **full transaction log** with timestamps, amounts, and block numbers for every position event.
- Allow **risk category tagging** on positions (e.g., "Speculative," "Income," "Hedge") for personal tracking.
- Add **immutable export** of position history (hash-verified CSV) for personal audit trails.
- Flag positions with **"High Risk"** tags if leverage exceeds 5× or HF is below 1.5.

---

### 52. Peter — The Conservative Retiree (Risk)
**Background:** 67-year-old with a fixed income. Cannot afford to lose capital. Uses DeFi only for stable yield.
**Looking for:** Capital preservation first, clear yield floor, no surprise liquidations.
**UX/UI Suggestions:**
- Add a **"Capital Protected Mode"** (1.0–1.5× leverage only) with a simplified interface showing only safe-range controls.
- Show **minimum HF required to avoid liquidation** as a large, always-visible number.
- Add **daily email summaries** of position health in plain English: "Your position is healthy. Current HF: 2.1."
- Make the **vault product** the default recommendation for this persona — auto-rebalancing avoids manual HF monitoring.

---

### 53. Svetlana — The Black Swan Preparer
**Background:** 41-year-old macro investor who always plans for tail risks. Reads about protocol failures and prepares contingencies.
**Looking for:** Protocol failure scenarios, emergency procedures, force-majeure documentation.
**UX/UI Suggestions:**
- Add a **"Protocol Risk FAQ"** page: What happens if Blend is hacked? What if an oracle fails? What if Stellar network stalls?
- Show **backstop balance** for each pool prominently — it's the first line of defense in a liquidity crisis.
- Provide a **"Emergency Exit Guide"** in the docs: how to close a position even if the Turbolong UI is down (using Stellar Lab or CLI).
- Add a **circuit breaker indicator** showing if any pool is currently in recovery mode.

---

### 54. Chris — The Insurance Seeker
**Background:** 37-year-old who buys DeFi coverage (Nexus Mutual, etc.) on all his positions.
**Looking for:** Protocol coverage availability, event risk disclosure, insurance-compatible position data.
**UX/UI Suggestions:**
- Link to **available DeFi insurance options** for Blend protocol from within the UI.
- Provide **position details in a format compatible** with DeFi coverage providers (contract address, position ID, value at risk).
- Add **risk event history** — past incidents on Blend or Turbolong that affected users.
- Show **protocol upgrade history** and governance change log to help users assess evolving risk.

---

## Category 7 — Yield Farmers / Passive Income Seekers (Personas 55–62)

APY-maximizers and passive income builders.

---

### 55. Lucas — The APY Chaser
**Background:** 26-year-old who moves capital weekly to the highest APY source across protocols.
**Looking for:** Real-time APY comparison, rate alerts, switching cost calculator.
**UX/UI Suggestions:**
- Add an **"APY Leaderboard"** tab showing all pool/asset combinations sorted by current net APY.
- Implement **rate alerts** (the alerts feature exists but make it more discoverable) — surface it prominently as "Set Rate Alert."
- Show **switching cost** (fees + slippage) to move from one pool/asset to another, alongside the APY difference.
- Add a **"This week's best opportunity"** email digest subscription.

---

### 56. Naomi — The Compounding Enthusiast
**Background:** 32-year-old who reinvests yield manually every week to maximize compounding.
**Looking for:** Compounding tools, reinvestment reminders, compound APY calculator.
**UX/UI Suggestions:**
- Add a **"Compound Now"** button that harvests BLND rewards and re-deposits them in one transaction.
- Show **compound APY** (assuming weekly reinvestment) alongside simple APY.
- Add a **reinvestment reminder** (email or push) on a user-configured schedule.
- Show a **compounding projection chart**: "At current APY with weekly compounding, $10k → $X in 1 year."

---

### 57. Elsa — The Passive Income Purist
**Background:** 38-year-old who wants yield with zero active management once set up.
**Looking for:** Set-and-forget vault, automatic alerts if action needed, zero manual rebalancing.
**UX/UI Suggestions:**
- Make the **Vault product the first thing** users see, with a "100% Automated" tagline.
- Show **time since last manual action required** — "This vault has run for 47 days without user intervention."
- Add an **"Auto-harvest"** toggle that reinvests BLND rewards on a schedule without manual clicks.
- Provide a **mobile push notification** system (PWA) for vault health alerts.

---

### 58. Kevin — The BLND Maximalist
**Background:** 29-year-old who is bullish on the BLND token and wants to maximize BLND accumulation alongside yield.
**Looking for:** BLND reward visibility, emission rates, BLND value accumulation tracking.
**UX/UI Suggestions:**
- Add **BLND reward rate** (BLND/day or BLND/year) as a visible metric on all pool cards.
- Show **accumulated unclaimed BLND** in the position dashboard with a "Claim" button.
- Add a **BLND price tracker** in the header (or link to a live price) so users can see BLND value in USD.
- Show **BLND APY component** separately from the base supply/borrow APY for transparency.

---

### 59. Paula — The Dividend Investor Analog
**Background:** 52-year-old who invests in high-dividend stocks. Maps DeFi yield to dividend investing mental model.
**Looking for:** Yield in dollar terms (not just %), payout frequency, yield reliability.
**UX/UI Suggestions:**
- Show **"Monthly income at current APY"** for a user-inputted deposit amount, prominently displayed.
- Add a **"Yield Reliability Score"** for each pool — a composite of rate stability, TVL depth, and audit score.
- Visualize **yield as a "dividend" flow**: weekly/monthly income distribution charts.
- Show **historical yield distribution** — not just current APY but 90-day range to show stability.

---

### 60. Sven — The Stablecoin Yield Farmer
**Background:** 35-year-old who avoids price risk and focuses purely on stablecoin yield strategies.
**Looking for:** USDC/stablecoin-only pools, minimal price exposure, pure interest arbitrage.
**UX/UI Suggestions:**
- Add a **"Stablecoin Only" filter** that hides all volatile asset pools.
- Show **"Net yield with no price exposure"** scenarios clearly — when both the leveraged asset and collateral are stablecoins.
- Add **"Price risk: None"** labels on stablecoin/stablecoin pair strategies.
- Highlight **USDC leverage loops** as the safest strategy type more prominently on the homepage.

---

### 61. Grace — The Lazy Portfolio Optimizer
**Background:** 44-year-old who wants maximum return for minimum effort. Will spend 10 minutes a month, not 10 hours.
**Looking for:** Single recommended action, automated optimization, minimal decisions.
**UX/UI Suggestions:**
- Add a **"Optimize My Portfolio"** button that analyzes current positions and recommends one specific action.
- Implement **"Auto-switch"** functionality that moves capital to better-yielding pools when the differential exceeds X%.
- Reduce the **number of decisions** required to open a position from the current flow — default to recommended settings.
- Send a **monthly "Your portfolio needs X"** notification (if anything is suboptimal) rather than requiring daily checks.

---

### 62. Andre — The Real Yield Chaser
**Background:** 30-year-old who avoids token emission-inflated APYs and only cares about organic protocol yield.
**Looking for:** Breakdown of yield sources, emission-adjusted APY, sustainable yield labeling.
**UX/UI Suggestions:**
- Show **"Organic APY"** (interest spread only) separate from **"Token Rewards APY"** (BLND emissions).
- Add a **"Sustainable Yield"** badge on pools where organic APY > 0 even without token rewards.
- Provide a **"What happens to APY if BLND price drops 90%"** scenario calculator.
- Flag pools as **"Emission-Dependent"** when >50% of APY comes from BLND rewards.

---

## Category 8 — Institutional / Professional Traders (Personas 63–70)

High-volume, professional-grade users with institutional requirements.

---

### 63. Alex — The Prop Trader
**Background:** 33-year-old at a small prop trading firm. Manages $2M in DeFi allocation with aggressive leverage targets.
**Looking for:** High position size support, slippage modeling, execution quality metrics.
**UX/UI Suggestions:**
- Show **price impact** for large position opens — how much does opening a $500k position move utilization rates?
- Add **institutional-grade execution**: split large positions into multiple transactions to minimize market impact.
- Provide **execution quality report** post-trade: slippage vs. estimated, fees, fill time.
- Support **sub-account / desk management**: multiple positions grouped by strategy or trader.

---

### 64. Wei — The Market Maker
**Background:** 38-year-old who provides liquidity in DeFi and uses leverage to amplify returns on market-making capital.
**Looking for:** Capital efficiency tools, inventory management, real-time P&L.
**UX/UI Suggestions:**
- Add a **capital efficiency score**: yield per dollar of collateral vs. alternatives.
- Show **real-time unrealized P&L** including accrued interest and BLND rewards.
- Add **position cost basis tracking** for proper accounting.
- Implement a **portfolio heat map** showing all positions, their leverage, and HF in a visual grid.

---

### 65. Julia — The Treasury Manager (DAO)
**Background:** 35-year-old who manages a DAO treasury looking to earn yield on idle stable assets.
**Looking for:** Multi-sig support, governance-compatible transaction flows, reporting tools.
**UX/UI Suggestions:**
- Add **multi-sig wallet support** (Stellar multi-sig) — allow position management with N-of-M signers.
- Provide **DAO-friendly transaction batching** — combine supply + leverage into a single governance-executable proposal.
- Add **treasury reporting** format compatible with DAO tooling (Tally, Gnosis Safe equivalent).
- Support **role-based access**: read-only viewers, proposers, executors with different permission levels.

---

### 66. Marco — The Quantitative Researcher
**Background:** 41-year-old quantitative researcher who builds and tests systematic strategies.
**Looking for:** Historical data access, backtesting support, model validation tools.
**UX/UI Suggestions:**
- Provide a **public data API** with historical rates, utilization, and HF data for backtesting.
- Add a **backtesting sandbox** in the UI where users can simulate a strategy against historical data.
- Expose **all protocol parameters** (c_factor, liquidation bonus, backstop take rate) in a machine-readable format.
- Implement **statistical annotations** on rate charts (rolling averages, standard deviation bands).

---

### 67. Anita — The Fund Compliance Officer
**Background:** 47-year-old compliance officer at a crypto fund that uses DeFi protocols.
**Looking for:** Transaction audit trail, KYC/AML clarity, regulatory reporting.
**UX/UI Suggestions:**
- Provide **full transaction history export** (CSV/JSON) with all fields populated for accounting software.
- Add a **regulatory FAQ** page clarifying jurisdictional issues and the nature of the protocol.
- Implement **read-only API access** for compliance monitoring without execution permissions.
- Show **on-chain provenance** for all assets — which smart contracts touched the funds.

---

### 68. Stefan — The High-Frequency Rebalancer
**Background:** 36-year-old who rebalances positions multiple times daily using algorithmic triggers.
**Looking for:** API access, webhook notifications, minimal UI dependency.
**UX/UI Suggestions:**
- Provide a **full API** mirroring all UI capabilities (open/close/adjust position, read state).
- Support **webhook subscriptions** for position events (HF change, rate change, liquidation warning).
- Add **programmatic position management** via SDK/library (TypeScript and Python packages).
- Provide a **rate-limiting policy** and **API key management** in the settings UI.

---

### 69. Rachel — The Yield Aggregator Developer
**Background:** 30-year-old who builds yield aggregators on top of DeFi protocols.
**Looking for:** Integration documentation, composability primitives, developer-friendly ABIs.
**UX/UI Suggestions:**
- Add a **developer documentation portal** linked from the main UI.
- Provide **ABI and contract address registry** in a machine-readable format (JSON) at a stable URL.
- Implement a **"Test Integration"** sandbox environment with unlimited testnet funds.
- Add a **changelog** for contract upgrades and API changes, with deprecation notices.

---

### 70. Oliver — The Fund Allocator
**Background:** 55-year-old who allocates capital on behalf of a family of funds. Needs consolidated reporting across protocols.
**Looking for:** Multi-protocol portfolio view, benchmark comparison, consolidated reporting.
**UX/UI Suggestions:**
- Add **cross-protocol portfolio integration** — show Turbolong positions alongside other Stellar DeFi positions.
- Provide **benchmark comparison**: show Turbolong APY vs. Aqua, vs. Blend direct, vs. T-bill rate.
- Generate **monthly PDF reports** summarizing performance, fees, and risk metrics.
- Support **API aggregation** so positions can be pulled into external portfolio management systems.

---

## Category 9 — Developers / Technical Users (Personas 71–78)

Users who want to understand the internals, build on top of, or audit the protocol.

---

### 71. Sam — The Smart Contract Auditor
**Background:** 29-year-old security researcher who audits Soroban contracts for a living.
**Looking for:** Contract addresses, source code links, security documentation, transparent mechanics.
**UX/UI Suggestions:**
- Add a **"Security" page** in the UI linking to: source code (GitHub), audit reports, bug bounty, and vulnerability disclosure policy.
- Surface **contract addresses** with one-click copy for every pool and strategy contract.
- Show **last audit date** and auditing firm for each contract directly in the pool selection UI.
- Link to **Stellar Expert** contract pages for real-time on-chain inspection.

---

### 72. James — The Protocol Integrator
**Background:** 33-year-old building a DeFi aggregator that wants to include Turbolong strategies.
**Looking for:** Well-documented APIs, stable interfaces, developer support channels.
**UX/UI Suggestions:**
- Create a **developer portal** (even a simple docs site) with integration guides and code examples.
- Publish a **TypeScript SDK** (the current blend.ts and defindex.ts files are a good start) as an npm package.
- Add **OpenAPI/Swagger spec** for any REST APIs (the alerts microservice especially).
- Provide a **Discord developer channel** or GitHub Discussions for integration support.

---

### 73. Lin — The Open Source Contributor
**Background:** 27-year-old who contributes to DeFi open source projects.
**Looking for:** Clear contribution guidelines, modular code, well-documented architecture.
**UX/UI Suggestions:**
- Add a **CONTRIBUTING.md** file and link it from the UI footer.
- Surface a **"Report a Bug"** or **"Suggest a Feature"** link in the UI settings.
- Add **architecture diagrams** showing how frontend, contracts, alerts, and scripts interact.
- Create **GitHub issue templates** for bug reports and feature requests.

---

### 74. Emma — The DevOps Engineer
**Background:** 34-year-old who maintains DeFi infrastructure. Wants to self-host a monitoring instance.
**Looking for:** Deployment documentation, environment variables, self-hosting guide.
**UX/UI Suggestions:**
- Add a **self-hosting guide** to the README — how to run the frontend, deploy contracts, configure alerts.
- Document all **environment variables** with descriptions and default values.
- Add a **health check endpoint** to the alerts microservice.
- Provide a **Docker Compose** setup for local development.

---

### 75. Nathan — The Protocol Archaeologist
**Background:** 40-year-old who deep-dives into protocol mechanics, reads every line of code.
**Looking for:** Complete parameter exposure, mathematical documentation, source links.
**UX/UI Suggestions:**
- Add **"View Source"** links throughout the UI pointing to the relevant contract function for each action.
- Show all **protocol parameters** (c_factor, liquidation_fee, backstop_take_rate) in a "Protocol Parameters" debug panel.
- Link the existing **docs/leverage-model.md** from within the UI under "How This Works."
- Add **formula annotations** on all calculated values — clicking HF shows the exact formula used.

---

### 76. Zoe — The Security Researcher
**Background:** 31-year-old who hunts vulnerabilities in DeFi protocols for bug bounties.
**Looking for:** Bug bounty program details, responsible disclosure process, test environment access.
**UX/UI Suggestions:**
- Link the **docs/blend-bug-bounty-report.md** (or a formal bug bounty program) from the UI.
- Add a **security.txt** file at the standard path (`/.well-known/security.txt`) with disclosure contact info.
- Provide **unlimited testnet access** with pre-funded wallets for security researchers.
- Show a **"Responsible Disclosure"** policy link in the footer.

---

### 77. Ivan — The Blockchain Data Engineer
**Background:** 38-year-old who builds analytics pipelines on Stellar data.
**Looking for:** Event emission consistency, indexed data, subgraph or data API.
**UX/UI Suggestions:**
- Ensure **all contract events** are consistently emitted with sufficient indexed fields for off-chain analytics.
- Provide a **public Stellarbeat / data API** endpoint for historical position and rate data.
- Add **pagination and filtering** to the transaction history export.
- Link to **existing Stellar analytics** dashboards (Stellar Expert, StellarChain) for each pool.

---

### 78. Priya — The Protocol Governance Participant
**Background:** 32-year-old active in Blend governance who wants to understand how Turbolong positions are affected by governance changes.
**Looking for:** Governance change impact analysis, parameter change notifications.
**UX/UI Suggestions:**
- Add a **"Governance Impact"** alert when a Blend governance proposal could affect active positions.
- Show **governance voting links** for Blend from within the Turbolong UI.
- Notify users when **protocol parameters** (c_factor, rate configs) are changed on-chain.
- Add a **parameter change history log** showing when and what changed in the underlying pools.

---

## Category 10 — International / Non-English Users (Personas 79–86)

Users whose primary language is not English.

---

### 79. Carlos — The Latin American User
**Background:** 28-year-old in Buenos Aires. Primary interest in CETES and USTRY as inflation hedges.
**Looking for:** Spanish interface, Latin American asset focus, local currency context.
**UX/UI Suggestions:**
- Add **Spanish UI translation** — this is especially relevant given the CETES/USTRY assets which appeal to LatAm users.
- Show **local currency value** (ARS, MXN, BRL) alongside USD values.
- Feature **CETES and USTRY on the homepage** as headline assets — they're the natural draw for this market.
- Add **educational content** explaining why leveraged Mexican T-bills (CETES) could be interesting for LatAm users.

---

### 80. Yuki — The Japanese Retail Investor
**Background:** 52-year-old Japanese retail investor who prefers Japanese content and conservative framing.
**Looking for:** Japanese translation, conservative defaults, formal tone.
**UX/UI Suggestions:**
- Provide **Japanese translation** with formal (keigo-appropriate) tone for UI text.
- Default to **lower leverage options** in a "Japan mode" reflecting local conservative investment culture.
- Add **yen-denominated** return calculations.
- Use **right-to-left-aware layout** preparation and proper CJK font stacks.

---

### 81. Zhang Wei — The Chinese DeFi User
**Background:** 34-year-old Chinese user accessing from a VPN. Familiar with yield farming from Binance Smart Chain.
**Looking for:** Mandarin interface, familiar DeFi mental models, fast mobile performance.
**UX/UI Suggestions:**
- Add **Simplified Chinese translation** with DeFi terminology consistent with Chinese crypto community conventions.
- Ensure the app **works well over VPN** — avoid hardcoded CDN resources that might be blocked.
- Support **OKX Wallet and imToken** which are popular wallets in the Chinese market.
- Add **WeChat-shareable position cards** for community sharing.

---

### 82. Fatima — The Arabic-Speaking User
**Background:** 31-year-old finance professional in Dubai. Arabic is her preferred language.
**Looking for:** Arabic UI, RTL layout support, shariah-compliant product clarity.
**UX/UI Suggestions:**
- Implement **full RTL (right-to-left) layout** for Arabic language mode.
- Add **Arabic translation** with financial terminology reviewed by native speakers.
- Add a **"Is this product Shariah-compliant?"** FAQ item — interest-bearing products are sensitive in Islamic finance contexts.
- Show **AED/SAR currency equivalents** for amounts.

---

### 83. Pierre — The French User
**Background:** 45-year-old French investor interested in TESOURO (Brazilian treasury bonds) on-chain.
**Looking for:** French interface, European regulatory context, euro-denominated returns.
**UX/UI Suggestions:**
- Add **French translation** for the UI and all help text.
- Show **EUR-denominated** return projections.
- Add a **GDPR compliance section** in the privacy settings (relevant for EU users).
- Feature **TESOURO** assets prominently as an international fixed-income exposure option.

---

### 84. Babatunde — The Nigerian User
**Background:** 29-year-old Nigerian who uses Stellar for remittances and now wants to earn yield.
**Looking for:** Naira context, USDC-first experience, simple mobile UI.
**UX/UI Suggestions:**
- Show **NGN-denominated** return equivalents (given that many users think in naira).
- Feature **USDC strategies** prominently as the most accessible entry point.
- Ensure **Lobstr wallet** (popular in Nigeria) integration is seamless.
- Add a **"Coming from remittances?"** onboarding path that bridges from USDC holding to yield generation.

---

### 85. Olga — The Eastern European User
**Background:** 37-year-old Ukrainian investor looking for yield alternatives during economic uncertainty.
**Looking for:** USD-stable yield, capital preservation, simple entry.
**UX/UI Suggestions:**
- Add a **Ukrainian/Russian language option**.
- Emphasize **USD-denominated stable yield** (USDC) as the headline use case.
- Provide a **"Safe entry"** path that starts with low leverage (1.5×) for risk-averse users.
- Show **returns in USD** by default (many users in this market think in USD, not local currency).

---

### 86. Raj — The Indian User
**Background:** 33-year-old software engineer in Bangalore. Comfortable with technology but navigates regulatory grey areas.
**Looking for:** Hindi/English bilingual support, clear regulatory positioning, UPI-adjacent context.
**UX/UI Suggestions:**
- Add **Hindi language support** for key UI elements (numbers, labels, error messages).
- Include a **regulatory disclaimer** tailored to India's evolving crypto regulations.
- Show **INR-equivalent** returns for amounts.
- Ensure **Freighter wallet** setup guide is available in Hindi for onboarding first-time users.

---

## Category 11 — Elderly Users (Personas 87–92)

Older users who may be less technically confident but have significant capital to deploy.

---

### 87. George — The Retired Professor
**Background:** 68-year-old retired economics professor. Intellectually curious, methodical, dislikes rushed UIs.
**Looking for:** Deep explanations available on request, no pop-up pressure, print-friendly documentation.
**UX/UI Suggestions:**
- Add a **"Learn More"** deep-dive section accessible from every metric that provides a full explanation.
- Remove any **urgency-creating UI patterns** ("Limited time!" or rapid price flashing).
- Make the **documentation print-friendly** — a clean PDF of the entire help system.
- Allow **font size preferences** saved to a user profile.

---

### 88. Margaret — The Retired Teacher
**Background:** 72-year-old who has moved from CDs to crypto following advice from her children. Needs patient guidance.
**Looking for:** Step-by-step wizard flows, undo capability, phone support equivalent in UI.
**UX/UI Suggestions:**
- Add a **"Chat Support"** button (even if AI-powered) for immediate help when confused.
- Make every **error message** end with a concrete next step: "What to do: Click 'Close' to cancel this action."
- Implement **"Confirm before every action"** mode that shows a plain-language summary of what will happen.
- Add a **"Guided Mode"** toggle that shows a text description of each step before proceeding.

---

### 89. Henry — The Tech-Savvy Elder
**Background:** 70-year-old retired IT professional. Comfortable with technology but notices when UX is thoughtless.
**Looking for:** Logical consistency, no infantilizing design, clear information architecture.
**UX/UI Suggestions:**
- Ensure **information architecture is logical** — related items grouped together, no arbitrary menu placement.
- Add a **site map** or **"What can I do here?"** overview page.
- Make **keyboard navigation** consistent throughout — tab order follows visual order.
- Add **"Last visited"** state restoration so users return to where they left off.

---

### 90. Dorothy — The First-Time Crypto User (Elder)
**Background:** 65-year-old whose grandchild set up her wallet. Has Stellar assets but no DeFi experience.
**Looking for:** Extremely simple entry, no assumptions of prior knowledge, gentle failure states.
**UX/UI Suggestions:**
- Add a **"What is a Health Factor?"** explainer video (30 seconds) accessible from the HF display.
- Never **disable the "Back" button** behavior — elderly users rely on browser back as an undo mechanism.
- Use **complete sentences** in all UI labels rather than terse technical shorthand.
- Add **"Is this right?"** confirmation checkpoints at key decisions with a plain-language summary.

---

### 91. Frank — The Deliberate Decision Maker
**Background:** 74-year-old who takes 2–3 days to make financial decisions. Doesn't like being rushed.
**Looking for:** Save-and-return flows, no session timeouts, persistent application state.
**UX/UI Suggestions:**
- **Save form state** locally so users can start filling in a position and return days later.
- Avoid **short session timeouts** that disconnect wallets — or at least warn before disconnecting.
- Add a **"Review later"** bookmark feature to save a pool/asset/leverage combination for future consideration.
- Show **"You were working on this"** reminder when the user returns after a pause.

---

### 92. Barbara — The Partner-Dependent User
**Background:** 69-year-old who makes financial decisions with her spouse. Needs to share information easily.
**Looking for:** Shareable position summaries, print/email capabilities, easy information forwarding.
**UX/UI Suggestions:**
- Add **"Share this with someone"** — a shareable link (read-only) to a position summary or product explainer.
- Enable **"Print this page"** functionality with a clean print-optimized CSS stylesheet.
- Add **email summary** capability — "Send my current positions to my email."
- Provide a **"Discussion guide"** — a simple PDF that explains Turbolong for a spouse or financial advisor review.

---

## Category 12 — Privacy-Focused Users (Personas 93–95)

Users who prioritize on-chain privacy and minimal data collection.

---

### 93. Cypherpunk Carl — The Privacy Absolutist
**Background:** 36-year-old who uses Tor, self-hosts everything, and is deeply skeptical of any data collection.
**Looking for:** No analytics tracking, no external CDN dependencies, self-hostable interface.
**UX/UI Suggestions:**
- Add a **privacy policy** that clearly states no user data is collected and no analytics are embedded.
- Audit and remove **third-party scripts** — ensure no Google Analytics, Hotjar, or similar.
- Make the frontend **self-hostable** from a simple web server with no external dependencies.
- Support **Tor Browser** fully — no anti-bot measures that block Tor exit nodes.

---

### 94. Maya — The Data Minimalist
**Background:** 29-year-old who uses minimal personal data in all services. Has never signed up with email anywhere.
**Looking for:** No email registration, no wallet address tracking, no localStorage fingerprinting.
**UX/UI Suggestions:**
- Ensure **no persistent fingerprinting** — localStorage use should be opt-in or limited to functional data.
- Make the **APY alerts** feature work without email (push notifications or on-chain event subscriptions only).
- Add a **"Clear all local data"** button in settings that wipes any cached state.
- Provide **no-email alternatives** for all features that currently require email (alerts, reports).

---

### 95. Alex — The Pseudonymous User
**Background:** 33-year-old who uses a pseudonymous Stellar address and wants to keep on-chain activity separate from identity.
**Looking for:** No KYC, no identity linking, clean on-chain footprint.
**UX/UI Suggestions:**
- Confirm **no KYC** is required and never add identity verification steps that aren't required by Stellar itself.
- Avoid **correlating wallet addresses** across sessions or displaying social graph information.
- Do not request **unnecessary wallet permissions** — only request signing permissions for specific transactions.
- Add a **"What data do we store?"** one-pager confirming no off-chain user data is retained.

---

## Category 13 — Vault / Automation Users (Personas 96–100)

Users specifically interested in the managed vault product.

---

### 96. Sofia — The Vault Depositor
**Background:** 40-year-old who wants all the benefits of leverage without managing positions manually.
**Looking for:** Clear vault mechanics, transparent fee structure, performance track record.
**UX/UI Suggestions:**
- Add a **vault performance history chart** showing share price appreciation over time since launch.
- Clearly display **vault fees** (management fee, performance fee, withdrawal fee) in one visible section.
- Show **"How the vault manages your position"** explainer — describing when it rebalances and why.
- Add a **"Compare: Vault vs. Manual"** view showing the time saved and performance difference.

---

### 97. Daniel — The DeFi Automation Enthusiast
**Background:** 31-year-old who runs automations across DeFi protocols and wants to compose Turbolong vault with other protocols.
**Looking for:** Vault share token composability, integration examples, programmatic deposit/withdraw.
**UX/UI Suggestions:**
- Document the **vault share token (ERC4626-equivalent)** interface for composability with other protocols.
- Add **programmatic deposit/withdraw** to the TypeScript SDK.
- Show **vault share token address** prominently with composability examples.
- Implement a **"Use vault shares as collateral"** integration path (if supported by any lending protocol).

---

### 98. Emma — The Vault Governance Participant
**Background:** 35-year-old interested in DeFindex governance for vault strategy changes.
**Looking for:** Governance participation, strategy visibility, on-chain voting.
**UX/UI Suggestions:**
- Link to **DeFindex governance** from the vault UI.
- Show **current vault strategy parameters** (target leverage, rebalance threshold, HF floor) with their governance-set values.
- Add **"Propose strategy change"** link for governance participants.
- Show **vault governance voting history** and recent parameter changes.

---

### 99. Robert — The Vault Yield Optimizer
**Background:** 48-year-old who evaluates vaults across protocols for maximum risk-adjusted return.
**Looking for:** Historical performance data, comparative APY vs. direct Blend deposit, vault-specific risk metrics.
**UX/UI Suggestions:**
- Show **"Vault APY vs. Direct Deposit APY"** comparison — the explicit premium earned from automation.
- Add **historical vault performance** data downloadable as CSV.
- Show **maximum drawdown** for the vault since inception.
- Display **vault rebalance history** — when did the vault last rebalance, and what triggered it?

---

### 100. Isabelle — The Vault Social Investor
**Background:** 26-year-old who follows crypto influencers and joins vaults based on community recommendations.
**Looking for:** Social proof, easy sharing, community around the vault.
**UX/UI Suggestions:**
- Add **"X people are in this vault"** social proof indicator.
- Implement **"Share vault position"** — a shareable card with APY and "I'm in this vault."
- Add a **vault leaderboard** or community page showing top depositors (optional, opt-in).
- Create a **community Telegram/Discord** link accessible from the vault UI for discussion and support.

---

## Top Recurring Improvement Themes

Based on analysis across all 100 personas, these 12 themes appear most frequently and represent the highest-impact improvement opportunities:

---

### 1. Onboarding & Progressive Disclosure (34 personas)
The biggest gap: the UI drops new users directly into a complex DeFi trading interface with no guided path. **Recommendation:** Build a multi-mode onboarding system — Beginner / Intermediate / Expert — with the default being Beginner for first-time users. An interactive 6-step tour and "What is X?" tooltips on all metrics would serve 30%+ of the addressable audience.

---

### 2. Risk Communication & Transparency (28 personas)
HF is the critical safety metric but is presented without enough context. **Recommendation:** Color-code HF with four zones (safe/caution/warning/danger), show "liquidation price" in asset terms alongside HF, and add a "Stress Test" button showing position health if rates move adversely. Every risk-averse persona cited this as the top need.

---

### 3. Mobile-First Optimization (22 personas)
The current UI works on mobile but was designed desktop-first. **Recommendation:** Redesign the mobile interaction pattern with bottom-sheet modals, thumb-reachable CTAs, and a PWA manifest. Sub-500KB initial load and offline state caching would unlock the emerging market user base.

---

### 4. Data Export & API Access (20 personas)
Both power users and institutional users need programmatic access. **Recommendation:** Publish a public REST API for position reads, a TypeScript SDK (the blend.ts/defindex.ts files are nearly there), and CSV export for all position history. This also serves compliance, reporting, and automation needs.

---

### 5. Accessibility (WCAG Compliance) (18 personas)
Multiple accessibility gaps exist: color-only information encoding, no ARIA labels on interactive elements, small tap targets. **Recommendation:** Conduct a WCAG 2.1 AA audit and resolve all Level A and AA violations. Priority: ARIA labels on the leverage slider, keyboard navigation, and color-blind-safe HF indicator.

---

### 6. Vault Product Positioning (16 personas)
The vault is an underutilized product that solves the main pain points for passive investors, beginners, and busy professionals. **Recommendation:** Make the vault a co-equal first-class product on the homepage — not a secondary tab. "Earn enhanced yield, fully automated" is a stronger hook for 50%+ of personas than "open a leveraged position."

---

### 7. Internationalization & Localization (15 personas)
Turbolong's core assets (CETES, USTRY, TESOURO) have natural appeal in LatAm, but the UI is English-only. **Recommendation:** Add Spanish and Portuguese as first priority languages. RTL support for Arabic. Local currency display (ARS, MXN, BRL, NGN) for contextual returns.

---

### 8. Real-Time Alerts & Notifications (14 personas)
The APY alert system exists but is not discoverable, and there's no HF alert system. **Recommendation:** Add HF threshold alerts (email + push) as a first-class feature. Surface the alerts system prominently in the UI header. Build a weekly digest email summarizing position health and rate changes.

---

### 9. Comparative Rate Intelligence (13 personas)
Users want to know if they're getting the best available rate. **Recommendation:** Add a "Compare Pools" view showing all pool/asset combinations by net APY. Show 24h/7d rate trend arrows. Add a "Best Rate" badge and switching cost calculator.

---

### 10. Pre-Transaction Transparency (12 personas)
Users want to see exactly what will happen before signing a transaction. **Recommendation:** Add a pre-transaction summary screen for every action showing: what will change, estimated fees in XLM, expected post-transaction HF, and estimated gas cost. A "Dry Run" simulation mode would also serve power users.

---

### 11. Developer Experience & Documentation (11 personas)
No public developer documentation exists. The existing code quality (blend.ts, leverage.rs) is high, but undiscoverable. **Recommendation:** Create a simple developer docs site, publish the TypeScript integration code as an npm package, and add a `security.txt` + bug bounty program link in the UI.

---

### 12. Trust Signals & Security Transparency (10 personas)
Multiple skeptical and security-conscious personas cited the lack of visible trust signals. **Recommendation:** Add a "Security" page linking to: GitHub source code, audit reports (exist in the repo), bug bounty program, contract addresses, and Stellar Expert links. Surface contract addresses with one-click copy on the pool selector.

---

*Document generated: 2026-03-23 | Based on exploration of turbolong codebase and frontend.*
