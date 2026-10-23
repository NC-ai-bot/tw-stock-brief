#!/usr/bin/env python3
"""盤中報價：抓證交所公開報價（約 5 秒延遲），只抓晨報 app 用得到的股票，寫成 docs/data/quotes.json。

用法：python3 tools/quotes.py [--force]
- 讀 docs/data/pool.json、pool_out.json、i1.json 決定要抓哪些股票（今日新增、觀察池持股、I1 模擬持股）加上加權／櫃買指數。
- 上市／上櫃用 pipeline/universe.csv 的 index 欄判斷（櫃買權值 → otc，其餘 → tse）。
- 報價沒有變化（沒有新的成交時間）就不改檔案，回傳碼 3；GitHub Actions 以此決定要不要 commit。
"""
import csv, json, os, sys, time, urllib.request, urllib.parse
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'docs', 'data')
OUT = os.path.join(DATA, 'quotes.json')
TPE = timezone(timedelta(hours=8))
MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp'


def load(name):
    p = os.path.join(DATA, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def exchange_map():
    m = {}
    p = os.path.join(ROOT, 'pipeline', 'universe.csv')
    with open(p, encoding='utf-8') as f:
        for r in csv.DictReader(f):
            m[r['code']] = 'otc' if '櫃買' in (r.get('index') or '') else 'tse'
    m['0050'] = 'tse'
    return m


def watchlist():
    """回傳 [{code, name, kinds:[...], cap, stop, entry, group}]（同一檔可能同時在多個名單）。"""
    items = {}

    def add(code, name, kind, **kw):
        it = items.setdefault(code, {'code': code, 'name': name, 'kinds': []})
        if kind not in it['kinds']:
            it['kinds'].append(kind)
        for k, v in kw.items():
            if v is not None:
                it[kind + '_' + k] = v

    po = load('pool_out.json') or {}
    for x in po.get('new') or []:
        add(x['code'], x['name'], 'new', cap=x.get('cap'), stop=x.get('stop_now'), ref=x.get('ref', x.get('entry')), group=x.get('group'))
    pool = load('pool.json') or {}
    for x in pool.get('positions') or []:
        if x.get('status') == 'pending':
            add(x['code'], x['name'], 'new', cap=x.get('cap'), stop=x.get('stop_now'), ref=x.get('ref', x.get('entry')), group=x.get('group'))
        else:
            add(x['code'], x['name'], 'pool', stop=x.get('stop_now'), entry=x.get('entry'), group=x.get('group'), days=x.get('days'))
    i1 = load('i1.json') or {}
    for x in i1.get('new') or []:
        add(x['code'], x['name'], 'i1new', cap=x.get('cap'), stop=x.get('stop_now'), ref=x.get('ref'))
    for x in i1.get('holding') or []:
        if x.get('status') == 'pending':
            add(x['code'], x['name'], 'i1new', cap=x.get('cap'), stop=x.get('stop_now'), ref=x.get('ref'))
        else:
            add(x['code'], x['name'], 'i1', stop=x.get('stop_now'), entry=x.get('entry'), days=x.get('days'))
    for x in po.get('exits') or []:
        add(x['code'], x['name'], 'exit', exit=x.get('exit'), ret=x.get('ret'))
    ext = load('ext.json') or {}
    for x in ext.get('list') or []:
        add(x['code'], x['name'], 'ext', close=x.get('close'))
    for x in ext.get('opens') or []:
        add(x['code'], x['name'], 'extopen', entry=x.get('entry'))
    return list(items.values())


def fetch(ex_ch):
    q = urllib.parse.urlencode({'ex_ch': ex_ch, 'json': '1', 'delay': '0', '_': str(int(time.time() * 1000))})
    req = urllib.request.Request(MIS + '?' + q, headers={
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Referer': 'https://mis.twse.com.tw/stock/index.jsp',
        'Accept-Language': 'zh-TW,zh;q=0.9',
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode('utf-8'))


def num(s):
    try:
        if s in (None, '', '-'):
            return None
        return float(s)
    except ValueError:
        return None


def first(s):
    """買賣五檔字串 '304.00_303.50_..._' 取第一檔。"""
    if not s:
        return None
    for part in s.split('_'):
        v = num(part)
        if v:
            return v
    return None


def parse(msg):
    code = msg.get('c')
    last = num(msg.get('z'))
    bid, ask = first(msg.get('b')), first(msg.get('a'))
    est = False
    if last is None:
        # 尚無成交（例如開盤前）：用買一／賣一中價當估計
        if bid and ask:
            last, est = round((bid + ask) / 2, 2), True
        elif bid or ask:
            last, est = (bid or ask), True
    prev = num(msg.get('y'))
    d = msg.get('d')
    t = msg.get('t')
    tlong = msg.get('tlong')
    ts = None
    if tlong and str(tlong).isdigit():
        ts = datetime.fromtimestamp(int(tlong) / 1000, TPE).strftime('%Y-%m-%d %H:%M:%S')
    out = {
        'code': code, 'name': msg.get('n'), 'last': last, 'est': est, 'prev': prev,
        'open': num(msg.get('o')), 'high': num(msg.get('h')), 'low': num(msg.get('l')),
        'vol': num(msg.get('v')), 'bid': bid, 'ask': ask, 'date': d, 'time': t, 'ts': ts,
    }
    if last is not None and prev:
        out['chg'] = round(last - prev, 2)
        out['chg_pct'] = round((last / prev - 1) * 100, 2)
    return out


def main():
    force = '--force' in sys.argv
    now = datetime.now(TPE)
    wl = watchlist()
    exm = exchange_map()
    syms = ['tse_t00.tw', 'otc_o00.tw'] + ['%s_%s.tw' % (exm.get(it['code'], 'tse'), it['code']) for it in wl]
    quotes = {}
    for i in range(0, len(syms), 20):
        batch = syms[i:i + 20]
        try:
            data = fetch('|'.join(batch))
        except Exception as e:
            print('fetch failed:', e, file=sys.stderr)
            continue
        for msg in data.get('msgArray') or []:
            q = parse(msg)
            if q.get('code'):
                quotes[q['code']] = q
        time.sleep(1)
    if not quotes:
        print('no quotes', file=sys.stderr)
        return 2

    idx = {k: quotes.pop(k) for k in ('t00', 'o00') if k in quotes}
    if 't00' in idx: idx['t00']['name'] = '加權指數'
    if 'o00' in idx: idx['o00']['name'] = '櫃買指數'
    items = []
    for it in wl:
        q = quotes.get(it['code'])
        row = dict(it)
        if q:
            row.update({k: v for k, v in q.items() if k not in ('code', 'name')})
            if not row.get('name'):
                row['name'] = q.get('name')
        items.append(row)

    today = now.strftime('%Y%m%d')
    dates = [q.get('date') for q in list(idx.values()) + list(quotes.values()) if q.get('date')]
    data_date = max(dates) if dates else None
    out = {
        'updated': now.strftime('%Y-%m-%d %H:%M'),
        'data_date': data_date,
        'market_open': data_date == today,
        'delay_note': '證交所公開報價，約 5 秒延遲；本檔每 5 分鐘更新一次，實際延遲約 5–10 分鐘',
        'index': idx,
        'items': items,
    }

    # 沒有新成交就不改檔（避免整天 commit 同樣內容）
    old = load('quotes.json')
    if old and not force:
        sig = lambda d: json.dumps({'i': {k: (v.get('ts'), v.get('last')) for k, v in d.get('index', {}).items()},
                                    'q': [(x.get('code'), x.get('ts'), x.get('last')) for x in d.get('items', [])]}, sort_keys=True)
        if sig(old) == sig(out):
            print('unchanged')
            return 3
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print('wrote', len(items), 'items, market_open=%s, data_date=%s' % (out['market_open'], data_date))
    return 0


if __name__ == '__main__':
    sys.exit(main())
