import { describe, it, expect, vi } from 'vitest';
import { Account, Transaction } from '@stellar/stellar-sdk';

// Mock @stellar/stellar-sdk
vi.mock('@stellar/stellar-sdk', async (importActual) => {
  const actual = await importActual<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: (tx: any, sim: any) => ({
        build: () => tx
      }),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: () => true
      }
    }
  };
});

import { buildBulkCloseXdr, buildBulkAdjustXdr, server } from '../src/blend';

// Mock server methods
vi.spyOn(server, 'getAccount').mockImplementation(async (address: string) => {
  return new Account(address, '0');
});

vi.spyOn(server, 'simulateTransaction').mockImplementation(async (tx: Transaction) => {
  return {
    error: null,
    results: [],
    transactionData: null,
    minResourceFee: '100',
    events: [],
    restorePreamble: null,
  } as any;
});

const mockPool = {
  id: "CDMAVJPFXPADND3YRL4BSM3AKZWCTFMX27GLLXCML3PD62HEQS5FPVAI",
  name: "Etherfuse",
  oracleId: "CAVRP26CWW6IUEXBRA3Q2T2SHBUVBC2DF43M4E23LEZGW5ZEIB62HALS",
  oracleDec: 1e14,
  backstopFP: 2000000,
  status: 1,
  assetIds: ["CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"]
};

const mockAssetXLM = {
  id: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
  symbol: "XLM",
  name: "Stellar Lumens",
  decimals: 7,
  reserveIndex: 0,
  supplyTokenId: 1,
  borrowTokenId: 0,
  cFactor: 0.75,
  maxUtil: 0.70
};

const mockAssetUSDC = {
  id: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
  symbol: "USDC",
  name: "USD Coin",
  decimals: 7,
  reserveIndex: 1,
  supplyTokenId: 3,
  borrowTokenId: 2,
  cFactor: 0.95,
  maxUtil: 0.95
};

describe('Bulk transaction building unit tests', () => {
  const userAddress = 'GDJEHTBE6ZHUXSWFI642DCGLUOECLHPF3KSXHPXTSTJ7E3JF6MQ5EZYY';

  it('buildBulkCloseXdr should successfully construct XDR for multiple positions in a pool', async () => {
    const positions = [
      {
        asset: mockAssetXLM,
        bTokens: 1000n,
        dTokens: 500n,
        bRate: 1n,
        dRate: 1n,
        collateral: 10,
        debt: 5,
        equity: 5,
        leverage: 2,
        hf: 1.5
      },
      {
        asset: mockAssetUSDC,
        bTokens: 2000n,
        dTokens: 0n,
        bRate: 1n,
        dRate: 1n,
        collateral: 20,
        debt: 0,
        equity: 20,
        leverage: 1,
        hf: 999
      }
    ];

    const xdrResult = await buildBulkCloseXdr([{ pool: mockPool, positions }], userAddress);
    expect(xdrResult).toBeDefined();
    
    // Deserialize and check transaction structure
    const tx = new Transaction(xdrResult, 'Test SDF Network ; September 2015');
    expect(tx.operations.length).toBe(1); // One pooled contract call operation
    expect(tx.operations[0].type).toBe('invokeHostFunction');
  });

  it('buildBulkAdjustXdr should build borrow/supply requests when leverage increases', async () => {
    const adjustments = [
      {
        asset: mockAssetXLM,
        pos: {
          asset: mockAssetXLM,
          bTokens: 1000n,
          dTokens: 500n,
          bRate: 1n,
          dRate: 1n,
          collateral: 10,
          debt: 5,
          equity: 5,
          leverage: 2,
          hf: 1.5
        },
        targetLev: 3 // Leverage increase
      }
    ];

    const xdrResult = await buildBulkAdjustXdr([{ pool: mockPool, adjustments }], userAddress);
    expect(xdrResult).toBeDefined();

    const tx = new Transaction(xdrResult, 'Test SDF Network ; September 2015');
    expect(tx.operations.length).toBe(1);
  });

  it('buildBulkAdjustXdr should build withdraw/repay requests when leverage decreases', async () => {
    const adjustments = [
      {
        asset: mockAssetXLM,
        pos: {
          asset: mockAssetXLM,
          bTokens: 1500n,
          dTokens: 1000n,
          bRate: 1n,
          dRate: 1n,
          collateral: 15,
          debt: 10,
          equity: 5,
          leverage: 3,
          hf: 1.2
        },
        targetLev: 2 // Leverage decrease
      }
    ];

    const xdrResult = await buildBulkAdjustXdr([{ pool: mockPool, adjustments }], userAddress);
    expect(xdrResult).toBeDefined();

    const tx = new Transaction(xdrResult, 'Test SDF Network ; September 2015');
    expect(tx.operations.length).toBe(1);
  });
});
