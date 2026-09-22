import { feeForNotional, notionalForUnits, roundWeight, unitsForNotional } from './money.js';

export const POLICY_VERSION = 'v1.3.1';

// Stablecoins are cash-like liquidity in this paper model, not risky token
// targets. Keep the classifier explicit so the decision can explain it.
export const CASH_LIKE_TOKENS = Object.freeze(new Set([
  'USDC', 'USDT', 'DAI', 'USDBC', 'USDE', 'USDS', 'USDCOIN', 'TETHERUSD', 'DAISTABLECOIN', 'PYUSD', 'USAD', 'USDCE', 'FRAX', 'LUSD', 'GUSD', 'TUSD', 'USDP', 'USD1', 'CRVUSD', 'EURC', 'EUROC', 'EUROE', 'GHO', 'APXUSD', 'USDB', 'USDM', 'USDY', 'USDL', 'USDA', 'USDD', 'USDN', 'USDX', 'USD0', 'MIM', 'SUSD', 'USTC'
]));

export function isCashLikeToken(token, quote = null) {
  const candidate = quote?.symbol || String(token || '').split(':').pop();
  const normalized = String(candidate || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CASH_LIKE_TOKENS.has(normalized);
}

export const PRESETS = Object.freeze({
  Conservative: Object.freeze({ cashFloor: 0.50, tokenCap: 0.25, maxChainWeight: 0.50, maxTurnover: 0.10 }),
  Balanced: Object.freeze({ cashFloor: 0.25, tokenCap: 0.35, maxChainWeight: 0.45, maxTurnover: 0.15 }),
  Risky: Object.freeze({ cashFloor: 0.00, tokenCap: 0.50, maxChainWeight: 0.60, maxTurnover: 0.25 }),
  // Kept as an input compatibility alias for previously created links/funds.
  Exploratory: Object.freeze({ cashFloor: 0.00, tokenCap: 0.50, maxChainWeight: 0.60, maxTurnover: 0.25 })
});

export const POLICY = Object.freeze({
  version: POLICY_VERSION,
  windows: 3,
  windowDays: 30,
  minimumSales: 10,
  minimumTradedTokens: 2,
  minimumSources: 1,
  sourceInfluenceCap: 0.15,
  groupInfluenceCap: 0.25,
  rebalanceThreshold: 0.03,
  liquidityFloorUsd: 250_000,
  tradeLiquidityCap: 0.005,
  feeRate: 0.001,
  buySlippage: 0.003,
  sellSlippage: 0.003,
  presets: PRESETS
});

const finite = (value) => Number.isFinite(Number(value));

export function median(values) {
  const sorted = values.filter(finite).map(Number).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function percentileRank(value, cohort) {
  const values = cohort.filter(finite).map(Number).sort((a, b) => a - b);
  if (values.length < 2) return null;
  const lower = values.filter((item) => item < value).length;
  const equal = values.filter((item) => item === value).length;
  return (lower + (equal / 2)) / (values.length - 1);
}

export function eligibility(candidate) {
  const windows = Array.isArray(candidate.windows) ? candidate.windows : [];
  const reasons = [];
  if (windows.length !== POLICY.windows || windows.some((window) => window.valid !== true)) reasons.push('three complete windows are required');
  if ((candidate.sales ?? 0) < POLICY.minimumSales) reasons.push(`fewer than ${POLICY.minimumSales} reported sales/outflows`);
  if ((candidate.tradedTokenCount ?? 0) < POLICY.minimumTradedTokens) reasons.push(`fewer than ${POLICY.minimumTradedTokens} observed traded tokens`);
  if (!finite(candidate.aggregateRealizedPnlUsd) || Number(candidate.aggregateRealizedPnlUsd) <= 0) reasons.push('aggregate realized PnL is not positive');
  if (candidate.balanceComplete !== true) reasons.push('selected-chain balance coverage is incomplete');
  return { eligible: reasons.length === 0, reasons };
}

export function scoreCandidate(candidate, eligibleCohort) {
  const windows = candidate.windows || [];
  const profitableWindows = windows.filter((window) => Number(window.realizedRoi) > 0).length;
  const medianRoi = median(windows.map((window) => window.realizedRoi));
  const cohortRois = eligibleCohort.map((item) => median((item.windows || []).map((window) => window.realizedRoi))).filter(finite);
  const returnComponent = medianRoi === null ? 0 : (percentileRank(medianRoi, cohortRois) ?? 0);
  const breadth = Math.min(Number(median(windows.map((window) => window.tradedTokenCount))) / POLICY.minimumTradedTokens, 1);
  const score = 50 * (profitableWindows / POLICY.windows) + 30 * returnComponent + 20 * breadth;
  return {
    ...candidate,
    profitableWindows,
    medianRoi,
    returnComponent,
    breadth,
    sourceScore: Math.round(score * 100) / 100
  };
}

export function allocateSourceInfluence(scoredSources) {
  const sources = scoredSources.slice(0, 10).map((source) => ({ ...source, influence: 0 }));
  let remaining = 1;
  let active = sources.filter((source) => source.sourceScore > 40).map((source) => source.id);
  while (remaining > 0.000001 && active.length) {
    const pool = sources.filter((source) => active.includes(source.id));
    const denominator = pool.reduce((sum, source) => sum + Math.max(source.sourceScore - 40, 0), 0);
    if (!denominator) break;
    let assigned = 0;
    for (const source of pool) {
      const room = POLICY.sourceInfluenceCap - source.influence;
      const share = Math.min(room, remaining * (Math.max(source.sourceScore - 40, 0) / denominator));
      source.influence += share;
      assigned += share;
    }
    remaining -= assigned;
    active = sources.filter((source) => source.influence < POLICY.sourceInfluenceCap - 0.000001).map((source) => source.id);
    if (assigned < 0.000001) break;
  }
  return sources.map((source) => ({ ...source, influence: roundWeight(source.influence) }));
}

export function scoreAndSelect(candidates) {
  const eligibleCandidates = candidates.filter((candidate) => eligibility(candidate).eligible);
  const scored = eligibleCandidates
    .map((candidate) => scoreCandidate(candidate, eligibleCandidates))
    .sort((a, b) => b.sourceScore - a.sourceScore || a.id.localeCompare(b.id));
  return {
    eligibleCount: scored.length,
    selected: allocateSourceInfluence(scored),
    rejected: candidates.filter((candidate) => !eligibility(candidate).eligible).map((candidate) => ({ id: candidate.id, reasons: eligibility(candidate).reasons }))
  };
}

function chooseMarketEvidenceCandidates(bundle, limit = 5) {
  const ranked = Object.entries(bundle.quotes || [])
    .filter(([token, quote]) => !isCashLikeToken(token, quote) && quote && quote.ageSeconds <= 600 && quote.liquidityUsd >= POLICY.liquidityFloorUsd)
    .map(([token, quote]) => {
      const lanes = bundle.tokenLanes?.[token] || {};
      const volumeValues = Object.values(bundle.quotes || {}).map((item) => Number(item.volume24hUsd || 0)).filter((value) => value > 0);
      const maxVolume = Math.max(...volumeValues, 1);
      const buyerCount = Number(lanes.buyerActivity?.observedBuyerCount || 0);
      const netFlow = Number(lanes.flowIntelligence?.netFlowUsd || 0);
      const liquidityValues = Object.values(bundle.quotes || {}).map((item) => Number(item.liquidityUsd || 0)).filter((value) => value > 0);
      const maxLiquidity = Math.max(...liquidityValues, 1);
      const volumeScore = Number(quote.volume24hUsd || 0) / maxVolume;
      const liquidityScore = Number(quote.liquidityUsd || 0) / maxLiquidity;
      const smartMoneyNetFlow = Number(lanes.smartMoney?.netFlow24hUsd || 0);
      const flowScore = Math.min(Math.max(netFlow, 0) / Math.max(Number(quote.volume24hUsd || 0), 1), 1);
      const smartMoneyScore = Math.min(Math.max(smartMoneyNetFlow, 0) / Math.max(Number(quote.volume24hUsd || 0), 1), 1);
      const buyerScore = Math.min(buyerCount / 1000, 1);
      const score = volumeScore * 0.30 + liquidityScore * 0.15 + flowScore * 0.25 + smartMoneyScore * 0.20 + buyerScore * 0.10;
      return { token, quote, lanes, score, smartMoneyScore };
    })
    .sort((a, b) => b.score - a.score || a.token.localeCompare(b.token));
  const selected = [];
  const seenChains = new Set();
  const seenFamilies = new Set();
  const familyFor = (candidate) => {
    const symbol = String(candidate.quote?.symbol || candidate.token || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (/^(W?ETH|STETH|WSTETH|CBETH|RETH|OETH|FRXETH|SFRXETH|METH)$/.test(symbol)) return 'ether';
    if (/^(W?BTC|CBBTC|TBTC|LBTC|FBTC|OBTC|SOLVBTC)$/.test(symbol)) return 'bitcoin';
    if (/^(SOL|WSOL|MSOL|JITOSOL|BSOL|JUPSOL)$/.test(symbol)) return 'solana';
    return symbol || candidate.token;
  };
  const addCandidates = (predicate) => {
    for (const candidate of ranked) {
      if (selected.length >= limit) break;
      const chain = candidate.quote.chain || bundle.chain || 'unknown';
      const family = familyFor(candidate);
      if (selected.some((item) => item.token === candidate.token) || !predicate(candidate, chain, family)) continue;
      selected.push(candidate);
      seenChains.add(chain);
      seenFamilies.add(family);
    }
  };
  addCandidates((_candidate, chain, family) => !seenChains.has(chain) && !seenFamilies.has(family));
  addCandidates((_candidate, _chain, family) => !seenFamilies.has(family));
  addCandidates((_candidate, chain) => !seenChains.has(chain));
  addCandidates(() => true);
  return selected.slice(0, limit);
}

export function buildTargetAllocation(bundle, presetName = 'Balanced') {
  const preset = PRESETS[presetName] || PRESETS.Balanced;
  const selection = scoreAndSelect(bundle.sources || []);
  const raw = new Map();
  const unavailable = [];
  const cashLikeTokens = new Set();
  const riskFractions = new Map(selection.selected.map((source) => {
    const result = Object.entries(source.exposures || {}).reduce((accumulator, [token, fraction]) => {
      const quote = bundle.quotes?.[token];
      if (finite(fraction) && Number(fraction) > 0 && !isCashLikeToken(token, quote) && quote && quote.ageSeconds <= 600 && quote.liquidityUsd >= POLICY.liquidityFloorUsd) {
        accumulator.total += Number(fraction);
        accumulator.byToken[token] = Number(fraction);
      }
      return accumulator;
    }, { total: 0, byToken: {} });
    return [source.id, result];
  }));
  const riskSources = selection.selected.filter((source) => (riskFractions.get(source.id)?.total || 0) > 0);
  const totalRiskInfluence = riskSources.reduce((sum, source) => sum + Number(source.influence || 0), 0);
  const selected = selection.selected.map((source) => ({
    ...source,
    allocationWeight: riskSources.includes(source) && totalRiskInfluence > 0 ? roundWeight(source.influence / totalRiskInfluence) : 0
  }));
  for (const source of selected) {
    if (source.balanceComplete !== true || !source.exposures) {
      unavailable.push({ source: source.id, reason: 'missing complete balance denominator' });
      continue;
    }
    for (const [token, fraction] of Object.entries(source.exposures)) {
      if (!finite(fraction) || Number(fraction) <= 0) continue;
      const quote = bundle.quotes?.[token];
      if (isCashLikeToken(token, quote)) {
        cashLikeTokens.add(quote?.symbol || token);
        continue;
      }
      if (!quote || quote.ageSeconds > 600 || quote.liquidityUsd < POLICY.liquidityFloorUsd) {
        unavailable.push({ source: source.id, token, reason: 'quote stale or below liquidity floor' });
        continue;
      }
      const riskTotal = riskFractions.get(source.id)?.total || 0;
      const riskShare = riskTotal ? Number(fraction) / riskTotal : 0;
      raw.set(token, (raw.get(token) || 0) + source.allocationWeight * riskShare);
    }
  }
  let marketFallback = false;
  let marketCandidates = [];
  const blockedByIncompleteBalance = (bundle.sources || []).length > 0 && !(bundle.sources || []).some((source) => source.balanceComplete === true);
  let marketEvidenceStatus = raw.size >= 2 ? 'WALLET_EVIDENCE' : blockedByIncompleteBalance ? 'BLOCKED_INCOMPLETE_BALANCE' : Object.keys(bundle.quotes || {}).length ? 'INSUFFICIENT_MARKET_UNIVERSE' : 'NO_MARKET_DATA';
  if (raw.size < 2 && !blockedByIncompleteBalance) {
    marketCandidates = chooseMarketEvidenceCandidates(bundle, 5);
    if (marketCandidates.length >= 2) {
      marketFallback = true;
      marketEvidenceStatus = 'MARKET_FALLBACK';
      raw.clear();
      const equalWeight = 1 / marketCandidates.length;
      marketCandidates.forEach((candidate) => raw.set(candidate.token, equalWeight));
    }
  }
  const defaultChain = bundle.chain || 'unknown';
  const scopedChains = bundle.chains || (bundle.chain ? [bundle.chain] : []);
  const effectiveChainCap = scopedChains.length <= 1 ? 1 - preset.cashFloor : preset.maxChainWeight;
  const rankedCandidates = [...raw.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([token, rawWeight]) => ({ token, rawWeight, chain: bundle.quotes?.[token]?.chain || defaultChain }));
  const selectedCandidates = [];
  for (const chain of [...new Set(rankedCandidates.map((candidate) => candidate.chain))]) {
    const candidate = rankedCandidates.find((item) => item.chain === chain);
    if (candidate) selectedCandidates.push(candidate);
  }
  for (const candidate of rankedCandidates) {
    if (selectedCandidates.length >= 5) break;
    if (!selectedCandidates.some((item) => item.token === candidate.token)) selectedCandidates.push(candidate);
  }
  const chainWeights = new Map();
  const targets = selectedCandidates
    .map(({ token, rawWeight, chain }) => {
      const observedSources = marketFallback ? [] : selected.filter((source) => (riskFractions.get(source.id)?.byToken?.[token] || 0) > 0 && source.allocationWeight > 0);
      const chainRemaining = Math.max(0, effectiveChainCap - (chainWeights.get(chain) || 0));
      const targetWeight = roundWeight(Math.min((1 - preset.cashFloor) * rawWeight, preset.tokenCap, chainRemaining));
      chainWeights.set(chain, (chainWeights.get(chain) || 0) + targetWeight);
      const quote = bundle.quotes[token];
      return {
        token,
        symbol: quote?.symbol || token,
        chain,
        rawWeight: roundWeight(rawWeight),
        targetWeight,
        quote: bundle.quotes[token],
        evidence: {
          observedSourceCount: observedSources.length,
          marketFallback,
          weightedObservedExposure: roundWeight(rawWeight),
          sourceInfluence: roundWeight(observedSources.reduce((sum, source) => sum + source.influence, 0)),
          riskSleeveWeight: roundWeight(observedSources.reduce((sum, source) => sum + source.allocationWeight, 0)),
          sourceBreakdown: observedSources.map((source) => ({ source: source.label || source.id, influence: source.influence, allocationWeight: source.allocationWeight, observedExposure: Number(source.exposures[token]), riskySleeveExposure: roundWeight((riskFractions.get(source.id)?.byToken?.[token] || 0) / (riskFractions.get(source.id)?.total || 1)) })),
          marketScore: marketCandidates.find((candidate) => candidate.token === token)?.score || null,
          reasons: marketFallback ? [
            'Strict wallet evidence covered fewer than two risky assets on this cutoff, so this is a clearly labeled market-evidence fallback',
            `${bundle.assetUniverseLabel || 'Selected market-cap universe'} was screened before the bounded evidence lanes ran`,
            `Token Screener quote passes the $${POLICY.liquidityFloorUsd.toLocaleString()} liquidity floor on ${chain}`,
            `Flow Intelligence, buyer activity, liquidity, and volume ranked this token inside a diversified ${marketCandidates.length}-asset sleeve`,
            ...(Number(marketCandidates.find((candidate) => candidate.token === token)?.smartMoneyScore || 0) > 0 ? ['Smart Money Netflow added positive corroborating flow context'] : []),
            `The ${presetName} cap limits this token to ${Math.round(preset.tokenCap * 100)}% and this selected scope to ${Math.round(effectiveChainCap * 100)}% risk`
          ] : [
            `${observedSources.length} eligible source wallet${observedSources.length === 1 ? ' shows' : 's show'} observed ${quote?.symbol || token} exposure on ${chain}`,
            `Token Screener quote passes the $${POLICY.liquidityFloorUsd.toLocaleString()} liquidity floor`,
            `Eligible source weights are normalized across the risk sleeve; the ${presetName} cap limits this token to ${Math.round(preset.tokenCap * 100)}% and this selected scope to ${Math.round(effectiveChainCap * 100)}% risk`
          ],
          lanes: bundle.tokenLanes?.[token] || null
        }
      };
    })
    .filter((target) => target.targetWeight > 0);
  const totalRisk = targets.reduce((sum, target) => sum + target.targetWeight, 0);
  const cashWeight = roundWeight(Math.max(preset.cashFloor, 1 - totalRisk));
  const additionalCash = roundWeight(Math.max(0, cashWeight - preset.cashFloor));
  return {
    preset: presetName,
    chains: scopedChains,
    assetUniverse: bundle.assetUniverse || 'top50',
    assetUniverseLabel: bundle.assetUniverseLabel || 'Top 50 by market cap',
    selectionRules: {
      windows: POLICY.windows,
      windowDays: POLICY.windowDays,
      minimumSales: POLICY.minimumSales,
      minimumTradedTokens: POLICY.minimumTradedTokens,
      requiresPositiveRealizedPnl: true,
      requiresCompleteBalance: true,
      minimumDiversifiedAssets: 2,
      marketEvidenceFallbackWhenBelowMinimum: true,
      initialPortfolioRequired: false,
      marketEvidenceStatus,
      assetUniverse: bundle.assetUniverse || 'top50',
      assetUniverseLabel: bundle.assetUniverseLabel || 'Top 50 by market cap',
      universeSize: bundle.rawCoverage?.universeSize || null,
      analyzedTokenCount: Object.keys(bundle.quotes || {}).length,
      flowAnalyzedTokenCount: bundle.rawCoverage?.flowAnalyzedTokens || 0,
      deepAnalyzedTokenCount: bundle.rawCoverage?.deepAnalyzedTokens || 0,
      estimatedCredits: bundle.rawCoverage?.estimatedCredits || null,
      runCreditLimit: bundle.rawCoverage?.runCreditLimit || null,
      boundedCandidateLimit: Object.keys(bundle.quotes || {}).length,
      effectiveChainCap,
      chainCapNote: scopedChains.length <= 1 ? 'Single-chain scope uses the full preset risk sleeve; the diversification cap applies when multiple chains are selected.' : `Multi-chain scope caps each chain at ${Math.round(preset.maxChainWeight * 100)}%.`
    },
    sourceSelection: { ...selection, selected },
    targets,
    cashWeight,
    cashReasons: [
      `The ${presetName} preset requires at least ${Math.round(preset.cashFloor * 100)}% cash.`,
      cashLikeTokens.size ? `${[...cashLikeTokens].join(', ')} is treated as cash-like liquidity and is never created as a risky token target.` : 'Stablecoins such as USDC and USDT are treated as cash-like liquidity and are never created as risky token targets.',
      marketFallback ? 'The strict wallet cohort did not cover two risky assets, so the displayed targets are a market-evidence research sleeve rather than a claim about profitable wallets.' : marketEvidenceStatus === 'NO_MARKET_DATA' ? 'No usable market universe was returned by the provider. A new fund does not require an initial portfolio; this cash result reflects unavailable market data and should be re-evaluated.' : marketEvidenceStatus === 'INSUFFICIENT_MARKET_UNIVERSE' ? 'The selected market-cap range returned fewer than two liquid non-stable candidates after the liquidity rule. Widen the range or choose another chain.' : marketEvidenceStatus === 'BLOCKED_INCOMPLETE_BALANCE' ? 'Wallet evidence was incomplete, so it was not converted into risk. Market-evidence fallback is disabled for this incomplete wallet bundle.' : `${Math.round(additionalCash * 100)}% remains above that floor because token caps, chain diversification caps, concentration, and the five-token limit do not justify more risk from this bundle.`,
      'This policy does not predict a correction or claim that the market is overextended.'
    ],
    cashLikeTokens: [...cashLikeTokens].sort(),
    marketFallback,
    marketEvidenceStatus,
    chainCount: new Set(targets.map((target) => target.chain)).size,
    targetChains: [...new Set(targets.map((target) => target.chain))],
    dataLanes: bundle.dataLanes || [],
    unavailable,
    totalWeight: roundWeight(cashWeight + totalRisk)
  };
}

export function proposeRebalance({ allocation, positions, cashCents, navCents }) {
  const targetByToken = new Map(allocation.targets.map((target) => [target.token, target]));
  const currentByToken = new Map((positions || []).map((position) => [position.token, position]));
  const tokens = new Set([...targetByToken.keys(), ...currentByToken.keys()]);
  const desired = [];
  const skipped = [...allocation.unavailable];
  for (const token of tokens) {
    if (isCashLikeToken(token)) {
      skipped.push({ token, reason: 'cash-like stablecoin is excluded from risky rebalance orders' });
      continue;
    }
    const target = targetByToken.get(token);
    const current = currentByToken.get(token);
    const quote = target?.quote || allocation.targets.find((item) => item.token === token)?.quote || (current ? { priceCents: current.mark_cents, ageSeconds: 0, liquidityUsd: 0 } : null);
    if (!quote || !quote.priceCents) {
      skipped.push({ token, reason: 'missing valid mark' });
      continue;
    }
    const currentValue = current ? notionalForUnits(current.units, current.mark_cents || quote.priceCents) : 0;
    const currentWeight = navCents ? currentValue / navCents : 0;
    const targetWeight = target?.targetWeight || 0;
    const changedEnough = !current || Math.abs(targetWeight - currentWeight) >= POLICY.rebalanceThreshold || targetWeight === 0;
    if (!changedEnough) {
      skipped.push({ token, reason: 'change is below three percentage points', currentWeight: roundWeight(currentWeight), targetWeight: roundWeight(targetWeight) });
      continue;
    }
    desired.push({
      token,
      side: targetWeight < currentWeight ? 'SELL' : 'BUY',
      deltaCents: Math.abs(Math.round((targetWeight * navCents) - currentValue)),
      quote
    });
  }

  const turnoverLimit = Math.floor(navCents * (PRESETS[allocation.preset] || PRESETS.Balanced).maxTurnover);
  let remainingTurnover = turnoverLimit;
  let availableCash = cashCents;
  const orders = [];
  for (const item of desired.filter((candidate) => candidate.side === 'SELL')) {
    if (remainingTurnover <= 0) break;
    const position = currentByToken.get(item.token);
    const priceCents = Math.max(1, Math.floor(item.quote.priceCents * (1 - POLICY.sellSlippage)));
    const cappedNotional = Math.min(item.deltaCents, remainingTurnover, notionalForUnits(position?.units || 0, priceCents));
    const quantityUnits = unitsForNotional(cappedNotional, priceCents);
    const notionalCents = notionalForUnits(quantityUnits, priceCents);
    if (!quantityUnits || notionalCents < 100) {
      skipped.push({ token: item.token, reason: 'remaining turnover would create only a dust-sized fill' });
      continue;
    }
    const feeCents = feeForNotional(notionalCents);
    orders.push({ token: item.token, side: 'SELL', quantityUnits, priceCents, notionalCents, feeCents });
    remainingTurnover -= notionalCents;
    availableCash += notionalCents - feeCents;
  }
  for (const item of desired.filter((candidate) => candidate.side === 'BUY')) {
    if (remainingTurnover <= 0 || availableCash <= 0) break;
    const priceCents = Math.max(1, Math.ceil(item.quote.priceCents * (1 + POLICY.buySlippage)));
    const maximumAffordable = Math.floor(availableCash / 1.001);
    const cappedNotional = Math.min(item.deltaCents, remainingTurnover, maximumAffordable);
    const quantityUnits = unitsForNotional(cappedNotional, priceCents);
    const notionalCents = notionalForUnits(quantityUnits, priceCents);
    if (!quantityUnits || notionalCents < 100) {
      skipped.push({ token: item.token, reason: 'remaining turnover would create only a dust-sized fill' });
      continue;
    }
    const feeCents = feeForNotional(notionalCents);
    orders.push({ token: item.token, side: 'BUY', quantityUnits, priceCents, notionalCents, feeCents });
    remainingTurnover -= notionalCents;
    availableCash -= notionalCents + feeCents;
  }
  const turnoverCents = orders.reduce((sum, order) => sum + order.notionalCents, 0);
  return {
    orders,
    skipped,
    turnoverCents,
    turnoverWeight: navCents ? roundWeight(turnoverCents / navCents) : 0,
    maxTurnoverWeight: (PRESETS[allocation.preset] || PRESETS.Balanced).maxTurnover
  };
}
