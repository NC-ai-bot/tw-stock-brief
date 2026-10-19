# 台股技術面選股晨報（tw-stock-brief）

「台股技術面選股晨報」的程式碼庫。原本程式以 `pipeline/*.txt` 的形式存放在晨報網頁
artifact（`https://claude.ai/artifact/WV3mXs9MbnsLWQxFYjcaHQ`）的附檔裡，由四個排程每次取回執行；
這個 repo 是搬遷的第一步：把程式納入 git 版本控制。

## 搬遷狀態

| 階段 | 內容 | 狀態 |
| --- | --- | --- |
| 1 | 程式原樣搬進 repo（逐位元組相同，SHA-256 與排程核准指紋一致） | ✅ 本次完成 |
| 2 | 排程改從 GitHub 取程式（取代從 artifact 讀 `pipeline/*.txt`），指紋改用 `pipeline/SHA256SUMS` | 待辦 |
| 3 | 改程式一律走 PR；artifact 只留資料（kdata.json、pool.json…）與網頁 | 待辦 |

> 排程目前**仍然**從 artifact 讀程式，這次搬遷不影響明早的晨報。

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
