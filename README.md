# 台股技術面選股晨報（tw-stock-brief）

「台股技術面選股晨報」的程式碼庫。原本程式以 `pipeline/*.txt` 的形式存放在晨報網頁
artifact（`https://claude.ai/artifact/WV3mXs9MbnsLWQxFYjcaHQ`）的附檔裡，由四個排程每次取回執行；
現在程式的正本在這個 repo，網頁附檔是發布處。

## 搬遷狀態

| 階段 | 內容 | 狀態 |
| --- | --- | --- |
| 1 | 程式原樣搬進 repo（逐位元組相同，SHA-256 與排程核准指紋一致） | ✅ 完成 |
| 2 | GitHub 當正本、網頁附檔當發布處；加上 `tools/check_sync.py` 核對兩邊一致 | ✅ 完成 |

排程**不直接**從 GitHub 取程式：排程執行時 shell 不能連網，WebFetch 回傳的內容又會經過模型整理、
無法保證逐位元組相同，指紋比對會失敗。所以排程維持從網頁附檔讀程式，GitHub 負責版本紀錄與審核。

## 修改程式的流程

1. **在 GitHub 改**：開分支修改 `pipeline/*.py`，同時更新 `pipeline/SHA256SUMS`
   （`cd pipeline && sha256sum pipe.py pool.py inc.py adj.py weekly_pdf.py supertrend.py > SHA256SUMS`），開 PR 審核後合併。
2. **發布到網頁**：把合併後的 `pipeline/X.py` 上傳成晨報網頁的 `pipeline/X.txt`
   （只上傳有改的檔案，不動網頁其他附檔與畫面）。
3. **更新排程指紋**：四個排程的說明裡寫死了核准指紋，把改過的檔案的新指紋換上去：

   | 程式 | 用到的排程 |
   | --- | --- |
   | pipe.py、pool.py、inc.py | 夜間資料更新、晨報、週報 |
   | adj.py | 夜間資料更新 |
   | weekly_pdf.py、supertrend.py | 週報 |

4. **核對**：用 Artifact read 取回網頁的 `pipeline/*.txt` 到某個目錄，執行
   `python3 tools/check_sync.py 該目錄`，六支程式都顯示「一致」才算發布完成。

步驟 2、3 要一起做、而且避開排程執行時段（07:29、13:51、21:51、週六 11:50 前後）；
只做其中一個，下一次排程會因指紋不符而停止並推播通知。

**不要直接改網頁上的 `pipeline/*.txt`**，否則 GitHub 的版本紀錄就不完整；
`check_sync.py` 顯示「網頁附檔與 repo 不同」就代表兩邊已經分岔。

## 目錄

```
pipeline/
  pipe.py         主程式：validate / market / screen / track / build（晨報 PDF）/ page（網頁）
  pool.py         觀察池：plan / commit / weekly（週六滾動式優化）、超級趨勢與回測
  inc.py          日K增量更新：unpack / plan / merge / pack（kdata.json ⇄ data/*.csv）
  adj.py          除權息還原：need / ingest / apply / pack
  weekly_pdf.py   週報 PDF
  supertrend.py   超級趨勢研究（週報第 4 頁）
  universe.csv    股票池：台灣50、中型100、櫃買權值共 198 檔
  strategy.json   策略參數快照（2026-10-17，第 3 版 H7）；正式版本仍由週六排程寫回 artifact
  SHA256SUMS      使用者核准版本的程式指紋
tools/
  check_sync.py   核對網頁附檔與 repo 程式是否一致
```

程式內檔名對應：artifact 上的 `pipeline/pipe.txt` = 這裡的 `pipeline/pipe.py`，其餘同理。

## 指紋驗證

```sh
cd pipeline && sha256sum -c SHA256SUMS
```

## 執行環境

- Python 3.11+，`pip install -r requirements.txt`；週報要 `playwright` 的 Chromium。
- 字型：`/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`（圖表）、`/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc`（晨報 PDF）。
- `pdftoppm`（poppler-utils）用來檢查 PDF 與產生網頁頁面圖。
- 程式本身不連網；所有網路資料（鉅亨、證交所、HiStock、集保）由排程用 WebFetch 抓好存成 CSV 再交給程式。

## 排程（台北時間）

| 排程 | 時間 | 做什麼 | 用到的程式 |
| --- | --- | --- | --- |
| 台股晨報夜間資料更新 | 週一～五 21:51 | 更新日K、除權息還原、證交所籌碼、觀察池候選與候選股基本面，暫存成 `pipeline/kdata.json`、`divs.json`、`eve.json`；不寄信 | inc、pipe、adj、pool |
| 台股技術面選股晨報 | 週一～五 07:29 | 暫存有效走「暫存流程」（只補國際盤、夜盤），否則走完整流程；結算觀察池、產出 PDF、更新網頁、寄信 | inc、pipe、pool |
| 晨報觀察池收盤追蹤 | 週一～五 13:51 | 用當日收盤計算池內損益與停損距離並寄信 | （不跑程式，只讀 pool.json） |
| 晨報週報 | 週六 11:50 | `pool.py weekly` 滾動式優化、`supertrend.py study`、H7 試用期鎖定、週報 PDF、寄信 | pipe、pool、inc、weekly_pdf、supertrend |

### 每日資料流

```
夜間 21:51                                   早上 07:29
inc.py unpack ─► WebFetch 報價/日K ─► inc.py merge        inc.py unpack ─► 判斷暫存是否有效
   ─► pipe.py validate ─► adj.py need/ingest/apply           ─► pipe.py market ─► pool.py plan
   ─► pipe.py market ─► pool.py plan                         ─► pool.py commit ─► pipe.py track
   ─► adj.py pack ─► 上傳 kdata.json / eve.json              ─► pipe.py build / page ─► inc.py pack
                                                             ─► 發布網頁、Gmail 寄信
```

`kdata.json` 一律存**原始（未還原）**價格；還原只在 `adj.py apply` 時套用到 `data/`。

## 晨報 app（`docs/`，GitHub Pages）

網址：https://nc-ai-bot.github.io/tw-stock-brief/ ，手機開啟後「加入主畫面」就是 app（PWA，可離線看上次的內容）。
app 只讀 `docs/data/*.json`，選股邏輯一律在排程裡算好；`docs/report.pdf` 是今日 PDF，`docs/archive/YYYYMMDD.pdf` 是歷史 PDF（有才顯示）。

| 檔案 | 來源（排程產出的同名檔） | 內容 |
| --- | --- | --- |
| `data/meta.json` | meta.json | report_date、data_date、file_date、notes |
| `data/market.json` | market.json | 加權／櫃買指數狀態 |
| `data/market_analysis.json` | market_analysis.json | summary／tech／chips／intl／plan |
| `data/pool_out.json` | pool_out.json | 今日新增（含 cap、lot、status）、出場、續抱、風險、unfilled、summary、ev |
| `data/pool.json` | pool.json | positions、closed、equity |
| `data/history.json` | history.json | 歷史入選 |
| `data/archive.json` | archive.json | 歷史晨報清單 |
| `data/i1.json` | i1.json | I1 測試名單 |
| `data/ext.json` | ext.json | 趨勢延續觀察 |
| `data/quotes.json` | tools/quotes.py（GitHub Actions 每 5 分鐘） | 盤中報價：加權、櫃買與名單內各檔 |
| `data/k/CODE.json` | tools/export_k.py（排程，adj.py apply 之後） | 入選股票最近 180 根還原日K |
| `data/kl/CODE.json` | tools/export_kl.py（FinMind；排程每天補名單、週五補全部） | 股票池 199 檔＋兩指數 2016 起未還原日K，供週／月／年K |
| `guide.pdf` | 手動（_guide/guide.html → Chromium 列印） | 使用說明 |

自動更新：21:51 夜間排程推晚上版、07:29 晨報排程推正式版（含當天 archive PDF 與清理 60 份以外的舊檔）、08:40 備援排程在觸發備援時再推一次；三個排程都以 add_repo（push）＋ git clone/commit/push 寫入 docs/。
