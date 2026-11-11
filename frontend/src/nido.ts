import { Networks, StrKey } from "@stellar/stellar-sdk";
import type { NetworkMode } from "./blend";

export const isContractAccount = (address: string): boolean => StrKey.isValidContract(address);

/** Nido's preview of Perch dev on testnet (nidohq/nido#356): the only Nido
 * deployment whose accounts take grants (`apply_grant`), so TurboLong's grant
 * mode demo runs there. Accounts from the earlier testnet wallet do not carry
 * over. */
export const NIDO_GRANTS_PREVIEW = "https://356.test.nido.fyi";

/**
 * The wallet origin of `account` on `base`, where its passkey ceremonies run:
 * `<c-address>.<host>` in production, `<c-address>--<N>.<apex>` on Nido's
 * numbered preview hosts (`<N>.<apex>`). Mirrors
 * `accountOrigin` in Nido's current wallets-kit module; the published 0.1.0
 * knows only `pr-<N>` and would send preview ceremonies to a host that does
 * not exist.
 */
export function nidoAccountOrigin(base: string, account: string): string {
  if (!isContractAccount(account)) throw new Error(`Not a contract account: ${account}`);
  const url = new URL(base.includes("://") ? base : `https://${base}`);
  const [first, ...rest] = url.host.split(".");
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);
  const preview = rest.length && !ipv4 ? /^(\d+)$/.exec(first ?? "")?.[1] : undefined;
  const host = preview
    ? `${account.toLowerCase()}--${preview}.${rest.join(".")}`
    : `${account.toLowerCase()}.${url.host}`;
  return `${url.protocol}//${host}`;
}

/** Public simulation sources from Nido's production/testnet deployment workflows.
 * Nido supplies the actual fee payer when its wallet submits; we never sign for these accounts. */
export function nidoConfig(network: NetworkMode) {
  return {
    base:
      (import.meta.env.VITE_NIDO_BASE as string | undefined) ??
      (network === "mainnet" ? "https://nido.fyi" : NIDO_GRANTS_PREVIEW),
    networkPassphrase: network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    /** Nido's relayer (OpenZeppelin Channels), which pays for and sends app
     * calls signed under a grant. The testnet grants preview runs none. */
    relayer: network === "mainnet" ? "https://nido-mainnet.fly.dev" : undefined,
    simulationSource:
      network === "mainnet"
        ? "GB62GN4DMXIPFGZMGITUP2XIGIVDV3IBK263LMEVQ7AEBHF6KWXLIM6V"
        : "GCYVFKNTVZA5AY3KJWPW4NU4247UDDFFOCT4C3WCOKUDQQABIZRZ46I3",
  };
}
