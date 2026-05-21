import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const sharedDist = join(projectRoot, 'packages', 'shared', 'dist', 'index.js');

if (!existsSync(sharedDist)) {
  console.error('找不到 packages/shared/dist/index.js');
  console.error('請在 mga 專案根目錄執行，且先 build shared：');
  console.error('  cd <mga 專案目錄>');
  console.error('  npm run build -w @mga/shared');
  console.error('  npm run diag:queue');
  process.exit(1);
}

const { openDb, reclaimStuckProcessing, resolveDbPath } = await import(pathToFileURL(sharedDist).href);

const reset = process.argv.includes('--reset');

const db = openDb();
console.log('db:', resolveDbPath());
console.log('by status:', db.prepare('SELECT status, COUNT(*) c FROM event_queue GROUP BY status').all());
console.log('pending:', db.prepare("SELECT COUNT(*) c FROM event_queue WHERE status='pending'").get());
console.log('processing:', db.prepare("SELECT COUNT(*) c FROM event_queue WHERE status='processing'").get());
const site = db.prepare('SELECT allowed_hosts FROM analytics_sites WHERE site_id = ?').get('s_demo');
console.log('allowed_hosts:', site?.allowed_hosts);
const rawCount = db.prepare('SELECT COUNT(*) c FROM event_raw').get();
console.log('event_raw count:', rawCount?.c);

if (reset) {
  const reclaimed = reclaimStuckProcessing(db);
  console.log(`Reclaimed ${reclaimed} stuck processing row(s)`);
}
