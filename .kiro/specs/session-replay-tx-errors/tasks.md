# Implementation Plan: Session Replay on Failed TX Flows

## Overview

Create `frontend/src/sessionReplay.ts`, update `frontend/index.html` with the consent dialog and settings toggle, and instrument every transaction flow catch block in `frontend/src/main.ts` with `notifyTxError`.

## Tasks

- [ ] 1. Install PostHog SDK and configure environment variable
  - [ ] 1.1 Add posthog-js dependency and env var support
    - Run `npm install posthog-js` in `frontend/`
    - Add `VITE_POSTHOG_KEY=` placeholder to a new `frontend/.env.example` file
    - Add `frontend/.env.local` to `.gitignore` if not already present
    - _Requirements: 7.6_

- [ ] 2. Create `frontend/src/sessionReplay.ts`
  - [ ] 2.1 Scaffold module with types and internal state
    - Define `ReplayContext` interface (`flowName`, `errorMessage`, `timestamp`)
    - Declare internal state: `_initialised`, `_recordingActive`, `_stopTimer`
    - _Requirements: 3.2_

  - [ ] 2.2 Implement `isReplayEnabled()`
    - Read `localStorage.getItem("sessionReplayConsent")` fresh on each call
    - Return `true` only when value is exactly `"granted"`
    - Wrap in try/catch — return `false` if localStorage throws
    - _Requirements: 1.1, 1.2, 1.3, 9.3, 9.4, 9.5_

  - [ ] 2.3 Implement `initSessionReplay()`
    - Read `import.meta.env.VITE_POSTHOG_KEY`
    - If empty/undefined: log warning, set `_initialised = false`, return
    - Call `posthog.init(key, { disable_session_recording: true, capture_pageview: false, capture_pageleave: false, persistence: "localStorage", session_recording: { maskAllInputs: true, maskInputOptions: { password, text, number, range }, maskTextSelector: ".wallet-address-display" } })`
    - Set `_initialised = true`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 4.1, 4.2, 5.1_

  - [ ] 2.4 Implement `startErrorReplay(context: ReplayContext)`
    - Guard: if `_recordingActive` is true, return immediately
    - Call `posthog.startSessionRecording()`
    - Call `posthog.capture("tx_error_replay_started", { flowName, errorMessage, timestamp })`
    - Set `_recordingActive = true`
    - Set `_stopTimer = setTimeout(() => { posthog.stopSessionRecording(); _recordingActive = false; }, 60_000)`
    - _Requirements: 3.1, 3.3, 3.4, 3.6_

  - [ ] 2.5 Implement `notifyTxError(flowName, error)`
    - If `!_initialised` or `!isReplayEnabled()`: return (no-op)
    - Derive `errorMessage`: `error instanceof Error ? error.message : String(error)`, truncate to 500 chars
    - Call `startErrorReplay({ flowName, errorMessage, timestamp: Date.now() })`
    - Never throw
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 3.5_

  - [ ] 2.6 Implement `setupReplayToggle()`
    - Find `#replay-toggle` button in DOM
    - Sync badge text and `aria-checked` to `isReplayEnabled()` on call
    - On click: if `isReplayEnabled()` → set `"sessionReplayConsent"` to `"revoked"`, update badge to `"Off"`, set `aria-checked="false"`
    - On click: if not enabled → show `#replay-consent-overlay`
    - Wire `#replay-consent-accept`: set `"sessionReplayConsent"` to `"granted"`, hide overlay, update badge to `"On"`, set `aria-checked="true"`
    - Wire `#replay-consent-decline`, `#replay-consent-decline` Escape key, and click-outside: hide overlay, leave consent unchanged
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 6.1, 6.2, 6.3, 6.4_

- [ ] 3. Update `frontend/index.html`
  - [ ] 3.1 Add consent dialog overlay HTML
    - Insert `#replay-consent-overlay` div (with `hidden` class) before `#app`, reusing `.disclaimer-overlay` / `.disclaimer-modal` CSS classes
    - Include title, description of what is recorded/masked, accept and decline buttons
    - _Requirements: 2.2_

  - [ ] 3.2 Add replay toggle to settings dropdown
    - Insert `<button id="replay-toggle" class="settings-dropdown-item" role="switch" aria-checked="false">Session Replay <span class="settings-badge">Off</span></button>` after `#theme-toggle` inside `#settings-dropdown`
    - Add `wallet-address-display` class to `#wallet-address` span
    - _Requirements: 6.1, 6.4, 5.1_

- [ ] 4. Update `frontend/src/main.ts`
  - [ ] 4.1 Import and initialise session replay module
    - Add `import { initSessionReplay, notifyTxError, setupReplayToggle } from './sessionReplay.ts'`
    - Call `initSessionReplay()` near the top of the module (before any tx flow can run)
    - Call `setupReplayToggle()` after DOM is ready (alongside other toggle setup calls)
    - _Requirements: 7.1, 6.1_

  - [ ] 4.2 Instrument all transaction flow catch blocks
    - Add `notifyTxError("openPosition", e)` in `openPosition` catch
    - Add `notifyTxError("closePosition", e)` in `closePosition` catch
    - Add `notifyTxError("repay", e)` in repay catch (inside closePosition two-step fallback)
    - Add `notifyTxError("withdraw", e)` in withdraw catch
    - Add `notifyTxError("claim", e)` in claim catch
    - Add `notifyTxError("increaseLeverage", e)` in increaseLeverage catch
    - Add `notifyTxError("decreaseLeverage", e)` in decreaseLeverage catch
    - Add `notifyTxError("resupply", e)` in resupply catch
    - Add `notifyTxError("swapBlnd", e)` in swapBlnd catch
    - Add `notifyTxError("vaultDeposit", e)` in vault deposit catch
    - Add `notifyTxError("vaultWithdraw", e)` in vault withdraw catch
    - Add `notifyTxError("vaultRebalance", e)` in vault rebalance catch
    - _Requirements: 8.1, 8.2_

- [ ] 5. Checkpoint — build verification
  - Run `npm run build` in `frontend/` and confirm zero TypeScript errors
  - Ensure all tasks pass, ask the user if questions arise.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.2"] },
    { "id": 2, "tasks": ["2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4"] },
    { "id": 4, "tasks": ["2.5", "2.6"] },
    { "id": 5, "tasks": ["4.1"] },
    { "id": 6, "tasks": ["4.2"] },
    { "id": 7, "tasks": ["5"] }
  ]
}
```
