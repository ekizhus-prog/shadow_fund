import { config } from './config.js';
import { createDatabase, execute, id, now, queryAll } from './db/index.js';
import { runEvaluation } from './agent/evaluate.js';

const db = createDatabase();

async function runOnce() {
  const funds = queryAll(db, `SELECT * FROM funds WHERE status IN ('READY', 'MONITORING') ORDER BY updated_at`);
  for (const fund of funds) {
    const jobId = id('job');
    execute(db, `INSERT INTO jobs (id, fund_id, stage, status, progress, message, created_at, updated_at) VALUES (?, ?, 'SCHEDULED', 'QUEUED', 0, ?, ?, ?)`, [jobId, fund.id, 'Scheduled collection', now(), now()]);
    try { await runEvaluation(db, { fundId: fund.id, jobId, dataMode: config.dataMode }); }
    catch (error) { console.error(`[worker] ${fund.id}: ${error.message}`); }
  }
}

await runOnce();
if (!config.workerOnce) {
  console.log(`[worker] polling every ${config.workerIntervalMs}ms`);
  setInterval(() => runOnce().catch((error) => console.error('[worker]', error)), config.workerIntervalMs);
} else {
  db.close();
}
