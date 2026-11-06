# Mainnet recording with Nido

This recording uses an existing funded Nido mainnet account with TurboLong's Blend integration. It does not create an account, add a persistent session grant, or publish a frontend.

## Verified network

TurboLong's mainnet Etherfuse pool is `CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI`. Its XLM Soroban asset is `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA`. Both addresses are listed in `frontend/src/blend.ts`. A read-only mainnet RPC query at ledger 65343468 confirmed both contract instances and simulated `get_reserve(XLM)`: the reserve was enabled, with 7 decimals. This query sent no transaction. The mainnet passphrase is `Public Global Stellar Network ; September 2015`; TurboLong's configured RPC and pool values are in the same source file.

Nido production deploy configuration selects mainnet and publishes its relayer simulation source `GB62GN4DMXIPFGZMGITUP2XIGIVDV3IBK263LMEVQ7AEBHF6KWXLIM6V` in Nido's [`deploy-production.yml`](https://github.com/nidohq/nido/blob/main/.github/workflows/deploy-production.yml). This G-address supplies simulations only. Nido signs and submits the smart-account transaction through its wallet flow. It does not become the user's account or a TurboLong signing key.

The matching testnet source `GCYVFKNTVZA5AY3KJWPW4NU4247UDDFFOCT4C3WCOKUDQQABIZRZ46I3` and `https://test.nido.fyi` base come from Nido's [`deploy-testnet.yml`](https://github.com/nidohq/nido/blob/main/.github/workflows/deploy-testnet.yml). Testnet picker validation uses the Stellar test network; mainnet picker validation uses the public network.

## Recording steps

1. Open TurboLong and keep the network label on **Mainnet**. Connect → **Nido**. Select the existing funded Nido mainnet C-address. Connection checks that this contract account exists on TurboLong's selected network.
2. Open **Trade**, select the **Etherfuse** pool and **XLM**, then choose an amount and leverage appropriate for the account. Frame the mainnet network label and the selected pool. Do not imply a rehearsal or mocked result is a live position.
3. Submit the position. Review and approve the displayed XLM `approve` transaction in Nido. Its allowance is limited to the chosen deposit plus one stroop and expires after 120 ledgers. Review and approve the separate Blend position transaction. Nido requests the primary passkey for each transaction; TurboLong does not ask for a persistent delegation grant.
4. Wait for the Nido relayer confirmation and TurboLong's mainnet RPC confirmation before calling the position live. Show the returned transaction hash and resulting position. If either approval is cancelled, a simulation or relayer request fails, or confirmation times out, show the error and check the wallet/transaction before retrying. A timeout can happen after a wallet has submitted.

Nido's smart account is a Soroban contract address. Classic Stellar trustline changes and the Stellar Broker mediator swap do not support C-address sources; TurboLong leaves those paths unavailable for Nido and does not submit them through a different account.

## Human prerequisites and evidence limits

The wallet owner needs an existing funded Nido mainnet account in the same browser/device, its working passkey(s), popup permission, and a functioning, funded Nido relayer. The owner must choose the amount/leverage and approve both transaction prompts. A position can lose its deposit through liquidation. No live wallet connection, signature, position, balance, or transaction is claimed by this PR. Mainnet contract existence and XLM reserve configuration were queried read-only; wallet and transaction behavior is covered with deterministic mocks. Browser checks show the actual mainnet/testnet wallet picker without selecting a wallet.
