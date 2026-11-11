# Mainnet walkthrough: TurboLong access on Nido

This is the mainnet version of the [testnet demo](nido-grants-demo.md), for the account owner to run. Every mainnet transaction in it is either signed with the owner's Nido passkey or made by TurboLong's session key after the owner's click. Nobody else signs anything.

## What runs on mainnet, and the evidence

| | |
| --- | --- |
| Nido wallet | https://nido.fyi, deployed from nidohq/nido `0621f19c` (2026-10-27) |
| Account | Perch account 0.5.1 (wasm `2c976bfd…`, Nido mainnet factory `CBHERM3I…3FAC`). It has `apply_doc`, `document`, `installed_rules` and `capabilities`, and no `apply_grant`. It reports `auth_digest: addr_oz_v1`. |
| Where TurboLong's rules live | The account's own policy document. Nido's `/security/delegate-doc/` page upserts them and submits `apply_doc` through Nido's relayer. A live mainnet account already holds a contract-scoped `session-key` rule written this way. |
| Cap | Compiled to `perch-spending-limit` (OpenZeppelin `spending_limit`, `CAD75KDQ…`). It meters only `transfer`. Going over refuses with `#3221`. |
| Calls signed by TurboLong's key | Sent through Nido's relayer (`https://nido-mainnet.fly.dev`, OpenZeppelin Channels), which pays the fee. TurboLong first runs each call through an enforcing simulation, so a refused call is never sent. |

On a live mainnet account, production Nido renders TurboLong's exact request as two rules:

- `YieldBlox`: only `submit()` on YieldBlox, no cap.
- `XLM`: only `transfer()` on XLM, *Pays to: Only* YieldBlox, up to 5 XLM per day.

Each rule is named for what it covers: the pool's own name, and `XLM`.

Both expire after about 24 hours, and approval stays enabled. A read-only recording simulation on mainnet shows that a 1× supply of 2 XLM to YieldBlox asks the account to authorize exactly `submit → transfer(account, pool, 2 XLM)`.

## Blend on mainnet right now

All three TurboLong mainnet pools refuse new borrows: Etherfuse is admin-frozen (status 4), and Fixed and YieldBlox are on ice (status 3). A leveraged open fails with Blend `#1206` for any wallet. So the walkthrough supplies at **1×** in **YieldBlox**, which still takes supply and withdrawals.

## Before you start

- A Nido mainnet account (https://nido.fyi) holding at least 7 XLM, and its passkey.
- TurboLong from the branch of https://github.com/Dgetsylver/TurboLong/pull/352, served on localhost. The session key needs a secure context, and Nido accepts an http app origin only on localhost.

  ```sh
  cd frontend && npm install && npm run dev
  ```

  Open `http://localhost:5173/?network=mainnet`; the header shows **Mainnet**.
- Popups allowed for `localhost`.

## Steps

1. **Connect → Nido** and pick the mainnet account.
2. **Trade**: pool **YieldBlox**, asset **XLM**. Drag leverage to **1.0×**.
3. On the **TurboLong access** card, set *Up to* **5** XLM per **day**. Press **Allow TurboLong to manage positions**. Nido's sheet lists the two rules above and "What changes: … + added YieldBlox … + added XLM". Press **Review & continue**, then approve with your passkey. Nido's relayer submits `apply_doc`. This is the one transaction the passkey signs.
4. The card turns **Active** and shows *5.00 of 5.00 XLM left this day* and the end time.
5. Deposit **2** XLM at **1.0×** → **Confirm & Open** → confirm. No Nido window opens. The toast says the call was *signed under TurboLong's grant, no passkey prompt*. The card shows *3.00 of 5.00* left.
6. **Add Funds**: **2** XLM at **1.0×**. Again no window; *1.00 of 5.00* left.
7. **Add Funds**: **2** XLM again. The account refuses: *Your account refused: this would go over the spending cap you gave TurboLong.* Nothing is sent. The dialog offers **Use main wallet**; press **Cancel**.
8. **Close** → **Confirm Close**. No window. A close only withdraws, so it moves no XLM out of the wallet and uses none of the cap. The 4 XLM come back.
9. Revoke: **Revoke in Nido** opens Nido's Security page. Revoke TurboLong's session key there; Nido rewrites the document without the two rules, and asks for the passkey once more. **Forget key** stops this browser from signing straight away.

Mainnet transactions: `apply_doc` (passkey), two supplies and one close (session key, through the relayer), and the revoke (passkey). Nothing in the walkthrough borrows.

## What to say about the limits

- **The pool rule is not pinned to the account.** Nido's grant request can pin arguments only on `transfer` (its recipient), so `submit`'s `from`, `spender` and `to` stay open. Whoever holds the session key could move the position itself to another address. The 5 XLM cap protects the XLM in the wallet. Use small amounts.
- **One pool at a time.** The XLM rule is named `XLM` for every pool, and Nido replaces a rule of the same name. Allowing TurboLong in a second pool moves the XLM rule, and its cap, to that pool; the first pool's card goes back to asking for approval.
- **The cap counts gross XLM moved into the pool.** At 1× that is the deposit.
- **Nido calls the session key "a passkey the app holds".** It is a P-256 key made non-extractable in the browser, which signs without a prompt. The rules are its limit.

## The smallest Nido change that pins `submit` to the account

Perch's mainnet document language already has an `is-self` argument predicate. At the deployed source (`c135aca`) it passes validation on any rule and compiles to the interpreter op `ArgAddrIsSelf(i)`. Only Nido's request and draft code can't express it:

1. `lib/policy/docRequest.ts`: accept `grant.<i>.self_args=0,1,2`, argument indexes that must be the account itself, on any grant. Refuse an index that clashes with `to`.
2. `lib/policy/docDraft.ts`, `draftToDoc`: emit `args: [{ index, pred: { type: "is-self" } }]` for each one.
3. The approval sheet: show "Argument *n* must be this account" on the rule.

TurboLong would then add `grant.0.self_args=0,1,2` to its request. Every withdrawal and borrow would have to land back in the owner's account, which closes the gap above.
