#!/usr/bin/env python3
"""補抓某一天全股票池的 1 分鐘分時（鉅亨 charting API），輸出 app 用的 data/tl 格式。

用法：python3 tools/backfill_tl.py 20261022 out.json
格式：{"<code>": [["HH:MM:00", close, cumVol], ...], "TSE01": [...], "OTC01": [...], "_date": "YYYYMMDD"}
（指數成交量填 0。沙盒連不到鉅亨，這支是給 GitHub Actions 跑的。）
"""
import json, sys, time, datetime, zoneinfo, urllib.request, urllib.parse

TZ = zoneinfo.ZoneInfo('Asia/Taipei')
API = 'https://ws.api.cnyes.com/ws/api/v1/charting/history'

def fetch(symbol, day):
    d = datetime.datetime.strptime(day, '%Y%m%d').replace(tzinfo=TZ)
    frm = int((d + datetime.timedelta(hours=14, minutes=40)).timestamp())  # 鉅亨的 from/to 是反的：from 放較晚的時間
    to = int((d + datetime.timedelta(hours=8, minutes=46)).timestamp())
    url = f'{API}?{urllib.parse.urlencode({"symbol": symbol, "resolution": 1, "quote": 1, "from": frm, "to": to})}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.cnyes.com', 'Referer': 'https://www.cnyes.com/'})
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                j = json.load(r)
            data = j.get('data') or {}
            ts, cs, vs = data.get('t') or [], data.get('c') or [], data.get('v') or []
            rows = []
            for t, c, v in zip(ts, cs, vs):
                dt = datetime.datetime.fromtimestamp(t, TZ)
                if dt.strftime('%Y%m%d') != day or c is None:
                    continue
                rows.append((dt.strftime('%H:%M:00'), float(c), float(v or 0)))
            rows.sort()
            return rows
        except Exception as e:
            print(f'  {symbol} 第 {i + 1} 次失敗：{e}', file=sys.stderr)
            time.sleep(2 * (i + 1))
    return []

def main():
    day, out = sys.argv[1], sys.argv[2]
    uni = json.load(open('docs/data/universe.json'))
    res = {'_date': day}
    targets = [(c, f'TWS:{c}:STOCK', True) for c in uni] + [('TSE01', 'TWS:TSE01:INDEX', False), ('OTC01', 'TWS:OTC01:INDEX', False)]
    for code, sym, is_stock in targets:
        rows = fetch(sym, day)
        if not rows:
            print(f'{code}: 無資料', file=sys.stderr); continue
        cum = 0.0; arr = []
        for hm, c, v in rows:
            cum += v
            arr.append([hm, round(c, 2), int(round(cum)) if is_stock else 0])
        res[code] = arr
        print(f'{code}: {len(arr)} 筆，收 {arr[-1][1]}', file=sys.stderr)
        time.sleep(0.25)
    json.dump(res, open(out, 'w'), separators=(',', ':'), ensure_ascii=False)
    print(f'完成：{len(res) - 1} 檔 → {out}', file=sys.stderr)

if __name__ == '__main__':
    main()
