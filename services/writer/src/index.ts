import { randomUUID } from 'node:crypto';
import {
  ackQueueIds,
  analyticsEventSchema,
  claimQueueBatch,
  failQueueIds,
  initSchema,
  openDb,
  reclaimStuckProcessing,
  toMssqlDto,
  type AnalyticsEvent,
  type MssqlBatchRequest,
} from '@mga/shared';

const POLL_MS = Number(process.env.MGA_WRITER_POLL_MS ?? 2000);
const BATCH_SIZE = Number(process.env.MGA_WRITER_BATCH_SIZE ?? 200);
const MAX_ATTEMPTS = Number(process.env.MGA_WRITER_MAX_ATTEMPTS ?? 5);
const MSSQL_API_URL =
  process.env.MGA_MSSQL_API_URL ?? 'http://localhost:7090/internal/analytics/events/batch';
const MSSQL_API_TOKEN = process.env.MGA_MSSQL_API_TOKEN ?? 'dev-token-change-me';

const db = openDb();
initSchema(db);

const reclaimed = reclaimStuckProcessing(db);
if (reclaimed > 0) {
  console.log(`[writer] reclaimed ${reclaimed} stuck processing queue row(s)`);
}

let backoffUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postBatch(batch: MssqlBatchRequest): Promise<{ ok: boolean; retryable: boolean; error?: string; status?: number }> {
  try {
    const res = await fetch(MSSQL_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MSSQL_API_TOKEN}`,
      },
      body: JSON.stringify(batch),
    });

    if (res.status === 200 || res.status === 204) {
      return { ok: true, retryable: false, status: res.status };
    }
    if (res.status === 400) {
      const text = await res.text();
      return { ok: false, retryable: false, error: `400 ${text}`, status: res.status };
    }
    if (res.status === 409) {
      return { ok: true, retryable: false, status: res.status };
    }
    if (res.status === 429 || res.status === 503 || res.status >= 500) {
      return { ok: false, retryable: true, error: `HTTP ${res.status}`, status: res.status };
    }
    return { ok: false, retryable: false, error: `HTTP ${res.status}`, status: res.status };
  } catch (err) {
    return { ok: false, retryable: true, error: String(err) };
  }
}

function applyBackoff(status?: number): void {
  const base = status === 429 ? 5000 : 2000;
  const jitter = Math.floor(Math.random() * 1000);
  backoffUntil = Date.now() + base + jitter;
}

async function processOnce(): Promise<void> {
  if (Date.now() < backoffUntil) return;

  const rows = claimQueueBatch(db, BATCH_SIZE);
  if (rows.length === 0) return;

  const events: AnalyticsEvent[] = [];
  const ids: number[] = [];

  for (const row of rows) {
    ids.push(row.id);
    try {
      const raw = JSON.parse(row.payload) as Record<string, unknown>;
      const { _ingest, ...rest } = raw;
      void _ingest;
      const parsed = analyticsEventSchema.safeParse(rest);
      if (parsed.success) events.push(parsed.data);
    } catch {
      /* skip malformed */
    }
  }

  if (events.length === 0) {
    ackQueueIds(db, ids);
    console.warn(`[writer] dropped ${ids.length} queue row(s): event schema parse failed`);
    return;
  }

  const batch: MssqlBatchRequest = {
    batch_id: randomUUID(),
    source: 'mga-writer',
    events: events.map(toMssqlDto),
  };

  const result = await postBatch(batch);
  if (result.ok) {
    ackQueueIds(db, ids);
    console.log(`[writer] flushed ${events.length} events (batch ${batch.batch_id})`);
    return;
  }

  failQueueIds(db, ids, result.error ?? 'unknown', MAX_ATTEMPTS);
  if (result.retryable) {
    applyBackoff(result.status);
    console.warn(`[writer] retryable failure: ${result.error}; backoff until ${new Date(backoffUntil).toISOString()}`);
  } else {
    console.error(`[writer] DLQ: ${result.error}`);
  }
}

console.log(`Writer polling every ${POLL_MS}ms -> ${MSSQL_API_URL}`);

async function loop(): Promise<void> {
  for (;;) {
    try {
      await processOnce();
    } catch (err) {
      console.error('[writer] process error (will retry):', err);
      applyBackoff(503);
    }
    await sleep(POLL_MS);
  }
}

void loop();
