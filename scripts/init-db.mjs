import { networkInterfaces } from 'node:os';
import { initSchema, openDb, parseAllowedHosts, reclaimStuckProcessing } from '../packages/shared/dist/index.js';

const LAN_HOST_PATTERNS = ['192.168.*', '10.*', '172.*'];

function localIpv4Addresses() {
  const ips = new Set();
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.add(net.address);
      }
    }
  }
  return [...ips];
}

function mergeAllowedHosts(existing) {
  const hosts = parseAllowedHosts(existing);
  const add = (value) => {
    if (!hosts.includes(value)) hosts.push(value);
  };
  for (const pattern of LAN_HOST_PATTERNS) add(pattern);
  for (const ip of localIpv4Addresses()) add(ip);
  const extra = process.env.MGA_DEMO_ALLOWED_HOSTS;
  if (extra) {
    for (const item of extra.split(',').map((s) => s.trim()).filter(Boolean)) add(item);
  }
  return JSON.stringify(hosts);
}

const db = openDb();
initSchema(db);

const site = db.prepare('SELECT allowed_hosts FROM analytics_sites WHERE site_id = ?').get('s_demo');
if (site) {
  const merged = mergeAllowedHosts(site.allowed_hosts);
  if (merged !== site.allowed_hosts) {
    db.prepare('UPDATE analytics_sites SET allowed_hosts = ? WHERE site_id = ?').run(merged, 's_demo');
    console.log('Updated s_demo allowed_hosts:', merged);
  } else {
    console.log('s_demo allowed_hosts already up to date:', site.allowed_hosts);
  }
}

const reclaimed = reclaimStuckProcessing(db);
if (reclaimed > 0) {
  console.log(`Reclaimed ${reclaimed} stuck processing queue row(s)`);
}

console.log('Local IPv4 added for collect origin check:', localIpv4Addresses().join(', ') || '(none)');
console.log('Database initialized:', process.env.MGA_DB_PATH ?? '(default mga/data/mga.db)');
