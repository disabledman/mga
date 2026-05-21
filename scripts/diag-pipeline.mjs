import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const sharedDist = join(projectRoot, 'packages', 'shared', 'dist', 'index.js');

function fail(message, code = 1) {
  console.error(message);
  process.exitCode = code;
}

if (!existsSync(sharedDist)) {
  fail('請先 build shared：npm run build -w @mga/shared');
} else {
  const { openDb, resolveDbPath, parseAllowedHosts, hostMatchesAllowed } = await import(
    pathToFileURL(sharedDist).href
  );

  const COLLECTOR = process.env.MGA_COLLECTOR_URL ?? 'http://127.0.0.1:7080';
  const MOCK = process.env.MGA_MSSQL_API_URL?.replace(/\/internal\/analytics\/events\/batch$/, '') ?? 'http://127.0.0.1:7090';
  const QUERY = process.env.MGA_QUERY_URL ?? 'http://127.0.0.1:7100';
  const ORIGIN = process.env.MGA_TEST_ORIGIN ?? 'http://192.168.10.7:7080';
  const TEST_HOST = (() => {
    try {
      return new URL(ORIGIN).hostname;
    } catch {
      return '192.168.10.7';
    }
  })();

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function getJson(url) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      return { ok: false, status: 0, body: String(err) };
    }
  }

  const dbPath = resolveDbPath();
  const db = openDb();
  const rawBefore = db.prepare('SELECT COUNT(*) AS c FROM event_raw').get().c;
  const queueBefore = db.prepare("SELECT COUNT(*) AS c FROM event_queue WHERE status='pending'").get().c;
  const site = db.prepare('SELECT allowed_hosts FROM analytics_sites WHERE site_id = ?').get('s_demo');
  const allowed = site ? parseAllowedHosts(site.allowed_hosts) : [];
  const hostOk = hostMatchesAllowed(TEST_HOST, allowed);

  console.log('=== MGA pipeline diagnostic ===');
  console.log('db:', dbPath);
  console.log('collector:', COLLECTOR);
  console.log('mock:', MOCK);
  console.log('test origin:', ORIGIN);
  console.log('test host:', TEST_HOST);
  console.log('allowed_hosts:', site?.allowed_hosts ?? '(missing s_demo)');
  console.log('hostMatchesAllowed:', hostOk);
  console.log('event_raw before:', rawBefore);
  console.log('queue pending before:', queueBefore);
  console.log('');

  if (!hostOk) {
    fail(
      `FAIL: DB 不允許 host "${TEST_HOST}"\n` +
        '  → 在專案根目錄執行：npm run build -w @mga/shared && npm run db:init\n' +
        '  → 重啟 npm run dev\n' +
        '  → 或設定 MGA_DEMO_ALLOWED_HOSTS=192.168.10.7 後再 db:init'
    );
  } else {
    const health7080 = await getJson(`${COLLECTOR}/health`);
    const health7090 = await getJson(`${MOCK}/health`);
    const health7100 = await getJson(`${QUERY}/health`);

    console.log('7080 /health', health7080.status, health7080.body);
    console.log('7090 /health', health7090.status, health7090.body);
    console.log('7100 /health', health7100.status, health7100.body);

    const collectorHealth = health7080.body;
    if (collectorHealth && typeof collectorHealth === 'object') {
      if (collectorHealth.db_path && collectorHealth.db_path !== dbPath) {
        console.warn('');
        console.warn('WARN: Collector 與 diag 使用不同 DB！');
        console.warn('  diag:      ', dbPath);
        console.warn('  collector: ', collectorHealth.db_path);
        console.warn('  → 請 Ctrl+C 停掉 npm run dev，再重新 npm run dev');
      }
      const collectorHostOk = collectorHealth.demo_host_checks?.[TEST_HOST];
      if (collectorHostOk === false) {
        fail(
          `FAIL: Collector 不允許 host "${TEST_HOST}"（DB 路徑：${collectorHealth.db_path ?? 'unknown'}）\n` +
            '  → npm run db:init\n' +
            '  → Ctrl+C 後重新 npm run dev（build shared 後必須完整重啟，不能只靠 tsx watch）'
        );
      }
      if (collectorHostOk === undefined) {
        console.warn('');
        console.warn('WARN: Collector /health 無 demo_host_checks，可能跑舊版程式');
        console.warn('  → npm run build -w @mga/shared');
        console.warn('  → Ctrl+C 後重新 npm run dev');
      }
    }
    console.log('');

    if (!health7080.ok) {
      fail('FAIL: Collector 未啟動。請 npm run dev');
    } else if (!health7090.ok) {
      fail('FAIL: Mock MSSQL API (7090) 未啟動 — Writer 無法 flush');
    } else {
      const eventId = randomUUID();
      const payload = {
        site_id: 's_demo',
        write_key: 'wk_demo_change_in_production',
        events: [
          {
            event_id: eventId,
            tenant_id: 't_demo',
            site_id: 's_demo',
            event_name: 'click',
            timestamp: new Date().toISOString(),
            client_ts: new Date().toISOString(),
            session_id: 'diag12345678',
            visitor_id: 'diag12345678',
            page_url: `${ORIGIN}/demo.html`,
            page_path: '/demo.html',
            track_id: 'diag_pipeline',
            consent_granted: true,
          },
        ],
      };

      let collectStatus = 0;
      let collectBody = '';
      try {
        const res = await fetch(`${COLLECTOR}/v1/collect`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: ORIGIN,
          },
          body: JSON.stringify(payload),
        });
        collectStatus = res.status;
        collectBody = await res.text();
      } catch (err) {
        collectBody = String(err);
      }

      console.log('POST /v1/collect ->', collectStatus, collectBody || '(empty)');
      console.log('');

      if (collectStatus !== 204) {
        if (collectStatus === 403) {
          fail(
            'FAIL: Collect 403 origin_not_allowed（DB 看起來允許，但 Collector 可能跑舊程式）\n' +
              '  → npm run build -w @mga/shared\n' +
              '  → npm run db:init\n' +
              '  → 重啟 npm run dev（必須重啟 Collector）'
          );
        } else {
          fail(`FAIL: Collect 未成功（預期 204，實際 ${collectStatus}）`);
        }
      } else {
        let flushed = false;
        for (let i = 0; i < 8; i++) {
          await sleep(1000);
          const pending = db.prepare("SELECT COUNT(*) AS c FROM event_queue WHERE status='pending'").get().c;
          const processing = db.prepare("SELECT COUNT(*) AS c FROM event_queue WHERE status='processing'").get().c;
          const rawNow = db.prepare('SELECT COUNT(*) AS c FROM event_raw').get().c;
          console.log(`t+${i + 1}s pending=${pending} processing=${processing} event_raw=${rawNow}`);
          if (rawNow > rawBefore) {
            flushed = true;
            break;
          }
        }

        console.log('');
        const rawAfter = db.prepare('SELECT COUNT(*) AS c FROM event_raw').get().c;

        if (flushed || rawAfter > rawBefore) {
          console.log('OK: 事件已寫入 event_raw（Writer → Mock 正常）');
          console.log('若按 demo 按鈕仍無資料，請在瀏覽器 Network 確認 POST /v1/collect 是否 204');
        } else {
          const pending = db.prepare("SELECT COUNT(*) AS c FROM event_queue WHERE status='pending'").get().c;
          const processing = db.prepare("SELECT COUNT(*) AS c FROM event_queue WHERE status='processing'").get().c;
          fail(
            'FAIL: Collect 204 但 event_raw 未增加\n' +
              (pending > 0 || processing > 0
                ? `  → 佇列堆積 pending=${pending} processing=${processing}：查 [writer] retryable failure`
                : '  → 查 [writer] dropped 或 Writer 未啟動')
          );
        }
      }
    }
  }

  db.close();
}
