import assert from 'node:assert/strict';
import test from 'node:test';
import { NansenObservationAdapter } from '../server/nansen/adapter.js';

test('live adapter analyzes the selected token universe and uses the Nansen evidence lanes', async () => {
  const calls = [];
  const client = { post: async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint.includes('token-screener')) return { data: [
      { chain: 'ethereum', token_address: '0xeth-token', symbol: 'WETH', price_usd: 100, liquidity_usd: 1_000_000, volume_usd: 2_000_000, volume_rank: 1 },
      { chain: 'base', token_address: '0xbase-token', symbol: 'AERO', price_usd: 2, liquidity_usd: 900_000, volume_usd: 1_500_000, volume_rank: 2 }
    ] };
    if (endpoint.includes('who-bought-sold')) return { data: [{ wallet_address: '0xwallet' }] };
    if (endpoint.includes('flow-intelligence')) return { data: [{ net_flow_usd: 1234 }] };
    if (endpoint.includes('current-balance')) return { data: [{ symbol: 'WETH', value_usd: 1000 }] };
    if (endpoint.includes('pnl-summary')) return { data: [{ realized_pnl_percent: 0.1, realized_pnl_usd: 100, traded_times: 5, traded_token_count: 6 }] };
    return { data: [] };
  } };
  const bundle = await new NansenObservationAdapter(client).collect({ chains: ['ethereum', 'base'], cutoff: '2026-09-20T00:00:00.000Z' });
  assert.equal(bundle.synthetic, false);
  assert.deepEqual(bundle.chains, ['ethereum', 'base']);
  assert.deepEqual(calls.find((call) => call.endpoint.includes('token-screener')).body.chains, ['ethereum', 'base']);
  assert.deepEqual(calls.find((call) => call.endpoint.includes('token-screener')).body.order_by, [{ field: 'market_cap_usd', direction: 'DESC' }]);
  assert.deepEqual(Object.keys(bundle.tokenLanes), ['ethereum:0xeth-token', 'base:0xbase-token']);
  assert.equal(bundle.dataLanes.length, 8);
  assert.equal(bundle.dataLanes.find((lane) => lane.key === 'smartMoney').status, 'LIVE');
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('token-screener')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('who-bought-sold')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('pnl-summary')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('current-balance')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('dex-trades')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('flow-intelligence')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('related-wallets')));
  assert.ok(calls.some(({ endpoint }) => endpoint.includes('smart-money/netflow')));
});

test('live adapter analyzes every token in a selected market-cap band before policy targeting', async () => {
  const calls = [];
  const screenerRows = Array.from({ length: 100 }, (_, index) => ({
    chain: 'ethereum', token_address: `0xtoken-${index + 1}`, symbol: `T${index + 1}`,
    price_usd: 10, market_cap_usd: 100_000_000 - index * 100_000, liquidity_usd: 1_000_000, volume_usd: 2_000_000
  }));
  const client = { post: async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint.includes('token-screener')) return { data: screenerRows };
    if (endpoint.includes('who-bought-sold')) return { data: [] };
    if (endpoint.includes('flow-intelligence')) return { data: [] };
    if (endpoint.includes('current-balance')) return { data: [] };
    if (endpoint.includes('pnl-summary')) return { data: [] };
    return { data: [] };
  } };
  const bundle = await new NansenObservationAdapter(client).collect({ chains: ['ethereum'], assetUniverse: 'rank51_100', cutoff: '2026-09-20T00:00:00.000Z' });
  assert.equal(bundle.assetUniverse, 'rank51_100');
  assert.equal(bundle.rawCoverage.universeSize, 50);
  assert.equal(bundle.rawCoverage.screenedTokens, 50);
  assert.equal(bundle.rawCoverage.analyzedTokens, 50);
  assert.ok(bundle.rawCoverage.flowAnalyzedTokens > 0);
  assert.ok(bundle.rawCoverage.flowAnalyzedTokens <= 50);
  assert.ok(bundle.rawCoverage.deepAnalyzedTokens > 0);
  assert.ok(bundle.rawCoverage.deepAnalyzedTokens <= bundle.rawCoverage.flowAnalyzedTokens);
  assert.ok(bundle.rawCoverage.estimatedCredits <= bundle.rawCoverage.runCreditLimit);
  assert.equal(Object.keys(bundle.quotes).length, 50);
  assert.ok(Object.values(bundle.quotes).every((quote) => quote.marketCapRank >= 51 && quote.marketCapRank <= 100));
  assert.ok(new Set(Object.values(bundle.quotes).map((quote) => quote.marketCapRank)).size >= 5);
  assert.equal(calls.find((call) => call.endpoint.includes('token-screener')).body.pagination.per_page, 1000);
});

test('full-range credit plan keeps deep token and wallet profiler lanes alive', async () => {
  const calls = [];
  const screenerRows = Array.from({ length: 250 }, (_, index) => ({
    chain: index % 2 ? 'ethereum' : 'base', token_address: `0xfull-${index + 1}`, symbol: `FULL${index + 1}`,
    price_usd: 10, market_cap_usd: 250_000_000 - index * 100_000, liquidity_usd: 1_000_000, volume_usd: 2_000_000
  }));
  const client = { post: async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint.includes('token-screener')) return { data: screenerRows };
    if (endpoint.includes('who-bought-sold')) return { data: [{ wallet_address: '0xdeep-wallet' }] };
    if (endpoint.includes('flow-intelligence')) return { data: [{ net_flow_usd: 1234 }] };
    if (endpoint.includes('dex-trades')) return { data: [{ transaction_hash: '0xtrade' }] };
    if (endpoint.includes('current-balance')) return { data: [{ token_address: '0xfull-1', symbol: 'FULL1', value_usd: 1000 }] };
    if (endpoint.includes('related-wallets')) return { data: [{ address: '0xrelated' }] };
    if (endpoint.includes('pnl-summary')) return { data: [{ realized_pnl_percent: 0.1, realized_pnl_usd: 100, traded_times: 5, traded_token_count: 6 }], pagination: { complete: true } };
    if (endpoint.includes('smart-money/netflow')) return { data: [{ token_address: '0xfull-1', net_flow_24h_usd: 5000 }] };
    return { data: [] };
  } };
  const bundle = await new NansenObservationAdapter(client).collect({ chains: ['ethereum', 'base'], assetUniverse: '1:250', cutoff: '2026-09-20T00:00:00.000Z' });
  assert.equal(bundle.rawCoverage.analyzedTokens, 250);
  assert.ok(bundle.rawCoverage.flowAnalyzedTokens > 0);
  assert.ok(bundle.rawCoverage.deepAnalyzedTokens >= 2);
  assert.equal(bundle.rawCoverage.discoveredWallets, 2);
  for (const key of ['buyerActivity', 'dexTrades', 'pnlSummary', 'currentBalance', 'relatedWallets']) {
    assert.equal(bundle.dataLanes.find((lane) => lane.key === key).status, 'LIVE', key);
  }
  for (const endpoint of ['who-bought-sold', 'dex-trades', 'current-balance', 'related-wallets', 'pnl-summary']) {
    assert.ok(calls.some((call) => call.endpoint.includes(endpoint)), endpoint);
  }
  assert.ok(bundle.rawCoverage.estimatedCredits <= bundle.rawCoverage.runCreditLimit);
});

test('twenty-token demo range runs every token lane across a non-top rank band', async () => {
  const calls = [];
  const screenerRows = Array.from({ length: 64 }, (_, index) => ({
    chain: 'ethereum', token_address: `0xdemo-${index + 1}`, symbol: `DEMO${index + 1}`,
    price_usd: 10, market_cap_usd: 64_000_000 - index * 100_000, liquidity_usd: 1_000_000, volume_usd: 2_000_000
  }));
  const client = { post: async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint.includes('token-screener')) return { data: screenerRows };
    if (endpoint.includes('who-bought-sold')) return { data: [{ address: '0xdemo-wallet' }] };
    if (endpoint.includes('flow-intelligence')) return { data: [{ net_flow_usd: 1234 }] };
    if (endpoint.includes('dex-trades')) return { data: [{ transaction_hash: '0xdemo-trade' }] };
    if (endpoint.includes('current-balance')) return { data: [{ token_address: '0xdemo-45', symbol: 'DEMO45', value_usd: 1000 }] };
    if (endpoint.includes('related-wallets')) return { data: [{ address: '0xdemo-related' }] };
    if (endpoint.includes('pnl-summary')) return { data: [{ realized_pnl_percent: 0.1, realized_pnl_usd: 100, traded_times: 5, traded_token_count: 6 }], pagination: { complete: true } };
    if (endpoint.includes('smart-money/netflow')) return { data: [{ token_address: '0xdemo-45', net_flow_24h_usd: 5000 }] };
    return { data: [] };
  } };
  const bundle = await new NansenObservationAdapter(client).collect({ chains: ['ethereum'], assetUniverse: '45:64', cutoff: '2026-09-20T00:00:00.000Z' });
  assert.equal(bundle.rawCoverage.screenedTokens, 20);
  assert.equal(bundle.rawCoverage.flowAnalyzedTokens, 20);
  assert.equal(bundle.rawCoverage.deepAnalyzedTokens, 20);
  assert.equal(calls.filter(({ endpoint }) => endpoint.includes('flow-intelligence')).length, 20);
  assert.equal(calls.filter(({ endpoint }) => endpoint.includes('who-bought-sold')).length, 20);
  assert.equal(calls.filter(({ endpoint }) => endpoint.includes('dex-trades')).length, 20);
  for (const key of ['buyerActivity', 'dexTrades', 'pnlSummary', 'currentBalance', 'relatedWallets']) {
    assert.equal(bundle.dataLanes.find((lane) => lane.key === key).status, 'LIVE', key);
  }
});
