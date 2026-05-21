import type { MgaDatabase } from './db.js';

const DEFAULT_RETENTION_DAYS = Number(process.env.MGA_RETENTION_DAYS ?? 395);

export function purgeExpiredEvents(db: MgaDatabase, retentionDays = DEFAULT_RETENTION_DAYS): {
  deleted_raw: number;
  deleted_queue: number;
} {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();

  const raw = db.prepare(`DELETE FROM event_raw WHERE event_time_utc < ?`).run(cutoffIso);

  const staleQueue = db
    .prepare(`DELETE FROM event_queue WHERE created_at < datetime(?, '-7 days')`)
    .run(cutoffIso.slice(0, 10));

  return {
    deleted_raw: Number(raw.changes),
    deleted_queue: Number(staleQueue.changes),
  };
}
