/**
 * Central app state + tiny pub/sub. The shell and screens subscribe; mutating
 * via the setters notifies subscribers so the UI re-renders. Keeps the
 * view/wallet/settings state out of the data layer (blend.ts etc. stay pure).
 */
import type { NetworkMode } from "../blend";

export type View = "dashboard" | "trade" | "vault" | "compare" | "swap" | "status";
export type Theme = "light" | "dark";
export type Lang = "en" | "es" | "pt";

export interface AppState {
  view: View;
  userAddress: string | null;
  connected: boolean;
  network: NetworkMode;
  theme: Theme;
  expert: boolean;
  lang: Lang;
}

const state: AppState = {
  view: "dashboard",
  userAddress: null,
  connected: false,
  network: "mainnet",
  theme: "dark",
  expert: false,
  lang: "en",
};

type Listener = (s: AppState) => void;
const listeners = new Set<Listener>();

export function getState(): Readonly<AppState> {
  return state;
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const l of listeners) l(state);
}

/** Subscribe to state changes. Returns an unsubscribe fn. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
