/**
 * Turbolong — Dashboard (vanilla-TS port)
 * ----------------------------------------------------------------------------
 * A framework-free reference implementation of the Dashboard screen, written to
 * match the production app's stack (vanilla TS + Vite, no React). It reads the
 * design tokens from `tokens/` (the `--tl-*` CSS custom properties) and mirrors
 * the React reference in `ui_kits/app/DashboardScreen.jsx`.
 *
 * Use this as the PATTERN for porting the other screens: a pure render function
 * that returns an HTMLElement from typed data, plus small helpers. Swap the
 * SEED_* data for your real on-chain fetches (fetchUserPositions, vault reads).
 *
 * Pair with dashboard.css (sibling file) for the tokenized styles.
 */
import "./dashboard.css";

// ── Domain types ────────────────────────────────────────────────────────────
export type Role = 'Looped' | 'Collateral' | 'Borrow';

export interface Leg {
  asset: string;        // e.g. "USDC"
  role: Role;
  amountUsd: number;    // USD value of this leg
  loopX?: number;       // present for Looped legs, e.g. 5.0
  isNew?: boolean;
}

export interface PoolAccount {
  pool: string;         // e.g. "YieldBlox"
  legs: Leg[];
  equityUsd: number;    // collateral − debt, summed for this pool
  netApy: number;       // %, can be negative
  /**
   * ACCOUNT-WIDE health (PR #295): Σ(collateralUsd × cFactor) ÷ Σ(debtUsd) over
   * every reserve in this pool. NOT per-asset. 1.0 = liquidation.
   */
  accountHealth: number;
  hasNew?: boolean;
}

export interface VaultHolding {
  name: string;         // e.g. "USDC · YieldBlox Vault"
  equityUsd: number;
  share: string;        // e.g. "0.12%"
  netApy: number;
  strategyHealth: number; // informational (keeper-protected), not personal liq.
}

export interface DashboardData {
  connected: boolean;
  poolAccounts: PoolAccount[];
  vaults: VaultHolding[];
}

// ── Formatting ──────────────────────────────────────────────────────────────
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

// Risk zone → token color. Mirrors HealthFactor.jsx thresholds.
function hfColor(hf: number): string {
  if (hf < 1.2) return 'var(--tl-danger)';
  if (hf < 1.5) return 'var(--tl-warning)';
  if (hf < 2.0) return 'var(--tl-warning)';
  return 'var(--tl-success)';
}
function hfLabel(hf: number): string {
  if (hf < 1.2) return 'Near liquidation';
  if (hf < 1.5) return 'High risk';
  if (hf < 2.0) return 'Caution';
  return 'Safe';
}
const ROLE_COLOR: Record<Role, string> = {
  Looped: 'var(--tl-primary)',
  Collateral: 'var(--tl-success)',
  Borrow: 'var(--tl-blnd)',
};

// ── Tiny DOM helper ─────────────────────────────────────────────────────────
type Attrs = Record<string, string>;
function el(tag: string, attrs: Attrs = {}, children: (Node | string)[] = []): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'title') node.title = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

// ── Subcomponents ───────────────────────────────────────────────────────────
function metricHero(label: string, value: string, tone?: string, title?: string): HTMLElement {
  return el('div', { class: 'tl-hero' }, [
    el('span', { class: 'tl-hero__label', ...(title ? { title } : {}) }, [label]),
    el('span', { class: 'tl-hero__value', style: tone ? `color:${tone}` : '' }, [value]),
  ]);
}

function miniMetric(label: string, value: string, tone?: string): HTMLElement {
  return el('div', { class: 'tl-mini' }, [
    el('span', { class: 'tl-mini__label' }, [label]),
    el('span', { class: 'tl-mini__value', style: tone ? `color:${tone}` : '' }, [value]),
  ]);
}

function badge(text: string, tone: string): HTMLElement {
  return el('span', { class: `tl-badge tl-badge--${tone}` }, [text]);
}

/** Account Health readout — the account-wide risk number (see HealthFactor.jsx). */
function accountHealth(hf: number, title: string): HTMLElement {
  const pos = Math.max(0, Math.min(1, (hf - 1) / (3 - 1))) * 100;
  const color = hfColor(hf);
  return el('div', { class: 'tl-hf' }, [
    el('div', { class: 'tl-hf__top' }, [
      el('span', { class: 'tl-hf__label', title }, ['Account Health']),
      el('span', { class: 'tl-hf__val', style: `color:${color}` }, [hf.toFixed(2) + ' · ' + hfLabel(hf)]),
    ]),
    el('div', { class: 'tl-hf__track' }, [
      el('div', { class: 'tl-hf__grad' }, []),
      el('div', {
        class: 'tl-hf__mark' + (hf < 1.2 ? ' tl-hf__mark--pulse' : ''),
        style: `left:${pos}%;background:${color};box-shadow:0 0 8px ${color}`,
      }, []),
    ]),
  ]);
}

function legRow(lg: Leg, last: boolean): HTMLElement {
  const left = el('span', { class: 'tl-leg__left' }, [
    el('span', { class: 'tl-mono tl-leg__sym' }, [lg.asset]),
    badge(lg.role, lg.role === 'Looped' ? 'primary' : lg.role === 'Collateral' ? 'success' : 'blnd'),
  ]);
  if (lg.loopX) left.append(el('span', { class: 'tl-leg__sub' }, [lg.loopX.toFixed(1) + '× loop']));
  return el('div', { class: 'tl-leg' + (last ? ' tl-leg--last' : '') }, [
    left,
    el('span', { class: 'tl-mono tl-leg__amt' }, [money(lg.amountUsd)]),
  ]);
}

// ── Cards ───────────────────────────────────────────────────────────────────
function poolCard(acc: PoolAccount, onManage: () => void, onAddLeg: () => void): HTMLElement {
  const cross = acc.legs.length > 1;

  const actions: Node[] = [];
  if (acc.hasNew) actions.push(badge('New', 'primary'));
  if (cross) {
    const xc = badge('Cross-collateralized', 'neutral');
    xc.title = 'More than one asset in this pool. They share one Account Health — every collateral backs every borrow, so liquidation is account-wide, not per leg.';
    actions.push(xc);
  }

  const card = el('section', { class: 'tl-card' }, [
    el('header', { class: 'tl-card__head' }, [
      el('h2', { class: 'tl-card__title' }, [acc.pool + ' ', el('span', { class: 'tl-card__sub' }, ['account'])]),
      el('div', { class: 'tl-card__actions' }, actions),
    ]),
    el('div', { class: 'tl-grid tl-grid--2' }, [
      miniMetric('Equity', money(acc.equityUsd)),
      miniMetric('Net APY', pct(acc.netApy), acc.netApy >= 0 ? 'var(--tl-success)' : 'var(--tl-danger)'),
    ]),
    el('div', { class: 'tl-legs' }, acc.legs.map((lg, i) => legRow(lg, i === acc.legs.length - 1))),
    el('div', { class: 'tl-well' }, [
      accountHealth(acc.accountHealth, 'Pool-wide: total collateral value ÷ total debt across every leg in this pool. Liquidation is account-wide — it triggers when this drops below 1.0.'),
    ]),
  ]);

  if (cross) {
    card.append(el('p', { class: 'tl-note' }, [
      `All legs in ${acc.pool} share this health — every collateral backs every borrow. Liquidation is account-wide, not per asset.`,
    ]));
  }

  const manage = el('button', { class: 'tl-btn tl-btn--secondary tl-flex1' }, ['Manage']);
  manage.addEventListener('click', onManage);
  const add = el('button', { class: 'tl-btn tl-btn--ghost tl-flex1' }, ['Add leg']);
  add.addEventListener('click', onAddLeg);
  card.append(el('div', { class: 'tl-row tl-row--gap' }, [manage, add]));
  return card;
}

function vaultCard(v: VaultHolding, onManage: () => void): HTMLElement {
  const managed = badge('Managed', 'blnd');
  managed.title = 'A passive vault position. A permissionless keeper auto-rebalances the strategy, so you’re not liquidated the way a manual pool account is — the strategy health below is informational.';

  const manage = el('button', { class: 'tl-btn tl-btn--secondary tl-full' }, ['Manage in Vault']);
  manage.addEventListener('click', onManage);

  return el('section', { class: 'tl-card' }, [
    el('header', { class: 'tl-card__head' }, [
      el('h2', { class: 'tl-card__title' }, [v.name]),
      el('div', { class: 'tl-card__actions' }, [managed]),
    ]),
    el('div', { class: 'tl-grid tl-grid--3' }, [
      miniMetric('Your Equity', money(v.equityUsd)),
      miniMetric('Share', v.share),
      miniMetric('Net APY', pct(v.netApy), 'var(--tl-success)'),
    ]),
    el('div', { class: 'tl-strategy' }, [
      el('span', { class: 'tl-dot' }, []),
      'Strategy Health ',
      el('span', { class: 'tl-mono tl-strategy__hf' }, [v.strategyHealth.toFixed(2)]),
      ' · keeper-protected',
    ]),
    manage,
  ]);
}

// ── Screen ──────────────────────────────────────────────────────────────────
export interface DashboardHandlers {
  onNewPosition: () => void;
  onManagePool: (pool: string) => void;
  onGoVault: () => void;
}

export function renderDashboard(data: DashboardData, h: DashboardHandlers): HTMLElement {
  const root = el('div', { class: 'tl-dash' }, []);

  if (!data.connected && data.poolAccounts.length === 0 && data.vaults.length === 0) {
    return el('section', { class: 'tl-card tl-empty' }, ['Connect your wallet to see your positions.']);
  }

  // Header
  const newBtn = el('button', { class: 'tl-btn tl-btn--primary' }, ['+ New Position']);
  newBtn.addEventListener('click', h.onNewPosition);
  root.append(el('div', { class: 'tl-dash__head' }, [
    el('div', {}, [
      el('h1', { class: 'tl-h1' }, ['Dashboard']),
      el('p', { class: 'tl-sub' }, ['Your accounts, grouped by pool. Health is shared across every leg in a pool.']),
    ]),
    newBtn,
  ]));

  // Summary
  const totalEquity = data.poolAccounts.reduce((a, p) => a + p.equityUsd, 0)
    + data.vaults.reduce((a, v) => a + v.equityUsd, 0);
  const poolEquity = data.poolAccounts.reduce((a, p) => a + p.equityUsd, 0) || 1;
  const wAvgApy = data.poolAccounts.reduce((a, p) => a + p.netApy * p.equityUsd, 0) / poolEquity;
  const lowestHf = data.poolAccounts.length
    ? Math.min(...data.poolAccounts.map((p) => p.accountHealth))
    : 0;

  root.append(el('div', { class: 'tl-grid tl-grid--4 tl-dash__summary' }, [
    metricHero('Total Equity', money(totalEquity), undefined, 'Your own capital across all pools and vaults — collateral value minus debt, summed.'),
    metricHero('Avg Net APY', pct(wAvgApy), wAvgApy >= 0 ? 'var(--tl-success)' : 'var(--tl-danger)'),
    metricHero('Positions', String(data.poolAccounts.length + data.vaults.length), undefined, 'Your active pool accounts plus passive vault positions.'),
    metricHero('Lowest Account Health', lowestHf ? lowestHf.toFixed(2) : '—', hfColor(lowestHf || 99), 'The riskiest pool account. Below 1.0 the whole pool account is liquidated.'),
  ]));

  // Group A — Pool Accounts
  if (data.poolAccounts.length) {
    root.append(el('h2', { class: 'tl-group' }, ['Pool Accounts ', el('span', { class: 'tl-group__sub' }, ['active · self-managed'])]));
    root.append(el('div', { class: 'tl-grid tl-grid--2' },
      data.poolAccounts.map((acc) => poolCard(acc, () => h.onManagePool(acc.pool), h.onNewPosition))));
  }

  // Group B — Vaults
  if (data.vaults.length) {
    root.append(el('h2', { class: 'tl-group tl-group--mt' }, ['Vaults ', el('span', { class: 'tl-group__sub' }, ['passive · auto-rebalanced'])]));
    root.append(el('div', { class: 'tl-grid tl-grid--2' },
      data.vaults.map((v) => vaultCard(v, h.onGoVault))));
  }

  return root;
}

// ── Demo seed (replace with real on-chain reads) ────────────────────────────
export const SEED_DASHBOARD: DashboardData = {
  connected: true,
  poolAccounts: [
    {
      pool: 'YieldBlox', equityUsd: 3200, netApy: 19.8, accountHealth: 1.66,
      legs: [
        { asset: 'USDC', role: 'Looped', amountUsd: 5000, loopX: 5.0 },
        { asset: 'EURC', role: 'Collateral', amountUsd: 2400 },
        { asset: 'XLM', role: 'Borrow', amountUsd: 3200 },
      ],
    },
    {
      pool: 'Fixed', equityUsd: 640, netApy: 12.1, accountHealth: 1.48,
      legs: [{ asset: 'XLM', role: 'Looped', amountUsd: 4480, loopX: 7.0 }],
    },
  ],
  vaults: [
    { name: 'USDC · YieldBlox Vault', equityUsd: 3420, share: '0.12%', netApy: 18.6, strategyHealth: 1.62 },
  ],
};

/* Example mount:
   import { renderDashboard, SEED_DASHBOARD } from './dashboard';
   const view = renderDashboard(SEED_DASHBOARD, {
     onNewPosition: () => router.go('trade'),
     onManagePool: (pool) => router.go('trade', { pool }),
     onGoVault: () => router.go('vault'),
   });
   document.getElementById('app')!.replaceChildren(view);
*/
