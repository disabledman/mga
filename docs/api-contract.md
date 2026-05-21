# MGA — 公司 MSSQL 寫入 API 契約

Writer 服務呼叫此 API；Analytics **不直連 MSSQL**。

## 認證

```
Authorization: Bearer <MGA_MSSQL_API_TOKEN>
```

## POST /internal/analytics/events/batch

批次寫入原始事件（建議 100～500 筆）。

**Request**

```json
{
  "batch_id": "uuid",
  "source": "mga-writer",
  "events": [
    {
      "event_id": "uuid",
      "tenant_id": "t_xxx",
      "site_id": "s_xxx",
      "event_name": "click",
      "event_time_utc": "2026-05-19T08:00:00.000Z",
      "session_id": "64-char-hex",
      "visitor_id": "64-char-hex",
      "page_path": "/checkout",
      "track_id": "checkout_btn",
      "properties_json": "{\"track_id\":\"checkout_btn\"}",
      "consent_granted": true
    }
  ]
}
```

**Response 200**

```json
{ "accepted": 10, "duplicates": 2, "batch_id": "uuid" }
```

| HTTP | Writer 行為 |
|------|-------------|
| 200/204 | ack 佇列 |
| 400 | 進 DLQ（不重試） |
| 409 | 視為成功（冪等） |
| 429/503/5xx | 指數退避重試 |
| 其他 4xx | DLQ |

## POST /internal/analytics/events/dedupe-check（可選）

**Request:** `{ "event_ids": ["uuid", ...] }`  
**Response:** `{ "existing": ["uuid", ...] }`

## DELETE /internal/analytics/visitors/{visitorId}

GDPR：匿名化或刪除該 visitor 所有 `EventRaw`。

**Response:** `{ "anonymized": 42 }`

## GET /internal/analytics/visitors/{visitorId}/export

匯出該 visitor 事件（JSON array）。

## POST /internal/analytics/aggregate/run（可選）

觸發日彙總；本專案 Mock API 於寫入時即時更新彙總表。

## 資料表

見 [sql/schema.sql](../sql/schema.sql)。

JSON Schema：[schemas/event.schema.json](../schemas/event.schema.json)、[schemas/mssql-batch.schema.json](../schemas/mssql-batch.schema.json)。
