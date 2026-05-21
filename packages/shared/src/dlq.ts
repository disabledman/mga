import { withTransaction, type MgaDatabase } from './db.js';

export function getDlqCount(db: MgaDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM event_dlq`).get() as { c: number };
  return row.c;
}

export function listDlq(db: MgaDatabase, limit = 100): { id: number; payload: string; error: string; created_at: string }[] {
  return db
    .prepare(`SELECT id, payload, error, created_at FROM event_dlq ORDER BY id DESC LIMIT ?`)
    .all(limit) as { id: number; payload: string; error: string; created_at: string }[];
}

/** Re-enqueue DLQ rows for writer retry (admin). */
export function replayDlq(db: MgaDatabase, ids?: number[]): number {
  const rows = ids?.length
    ? (db
        .prepare(`SELECT id, payload FROM event_dlq WHERE id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as { id: number; payload: string }[])
    : (db.prepare(`SELECT id, payload FROM event_dlq ORDER BY id ASC`).all() as {
        id: number;
        payload: string;
      }[]);

  if (rows.length === 0) return 0;

  const insert = db.prepare(`INSERT INTO event_queue (payload, status) VALUES (?, 'pending')`);
  const del = db.prepare(`DELETE FROM event_dlq WHERE id = ?`);

  withTransaction(db, () => {
    for (const row of rows) {
      insert.run(row.payload);
      del.run(row.id);
    }
  });
  return rows.length;
}
