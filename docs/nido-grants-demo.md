# Demo: TurboLong under a Nido grant

The owner approves TurboLong's grant once with their Nido passkey. After that, TurboLong's own session key opens, adds to and closes XLM positions with no wallet prompt. The account checks every call against the grant and refuses anything outside it, including a call over the spending cap.

## Where it runs

This script runs on testnet, against Perch grants (`apply_grant`) on Perch dev, which Nido previews at **https://356.test.nido.fyi** ([nidohq/nido#356](https://github.com/nidohq/nido/pull/356)). On testnet, TurboLong's Nido wallet is that preview (`nidoConfig` in [`frontend/src/nido.ts`](../frontend/src/nido.ts)). Accounts made on the earlier testnet wallet do not carry over to it.

Mainnet works too, with the same request to Nido: Nido's mainnet accounts (Perch 0.5.1) have no grants, so Nido writes TurboLong's two rules into the account's own policy document (`apply_doc`). Nido's relayer sends the calls. See [the mainnet walkthrough](nido-grants-mainnet.md). Classic wallets, and Nido accounts that haven't allowed TurboLong, keep the main-wallet flow (an `approve` and a Blend transaction, each confirmed with the passkey).

## What the grant allows

For the selected Blend pool, two rules signed by TurboLong's session key:

| Rule | Contract | Functions | Limits |
| --- | --- | --- | --- |
| `tl-submit-<pool>` | the Blend pool | `submit` | no cap: `submit` moves no tokens itself |
| `tl-xlm-<pool>` | XLM | `transfer` | pays only the pool; a rolling cap (40 XLM per day in this script) |

Both rules expire after 24 hours. The owner can change the cap and expiry on Nido's approval sheet.

Grant mode calls Blend's plain `submit`, so Blend pulls the supplied XLM with the account's own `transfer(account, pool, n)`. That transfer is what the XLM rule caps and pins. TurboLong's main-wallet flow uses `approve` and `submit_with_allowance` instead. A grant cannot carry that flow: Perch caps only rules that allow exactly `transfer`, and Nido pins only `transfer`'s recipient.

Plain `submit` settles gross. It pulls every supplied unit first and pays the borrowed XLM back in the same transaction. Opening 10 XLM at 2x pulls 20 XLM, so the account needs 20 XLM on hand and the cap counts 20. A close repays the debt plus a 0.1% margin (Blend refunds the excess in the same transaction), so the cap counts about the debt.

## Before you record

1. `cd frontend && npm install && npm run dev`, then open `http://localhost:5173/?network=testnet`. The header shows **Testnet**.
2. Create a Nido account on https://356.test.nido.fyi (New account, one passkey). Friendbot funds it with 10,000 testnet XLM.
3. In TurboLong, Connect → **Nido** and pick that account. Allow popups for `localhost`.

## Script

1. **Trade** → pool **RegionalStarterPack**, asset **XLM**. Point at the **Grant mode** card: its *Testnet · Perch dev preview* label, the two rules, and the session-key line. The key is a P-256 key that this browser made as non-extractable. It signs with no prompt, so the grant's rules are the only limit on it.
2. Set the cap to **40** XLM per day and press **Approve grant in Nido**. Nido's popup shows each rule: the contract, its functions, *Pays to: Only* the pool, the cap and the expiry. Press **Review & continue**, then approve with the passkey. This is the only passkey prompt in the demo. The card turns **Active** and shows *40.00 of 40.00 XLM left this day* and the expiry.
3. Enter **10** XLM, set leverage to **2×**, and press **Confirm & Open**, then confirm the review. No Nido window opens. The stepper reads *Session key signs → Account checks grant → Confirmed*, and the toast says the transaction was *signed under TurboLong's grant, no passkey prompt*. The cap meter drops to *20.00 of 40.00*.
4. Press **Close** → **Confirm Close**. Again no Nido window. The cap shows about *9.98 of 40.00* left. The close pulled the 10 XLM debt plus a 0.1% margin; Blend refunds the margin in the same transaction, but the cap counts the full pull.
5. Open **10** XLM at **2×** again. The account refuses: *Your account refused: no rule in TurboLong's grant allows this call. It is over the spending cap, outside the grant's scope, or the grant expired.* The refusal came from an enforcing simulation, so nothing was sent and no fee was paid. The dialog offers **Use main wallet**, which runs the usual approve + submit flow with Nido's passkey prompts. Press **Cancel** for the recording. The refusal stays on the Grant mode card.
6. Optional: switch the asset to **USDC** and open. The grant covers no USDC transfer, so TurboLong declines to sign and offers the main wallet.
7. Revoke: **Revoke in Nido** opens Nido's Security page, where **Remove app** removes the grant from the account (`remove_grant`). **Forget key** deletes the session key from this browser at once, so it cannot sign even before the grant is removed.

## What to say about the limits

- The pool rule cannot pin `submit`'s `from`, `spender` or `to` arguments, because Nido's grant request has no way to express that yet. Within the pool, a holder of the session key could direct borrows or withdrawals to another address, up to the position's equity. The XLM cap protects the wallet's liquid XLM, not the Blend position. Use throwaway testnet funds.
- The session key is presented to Nido as "a passkey the app holds". The account's WebAuthn verifier checks no relying party or origin, so TurboLong assembles the assertion itself and sets the user-verified flag. Nido's own SDK does the same for session keys (`buildSyntheticAssertion`); TurboLong's key differs in staying non-extractable.
- Grant-signed transactions are paid for by a throwaway fee payer in this browser, funded by Friendbot (the preview runs no relayer). It pays fees and nothing else.

## Automated runs

- `cd frontend && npx vitest run test/grant.test.ts test/grant-sim.test.ts`: grant construction, Nido's request URL, on-chain grant parsing, cap and expiry math, the auth digest and payload, the session key's assertion, and the whole script against an emulated Perch dev account that verifies the signature and enforces scope and cap.
- `cd frontend/e2e && npm install && npm run test:e2e:testnet`: the script above, live on testnet, with a virtual passkey and a fresh Friendbot-funded Nido account. It writes screenshots and transaction hashes to `test-results/grants-demo/` (or `DEMO_OUT`). Not part of CI.
