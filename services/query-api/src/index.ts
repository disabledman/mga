import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  getDlqCount,
  getProcessingDepth,
  getQueueDepth,
  initSchema,
  listDlq,
  openDb,
  purgeExpiredEvents,
  replayDlq,
} from '@mga/shared';

const PORT = Number(process.env.MGA_QUERY_PORT ?? 7100);
const MSSQL_API_URL = process.env.MGA_MSSQL_API_URL ?? 'http://localhost:7090';
const MSSQL_API_TOKEN = process.env.MGA_MSSQL_API_TOKEN ?? 'dev-token-change-me';
const ADMIN_TOKEN = process.env.MGA_ADMIN_TOKEN ?? 'admin-dev-token';

const db = openDb();
initSchema(db);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

function requireTenant(request: { headers: Record<string, unknown> }): string {
  return (request.headers['x-tenant-id'] as string) || 't_demo';
}

function requireAdmin(request: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }): boolean {
  const token = request.headers['x-admin-token'] as string | undefined;
  if (token !== ADMIN_TOKEN) {
    reply.code(401).send({ error: 'admin_unauthorized' });
    return false;
  }
  return true;
}

app.get('/health', async () => ({
  ok: true,
  queue_depth: getQueueDepth(db),
  processing_depth: getProcessingDepth(db),
  dlq_count: getDlqCount(db),
}));

app.get('/v1/reports/overview', async (request) => {
  const tenantId = requireTenant(request);
  const { site_id = 's_demo' } = request.query as { site_id?: string };
  const today = new Date().toISOString().slice(0, 10);

  const pvRow = db
    .prepare(
      `SELECT COALESCE(SUM(view_count), 0) AS total FROM daily_page_views
       WHERE tenant_id = ? AND site_id = ? AND stat_date = ?`
    )
    .get(tenantId, site_id, today) as { total: number };

  const clickRow = db
    .prepare(
      `SELECT COALESCE(SUM(click_count), 0) AS total FROM daily_clicks
       WHERE tenant_id = ? AND site_id = ? AND stat_date = ?`
    )
    .get(tenantId, site_id, today) as { total: number };

  const recent = db
    .prepare(
      `SELECT event_name, page_path, track_id, event_time_utc
       FROM event_raw
       WHERE tenant_id = ? AND site_id = ?
       ORDER BY event_time_utc DESC
       LIMIT 20`
    )
    .all(tenantId, site_id);

  return {
    tenant_id: tenantId,
    site_id,
    date: today,
    page_views_today: pvRow.total,
    clicks_today: clickRow.total,
    queue_depth: getQueueDepth(db),
    dlq_count: getDlqCount(db),
    recent_events: recent,
  };
});

app.get('/v1/reports/pages', async (request) => {
  const tenantId = requireTenant(request);
  const { site_id = 's_demo', days = '7' } = request.query as { site_id?: string; days?: string };
  const since = new Date();
  since.setDate(since.getDate() - Number(days));

  const rows = db
    .prepare(
      `SELECT page_path, SUM(view_count) AS views
       FROM daily_page_views
       WHERE tenant_id = ? AND site_id = ? AND stat_date >= ?
       GROUP BY page_path
       ORDER BY views DESC
       LIMIT 50`
    )
    .all(tenantId, site_id, since.toISOString().slice(0, 10));

  return { tenant_id: tenantId, site_id, pages: rows };
});

app.get('/v1/reports/clicks', async (request) => {
  const tenantId = requireTenant(request);
  const { site_id = 's_demo', days = '7' } = request.query as { site_id?: string; days?: string };
  const since = new Date();
  since.setDate(since.getDate() - Number(days));

  const rows = db
    .prepare(
      `SELECT track_id, SUM(click_count) AS clicks
       FROM daily_clicks
       WHERE tenant_id = ? AND site_id = ? AND stat_date >= ?
       GROUP BY track_id
       ORDER BY clicks DESC
       LIMIT 50`
    )
    .all(tenantId, site_id, since.toISOString().slice(0, 10));

  return { tenant_id: tenantId, site_id, clicks: rows };
});

app.get('/v1/reports/hourly', async (request) => {
  const tenantId = requireTenant(request);
  const { site_id = 's_demo' } = request.query as { site_id?: string };

  const rows = db
    .prepare(
      `SELECT stat_hour, page_views, clicks, custom_events
       FROM hourly_site_stats
       WHERE tenant_id = ? AND site_id = ?
       ORDER BY stat_hour DESC
       LIMIT 24`
    )
    .all(tenantId, site_id);

  return { tenant_id: tenantId, site_id, hourly: rows.reverse() };
});

app.get('/v1/privacy/visitors/:visitorId/export', async (request, reply) => {
  const tenantId = requireTenant(request);
  const { visitorId } = request.params as { visitorId: string };

  const res = await fetch(`${MSSQL_API_URL}/internal/analytics/visitors/${visitorId}/export`, {
    headers: { Authorization: `Bearer ${MSSQL_API_TOKEN}` },
  });
  if (!res.ok) {
    return reply.code(res.status).send({ error: 'export_failed' });
  }
  const data = (await res.json()) as { events: { tenant_id: string }[] };
  const filtered = data.events.filter((e) => e.tenant_id === tenantId);
  return { visitor_id: visitorId, tenant_id: tenantId, events: filtered };
});

app.delete('/v1/privacy/visitors/:visitorId', async (request, reply) => {
  requireTenant(request);
  const { visitorId } = request.params as { visitorId: string };

  const res = await fetch(`${MSSQL_API_URL}/internal/analytics/visitors/${visitorId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${MSSQL_API_TOKEN}` },
  });
  if (!res.ok) {
    return reply.code(res.status).send({ error: 'delete_failed' });
  }
  return res.json();
});

app.post('/v1/admin/purge', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const result = purgeExpiredEvents(db);
  return { ok: true, ...result };
});

app.get('/v1/admin/dlq', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const { limit = '50' } = request.query as { limit?: string };
  return { items: listDlq(db, Number(limit)) };
});

app.post('/v1/admin/dlq/replay', async (request, reply) => {
  if (!requireAdmin(request, reply)) return;
  const body = (request.body as { ids?: number[] }) ?? {};
  const count = replayDlq(db, body.ids);
  return { replayed: count };
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Query API on http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
