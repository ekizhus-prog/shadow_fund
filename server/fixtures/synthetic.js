import { hash } from '../db/index.js';
import { syntheticLaneSet } from '../nansen/lanes.js';

const tokens = {
  WETH: { symbol: 'WETH', name: 'Wrapped Ether', priceCents: 351_200, liquidityUsd: 18_000_000 },
  AERO: { symbol: 'AERO', name: 'Aerodrome', priceCents: 120, liquidityUsd: 3_200_000 },
  DEGEN: { symbol: 'DEGEN', name: 'Degen', priceCents: 6, liquidityUsd: 1_100_000 },
  TOSHI: { symbol: 'TOSHI', name: 'Toshi', priceCents: 4, liquidityUsd: 680_000 },
  cbBTC: { symbol: 'cbBTC', name: 'Coinbase Wrapped BTC', priceCents: 6_543_210, liquidityUsd: 22_000_000 }
};

const tokenLanes = {
  WETH: {
    tokenScreener: { volume24hUsd: 42_000_000, volumeRank: 1, liquidityUsd: 18_000_000 },
    buyerActivity: { observedBuyerCount: 182, observedBuyUsd: 2_800_000, window: '24h' },
    flowIntelligence: { netFlowUsd: 1_240_000, direction: 'inflow', timeframe: '24h' }
  },
  AERO: {
    tokenScreener: { volume24hUsd: 8_400_000, volumeRank: 4, liquidityUsd: 3_200_000 },
    buyerActivity: { observedBuyerCount: 96, observedBuyUsd: 1_120_000, window: '24h' },
    flowIntelligence: { netFlowUsd: 310_000, direction: 'inflow', timeframe: '24h' }
  },
  DEGEN: {
    tokenScreener: { volume24hUsd: 3_100_000, volumeRank: 8, liquidityUsd: 1_100_000 },
    buyerActivity: { observedBuyerCount: 74, observedBuyUsd: 460_000, window: '24h' },
    flowIntelligence: { netFlowUsd: 84_000, direction: 'inflow', timeframe: '24h' }
  },
  TOSHI: {
    tokenScreener: { volume24hUsd: 1_700_000, volumeRank: 13, liquidityUsd: 680_000 },
    buyerActivity: { observedBuyerCount: 41, observedBuyUsd: 220_000, window: '24h' },
    flowIntelligence: { netFlowUsd: -18_000, direction: 'outflow', timeframe: '24h' }
  },
  cbBTC: {
    tokenScreener: { volume24hUsd: 51_000_000, volumeRank: 2, liquidityUsd: 22_000_000 },
    buyerActivity: { observedBuyerCount: 143, observedBuyUsd: 4_400_000, window: '24h' },
    flowIntelligence: { netFlowUsd: 790_000, direction: 'inflow', timeframe: '24h' }
  }
};

const baseSources = [
  {
    id: '0x71a4...9c20',
    label: 'Source 01',
    sales: 34,
    tradedTokenCount: 11,
    aggregateRealizedPnlUsd: 18_420,
    balanceComplete: true,
    exposures: { WETH: 0.38, AERO: 0.20, DEGEN: 0.12, TOSHI: 0.07, cbBTC: 0.15 },
    windows: [{ realizedRoi: 0.08, tradedTokenCount: 9, valid: true }, { realizedRoi: 0.12, tradedTokenCount: 12, valid: true }, { realizedRoi: 0.04, tradedTokenCount: 10, valid: true }]
  },
  {
    id: '0x28f0...c113',
    label: 'Source 02',
    sales: 29,
    tradedTokenCount: 9,
    aggregateRealizedPnlUsd: 13_060,
    balanceComplete: true,
    exposures: { WETH: 0.25, AERO: 0.30, DEGEN: 0.10, TOSHI: 0.11, cbBTC: 0.08 },
    windows: [{ realizedRoi: 0.05, tradedTokenCount: 8, valid: true }, { realizedRoi: 0.09, tradedTokenCount: 9, valid: true }, { realizedRoi: 0.02, tradedTokenCount: 7, valid: true }]
  },
  {
    id: '0x9b1d...4f81',
    label: 'Source 03',
    sales: 24,
    tradedTokenCount: 8,
    aggregateRealizedPnlUsd: 8_870,
    balanceComplete: true,
    exposures: { WETH: 0.20, AERO: 0.19, DEGEN: 0.24, TOSHI: 0.13, cbBTC: 0.06 },
    windows: [{ realizedRoi: 0.03, tradedTokenCount: 7, valid: true }, { realizedRoi: 0.06, tradedTokenCount: 8, valid: true }, { realizedRoi: 0.01, tradedTokenCount: 8, valid: true }]
  },
  {
    id: '0x4c77...a09e',
    label: 'Source 04',
    sales: 21,
    tradedTokenCount: 7,
    aggregateRealizedPnlUsd: 4_230,
    balanceComplete: true,
    exposures: { WETH: 0.16, AERO: 0.18, DEGEN: 0.11, TOSHI: 0.25, cbBTC: 0.04 },
    windows: [{ realizedRoi: 0.01, tradedTokenCount: 6, valid: true }, { realizedRoi: 0.04, tradedTokenCount: 7, valid: true }, { realizedRoi: 0.02, tradedTokenCount: 6, valid: true }]
  },
  {
    id: '0xdead...beef',
    label: 'Rejected example',
    sales: 4,
    tradedTokenCount: 2,
    aggregateRealizedPnlUsd: -140,
    balanceComplete: false,
    exposures: { WETH: 0.8 },
    windows: [{ realizedRoi: -0.03, tradedTokenCount: 2, valid: true }, { realizedRoi: null, tradedTokenCount: 0, valid: false }, { realizedRoi: 0.01, tradedTokenCount: 3, valid: true }]
  }
];

export function getSyntheticBundle(cycle = 1) {
  const sources = baseSources.map((source) => ({ ...source, windows: source.windows.map((window) => ({ ...window })) }))
    .map((source, index) => {
      if (cycle < 2) return source;
      if (index === 0) return { ...source, exposures: { ...source.exposures, AERO: 0.34, WETH: 0.22, DEGEN: 0.18 } };
      if (index === 1) return { ...source, exposures: { ...source.exposures, cbBTC: 0.18, TOSHI: 0.04 } };
      return source;
    });
  const quotes = Object.fromEntries(Object.entries(tokens).map(([token, quote]) => [token, {
    ...quote,
    ageSeconds: 42,
    observedAt: new Date().toISOString(),
    source: 'synthetic-fixture'
  }]));
  const eventCutoff = new Date(Date.now() - (cycle === 1 ? 60_000 : 30_000)).toISOString();
  const bundle = {
    chain: 'base',
    cycle,
    eventCutoff,
    collection: cycle === 1 ? 'initial bounded watchlist fixture' : 'changed exposure fixture',
    sources,
    quotes,
    tokenLanes,
    dataLanes: syntheticLaneSet(),
    synthetic: true
  };
  return { ...bundle, sourceHash: hash(bundle) };
}
