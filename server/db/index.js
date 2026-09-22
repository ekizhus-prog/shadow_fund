import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

export function createDatabase(databasePath = config.databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const schemaPath = path.join(config.root, 'server', 'db', 'schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  // Existing demo databases predate the user-selectable market-cap universe.
  // Keep them readable while adding the new setting without destructive work.
  try { db.exec("ALTER TABLE funds ADD COLUMN asset_universe TEXT NOT NULL DEFAULT 'top50'"); } catch (error) {
    if (!String(error.message || '').toLowerCase().includes('duplicate column name')) throw error;
  }
  return db;
}

export const now = () => new Date().toISOString();
export const id = (prefix) => `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
export const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function queryOne(db, sql, params = []) {
  return db.prepare(sql).get(...params) || null;
}

export function queryAll(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

export function execute(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
