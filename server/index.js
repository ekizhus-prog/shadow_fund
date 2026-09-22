import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { config } from './config.js';
import { createDatabase, execute, id, now, queryAll, queryOne } from './db/index.js';
import { createFund, getDecision, getFundSnapshot } from './domain/ledger.js';
import { buildTargetAllocation, POLICY_VERSION } from './domain/policy.js';
import { usdToCents } from './domain/money.js';
import { runEvaluation } from './agent/evaluate.js';
import { MARKET_CAP_RANGE, getAssetUniverse } from './domain/universe.js';

const db = createDatabase();
const webRoot = path.join(config.root, 'web');

function json(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  response.end(JSON.stringify(payload));
}

function text(response, status, payload, contentType) {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function mime(filePath) {
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' })[path.extname(filePath)] || 'application/octet-stream';
}

function serveStatic(response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(webRoot, relative);
  if (!filePath.startsWith(path.resolve(webRoot))) return text(response, 403, 'Forbidden', 'text/plain');
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return text(response, 404, 'Not found', 'text/plain');
  return text(response, 200, fs.readFileSync(filePath), mime(filePath));
}

function targetSignature(target) {
  return JSON.stringify({
    preset: target.preset,
    cashWeight: target.cashWeight,
    totalWeight: target.totalWeight,
    targets: (target.targets || []).map((item) => ({ token: item.token, rawWeight: item.rawWeight, targetWeight: item.targetWeight, priceCents: item.quote?.priceCents })),
    selectedSources: (target.sourceSelection?.selected || []).map((source) => ({ id: source.id, influence: source.influence, sourceScore: source.sourceScore }))
  });
}

function queueEvaluation(fundId) {
  const jobId = id('job');
  execute(db, `INSERT INTO jobs (id, fund_id, stage, status, progress, message, created_at, updated_at) VALUES (?, ?, 'SCHEDULED', 'QUEUED', 0, ?, ?, ?)`, [jobId, fundId, 'Waiting for evaluation worker', now(), now()]);
  setImmediate(() => runEvaluation(db, { fundId, jobId, dataMode: config.dataMode }).catch((error) => console.error(`[evaluation ${jobId}] ${error.message}`)));
  return jobId;
}

async function handleApi(request, response, url) {
  if (request.method === 'OPTIONS') return json(response, 204, {});
  if (request.method === 'GET' && url.pathname === '/healthz') return json(response, 200, { ok: true, service: 'shadow-fund', dataMode: config.dataMode, time: now() });
  if (request.method === 'GET' && url.pathname === '/api/admin/usage') {
    const usage = queryOne(db, `SELECT COUNT(*) AS attempts, COALESCE(SUM(credits), 0) AS credits FROM api_calls`);
    return json(response, 200, { ...usage, budget: config.creditBudget });
  }
  if (request.method === 'GET' && url.pathname === '/api/options') {
    return json(response, 200, {
      chains: config.nansenChains,
      marketCapRange: MARKET_CAP_RANGE,
      maxTargets: 5,
      analysisTokenLimit: Math.max(1, Math.min(config.nansenMaxTokens, 250)),
      runCreditLimit: config.runCreditLimit,
      demoFullLanes: config.demoFullLanes,
      note: config.demoFullLanes
        ? 'Demo mode: a selected universe of up to 20 tokens runs Token Screener, Flow Intelligence, Buyer/Sold, and DEX Trades for every token, then opens the profiler lanes for returned wallets.'
        : 'Every returned token is screened. The run budget determines how many token-specific lanes can be added without exhausting the configured credit limit; the final paper portfolio contains at most five targets.'
    });
  }
  if (request.method === 'POST' && url.pathname === '/api/funds') {
    const body = await readBody(request);
    const preset = ['Conservative', 'Balanced', 'Risky', 'Exploratory'].includes(body.preset) ? body.preset : 'Balanced';
    const requestedChain = String(body.chain || 'multi').toLowerCase();
    const chain = requestedChain === 'multi' ? 'multi' : config.nansenChains.includes(requestedChain) ? requestedChain : config.nansenChains[0];
    const assetUniverse = getAssetUniverse(body.assetUniverse).id;
    const initialCashCents = usdToCents(body.initialCash ?? '100000');
    if (initialCashCents < 100_000 || initialCashCents > 10_000_000_00) throw new Error('Virtual capital must be between $1,000 and $10,000,000');
    const fundId = createFund(db, { initialCashCents, preset, chain: config.dataMode === 'live' ? chain : 'base', assetUniverse, dataMode: config.dataMode, policyVersion: POLICY_VERSION });
    return json(response, 201, { fundId, snapshot: getFundSnapshot(db, fundId) });
  }
  const fundMatch = url.pathname.match(/^\/api\/funds\/([^/]+)$/);
  if (request.method === 'GET' && fundMatch) {
    const snapshot = getFundSnapshot(db, fundMatch[1]);
    return snapshot ? json(response, 200, snapshot) : json(response, 404, { error: 'Fund not found' });
  }
  const evaluateMatch = url.pathname.match(/^\/api\/funds\/([^/]+)\/evaluate$/);
  if (request.method === 'POST' && evaluateMatch) {
    if (!queryOne(db, 'SELECT id FROM funds WHERE id = ?', [evaluateMatch[1]])) return json(response, 404, { error: 'Fund not found' });
    const jobId = queueEvaluation(evaluateMatch[1]);
    return json(response, 202, { jobId });
  }
  const decisionsMatch = url.pathname.match(/^\/api\/funds\/([^/]+)\/decisions$/);
  if (request.method === 'GET' && decisionsMatch) {
    const snapshot = getFundSnapshot(db, decisionsMatch[1]);
    return snapshot ? json(response, 200, { fundId: decisionsMatch[1], decisions: snapshot.decisions }) : json(response, 404, { error: 'Fund not found' });
  }
  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (request.method === 'GET' && jobMatch) {
    const job = queryOne(db, 'SELECT * FROM jobs WHERE id = ?', [jobMatch[1]]);
    return job ? json(response, 200, job) : json(response, 404, { error: 'Job not found' });
  }
  const decisionMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)$/);
  if (request.method === 'GET' && decisionMatch) {
    const decision = getDecision(db, decisionMatch[1]);
    return decision ? json(response, 200, decision) : json(response, 404, { error: 'Decision not found' });
  }
  const replayMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)\/replay$/);
  if (request.method === 'POST' && replayMatch) {
    const decision = getDecision(db, replayMatch[1]);
    if (!decision) return json(response, 404, { error: 'Decision not found' });
    const observation = queryOne(db, 'SELECT * FROM observations WHERE id = ?', [decision.observationId]);
    if (!observation) return json(response, 409, { error: 'Original observation bundle is unavailable' });
    const bundle = JSON.parse(observation.bundle_json);
    const fund = queryOne(db, 'SELECT * FROM funds WHERE id = ?', [decision.fundId]);
    const replayTarget = buildTargetAllocation(bundle, fund.preset);
    const sameTarget = targetSignature(replayTarget) === targetSignature(decision.target);
    return json(response, 200, { mode: 'RECORDED_REPLAY', originalDecisionId: decision.id, originalEventCutoff: bundle.eventCutoff, sourceHash: bundle.sourceHash, sameTarget, target: replayTarget, note: 'Read-only recomputation from the stored observation bundle.' });
  }
  return json(response, 404, { error: 'Not found' });
}

async function handler(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return await handleApi(request, response, url);
    if (request.method !== 'GET') return text(response, 405, 'Method not allowed', 'text/plain');
    return serveStatic(response, url.pathname);
  } catch (error) {
    console.error(error);
    return json(response, error.message.startsWith('Invalid') ? 400 : 500, { error: error.message });
  }
}

const appServer = http.createServer(handler);
appServer.listen(config.appPort, '127.0.0.1', () => console.log(`Shadow Fund web: http://127.0.0.1:${config.appPort}`));
if (config.apiPort !== config.appPort) {
  http.createServer(handler).listen(config.apiPort, '127.0.0.1', () => console.log(`Shadow Fund API: http://127.0.0.1:${config.apiPort}`));
}

process.on('SIGINT', () => { db.close(); appServer.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); appServer.close(); process.exit(0); });
