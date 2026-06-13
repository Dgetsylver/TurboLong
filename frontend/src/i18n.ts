// T3.5 — tiny i18n runtime (no dependency).
//
// - t(key, vars?) resolves a key against the active locale, falling back to
//   English, then to the key itself. {vars} are interpolated as {name}.
// - applyTranslations(root) translates every [data-i18n] (textContent) and
//   [data-i18n-ph] (placeholder) element under root.
// - setLang() persists the choice and re-applies; initI18n() picks the stored
//   language, else the browser's, defaulting to English.

import { LOCALES, type Lang, LANG_NAMES } from "./locales.ts";

const STORAGE_KEY = "tl_lang";
const SUPPORTED: Lang[] = ["en", "es", "pt"];

let activeLang: Lang = "en";
const listeners = new Set<(lang: Lang) => void>();

export function getLang(): Lang {
  return activeLang;
}

export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = LOCALES[activeLang] ?? LOCALES.en;
  let s = dict[key] ?? LOCALES.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

export function applyTranslations(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-ph]")) {
    const key = el.dataset.i18nPh;
    if (key && "placeholder" in el) (el as HTMLInputElement).placeholder = t(key);
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-tip-i18n]")) {
    const key = el.dataset.tipI18n;
    if (key) el.setAttribute("data-tip", t(key));
  }
}

function normalize(raw: string | null | undefined): Lang | null {
  if (!raw) return null;
  const lc = raw.toLowerCase();
  if (lc.startsWith("es")) return "es";
  if (lc.startsWith("pt")) return "pt";
  if (lc.startsWith("en")) return "en";
  return null;
}

export function setLang(lang: Lang, opts: { persist?: boolean } = {}): void {
  if (!SUPPORTED.includes(lang)) return;
  activeLang = lang;
  if (opts.persist !== false) {
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = lang;
    applyTranslations();
  }
  for (const fn of listeners) fn(lang);
}

/** Cycle to the next supported language; returns the new language. */
export function cycleLang(): Lang {
  const idx = SUPPORTED.indexOf(activeLang);
  const next = SUPPORTED[(idx + 1) % SUPPORTED.length];
  setLang(next);
  return next;
}

export function onLangChange(fn: (lang: Lang) => void): void {
  listeners.add(fn);
}

export function langName(lang: Lang = activeLang): string {
  return LANG_NAMES[lang];
}

export function initI18n(): Lang {
  let stored: string | null = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  const lang = normalize(stored)
    ?? normalize(typeof navigator !== "undefined" ? navigator.language : null)
    ?? "en";
  setLang(lang, { persist: false });
  return lang;
}
