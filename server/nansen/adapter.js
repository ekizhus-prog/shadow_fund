import { DATA_LANES } from './lanes.js';
import { hash } from '../db/index.js';
import { config } from '../config.js';
import { getAssetUniverse } from '../domain/universe.js';

const CASH_LIKE_SYMBOLS = new Set(['USDC', 'USDT', 'DAI', 'USDBC', 'USDE', 'USDS', 'PYUSD', 'USAD', 'USDCE', 'FRAX', 'LUSD', 'GUSD', 'TUSD', 'USDP', 'USD1', 'CRVUSD', 'EURC', 'EUROC', 'EUROE', 'GHO', 'APXUSD', 'USDB', 'USDM', 'USDY', 'USDL', 'USDA', 'USDD', 'USDN', 'USDX', 'USD0', 'MIM', 'SUSD', 'USTC']);

const first = (object, names, fallback = null) => {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
};

function rows(payload) {
  const candidates = [payload?.data?.data, payload?.data, payload?.results, payload?.items, payload];
  return candidates.find(Array.isArray) || [];
}

function pageComplete(payload, rowCount, pageSize) {
  const metadata = payload?.pagination || payload?.meta || payload?.data?.pagination;
  if (metadata) {
    if (metadata.has_more !== undefined) return metadata.has_more === false;
    if (metadata.hasMore !== undefined) return metadata.hasMore === false;
    if (metadata.is_last_page !== undefined) return metadata.is_last_page === true;
    if (metadata.isLastPage !== undefined) return metadata.isLastPage === true;
    if (metadata.next_cursor !== undefined) return !metadata.next_cursor;
    if (metadata.nextCursor !== undefined) return !metadata.nextCursor;
    if (metadata.total !== undefined) return Number(metadata.total) <= rowCount;
  }
  return rowCount < pageSize;
}

function responseComplete(payload) {
  const metadata = payload?.pagination || payload?.meta;
  if (!metadata) return false;
  if (metadata.complete !== undefined) return metadata.complete === true;
  if (metadata.is_last_page !== undefined) return metadata.is_last_page === true;
  if (metadata.has_more !== undefined) return metadata.has_more === false;
  return false;
}

async function fetchAll(client, endpoint, body, pageSize = 100, maxPages = 10) {
  const all = [];
  let complete = false;
  let page = 1;
  for (; page <= maxPages; page += 1) {
    const response = await client.post(endpoint, { ...body, pagination: { ...(body.pagination || {}), page, per_page: pageSize } });
    const pageRows = rows(response);
    all.push(...pageRows);
    if (pageComplete(response, pageRows.length, pageSize)) { complete = true; break; }
  }
  return { data: all, pagination: { complete, pages: page } };
}

async function mapWithConcurrency(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(items[index], index);
    }
  };
  const workerCount = Math.min(Math.max(1, concurrency), items.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roi(value) {
  const parsed = number(value);
  if (parsed === null) return null;
  if (Math.abs(parsed) > 10) throw new Error('PnL ROI schema is outside the expected range; live evaluation paused for contract review');
  return Math.abs(parsed) > 1 ? parsed / 100 : parsed;
}

function windowsEndingAt(cutoff) {
  const end = new Date(cutoff);
  return Array.from({ length: 3 }, (_, index) => {
    const to = new Date(end.getTime() - index * 30 * 24 * 60 * 60 * 1000);
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { from: from.toISOString(), to: to.toISOString() };
  }).reverse();
}

function tokenIdentity(chain, addressOrSymbol) {
  return `${String(chain || 'unknown').toLowerCase()}:${String(addressOrSymbol || 'unknown').toLowerCase()}`;
}

function isCashLikeToken(token) {
  return CASH_LIKE_SYMBOLS.has(String(token?.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, ''));
}

function assetFamily(token) {
  const symbol = String(token?.symbol || token?.key || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^(W?ETH|STETH|WSTETH|CBETH|RETH|OETH|FRXETH|SFRXETH|METH)$/.test(symbol)) return 'ether';
  if (/^(W?BTC|CBBTC|TBTC|LBTC|FBTC|OBTC|SOLVBTC)$/.test(symbol)) return 'bitcoin';
  if (/^(SOL|WSOL|MSOL|JITOSOL|BSOL|JUPSOL)$/.test(symbol)) return 'solana';
  return symbol || String(token?.key || 'unknown');
}

function candidateQuality(token) {
  const volume = Math.log10(Math.max(Number(token.volume24hUsd || 0), 1));
  const liquidity = Math.log10(Math.max(Number(token.liquidityUsd || 0), 1));
  return (volume * 0.65) + (liquidity * 0.35);
}

function normalizeToken(row, fallbackChain) {
  const chain = String(first(row, ['chain', 'blockchain'], fallbackChain) || fallbackChain || 'unknown').toLowerCase();
  const address = first(row, ['token_address', 'tokenAddress', 'address']);
  const symbol = first(row, ['token_symbol', 'symbol', 'token_name'], address);
  return {
    key: tokenIdentity(chain, address || symbol),
    chain,
    address,
    symbol,
    priceCents: Math.round((number(first(row, ['price_usd', 'price', 'current_price'])) || 0) * 100),
    liquidityUsd: number(first(row, ['liquidity_usd', 'liquidity', 'volume_liquidity_usd'], 0)) || 0,
    volume24hUsd: number(first(row, ['volume_usd', 'volume_24h_usd', 'volume'])) || 0,
    marketCapUsd: number(first(row, ['market_cap_usd', 'marketCapUsd', 'market_cap'])) || 0,
    volumeRank: number(first(row, ['rank', 'volume_rank']))
  };
}

function rankByMarketCap(tokens) {
  const unique = new Map(tokens.map((token) => [token.key, token]));
  return [...unique.values()]
    .sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0) || (b.volume24hUsd || 0) - (a.volume24hUsd || 0) || String(a.key).localeCompare(String(b.key)))
    .map((token, index) => ({ ...token, marketCapRank: index + 1 }));
}

function selectDiverseTokens(tokens, limit, assetUniverse, alreadyScoped = false) {
  const marketCapRanked = rankByMarketCap(tokens);
  const universe = getAssetUniverse(assetUniverse);
  // The first pass applies the user's market-cap range. Later passes choose
  // subsets from that already-scoped list; applying the original rank filter
  // after re-ranking a subset would incorrectly turn ranges such as 45:60
  // into zero Flow/Buyer/DEX candidates.
  const ranked = alreadyScoped
    ? marketCapRanked
    : marketCapRanked.filter((token) => token.marketCapRank >= universe.minRank && token.marketCapRank <= universe.maxRank);
  const candidates = ranked;
  const riskyRanked = candidates.filter((token) => !isCashLikeToken(token)).sort((a, b) => candidateQuality(b) - candidateQuality(a) || a.marketCapRank - b.marketCapRank || String(a.key).localeCompare(String(b.key)));
  const cashRanked = candidates.filter((token) => isCashLikeToken(token)).sort((a, b) => candidateQuality(b) - candidateQuality(a) || a.marketCapRank - b.marketCapRank || String(a.key).localeCompare(String(b.key)));
  const bucketCount = Math.min(5, Math.max(2, Math.ceil(limit / 2)));
  const selectionMinRank = alreadyScoped ? 1 : universe.minRank;
  const selectionMaxRank = alreadyScoped ? marketCapRanked.length : universe.maxRank;
  const rankWidth = Math.max(1, selectionMaxRank - selectionMinRank + 1);
  const buckets = Array.from({ length: bucketCount }, () => []);
  for (const token of riskyRanked) {
    const relativeRank = Math.max(0, Math.min(rankWidth - 1, token.marketCapRank - selectionMinRank));
    const bucket = Math.min(bucketCount - 1, Math.floor((relativeRank / rankWidth) * bucketCount));
    buckets[bucket].push(token);
  }
  buckets.forEach((bucket) => bucket.sort((a, b) => candidateQuality(b) - candidateQuality(a) || a.marketCapRank - b.marketCapRank || String(a.key).localeCompare(String(b.key))));
  const selected = [];
  const seenChains = new Set();
  const seenFamilies = new Set();
  const addFromBuckets = (predicate) => {
    let added = true;
    while (selected.length < limit && added) {
      added = false;
      for (const bucket of buckets) {
        const token = bucket.find((candidate) => !selected.some((item) => item.key === candidate.key) && predicate(candidate));
        if (!token) continue;
        selected.push(token);
        seenChains.add(token.chain);
        seenFamilies.add(assetFamily(token));
        added = true;
        if (selected.length >= limit) break;
      }
    }
  };
  // First cover different rank bands, chains, and asset families. The later
  // passes fill remaining slots when the selected universe is genuinely narrow.
  addFromBuckets((token) => !seenChains.has(token.chain) && !seenFamilies.has(assetFamily(token)));
  addFromBuckets((token) => !seenFamilies.has(assetFamily(token)));
  addFromBuckets((token) => !seenChains.has(token.chain));
  addFromBuckets(() => true);
  for (const token of cashRanked) {
    if (selected.length >= limit) break;
    if (!selected.some((item) => item.key === token.key)) selected.push(token);
  }
  return selected;
}

function responseMetric(payload, names) {
  const record = rows(payload)[0] || payload?.data || payload || {};
  return first(record, names, null);
}

export class NansenObservationAdapter {
  constructor(client) {
    this.client = client;
  }

  async collect({ chain = 'base', chains = null, addresses = [], assetUniverse = 'top50', cutoff = new Date().toISOString(), cycle = 1, screenerTimeframe = '24h', flowTimeframe = '1d', onProgress = null }) {
    const collectionStartedAt = Date.now();
    const activeChains = [...new Set((chains || [chain]).map((value) => String(value).toLowerCase()).filter(Boolean))].slice(0, 5);
    const windows = windowsEndingAt(cutoff);
    const laneErrors = [];
    const attempt = async (key, endpoint, callback) => {
      try {
        return await callback();
      } catch (error) {
        laneErrors.push({ key, endpoint, message: error.message });
        return null;
      }
    };
    const raw = { tokenScreener: null, buyerActivity: [], pnlSummary: [], currentBalance: [], dexTrades: [], flowIntelligence: [], relatedWallets: [] };
    raw.tokenScreener = await attempt('tokenScreener', '/api/v1/token-screener', () => fetchAll(this.client, '/api/v1/token-screener', {
      chains: activeChains,
      timeframe: screenerTimeframe,
      order_by: [{ field: 'market_cap_usd', direction: 'DESC' }]
    }, 1000, 1));
    // Every token returned inside the selected market-cap range is analyzed.
    // The separate walletLimit remains bounded because wallet profiling is a
    // different evidence dimension from token-level market analysis.
    const tokenLimit = Math.max(1, Math.min(config.nansenMaxTokens, 250));
    const walletLimit = Math.max(1, Math.min(config.nansenMaxWallets, 12));
    const normalizedTokens = rows(raw.tokenScreener).map((row) => normalizeToken(row, activeChains[0])).filter((token) => token.address);
    const rankedTokens = rankByMarketCap(normalizedTokens);
    const screenedTokens = selectDiverseTokens(rankedTokens, tokenLimit, assetUniverse);
    const universe = getAssetUniverse(assetUniverse);
    const runCreditLimit = Math.max(1, config.runCreditLimit);
    const screenerCredits = 1;
    const smartMoneyCredits = 5;
    const profilerCreditsPerWallet = 5;
    // Keep the evidence bundle broad, but do not let the full-range Flow scan
    // consume the entire allowance. Two deep tokens (Buyer/Sold + DEX Trades)
    // are the bridge that can discover wallets for the profiler lanes. The
    // planner remains bounded and never spends above the run cap.
    const minimumDeepTokens = Math.min(2, screenedTokens.length);
    const deepLaneReserveCredits = minimumDeepTokens > 0 && runCreditLimit >= screenerCredits + smartMoneyCredits + (minimumDeepTokens * 2)
      ? minimumDeepTokens * 2
      : 0;
    const profilerWalletLimit = Math.min(
      walletLimit,
      Math.floor(Math.max(0, runCreditLimit - screenerCredits - smartMoneyCredits - deepLaneReserveCredits) / profilerCreditsPerWallet)
    );
    const reservedWalletCredits = profilerWalletLimit * profilerCreditsPerWallet;
    const smartMoneyResponse = runCreditLimit >= smartMoneyCredits
      ? await attempt('smartMoney', '/api/v1/smart-money/netflow', () => this.client.post('/api/v1/smart-money/netflow', {
        chains: activeChains,
        filters: { include_smart_money_labels: ['Fund', 'Smart Trader'], include_stablecoins: false },
        pagination: { page: 1, per_page: 100 },
        order_by: [{ field: 'net_flow_24h_usd', direction: 'DESC' }]
      }))
      : { data: [], pagination: { complete: true }, skipped: 'run credit limit reserved for token and wallet lanes' };
    const smartMoneyByToken = new Map(rows(smartMoneyResponse).map((row) => {
      const chain = String(first(row, ['chain', 'blockchain'], activeChains[0]) || activeChains[0]).toLowerCase();
      const address = first(row, ['token_address', 'tokenAddress', 'address']);
      return [tokenIdentity(chain, address), row];
    }));
    const demoFullLanes = config.demoFullLanes && screenedTokens.length <= 20;
    const demoCreditLimit = screenerCredits + smartMoneyCredits + (screenedTokens.length * 3) + (walletLimit * profilerCreditsPerWallet);
    const planningCreditLimit = demoFullLanes ? Math.max(runCreditLimit, demoCreditLimit) : runCreditLimit;
    const flowTokenLimit = Math.min(screenedTokens.length, Math.max(0, planningCreditLimit - screenerCredits - smartMoneyCredits - reservedWalletCredits - deepLaneReserveCredits));
    const flowTokens = selectDiverseTokens(screenedTokens, flowTokenLimit, assetUniverse, true);
    const deepBudget = demoFullLanes ? planningCreditLimit : runCreditLimit;
    const deepRemainingCredits = Math.max(0, deepBudget - screenerCredits - smartMoneyCredits - flowTokens.length - reservedWalletCredits);
    const deepTokenLimit = Math.min(flowTokens.length, Math.floor(deepRemainingCredits / 2));
    const deepTokens = selectDiverseTokens(flowTokens, deepTokenLimit, assetUniverse, true);
    const flowKeys = new Set(flowTokens.map((token) => token.key));
    const deepKeys = new Set(deepTokens.map((token) => token.key));
    const walletCandidates = new Map();
    const addWallet = (walletChain, address) => {
      const normalizedAddress = String(address || '').trim();
      if (!normalizedAddress) return;
      const wallet = { chain: String(walletChain || activeChains[0]).toLowerCase(), address: normalizedAddress };
      walletCandidates.set(`${wallet.chain}:${wallet.address}`, wallet);
    };
    addresses.filter(Boolean).slice(0, profilerWalletLimit).forEach((address) => addWallet(activeChains[0], address));
    const tokenResults = await mapWithConcurrency(screenedTokens, config.nansenConcurrency, async (token, index) => {
      const cashLike = isCashLikeToken(token);
      const buyerResponse = cashLike
        ? { data: [], pagination: { complete: true }, skipped: 'cash-like token' }
        : !deepKeys.has(token.key)
          ? { data: [], pagination: { complete: true }, skipped: 'reserved budget for the full selected-token scan' }
          : await attempt('buyerActivity', '/api/v1/tgm/who-bought-sold', () => fetchAll(this.client, '/api/v1/tgm/who-bought-sold', { chain: token.chain, token_address: token.address, date: { from: windows[2].from, to: cutoff }, buy_or_sell: 'BUY' }, 1000, 1));
      const flowResponse = !flowKeys.has(token.key)
        ? { data: [], pagination: { complete: true }, skipped: 'reserved budget for the full selected-token scan' }
        : await attempt('flowIntelligence', '/api/v1/tgm/flow-intelligence', () => this.client.post('/api/v1/tgm/flow-intelligence', { chain: token.chain, token_address: token.address, timeframe: flowTimeframe }));
      const dexResponse = cashLike
        ? { data: [], pagination: { complete: true }, skipped: 'cash-like token' }
        : !deepKeys.has(token.key)
          ? { data: [], pagination: { complete: true }, skipped: 'reserved budget for the full selected-token scan' }
          : await attempt('dexTrades', '/api/v1/tgm/dex-trades', () => fetchAll(this.client, '/api/v1/tgm/dex-trades', { chain: token.chain, token_address: token.address, date: { from: windows[0].from, to: cutoff } }, 1000, 1));
      onProgress?.({ completed: index + 1, total: screenedTokens.length, token });
      return { token, buyerResponse, flowResponse, dexResponse };
    });
    for (const { token, buyerResponse, flowResponse, dexResponse } of tokenResults) {
      raw.buyerActivity.push({ token, response: buyerResponse });
      for (const record of rows(buyerResponse)) {
        const address = first(record, ['address', 'wallet_address', 'walletAddress']);
        // The token request is the authoritative chain context. Some provider
        // rows omit chain or return a generic chain field for the wallet.
        addWallet(token.chain, address);
      }
      raw.flowIntelligence.push({ token, response: flowResponse });
      raw.dexTrades.push({ token, response: dexResponse });
    }
    const discovered = new Map();
    for (const chainName of activeChains) {
      if (discovered.size >= profilerWalletLimit) break;
      const firstCandidate = [...walletCandidates.values()].find((wallet) => wallet.chain === chainName);
      if (firstCandidate) discovered.set(`${firstCandidate.chain}:${firstCandidate.address}`, firstCandidate);
    }
    for (const wallet of walletCandidates.values()) {
      if (discovered.size >= profilerWalletLimit) break;
      discovered.set(`${wallet.chain}:${wallet.address}`, wallet);
    }
    const walletResults = await mapWithConcurrency([...discovered.values()], config.nansenConcurrency, async (wallet) => {
      const balanceResponse = await attempt('currentBalance', '/api/v1/profiler/address/current-balance', () => fetchAll(this.client, '/api/v1/profiler/address/current-balance', { chain: wallet.chain, address: wallet.address, hide_spam_token: true }, 1000, 1));
      const relatedResponse = await attempt('relatedWallets', '/api/v1/profiler/address/related-wallets', () => fetchAll(this.client, '/api/v1/profiler/address/related-wallets', { chain: wallet.chain, address: wallet.address }, 1000, 1));
      const pnlResponses = [];
      for (const window of windows) {
        pnlResponses.push(await attempt('pnlSummary', '/api/v1/profiler/address/pnl-summary', () => this.client.post('/api/v1/profiler/address/pnl-summary', { chain: wallet.chain, address: wallet.address, date: window })));
      }
      return { wallet, balanceResponse, relatedResponse, pnlResponses };
    });
    for (const { wallet, balanceResponse, relatedResponse, pnlResponses } of walletResults) {
      raw.currentBalance.push({ ...wallet, response: balanceResponse });
      raw.relatedWallets.push({ ...wallet, response: relatedResponse });
      windows.forEach((window, index) => raw.pnlSummary.push({ ...wallet, window, response: pnlResponses[index] }));
    }

    const sources = [...discovered.values()].map((wallet) => {
      const summaries = raw.pnlSummary.filter((item) => item.chain === wallet.chain && item.address === wallet.address);
      const balancesResponse = raw.currentBalance.find((item) => item.chain === wallet.chain && item.address === wallet.address)?.response;
      const balanceRows = rows(balancesResponse);
      const balanceValues = balanceRows.map((row) => {
        const address = first(row, ['token_address', 'tokenAddress']);
        const symbol = first(row, ['token_symbol', 'symbol', 'token_name'], address);
        return { token: tokenIdentity(wallet.chain, address || symbol), valueUsd: number(first(row, ['value_usd', 'usd_value', 'value'], 0)) || 0 };
      }).filter((item) => item.token && item.valueUsd > 0);
      const totalBalance = balanceValues.reduce((sum, item) => sum + item.valueUsd, 0);
      const exposures = Object.fromEntries(balanceValues.map((item) => [item.token, totalBalance ? item.valueUsd / totalBalance : 0]));
      const normalizedWindows = windows.map((window, index) => {
        const summary = summaries[index]?.response;
        const record = rows(summary)[0] || summary || {};
        return { realizedRoi: roi(first(record, ['realized_pnl_percent', 'realized_pnl_roi', 'roi'])), tradedTokenCount: number(first(record, ['traded_token_count', 'traded_tokens'], 0)) || 0, valid: Boolean(summary) && responseComplete(summary) && Boolean(first(record, ['traded_token_count', 'traded_tokens'])) };
      });
      return {
        id: `${wallet.chain}:${wallet.address}`,
        label: `${wallet.chain} · ${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
        chain: wallet.chain,
        sales: normalizedWindows.reduce((sum, window, index) => sum + (number(first(rows(summaries[index]?.response)[0] || summaries[index]?.response, ['traded_times', 'sales'], 0)) || 0), 0),
        tradedTokenCount: Math.max(...normalizedWindows.map((window) => window.tradedTokenCount), 0),
        aggregateRealizedPnlUsd: summaries.reduce((sum, item) => sum + (number(responseMetric(item.response, ['realized_pnl_usd', 'realizedPnlUsd'])) || 0), 0),
        balanceComplete: Boolean(balancesResponse?.pagination?.complete) && balanceRows.length > 0 && totalBalance > 0,
        exposures,
        windows: normalizedWindows
      };
    });
    const quotes = Object.fromEntries(screenedTokens.map((token) => [token.key, { ...token, ageSeconds: 0, observedAt: cutoff, source: '/api/v1/token-screener' }]));
    const tokenLanes = Object.fromEntries(screenedTokens.map((token) => {
      const buyers = raw.buyerActivity.find((item) => item.token.key === token.key)?.response;
      const flow = raw.flowIntelligence.find((item) => item.token.key === token.key)?.response;
      const dexTrades = raw.dexTrades.find((item) => item.token.key === token.key)?.response;
      return [token.key, {
        tokenScreener: { volume24hUsd: token.volume24hUsd, volumeRank: token.volumeRank, liquidityUsd: token.liquidityUsd },
        buyerActivity: { observedBuyerCount: rows(buyers).length, window: screenerTimeframe, coverage: buyers?.skipped || (buyers?.pagination?.complete === false ? 'bounded first page' : 'complete response'), status: buyers?.skipped ? 'NOT_USED' : buyers ? 'LIVE' : 'UNAVAILABLE' },
        flowIntelligence: { netFlowUsd: number(responseMetric(flow, ['net_flow_usd', 'netFlowUsd', 'net_flow'])), timeframe: flowTimeframe, status: flow?.skipped ? 'NOT_USED' : flow ? 'LIVE' : 'UNAVAILABLE' },
        dexTrades: { observedTradeCount: rows(dexTrades).length, window: '30d', coverage: dexTrades?.skipped === 'cash-like token' ? 'not applicable to cash-like token' : dexTrades?.skipped || (dexTrades?.pagination?.complete === false ? 'bounded first page' : 'complete response'), status: dexTrades?.skipped === 'cash-like token' ? 'NOT_APPLICABLE' : dexTrades?.skipped ? 'NOT_USED' : dexTrades ? 'LIVE' : 'UNAVAILABLE' },
        smartMoney: (() => {
          const row = smartMoneyByToken.get(token.key);
          return { netFlow24hUsd: number(first(row, ['net_flow_24h_usd', 'netFlow24hUsd'], 0)) || 0, traderCount: number(first(row, ['trader_count', 'traderCount'], 0)) || 0, status: smartMoneyResponse?.skipped ? 'NOT_USED' : row ? 'LIVE' : smartMoneyResponse ? 'LIVE' : 'UNAVAILABLE' };
        })()
      }];
    }));
    const bundle = {
      chain: activeChains.length > 1 ? 'multi' : activeChains[0],
      chains: activeChains,
      assetUniverse,
      assetUniverseLabel: getAssetUniverse(assetUniverse).label,
      cycle,
      eventCutoff: cutoff,
      mode: 'LIVE',
      sources,
      quotes,
      tokenLanes,
      dataLanes: DATA_LANES.map((lane) => {
        const laneError = laneErrors.find((error) => error.key === lane.key);
        const budgetLane = lane.key === 'flowIntelligence' ? { used: flowTokens.length, total: screenedTokens.length } : lane.key === 'buyerActivity' || lane.key === 'dexTrades' ? { used: deepTokens.length, total: screenedTokens.length } : null;
        return {
          ...lane,
          status: lane.key === 'smartMoney' ? (laneError ? 'UNAVAILABLE' : smartMoneyResponse?.skipped ? 'NOT_USED' : 'LIVE') : laneError ? 'UNAVAILABLE' : budgetLane && budgetLane.used === 0 ? 'NOT_USED' : lane.key === 'currentBalance' || lane.key === 'relatedWallets' || lane.key === 'pnlSummary' ? (discovered.size ? 'LIVE' : 'NOT_USED') : 'LIVE',
          note: lane.key === 'smartMoney'
            ? laneError ? `Provider lane unavailable for this run: ${laneError.message}` : 'Live Smart Money Netflow response captured server-side; token-level classification is used only as corroborating evidence.'
            : laneError
              ? `Provider lane unavailable for this run: ${laneError.message}`
              : budgetLane && budgetLane.used < budgetLane.total
                ? `Live for ${budgetLane.used} of ${budgetLane.total} analyzed tokens; the remaining token rows were still screened and scored within the ${runCreditLimit}-credit run plan.`
              : lane.key === 'currentBalance' || lane.key === 'relatedWallets' || lane.key === 'pnlSummary'
                ? (discovered.size
                  ? `Live for ${discovered.size} discovered wallet${discovered.size === 1 ? '' : 's'}; response captured server-side with request hash and coverage metadata.`
                  : profilerWalletLimit > 0
                    ? `The run reserved profiler capacity for up to ${profilerWalletLimit} wallet${profilerWalletLimit === 1 ? '' : 's'}, but the deep buyer lane returned no wallet address.`
                    : 'No wallet-profiler credits were reserved under this run limit.')
              : 'Response captured server-side with request hash and coverage metadata.'
        };
      }),
      synthetic: false,
      rawCoverage: {
        chains: activeChains,
        assetUniverse,
        assetUniverseLabel: getAssetUniverse(assetUniverse).label,
        universeSize: rankedTokens.filter((token) => token.marketCapRank >= universe.minRank && token.marketCapRank <= universe.maxRank).length,
        discoveredWallets: discovered.size,
        screenedTokens: screenedTokens.length,
        analyzedTokens: screenedTokens.length,
        analysisMode: 'FULL_SELECTED_RANGE',
        flowAnalyzedTokens: flowTokens.length,
        deepAnalyzedTokens: deepTokens.length,
        runCreditLimit: demoFullLanes ? planningCreditLimit : runCreditLimit,
        configuredRunCreditLimit: runCreditLimit,
        demoFullLanes,
        estimatedCredits: screenerCredits + smartMoneyCredits + flowTokens.length + (deepTokens.length * 2) + reservedWalletCredits,
        profilerWalletLimit,
        reservedWalletCredits,
        deepLaneReserveCredits,
        smartMoneyRows: rows(smartMoneyResponse).length,
        screenedChains: [...new Set(screenedTokens.map((token) => token.chain))],
        windows: windows.length,
        collectionMs: Date.now() - collectionStartedAt,
        laneErrors
      }
    };
    return { ...bundle, sourceHash: hash(bundle) };
  }
}
