import fs from 'node:fs';
import dns from 'node:dns';
import path from 'node:path';
import process from 'node:process';

// Some Windows environments advertise an unreachable IPv6 route for api.nansen.ai.
// Prefer IPv4 so the server can fall back deterministically like curl does.
dns.setDefaultResultOrder('ipv4first');

const root = process.cwd();

function loadDotEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const numberEnv = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const listEnv = (name, fallback) => {
  const values = String(process.env[name] || fallback).split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return [...new Set(values)].slice(0, 5);
};

export const config = Object.freeze({
  root,
  appPort: numberEnv('APP_PORT', 8312),
  apiPort: numberEnv('API_PORT', 8412),
  databasePath: path.resolve(root, process.env.DATABASE_PATH || './data/shadow-fund.sqlite'),
  dataMode: process.env.DATA_MODE || 'synthetic',
  nansenApiKey: process.env.NANSEN_API_KEY || '',
  projectId: process.env.PROJECT_ID || 'shadow-fund',
  creditBudget: numberEnv('NANSEN_CREDIT_BUDGET', 2500),
  runCreditLimit: numberEnv('NANSEN_RUN_CREDIT_LIMIT', 150),
  nansenChains: listEnv('NANSEN_CHAINS', 'ethereum,base,solana,arbitrum'),
  nansenMaxTokens: numberEnv('NANSEN_MAX_TOKENS', 250),
  nansenMaxWallets: numberEnv('NANSEN_MAX_WALLETS', 6),
  nansenConcurrency: Math.max(1, Math.min(numberEnv('NANSEN_CONCURRENCY', 2), 3)),
  demoFullLanes: process.env.NANSEN_DEMO_FULL_LANES === 'true',
  enableLlm: process.env.ENABLE_LLM === 'true',
  workerIntervalMs: numberEnv('WORKER_INTERVAL_MS', 6 * 60 * 60 * 1000),
  workerOnce: process.env.WORKER_ONCE === 'true'
});
