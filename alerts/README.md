# Turbolong Alerts Worker

The alerts Worker records APY snapshots on each scheduled cron run and exposes a read-only public endpoint for charting historical rates.

## Rate Snapshots

Cron writes one `rate_snapshots` row per pool asset every 15 minutes after fetching reserve rates. Rows include pool and asset identifiers, net supply and borrow rates, raw interest and BLND components, utilization, combined BLND emissions per second, and `captured_at`.

Snapshots are retained for 365 days. Each cron run prunes rows older than that window.

## Public Endpoint

`GET /rate-snapshots`

Query parameters:

- `window`: lookback window, such as `7d`, `30d`, `12w`, or `1y`; defaults to `7d` and is capped at 365 days.
- `pool_id`: optional Blend pool contract ID filter.
- `asset_symbol`: optional symbol filter, for example `USDC`.
- `asset_id`: optional asset contract ID filter.
- `limit`: optional row limit; defaults to 500 and is capped at 5000.

Example:

```text
GET /rate-snapshots?asset_symbol=USDC&window=30d&limit=1000
```

Response:

```json
{
  "ok": true,
  "window_days": 30,
  "limit": 1000,
  "filters": {
    "pool_id": null,
    "asset_symbol": "USDC",
    "asset_id": null
  },
  "snapshots": []
}
```
