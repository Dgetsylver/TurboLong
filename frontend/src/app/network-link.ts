/**
 * A demo link's `?network=testnet|mainnet`: applied once, like the header
 * toggle (a change of network drops the connected wallet), then taken out of
 * the address bar so a reload keeps whatever network is stored by then.
 */
export function applyNetworkLink(
  location: Pick<Location, "href">,
  history: Pick<History, "state" | "replaceState">,
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
): void {
  const url = new URL(location.href);
  const linked = url.searchParams.get("network");
  if (linked === null) return;
  if ((linked === "testnet" || linked === "mainnet") && linked !== storage.getItem("networkMode")) {
    storage.setItem("networkMode", linked);
    storage.removeItem("walletAddress");
  }
  url.searchParams.delete("network");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
