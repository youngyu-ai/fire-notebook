# 🤖 消防小本本（Fire Notebook）— 跨 AI 新對話視窗無縫接軌＆版本還原提示詞指南

本文件專為**「開啟任何新的 AI 對話視窗（Antigravity / Codex / Claude / Cursor / ChatGPT 等）」**時設計。  
您只需要複製下方對應情境的提示詞（Prompt）貼給新視窗的 AI，AI 就能在 10 秒內完整掌握本專案的所有背景、架構、網址、安全規範與備份版本，無縫接續開發！

---

## 📌 情境一：在新對話視窗「直接接續最新進度」繼續開發

> **使用時機**：當對話太長想開新視窗，或換一個 AI 助手繼續開發最新功能時，**直接整段複製下方文字貼給 AI**：

```markdown
請接手維護與開發我的專案「消防小本本（Fire Notebook — 消防電子公文暨業務檔案管理系統）」。

在開始回答或修改任何程式碼之前，請先依序讀取以下檔案以完整掌握專案現況：
1. 專案總覽與歷次變更紀錄：`C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\README.md`
2. 備份版本索引檔：`C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\backups\versions.json`
3. 目前最新交付目錄：`C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\outputs\`（包含 `Code.gs`、`Index.html` 與圖示檔）及（若有）`pwa\` 目錄。

請嚴格遵守本專案的固定開發規範：
1. 全程使用「繁體中文」溝通與撰寫註解。
2. 絕對不可刪除或破壞我 Google Sheets 既有案件資料、Google Drive 既有資料夾及 Google Tasks（消防）清單內容。
3. 注意 `Code.gs` 中 `HtmlService.setFaviconUrl()` 不支援 `data:` URI（會拋出網站小圖示圖片類型不受支援例外），請勿在 `setFaviconUrl` 填入 `data:`。
4. 每當完成一個新版本並經我確認可上線時，你必須自動：
   - 呼叫 `scripts/release_backup.py` 在 `backups/` 建立新版本的完整快照資料夾與 `.zip` 壓縮檔；
   - 在 `README.md`（並同步至 `outputs/README.md`）更新最新版本号與 Changelog 紀錄；
   - 若已啟用 Git / GitHub Pages，請自動幫我 commit 並 push 上線；若需貼回 GAS，請將內容放入我的 Windows 剪貼簿（`Set-Clipboard`）。

讀完上述檔案後，請向我簡短回報：
1. 你讀到的目前最新版本號與最後一次更新內容；
2. 確認你已準備好，並詢問我今天想新增或調整什麼功能。
```

---

## ⏪ 情境二：在新對話視窗「讀取／還原某一個指定備份版本」無縫接軌

> **使用時機**：如果某次改版後覺得不習慣，或是想指定從 `backups/` 裡的某一個特定歷史版本（例如 `v2.1.0`）重新出發，**複製下方文字貼給 AI（可將 `v2.1.0` 改成您想指定的版本號）**：

```markdown
請接手我的專案「消防小本本（Fire Notebook）」，並以我指定的歷史備份版本【v2.1.0】（若我寫「最新備份」則取 `backups/versions.json` 第一筆）作為基準版本無縫接軌。

請先依序執行以下步驟：
1. 讀取 `C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\README.md` 與 `C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\backups\versions.json`。
2. 找到 `backups\` 目錄下對應【v2.1.0】的備份資料夾（讀取其中的 `VERSION_MANIFEST.json`、`outputs\Code.gs`、`outputs\Index.html` 及相關檔案）。
3. 比較該備份版本與目前 `C:\Users\yshai\Documents\Codex\2026-10-20\gas-web-app-google-apps-script\outputs\` 現有檔案是否有差異，並向我報告：
   - 該備份版本的建立時間、包含檔案與功能重點；
   - 詢問我是要「直接將該備份版本還原覆蓋回 `outputs/` 並部署上線」，還是「以該備份版本的程式碼為基礎，開始進行新的修改」。

請全程使用繁體中文，並在每次定版後自動執行 `scripts/release_backup.py` 備份與更新 `README.md`。
```

---

## 📦 情境三：當次修改完成後的「一鍵收尾指令」

> **使用時機**：當您在對話中跟 AI 討論並測試完新功能，準備定版收尾時，只需對 AI 說這句話：

```markdown
這個版本 OK！請幫我執行標準定版流程：
1. 自動遞增版本號並執行 `scripts/release_backup.py` 建立 `backups/` 版本快照與 `.zip`；
2. 更新 `README.md` 與 `outputs/README.md` 的版本紀錄（Changelog）；
3. 幫我部署上線（自動推送到 GitHub Pages，若 `Code.gs` / `Index.html` 有變更請同步幫我放進剪貼簿或更新）。
```

---

## 🗂️ 目前已封存之備份版本快速對照表

> 詳細檔案雜湊（SHA-256）與清單由系統自動維護於 [`backups/versions.json`](file:///C:/Users/yshai/Documents/Codex/2026-10-20/gas-web-app-google-apps-script/backups/versions.json)

| 版本號 | 建立日期 | 備份資料夾名稱 | 核心特色摘要 |
| :--- | :--- | :--- | :--- |
| **`v2.4.1`** | `2026-10-25` | `v2.4.1_2026-10-25_修復手機版標籤類別下拉選單點擊無反應` | 修復手機介面「標籤類別」與「執行狀態」單行滾輪點擊無反應，整合原生下拉滾輪觸發層（點擊即開選單）＋加強建檔標籤下拉支援 |
| **`v2.4.0`** | `2026-10-22` | `v2.4.0_2026-10-22_手機版C2單行滾輪篩選與待辦說明彈窗` | 手機版方案 C2 單行極簡內嵌上下滾輪（40px 高，支援直接上下撥動與 ▲/▼ 微調，預設全部）＋ 待辦事項 `ⓘ 說明` 彈跳視窗 |
| **`v2.3.0`** | `2026-10-22` | `v2.3.0_2026-10-22_0.05秒瞬開快取與後端IO瘦身` | 方案 1 本機 `localStorage` 0.05 秒瞬開快取＋頂部同步呼吸燈（`雲端同步中…` → `已同步最新`）＋ 方案 2 後端 `Code.gs` 零副作用 I/O 瘦身 |
| **`v2.2.2`** | `2026-10-22` | `v2.2.2_2026-10-22_修正歷史年度獨立篩選顯示` | 修正選擇歷史年度（如 2024）時混入其他年度公文問題，改為嚴格僅顯示該年度公文與統計 |
| **`v2.2.1`** | `2026-10-22` | `v2.2.1_2026-10-22_修復手機Chrome多帳號Cookie衝突與Tasks讀取` | 修復手機版 Chrome 多帳號 Cookie 衝突（`credentials: 'omit'`＋防快取＋自動重試） |
| **`v2.2.0`** | `2026-10-22` | `v2.2.0_2026-10-22_GitHub-Pages-PWA與信任裝置密碼鎖` | 升級 GitHub Pages 標準 PWA、首次開啟通行密碼驗證（信任裝置記憶）、`Code.gs` 新增 `doPost(e)` API 與母資料夾自癒 |
| **`v2.1.0`** | `2026-10-22` | `v2.1.0_2026-10-22_UI2.0-方案A零閃爍與新LOGO` | UI 2.0 正式版、方案 A 自然捲動（100% 零閃爍）、救護包公文夾新 LOGO、預設載入當年度全部案件＋跨年未結案、手機版 Bottom Sheet 與淺色說明輸入框 |

