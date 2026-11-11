import { describe, expect, it } from "vitest";
import { applyNetworkLink } from "../src/app/network-link";

/** A browser tab: an address bar `replaceState` rewrites, and its storage. */
function tab(href: string, stored: Record<string, string> = {}) {
  const location = { href };
  const store = new Map(Object.entries(stored));
  return {
    location,
    store,
    load(next = location.href) {
      location.href = next;
      applyNetworkLink(
        location,
        {
          state: null,
          replaceState: (_state: unknown, _title: string, url?: string | URL | null) => {
            location.href = new URL(String(url), location.href).toString();
          },
        },
        {
          getItem: (k) => store.get(k) ?? null,
          setItem: (k, v) => void store.set(k, v),
          removeItem: (k) => void store.delete(k),
        },
      );
    },
  };
}

describe("?network= demo link", () => {
  it("applies once, so a later header switch survives a reload with its wallet", () => {
    const t = tab("http://localhost:5173/?network=testnet", { networkMode: "mainnet", walletAddress: "GOLD" });
    t.load();
    expect(t.store.get("networkMode")).toBe("testnet");
    expect(t.store.has("walletAddress")).toBe(false); // the mainnet wallet does not carry over
    expect(t.location.href).toBe("http://localhost:5173/");

    // Header toggle to mainnet, connect, reload.
    t.store.set("networkMode", "mainnet");
    t.store.set("walletAddress", "CNIDO");
    t.load();
    expect(t.store.get("networkMode")).toBe("mainnet");
    expect(t.store.get("walletAddress")).toBe("CNIDO");
  });

  it("removes only the network parameter, keeping the others and the hash", () => {
    const t = tab("http://localhost:5173/app?e2e=1&network=mainnet&ref=x#/trade", { walletAddress: "CNIDO" });
    t.load();
    expect(t.location.href).toBe("http://localhost:5173/app?e2e=1&ref=x#/trade");
    expect(t.store.get("networkMode")).toBe("mainnet");
  });

  it("keeps the wallet when the link names the stored network, and ignores an unknown one", () => {
    const t = tab("http://localhost:5173/?network=testnet", { networkMode: "testnet", walletAddress: "CNIDO" });
    t.load();
    expect(t.store.get("walletAddress")).toBe("CNIDO");
    t.load("http://localhost:5173/?network=futurenet");
    expect(t.store.get("networkMode")).toBe("testnet");
    expect(t.store.get("walletAddress")).toBe("CNIDO");
    expect(t.location.href).toBe("http://localhost:5173/");
  });
});
