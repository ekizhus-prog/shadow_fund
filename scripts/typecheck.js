import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : full.endsWith('.js') ? [full] : [];
  });
}
const targets = [...files('server'), ...files('scripts'), ...files('tests'), 'web/app.js'];
for (const target of targets) {
  const result = spawnSync(process.execPath, ['--check', target], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax check passed for ${targets.length} JavaScript files.`);
