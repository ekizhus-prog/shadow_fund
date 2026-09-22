export const DATA_LANES = Object.freeze([
  { key: 'tokenScreener', label: 'Token Screener', endpoint: '/api/v1/token-screener', purpose: 'Volume, liquidity, and supported-token universe' },
  { key: 'buyerActivity', label: 'Who Bought / Sold', endpoint: '/api/v1/tgm/who-bought-sold', purpose: 'Observed buyer counts and buy/sell activity' },
  { key: 'pnlSummary', label: 'Profiler PnL Summary', endpoint: '/api/v1/profiler/address/pnl-summary', purpose: 'Three-window realized PnL and consistency' },
  { key: 'currentBalance', label: 'Profiler Current Balance', endpoint: '/api/v1/profiler/address/current-balance', purpose: 'Complete balance denominator and token exposure' },
  { key: 'dexTrades', label: 'TGM DEX Trades', endpoint: '/api/v1/tgm/dex-trades', purpose: 'Executed buy/sell legs and trade direction' },
  { key: 'flowIntelligence', label: 'Flow Intelligence', endpoint: '/api/v1/tgm/flow-intelligence', purpose: 'Observed token flow context' },
  { key: 'relatedWallets', label: 'Related Wallets', endpoint: '/api/v1/profiler/address/related-wallets', purpose: 'Correlation review and conservative grouping caps' },
  { key: 'smartMoney', label: 'Smart Money Netflow', endpoint: '/api/v1/smart-money/netflow', purpose: 'Aggregated smart-money accumulation and distribution context' }
]);

export function syntheticLaneSet() {
  return DATA_LANES.map((lane) => ({
    ...lane,
    status: lane.key === 'smartMoney' ? 'NOT_USED' : 'SYNTHETIC_FIXTURE',
    note: lane.key === 'smartMoney' ? 'Not used by default because premium classification and redistribution rights are unresolved.' : 'Illustrative fixture value; not a live provider response.'
  }));
}
