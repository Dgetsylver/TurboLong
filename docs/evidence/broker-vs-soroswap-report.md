# Broker-vs-Soroswap routing report (mainnet)

Generated 2026-07-16T11:47:51.932Z from https://turbolong-alerts.turbolong.workers.dev/swap-routes

## Summary

| Metric | Value |
|---|---|
| Dataset rows | 2 |
| Harvests with both quotes logged | 1 / 50 |
| Broker quote win rate | 100.0% (1/1) |
| Executed swaps | 0 (broker 0, soroswap 0) |
| Fallback triggers | 1 |
| Average uplift (chosen vs alternative) | 13 bps |
| Average realized slippage | — |
| On-chain verification | 1/1 tx confirmed |

## Decisions

| id | ts | asset | in (BLND) | broker quote | soroswap quote | chosen | reason | status | out | tx |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 2026-07-16 09:18:33 | USDC | 100 | 3.8841107 | 3.878743 | broker | best | quote_only | — | — |
| 2 | 2026-07-16 09:42:41 | USDC | 1.3751024 | — | 0.0533448 | soroswap | fallback_unavailable | executed | 0 | [2e065e0b…](https://stellar.expert/explorer/public/tx/2e065e0ba389c257c27da459336457b6511c688fb2583d3fdca928dd5bdc1a29) |
