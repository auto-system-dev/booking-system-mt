# 多租戶第 2 週完成報告

更新日期：2026-04-01

## 範圍

本週目標對應原規劃第 3 點：

- 實作租戶識別與授權
- API 請求注入 `tenant_id`
- 主要資料查詢加上租戶範圍
- 缺少 `tenant_id` 時阻擋請求

## 本週已完成

### 1) 租戶識別中介層

- 新增 `src/middlewares/tenant.js`
  - `resolveTenantId(req)`：依序從 `session.admin.tenant_id`、`x-tenant-id`、`query/body tenant_id`、`DEFAULT_TENANT_ID` 解析
  - `requireTenantContext`：缺少 `tenant_id` 時回 `400 TENANT_REQUIRED`
  - `attachTenantContext`：預留可擴充

### 2) 管理端與關鍵 API 租戶強制化

- 已將 `requireTenantContext` 套用到多條路由（含 `/api/admin` 共用保護鍊）
- 關鍵路徑已強制傳遞 `req.tenantId` 至 service/db 層

涵蓋重點：

- 訂房主流程（建立、查詢、快速建立）
- 房型/館別（public + admin）
- 假日、加購商品、設定
- 統計與匯出（bookings/customers/statistics）
- 儀表板（dashboard、bundle、ops、interval-summary）

### 3) DB 層租戶範圍防呆

- 在 `database.js` 新增 `assertTenantScope(tenantId, operation)`
  - 若缺少 tenant，會回退 `DEFAULT_TENANT_ID`（預設 `1`）
  - 非法值直接 throw，降低漏範圍風險

- 已 tenant 化主要查詢與寫入（摘要）：
  - `bookings`：查詢/區間/單筆/email/寫入
  - `room_types`：查詢/新增/修改/刪除
  - `buildings`：查詢/新增/修改/刪除
  - `holidays`：查詢/新增/區間新增/刪除/判斷
  - `addons`：查詢/新增/修改/刪除
  - `customers`：列表/查詢/修改/刪除/統計
  - `settings`：讀取與更新（tenant 維度）
  - `statistics`：SQL 層加 tenant 條件（含來源、房型、付款拆分）
  - `monthly/period comparison` 報表鏈 tenant 化

### 4) 背景流程與服務補齊

- `booking.service` / `booking.routes` / `modeGuard` 已改 tenant-aware
- email/notification/payment 相關 service 已改用 tenant-aware 設定讀取（主要以 `DEFAULT_TENANT_ID` 驅動背景流程）

### 5) 驗收腳本（可重複執行）

- 新增 `scripts/tenant-isolation-smoke.js`
- 新增 npm script：`npm run test:tenant-smoke`
- 實測結果：`PASS`
  - `tenantA` 無法讀到 `tenantB` 的 bookings / room_types
  - `tenantB` 無法讀到 `tenantA` 的 bookings / room_types

## 仍需關注的風險/注意事項

### A) 歷史資料回填

- 既有資料可能有 `tenant_id IS NULL`
- 若後續查詢全改為 tenant 強制，舊資料會「看不到」
- 建議先做一次資料回填 migration（至少主業務表）

### B) 設定資料唯一鍵

- 若 `settings` 現有唯一鍵仍是全域 `key`，多租戶下可能互斥
- 建議改成複合唯一鍵：`(tenant_id, key)`

### C) 背景排程多租戶執行模型

- 目前背景排程多使用 `DEFAULT_TENANT_ID`
- 若要同時服務多租戶，需改為「迭代 tenants 執行」模式

### D) 尚未全面 tenant 化的邊角功能

- 仍需逐步掃描次要功能與舊 API（例如部份權限/模板/日誌維度策略）
- 建議用「新增 API 一律 tenant 必帶」作為開發規範

## 第 3 週建議直接照做

### 1) 訂閱引擎 MVP（必做）

- 建立 `basic/pro` + `monthly/yearly`
- 訂閱狀態：`trialing/active/past_due/canceled`
- 每日排程檢查到期：降權/停用/恢復

### 2) 功能 Gate（必做）

- 在 middleware 注入 `plan capability`
- 對報表/API/分店數等功能做限制

### 3) Webhook 與付款同步（可先手動）

- 先上手動收費 + 後台調整訂閱
- 再接 webhook：驗簽 + 去重 + subscriptions 狀態同步

### 4) 測試與回歸（必做）

- 增加自動化測試：A/B tenant 隔離、狀態流轉、到期停權與恢復
- 將 `npm run test:tenant-smoke` 併入部署前檢查

## 建議短期規範

- 新增任何資料查詢前先決定 tenant 維度
- route 層預設掛 `requireTenantContext`
- db 層函式優先使用 `(tenantId, ...)` 或明確 `assertTenantScope`
- PR 檢查清單加入：「此變更是否可能跨租戶讀寫」

