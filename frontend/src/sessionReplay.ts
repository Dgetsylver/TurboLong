/**
 * sessionReplay.ts — Privacy-first, error-triggered session replay via PostHog.
 *
 * Recording only starts when:
 *   1. The user has explicitly opted in (sessionReplayConsent === "granted")
 *   2. A transaction flow catch block calls notifyTxError()
 *
 * All input values and wallet addresses are masked before any data leaves the browser.
 */

// posthog-js is a CommonJS/ESM package — import the default export.
// If the package is not installed, the build will fail with a clear error.
import posthog from "posthog-js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ReplayContext {
  /** Name of the transaction flow that errored, e.g. "openPosition" */
  flowName: string;
  /** Caught error message, truncated to 500 characters */
  errorMessage: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
}

// ── Internal state ────────────────────────────────────────────────────────────

const CONSENT_KEY = "sessionReplayConsent";
const CONSENT_GRANTED = "granted";
const CONSENT_REVOKED = "revoked";
const RECORDING_TIMEOUT_MS = 60_000;

let _initialised = false;
let _recordingActive = false;
let _stopTimer: ReturnType<typeof setTimeout> | null = null;

// ── Consent helpers ───────────────────────────────────────────────────────────

/**
 * Returns true iff the user has explicitly granted consent.
 * Reads localStorage fresh on every call — never caches — so mid-session
 * revocation takes effect immediately.
 * Never throws.
 */
export function isReplayEnabled(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === CONSENT_GRANTED;
  } catch {
    return false;
  }
}

function setConsent(granted: boolean): void {
  try {
    localStorage.setItem(CONSENT_KEY, granted ? CONSENT_GRANTED : CONSENT_REVOKED);
  } catch {
    // localStorage unavailable (private browsing, storage full) — silently ignore
  }
}

// ── PostHog initialisation ────────────────────────────────────────────────────

/**
 * Initialise the PostHog SDK with privacy-safe defaults.
 * Call once at app startup, before any transaction flow can execute.
 * No-op (with console warning) if VITE_POSTHOG_KEY is empty.
 */
export function initSessionReplay(): void {
  const apiKey = (import.meta.env.VITE_POSTHOG_KEY as string | undefined) ?? "";

  if (!apiKey) {
    console.warn(
      "[sessionReplay] VITE_POSTHOG_KEY is not set — session replay disabled. " +
      "Copy frontend/.env.example to frontend/.env.local and add your PostHog key."
    );
    _initialised = false;
    return;
  }

  posthog.init(apiKey, {
    api_host: "https://app.posthog.com",

    // Never auto-start recording — only start on explicit error trigger
    disable_session_recording: true,

    // No automatic page-level events
    capture_pageview: false,
    capture_pageleave: false,

    // Use localStorage so state survives reloads without cookies
    persistence: "localStorage",

    // Privacy: mask all inputs and wallet address display nodes
    session_recording: {
      maskAllInputs: true,
      maskInputOptions: {
        password: true,
        text: true,
        number: true,
        range: true,
      },
      // Mask any element with this class — applied to #wallet-address and similar nodes
      maskTextSelector: ".wallet-address-display",
    },
  } as Parameters<typeof posthog.init>[1]);

  _initialised = true;
}

// ── Recording ─────────────────────────────────────────────────────────────────

/**
 * Begin a PostHog session recording for the given error context.
 * Debounced: if a recording is already active, this call is ignored.
 * Automatically stops after RECORDING_TIMEOUT_MS (60 seconds).
 */
function startErrorReplay(context: ReplayContext): void {
  if (_recordingActive) return;

  _recordingActive = true;

  posthog.startSessionRecording();

  // Capture a named event so the recording is easy to find in PostHog
  posthog.capture("tx_error_replay_started", {
    flow_name: context.flowName,
    error_message: context.errorMessage,
    timestamp: context.timestamp,
  });

  // Auto-stop after 60 seconds
  if (_stopTimer !== null) clearTimeout(_stopTimer);
  _stopTimer = setTimeout(() => {
    posthog.stopSessionRecording();
    _recordingActive = false;
    _stopTimer = null;
  }, RECORDING_TIMEOUT_MS);
}

// ── Public error boundary hook ────────────────────────────────────────────────

/**
 * Call this from every transaction flow catch block.
 * Starts a recording only when the user has consented.
 * Never throws.
 *
 * @param flowName  One of the known tx flow names (e.g. "openPosition")
 * @param error     The caught error value
 */
export function notifyTxError(flowName: string, error: unknown): void {
  try {
    if (!_initialised) return;
    if (!isReplayEnabled()) return;

    const raw = error instanceof Error ? error.message : String(error);
    const errorMessage = raw.slice(0, 500);

    startErrorReplay({ flowName, errorMessage, timestamp: Date.now() });
  } catch {
    // Swallow all errors — this must never break the tx flow
  }
}

// ── Settings toggle wiring ────────────────────────────────────────────────────

/**
 * Wire the #replay-toggle button and consent dialog.
 * Call after the DOM is ready.
 */
export function setupReplayToggle(): void {
  const toggle = document.getElementById("replay-toggle") as HTMLButtonElement | null;
  if (!toggle) return;

  // Sync initial badge state
  syncToggleBadge(toggle);

  toggle.addEventListener("click", () => {
    if (isReplayEnabled()) {
      // Already consented — toggle off immediately, no dialog
      setConsent(false);
      syncToggleBadge(toggle);
    } else {
      // Not yet consented — show consent dialog
      showConsentDialog(toggle);
    }
  });

  // Wire consent dialog buttons
  const overlay = document.getElementById("replay-consent-overlay");
  const acceptBtn = document.getElementById("replay-consent-accept");
  const declineBtn = document.getElementById("replay-consent-decline");

  if (!overlay || !acceptBtn || !declineBtn) return;

  acceptBtn.addEventListener("click", () => {
    setConsent(true);
    hideConsentDialog();
    syncToggleBadge(toggle);
  });

  declineBtn.addEventListener("click", () => {
    hideConsentDialog();
    // Leave consent unchanged
  });

  // Dismiss on Escape key
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay && !overlay.classList.contains("hidden")) {
      hideConsentDialog();
    }
  });

  // Dismiss on click outside the modal
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hideConsentDialog();
  });
}

function syncToggleBadge(toggle: HTMLButtonElement): void {
  const enabled = isReplayEnabled();
  const badge = toggle.querySelector(".settings-badge");
  if (badge) badge.textContent = enabled ? "On" : "Off";
  toggle.setAttribute("aria-checked", enabled ? "true" : "false");
}

function showConsentDialog(toggle: HTMLButtonElement): void {
  const overlay = document.getElementById("replay-consent-overlay");
  if (overlay) {
    overlay.classList.remove("hidden");
    // Focus the accept button for keyboard accessibility
    const acceptBtn = document.getElementById("replay-consent-accept");
    if (acceptBtn) acceptBtn.focus();
  }
}

function hideConsentDialog(): void {
  const overlay = document.getElementById("replay-consent-overlay");
  if (overlay) overlay.classList.add("hidden");
}
