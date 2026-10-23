#!/usr/bin/env python3
"""把晨報用到的股票日K（除權息還原後）匯出成 app 用的小檔案。

用法：python3 tools/export_k.py <data_dir> <docs_dir> [bars]
- data_dir：排程工作目錄裡的 data/（adj.py apply 之後、還原後價格），每檔 CODE.csv：第一行「# 名稱」，第二行 t,o,h,l,c,v。
- docs_dir：repo 的 docs/；會讀 docs/data/*.json 決定要匯出哪些代號（今日新增、觀察池持股、已結算、I1、趨勢延續、歷史入選）加上 TSE01、0050，
  寫到 docs/data/k/CODE.json（最近 bars 根，預設 180）與 docs/data/k/index.json。
- 不在名單內的舊檔會刪除，避免 repo 無限長大。
"""
import csv, io, json, os, sys
from datetime import datetime, timezone, timedelta

TPE = timezone(timedelta(hours=8))


def load(docs, name):
    p = os.path.join(docs, 'data', name)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def wanted(docs):
    codes = ['TSE01', '0050']
    def add(lst, key='code'):
        for x in lst or []:
            c = x.get(key) if isinstance(x, dict) else None
            if c and c not in codes:
                codes.append(c)
    po = load(docs, 'pool_out.json') or {}
    add(po.get('new')); add(po.get('holding')); add(po.get('exits')); add(po.get('unfilled'))
    pool = load(docs, 'pool.json') or {}
    add(pool.get('positions')); add(pool.get('closed'))
    i1 = load(docs, 'i1.json') or {}
    add(i1.get('new')); add(i1.get('holding')); add(i1.get('exits')); add(i1.get('top'))
    ext = load(docs, 'ext.json') or {}
    add(ext.get('list')); add(ext.get('opens'))
    hist = load(docs, 'history.json') or []
    add(sorted(hist, key=lambda x: x.get('date', ''), reverse=True)[:60])
    return codes


def read_csv(path):
    txt = open(path, encoding='utf-8').read().replace('```csv', '').replace('```', '')
    name = next((l[1:].strip() for l in txt.splitlines() if l.startswith('#')), None)
    lines = [l for l in txt.splitlines() if l.strip() and not l.startswith('#')]
    rows = []
    for r in csv.DictReader(io.StringIO('\n'.join(lines))):
        try:
            t = int(float(r['t']))
            d = datetime.fromtimestamp(t, timezone.utc).astimezone(TPE).strftime('%Y-%m-%d')
            rows.append([d, float(r['o']), float(r['h']), float(r['l']), float(r['c']), float(r['v'] or 0)])
        except (KeyError, ValueError):
            continue
    rows.sort(key=lambda x: x[0])
    # 同一天只留最後一筆
    out = {}
    for x in rows:
        out[x[0]] = x
    return name, [out[k] for k in sorted(out)]


def main():
    if len(sys.argv) < 3:
        print(__doc__); return 1
    data, docs = sys.argv[1], sys.argv[2]
    bars = int(sys.argv[3]) if len(sys.argv) > 3 else 180
    kdir = os.path.join(docs, 'data', 'k')
    os.makedirs(kdir, exist_ok=True)
    codes = wanted(docs)
    index, keep = [], set()
    for c in codes:
        p = os.path.join(data, f'{c}.csv')
        if not os.path.exists(p):
            continue
        name, rows = read_csv(p)
        if not rows:
            continue
        rows = rows[-bars:]
        with open(os.path.join(kdir, f'{c}.json'), 'w', encoding='utf-8') as f:
            json.dump({'code': c, 'name': name or c, 'adj': True, 'bars': rows}, f, ensure_ascii=False, separators=(',', ':'))
        keep.add(f'{c}.json')
        index.append({'code': c, 'name': name or c, 'last': rows[-1][0], 'n': len(rows)})
    for fn in os.listdir(kdir):
        if fn.endswith('.json') and fn != 'index.json' and fn not in keep:
            os.remove(os.path.join(kdir, fn))
    with open(os.path.join(kdir, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump({'updated': datetime.now(TPE).strftime('%Y-%m-%d %H:%M'), 'items': index}, f, ensure_ascii=False, indent=1)
    print('exported', len(index), 'codes to', kdir)
    return 0


if __name__ == '__main__':
    sys.exit(main())
