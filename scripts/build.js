import fs from 'node:fs';
import path from 'node:path';
import { config } from '../server/config.js';

const dist = path.join(config.root, 'dist');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(config.root, 'web'), dist, { recursive: true });
console.log(`Static web build copied to ${dist}`);
