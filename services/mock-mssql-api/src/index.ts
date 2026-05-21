import Fastify from 'fastify';
import {
  initSchema,
  mssqlBatchRequestSchema,
  openDb,
  withTransaction,
  type MssqlEventDto,
} from '@mga/shared';

const PORT = Number(process.env.MGA_MSSQL_API_PORT ?? 7090);
const API_TOKEN = process.env.MGA_MSSQL_API_TOKEN ?? 'dev-token-change-me';

const db = openDb();
initSchema(db);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO event_raw (
    event_id, tenant_id, site_id, event_name, event_time_utc,
    session_id, visitor_id, page_url, page_path, referrer,
    user_agent, device_type, browser, os, country_code,
    track_id, properties_json, consent_granted
  ) VALUES (
    @event_id, @tenant_id, @site_id, @event_name, @event_time_utc,
    @session_id, @visitor_id, @page_url, @page_path, @referrer,
    @user_agent, @device_type, @browser, @os, @country_code,
    @track_id, @properties_json, @consent_granted
  )
`);

const upsertPageView = db.prepare(`
  INSERT INTO daily_page_views (stat_date, tenant_id, site_id, page_path, view_count)
  VALUES (@stat_date, @tenant_id, @site_id, @page_path, 1)
  ON CONFLICT(stat_date, tenant_id, site_id, page_path)
  DO UPDATE SET view_count = view_count + 1
`);

const upsertClick = db.prepare(`
  INSERT INTO daily_clicks (stat_date, tenant_id, site_id, track_id, click_count)
  VALUES (@stat_date, @tenant_id, @site_id, @track_id, 1)
  ON CONFLICT(stat_date, tenant_id, site_id, track_id)
  DO UPDATE SET click_count = click_count + 1
`);

const upsertHourly = db.prepare(`
  INSERT INTO hourly_site_stats (stat_hour, tenant_id, site_id, page_views, clicks, custom_events)
  VALUES (@stat_hour, @tenant_id, @site_id, @pv, @cl, @cu)
  ON CONFLICT(stat_hour, tenant_id, site_id)
  DO UPDATE SET
    page_views = page_views + @pv,
    clicks = clicks + @cl,
    custom_events = custom_events + @cu
`);

function statDate(iso: string): string {
  return iso.slice(0, 10);
}

function statHour(iso: string): string {
  return iso.slice(0, 13) + ':00:00';
}

function aggregateEvent(ev: MssqlEventDto): void {
  const date = statDate(ev.event_time_utc);
  const hour = statHour(ev.event_time_utc);

  let pv = 0;
  let cl = 0;
  let cu = 0;
  if (ev.event_name === 'page_view') pv = 1;
  else if (ev.event_name === 'click' || ev.event_name === 'outbound_click') cl = 1;
  else if (ev.event_name.startsWith('custom:')) cu = 1;

  upsertHourly.run({
    stat_hour: hour,
    tenant_id: ev.tenant_id,
    site_id: ev.site_id,
    pv,
    cl,
    cu,
  });

  if (ev.event_name === 'page_view' && ev.page_path) {
    upsertPageView.run({
      stat_date: date,
      tenant_id: ev.tenant_id,
      site_id: ev.site_id,
      page_path: ev.page_path,
    });
  }

  const trackId = resolveTrackId(ev);
  const countsAsClick =
    ev.event_name === 'click' ||
    ev.event_name === 'outbound_click' ||
    ev.event_name.startsWith('custom:');
  if (countsAsClick && trackId) {
    upsertClick.run({
      stat_date: date,
      tenant_id: ev.tenant_id,
      site_id: ev.site_id,
      track_id: trackId,
    });
  }
}

function resolveTrackId(ev: MssqlEventDto): string | undefined {
  if (ev.track_id) return ev.track_id;
  if (!ev.properties_json) return undefined;
  try {
    const props = JSON.parse(ev.properties_json) as { track_id?: string };
    return typeof props.track_id === 'string' ? props.track_id : undefined;
  } catch {
    return undefined;
  }
}

function mapRow(ev: MssqlEventDto) {
  return {
    event_id: ev.event_id,
    tenant_id: ev.tenant_id,
    site_id: ev.site_id,
    event_name: ev.event_name,
    event_time_utc: ev.event_time_utc,
    session_id: ev.session_id,
    visitor_id: ev.visitor_id,
    page_url: ev.page_url ?? null,
    page_path: ev.page_path ?? null,
    referrer: ev.referrer ?? null,
    user_agent: ev.user_agent ?? null,
    device_type: ev.device_type ?? null,
    browser: ev.browser ?? null,
    os: ev.os ?? null,
    country_code: ev.country_code ?? null,
    track_id: ev.track_id ?? null,
    properties_json: ev.properties_json ?? null,
    consent_granted: ev.consent_granted ? 1 : 0,
  };
}

const app = Fastify({ logger: true });

app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;
  const auth = request.headers.authorization;
  if (auth !== `Bearer ${API_TOKEN}`) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
});

app.get('/health', async () => ({ ok: true, service: 'mock-mssql-api' }));

app.post('/internal/analytics/events/batch', async (request, reply) => {
  const parsed = mssqlBatchRequestSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_batch', details: parsed.error.flatten() });
  }

  let accepted = 0;
  let duplicates = 0;

  withTransaction(db, () => {
    for (const ev of parsed.data.events) {
      const info = insertEvent.run(mapRow(ev));
      if (info.changes > 0) {
        accepted += 1;
        aggregateEvent(ev);
      } else {
        duplicates += 1;
      }
    }
  });
  return { accepted, duplicates, batch_id: parsed.data.batch_id };
});

app.post('/internal/analytics/events/dedupe-check', async (request) => {
  const body = request.body as { event_ids?: string[] };
  const ids = body.event_ids ?? [];
  if (ids.length === 0) return { existing: [] };
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT event_id FROM event_raw WHERE event_id IN (${placeholders})`)
    .all(...ids) as { event_id: string }[];
  return { existing: rows.map((r) => r.event_id) };
});

app.get('/internal/analytics/visitors/:visitorId/export', async (request) => {
  const { visitorId } = request.params as { visitorId: string };
  const rows = db
    .prepare(
      `SELECT event_id, tenant_id, site_id, event_name, event_time_utc, session_id, visitor_id,
              page_path, track_id, properties_json, consent_granted, ingested_at_utc
       FROM event_raw WHERE visitor_id = ? ORDER BY event_time_utc ASC`
    )
    .all(visitorId);
  return { visitor_id: visitorId, events: rows };
});

app.delete('/internal/analytics/visitors/:visitorId', async (request) => {
  const { visitorId } = request.params as { visitorId: string };
  const anon = 'deleted-' + visitorId.slice(0, 8);
  const result = db
    .prepare(`UPDATE event_raw SET visitor_id = ?, properties_json = NULL WHERE visitor_id = ?`)
    .run(anon, visitorId);
  return { anonymized: result.changes };
});

app.post('/internal/analytics/aggregate/run', async () => {
  return { ok: true, message: 'aggregates updated inline on ingest' };
});

try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`Mock MSSQL API on http://localhost:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
