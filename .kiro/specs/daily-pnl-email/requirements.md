# Requirements Document

## Introduction

The Daily P&L Summary Email feature delivers a morning digest to opted-in users showing the current state of their monitored positions on the Blend protocol. Each email contains a compact table with every open position the user tracks: the asset, pool, leverage bracket, current Health Factor (HF), and the net yield accrued over the last 24 hours. Users choose the UTC hour at which they want to receive the digest. The feature extends the existing Turbolong Alerts Cloudflare Worker, reusing the Resend email delivery, the Soroban RPC helpers in `stellar.ts`, and the D1 SQLite database.

## Glossary

- **Digest_Scheduler**: The cron-triggered component that identifies which subscribers are due for a daily digest at the current UTC hour and dispatches emails.
- **Digest_Email**: The HTML email containing the P&L summary table sent to a subscriber.
- **Position**: A single (pool, asset, leverage bracket) combination that a subscriber monitors.
- **HF (Health Factor)**: The ratio of a position's collateral value to its borrow value; a value below 1 indicates liquidation risk. Computed from Blend pool reserve data.
- **24h Yield**: The net yield (in percentage points of APY) accrued by a position over the last 24 hours, derived from the current net APY divided by 365.
- **Digest_Hour**: The UTC hour (0–23) at which a subscriber wants to receive their daily digest.
- **Subscription**: A row in the `subscriptions` table representing a user's opt-in for a specific position alert.
- **PnL_Subscription**: An extension of a Subscription that also carries `digest_enabled` and `digest_hour` fields.
- **Worker**: The Cloudflare Worker defined in `alerts/src/index.ts`.
- **Resend**: The third-party email delivery service accessed via `email.ts`.
- **Blend_Pool**: A Blend protocol lending pool on Stellar mainnet, identified by a contract ID.

---

## Requirements

### Requirement 1: Opt-in via Subscription

**User Story:** As a user, I want to opt in to the daily P&L digest when subscribing, so that I receive a morning summary of my positions without having to set up a separate alert.

#### Acceptance Criteria

1. WHEN a POST request is made to `/subscribe` with a valid `digest_hour` field (integer 0–23), THE Worker SHALL store `digest_enabled = 1` and the provided `digest_hour` value on the subscription row.
2. WHEN a POST request is made to `/subscribe` without a `digest_hour` field, THE Worker SHALL create the subscription with `digest_enabled = 0` and `digest_hour = NULL`, leaving the existing APY alert behaviour unchanged.
3. IF the `digest_hour` field is present but is not an integer in the range 0–23, THEN THE Worker SHALL reject the entire request with HTTP 400, return an error message describing the valid range, and create no subscription row.
4. THE Worker SHALL accept `digest_hour` on both new subscriptions and re-subscriptions (upsert), updating the stored value each time.
5. WHEN a subscription is verified via `/verify`, THE Worker SHALL preserve the `digest_enabled` and `digest_hour` values set at subscription time.

---

### Requirement 2: Schema Extension

**User Story:** As a developer, I want the database schema to store digest preferences per subscription, so that the scheduler can query which users are due for a digest at any given hour.

#### Acceptance Criteria

1. THE `subscriptions` table SHALL include a `digest_enabled` column of type `INTEGER` with a default value of `0`.
2. THE `subscriptions` table SHALL include a `digest_hour` column of type `INTEGER` with a default value of `NULL`.
3. THE `subscriptions` table SHALL include a `last_digest_at` column of type `TEXT` with a default value of `NULL`, storing the ISO-8601 datetime of the most recent digest sent.
4. WHEN a migration is applied to an existing database, THE schema change SHALL be backward-compatible and SHALL NOT drop or alter existing columns.

---

### Requirement 3: Position Data Fetching

**User Story:** As a developer, I want the Worker to fetch current HF and 24h yield for each monitored position, so that the digest email contains accurate, up-to-date data.

#### Acceptance Criteria

1. WHEN computing the digest for a position, THE Worker SHALL call `fetchReserveRates()` from `stellar.ts` to obtain current supply APR, borrow cost, and BLND emissions for the relevant pool and asset.
2. WHEN computing the digest for a position, THE Worker SHALL derive the current net APY using `computeNetApy()` from `stellar.ts` with the subscription's `leverage_bracket`, accepting zero or negative values for both leverage bracket and net APY as valid results.
3. WHEN computing the digest for a position, THE Worker SHALL compute the 24h yield as `netApy / 365` (percentage points per day).
4. WHEN computing the digest for a position, THE Worker SHALL compute the Health Factor as `(totalSupply * priceUsd) / (totalBorrow * priceUsd)` using data returned by `fetchReserveRates()`, where a value of `Infinity` is displayed as `∞` when total borrow is zero.
5. IF `fetchReserveRates()` returns `null` for a position, THEN THE Worker SHALL include that position in the digest table with `N/A` values rather than omitting the row entirely.

---

### Requirement 4: Digest Email Template

**User Story:** As a subscriber, I want to receive a well-formatted morning email showing all my monitored positions, so that I can quickly assess my portfolio health at a glance.

#### Acceptance Criteria

1. THE Digest_Email SHALL contain a single HTML table with one row per position the subscriber monitors.
2. WHEN rendering the table, THE Digest_Email SHALL include the following columns for each position: Pool, Asset, Leverage, Health Factor, 24h Yield (%). IF the table rendering fails, THE Digest_Email SHALL still be sent with a fallback message in place of the table.
3. WHEN the Health Factor is below 1.2, THE Digest_Email SHALL render that cell in a warning colour (red or orange) to draw attention to liquidation risk.
4. WHEN the 24h Yield is negative, THE Digest_Email SHALL render that cell in red to indicate a loss.
5. THE Digest_Email SHALL include an unsubscribe link using the subscription's existing `unsub_token`.
6. THE Digest_Email SHALL include a link to the Turbolong app using the `FRONTEND_ORIGIN` environment variable.
7. THE Digest_Email SHALL be sent via the existing `sendEmail` helper in `email.ts` using the `RESEND_API_KEY` and `RESEND_FROM` environment variables.
8. THE Digest_Email subject line SHALL follow the pattern: `TurboLong Morning Digest — <date in YYYY-MM-DD format>`.

---

### Requirement 5: Digest Scheduling

**User Story:** As a subscriber, I want my digest to arrive at the UTC hour I chose, so that it fits my morning routine regardless of my timezone.

#### Acceptance Criteria

1. WHEN the cron trigger fires, THE Digest_Scheduler SHALL query the database for all verified subscriptions where `digest_enabled = 1` and `digest_hour` equals the current UTC hour.
2. WHEN multiple positions belong to the same subscriber email, THE Digest_Scheduler SHALL group them into a single Digest_Email rather than sending one email per position.
3. WHEN a Digest_Email is sent successfully, THE Digest_Scheduler SHALL update `last_digest_at` to the current UTC datetime for all subscription rows belonging to that email.
4. WHEN a Digest_Email has already been sent to a subscriber within the last 23 hours, THE Digest_Scheduler SHALL NOT send another digest to that subscriber during the current cron run, preventing duplicate sends if the cron fires multiple times within the same hour. THE Digest_Scheduler SHALL NOT update `last_digest_at` when a send is skipped due to this duplicate prevention check.
5. THE Digest_Scheduler SHALL run within the existing `scheduled()` handler in `index.ts` alongside the existing APY alert logic, without replacing it.
6. WHEN the Digest_Scheduler encounters a send failure for a subscriber, THE Digest_Scheduler SHALL log the error, leave `last_digest_at` unchanged for that subscriber, and continue processing remaining subscribers. THE Digest_Scheduler SHALL update `last_digest_at` only for subscribers whose emails were sent successfully.

---

### Requirement 6: Cron Schedule Extension

**User Story:** As a developer, I want the cron to fire every hour so that digests can be delivered at any user-chosen UTC hour, while the existing 15-minute APY check continues to run.

#### Acceptance Criteria

1. THE `wrangler.toml` SHALL declare a second cron trigger `"0 * * * *"` (top of every hour) in addition to the existing `"*/15 * * * *"` trigger.
2. WHEN the hourly cron fires, THE Worker SHALL execute the Digest_Scheduler logic.
3. WHEN the 15-minute cron fires, THE Worker SHALL execute only the existing APY alert logic and SHALL NOT run the Digest_Scheduler.
4. THE Worker SHALL use the `event.cron` field value of the `ScheduledEvent` to determine which logic path to execute: `"*/15 * * * *"` routes to the APY alert handler and `"0 * * * *"` routes to the Digest_Scheduler.
