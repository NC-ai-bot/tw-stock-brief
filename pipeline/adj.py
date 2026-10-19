# 台股晨報：除權息還原（搭配 inc.py / pipe.py；不修改它們）
#   python3 adj.py apply     先把原始日K備份到 data_raw/，再依 divs.json 對 data/*.csv 做向後還原（事件日之前的價量乘以還原因子）
#                            同時自動判定面額變更／分割（單日開盤跌逾 30% 且接近整數分割比）；結果寫 adj_report.txt
#                            可重複執行：每次都從 data_raw/ 的原始資料重算
#   python3 adj.py pack      用 data_raw/ 的「原始」日K打包 kdata.json（取代 inc.py pack；資料庫永遠存原始價）
#   python3 adj.py need      列出需要補查股利的代號 → div_need.txt（merge_report 的平盤價不符、原始資料仍有單日跳空 >10.5% 且 divs.json 沒有對應事件）
#   python3 adj.py ingest    讀 divnew/CODE.csv（ex_date,cash,stock）併入 divs.json
# divs.json 格式：{"CODE": [["YYYY-MM-DD", 現金股利, 股票股利(元)], ...]}
import sys, os, io, json, glob, shutil, datetime as dt
import pandas as pd

TZ = dt.timezone(dt.timedelta(hours=8))


def read(path):
    txt = open(path, encoding='utf-8').read().replace('```csv', '').replace('```', '')
    name = next((l[1:].strip() for l in txt.splitlines() if l.startswith('#')), os.path.basename(path)[:-4])
    lines = [l for l in txt.splitlines() if l.strip() and not l.startswith('#')]
    df = pd.read_csv(io.StringIO('\n'.join(lines)))[['t', 'o', 'h', 'l', 'c', 'v']]
    df = df.drop_duplicates('t', keep='last').sort_values('t').reset_index(drop=True)
    df['d'] = [dt.datetime.fromtimestamp(int(t), TZ).date() for t in df.t]
    return name, df


def write(path, name, df):
    with open(path, 'w', encoding='utf-8') as f:
        f.write(f'# {name}\n')
        df.sort_values('t', ascending=False)[['t', 'o', 'h', 'l', 'c', 'v']].to_csv(f, index=False)


def load_divs():
    return json.load(open('divs.json', encoding='utf-8')) if os.path.exists('divs.json') else {}


def adjust(df, events, code, rep):
    applied = []
    for ex, cash, stock in sorted(events):
        cash = float(cash or 0); stock = float(stock or 0)
        if cash == 0 and stock == 0: continue
        exd = pd.Timestamp(ex).date()
        idx = df.index[(df.d >= exd) & (df.d <= exd + dt.timedelta(days=4))]   # 資料庫缺當天或遇休市時順延到下一個交易日
        if not len(idx) or idx[0] == 0: continue                                # 超出資料範圍
        i = idx[0]; prev = df.c.iloc[i - 1]
        ref = (prev - cash) / (1 + stock / 10); f = ref / prev; o = df.o.iloc[i]
        if not (0.05 < f < 0.9995) or abs(o / ref - 1) > 0.105:
            rep.append(f'{code} {ex} 現金{cash} 股票{stock}：參考價 {ref:.2f} 與開盤 {o} 不符，未還原'); continue
        fs = 1 / (1 + stock / 10)
        for k in 'ohlc': df.loc[:i - 1, k] = df.loc[:i - 1, k] * f
        df.loc[:i - 1, 'v'] = df.loc[:i - 1, 'v'] / fs
        applied.append(f'{df.d[i]}:{f:.4f}')
    for j in df.index[1:]:                                                     # 面額變更／分割
        prev, o = df.c[j - 1], df.o[j]
        if o / prev < 0.7:
            for k in (2, 3, 4, 5, 10, 20):
                if abs(o / (prev / k) - 1) <= 0.105:
                    for x in 'ohlc': df.loc[:j - 1, x] = df.loc[:j - 1, x] / k
                    df.loc[:j - 1, 'v'] = df.loc[:j - 1, 'v'] * k
                    applied.append(f'{df.d[j]}:split1/{k}'); rep.append(f'{code} {df.d[j]} 判定為面額變更／分割 1→{k}'); break
    return applied


def apply():
    if not os.path.isdir('data_raw'):
        shutil.copytree('data', 'data_raw')
    else:   # 已備份過：data_raw/ 是原始資料，把 data/ 中較新的（例如剛重抓的）檔案同步回 data_raw/
        for p in glob.glob('data/*.csv'):
            q = 'data_raw/' + os.path.basename(p)
            if not os.path.exists(q) or os.path.getmtime(p) > os.path.getmtime(q) + 1: shutil.copy2(p, q)
    divs = load_divs(); rep = []; n = 0; ev = 0
    for p in glob.glob('data_raw/*.csv'):
        code = os.path.basename(p)[:-4]
        if code.startswith('_'): continue
        try: name, df = read(p)
        except Exception as e: rep.append(f'{code} 讀取失敗 {e}'); continue
        a = adjust(df, divs.get(code, []), code, rep)
        if a:
            for k in 'ohlc': df[k] = df[k].round(4)
            n += 1; ev += len(a)
        write('data/' + os.path.basename(p), name, df)
        os.utime('data/' + os.path.basename(p), (os.path.getatime(p), os.path.getmtime(p)))
    open('adj_report.txt', 'w', encoding='utf-8').write('\n'.join(rep))
    print(f'除權息還原：{n} 檔、{ev} 個事件；未還原或特殊 {len(rep)} 筆（見 adj_report.txt）')


def pack():
    import inc
    if not os.path.isdir('data_raw'):
        inc.pack(); return
    for p in glob.glob('data/*.csv'):     # 還原後才重抓的檔案以 data/ 為準同步回原始資料
        q = 'data_raw/' + os.path.basename(p)
        if not os.path.exists(q) or os.path.getmtime(p) > os.path.getmtime(q) + 1: shutil.copy2(p, q)
    os.rename('data', 'data_adj'); os.rename('data_raw', 'data')
    try:
        inc.pack()
    finally:
        os.rename('data', 'data_raw'); os.rename('data_adj', 'data')


def need():
    divs = load_divs(); codes = set()
    if os.path.exists('merge_report.txt'):
        for l in open('merge_report.txt', encoding='utf-8'):
            if '平盤價不符' in l:
                codes |= {x.split('(')[0] for x in l.split('：', 1)[-1].split() if '(' in x}
    src = 'data_raw' if os.path.isdir('data_raw') else 'data'
    for p in glob.glob(f'{src}/*.csv'):
        code = os.path.basename(p)[:-4]
        if code.startswith('_'): continue
        try: _, df = read(p)
        except Exception: continue
        r = df.c.pct_change(); known = {pd.Timestamp(e[0]).date() for e in divs.get(code, [])}
        for j in r.index[r.abs() > 0.105][-3:]:
            if df.o[j] / df.c[j - 1] < 0.7 and any(abs(df.o[j] / (df.c[j - 1] / k) - 1) <= 0.105 for k in (2, 3, 4, 5, 10, 20)): continue   # 面額變更，apply 會自動處理
            if j >= len(df) - 130 and not any(abs((df.d[j] - k).days) <= 4 for k in known): codes.add(code)
    codes.discard('TSE01'); codes.discard('OTC01')
    open('div_need.txt', 'w').write('\n'.join(sorted(codes)) + ('\n' if codes else ''))
    print('需要補查股利：', ' '.join(sorted(codes)) or '無')


def ingest():
    divs = load_divs(); n = 0
    for p in glob.glob('divnew/*.csv'):
        code = os.path.basename(p)[:-4]
        try:
            e = pd.read_csv(io.StringIO(open(p).read().replace('```csv', '').replace('```', ''))).fillna(0)
        except Exception as ex:
            print('讀取失敗', code, ex); continue
        old = {x[0]: x for x in divs.get(code, [])}
        for _, r in e.iterrows():
            d = pd.to_datetime(r.ex_date, errors='coerce')
            if pd.isna(d) or (float(r.cash) == 0 and float(r.stock) == 0): continue
            old[str(d.date())] = [str(d.date()), float(r.cash), float(r.stock)]; n += 1
        divs[code] = sorted(old.values())
    json.dump(divs, open('divs.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print('併入股利事件', n, '筆')


if __name__ == '__main__':
    {'apply': apply, 'pack': pack, 'need': need, 'ingest': ingest}[sys.argv[1]]()
