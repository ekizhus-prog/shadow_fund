import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTargetAllocation, eligibility, isCashLikeToken, PRESETS, proposeRebalance, scoreAndSelect } from '../server/domain/policy.js';
import { getSyntheticBundle } from '../server/fixtures/synthetic.js';
import { getAssetUniverse } from '../server/domain/universe.js';

test('synthetic cohort selects eligible sources and rejects incomplete evidence', () => {
  const bundle = getSyntheticBundle(1);
  const result = scoreAndSelect(bundle.sources);
  assert.equal(result.eligibleCount, 4);
  assert.equal(result.rejected.length, 1);
  assert.ok(result.selected.every((source) => source.influence <= 0.15));
  assert.ok(result.selected.reduce((sum, source) => sum + source.influence, 0) <= 0.6);
});

test('allocation keeps the documented cash floor and token cap', () => {
  const bundle = getSyntheticBundle(1);
  const allocation = buildTargetAllocation(bundle, 'Balanced');
  assert.equal(allocation.totalWeight, 1);
  assert.ok(allocation.cashWeight >= 0.25);
  assert.ok(allocation.targets.every((target) => target.targetWeight <= 0.35));
  assert.ok(allocation.targets.length <= 5);
});

test('cash-like stablecoins are excluded and the risk sleeve is normalized', () => {
  const bundle = {
    sources: [{
      id: 'wallet-1', label: 'Wallet 1', sales: 20, tradedTokenCount: 4, aggregateRealizedPnlUsd: 100,
      balanceComplete: true, exposures: { WETH: 0.7, USDC: 0.3 },
      windows: [{ valid: true, realizedRoi: 0.1, tradedTokenCount: 4 }, { valid: true, realizedRoi: 0.1, tradedTokenCount: 4 }, { valid: true, realizedRoi: 0.1, tradedTokenCount: 4 }]
    }],
    quotes: {
      WETH: { priceCents: 100, ageSeconds: 0, liquidityUsd: 500_000 },
      USDC: { priceCents: 100, ageSeconds: 0, liquidityUsd: 500_000 }
    },
    dataLanes: []
  };
  const allocation = buildTargetAllocation(bundle, 'Balanced');
  assert.equal(isCashLikeToken('USDC'), true);
  assert.equal(isCashLikeToken('EURC'), true);
  assert.equal(isCashLikeToken('GHO'), true);
  assert.deepEqual(allocation.targets.map((target) => target.token), ['WETH']);
  assert.equal(allocation.targets[0].targetWeight, 0.35);
  assert.equal(allocation.targets[0].rawWeight, 1);
  assert.equal(allocation.cashWeight, 0.65);
  assert.deepEqual(allocation.cashLikeTokens, ['USDC']);
  assert.equal(allocation.sourceSelection.selected[0].allocationWeight, 1);
});

test('preset cash floors match the product risk language', () => {
  assert.equal(PRESETS.Conservative.cashFloor, 0.5);
  assert.equal(PRESETS.Balanced.cashFloor, 0.25);
  assert.equal(PRESETS.Risky.cashFloor, 0);
});

test('market-cap range is dynamic and does not require an initial portfolio', () => {
  const range = getAssetUniverse('40:250');
  assert.equal(range.minRank, 40);
  assert.equal(range.maxRank, 250);
  const allocation = buildTargetAllocation({ sources: [], quotes: {}, dataLanes: [] }, 'Balanced');
  assert.equal(allocation.marketEvidenceStatus, 'NO_MARKET_DATA');
  assert.equal(allocation.cashWeight, 1);
  assert.match(allocation.cashReasons.join(' '), /does not require an initial portfolio/i);
});

test('multi-chain market fallback creates a labeled diversified research sleeve', () => {
  const quotes = {
    'ethereum:btc': { symbol: 'WBTC', chain: 'ethereum', priceCents: 6_000_000, liquidityUsd: 2_000_000, volume24hUsd: 9_000_000, ageSeconds: 0 },
    'base:eth': { symbol: 'WETH', chain: 'base', priceCents: 300_000, liquidityUsd: 2_000_000, volume24hUsd: 8_000_000, ageSeconds: 0 },
    'solana:sol': { symbol: 'SOL', chain: 'solana', priceCents: 14_000, liquidityUsd: 2_000_000, volume24hUsd: 7_000_000, ageSeconds: 0 },
    'ethereum:usdc': { symbol: 'USDC', chain: 'ethereum', priceCents: 100, liquidityUsd: 20_000_000, volume24hUsd: 20_000_000, ageSeconds: 0 }
  };
  const allocation = buildTargetAllocation({
    chain: 'multi', chains: ['ethereum', 'base', 'solana'], sources: [], quotes,
    tokenLanes: Object.fromEntries(Object.keys(quotes).map((token) => [token, { buyerActivity: { observedBuyerCount: 100 }, flowIntelligence: { netFlowUsd: 1000 } }])), dataLanes: []
  }, 'Balanced');
  assert.equal(allocation.marketFallback, true);
  assert.equal(allocation.cashWeight, 0.25);
  assert.equal(allocation.targets.length, 3);
  assert.deepEqual(allocation.targetChains, ['base', 'ethereum', 'solana']);
  assert.ok(allocation.targets.every((target) => target.evidence.marketFallback === true && target.targetWeight === 0.25));
});

test('missing balance denominator cannot become risk', () => {
  const candidate = getSyntheticBundle(1).sources[0];
  assert.equal(eligibility({ ...candidate, balanceComplete: false }).eligible, false);
  const allocation = buildTargetAllocation({ ...getSyntheticBundle(1), sources: [{ ...candidate, balanceComplete: false }] }, 'Balanced');
  assert.equal(allocation.targets.length, 0);
  assert.equal(allocation.cashWeight, 1);
});

test('rebalance respects turnover and never spends more than cash', () => {
  const bundle = getSyntheticBundle(1);
  const allocation = buildTargetAllocation(bundle, 'Balanced');
  const proposal = proposeRebalance({ allocation, positions: [], cashCents: 100_000_00, navCents: 100_000_00 });
  assert.ok(proposal.turnoverWeight <= 0.15);
  assert.ok(proposal.orders.every((order) => order.quantityUnits > 0 && order.notionalCents >= 100));
});
