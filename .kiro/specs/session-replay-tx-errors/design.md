# Design Document

## Overview

This design adds a self-contained `sessionReplay.ts` module to the TurboLong frontend that integrates PostHog session replay with strict privacy controls. Recording is triggered only when a transaction flow's `catch` block fires and the user has explicitly opted in. All PII (input values, wallet addresses) is masked at the SDK configuration level before any data leaves the browser.

Three files are modified or created:
1. **`frontend/src/sessionReplay.ts`** — new module: PostHog init, consent management, PII masking, error-triggered recording
2. **`frontend/index.html`** — add consent dialog overlay + replay toggle button in settings dropdown
3. **`frontend/src/main.ts`** — import module, call `notifyTxError` in each tx flow catch block, wire toggle button

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  main.ts                                                    │
│                                                             │
│  import { initSessionReplay, notifyTxError,                 │
│           setupReplayToggle } from './sessionReplay.ts'     │
│                                                             │
│  initSessionReplay()  ← called once at module top level     │
│  setupReplayToggle()  ← wires #replay-toggle button         │
│                                                             │
│  async function openPosition() {                            │
│    try { ... }                                              │
│    catch (e) { notifyTxError("openPosition", e); ... }      │
│  }                                                          │
│  // same pattern for all 12 tx flows                        │
└────────────────────┬────────────────────────────────────────┘
                     │ calls
┌────────────────────▼────────────────────────────────────────┐
│  sessionReplay.ts                                           │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│  │ initSession  │  │ isReplay     │  │ notifyTxError     │ │
│  │ Replay()     │  │ Enabled()    │  │ (flowName, err)   │ │
│  │              │  │              │  │                   │ │
│  │ posthog.init │  │ reads        │  │ → startError      │ │
│  │ with privacy │  │ localStorage │  │   Replay()        │ │
│  │ config       │  │              │  │                   │ │
│  └──────────────┘  └──────────────┘  └───────────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ startErrorReplay(context: ReplayContext)             │   │
│  │  • guard: already recording? → skip                 │   │
│  │  • posthog.startSessionRecording()                  │   │
│  │  • posthog.capture("tx_error_replay_started", ctx)  │   │
│  │  • setTimeout(stopRecording, 60_000)                │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ setupReplayToggle()                                  │   │
│  │  • reads #replay-toggle from DOM                    │   │
│  │  • on click: if granted → revoke                    │   │
│  │              if not granted → show consent dialog   │   │
│  │  • updates badge + aria-checked                     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                     │ SDK calls
┌────────────────────▼────────────────────────────────────────┐
│  posthog-js (npm)                                           │
│  • disable_session_recording: true  (no auto-record)        │
│  • maskAllInputs: true                                      │
│  • maskInputOptions: { password, text, number, range }      │
│  • maskTextSelector: ".wallet-address-display"              │
│  • capture_pageview: false                                  │
│  • capture_pageleave: false                                 │
│  • persistence: "localStorage"                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Components and Interfaces

### `sessionReplay.ts` — Public API

```typescript
/** Call once at app startup. No-op if VITE_POSTHOG_KEY is empty. */
export function initSessionReplay(): void

/** Returns true iff localStorage["sessionReplayConsent"] === "granted". Never throws. */
export function isReplayEnabled(): boolean

/**
 * Called from every tx flow catch block.
 * Internally calls startErrorReplay() only when isReplayEnabled() === true.
 * No-op if SDK not initialised. Never throws.
 */
export function notifyTxError(flowName: string, error: unknown): void

/**
 * Wires the #replay-toggle button and syncs its badge/aria state.
 * Call after DOM is ready.
 */
export function setupReplayToggle(): void
```

### `ReplayContext` type

```typescript
interface ReplayContext {
  flowName: string;      // e.g. "openPosition"
  errorMessage: string;  // error.message or String(error), max 500 chars
  timestamp: number;     // Date.now()
}
```

### Internal state

```typescript
let _initialised = false;          // true after posthog.init() succeeds
let _recordingActive = false;      // debounce guard
let _stopTimer: ReturnType<typeof setTimeout> | null = null;
```

---

## Data Models

### Consent Store

| Key | Value | Meaning |
|-----|-------|---------|
| `"sessionReplayConsent"` | `"granted"` | User opted in |
| `"sessionReplayConsent"` | `"revoked"` | User explicitly opted out |
| `"sessionReplayConsent"` | absent / any other | Treated as not granted |

`isReplayEnabled()` reads this key fresh on every call (no in-memory cache) so mid-session revocation takes effect immediately.

### PostHog Init Config

```typescript
posthog.init(import.meta.env.VITE_POSTHOG_KEY, {
  api_host: "https://app.posthog.com",
  disable_session_recording: true,   // never auto-start
  capture_pageview: false,
  capture_pageleave: false,
  persistence: "localStorage",
  session_recording: {
    maskAllInputs: true,
    maskInputOptions: {
      password: true,
      text: true,
      number: true,
      range: true,
    },
    maskTextSelector: ".wallet-address-display",
  },
});
```

---

## HTML Changes

### Consent Dialog (added to `index.html`)

Reuses the existing `.disclaimer-overlay` / `.disclaimer-modal` pattern:

```html
<!-- Session Replay Consent Dialog -->
<div id="replay-consent-overlay" class="disclaimer-overlay hidden"
     role="dialog" aria-modal="true" aria-labelledby="replay-consent-title">
  <div class="disclaimer-modal">
    <div class="disclaimer-modal-icon">&#128247;</div>
    <h2 id="replay-consent-title">Session Replay — Opt In</h2>
    <div class="disclaimer-body">
      <p>When a transaction error occurs, Turbolong can record a short session replay
         (up to 60 seconds) to help diagnose the issue.</p>
      <p><strong>What is recorded:</strong> browser interactions during the error window.</p>
      <p><strong>What is masked:</strong> all input field values (amounts, leverage),
         wallet addresses, and any text marked as sensitive.</p>
      <p><strong>No automatic recording</strong> happens on normal page visits.</p>
      <p>You can turn this off at any time from Settings.</p>
    </div>
    <div class="disclaimer-actions">
      <button id="replay-consent-accept" class="btn btn-primary">Enable Session Replay</button>
      <button id="replay-consent-decline" class="btn btn-ghost">No thanks</button>
    </div>
  </div>
</div>
```

### Settings Dropdown Toggle (added to `index.html`)

Inserted after `#theme-toggle`, matching the existing button structure:

```html
<button id="replay-toggle" class="settings-dropdown-item"
        role="switch" aria-checked="false">
  Session Replay <span class="settings-badge">Off</span>
</button>
```

---

## Error Boundary Instrumentation

Every transaction flow catch block gets a single `notifyTxError` call. The `flowName` strings are:

| Function | `flowName` |
|----------|-----------|
| `openPosition` | `"openPosition"` |
| `closePosition` | `"closePosition"` |
| `repay` (standalone) | `"repay"` |
| `withdraw` | `"withdraw"` |
| `claim` | `"claim"` |
| `increaseLeverage` | `"increaseLeverage"` |
| `decreaseLeverage` | `"decreaseLeverage"` |
| `resupply` | `"resupply"` |
| `swapBlnd` | `"swapBlnd"` |
| vault deposit handler | `"vaultDeposit"` |
| vault withdraw handler | `"vaultWithdraw"` |
| vault rebalance handler | `"vaultRebalance"` |

Pattern:
```typescript
} catch (e: any) {
  notifyTxError("openPosition", e);   // ← add this line
  markStepperError(STEPS.length);
  toast(`Open failed: ${(e?.message ?? String(e)).slice(0, 150)}`, "error");
}
```

---

## PII Masking Strategy

### Input fields
`maskAllInputs: true` + `maskInputOptions` covers all `<input>` types including `type="range"` (leverage slider) and `type="number"` (amount inputs). PostHog replaces values with `*` characters in the rrweb DOM snapshot.

### Wallet addresses
The `#wallet-address` span in the nav already displays the truncated address. The `wallet-address-display` CSS class is added to this element in `index.html`. The `maskTextSelector: ".wallet-address-display"` config masks any element with this class in recordings.

For toast notifications that include wallet addresses: the `toast()` function in `main.ts` is not modified — wallet addresses are not passed to `toast()` in the current codebase (only truncated `fmtAddr()` output appears in toasts, and those are short enough that the full address is never present).

### Event properties
`notifyTxError` passes only `flowName`, truncated `errorMessage`, and `timestamp` to PostHog. The raw `userAddress` is never included in any PostHog call.

---

## Environment Variable

`VITE_POSTHOG_KEY` is read via `import.meta.env.VITE_POSTHOG_KEY`. Developers set this in a `.env.local` file (already gitignored by the existing `.gitignore`). The CI/CD pipeline sets it as a secret. If the variable is empty or undefined, `initSessionReplay()` logs a console warning and returns early — all exported functions become no-ops.

---

## Testing Strategy

No property-based tests are applicable — this feature is primarily DOM wiring, SDK configuration, and side-effectful browser API calls.

### Unit-testable logic (pure functions)

- `isReplayEnabled()` — pure read of localStorage; testable with a mock storage
- Error message truncation in `notifyTxError` — pure string operation
- Consent state transitions (granted → revoked → absent) — pure localStorage reads/writes

### Integration / smoke tests

- Verify PostHog is not initialised when `VITE_POSTHOG_KEY` is empty
- Verify `notifyTxError` does not throw when called before `initSessionReplay`
- Verify `isReplayEnabled()` returns `false` when localStorage is unavailable (mock `localStorage.getItem` to throw)
- Verify the replay toggle badge updates correctly on consent grant/revoke

### Manual verification checklist

- [ ] Open DevTools Network tab — confirm no PostHog requests on page load (recording disabled)
- [ ] Enable replay in settings — confirm consent dialog appears
- [ ] Decline consent — confirm badge stays "Off", no PostHog requests
- [ ] Accept consent — confirm badge shows "On"
- [ ] Trigger a tx error — confirm PostHog `startSessionRecording` is called
- [ ] Confirm input values are masked in PostHog dashboard recording
- [ ] Confirm wallet address is masked in PostHog dashboard recording
- [ ] Disable replay in settings — confirm badge shows "Off", no new recordings start
