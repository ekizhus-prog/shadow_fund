import { execute, id, now, queryAll, queryOne, transaction } from '../db/index.js';
import { centsToUsd, notionalForUnits, unitsToNumber } from './money.js';

function parseJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function createFund(db, { initialCashCents, preset, chain = 'base', assetUniverse = 'top50', dataMode = 'synthetic', policyVersion }) {
  const fundId = id('fund');
  const timestamp = now();
  transaction(db, () => {
    execute(db, `INSERT INTO funds (id, initial_cash_cents, cash_cents, preset, chain, asset_universe, status, data_mode, current_cycle, policy_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'READY', ?, 0, ?, ?, ?)`, [fundId, initialCashCents, initialCashCents, preset, chain, assetUniverse, dataMode, policyVersion, timestamp, timestamp]);
    execute(db, `INSERT INTO cash_entries (id, fund_id, entry_type, amount_cents, reason, created_at) VALUES (?, ?, 'VIRTUAL_DEPOSIT', ?, ?, ?)`, [id('cash'), fundId, initialCashCents, 'Initial virtual capital', timestamp]);
  });
  return fundId;
}

function positionValue(position) {
  return notionalForUnits(position.units, position.mark_cents);
}

export function getPortfolio(db, fundId) {
  const fund = queryOne(db, 'SELECT * FROM funds WHERE id = ?', [fundId]);
  if (!fund) return null;
  const rawPositions = queryAll(db, 'SELECT * FROM positions WHERE fund_id = ? AND units > 0 ORDER BY token', [fundId]);
  const positionValues = rawPositions.map(positionValue);
  const navCents = Number(fund.cash_cents) + positionValues.reduce((sum, value) => sum + value, 0);
  const positions = rawPositions.map((position, index) => ({
    token: position.token,
    units: unitsToNumber(position.units),
    unitsRaw: position.units,
    markCents: position.mark_cents,
    markUsd: centsToUsd(position.mark_cents),
    valueCents: positionValues[index],
    valueUsd: centsToUsd(positionValues[index]),
    weight: navCents ? Math.round((positionValues[index] / navCents) * 10000) / 10000 : 0,
    targetWeight: position.target_weight,
    costBasisUsd: centsToUsd(position.cost_basis_cents)
  }));
  const maxNav = queryOne(db, `SELECT MAX(CAST(json_extract(costs_json, '$.navAfterCents') AS INTEGER)) AS max_nav FROM decisions WHERE fund_id = ? AND status IN ('APPLIED', 'NO_CHANGE')`, [fundId])?.max_nav;
  const drawdown = maxNav && Number(maxNav) > 0 ? (navCents / Number(maxNav)) - 1 : 0;
  return {
    fundId,
    cashCents: Number(fund.cash_cents),
    cashUsd: centsToUsd(fund.cash_cents),
    navCents,
    navUsd: centsToUsd(navCents),
    netReturn: fund.initial_cash_cents ? (navCents / fund.initial_cash_cents) - 1 : 0,
    drawdown,
    positions,
    cycle: fund.current_cycle
  };
}

export function getFundSnapshot(db, fundId) {
  const fund = queryOne(db, 'SELECT * FROM funds WHERE id = ?', [fundId]);
  if (!fund) return null;
  const latestJob = queryOne(db, 'SELECT * FROM jobs WHERE fund_id = ? ORDER BY created_at DESC LIMIT 1', [fundId]);
  const latestObservation = queryOne(db, 'SELECT id, cycle, mode, endpoint, event_cutoff, fetched_at, coverage, source_hash FROM observations WHERE fund_id = ? ORDER BY cycle DESC LIMIT 1', [fundId]);
  const decisions = queryAll(db, 'SELECT * FROM decisions WHERE fund_id = ? ORDER BY cycle DESC LIMIT 20', [fundId]).map(deserializeDecision);
  return {
    id: fund.id,
    preset: fund.preset,
    chain: fund.chain,
    assetUniverse: fund.asset_universe || 'top50',
    status: fund.status,
    dataMode: fund.data_mode,
    currentCycle: fund.current_cycle,
    policyVersion: fund.policy_version,
    createdAt: fund.created_at,
    portfolio: getPortfolio(db, fundId),
    latestJob,
    latestObservation,
    decisions
  };
}

export function deserializeDecision(row) {
  if (!row) return null;
  return {
    id: row.id,
    fundId: row.fund_id,
    cycle: row.cycle,
    status: row.status,
    inputHash: row.input_hash,
    observationId: row.observation_id,
    policyVersion: row.policy_version,
    mode: row.mode,
    before: parseJson(row.before_json, {}),
    target: parseJson(row.target_json, {}),
    orders: parseJson(row.orders_json, []),
    skipped: parseJson(row.skipped_json, []),
    costs: parseJson(row.costs_json, {}),
    explanation: row.explanation,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

export function getDecision(db, decisionId) {
  const row = queryOne(db, 'SELECT * FROM decisions WHERE id = ?', [decisionId]);
  if (!row) return null;
  const decision = deserializeDecision(row);
  decision.evidence = queryAll(db, 'SELECT evidence_type, evidence_json FROM decision_evidence WHERE decision_id = ?', [decisionId])
    .map((item) => ({ type: item.evidence_type, data: parseJson(item.evidence_json, {}) }));
  return decision;
}

export function applyDecision(db, decisionId, { quotes = {} } = {}) {
  return transaction(db, () => {
    const decisionRow = queryOne(db, 'SELECT * FROM decisions WHERE id = ?', [decisionId]);
    if (!decisionRow) throw new Error('Decision not found');
    if (['APPLIED', 'NO_CHANGE'].includes(decisionRow.status)) return getDecision(db, decisionId);
    const decision = deserializeDecision(decisionRow);
    const fund = queryOne(db, 'SELECT * FROM funds WHERE id = ?', [decision.fundId]);
    let cashCents = Number(fund.cash_cents);
    let feeCents = 0;
    let turnoverCents = 0;
    const fills = [];
    const timestamp = now();

    for (const requested of decision.orders) {
      const existing = queryOne(db, 'SELECT * FROM positions WHERE fund_id = ? AND token = ?', [decision.fundId, requested.token]);
      const existingUnits = Number(existing?.units || 0);
      let quantityUnits = Number(requested.quantityUnits);
      if (requested.side === 'SELL') quantityUnits = Math.min(quantityUnits, existingUnits);
      if (requested.side === 'BUY') {
        const maximumNotional = Math.floor(cashCents / 1.001);
        quantityUnits = Math.min(quantityUnits, Math.floor((maximumNotional * 100_000_000) / requested.priceCents));
      }
      if (!quantityUnits) continue;
      const notionalCents = notionalForUnits(quantityUnits, requested.priceCents);
      const actualFee = Math.floor(notionalCents * 0.001);
      if (requested.side === 'BUY') {
        const total = notionalCents + actualFee;
        if (total > cashCents) continue;
        cashCents -= total;
        const newUnits = existingUnits + quantityUnits;
        const newBasis = Number(existing?.cost_basis_cents || 0) + total;
        execute(db, `INSERT INTO positions (fund_id, token, units, cost_basis_cents, mark_cents, target_weight, updated_at)
          VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(fund_id, token) DO UPDATE SET units = excluded.units, cost_basis_cents = excluded.cost_basis_cents, mark_cents = excluded.mark_cents, updated_at = excluded.updated_at`,
        [decision.fundId, requested.token, newUnits, newBasis, requested.priceCents, timestamp]);
        execute(db, `INSERT INTO cash_entries (id, fund_id, decision_id, entry_type, amount_cents, reason, created_at) VALUES (?, ?, ?, 'PAPER_BUY', ?, ?, ?)`, [id('cash'), decision.fundId, decisionId, -total, `${requested.token} buy including modeled fee`, timestamp]);
      } else {
        cashCents += notionalCents - actualFee;
        const remainingUnits = existingUnits - quantityUnits;
        const remainingBasis = remainingUnits ? Math.max(0, Number(existing.cost_basis_cents) - Math.floor(Number(existing.cost_basis_cents) * quantityUnits / existingUnits)) : 0;
        execute(db, `UPDATE positions SET units = ?, cost_basis_cents = ?, mark_cents = ?, updated_at = ? WHERE fund_id = ? AND token = ?`, [remainingUnits, remainingBasis, requested.priceCents, timestamp, decision.fundId, requested.token]);
        execute(db, `INSERT INTO cash_entries (id, fund_id, decision_id, entry_type, amount_cents, reason, created_at) VALUES (?, ?, ?, 'PAPER_SELL', ?, ?, ?)`, [id('cash'), decision.fundId, decisionId, notionalCents - actualFee, `${requested.token} sell including modeled fee`, timestamp]);
      }
      feeCents += actualFee;
      turnoverCents += notionalCents;
      execute(db, `INSERT INTO paper_orders (id, decision_id, fund_id, token, side, quantity_units, price_cents, notional_cents, fee_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id('order'), decisionId, decision.fundId, requested.token, requested.side, quantityUnits, requested.priceCents, notionalCents, actualFee, timestamp]);
      fills.push({ ...requested, quantityUnits, notionalCents, feeCents: actualFee });
    }

    for (const [token, quote] of Object.entries(quotes)) {
      execute(db, `INSERT INTO marks (id, fund_id, token, price_cents, observed_at, stale, source) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id('mark'), decision.fundId, token, quote.priceCents, quote.observedAt || timestamp, quote.ageSeconds > 600 ? 1 : 0, quote.source || 'observation']);
      execute(db, `UPDATE positions SET mark_cents = ?, updated_at = ? WHERE fund_id = ? AND token = ?`, [quote.priceCents, timestamp, decision.fundId, token]);
    }
    execute(db, 'UPDATE positions SET target_weight = 0 WHERE fund_id = ?', [decision.fundId]);
    for (const target of decision.target.targets || []) {
      execute(db, 'UPDATE positions SET target_weight = ? WHERE fund_id = ? AND token = ?', [target.targetWeight, decision.fundId, target.token]);
    }
    execute(db, 'UPDATE funds SET cash_cents = ?, current_cycle = ?, status = ?, updated_at = ? WHERE id = ?', [cashCents, decision.cycle, 'MONITORING', timestamp, decision.fundId]);
    const portfolio = getPortfolio(db, decision.fundId);
    const status = fills.length ? 'APPLIED' : 'NO_CHANGE';
    const costs = { feeCents, feeUsd: centsToUsd(feeCents), turnoverCents, turnoverUsd: centsToUsd(turnoverCents), navAfterCents: portfolio.navCents, navAfterUsd: portfolio.navUsd, fillCount: fills.length, fills };
    execute(db, 'UPDATE decisions SET status = ?, costs_json = ?, completed_at = ? WHERE id = ?', [status, JSON.stringify(costs), timestamp, decisionId]);
    return getDecision(db, decisionId);
  });
}
