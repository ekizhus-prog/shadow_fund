import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';
import { createDatabase, queryAll } from '../server/db/index.js';

const db = createDatabase();
const calls = queryAll(db, 'SELECT * FROM api_calls ORDER BY fetched_at');
const output = path.join(config.root, 'data', `usage-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ projectId: config.projectId, budget: config.creditBudget, attempts: calls.length, chargedCredits: calls.reduce((sum, call) => sum + call.credits, 0), calls }, null, 2));
db.close();
console.log(`Usage export: ${output}`);
