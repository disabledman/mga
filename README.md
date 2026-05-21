# MGA — Multi-tenant Web Analytics

依 PLAN 實作的 GA 類網頁行為監控：**SDK → Collect API → Queue → Writer → 公司 MSSQL 寫入 API**。

本 repo 內含 **Mock MSSQL API**（SQLite 模擬 `analytics.EventRaw` 與彙總表），便於本機開發；上線時將 `MGA_MSSQL_API_URL` 指向公司真實 API 即可。

## 架構

```
Browser (tracker.js)
    → Collector :7080  (/v1/collect)
    → SQLite queue
    → Writer
    → Mock MSSQL API :7090  (/internal/analytics/events/batch)
    → SQLite event_raw + 彙總表
Query API :7100  →  Dashboard :7808
```

## 快速開始

需要 **Node.js ≥ 22.5**（內建 `node:sqlite`，無需 Visual Studio / `better-sqlite3` 編譯）。若用 nvm：

```bash
nvm use
```

```bash
cd mga
npm install
npm run build
npm run db:init
npm run dev
```

| 服務 | 埠 | 說明 |
|------|-----|------|
| Collector | 7080 | 採集 + 提供 `/sdk/tracker.js` |
| Mock MSSQL API | 7090 | 模擬公司寫入 API |
| Writer | — | 背景輪詢佇列 |
| Query API | 7100 | 報表 REST |
| Dashboard | 7808 | 簡易儀表板 |

### 示範站點

- `site_id`: `s_demo`
- `write_key`: `wk_demo_change_in_production`
- `tenant_id`: `t_demo`

### 嵌入 SDK

```html
<script>
  window.analytics = window.analytics || function () {
    (window.analytics.q = window.analytics.q || []).push([].slice.call(arguments));
  };
  window.analytics.q = window.analytics.q || [];
  window.analytics.push = function (cmd) { window.analytics.q.push(cmd); };
  window.analytics.push(['init', {
    siteId: 's_demo',
    writeKey: 'wk_demo_change_in_production',
    apiHost: 'http://localhost:7080',
    consentRequired: true,
    autoTrack: { pageView: true, clicks: true },
    clickSelector: '[data-track], a, button',
  }]);
</script>
<script src="http://localhost:7080/sdk/tracker.js"></script>
```

點擊追蹤請在元素上加 `data-track="button_name"`。


開啟 **http://localhost:7080/demo.html**（只需 `npm run dev`），Demo 會**自動啟用** Cookie 追蹤，直接點按鈕即可；數秒後在 http://localhost:7808 查看報表。

正式區僅 Collector 對外時，嵌入改用 `https://ga.pmatch.com.tw`（Nginx 內轉 `127.0.0.1:7080`），`apiHost` 與 `<script src>` 皆指向該網域。


若終端機沒有 `[collector] collect accepted` 或 `[writer] flushed`，代表事件未送出（常見原因：用 file:// 開頁、Collector 未啟動）。

## 對接公司 MSSQL API

1. 執行 [sql/schema.sql](sql/schema.sql) 於 MSSQL。
2. 實作契約（見 PLAN）：
   - `POST /internal/analytics/events/batch`
   - `DELETE /internal/analytics/visitors/:visitorId`
3. 設定環境變數：

```env
MGA_MSSQL_API_URL=https://your-api/internal/analytics/events/batch
MGA_MSSQL_API_TOKEN=<service-token>
```

Mock API 行為可參考 [services/mock-mssql-api/src/index.ts](services/mock-mssql-api/src/index.ts)。

## 目錄

| 路徑 | 說明 |
|------|------|
| `packages/sdk` | 瀏覽器追蹤 SDK |
| `packages/shared` | Schema、佇列、DB 工具 |
| `services/collector` | 採集 API |
| `services/writer` | 佇列 → MSSQL API |
| `services/mock-mssql-api` | 本機模擬寫入 API |
| `services/query-api` | 報表查詢 |
| `apps/dashboard` | 儀表板 |
| `sql/schema.sql` | MSSQL DDL |

## 維運

```bash
# 資料保留清理（EventRaw TTL）
npm run maintenance:purge

# DLQ 重放（需 x-admin-token）
curl -X POST http://localhost:7100/v1/admin/dlq/replay -H "x-admin-token: admin-dev-token"

# GDPR 刪除 visitor
curl -X DELETE http://localhost:7100/v1/privacy/visitors/<visitor_id> -H "x-tenant-id: t_demo"
```

契約文件：[docs/api-contract.md](docs/api-contract.md)

## API 摘要

**Collect** `POST /v1/collect`

```json
{
  "site_id": "s_demo",
  "write_key": "wk_demo_change_in_production",
  "events": [{ "event_id": "...", "event_name": "page_view", ... }]
}
```

**Query**（Header `x-tenant-id: t_demo`）

- `GET /v1/reports/overview?site_id=s_demo`
- `GET /v1/reports/pages?site_id=s_demo`
- `GET /v1/reports/clicks?site_id=s_demo`
