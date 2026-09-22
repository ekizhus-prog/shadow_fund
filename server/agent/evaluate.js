import { buildTargetAllocation, POLICY, POLICY_VERSION, proposeRebalance } from '../domain/policy.js';
import { applyDecision, deserializeDecision, getPortfolio } from '../domain/ledger.js';
import { execute, hash, id, now, queryAll, queryOne } from '../db/index.js';
import { getSyntheticBundle } from '../fixtures/synthetic.js';
import { config } from '../config.js';
import { NansenClient } from '../nansen/client.js';
import { NansenObservationAdapter } from '../nansen/adapter.js';
import { getAssetUniverse } from '../domain/universe.js';

function setJob(db, jobId, stage, progress, message, status = 'RUNNING', extra = {}) {
  execute(db, `UPDATE jobs SET stage = ?, progress = ?, message = ?, status = ?, decision_id = COALESCE(?, decision_id), error = ?, updated_at = ? WHERE id = ?`, [stage, progress, message, status, extra.decisionId || null, extra.error || null, now(), jobId]);
}

function beforeSnapshot(portfolio) {
  return {
    navCents: portfolio.navCents,
    cashWeight: portfolio.navCents ? portfolio.cashCents / portfolio.navCents : 1,
    positions: portfolio.positions.map((position) => ({ token: position.token, valueCents: position.valueCents, weight: position.weight }))
  };
}

function explanation({ allocation, proposal, bundle, portfolio }) {
  const sourceCount = allocation.sourceSelection.selected.length;
  const candidateCount = allocation.sourceSelection.eligibleCount + allocation.sourceSelection.rejected.length;
  const targetText = allocation.targets.length
    ? allocation.targets.map((target) => `${target.chain ? `${target.chain} · ` : ''}${target.symbol || target.token} ${Math.round(target.targetWeight * 100)}%`).join(', ')
    : 'cash only';
  const action = proposal.orders.length ? `${proposal.orders.length} paper fill${proposal.orders.length === 1 ? '' : 's'}` : 'no paper fills';
  const liveLaneText = allocation.dataLanes.filter((lane) => lane.status === 'LIVE').map((lane) => lane.label).join(', ');
  const cachedLaneText = allocation.dataLanes.filter((lane) => lane.status === 'CACHED').map((lane) => lane.label).join(', ');
  const unavailableLaneCount = allocation.dataLanes.filter((lane) => lane.status === 'UNAVAILABLE').length;
  const laneText = [liveLaneText, cachedLaneText ? `${cachedLaneText} (recent cache)` : ''].filter(Boolean).join(', ') || 'no complete live lane';
  const cacheText = cachedLaneText ? ' A recent cached token universe was used because the provider lane timed out; the cache age is shown in the evidence card.' : '';
  const universeText = bundle.assetUniverseLabel ? ` The requested universe was ${bundle.assetUniverseLabel}.` : '';
  const methodText = allocation.marketFallback
    ? `${allocation.sourceSelection.selected.length ? 'Strict wallet evidence covered fewer than two risky assets' : 'No eligible wallet source was required for this first-run market scan'}, so the target uses a clearly labeled multi-chain market-evidence fallback from Token Screener, Flow Intelligence, buyer activity, liquidity, and volume. `
    : 'Observed source exposure produced the target. ';
  const analyzedTokenCount = bundle.rawCoverage?.analyzedTokens || Object.keys(bundle.quotes || {}).length;
  return `Cycle ${bundle.cycle} analyzed ${analyzedTokenCount} tokens in the selected market-cap range, then evaluated ${candidateCount} wallet candidates and selected ${sourceCount} after the three-window eligibility test. ` +
    `${methodText}${allocation.preset} target: ${targetText}, with ${Math.round(allocation.cashWeight * 100)}% cash. ` +
    `The evidence bundle has ${laneText} available; ${unavailableLaneCount} declared lane${unavailableLaneCount === 1 ? '' : 's'} could not be used in this run.${cacheText} ` +
    `Available lanes explain coverage and liquidity context; eligible sources are normalized inside the risk sleeve, while capped source influence remains an attribution limit.${universeText} ` +
    `${allocation.cashLikeTokens?.length ? `${allocation.cashLikeTokens.join(', ')} was treated as cash-like liquidity. ` : 'Stablecoins were treated as cash-like liquidity when observed. '}` +
    `${action[0].toUpperCase()}${action.slice(1)} stayed within the ${Math.round(proposal.maxTurnoverWeight * 100)}% turnover cap; starting NAV was $${(portfolio.navCents / 100).toFixed(2)}. ` +
    `This is ${bundle.synthetic ? 'synthetic recorded evidence' : 'live provider evidence'}, not investment advice, a return forecast, or a real order.`;
}

export function ensurePolicy(db) {
  execute(db, `INSERT INTO policy_versions (id, version, policy_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(version) DO NOTHING`, [id('policy'), POLICY_VERSION, JSON.stringify(POLICY), now()]);
  execute(db, 'UPDATE funds SET policy_version = ? WHERE policy_version <> ?', [POLICY_VERSION, POLICY_VERSION]);
}

async function collectBundle(db, fund, dataMode, jobId = null) {
  if (dataMode === 'synthetic') return getSyntheticBundle(Number(fund.current_cycle) + 1);
  if (!config.nansenApiKey) throw new Error('Live mode requires NANSEN_API_KEY; synthetic mode remains the safe default');
  const client = new NansenClient({
    apiKey: config.nansenApiKey,
    onCall: (call) => execute(db, 'INSERT INTO api_calls (id, endpoint, request_hash, status, http_status, credits, fetched_at, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id('api'), call.endpoint, call.requestHash, call.status, call.httpStatus, call.credits, now(), call.error || null])
  });
  const cycle = Number(fund.current_cycle) + 1;
  const assetUniverse = fund.asset_universe || 'top50';
  const bundle = await new NansenObservationAdapter(client).collect({
    chain: fund.chain,
    chains: fund.chain === 'multi' ? config.nansenChains : [fund.chain],
    assetUniverse,
    cycle,
    cutoff: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    onProgress: jobId ? ({ completed, total, token }) => setJob(db, jobId, 'COLLECTING', 12 + Math.round((completed / Math.max(total, 1)) * 16), `Analyzed ${completed}/${total} tokens${token?.symbol ? ` · ${token.symbol}` : ''}`) : null
  });
  if (Object.keys(bundle.quotes || {}).length >= 2) return bundle;

  // A short provider outage must not erase the last useful published universe.
  // Reuse only a recent, durable live observation and label it as cached so the
  // UI and journal remain honest about freshness and lane availability.
  const previousRows = queryAll(db, `SELECT cycle, fetched_at, bundle_json FROM observations WHERE fund_id = ? AND mode = 'LIVE' AND cycle < ? ORDER BY cycle DESC LIMIT 12`, [fund.id, cycle]);
  for (const previous of previousRows) {
    try {
      const previousBundle = JSON.parse(previous.bundle_json);
      const previousQuotes = previousBundle.quotes || {};
      const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(previous.fetched_at).getTime()) / 1000));
      if (Object.keys(previousQuotes).length < 2 || !Number.isFinite(ageSeconds) || ageSeconds > 600) continue;
      const cachedQuotes = Object.fromEntries(Object.entries(previousQuotes).map(([token, quote]) => [token, { ...quote, ageSeconds }]));
      const dataLanes = (bundle.dataLanes || []).map((lane) => lane.key === 'tokenScreener'
        ? { ...lane, status: 'CACHED', note: `Provider lane unavailable; reused the last complete token universe from cycle ${previous.cycle}, ${ageSeconds}s old. No fresh Token Screener claim is made.` }
        : lane);
      const cachedBundle = {
        ...bundle,
        quotes: cachedQuotes,
        tokenLanes: previousBundle.tokenLanes || {},
        dataLanes,
        assetUniverse: previousBundle.assetUniverse || assetUniverse,
        assetUniverseLabel: previousBundle.assetUniverseLabel || getAssetUniverse(assetUniverse).label,
        rawCoverage: { ...bundle.rawCoverage, cachedTokenUniverse: true, cacheCycle: previous.cycle, cacheAgeSeconds: ageSeconds, assetUniverse: previousBundle.assetUniverse || assetUniverse, assetUniverseLabel: previousBundle.assetUniverseLabel || getAssetUniverse(assetUniverse).label }
      };
      return { ...cachedBundle, sourceHash: hash(cachedBundle) };
    } catch {
      // Ignore one malformed historical bundle and inspect the next bounded row.
    }
  }
  return bundle;
}

export async function runEvaluation(db, { fundId, jobId, dataMode = 'synthetic' }) {
  let fund = queryOne(db, 'SELECT * FROM funds WHERE id = ?', [fundId]);
  if (!fund) throw new Error('Fund not found');
  try {
    ensurePolicy(db);
    fund = queryOne(db, 'SELECT * FROM funds WHERE id = ?', [fundId]);
    const cycle = Number(fund.current_cycle) + 1;
    setJob(db, jobId, 'COLLECTING', 12, `Collecting bounded ${fund.chain} observations`);
    const bundle = await collectBundle(db, fund, dataMode, jobId);
    const existingObservation = queryOne(db, 'SELECT * FROM observations WHERE fund_id = ? AND cycle = ?', [fundId, cycle]);
    const observationId = existingObservation?.id || id('obs');
    if (!existingObservation) {
      const mode = bundle.synthetic ? 'SYNTHETIC' : 'LIVE';
      const endpoint = bundle.synthetic ? 'fixture://bounded-wallet-bundle' : 'https://api.nansen.ai';
      const coverage = bundle.rawCoverage ? JSON.stringify(bundle.rawCoverage) : 'complete fixture coverage';
      execute(db, `INSERT INTO observations (id, fund_id, cycle, mode, endpoint, event_cutoff, fetched_at, coverage, source_hash, bundle_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [observationId, fundId, cycle, mode, endpoint, bundle.eventCutoff, now(), coverage, bundle.sourceHash, JSON.stringify(bundle), now()]);
    }

    setJob(db, jobId, 'VALIDATING', 30, 'Checking window completeness, balance denominators, and quote freshness');
    const portfolio = getPortfolio(db, fundId);
    const allocation = buildTargetAllocation(bundle, fund.preset);
    setJob(db, jobId, 'SCORING', 52, `Scored ${bundle.sources.length} candidate wallets; ${allocation.sourceSelection.eligibleCount} passed eligibility`);
    const proposal = proposeRebalance({ allocation, positions: portfolio.positions.map((position) => ({ token: position.token, units: position.unitsRaw, mark_cents: position.markCents })), cashCents: portfolio.cashCents, navCents: portfolio.navCents });
    setJob(db, jobId, 'TARGETING', 70, `Constructed ${allocation.targets.length} token targets and a ${Math.round(allocation.cashWeight * 100)}% cash target`);
    const input = { fundId, cycle, policyVersion: fund.policy_version, sourceHash: bundle.sourceHash, allocation, proposal, before: beforeSnapshot(portfolio) };
    const inputHash = hash(input);
    let decision = queryOne(db, 'SELECT * FROM decisions WHERE fund_id = ? AND cycle = ? AND input_hash = ?', [fundId, cycle, inputHash]);
    if (!decision) {
      const decisionId = id('decision');
      execute(db, `INSERT INTO decisions (id, fund_id, cycle, status, input_hash, observation_id, policy_version, mode, before_json, target_json, orders_json, skipped_json, costs_json, explanation, created_at) VALUES (?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`, [decisionId, fundId, cycle, inputHash, observationId, fund.policy_version, bundle.synthetic ? 'SYNTHETIC' : 'LIVE', JSON.stringify(beforeSnapshot(portfolio)), JSON.stringify(allocation), JSON.stringify(proposal.orders), JSON.stringify(proposal.skipped), explanation({ allocation, proposal, bundle, portfolio }), now()]);
      decision = queryOne(db, 'SELECT * FROM decisions WHERE id = ?', [decisionId]);
      for (const source of allocation.sourceSelection.selected) {
        execute(db, 'INSERT INTO decision_evidence (id, decision_id, evidence_type, evidence_json) VALUES (?, ?, ?, ?)', [id('evidence'), decisionId, 'source_score', JSON.stringify({ source: source.id, score: source.sourceScore, influence: source.influence, medianRoi: source.medianRoi })]);
      }
      execute(db, 'INSERT INTO decision_evidence (id, decision_id, evidence_type, evidence_json) VALUES (?, ?, ?, ?)', [id('evidence'), decisionId, 'allocation', JSON.stringify({ targets: allocation.targets, cashWeight: allocation.cashWeight, preset: allocation.preset })]);
      execute(db, 'INSERT INTO decision_evidence (id, decision_id, evidence_type, evidence_json) VALUES (?, ?, ?, ?)', [id('evidence'), decisionId, 'observation', JSON.stringify({ observationId, mode: bundle.synthetic ? 'SYNTHETIC' : 'LIVE', sourceHash: bundle.sourceHash, eventCutoff: bundle.eventCutoff, dataLanes: bundle.dataLanes })]);
    }
    setJob(db, jobId, 'PAPER_REBALANCING', 82, proposal.orders.length ? 'Applying paper orders with modeled costs' : 'No eligible change; recording a no-change decision');
    const applied = applyDecision(db, decision.id, { quotes: bundle.quotes });
    setJob(db, jobId, 'JOURNALED', 94, applied.status === 'NO_CHANGE' ? 'No Change journaled with evidence' : 'Paper fills and cash entries reconciled', 'RUNNING', { decisionId: applied.id });
    setJob(db, jobId, 'MONITORING', 100, 'Monitoring with the latest durable mark', 'SUCCEEDED', { decisionId: applied.id });
    return applied;
  } catch (error) {
    setJob(db, jobId, 'ERROR', 100, 'Evaluation stopped without changing the paper ledger', 'FAILED', { error: error.message });
    throw error;
  }
}
