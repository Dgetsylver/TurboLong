---
sidebar_position: 2
---

# UX Research & Analysis

This page summarizes key findings from a comprehensive UX/UI audit involving 100 user personas across 13 categories.

## Key Findings by User Segment

### Power Users (Personas 1–10)

**What they need:**

- Keyboard shortcuts for fast actions
- Advanced data panels (rate curves, protocol params)
- CSV/JSON position exports
- API access for bots
- Execution fee transparency

**Suggested features:**

- Public REST/GraphQL API for bot monitoring
- Keyboard navigation (L = leverage, C = close)
- Skeleton screens instead of spinners
- "Verify on-chain" links (Stellar Expert)

### DeFi Beginners (Personas 11–20)

**What they need:**

- Plain-language explanations
- Guided onboarding (6–8 steps)
- Beginner mode (limit to 2× leverage)
- Tooltips on every acronym (HF, APY, TVL)
- "What could go wrong?" scenario explanations

**Suggested features:**

- Interactive tour on first visit
- Inline help: "Is this safe for me?" checklist
- Paper trading (practice with simulated funds)
- Prominent "Close my position safely" guide

### Traditional Finance Background (Personas 21–30)

**What they need:**

- Familiar financial concepts (LTV, coverage ratios)
- Executive summary (3 numbers, 5 seconds to understand)
- Risk disclosure documents (PDF)
- Counterparty risk explanations
- Sharpe ratio or risk-adjusted metrics

**Suggested features:**

- "At a Glance" dashboard: APY, HF, P&L
- Email/calendar alerts for HF warnings
- Annualized return vs. benchmark comparison
- "Due Diligence" page with audit links

### Accessibility-Focused Users (Personas 31–38)

**What they need:**

- WCAG AAA contrast ratios
- Full keyboard navigation
- Screen reader support (ARIA labels)
- Text sizing up to 200%
- No color-only information

**Suggested features:**

- High contrast mode toggle
- Proper heading hierarchy (h1 → h2 → h3)
- Live region announcements for HF updates
- Min 44×44px tap targets on mobile

### Mobile-First Users (Personas 39–46)

**What they need:**

- Fast load times (<500KB)
- Bottom-sheet navigation (thumb reach)
- One-handed operation
- Offline caching
- Local currency display

**Suggested features:**

- Compress charts; lazy-load non-critical assets
- CTA buttons at bottom of screen
- Pull-to-refresh
- PWA home screen icon
- Support for local dialects

### Risk-First Users (Personas 47–54)

**What they need:**

- Worst-case scenarios explicitly shown
- Clear downside/upside
- Automated stop-loss equivalents (auto-deleverage at HF threshold)
- Emergency exit procedures
- Smart contract risk disclosure

**Suggested features:**

- "If rates spike to X%, you get liquidated in Y days"
- Auto-rebalance at HF threshold with pre-signed transactions
- Circuit breaker indicator (pool in recovery mode?)
- Emergency Deleverage button (1-click partial close)

### Yield Farmers (Personas 55–62)

**What they need:**

- APY leaderboard (all pool/asset combos)
- Rate alerts when APY drops
- Compounding projection charts
- BLND reward tracking
- Emission-vs-organic APY breakdown

**Suggested features:**

- "Best opportunity today" banner on homepage
- "Optimize My Portfolio" button (1-click rebalance suggestion)
- Sustainable yield labeling
- Monthly income projections

### Institutional Users (Personas 63–70)

**What they need:**

- Multi-sig wallet support
- Multi-account/desk management
- Governance-compatible flows
- Compliance reporting (CSV/JSON)
- Sub-account permission roles

**Suggested features:**

- DAO treasury workflows
- Batch transaction execution
- Regulatory reporting format compatibility
- Webhook subscriptions for position events

### International/Non-English Users (Personas 79–86)

**What they need:**

- Multi-language support (Spanish, Mandarin, Arabic, etc.)
- Local currency display
- RTL layout (Arabic)
- Asset-specific focus by region (CETES for LatAm, TESOURO for Brazil)
- Time zone support

**Suggested features:**

- Language selector in navbar
- Geolocation-based default currency
- RTL CSS for Arabic/Hebrew
- Regional asset highlights on homepage

## Design Principles Across All Personas

### 1. Progressive Disclosure

Don't overwhelm beginners; give experts all the data they need.

```
Beginner view: "Supply $1,000, earn ~$100/month"
Expert view: "Supply $1,000, borrow $900, 3-kink rate at 80% util, HF 1.056..."
```

### 2. Real-Time Without Distraction

Update values live but avoid flashing/animation anxiety.

```
✅ Smooth fade-in for rate changes
❌ Pulsing red warning box every update
```

### 3. Failures are Informative

Never just say "Error." Tell users what went wrong and how to fix it.

```
❌ "insufficient_fee_error"
✅ "Your wallet doesn't have enough XLM for fees. You need $0.001 more."
```

### 4. One Primary Action Per Screen

Reduce cognitive load and decision paralysis.

```
Screen 1: "Deposit amount?"
Screen 2: "Choose leverage?"
Screen 3: "Review and confirm?"
NOT: 20 options on one screen
```

### 5. Familiar Metaphors for Newcomers

Map DeFi concepts to what users already know.

```
"Health Factor works like a loan-to-value (LTV) ratio"
"Leverage is like taking a mortgage on a house"
"Liquidation is like foreclosure"
```

## Recommended Roadmap

### Phase 1: Core Accessibility + Mobile (Months 1–2)

- [ ] High-contrast mode toggle
- [ ] Keyboard navigation (leverage slider, tabs)
- [ ] ARIA labels for screen readers
- [ ] Mobile optimization (bottom CTAs, responsive)

### Phase 2: Educational Features (Months 2–3)

- [ ] Interactive onboarding tour
- [ ] Tooltips on all acronyms
- [ ] "What does this mean?" expandable sections
- [ ] Video tutorials (YouTube embeds)

### Phase 3: Power User Features (Months 3–4)

- [ ] Public API / GraphQL endpoint
- [ ] CSV/JSON export
- [ ] Advanced Stats panel (rate curves, protocol params)
- [ ] Keyboard shortcuts

### Phase 4: Institutional Features (Months 4–5)

- [ ] Multi-sig wallet support
- [ ] Multi-account management
- [ ] Webhook notifications
- [ ] Compliance reporting

## Metrics to Track

### User Engagement

- **Onboarding completion rate** — % of users completing first position (target: >60%)
- **Return rate** — % of users returning after 7 days (target: >30%)
- **Position duration** — Average days a position stays open (target: >7 days)

### Safety

- **Liquidation rate** — % of positions liquidated (target: <2%)
- **User satisfaction score** — NPS or CSAT (target: >40)
- **Support ticket volume** — Scaled by user base (target: <1 ticket per 100 users)

### Accessibility

- **WCAG audit score** — Automated + manual testing (target: AAA for critical flows)
- **Screen reader usability** — Test with NVDA/JAWS (target: >95% feature coverage)
- **Mobile conversion rate** — % of positions opened on mobile (target: >30% by year 2)

## See Also

- [User Guide & Risk Management](../guides/user-guide.md)
- [Getting Started](../guides/getting-started.md)
- [Frontend Architecture](../architecture/frontend.md)
