import { createDatabase } from '../server/db/index.js';
import { ensurePolicy } from '../server/agent/evaluate.js';
import { config } from '../server/config.js';

const db = createDatabase();
ensurePolicy(db);
console.log(`Database ready: ${config.databasePath}`);
db.close();
