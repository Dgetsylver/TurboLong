import {
  NidoModule,
  AccountSwitchRequestedError,
  accountOrigin,
  clearCachedAddress,
  openCeremonyPopup,
  parseSignReturn,
  signTransactionUrl,
} from "@nidohq/stellar-wallets-kit-module";
import { nidoConfig } from "../nido";
import type { NetworkMode } from "../blend";

export interface WalletSignResult {
  /** The kit's XDR slot contains a transaction hash when `submitted` is true. */
  signedTxXdr: string;
  signerAddress?: string;
  submitted?: true;
}

/** Compatibility with the live wallet's `nido_submitted` response, already
 * supported by Nido's upstream module but absent from published version 0.1.0.
 * Reuse the package's picker, origin-checked popup and URL helpers. Replacing
 * this override requires preserving the account/network checks and shared
 * approval exclusion covered by frontend/test/nido-module.test.ts, as well as
 * support for the submitted flag.
 * https://github.com/nidohq/nido/blob/main/packages/stellar-wallets-kit-module/src/module.ts
 */
export class TurboLongNidoModule extends NidoModule {
  // The package reuses the named nido-wallet popup and accepts origin-only replies.
  // Share this guard across instances so one approval cannot confirm another call.
  private static signing = false;
  private readonly deployment;

  constructor(network: NetworkMode) {
    const deployment = nidoConfig(network);
    super(deployment);
    this.deployment = deployment;
  }

  override async signTransaction(
    txXdr: string,
    opts?: { networkPassphrase?: string; address?: string; path?: string },
  ): Promise<WalletSignResult> {
    if (TurboLongNidoModule.signing) throw new Error("Nido: another transaction approval is already in progress.");
    TurboLongNidoModule.signing = true;
    try {
      const networkPassphrase = opts?.networkPassphrase ?? this.deployment.networkPassphrase;
      if (networkPassphrase !== this.deployment.networkPassphrase) {
        throw new Error("Nido: transaction network does not match the connected wallet.");
      }
      const { address } = await this.getAddress({ skipRequestAccess: true });
      if (opts?.address && opts.address !== address) {
        throw new Error("Nido: reconnect before signing with a different account.");
      }
      const url = signTransactionUrl({
        base: this.deployment.base,
        account: address,
        xdr: txXdr,
        networkPassphrase,
        dappOrigin: window.location.origin,
        returnUrl: window.location.href,
      });
      const { search } = await openCeremonyPopup(url, accountOrigin(this.deployment.base, address));
      const params = new URLSearchParams(search);
      const hash = params.get("nido_submitted");
      if (hash !== null) {
        if (params.get("kind") !== "tx" || !/^[a-f0-9]{64}$/i.test(hash)) {
          throw new Error("Nido: invalid transaction confirmation. Check the wallet before retrying.");
        }
        return { signedTxXdr: hash, signerAddress: address, submitted: true };
      }
      const result = parseSignReturn(search);
      if (result?.status === "switch-account") {
        clearCachedAddress();
        throw new AccountSwitchRequestedError();
      }
      if (result?.status === "cancelled") throw new Error("Nido: signing was cancelled.");
      if (result?.status === "error") throw new Error(`Nido: ${result.error}`);
      // The live wallet submits itself. Never interpret an old signed-XDR reply
      // as confirmation or broadcast an envelope without a fee-payer signature.
      throw new Error("Nido: no transaction confirmation. Check the wallet before retrying.");
    } finally {
      TurboLongNidoModule.signing = false;
    }
  }
}
