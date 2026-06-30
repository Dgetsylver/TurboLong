/**
 * App shell — top nav (logo, view tabs, network toggle, settings menu, wallet),
 * testnet banner, main mount, mobile bottom tab bar. Rebuilt reactively from
 * app state; menu open/close kept in module vars so re-renders preserve it.
 */
import "./shell.css";
import { el, on } from "../ui";
import { getState, setState, subscribe, type View } from "./state";
import { connect, disconnect, switchWallet, switchNetwork, fmtAddr } from "./wallet";
import { toggleTheme } from "./theme";
import { openAppModal } from "./modals";
import { setLang, t } from "../i18n";
import type { Lang } from "../locales";

const NAV: { key: View; i18n: string; fallback: string }[] = [
  { key: "dashboard", i18n: "nav.dashboard", fallback: "Dashboard" },
  { key: "trade", i18n: "nav.trade", fallback: "Trade" },
  { key: "vault", i18n: "nav.vault", fallback: "Vault" },
  { key: "compare", i18n: "nav.compare", fallback: "Compare" },
  { key: "swap", i18n: "nav.swap", fallback: "Swap" },
];
const LANGS: { code: Lang; name: string }[] = [
  { code: "en", name: "English" },
  { code: "es", name: "Español" },
  { code: "pt", name: "Português (BR)" },
];

let settingsOpen = false;
let walletMenuOpen = false;
let langOpen = false;
let navEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let mobileEl: HTMLElement | null = null;

const tr = (key: string, fallback: string) => {
  const v = t(key);
  return v && v !== key ? v : fallback;
};
const go = (view: View) => setState({ view });
const closeMenus = () => {
  settingsOpen = walletMenuOpen = langOpen = false;
};

function navTabs(active: View): HTMLElement[] {
  return NAV.map((it) => {
    const b = el("button", { class: "tl-nav__tab" + (active === it.key ? " is-active" : "") }, [tr(it.i18n, it.fallback)]);
    on(b, "click", () => go(it.key));
    return b;
  });
}

function menuRow(label: string, right: Node | string | null, onClick: () => void): HTMLElement {
  const r = el("button", { class: "tl-menu__row" }, [el("span", {}, [label]), right ?? ""]);
  on(r, "click", onClick);
  return r;
}

function settingsMenu(): HTMLElement {
  const s = getState();
  const badge = (txt: string, on_: boolean) =>
    el("span", { class: "tl-menu__badge" + (on_ ? " is-on" : "") }, [txt]);

  const rows: HTMLElement[] = [
    menuRow("Expert mode", badge(s.expert ? "On" : "Off", s.expert), () => {
      setState({ expert: !s.expert });
    }),
    menuRow("Theme", badge(s.theme === "dark" ? "Dark" : "Light", true), () => {
      toggleTheme();
    }),
  ];

  const langToggle = menuRow(
    "Language",
    el("span", { class: "tl-menu__hint" }, [LANGS.find((l) => l.code === s.lang)?.name ?? "English", " ›"]),
    () => {
      langOpen = !langOpen;
      render();
    },
  );
  rows.push(langToggle);
  if (langOpen) {
    const sub = el("div", { class: "tl-menu__sub" },
      LANGS.map((l) =>
        menuRow(l.name, s.lang === l.code ? el("span", {}, ["✓"]) : null, () => {
          setLang(l.code);
          setState({ lang: l.code });
          langOpen = false;
          render();
        }),
      ),
    );
    rows.push(sub);
  }

  rows.push(el("div", { class: "tl-menu__div" }));
  const items: [string, () => void][] = [
    ["Set up alerts", () => openAppModal("alerts")],
    ["Take the tour", () => openAppModal("tour")],
    ["Keyboard shortcuts", () => openAppModal("shortcuts")],
    ["Status page", () => { window.location.href = "/status.html"; }],
  ];
  for (const [label, act] of items) rows.push(menuRow(label, null, () => { closeMenus(); render(); act(); }));

  return el("div", { class: "tl-menu" }, rows);
}

function walletArea(): HTMLElement {
  const s = getState();
  if (!s.connected || !s.userAddress) {
    const b = el("button", { class: "tl-wallet-connect" }, [tr("nav.connect", "Connect wallet")]);
    on(b, "click", () => void connect());
    return b;
  }
  const pill = el("button", { class: "tl-wallet-pill" }, [
    el("span", { class: "tl-wallet-pill__dot" }),
    el("span", { class: "tl-mono tl-wallet-pill__addr" }, [fmtAddr(s.userAddress)]),
    el("span", { class: "tl-wallet-pill__caret" }, ["▾"]),
  ]);
  on(pill, "click", () => { walletMenuOpen = !walletMenuOpen; settingsOpen = false; render(); });
  const wrap = el("div", { class: "tl-rel" }, [pill]);
  if (walletMenuOpen) {
    wrap.append(el("div", { class: "tl-menu tl-menu--wallet" }, [
      menuRow("Switch wallet", null, () => { closeMenus(); render(); void switchWallet(); }),
      (() => {
        const r = menuRow("Disconnect", null, () => { closeMenus(); render(); void disconnect(); });
        r.classList.add("tl-menu__row--danger");
        return r;
      })(),
    ]));
  }
  return wrap;
}

function renderNav(): HTMLElement {
  const s = getState();
  const testnet = s.network === "testnet";

  const netBtn = el("button", { class: "tl-net" + (testnet ? " is-testnet" : ""), title: "Switch between Mainnet and Testnet" }, [
    testnet ? "Testnet" : "Mainnet",
  ]);
  on(netBtn, "click", () => void switchNetwork(testnet ? "mainnet" : "testnet"));

  const bell = el("button", { class: "tl-gear", title: "Alerts", "aria-label": "Alerts" }, ["🔔"]);
  on(bell, "click", () => { closeMenus(); render(); openAppModal("alerts"); });

  const gear = el("button", { class: "tl-gear" + (settingsOpen ? " is-open" : ""), title: "Settings", "aria-label": "Settings" }, ["⚙"]);
  on(gear, "click", () => { settingsOpen = !settingsOpen; walletMenuOpen = false; langOpen = false; render(); });
  const gearWrap = el("div", { class: "tl-rel" }, [gear, settingsOpen ? settingsMenu() : ""]);

  const right = el("div", { class: "tl-nav__right" }, [netBtn, bell, gearWrap, walletArea()]);

  const logo = el("div", { class: "tl-nav__brand" }, [
    el("img", { src: "/logo.svg", alt: "", class: "tl-nav__logo" }),
    el("span", { class: "tl-nav__word" }, ["Turbo", el("span", { class: "tl-nav__word-accent" }, ["long"])]),
  ]);
  const left = el("div", { class: "tl-nav__left" }, [logo, ...navTabs(s.view)]);

  const nav = el("nav", { class: "tl-nav" }, [left, right]);
  if (settingsOpen || walletMenuOpen) {
    const backdrop = el("div", { class: "tl-nav__backdrop" });
    on(backdrop, "click", () => { closeMenus(); render(); });
    nav.append(backdrop);
  }
  return nav;
}

function renderBanner(): HTMLElement {
  const testnet = getState().network === "testnet";
  if (!testnet) return el("div", { class: "tl-banner is-hidden" });
  const fund = el("button", { class: "tl-banner__fund" }, ["Fund wallet"]);
  return el("div", { class: "tl-banner" }, [
    el("span", { class: "tl-banner__dot" }),
    el("span", {}, ["Testnet mode"]),
    el("span", { class: "tl-banner__sep" }, ["·"]),
    el("span", { class: "tl-banner__sub" }, ["Using Stellar Testnet — no real funds at risk"]),
    fund,
  ]);
}

function renderMobile(): HTMLElement {
  const active = getState().view;
  return el("nav", { class: "tl-mobnav" },
    NAV.map((it) => {
      const b = el("button", { class: "tl-mobnav__tab" + (active === it.key ? " is-active" : "") }, [
        tr(it.key === "dashboard" ? "nav.home" : it.i18n, it.key === "dashboard" ? "Home" : it.fallback),
      ]);
      on(b, "click", () => go(it.key));
      return b;
    }),
  );
}

function render(): void {
  if (navEl) navEl.replaceWith((navEl = renderNav()));
  if (bannerEl) bannerEl.replaceWith((bannerEl = renderBanner()));
  if (mobileEl) mobileEl.replaceWith((mobileEl = renderMobile()));
}

/** Build the shell. Returns the root + the #app-main mount for the router. */
export function buildShell(): { root: HTMLElement; main: HTMLElement } {
  navEl = renderNav();
  bannerEl = renderBanner();
  mobileEl = renderMobile();
  const main = el("main", { class: "tl-main", id: "app-main" });
  const root = el("div", { class: "tl-app" }, [navEl, bannerEl, main, mobileEl]);
  subscribe(render);
  return { root, main };
}
