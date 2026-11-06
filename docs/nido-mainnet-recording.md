# Mainnet recording with Nido

This recording uses an existing funded Nido mainnet account with TurboLong's Blend integration. It does not create an account, add a persistent session grant, or publish a frontend.

## Verified network

TurboLong's mainnet Etherfuse pool, XLM Soroban asset, RPC and network passphrase are defined by `MAINNET_CONFIG` in [`frontend/src/blend.ts`](../frontend/src/blend.ts). A read-only mainnet RPC query at ledger 65343468 confirmed the configured pool and XLM contract instances and simulated `get_reserve(XLM)`: the reserve was enabled, with 7 decimals. This query sent no transaction.

[`nidoConfig`](../frontend/src/nido.ts) owns the wallet base URL, network passphrase and public simulation source for each network. Its simulation sources come from Nido's [`deploy-production.yml`](https://github.com/nidohq/nido/blob/main/.github/workflows/deploy-production.yml) and [`deploy-testnet.yml`](https://github.com/nidohq/nido/blob/main/.github/workflows/deploy-testnet.yml). These G-addresses supply simulations only. Nido signs and submits the smart-account transaction through its wallet flow. The simulation source does not become the user's account or a TurboLong signing key.

Leave `VITE_NIDO_BASE` unset for automatic wallet deployment selection when switching networks. An override replaces the wallet URL for both networks; it does not change the selected passphrase or simulation source. Testnet picker validation uses the Stellar test network; mainnet picker validation uses the public network.

## Recording steps

1. Open TurboLong and keep the network label on **Mainnet**. Connect → **Nido**. Select the existing funded Nido mainnet C-address. Connection checks that this contract account exists on TurboLong's selected network.
2. Open **Trade**, select the **Etherfuse** pool and **XLM**, then choose an amount and leverage appropriate for the account. Frame the mainnet network label and the selected pool. Do not imply a rehearsal or mocked result is a live position.
3. Submit the position. Review and approve the displayed XLM `approve` transaction in Nido. Its allowance is limited to the chosen deposit plus one stroop and expires after 120 ledgers. Review and approve the separate Blend position transaction. Nido requests the primary passkey for each transaction; TurboLong does not ask for a persistent delegation grant. Finish or cancel each approval before starting another action: TurboLong rejects overlapping Nido transaction approvals.
4. Wait for the Nido relayer confirmation and TurboLong's mainnet RPC confirmation before calling the position live. Show the returned transaction hash and resulting position. If either approval is cancelled, a simulation or relayer request fails, or confirmation times out, show the error and check the wallet/transaction before retrying. A timeout can happen after a wallet has submitted.

Nido's smart account is a Soroban contract address. This integration supports Blend position operations and skips classic trustline setup for C-accounts. BLND claiming (including Claim & Convert), vault deposit/withdrawal/rebalance, Aquarius receipt-token swaps, classic Stellar trustline changes, and Stellar Broker swaps require a classic wallet. TurboLong rejects these workflows for C-accounts before building a transaction, including before claiming any rewards for Claim & Convert.

## Human prerequisites and evidence limits

The wallet owner needs an existing funded Nido mainnet account in the same browser/device, its working passkey(s), popup permission, and a functioning, funded Nido relayer. The owner must choose the amount/leverage and approve both transaction prompts. A position can lose its deposit through liquidation. No live wallet connection, signature, position, balance, or transaction is claimed by this PR. Mainnet contract existence and XLM reserve configuration were queried read-only; wallet and transaction behavior is covered with deterministic mocks. Browser checks show the actual mainnet/testnet wallet picker without selecting a wallet.
