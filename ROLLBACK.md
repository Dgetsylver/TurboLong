# TurboLong Vault Rollback & Emergency Guide

## Emergency Pause

The strategy contract does not currently expose a direct `pause()` administrative method. To safely pause or hide the vault from users on mainnet, we disable frontend interactions by un-wiring the contract address.

**To trigger an emergency pause:**
1. Open `frontend/src/defindex.ts`.
2. Locate the `MAINNET_VAULTS` array (around line 49).
3. Revert `vaultId: "C..."` back to an empty string `vaultId: ""`.
4. Commit the change and push to redeploy the frontend.

Once the frontend is rebuilt, the vault will revert to the "Not deployed" state. Users will be unable to deposit, withdraw, or see the active statistics from the UI. *Note: Advanced users could still invoke contract methods directly via `stellar contract invoke`.*

## Deleveraging and Monitoring

To safeguard users against significant liquidation risks caused by Health Factor (HF) drops:
You can run the auto-deleverage script.

```bash
cd scripts/
MAINNET_SECRET=S... npx tsx mainnet_loop.ts --monitor --hf-threshold 1.05
```

This will run an automated HF monitor loop. If HF falls below `1.05`, it will proactively deleverage 25% of the debt to pull the health factor back up to a safer level without completely liquidating the user's position.

## Manual Deleverage (Emergency Action)
In the event that you need to manually intervene to save a position:
1. Obtain the strategy's ID and the user's account ID.
2. Ensure you have the `KEEPER` secret key.
3. Call `rebalance` directly on the DeFindex vault contract.

```bash
stellar contract invoke \
  --id <VAULT_CONTRACT_ID> \
  --network mainnet \
  --source <KEEPER_SECRET> \
  -- rebalance
```
