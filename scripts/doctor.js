import fs from 'node:fs';
import { createDatabase } from '../server/db/index.js';
import { config } from '../server/config.js';

const major = Number(process.versions.node.split('.')[0]);
const required = ['package.json', 'server/index.js', 'server/db/schema.sql', 'web/index.html', '.env.example'];
const missing = required.filter((file) => !fs.existsSync(`${config.root}/${file}`));
if (major < 24) throw new Error(`Node 24+ is required; found ${process.version}`);
if (missing.length) throw new Error(`Missing required files: ${missing.join(', ')}`);
const db = createDatabase();
const tableCount = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table'").get().count;
db.close();
console.log(JSON.stringify({ ok: true, node: process.version, database: config.databasePath, tables: tableCount, dataMode: config.dataMode }, null, 2));
