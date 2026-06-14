/** Theme: dark default, [data-theme] on <html>, persisted. Ported from main.ts. */
import { getState, setState, type Theme } from "./state";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute("data-theme", theme);
  setState({ theme });
}

export function initTheme(): void {
  const saved = localStorage.getItem("theme") as Theme | null;
  applyTheme(saved ?? systemTheme());
  // Follow the OS while the user hasn't made an explicit choice.
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (!localStorage.getItem("theme")) applyTheme(systemTheme());
  });
}

export function toggleTheme(): void {
  const next: Theme = getState().theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
}
