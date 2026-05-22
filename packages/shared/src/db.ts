import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Walk up from module location (works from packages/shared/dist or node_modules/@mga/shared/dist). */
export function findMgaProjectRoot(startDir = __dirname): string {
  let dir = resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'mga') return dir;
      } catch {
        /* try parent */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(startDir, '../../..');
}

export const PROJECT_ROOT = findMgaProjectRoot();
export const DEFAULT_DB_PATH = resolve(PROJECT_ROOT, 'data/mga.db');

/** Resolve MGA_DB_PATH relative to project root so all services share one DB. */
export function resolveDbPath(): string {
  const raw = process.env.MGA_DB_PATH;
  if (!raw) return DEFAULT_DB_PATH;
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) {
    return resolve(raw);
  }
  return resolve(PROJECT_ROOT, raw);
}

export type MgaDatabase = DatabaseSync;

const DEFAULT_BUSY_MS = 10_000;

function isSqliteBusy(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; errcode?: number; message?: string };
  return (
    e.errcode === 5 ||
    e.code === 'SQLITE_BUSY' ||
    (e.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(String(e.message ?? '')))
  );
}

function syncSleep(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* wait for lock holder */
  }
}

export function openDb(dbPath = resolveDbPath()): MgaDatabase {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  const busyMs = Number(process.env.MGA_DB_BUSY_MS ?? DEFAULT_BUSY_MS);
  if (Number.isFinite(busyMs) && busyMs > 0) {
    db.exec(`PRAGMA busy_timeout = ${Math.floor(busyMs)}`);
  }
  return db;
}

export function withTransaction(db: MgaDatabase, fn: () => void): void {
  const maxRetries = Number(process.env.MGA_DB_TX_RETRIES ?? 8);
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        fn();
        db.exec('COMMIT');
        return;
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* connection may already be rolled back */
        }
        throw err;
      }
    } catch (err) {
      if (!isSqliteBusy(err) || attempt >= maxRetries) throw err;
      syncSleep(25 * Math.pow(2, attempt) + Math.floor(Math.random() * 25));
    }
  }
}

function migrateEventRawColumns(db: MgaDatabase): void {
  const columns = db.prepare(`PRAGMA table_info(event_raw)`).all() as { name: string }[];
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('client_ip')) {
    db.exec(`ALTER TABLE event_raw ADD COLUMN client_ip TEXT`);
  }
}

export function initSchema(db: MgaDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_queue_status ON event_queue(status, id);

    CREATE TABLE IF NOT EXISTS event_dlq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      error TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS analytics_sites (
      site_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      write_key TEXT NOT NULL UNIQUE,
      allowed_hosts TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS event_raw (
      event_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_time_utc TEXT NOT NULL,
      session_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      page_url TEXT,
      page_path TEXT,
      referrer TEXT,
      user_agent TEXT,
      device_type TEXT,
      browser TEXT,
      os TEXT,
      country_code TEXT,
      client_ip TEXT,
      track_id TEXT,
      properties_json TEXT,
      consent_granted INTEGER NOT NULL DEFAULT 0,
      ingested_at_utc TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_raw_site_time
      ON event_raw(tenant_id, site_id, event_time_utc DESC);

    CREATE TABLE IF NOT EXISTS daily_page_views (
      stat_date TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      page_path TEXT NOT NULL,
      view_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stat_date, tenant_id, site_id, page_path)
    );

    CREATE TABLE IF NOT EXISTS daily_clicks (
      stat_date TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      click_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stat_date, tenant_id, site_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS hourly_site_stats (
      stat_hour TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      site_id TEXT NOT NULL,
      page_views INTEGER NOT NULL DEFAULT 0,
      clicks INTEGER NOT NULL DEFAULT 0,
      custom_events INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (stat_hour, tenant_id, site_id)
    );
  `);

  migrateEventRawColumns(db);

  const count = db.prepare('SELECT COUNT(*) AS c FROM analytics_sites').get() as { c: number };
  if (count.c === 0) {
    db.prepare(`
      INSERT INTO analytics_sites (site_id, tenant_id, name, write_key, allowed_hosts, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(
      's_demo',
      't_demo',
      'Demo Site',
      'wk_demo_change_in_production',
      JSON.stringify(['localhost', '127.0.0.1', '*.localhost', '192.168.*', '10.*'])
    );
  }
}

export function reclaimStuckProcessing(db: MgaDatabase): number {
  const result = db
    .prepare(`UPDATE event_queue SET status = 'pending' WHERE status = 'processing'`)
    .run();
  return Number(result.changes);
}

export function getProcessingDepth(db: MgaDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM event_queue WHERE status = 'processing'`).get() as {
    c: number;
  };
  return row.c;
}

export function enqueueEvents(db: MgaDatabase, events: unknown[]): number {
  const insert = db.prepare(`INSERT INTO event_queue (payload, status) VALUES (?, 'pending')`);
  withTransaction(db, () => {
    for (const item of events) {
      insert.run(JSON.stringify(item));
    }
  });
  return events.length;
}

export function claimQueueBatch(db: MgaDatabase, limit: number): { id: number; payload: string }[] {
  const select = db.prepare(`
    SELECT id, payload FROM event_queue
    WHERE status = 'pending'
    ORDER BY id ASC
    LIMIT ?
  `);
  const rows = select.all(limit) as { id: number; payload: string }[];
  if (rows.length === 0) return [];

  const mark = db.prepare(`UPDATE event_queue SET status = 'processing' WHERE id = ?`);
  withTransaction(db, () => {
    for (const row of rows) mark.run(row.id);
  });
  return rows;
}

export function ackQueueIds(db: MgaDatabase, ids: number[]): void {
  const del = db.prepare(`DELETE FROM event_queue WHERE id = ?`);
  withTransaction(db, () => {
    for (const id of ids) del.run(id);
  });
}

export function failQueueIds(db: MgaDatabase, ids: number[], error: string, maxAttempts: number): void {
  const bump = db.prepare(`
    UPDATE event_queue
    SET status = 'pending', attempts = attempts + 1, last_error = ?
    WHERE id = ?
  `);
  const toDlq = db.prepare(`
    INSERT INTO event_dlq (payload, error)
    SELECT payload, ? FROM event_queue WHERE id = ?
  `);
  const del = db.prepare(`DELETE FROM event_queue WHERE id = ?`);
  const getRow = db.prepare('SELECT attempts, payload FROM event_queue WHERE id = ?');

  withTransaction(db, () => {
    for (const id of ids) {
      const row = getRow.get(id) as { attempts: number; payload: string } | undefined;
      if (!row) continue;
      if (row.attempts + 1 >= maxAttempts) {
        toDlq.run(error, id);
        del.run(id);
      } else {
        bump.run(error, id);
      }
    }
  });
}

export function getQueueDepth(db: MgaDatabase): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM event_queue WHERE status = 'pending'`).get() as {
    c: number;
  };
  return row.c;
}
