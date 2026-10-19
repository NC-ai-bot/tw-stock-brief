# 台股晨報：日K增量更新（搭配 pipe.py；不修改 pipe.py）
#   python3 inc.py unpack                 kdata.json -> data/*.csv
#   python3 inc.py plan YYYY-MM-DD        依資料日 D 產生 quote_urls.txt（每行一個鉅亨報價網址，8 檔一組）
#                                         與 full.txt（需整檔兩段重抓：庫中沒有、筆數不足、輪替抽查）
#                                         與 gap.txt（庫中最後日期早於 D 的前一交易日，需短區間補抓）
#   python3 inc.py merge YYYY-MM-DD       讀 quotes/*.csv（sym,ts,o,h,l,c,v,amt,prev）把資料日 D 的 K 棒併入 data/*.csv，
#                                         讀 gapdata/CODE.csv（t,o,h,l,c,v 短區間）補缺漏日；寫 merge_report.txt
#   python3 inc.py pack                   data/*.csv -> kdata.json（只保留最近 160 根）
import sys, os, io, json, glob, datetime as dt
from zoneinfo import ZoneInfo
import pandas as pd

TZ = ZoneInfo('Asia/Taipei')
EXTRA = {'TSE01': 'INDEX', 'OTC01': 'INDEX', '0050': 'STOCK'}
KEEP = 400
ROTATE = 8          # 每天輪替整檔重抓幾檔，逐步汰換早期轉錄錯誤


def codes():
    u = pd.read_csv('universe.csv', dtype=str)
    return list(EXTRA) + list(u.code)


def sym(c):
    return f"TWS:{c}:{EXTRA.get(c, 'STOCK')}"


def day_t(d):
    d = pd.Timestamp(d)   # 鉅亨日K的 t 是該日 UTC 00:00
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp())


def read(code):
    p = f'data/{code}.csv'
    if not os.path.exists(p):
        return None, None
    txt = open(p, encoding='utf-8').read().replace('```csv', '').replace('```', '')
    name = next((l[1:].strip() for l in txt.splitlines() if l.startswith('#')), code)
    lines = [l for l in txt.splitlines() if l.strip() and not l.startswith('#')]
    df = pd.read_csv(io.StringIO('\n'.join(lines)))
    df = df[['t', 'o', 'h', 'l', 'c', 'v']].drop_duplicates('t', keep='last').sort_values('t', ascending=False)
    return name, df


def write(code, name, df):
    df = df.drop_duplicates('t', keep='last').sort_values('t', ascending=False).head(KEEP)
    with open(f'data/{code}.csv', 'w', encoding='utf-8') as f:
        f.write(f'# {name}\n')
        df.to_csv(f, index=False)


def tdate(t):
    return dt.datetime.fromtimestamp(int(t), TZ).date()


def unpack():
    os.makedirs('data', exist_ok=True)
    k = json.load(open('kdata.json', encoding='utf-8'))
    for c, txt in k['data'].items():
        open(f'data/{c}.csv', 'w', encoding='utf-8').write(txt)
    print('unpacked', len(k['data']), 'codes; last data date', k.get('last'))


def pack():
    out = {}
    last = None
    for c in codes():
        name, df = read(c)
        if df is None or not len(df):
            continue
        write(c, name, df)
        out[c] = open(f'data/{c}.csv', encoding='utf-8').read()
        if c == 'TSE01':
            last = str(tdate(df.t.max()))
    json.dump({'last': last, 'keep': KEEP, 'data': out}, open('kdata.json', 'w', encoding='utf-8'), ensure_ascii=False)
    print('packed', len(out), 'codes; last', last, '; bytes', os.path.getsize('kdata.json'))


def plan(D):
    D = pd.Timestamp(D).date()
    cal = cal_dates()
    prev = max([d for d in cal if d < D], default=None)
    allc = codes()
    full, gap, ok = [], [], []
    for c in allc:
        name, df = read(c)
        if df is None or len(df) < 120:
            full.append(c); continue
        last = tdate(df.t.max())
        if last >= D or last == prev:
            ok.append(c)
        else:
            gap.append(c)
    # 輪替抽查：依日期決定，跳過已在 full 的
    stock = [c for c in allc if c not in EXTRA and c not in full]
    if stock:
        start = (D.toordinal() * ROTATE) % len(stock)
        rot = [stock[(start + i) % len(stock)] for i in range(ROTATE)]
        full += [c for c in rot if c not in full]
    urls = [f"https://ws.api.cnyes.com/ws/api/v1/quote/quotes/{','.join(sym(c) for c in allc[i:i + 8])}"
            for i in range(0, len(allc), 8)]
    open('quote_urls.txt', 'w').write('\n'.join(urls) + '\n')
    open('full.txt', 'w').write('\n'.join(full))
    open('gap.txt', 'w').write('\n'.join(gap))
    print(f'D={D} prev={prev} | quote urls {len(urls)} | full {len(full)}: {" ".join(full)} | gap {len(gap)}: {" ".join(gap)}')


def cal_dates():
    # data/_cal.csv：加權指數短區間 t,c（由 WebFetch 存檔），用來判斷交易日
    if not os.path.exists('data/_cal.csv'):
        return []
    txt = open('data/_cal.csv').read().replace('```csv', '').replace('```', '')
    lines = [l for l in txt.splitlines() if l.strip() and l.strip()[0].isdigit()]
    return sorted({tdate(l.split(',')[0]) for l in lines})


def merge(D):
    D = pd.Timestamp(D).date()
    T = day_t(D)
    rep, applied, stale, mism, miss = [], 0, [], [], []
    rows = {}
    for f in sorted(glob.glob('quotes/*.csv')):
        txt = open(f, encoding='utf-8').read().replace('```csv', '').replace('```', '')
        for l in txt.splitlines():
            p = [x.strip() for x in l.split(',')]
            if len(p) < 9 or not p[0].startswith('TWS:'):
                continue
            rows[p[0].split(':')[1]] = p
    for c in codes():
        p = rows.get(c)
        name, df = read(c)
        if p is None:
            miss.append(c); continue
        try:
            ts = int(float(p[1])); o, h, l, cl = map(float, p[2:6])
            v = float(p[7] if EXTRA.get(c) == 'INDEX' else p[6]); prevc = float(p[8]) if p[8] else None
        except Exception:
            miss.append(c); continue
        if tdate(ts) != D:
            stale.append(f'{c}({tdate(ts)})'); continue
        if df is None:
            continue   # 庫中沒有 → 等整檔重抓
        old = df[df.t < T]
        if prevc and len(old):
            lc = float(old.sort_values('t').c.iloc[-1])
            if abs(lc - prevc) / prevc > 0.002:
                mism.append(f'{c}(庫{lc}/報價平盤{prevc})')
        new = pd.DataFrame([[T, o, h, l, cl, v]], columns=['t', 'o', 'h', 'l', 'c', 'v'])
        write(c, name, pd.concat([df[df.t != T], new]))
        applied += 1
    gapn = 0
    for f in glob.glob('gapdata/*.csv'):
        c = os.path.basename(f)[:-4]
        name, df = read(c)
        if df is None:
            continue
        txt = open(f, encoding='utf-8').read().replace('```csv', '').replace('```', '')
        lines = [l for l in txt.splitlines() if l.strip() and not l.startswith('#')]
        g = pd.read_csv(io.StringIO('\n'.join(lines)))[['t', 'o', 'h', 'l', 'c', 'v']]
        g = g[g.t.apply(lambda t: tdate(t) <= D)]
        write(c, name, pd.concat([df[~df.t.isin(g.t)], g]))
        gapn += 1
    rep.append(f'資料日 {D}：併入報價 {applied} 檔，補缺漏 {gapn} 檔')
    if miss: rep.append('報價缺漏：' + ' '.join(miss))
    if stale: rep.append('報價日期不是資料日（停牌或未成交）：' + ' '.join(stale))
    if mism: rep.append('前一日收盤與報價平盤價不符（可能除權息或庫存資料有誤，交給 validate 判斷）：' + ' '.join(mism))
    open('merge_report.txt', 'w').write('\n'.join(rep))
    print('\n'.join(rep))


if __name__ == '__main__':
    a = sys.argv
    {'unpack': lambda: unpack(), 'pack': lambda: pack(), 'plan': lambda: plan(a[2]), 'merge': lambda: merge(a[2])}[a[1]]()
