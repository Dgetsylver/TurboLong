import { Networks, StrKey } from "@stellar/stellar-sdk";
import type { NetworkMode } from "./blend";

export const isContractAccount = (address: string): boolean => StrKey.isValidContract(address);

/** Nido's preview of Perch dev on testnet (nidohq/nido#356): the only Nido
 * deployment whose accounts take grants (`apply_grant`), so TurboLong's grant
 * mode demo runs there. Accounts from the earlier testnet wallet do not carry
 * over. */
export const NIDO_GRANTS_PREVIEW = "https://356.test.nido.fyi";

/** Public simulation sources from Nido's production/testnet deployment workflows.
 * Nido supplies the actual fee payer when its wallet submits; we never sign for these accounts. */
export function nidoConfig(network: NetworkMode) {
  return {
    base:
      (import.meta.env.VITE_NIDO_BASE as string | undefined) ??
      (network === "mainnet" ? "https://nido.fyi" : NIDO_GRANTS_PREVIEW),
    networkPassphrase: network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET,
    simulationSource:
      network === "mainnet"
        ? "GB62GN4DMXIPFGZMGITUP2XIGIVDV3IBK263LMEVQ7AEBHF6KWXLIM6V"
        : "GCYVFKNTVZA5AY3KJWPW4NU4247UDDFFOCT4C3WCOKUDQQABIZRZ46I3",
  };
}
