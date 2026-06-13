# Requirements Document

## Introduction

When a user makes their first deposit into a Blend leveraged-loop position, the transaction can fail with a "no trustline" error if the user's Stellar account has not yet established trustlines for the pool's b_tokens (supply receipt tokens), d_tokens (debt receipt tokens), and the BLND reward token. This feature eliminates that failure mode by detecting missing trustlines before the deposit is submitted and bundling the necessary `changeTrust` operations into the same signed transaction envelope, so the user only needs to sign once and the deposit succeeds on the first attempt.

## Glossary

- **b_token**: A Soroban-wrapped Stellar classic asset representing a user's supply (collateral) share in a Blend pool reserve. Each reserve has one b_token. Its classic asset code follows the pattern `bXXX` where `XXX` is the underlying asset symbol.
- **d_token**: A Soroban-wrapped Stellar classic asset representing a user's debt share in a Blend pool reserve. Each reserve has one d_token. Its classic asset code follows the pattern `dXXX`.
- **BLND**: The Blend protocol reward token (`BLND` issued by `GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY` on mainnet). Users accumulate BLND emissions while holding positions; a trustline is required to receive them.
- **Trustline**: A Stellar classic ledger entry that authorises an account to hold a specific asset. Created via the `changeTrust` operation. An account can hold at most 1,000 trustlines (the Stellar trustline limit).
- **Trustline_Checker**: The module responsible for querying Horizon to determine which required trustlines are absent from a user's account.
- **Bundle_Builder**: The module responsible for prepending `changeTrust` operations to an existing transaction XDR when missing trustlines are detected.
- **Deposit_Flow**: The end-to-end sequence in `main.ts` that handles the "Open Position" user action, including approve, open-position, and any trustline setup steps.
- **First Deposit**: Any deposit attempt where the user does not yet hold b_tokens or d_tokens for the target pool reserve (i.e., no existing Blend position for that asset).
- **Horizon**: The Stellar REST API used to load account state, including existing trustlines.

---

## Requirements

### Requirement 1: Detect Missing Trustlines Before Deposit

**User Story:** As a user opening a leveraged position for the first time, I want the app to automatically detect which trustlines I am missing, so that my deposit does not fail with a "no trustline" error.

#### Acceptance Criteria

1. WHEN a user initiates a deposit, THE Trustline_Checker SHALL query the user's Horizon account record to retrieve the current list of established trustlines.
2. WHEN the Horizon account record is retrieved, THE Trustline_Checker SHALL compare the existing trustlines against the required set: the b_token, d_token, and BLND token for the target pool reserve.
3. WHEN all required trustlines are already present, THE Trustline_Checker SHALL return an empty list of missing trustlines, resulting in no `changeTrust` operations being added.
4. IF the Horizon account query fails, THEN THE Trustline_Checker SHALL propagate the error to the Deposit_Flow so the deposit is aborted with a descriptive message rather than silently proceeding without trustline setup.

---

### Requirement 2: Bundle Trustline Operations Into the Deposit Transaction

**User Story:** As a user, I want trustline creation to happen in the same transaction as my deposit, so that I only need to sign once and the entire operation is atomic.

#### Acceptance Criteria

1. WHEN the Trustline_Checker returns one or more missing trustlines, THE Bundle_Builder SHALL prepend one `changeTrust` operation per missing trustline to the existing deposit transaction XDR before it is presented to the user for signing.
2. THE Bundle_Builder SHALL set the `limit` parameter of each `changeTrust` operation to the Stellar maximum trustline limit (`"922337203685.4775807"`), ensuring the trustline does not artificially cap the user's token balance.
3. THE Bundle_Builder SHALL preserve all existing operations in the transaction (approve and open-position Soroban calls) unchanged after prepending the `changeTrust` operations.
4. WHEN trustline operations are bundled, THE Deposit_Flow SHALL present the combined transaction to the user for a single wallet signature rather than requiring separate signing steps.
5. WHEN no trustlines are missing, THE Bundle_Builder SHALL return the original transaction XDR unmodified.

---

### Requirement 3: Handle the Stellar Trustline Limit

**User Story:** As a user whose account is near the Stellar trustline limit, I want to receive a clear error before signing, so that I am not surprised by an on-chain failure.

#### Acceptance Criteria

1. WHEN the Trustline_Checker determines the number of missing trustlines, THE Trustline_Checker SHALL calculate the user's projected trustline count as: `(current trustline count) + (number of missing trustlines)`.
2. IF the projected trustline count exceeds 1,000, THEN THE Trustline_Checker SHALL return an error indicating the trustline limit would be exceeded, and THE Deposit_Flow SHALL abort the deposit and display a message instructing the user to remove unused trustlines before proceeding.
3. WHEN the projected trustline count is exactly 1,000 or fewer, THE Trustline_Checker SHALL allow the deposit to proceed normally.

---

### Requirement 4: No-Op When Trustlines Already Exist

**User Story:** As a returning user who already has all required trustlines, I want the deposit flow to behave exactly as before, so that no unnecessary operations are added to my transaction.

#### Acceptance Criteria

1. WHEN all required trustlines for the target pool reserve are already present on the user's account, THE Deposit_Flow SHALL NOT add any `changeTrust` operations to the transaction.
2. WHEN all required trustlines are already present, THE Deposit_Flow SHALL NOT make any additional Horizon or RPC calls beyond those already performed in the normal deposit flow.
3. FOR ALL deposit attempts where trustlines are already present, the resulting transaction XDR SHALL be byte-for-byte identical to the XDR that would have been produced without the trustline-auto-setup feature enabled (round-trip property: the no-op path is transparent).

---

### Requirement 5: Identify Required Trustlines for a Pool Reserve

**User Story:** As a developer, I want a deterministic function that returns the full set of classic assets requiring trustlines for a given pool reserve, so that the detection logic is reusable and testable.

#### Acceptance Criteria

1. THE Trustline_Checker SHALL derive the b_token classic asset for a reserve by reading the Soroban token contract's `symbol` and `issuer` metadata from the active network configuration.
2. THE Trustline_Checker SHALL derive the d_token classic asset for a reserve using the same mechanism as the b_token.
3. THE Trustline_Checker SHALL always include the BLND classic asset (`blndClassic` from the active network config) in the required trustline set, regardless of which pool or reserve is being deposited into.
4. WHEN the active network is testnet, THE Trustline_Checker SHALL use the testnet BLND asset and testnet b_token/d_token issuers from `TESTNET_CONFIG`.
5. WHEN the active network is mainnet, THE Trustline_Checker SHALL use the mainnet BLND asset and mainnet b_token/d_token issuers from `MAINNET_CONFIG`.
