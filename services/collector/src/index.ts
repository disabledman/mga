import Fastify from 'fastify';
import cors from '@fastify/cors';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anonymizeIp,
  collectPayloadSchema,
  enqueueEvents,
  extractClientIp,
  getProcessingDepth,
  getQueueDepth,
  hostMatchesAllowed,
  initSchema,
  isBotUserAgent,
  openDb,
  parseAllowedHosts,
  resolveCountryCode,
  resolveDbPath,
  type SiteConfig,
} from '@mga/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SDK_DIR = join(__dirname, '../../../packages/sdk/dist');
const SDK_PATH = join(SDK_DIR, 'tracker.js');
const SDK_MAP_PATH = join(SDK_DIR, 'tracker.js.map');
const DEMO_PATH = join(__dirname, '../../../examples/demo.html');

const PORT = Number(process.env.MGA_COLLECTOR_PORT ?? 7080);
const DB_PATH = resolveDbPath();
const db = openDb();
initSchema(db);

const siteStmt = db.prepare(`
  SELECT site_id, tenant_id, name, write_key, allowed_hosts, is_active
  FROM analytics_sites WHERE site_id = ? AND is_active = 1
`);

function loadSite(siteId: string): SiteConfig | null {
  const row = siteStmt.get(siteId) as
    | {
        site_id: string;
        tenant_id: string;
        name: string;
        write_key: string;
        allowed_hosts: string;
        is_active: number;
      }
    | undefined;
  if (!row) return null;
  return {
    site_id: row.site_id,
    tenant_id: row.tenant_id,
    name: row.name,
    write_key: row.write_key,
    allowed_hosts: parseAllowedHosts(row.allowed_hosts),
    is_active: Boolean(row.is_active),
  };
}

const demoSite = loadSite('s_demo');
console.log(`Collector DB: ${DB_PATH}`);
console.log(`Collector s_demo allowed_hosts: ${JSON.stringify(demoSite?.allowed_hosts ?? [])}`);

const ipRateMap = new Map<string, { count: number; resetAt: number }>();
const visitorRateMap = new Map<string, { count: number; resetAt: number }>();
const IP_RATE_LIMIT = Number(process.env.MGA_RATE_LIMIT_IP ?? 120);
const VISITOR_RATE_LIMIT = Number(process.env.MGA_RATE_LIMIT_VISITOR ?? 60);
const RATE_WINDOW_MS = 60_000;

function checkRate(map: Map<string, { count: number; resetAt: number }>, key: string, limit: number): boolean {
  const now = Date.now();
  let entry = map.get(key);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    map.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= limit;
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: true,
  methods: ['POST', 'OPTIONS', 'GET'],
});

app.get('/health', async () => {
  const site = loadSite('s_demo');
  const allowed = site?.allowed_hosts ?? [];
  return {
    ok: true,
    db_path: DB_PATH,
    queue_depth: getQueueDepth(db),
    processing_depth: getProcessingDepth(db),
    demo_allowed_hosts: allowed,
    demo_host_checks: {
      '192.168.10.7': hostMatchesAllowed('192.168.10.7', allowed),
      '127.0.0.1': hostMatchesAllowed('127.0.0.1', allowed),
    },
  };
});

app.get('/sdk/tracker.js', async (_request, reply) => {
  try {
    const js = await readFile(SDK_PATH, 'utf8');
    return reply.type('application/javascript').send(js);
  } catch {
    return reply.code(404).send({ error: 'sdk_not_built', hint: 'npm run build -w @mga/sdk' });
  }
});

app.get('/sdk/tracker.js.map', async (_request, reply) => {
  try {
    const map = await readFile(SDK_MAP_PATH, 'utf8');
    return reply.type('application/json').send(map);
  } catch {
    return reply.code(404).send();
  }
});

app.get('/demo.html', async (_request, reply) => {
  try {
    const html = await readFile(DEMO_PATH, 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  } catch {
    return reply.code(404).send({ error: 'demo_not_found' });
  }
});

app.post('/v1/collect', async (request, reply) => {
  const parsed = collectPayloadSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
  }

  const { site_id, write_key, events } = parsed.data;
  const site = loadSite(site_id);
  if (!site || site.write_key !== write_key) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const originHeader = request.headers.origin as string | undefined;
  const origin =
    originHeader && originHeader !== 'null'
      ? originHeader
      : (request.headers.referer as string) || '';
  let host = '';
  try {
    host = origin ? new URL(origin).hostname : '';
  } catch {
    host = '';
  }
  if (host && !hostMatchesAllowed(host, site.allowed_hosts)) {
    request.log.warn(
      { host, allowed_hosts: site.allowed_hosts, db_path: DB_PATH },
      'origin_not_allowed'
    );
    return reply.code(403).send({ error: 'origin_not_allowed', host, allowed_hosts: site.allowed_hosts });
  }

  const rawIp = extractClientIp(request.headers, request.ip);
  const clientIp = anonymizeIp(rawIp);
  const rateIpKey = `${site_id}:ip:${clientIp ?? 'unknown'}`;
  if (!checkRate(ipRateMap, rateIpKey, IP_RATE_LIMIT)) {
    return reply.code(429).send({ error: 'rate_limited', scope: 'ip' });
  }

  const countryCode = resolveCountryCode(request.headers);

  const accepted = events.filter((e) => {
    if (isBotUserAgent(e.user_agent)) return false;
    const vKey = `${site_id}:vid:${e.visitor_id}`;
    if (!checkRate(visitorRateMap, vKey, VISITOR_RATE_LIMIT)) return false;
    return true;
  });

  if (accepted.length === 0) {
    return reply.code(204).send();
  }

  const enriched = accepted.map((e) => ({
    ...e,
    tenant_id: site.tenant_id,
    site_id: site.site_id,
    country: countryCode ?? e.country,
    client_ip: rawIp,
    _ingest: { received_at: new Date().toISOString() },
  }));

  enqueueEvents(db, enriched);
  request.log.info(
    { site_id, count: accepted.length, queue_depth: getQueueDepth(db) },
    'collect accepted'
  );
  return reply.code(204).send();
});

app.post('/v1/collect/beacon', async (request, reply) => {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/collect',
    payload: request.body as object,
    headers: request.headers,
  });
  return reply.code(res.statusCode).send(res.body || null);
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Collector listening on http://localhost:${PORT}`);
  console.log(`Demo page: http://localhost:${PORT}/demo.html`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
