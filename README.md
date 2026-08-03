# MGA — Multi-tenant Web Analytics

<img width="1920" height="1032" alt="image" src="https://github.com/user-attachments/assets/1a195b69-ab41-4673-b9a6-5df43824c8e8" />


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

### Demo 頁面（快速驗證）

內建示範頁 [`examples/demo.html`](examples/demo.html)，由 Collector 以 `GET /demo.html` 提供。

```bash
npm run dev
```

| 開啟方式 | URL | 說明 |
|----------|-----|------|
| **推薦** | `http://localhost:7080/demo.html` | SDK 用相對路徑 `/sdk/tracker.js`，`apiHost` 自動為目前 origin |
| LAN 測試 | `http://192.168.x.x:7080/demo.html` | 同網段其他電腦可測；需 `npm run db:init` 更新 `allowed_hosts` |
| 靜態伺服器 | `npm run demo` → `:7500/demo.html` | 頁面不在 7080 時，`apiHost` 會 fallback 到 `http://localhost:7080`，**僅適合本機** |

Demo 預設 `consentRequired: false` 並自動 `consent('grant')`，可直接點「主要 CTA」測試。約 2～4 秒後到 Dashboard（`:7808`）看報表。

診斷工具（在專案根目錄執行）：

```bash
npm run diag:pipeline    # 端到端：health → collect → writer flush
npm run diag:queue       # 佇列狀態；加 --reset 重設卡住的 processing
npm run db:init          # 初始化 DB、合併 LAN allowed_hosts、reclaim 佇列
npm run db:reset         # 清空全部分析資料後重建 DB（需先停 dev/PM2）
```

終端機應依序出現 `[collector] collect accepted` 與 `[writer] flushed`；若只有前者，見下方「常見錯誤」。

### 嵌入 SDK

#### 1. 基本模式（與 Demo 相同）

**順序很重要：** 先 stub + `init` 排進佇列，再載入 `tracker.js`。

```html
<!-- 1. stub + init（inline，在 tracker.js 之前） -->
<script>
  (function () {
    // 頁面由 Collector :7080 提供時，用相對路徑即可（LAN 也能用）
    var apiHost = window.location.protocol.startsWith('http')
      ? (window.location.port === '7080' ? window.location.origin : 'https://ga.example.com')
      : 'https://ga.example.com';

    window.analytics = window.analytics || function () {
      (window.analytics.q = window.analytics.q || []).push([].slice.call(arguments));
    };
    window.analytics.q = window.analytics.q || [];
    window.analytics.push = function (cmd) { window.analytics.q.push(cmd); };

    window.analytics.push(['init', {
      siteId: 's_demo',
      writeKey: 'wk_demo_change_in_production',
      tenantId: 't_demo',
      apiHost: apiHost,
      consentRequired: false,          // 正式站建議 true，並在同意後 analytics('consent','grant')
      allowIdentify: true,
      blockPaths: ['/account/*'],      // 不追蹤的路徑（glob）
      autoTrack: {
        pageView: true,
        clicks: true,
        outboundLinks: true,
      },
      clickSelector: '[data-track], a[href]',
    }]);
  })();
</script>
<!-- 2. 載入 SDK（Collector 同網域時用相對路徑） -->
<script src="/sdk/tracker.js"></script>
<!-- 3. 可選：Demo 會自動 grant consent 並 flush -->
<script>
  if (window.MgaAnalytics) {
    analytics('consent', 'grant');
    analytics('flush');
  }
</script>
```

#### 2. 點擊與自訂事件

| 用途 | 作法 |
|------|------|
| 追蹤按鈕 / 連結 | 元素加 `data-track="track_id"`（例：`data-track="demo_cta"`） |
| 外連 | `<a href="https://..." data-track="demo_outbound">`（需 `outboundLinks: true`） |
| 排除不追蹤 | 元素加 `class="no-track"` |
| 自訂事件 | `analytics('track', 'event_name', { track_id: '...' }); analytics('flush');` |

#### 3. `init` 選項摘要

| 選項 | Demo 值 | 說明 |
|------|---------|------|
| `siteId` / `writeKey` | `s_demo` / `wk_demo_change_in_production` | 站點識別，須與 DB `analytics_sites` 一致 |
| `tenantId` | `t_demo` | 租戶 ID（報表查詢用） |
| `apiHost` | 動態或正式網域 | Collect API 根 URL，**不含** `/v1/collect` |
| `consentRequired` | `false` | `true` 時須先 `analytics('consent','grant')` 才送事件 |
| `autoTrack` | pageView / clicks / outboundLinks | 自動追蹤 |
| `clickSelector` | `[data-track], a[href]` | 點擊委派選擇器 |
| `blockPaths` | `['/account/*']` | 不送事件的路徑 |

#### 4. URL 怎麼填（本機 / LAN / 正式）

| 情境 | `apiHost` | `<script src>` |
|------|-----------|----------------|
| 頁面由 Collector :7080 提供（含 LAN） | `window.location.origin` 或省略改相對 collect | `/sdk/tracker.js` |
| 頁面在其他網域 / 埠 | Collector 對外 URL（例 `https://ga.example.com`） | 同左 + `/sdk/tracker.js` |
| 本機靜態頁（`:7500` 等） | `http://localhost:7080` 或 LAN IP | `http://<collector-host>:7080/sdk/tracker.js` |

服務彼此通訊（Writer → Mock API）請用 `127.0.0.1`（見 `.env` 的 `MGA_MSSQL_API_URL`），與瀏覽器端的 `apiHost` 無關。

#### 5. `allowed_hosts`（Collect 403 時必查）

Collect 會檢查請求 `Origin` 的 hostname。LAN IP 或新網域需加入 DB：

```bash
npm run db:init   # 自動合併 192.168.*、10.*、172.* 及本機 IPv4
```

或手動更新 `analytics_sites.allowed_hosts`（`site_id = 's_demo'`）。  
確認 Collector 啟動 log 為 `Collector DB: .../data/mga.db`（**不是** `node_modules/data/mga.db`）。

### SDK 異動與 build 流程

SDK 原始碼在 `packages/sdk/src/tracker.ts`，瀏覽器載入編譯產物 `packages/sdk/dist/tracker.js`。Collector 以 `GET /sdk/tracker.js` 提供（見 [services/collector/src/index.ts](services/collector/src/index.ts)）。

```
packages/sdk/src/tracker.ts
    npm run build -w @mga/sdk
packages/sdk/dist/tracker.js
    Collector GET /sdk/tracker.js
    頁面 <script src="/sdk/tracker.js">
```

#### 何時需要 build

| 情境 | 指令 |
|------|------|
| 修改 `packages/sdk/` | `npm run build -w @mga/sdk` |
| 修改 `packages/shared/` | `npm run build -w @mga/shared`，**並重啟** `npm run dev` |
| 第一次 clone / 清過 `dist/` | `npm run build` |
| `npm run dev` 前 | `predev` 會自動 build shared + SDK |
| 正式區部署 | `npm run build` 後 `npm run start` |

改 SDK 後不必重啟 Collector（每次請求重讀 `dist/tracker.js`），但瀏覽器可能快取，請 **Ctrl+F5** 或 DevTools 勾 Disable cache。

#### 本機開發 SDK（可選）

```bash
npm run dev -w @mga/sdk
```

存檔後自動輸出 `dist/tracker.js`，重新整理測試頁即可。

#### 常見錯誤

| 現象 | 原因 | 處理 |
|------|------|------|
| Demo：**SDK 未初始化** | `dist/tracker.js` 不存在；或 init 在 tracker.js 之後 | `npm run build -w @mga/sdk`；確認嵌入順序 |
| Demo：**SDK 未載入** | Collector 未啟動或 script URL 錯誤 | `npm run dev`；Network 確認 `/sdk/tracker.js` 200 |
| Collect **403** `origin_not_allowed` | `allowed_hosts` 不含頁面 host | `npm run db:init`；重啟 dev；看 Collector 啟動的 `allowed_hosts` |
| 有 `[collector]` 無 `[writer] flushed` | Writer / Mock :7090 未跑；或 Collect 其實 403 未入佇列 | `npm run diag:pipeline`；確認五個服務皆啟動 |
| Collector DB 指向 `node_modules/data/` | 舊版 shared 路徑 bug | 更新程式、`npm run build -w @mga/shared`、重啟 dev |
| 改了 SDK 行為沒變 | 瀏覽器快取 | 硬重新整理 |

若終端機沒有 `[collector] collect accepted` 或 `[writer] flushed`，代表事件未完整送出（常見：`file://` 開頁、Collect 403、Writer 未啟動）。

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

與 Demo 相同的三段式嵌入，但 `apiHost` / `<script src>` 改為正式 GA 網域，且建議開啟 consent：

```html
<script>
  window.analytics = window.analytics || function () {
    (window.analytics.q = window.analytics.q || []).push([].slice.call(arguments));
  };
  window.analytics.q = window.analytics.q || [];
  window.analytics.push = function (cmd) { window.analytics.q.push(cmd); };
  window.analytics.push(['init', {
    siteId: 's_prod',
    writeKey: '<正式 write_key>',
    tenantId: '<tenant_id>',
    apiHost: 'https://ga.pmatch.com.tw',
    consentRequired: true,
    autoTrack: { pageView: true, clicks: true, outboundLinks: true },
    clickSelector: '[data-track], a[href]',
  }]);
</script>
<script src="https://ga.pmatch.com.tw/sdk/tracker.js"></script>
```

使用者同意 Cookie 後再呼叫 `analytics('consent', 'grant')`。完整選項說明見上方「嵌入 SDK」。

並在 DB 設定正式站（見下方「SQLite 站點設定」）；`allowed_hosts` 須含正式頁 hostname（例：`pmatch.com.tw`、`www.pmatch.com.tw`），否則 Collect 回 `403 origin_not_allowed`。

### 6. SQLite 站點設定（`analytics_sites`）

Collect 驗證用的站點在 **SQLite**（`.env` 的 `MGA_DB_PATH`，預設 `data/mga.db`），表名 `analytics_sites`。

**新 DB** 在 `analytics_sites` 為空時，`npm run db:init` 或首次啟動服務只會自動插入 **Demo 站**（`s_demo` / `wk_demo_change_in_production`），不會建立正式站；正式上線需手動 **INSERT** 或 **UPDATE**。

| 欄位 | 說明 |
|------|------|
| `site_id` | 對應前端 `siteId` |
| `tenant_id` | 入庫事件的 tenant（Collector 以 DB 為準） |
| `write_key` | 對應前端 `writeKey`，**全表唯一**，8–64 字元 |
| `allowed_hosts` | JSON 字串陣列，例：`["pmatch.com.tw","www.pmatch.com.tw"]` |
| `is_active` | `1` 才接受 Collect；`0` 為停用 |

操作前確認所有 MGA 服務使用的 `MGA_DB_PATH` 一致（Collector 啟動 log 會印 DB 路徑）。修改後無需重啟 Collector 即可生效；建議改完以正式頁或 curl 測 `POST /v1/collect`（204 / 401 / 403）。

#### 新增正式站（INSERT）

```sql
INSERT INTO analytics_sites (site_id, tenant_id, name, write_key, allowed_hosts, is_active)
VALUES (
  's_prod',
  't_prod',
  'Pmatch 正式',
  'wk_你的正式金鑰',
  '["pmatch.com.tw","www.pmatch.com.tw"]',
  1
);
```

前端 `init` 的 `siteId` / `writeKey` / `tenantId` 須與上列一致（入庫 `tenant_id` 仍以 DB 為準）。  
查報表時 Query API 需帶 `x-tenant-id: t_prod`、`?site_id=s_prod`（預設為 `t_demo` / `s_demo`）。

#### 更新既有站（UPDATE）

沿用 `s_demo` 或更換 write key、網域、tenant 名稱：

```sql
UPDATE analytics_sites
SET
  write_key = 'wk_新的金鑰',
  tenant_id = 't_prod',
  name = '正式站',
  allowed_hosts = '["pmatch.com.tw","www.pmatch.com.tw"]'
WHERE site_id = 's_demo';
```

`write_key` 不可與其他列重複。僅補允許的 Origin hostname 時，可只更新 `allowed_hosts`；LAN 開發亦可 `MGA_DEMO_ALLOWED_HOSTS=網域1,網域2` 後執行 `npm run db:init`（**僅合併 `s_demo` 的 `allowed_hosts`**，不改 write key）。

#### 停用站點（不再接受 Collect）

```sql
UPDATE analytics_sites SET is_active = 0 WHERE site_id = 's_demo';
```

停用後該 `site_id` 的 Collect 回 **401**（`loadSite` 只載入 `is_active = 1`）。若要恢復：

```sql
UPDATE analytics_sites SET is_active = 1 WHERE site_id = 's_demo';
```

#### 驗證

```bash
# 需 sqlite3 CLI；Windows 可改用 DB Browser for SQLite
sqlite3 data/mga.db "SELECT site_id, tenant_id, write_key, allowed_hosts, is_active FROM analytics_sites;"
```

| Collect 結果 | 常見原因 |
|--------------|----------|
| **401** | `site_id` 不存在、`is_active = 0`、或 `write_key` 不符 |
| **403** | 頁面 hostname 不在 `allowed_hosts` |
| **204** | 成功 |

### 7. 檢查清單

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

### 清空資料庫、重新開始記錄

本機 Mock 環境的佇列、事件、彙總表都在 SQLite（預設 `data/mga.db`）。若要**刪除全部分析資料**並從零開始（保留/重建 Demo 站點設定）：

1. **先停止**所有 MGA 程序（`Ctrl+C` 結束 `npm run dev`，或停止 PM2 的 collector / writer / mock-mssql-api / query-api / dashboard）。程序仍佔用 DB 時刪除會失敗。
2. 在專案根目錄執行：

```bash
npm run db:reset
```

會刪除 `data/mga.db` 以及 WAL/SHM 附檔，接著等同執行 `npm run db:init`（建立 schema、種子 `s_demo`、合併 LAN `allowed_hosts`、reclaim 卡住佇列）。
3. **重新啟動**服務後再送事件：

```bash
npm run dev
```

手動做法（與 `db:reset` 相同，需先停服務）：

```bash
# Linux / macOS
rm -f data/mga.db data/mga.db-wal data/mga.db-shm
npm run db:init
```

```powershell
# Windows PowerShell
Remove-Item -Force -ErrorAction SilentlyContinue data/mga.db, data/mga.db-wal, data/mga.db-shm
npm run db:init
```

| 指令 | 用途 |
|------|------|
| `npm run db:reset` | **全部清空**後重建 DB（開發/測試用） |
| `npm run db:init` | 僅初始化或修補 schema / `allowed_hosts`（**不刪**既有事件） |
| `npm run maintenance:purge` | 依保留天數刪除**過期** `event_raw`（非全清） |

若已對接**公司真實 MSSQL API**，本機 `db:reset` 只清 SQLite；遠端 `analytics.EventRaw` 與彙總表需依公司維運流程另行處理。

```bash
# 資料保留清理（EventRaw TTL，非全清）
npm run maintenance:purge

# 佇列 / 端到端診斷
npm run diag:queue
npm run diag:pipeline

# DB 初始化、LAN allowed_hosts、reclaim 卡住佇列（不刪既有資料）
npm run db:init

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
- `GET /v1/reports/visitors?site_id=s_demo` — 不重複訪客、新/回訪客、滾動 7 天留存率（可選 `date=YYYY-MM-DD`）
- `GET /v1/reports/pages?site_id=s_demo`
- `GET /v1/reports/clicks?site_id=s_demo`
