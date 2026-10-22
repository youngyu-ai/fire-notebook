# 🚒 消防小本本（Fire Notebook）— 消防電子公文暨業務檔案管理系統

**目前最新版本**：`v2.2.0`（更新日期：`2026-10-22`）  
**系統定位**：個人專屬的消防公文、訓練、耗材、器材業務追蹤工作台，整合 **Google Sheets（案件資料庫＋索引快取）**、**Google Drive（每案自動建立專屬歸檔資料夾＋定期試算表備份）** 與 **Google Tasks（消防待辦清單雙向同步）**。

---

## 📁 專案目錄結構

```text
C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\
├── README.md                          # 專案總覽、架構說明、部署 SOP 與完整版本紀錄 (Changelog)
├── AI交接與版本還原提示詞.md            # 跨 AI / 新對話視窗無縫接軌與指定版本還原專用提示詞
├── scripts/
│   └── release_backup.py              # 自動化版本封存腳本（產生 backups/ 快照、SHA-256 校驗與 .zip）
├── backups/                           # 歷次定版完整快照庫（含資料夾與 .zip 壓縮包）
│   ├── versions.json                  # 版本清單與變更紀錄索引檔
│   └── v2.1.0_2026-10-22_UI2.0-方案A零閃爍與新LOGO/
│       ├── VERSION_MANIFEST.json      # 該版本檔案清單、SHA-256 雜湊與變更摘要
│       └── outputs/                   # 該版本完整程式碼與圖示快照
└── outputs/                           # 目前最新線上正式版交付檔案（Active Deliverables）
    ├── Code.gs                        # Google Apps Script 後端主程式
    ├── Index.html                     # 線上正式版前端單頁應用程式 (UI 2.0 + 方案 A 零閃爍 + 新 LOGO)
    ├── UI-Preview.html                # 本機離線預覽版
    ├── Desktop-Icon.ico               # Windows 桌面捷徑多尺寸圖示 (256/128/64/48/32/16)
    ├── Desktop-Icon.png               # 512x512 高解析度圓角透明去背主圖示
    ├── Desktop-Icon-192.png           # 192x192 PWA 標準圖示
    └── Desktop-Icon-180.png           # 180x180 Apple Touch Icon 圖示
```

---

## 🔗 線上環境與桌面捷徑資訊

- **Apps Script 專案編輯器**：`https://script.google.com/home/projects/1Ho8fz-9fryMHxCrxVc-WJallrsyAc7YFJV98tdWp1i8RbbXIxo8SH7BJ/edit`
- **GAS Web App 正式部署網址 (`/exec`)**：`https://script.google.com/macros/s/AKfycby_KpvIxGmEgZV_T7W8a84hv6LE4ifycdU--ZBANd_kjlJkrGiZKQzSCUxbihEqgzAb/exec`
- **Windows 桌面捷徑位置**：`C:\Users\yshai\OneDrive\桌面\消防小本本.lnk`（以 Chrome `--app="..."` 獨立視窗開啟，綁定 `outputs\Desktop-Icon.ico`）

---

## ✨ 系統核心功能與架構亮點

### 1. 後端架構（`outputs/Code.gs`）
- **三表分離與快取加速**：
  - `業務公文管理`：主資料表（儲存 `資料ID`、`發文/登記日期`、`標籤類別`、`案件/公文主旨`、`內容說明`、`限辦/完成期限`、`執行狀態`、`執行進度與摘要`、`專屬資料夾連結`、`建檔時間`）。
  - `_系統索引`：輕量級中繼資料索引表，搭配 `CacheService` 分塊快取（Chunked Metadata Cache），大幅降低讀取大型歷史文字的延遲。
  - `_操作紀錄`：搭配前端 `clientRequestId` 實作 **Idempotency（冪等防重複送出）** 與中斷續傳恢復，避免網路不穩時重複建立案件資料夾或重複寫入列。
- **預設載入「當年度全部案件 ＋ 跨年未結案」**：
  - `apiBootstrap()` 與 `apiLoadActivePage()` 以當年度 `YYYY-01-01` 為分界（`cutoff`），預設載入**今年度所有案件（含已結案／存查）**以及**跨年度尚未結案（`待辦`／`辦理中`）的舊案**。
  - 往年已結案之歷史案件可透過前端「🗄️ 歷史年度」按年份按需載入（`apiLoadArchiveYear`）。
- **Google Drive 自動歸檔與定期備份**：
  - 每件新案自動於根目錄下建立獨立案件資料夾，支援多檔上傳。
  - 內建每月自動備份觸發器，將試算表備份至 `_系統備份` 資料夾（保留最近 24 份）。
- **Google Tasks 雙向同步（`消防` 清單）**：
  - 新增案件或變更狀態為「已結案」時，自動同步建立、勾選完成或重新開啟對應的 Google Tasks 待辦事項。

### 2. 前端介面（`outputs/Index.html` — UI 2.0 方案 A）
- **方案 A 零閃爍自然捲動頂欄**：
  - 頂部僅固定（`position: sticky`）深紅色窄標題列（`.topbar`），內含新救護包公文夾 LOGO、同步狀態膠囊，以及手機版專屬 **`🔍 搜尋/篩選`** 快速回頂端按鈕。
  - 搜尋框、歷史年度切換、狀態統計與標籤篩選列（`.controls-section`）位於主容器頂部，手機往下滑時 **1:1 隨手指自然往上捲走**，不動態改變文件總高度，徹底根除手機瀏覽器 `scrollY` 回彈閃爍問題。
- **案件卡片急迫度視覺階層**：
  - 左側急迫度色條（逾期紅條、3天內到期橘條、辦理中藍條、已結案柔和灰底降噪）。
  - 跨年未結案自動標示醒目橘色徽章 `📌 跨年未結案 (YYYY)`。
  - 整張卡片點擊即可開啟進度與內文視窗。
- **手機版 Bottom Sheet 底部抽屜模式 ＋ 單手懸浮列**：
  - 手機視角（`max-width: 760px`）下，「公文內文與進度更新（`#progressModal`）」與「新增案件建檔（`#newModal`）」皆由底部滑出為 Bottom Sheet（含頂部拖曳把手 `.sheet-handle`）。
  - 手機畫面底部配置「`＋ 新增建檔` / `🚒 待辦事項`」雙按鈕單手懸浮列（`.mobile-bottom-bar`）。
- **垂直視覺化時間軸 ＋ 淺色輸入框 ＋ 拖曳上傳區（Dropzone）**：
  - 內容說明與進度輸入框皆採用柔和淺灰藍底色（`#f8fafc`），點擊時轉為純白底與紅色聚焦光暈。
  - 自動將 `----------` 分隔之歷史文字解析為垂直時間軸卡片（含時間戳、狀態標籤、`📎` 附件徽章），並可隨時一鍵切換回全文手動編輯模式。
  - 照片上傳前於瀏覽器端自動壓縮至最長邊 `1600px`、JPEG 品質 `0.75`，並嚴格把關 `6 MiB` 請求上限與 HEIC 格式檢查。

---

## 📜 歷次版本更新紀錄（Changelog）

### `v2.2.0` — 2026-10-22（升級 GitHub Pages 標準 PWA ＋ 跨裝置首次通行密碼信任機制）
- **備份路徑**：`backups/v2.2.0_2026-10-22_GitHub-Pages-PWA與信任裝置密碼鎖/`（含同名 `.zip`）
- **變更內容**：
  1. **GitHub Pages 標準 PWA 架構**：於專案根目錄與 `pwa/` 產出完整 PWA 檔案（`index.html`、`manifest.json`、`sw.js`、`icon-192.png`、`icon-512.png`、`apple-touch-icon.png`、`favicon.ico`），徹底消除 Google Apps Script 頂部灰色警告列與雙層 `iframe` 限制。
  2. **跨裝置「首次通行密碼驗證（設為信任裝置）」**：手機、平板、桌機、筆電首次開啟 PWA 時輸入一次通行密碼（預設為 `119`，可隨時於介面右上角 `🔒 信任裝置` 按鈕修改雲端密碼），驗證成功後自動記憶於該裝置 `localStorage` 成為信任裝置，日後開啟免重複輸入。
  3. **後端 `Code.gs` 新增 `doPost(e)` JSON API 與母資料夾自癒機制**：支援跨網域 `fetch` 呼叫所有既有業務功能，並強化 `getRootFolder_()` 自動記憶與從既有案件資料夾反查母資料夾 ID。

### `v2.1.0` — 2026-10-22（UI 2.0 方案 A 零閃爍自然捲動 ＋ 救護包公文夾新 LOGO ＋ 自動備份機制）
- **備份路徑**：`backups/v2.1.0_2026-10-22_UI2.0-方案A零閃爍與新LOGO/`（含同名 `.zip`）
- **變更內容**：
  1. **修復手機版捲動閃爍（改採方案 A）**：移除原本透過 `scroll` 事件動態縮減 `.collapsible-controls` `max-height` 的設計（避免頁面高度突變引發 `scrollY` 回彈死循環），改為僅固定深紅窄標題列，讓搜尋與篩選列隨手指自然捲動，並於手機頂欄右側新增「`🔍 搜尋/篩選`」一鍵回頂端按鈕。
  2. **更換全系統專屬新 LOGO**：將原圖裁切外框淺藍底色並做圓角透明去背，全面更新至 `Index.html`（頂欄圖示、`apple-touch-icon`、`favicon`）及 `Desktop-Icon.ico` / `180` / `192` / `512` PNG 圖示，同步刷新 Windows 桌面捷徑。
  3. **預設載入範圍升級**：前後端（`Code.gs` 與 `Index.html`）預設載入範圍統一由「近 90 天」改為「**當年度 `YYYY-01-01` 起全部案件（含已結案）＋ 跨年未結案**」。
  4. **手機版 Bottom Sheet 與淺色說明框**：手機版彈窗全面改為底部抽屜模式（Bottom Sheet），所有 `<textarea>` 改為柔和淺色底（`#f8fafc`）。
  5. **建立版本自動備份與 AI 交接機制**：新增 `scripts/release_backup.py`、`backups/versions.json` 與 `AI交接與版本還原提示詞.md`。

---

## 🔄 如何執行版本備份與還原

### 建立新版本備份
每次完成程式碼修改後，執行 `scripts/release_backup.py` 即可自動封存 `outputs/` 與 `pwa/` 至 `backups/` 並產生 `.zip` 與 `VERSION_MANIFEST.json`。

### 從任一歷史備份還原至 `outputs/`
若需將系統退回某個歷史版本（例如 `v2.1.0_2026-10-22_UI2.0-方案A零閃爍與新LOGO`），只需將該備份資料夾下 `outputs/*` 覆蓋回專案的 `outputs/` 目錄，再貼回 GAS 或推送至 GitHub 即可。

