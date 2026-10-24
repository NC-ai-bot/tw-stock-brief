#!/usr/bin/env python3
"""長期日K（未還原、FinMind）：給 app 的週K／月K／年K用。

用法：FINMIND_TOKEN=... python3 tools/export_kl.py <docs_dir> [--codes all|watch|2330,2454,...] [--since 2016-01-01]
- 寫 docs/data/kl/CODE.json：{"code","name","adj":false,"bars":[[date,o,h,l,c,v張],...]}，另寫 kl/index.json。
- all：pipeline/universe.csv 全部 ＋ TSE01（TAIEX）、OTC01（TPEx）、0050。
- watch：docs/data/k/index.json 列出的代號（晨報目前用到的）。
- 已存在的檔案只補最後日期之後的資料（增量），--full 強制整檔重抓。
"""
import csv, json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))
API = 'https://api.finmindtrade.com/api/v4/data'
ALIAS = {'TSE01': 'TAIEX', 'OTC01': 'TPEx'}
NAMES = {'TSE01': '加權指數', 'OTC01': '櫃買指數', '0050': '元大台灣50'}


def universe(root):
    out = []
    with open(os.path.join(root, 'pipeline', 'universe.csv'), encoding='utf-8') as f:
        for r in csv.DictReader(f):
            out.append((r['code'], r['name']))
    return out


def fetch(code, start, token):
    q = urllib.parse.urlencode({'dataset': 'TaiwanStockPrice', 'data_id': ALIAS.get(code, code), 'start_date': start, 'token': token})
    req = urllib.request.Request(API + '?' + q, headers={'User-Agent': 'tw-stock-brief/1.0'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('msg') != 'success':
                raise RuntimeError(d.get('msg'))
            rows = []
            for x in d.get('data') or []:
                try:
                    o, h, l, c = float(x['open']), float(x['max']), float(x['min']), float(x['close'])
                except (KeyError, TypeError, ValueError):
                    continue
                if not (o and h and l and c):
                    continue
                v = float(x.get('Trading_Volume') or 0)
                v = round(v / 1000, 1)   # 股 → 張（指數亦同）
                rows.append([x['date'], o, h, l, c, v])
            return rows
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return 1
    docs = args[0]
    root = os.path.dirname(os.path.abspath(docs))
    token = os.environ.get('FINMIND_TOKEN', '')
    which = 'watch'; since = '2016-01-01'; full = '--full' in args
    for i, a in enumerate(args):
        if a == '--codes': which = args[i + 1]
        if a == '--since': since = args[i + 1]
    uni = universe(root)
    names = dict(uni); names.update(NAMES)
    if which == 'all':
        codes = ['TSE01', 'OTC01', '0050'] + [c for c, _ in uni]
    elif which == 'watch':
        p = os.path.join(docs, 'data', 'k', 'index.json')
        codes = ['TSE01', 'OTC01', '0050'] + [x['code'] for x in (json.load(open(p, encoding='utf-8'))['items'] if os.path.exists(p) else [])]
        codes = list(dict.fromkeys(codes))
    else:
        codes = which.split(',')
    kdir = os.path.join(docs, 'data', 'kl'); os.makedirs(kdir, exist_ok=True)
    ok, fail = 0, []
    for c in codes:
        p = os.path.join(kdir, f'{c}.json')
        old = None
        if os.path.exists(p) and not full:
            try:
                old = json.load(open(p, encoding='utf-8'))
            except Exception:
                old = None
        start = since
        if old and old.get('bars'):
            start = old['bars'][-1][0]   # 從最後一天重抓（覆蓋同日）
        try:
            rows = fetch(c, start, token)
        except Exception as e:
            fail.append(f'{c}: {e}'); continue
        bars = {b[0]: b for b in (old['bars'] if old else [])}
        for b in rows:
            bars[b[0]] = b
        allb = [bars[k] for k in sorted(bars)]
        if not allb:
            fail.append(f'{c}: no data'); continue
        with open(p, 'w', encoding='utf-8') as f:
            json.dump({'code': c, 'name': names.get(c, c), 'adj': False, 'src': 'FinMind', 'bars': allb}, f, ensure_ascii=False, separators=(',', ':'))
        ok += 1
        time.sleep(0.4)
    idx = []
    for fn in sorted(os.listdir(kdir)):
        if fn.endswith('.json') and fn != 'index.json':
            try:
                d = json.load(open(os.path.join(kdir, fn), encoding='utf-8'))
                idx.append({'code': d['code'], 'name': d.get('name'), 'first': d['bars'][0][0], 'last': d['bars'][-1][0], 'n': len(d['bars'])})
            except Exception:
                pass
    json.dump({'updated': datetime.now(TPE).strftime('%Y-%m-%d %H:%M'), 'items': idx}, open(os.path.join(kdir, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'ok {ok}, failed {len(fail)}', *fail[:10], sep='\n')
    return 0 if ok else 2


if __name__ == '__main__':
    sys.exit(main())
