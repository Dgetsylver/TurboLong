import i18next from "i18next";
import en from "./en.json";
import es from "./es.json";
import ptBR from "./pt-BR.json";

const STORAGE_KEY = "turbolong_lang";
const SUPPORTED = ["en", "es", "pt-BR"] as const;
export type Locale = (typeof SUPPORTED)[number];

export function getSavedLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
  return saved && (SUPPORTED as readonly string[]).includes(saved) ? saved : "en";
}

export async function initI18n(): Promise<void> {
  await i18next.init({
    lng: getSavedLocale(),
    fallbackLng: "en",
    resources: {
      en:      { translation: en },
      es:      { translation: es },
      "pt-BR": { translation: ptBR },
    },
    interpolation: { escapeValue: false },
  });
}

export function t(key: string, opts?: Record<string, unknown>): string {
  return i18next.t(key, opts as any) as string;
}

export async function setLocale(locale: Locale): Promise<void> {
  localStorage.setItem(STORAGE_KEY, locale);
  await i18next.changeLanguage(locale);
}

export function getCurrentLocale(): string {
  return i18next.language;
}

export { SUPPORTED };
