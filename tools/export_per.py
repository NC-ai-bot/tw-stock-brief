#!/usr/bin/env python3
"""本益比河流圖資料（FinMind TaiwanStockPER）：給 app 的「本益比河流」用。

用法：FINMIND_TOKEN=... python3 tools/export_per.py <docs_dir> [--codes all|2330,...]
- 由每日本益比反推近四季每股盈餘：EPS = 收盤 ÷ 本益比（收盤取 docs/data/kl/CODE.json 的未還原價）。
- 以「月」為單位取中位數，只在 EPS 變動超過 1% 時記一筆（階梯函數），虧損或缺資料記 0。
- 寫 docs/data/per_all.json：{"updated": "...", "data": {"CODE": [[YYYY-MM-DD, eps], ...]}}。
- 每次整批從 2016 重抓（約 3 分鐘）；分割／大額股票股利後證交所 EPS 未重算的期間會用 divs_all.json 的係數修正。指數與 0050 不做。
"""
import csv, json, os, statistics, sys, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone

TPE = timezone(timedelta(hours=8))
API = 'https://api.finmindtrade.com/api/v4/data'


def universe(root):
    with open(os.path.join(root, 'pipeline', 'universe.csv'), encoding='utf-8') as f:
        return [r['code'] for r in csv.DictReader(f)]


def fetch(code, start, token):
    q = urllib.parse.urlencode({'dataset': 'TaiwanStockPER', 'data_id': code, 'start_date': start, 'token': token})
    req = urllib.request.Request(API + '?' + q, headers={'User-Agent': 'tw-stock-brief/1.0'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode('utf-8'))
            if d.get('msg') != 'success':
                raise RuntimeError(d.get('msg'))
            out = {}
            for x in d.get('data') or []:
                try:
                    per = float(x.get('PER') or 0)
                except (TypeError, ValueError):
                    per = 0
                out[x['date']] = per
            return out
        except Exception:
            if attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))


def monthly_eps(per, closes):
    """per: {date: PER}; closes: {date: close} → [[month-first-date, eps], ...] 階梯（變動 >1% 才記）"""
    bym = {}
    for d, p in per.items():
        c = closes.get(d)
        if not c:
            continue
        bym.setdefault(d[:7], []).append(c / p if p > 0 else 0.0)
    rows = []
    for m in sorted(bym):
        vals = bym[m]
        pos = [v for v in vals if v > 0]
        eps = statistics.median(pos) if len(pos) >= len(vals) / 2 else 0.0
        eps = round(eps, 3)
        if rows and (eps == rows[-1][1] or (eps > 0 and rows[-1][1] > 0 and abs(eps / rows[-1][1] - 1) <= 0.01)):
            continue
        rows.append([m + '-01', eps])
    return rows


def fix_splits(rows, events):
    """分割／大額股票股利（係數 < 0.8）後，證交所本益比的 EPS 往往要等下一季財報才會重算，
    反推的 EPS 會沿用分割前的值（本益比看起來突然變很低）。偵測：事件後第一個 EPS 與事件前相差不到 15% → 未重算，
    在事件日插入一階（× 係數），之後的 EPS 也乘上係數，直到出現一次接近係數的跳階（代表已重算）為止。"""
    for d, f, _ in events:
        if not (0 < f < 0.8):
            continue
        m = d[:7]
        before = [r for r in rows if r[0][:7] < m]
        if not before or before[-1][1] <= 0:
            continue
        base = before[-1][1]
        after = [r for r in rows if r[0][:7] >= m]
        first = after[0][1] if after else base
        if first <= 0 or abs(first / base - 1) > 0.15:
            continue  # 事件後已經差很多 → 已重算，不處理
        if not after or after[0][0][:7] != m:
            rows.append([d, base]); rows.sort(key=lambda r: r[0])
            after = [r for r in rows if r[0][:7] >= m]
        prev = base
        for r in after:
            v = r[1]
            if v <= 0:
                prev = v; continue
            if prev > 0 and abs(v / prev - f) <= 0.08:
                break  # 出現接近係數的跳階 → 已重算
            prev = v
            r[1] = round(v * f, 3)
    return rows


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); return 1
    docs = args[0]; root = os.path.dirname(os.path.abspath(docs))
    token = os.environ.get('FINMIND_TOKEN', '')
    which = 'all'
    for i, a in enumerate(args):
        if a == '--codes': which = args[i + 1]
    codes = universe(root) if which == 'all' else which.split(',')
    p = os.path.join(docs, 'data', 'per_all.json')
    dv = {}
    dp = os.path.join(docs, 'data', 'divs_all.json')
    if os.path.exists(dp):
        try: dv = json.load(open(dp, encoding='utf-8')).get('data', {})
        except Exception: dv = {}
    old = {}
    if os.path.exists(p) and which != 'all':
        try: old = json.load(open(p, encoding='utf-8')).get('data', {})
        except Exception: old = {}
    data = dict(old); fail = []
    for c in codes:
        klp = os.path.join(docs, 'data', 'kl', c + '.json')
        if not os.path.exists(klp):
            fail.append(f'{c}: no kl'); continue
        closes = {b[0]: b[4] for b in json.load(open(klp, encoding='utf-8'))['bars']}
        try:
            per = fetch(c, '2016-01-01', token)
        except Exception as e:
            fail.append(f'{c}: {e}'); continue
        data[c] = fix_splits(monthly_eps(per, closes), dv.get(c, []))
        time.sleep(0.25)
    json.dump({'updated': datetime.now(TPE).strftime('%Y-%m-%d %H:%M'), 'data': data}, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'ok {len(codes) - len(fail)}, failed {len(fail)}, steps {sum(len(v) for v in data.values())}', *fail[:10], sep='\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
