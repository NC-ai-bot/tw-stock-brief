#!/usr/bin/env python3
"""除權息還原係數（FinMind TaiwanStockDividendResult）：給 app 的「還原日K」用。

用法：FINMIND_TOKEN=... python3 tools/export_divs.py <docs_dir> [--codes all|2330,...]
- 寫 docs/data/divs_all.json：{"updated": "...", "data": {"CODE": [[除權息日, 係數=參考價/前一日收盤, 現金+股票股利], ...]}}
- 係數套用方式：除權息日之前的所有價格 × 係數（向後還原），成交量 ÷ 係數。
- 增量：已有的代號只抓最後事件日之後的資料；--full 整批重抓。
"""
import csv, json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))
API = 'https://api.finmindtrade.com/api/v4/data'


def universe(root):
    with open(os.path.join(root, 'pipeline', 'universe.csv'), encoding='utf-8') as f:
        return [r['code'] for r in csv.DictReader(f)]


def fetch(code, start, token):
    q = urllib.parse.urlencode({'dataset': 'TaiwanStockDividendResult', 'data_id': code, 'start_date': start, 'token': token})
    req = urllib.request.Request(API + '?' + q, headers={'User-Agent': 'tw-stock-brief/1.0'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('msg') != 'success':
                raise RuntimeError(d.get('msg'))
            out = []
            for x in d.get('data') or []:
                try:
                    b, a = float(x['before_price']), float(x['after_price'])
                except (KeyError, TypeError, ValueError):
                    continue
                if b <= 0 or a <= 0:
                    continue
                f = a / b
                if not (0.02 < f < 0.9999):
                    continue
                out.append([x['date'], round(f, 6), float(x.get('stock_and_cache_dividend') or 0)])
            return out
        except Exception:
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return 1
    docs = args[0]; root = os.path.dirname(os.path.abspath(docs))
    token = os.environ.get('FINMIND_TOKEN', '')
    which = 'all'; full = '--full' in args
    for i, a in enumerate(args):
        if a == '--codes': which = args[i + 1]
    codes = (['0050'] + universe(root)) if which == 'all' else which.split(',')
    p = os.path.join(docs, 'data', 'divs_all.json')
    old = {}
    if os.path.exists(p) and not full:
        try: old = json.load(open(p, encoding='utf-8')).get('data', {})
        except Exception: old = {}
    data = dict(old); fail = []
    for c in codes:
        start = '2016-01-01'
        if c in old and old[c]:
            start = old[c][-1][0]
        try:
            rows = fetch(c, start, token)
        except Exception as e:
            fail.append(f'{c}: {e}'); continue
        ev = {r[0]: r for r in old.get(c, [])}
        for r in rows: ev[r[0]] = r
        data[c] = [ev[k] for k in sorted(ev)]
        time.sleep(0.3)
    json.dump({'updated': datetime.now(TPE).strftime('%Y-%m-%d %H:%M'), 'data': data}, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'ok {len(codes) - len(fail)}, failed {len(fail)}, events {sum(len(v) for v in data.values())}', *fail[:10], sep='\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
