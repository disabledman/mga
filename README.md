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

### SDK 異動與 build 流程

SDK 原始碼在 `packages/sdk/src/tracker.ts`，瀏覽器實際載入的是編譯產物 `packages/sdk/dist/tracker.js`。Collector 透過 `GET /sdk/tracker.js` 讀取該檔案對外提供（見 [services/collector/src/index.ts](services/collector/src/index.ts)）。

```
packages/sdk/src/tracker.ts
    npm run build -w @mga/sdk
packages/sdk/dist/tracker.js
    Collector GET /sdk/tracker.js
    正式頁 <script src=".../sdk/tracker.js">
```

#### 何時需要 build

| 情境 | 指令 |
|------|------|
| 修改 `packages/sdk/` 內程式 | `npm run build -w @mga/sdk` |
| 第一次 clone / 清過 `dist/` | `npm run build` 或至少 build SDK |
| `npm run dev` 前 | 根目錄 `predev` 會自動 build shared + SDK |
| 正式區部署 | `npm run build`（含 SDK）後再 `npm run start` |

改完 SDK 後**不必重啟 Collector**（每次請求會重新讀 `dist/tracker.js`），但瀏覽器可能快取舊檔，請 **硬重新整理**（Ctrl+F5）或開無痕視窗驗證。

#### 嵌入順序（重要）

`init` 必須在載入 `tracker.js` **之前**排進佇列：

```html
<!-- 1. stub + init -->
<script>
  window.analytics = window.analytics || function () { ... };
  window.analytics.push(['init', { siteId: '...', writeKey: '...', apiHost: '...' }]);
</script>
<!-- 2. 再載入 SDK -->
<script src="http://localhost:7080/sdk/tracker.js"></script>
```

若順序反了，或 `tracker.js` 404 / 未 build，Demo 會顯示：**「SDK 未初始化（init 未執行）。請重新 build SDK：npm run build -w @mga/sdk」**（`window.MgaAnalytics` 不存在）。

#### 常見錯誤對照

| 現象 | 原因 | 處理 |
|------|------|------|
| Demo：**SDK 未初始化（init 未執行）** | `dist/tracker.js` 不存在或載入失敗；或 init 在 tracker.js 之後 | `npm run build -w @mga/sdk`；確認 `<script src>` 在 init 之後；看 Network 是否 200 |
| Demo：**SDK 未載入** | Collector 未啟動或 URL 錯誤 | `npm run dev`；開 `http://localhost:7080/sdk/tracker.js` 應有 JS 內容 |
| Collect 404 `sdk_not_built` | 未 build SDK | `npm run build -w @mga/sdk` |
| 改了 SDK 但行為沒變 | 瀏覽器快取 | 硬重新整理；或 DevTools 勾 Disable cache |

#### 本機開發 SDK（可選）

僅改 SDK、其餘服務已跑時，可另開終端機監聽重建：

```bash
npm run dev -w @mga/sdk
```

存檔後會自動輸出 `dist/tracker.js`，再重新整理測試頁即可。

開啟 **http://localhost:7080/demo.html**（只需 `npm run dev`），Demo 會**自動啟用** Cookie 追蹤，直接點按鈕即可；數秒後在 http://localhost:7808 查看報表。

正式區僅 Collector 對外時，嵌入改用 `https://ga.pmatch.com.tw`（Nginx 內轉 `127.0.0.1:7080`），`apiHost` 與 `<script src>` 皆指向該網域。


若終端機沒有 `[collector] collect accepted` 或 `[writer] flushed`，代表事件未送出（常見原因：用 file:// 開頁、Collector 未啟動）。

## 正式區部署

本機開發用 `npm run dev`；**正式區請用 `npm run build` 後以 `npm run start` 常駐**，不要用 `dev`（`tsx watch` 僅供開發）。

### 1. 部署到伺服器

```bash
cd mga
npm install
npm run build
npm run db:init          # 僅第一次；已有 data/mga.db 可略過
cp .env.example .env     # 依正式環境修改（見下方）
```

`.env.example` 不會自動載入，需複製為 `.env` 並以 PM2 `env_file`、systemd `EnvironmentFile` 或 shell 匯出變數。

### 2. 環境變數（`.env` 範例）

```env
MGA_DB_PATH=./data/mga.db
MGA_COLLECTOR_PORT=7080
MGA_MSSQL_API_PORT=7090
MGA_MSSQL_API_URL=http://127.0.0.1:7090/internal/analytics/events/batch
MGA_MSSQL_API_TOKEN=<正式 token>
MGA_QUERY_PORT=7100
MGA_QUERY_URL=http://127.0.0.1:7100
MGA_DASHBOARD_PORT=7808
MGA_ADMIN_TOKEN=<admin token>
```

對接公司真實 MSSQL API 時，將 `MGA_MSSQL_API_URL` 改為正式 URL，可不跑 mock-mssql-api。

### 3. 啟動服務（正式區）

各服務需**同時常駐**（缺 writer 則佇列不會寫入報表）：

```bash
npm run start -w @mga/collector
npm run start -w @mga/writer
npm run start -w @mga/mock-mssql-api    # 或改接真實 API 時省略
npm run start -w @mga/query-api
npm run start -w @mga/dashboard
```

以 [PM2](https://pm2.keymetrics.io/) 為例（在專案根目錄、已設定 `.env` 後）：

```bash
pm2 start npm --name mga-collector -- run start -w @mga/collector
pm2 start npm --name mga-writer -- run start -w @mga/writer
pm2 start npm --name mga-mssql -- run start -w @mga/mock-mssql-api
pm2 start npm --name mga-query -- run start -w @mga/query-api
pm2 start npm --name mga-dashboard -- run start -w @mga/dashboard
pm2 save
```

### 4. 對外與 Nginx（僅 Collector）

正式頁嵌入 SDK 指向 GA 網域，**不必**暴露 Dashboard / Query 埠：

| 對象 | URL |
|------|-----|
| 正式頁 `<script src>`、`apiHost` | `https://ga.pmatch.com.tw` |
| Nginx 反代 | `https://ga.pmatch.com.tw` → `http://127.0.0.1:7080` |
| 內部看報表 | `http://127.0.0.1:7808`（或 SSH tunnel） |

Nginx 需轉發：`/sdk/tracker.js`、`/v1/collect`、`/v1/collect/beacon`。

### 5. 正式頁 SDK 嵌入

```html
<script>
  window.analytics.push(['init', {
    siteId: 's_prod',
    writeKey: '<正式 write_key>',
    apiHost: 'https://ga.pmatch.com.tw',
    consentRequired: true,
    autoTrack: { pageView: true, clicks: true },
    clickSelector: '[data-track], a, button',
  }]);
</script>
<script src="https://ga.pmatch.com.tw/sdk/tracker.js"></script>
```

並在 DB `analytics_sites.allowed_hosts` 加入正式站網域（例：`pmatch.com.tw`、`www.pmatch.com.tw`），否則 Collect 回 `403 origin_not_allowed`。

### 6. 檢查清單

1. `npm run build` 成功，`packages/sdk/dist/tracker.js` 存在
2. 五個程序皆在跑（至少 collector + writer + 寫入 API + query + dashboard）
3. Nginx TLS 與反代至 `7080` 正常
4. 正式頁 Network：`POST https://ga.pmatch.com.tw/v1/collect` → **204**
5. 內部 Dashboard 可開、數秒內有新事件

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
