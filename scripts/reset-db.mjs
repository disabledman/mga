import { existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDbPath } from '../packages/shared/dist/index.js';

const dbPath = resolveDbPath();
const files = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];

let removed = 0;
for (const file of files) {
  if (!existsSync(file)) continue;
  try {
    unlinkSync(file);
    console.log('Deleted:', file);
    removed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to delete ${file}: ${msg}`);
    console.error('Stop all MGA services (npm run dev / PM2) so SQLite is not locked, then retry.');
    process.exit(1);
  }
}

if (removed === 0) {
  console.log('No database files found at:', dbPath);
}

const initScript = join(dirname(fileURLToPath(import.meta.url)), 'init-db.mjs');
const result = spawnSync(process.execPath, [initScript], {
  stdio: 'inherit',
  env: process.env,
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log('Database reset complete. Restart collector/writer/query/dashboard to resume recording.');
