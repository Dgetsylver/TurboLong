# Requirements Document

## Introduction

This feature adds consented, privacy-scrubbed session replay to the TurboLong frontend. Recording is triggered exclusively when an error is caught inside a transaction flow (openPosition, closePosition, repay, withdraw, claim, increaseLeverage, decreaseLeverage, resupply, swapBlnd, vault deposit/withdraw/rebalance). The feature is off by default and requires explicit user opt-in via the settings dropdown. Before any recording can start, the user must have given consent. All PII — wallet addresses and financial input fields — is masked before data leaves the browser.

The implementation integrates PostHog session replay (or a compatible SDK) into `frontend/src/main.ts` and follows the existing localStorage-based consent and settings patterns already used for the disclaimer overlay, theme, and expert mode.

---

## Glossary

- **Session_Replay_Module**: The self-contained TypeScript module (`sessionReplay.ts`) responsible for initialising the PostHog SDK, managing consent state, masking PII, and starting/stopping recordings.
- **Consent_Store**: The `localStorage` key `"sessionReplayConsent"` whose value is `"granted"` when the user has opted in, absent or any other value otherwise.
- **Replay_Opt_In_Toggle**: The settings-dropdown button that lets the user enable or disable session replay. Mirrors the existing expert-mode and theme toggles.
- **Consent_Dialog**: A modal overlay (reusing the existing disclaimer overlay pattern) that explains what is recorded and asks the user to confirm before the Replay_Opt_In_Toggle activates recording.
- **Transaction_Flow**: Any of the following async functions in `main.ts` whose `catch` block constitutes the error boundary: `openPosition`, `closePosition`, `repay` (inside `closePosition` two-step fallback), `withdraw`, `claim`, `increaseLeverage`, `decreaseLeverage`, `resupply`, `swapBlnd`, vault deposit, vault withdraw, vault rebalance.
- **Error_Boundary**: The `catch (e)` block wrapping a Transaction_Flow. When an error reaches this boundary, the Session_Replay_Module is notified.
- **PII_Mask_Config**: The PostHog `maskAllInputs` and custom `maskTextSelector` configuration that prevents wallet addresses and input field values from appearing in recordings.
- **PostHog_SDK**: The `posthog-js` npm package used as the session replay provider.

---

## Requirements

### Requirement 1: Opt-In Default State

**User Story:** As a user, I want session replay to be off by default, so that my browsing activity is never recorded without my knowledge.

#### Acceptance Criteria

1. THE Session_Replay_Module SHALL initialise with recording disabled when `"sessionReplayConsent"` is absent from `localStorage`.
2. WHEN the application loads, THE Session_Replay_Module SHALL read `localStorage.getItem("sessionReplayConsent")` and SHALL NOT start a PostHog session recording unless the value equals `"granted"`.
3. THE Session_Replay_Module SHALL expose a `isReplayEnabled(): boolean` function that returns `true` if and only if `localStorage.getItem("sessionReplayConsent") === "granted"`.

---

### Requirement 2: Explicit User Consent

**User Story:** As a user, I want to be shown a clear consent dialog before session replay is activated, so that I understand what data is collected and can make an informed choice.

#### Acceptance Criteria

1. WHEN the user clicks the Replay_Opt_In_Toggle for the first time (consent not yet recorded), THE Consent_Dialog SHALL be displayed before any recording starts.
2. THE Consent_Dialog SHALL contain a plain-language description of what is recorded (browser interactions during transaction errors), what is masked (input field values, wallet addresses), and a link to the privacy policy.
3. WHEN the user confirms consent in the Consent_Dialog, THE Session_Replay_Module SHALL set `localStorage.setItem("sessionReplayConsent", "granted")` and SHALL update the Replay_Opt_In_Toggle badge to `"On"`.
4. WHEN the user dismisses the Consent_Dialog without confirming, THE Session_Replay_Module SHALL leave `"sessionReplayConsent"` unchanged and SHALL leave the Replay_Opt_In_Toggle badge as `"Off"`.
5. WHEN the user clicks the Replay_Opt_In_Toggle and consent is already `"granted"`, THE Session_Replay_Module SHALL toggle the feature off by setting `localStorage.setItem("sessionReplayConsent", "revoked")` and SHALL update the badge to `"Off"` without showing the Consent_Dialog again.
6. WHEN the application loads and `"sessionReplayConsent"` equals `"granted"`, THE Session_Replay_Module SHALL restore the Replay_Opt_In_Toggle badge to `"On"` without showing the Consent_Dialog.

---

### Requirement 3: Error-Triggered Recording Only

**User Story:** As a developer, I want session replay to capture only the moments when a transaction error occurs, so that recordings are focused and storage costs are minimised.

#### Acceptance Criteria

1. WHEN an Error_Boundary catches an error and `isReplayEnabled()` returns `true`, THE Session_Replay_Module SHALL call `startErrorReplay(context: ReplayContext)` to begin or resume a PostHog recording.
2. THE `ReplayContext` type SHALL include: `flowName: string` (the Transaction_Flow name), `errorMessage: string` (the caught error message, truncated to 500 characters), and `timestamp: number` (Unix ms).
3. WHEN `startErrorReplay` is called, THE Session_Replay_Module SHALL attach the `ReplayContext` fields as PostHog event properties on a `"tx_error_replay_started"` event.
4. WHILE a recording is active, THE Session_Replay_Module SHALL stop the recording automatically after 60 seconds by calling `posthog.stopSessionRecording()`.
5. IF `isReplayEnabled()` returns `false` when an Error_Boundary fires, THEN THE Session_Replay_Module SHALL take no recording action.
6. THE Session_Replay_Module SHALL NOT start a new recording if a recording is already active (debounce: one recording per error event).

---

### Requirement 4: PII Masking — Input Fields

**User Story:** As a user, I want all financial input values to be masked in recordings, so that my leverage amounts, deposit sizes, and other sensitive inputs are never captured.

#### Acceptance Criteria

1. THE Session_Replay_Module SHALL initialise PostHog with `maskAllInputs: true` so that all `<input>` and `<textarea>` element values are replaced with `*` characters in the recording.
2. THE PII_Mask_Config SHALL include `maskInputOptions: { password: true, text: true, number: true, range: true }` to cover leverage sliders (`<input type="range">`), amount inputs (`<input type="number">`), and any text fields.
3. WHEN PostHog captures a DOM snapshot, THE Session_Replay_Module SHALL ensure that the `leverage-slider`, `leverage-input`, `initial-input`, `add-funds-input`, and `vault-amount-input` elements have their values replaced with masked placeholders.

---

### Requirement 5: PII Masking — Wallet Addresses

**User Story:** As a user, I want my wallet address to be masked in recordings, so that my on-chain identity is not exposed.

#### Acceptance Criteria

1. THE Session_Replay_Module SHALL initialise PostHog with a `maskTextSelector` that targets all DOM elements carrying the CSS class `wallet-address-display` (the class applied to the `#wallet-address` span and any other address display nodes).
2. WHEN PostHog captures a DOM snapshot containing a node matched by `maskTextSelector`, THE Session_Replay_Module SHALL replace the node's text content with `"G****…****"` in the recording.
3. THE Session_Replay_Module SHALL NOT include the raw `userAddress` string in any PostHog event property or identify call.
4. WHERE a wallet address appears in a toast notification text node, THE Session_Replay_Module SHALL mask that text node by adding the `wallet-address-display` class to the toast element before PostHog captures it.

---

### Requirement 6: Settings Integration

**User Story:** As a user, I want to control session replay from the existing settings dropdown, so that I can manage all preferences in one place.

#### Acceptance Criteria

1. THE Replay_Opt_In_Toggle SHALL be rendered as a `<button>` inside the settings dropdown (`#settings-dropdown`) following the same DOM structure as the existing `#expert-toggle` and `#theme-toggle` buttons.
2. THE Replay_Opt_In_Toggle SHALL display a `.settings-badge` child element with text `"Off"` when `isReplayEnabled()` returns `false` and `"On"` when it returns `true`.
3. WHEN the settings dropdown is opened, THE Replay_Opt_In_Toggle SHALL reflect the current consent state without requiring a page reload.
4. THE Replay_Opt_In_Toggle SHALL be accessible: it SHALL have `role="switch"`, `aria-checked` set to `"true"` or `"false"` matching the current state, and a visible label `"Session Replay"`.

---

### Requirement 7: PostHog SDK Initialisation

**User Story:** As a developer, I want the PostHog SDK to be initialised once at app startup with the correct privacy configuration, so that no data is sent before consent and no PII leaks through default settings.

#### Acceptance Criteria

1. THE Session_Replay_Module SHALL call `posthog.init(apiKey, config)` exactly once during application startup, before any Transaction_Flow can execute.
2. WHEN `posthog.init` is called, THE Session_Replay_Module SHALL pass `disable_session_recording: true` so that recording does not start automatically.
3. THE Session_Replay_Module SHALL pass `capture_pageview: false` and `capture_pageleave: false` to prevent automatic page-level event capture.
4. THE Session_Replay_Module SHALL pass `persistence: "localStorage"` so that PostHog state survives page reloads without using cookies.
5. IF the PostHog API key is not defined (empty string or missing environment variable), THEN THE Session_Replay_Module SHALL log a warning to the console and SHALL skip `posthog.init`, leaving all recording functions as no-ops.
6. THE Session_Replay_Module SHALL read the PostHog API key from the Vite environment variable `import.meta.env.VITE_POSTHOG_KEY` so that the key is never hard-coded in source files.

---

### Requirement 8: Error Boundary Instrumentation

**User Story:** As a developer, I want every transaction flow's catch block to call the Session_Replay_Module, so that no error goes unrecorded when the user has consented.

#### Acceptance Criteria

1. THE `main.ts` module SHALL call `notifyTxError(flowName, error)` from the Session_Replay_Module inside the `catch` block of each Transaction_Flow listed in the Glossary.
2. THE `notifyTxError` function SHALL accept `flowName: string` and `error: unknown` parameters and SHALL internally call `startErrorReplay` only when `isReplayEnabled()` returns `true`.
3. WHEN `notifyTxError` is called, THE Session_Replay_Module SHALL derive `errorMessage` by calling `error instanceof Error ? error.message : String(error)` and truncating to 500 characters.
4. THE `notifyTxError` function SHALL be a no-op (no throw, no side effects) when the PostHog SDK was not initialised due to a missing API key.

---

### Requirement 9: Round-Trip Consent Persistence

**User Story:** As a developer, I want consent state to survive page reloads correctly, so that users are not asked to consent again on every visit.

#### Acceptance Criteria

1. FOR ALL sequences of `setConsent(true)` followed by a page reload, `isReplayEnabled()` SHALL return `true` after the reload.
2. FOR ALL sequences of `setConsent(false)` followed by a page reload, `isReplayEnabled()` SHALL return `false` after the reload.
3. THE Session_Replay_Module SHALL treat any `localStorage` value for `"sessionReplayConsent"` other than the exact string `"granted"` as equivalent to consent not given.
4. WHEN `localStorage` is unavailable (e.g. private browsing with storage blocked), THE Session_Replay_Module SHALL default to `isReplayEnabled() === false` and SHALL NOT throw an unhandled exception.
