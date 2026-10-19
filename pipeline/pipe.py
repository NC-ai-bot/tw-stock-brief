# 台股技術面選股晨報 pipeline. Usage (run inside the work dir that has universe.csv, data/):
#   python3 pipe.py validate          -> writes bad.txt (codes needing refetch) and prints summary
#   python3 pipe.py optimize          -> 每日滾動式優化：回測鄰近參數，達標才更新 strategy.json
#   python3 pipe.py screen            -> writes candidates.json (依 strategy.json 的參數)
#   python3 pipe.py market            -> reads data/TSE01.csv, data/OTC01.csv; writes market.json
#   python3 pipe.py track             -> appends picks to history.json, writes perf.json (needs data/0050.csv)
#   python3 pipe.py build             -> reads picks.json, enrich.json, meta.json, market.json, market_analysis.json, perf.json; writes the PDF
#   python3 pipe.py page              -> builds site/ (index.html, report.pdf, history.json, page images) for the artifact
import sys, os, io, glob, json
import pandas as pd, numpy as np

def load(code):
    txt = open(f'data/{code}.csv', encoding='utf-8').read().replace('```csv', '').replace('```', '')
    lines = [l for l in txt.splitlines() if l.strip() and not l.startswith('#') and not l.startswith('|')]
    df = pd.read_csv(io.StringIO('\n'.join(lines)))
    if 't' in df.columns:   # 原始 unix 秒數格式：t,o,h,l,c,v（避免 WebFetch 轉換日期出錯）
        df = df.rename(columns={'o': 'open', 'h': 'high', 'l': 'low', 'c': 'close', 'v': 'volume'})
        df['date'] = pd.to_datetime(df['t'], unit='s', utc=True).dt.tz_convert('Asia/Taipei').dt.tz_localize(None).dt.normalize()
        df = df.drop(columns=['t'])
    else:
        df['date'] = pd.to_datetime(df['date'])
    df = df.sort_values('date').drop_duplicates('date').set_index('date')
    now = pd.Timestamp.now(tz='Asia/Taipei')
    if len(df) and df.index[-1] == now.normalize().tz_localize(None) and now.hour < 14:
        df = df.iloc[:-1]   # 盤中執行時去掉今天尚未收盤的 K 棒
    for n in (5, 10, 20, 60):
        df[f'MA{n}'] = df.close.rolling(n).mean()
    lo = df.low.rolling(9).min(); hi = df.high.rolling(9).max()
    rsv = ((df.close - lo) / (hi - lo) * 100).fillna(50)
    k = [50]; d = [50]
    for r in rsv:
        k.append(k[-1] * 2 / 3 + r / 3); d.append(d[-1] * 2 / 3 + k[-1] / 3)
    df['K'] = k[1:]; df['D'] = d[1:]
    return df

def check(code):
    df = load(code)
    wk = int((df.index.weekday >= 5).sum())
    bad = int(((df.high < df[['open', 'close']].max(axis=1)) | (df.low > df[['open', 'close']].min(axis=1))).sum())
    jump = int((df.close.iloc[-130:].pct_change().abs() > 0.105).sum())   # 只檢查最近 130 根（更早的除權息跳空不影響日常選股）
    return df, dict(n=len(df), wk=wk, bad=bad, jump=jump, last=str(df.index.max().date()))

def validate():
    uni = pd.read_csv('universe.csv', dtype=str)
    lasts = {}
    infos = {}
    for code in uni.code:
        if not os.path.exists(f'data/{code}.csv'):
            infos[code] = None; continue
        try:
            _, i = check(code); infos[code] = i; lasts[i['last']] = lasts.get(i['last'], 0) + 1
        except Exception as e:
            infos[code] = {'err': str(e)}
    last = max(lasts, key=lasts.get) if lasts else None
    badl = []
    for code, i in infos.items():
        if i is None or 'err' in i or i['wk'] or i['bad'] > 3 or i['jump'] or i['n'] < 120 or i['last'] != last:
            badl.append(code)
    open('bad.txt', 'w').write('\n'.join(badl))
    print('expected last date', last, '| ok', len(infos) - len(badl), '| need refetch', len(badl))
    print(' '.join(badl))

def usable():
    uni = pd.read_csv('universe.csv', dtype=str).set_index('code')
    bad = set(open('bad.txt').read().split()) if os.path.exists('bad.txt') else set()
    return [(c, uni.loc[c, 'name'], uni.loc[c, 'index']) for c in uni.index if c not in bad and os.path.exists(f'data/{c}.csv')]

def metrics(code):
    df = load(code); t = df.iloc[-1]
    s = lambda i: (df.MA60.iloc[-1 - i] / df.MA60.iloc[-6 - i] - 1) * 100
    cu = any(df.K.iloc[-i] > df.D.iloc[-i] and df.K.iloc[-i - 1] <= df.D.iloc[-i - 1] for i in (1, 2, 3))
    cd = any(df.K.iloc[-i] < df.D.iloc[-i] and df.K.iloc[-i - 1] >= df.D.iloc[-i - 1] for i in (1, 2, 3))
    kcross = min([df.K.iloc[-i] for i in (1, 2, 3) if df.K.iloc[-i] > df.D.iloc[-i] and df.K.iloc[-i - 1] <= df.D.iloc[-i - 1]] or [99])
    return dict(close=t.close, chg=(t.close / df.close.iloc[-2] - 1) * 100, K=t.K, D=t.D,
                Kmax8=df.K.iloc[-8:].max(), s0=s(0), s10=s(10), cross_up=cu, cross_dn=cd, kcross=kcross,
                ma5=t.MA5, ma10=t.MA10, ma20=t.MA20, ma60=t.MA60,
                roll=t.close / df.close.iloc[-60:-50].mean(),
                hi120=df.high.iloc[-121:-1].max(), hi60=df.high.iloc[-60:].max(), lo60=df.low.iloc[-60:-5].min(),
                vr=t.volume / df.volume.iloc[-21:-1].mean(), stable=stable(df), K_prev=df.K.iloc[-2],
                atr=atr_pct(df), macdh=macd_hist(df), upday=bool(t.close > t.open))

def atr_pct(df):
    tr = pd.concat([df.high - df.low, (df.high - df.close.shift()).abs(), (df.low - df.close.shift()).abs()], axis=1).max(axis=1)
    return float(tr.rolling(14).mean().iloc[-1] / df.close.iloc[-1] * 100)

def macd_hist(df):
    m = df.close.ewm(span=12).mean() - df.close.ewm(span=26).mean()
    return float((m - m.ewm(span=9).mean()).iloc[-1])

def market_bull():
    try:
        I = load('TSE01'); s60 = (I.MA60.iloc[-1] / I.MA60.iloc[-6] - 1) * 100
        return bool(I.close.iloc[-1] > I.MA60.iloc[-1] and s60 > 0)
    except Exception:
        return False

def stable(df):
    # 止穩訊號：近 3 日有長下影線、或量縮到 20 日均量 7 成以下、或 K<35 的黃金交叉
    w = df.iloc[-3:]
    shadow = ((w[['open', 'close']].min(axis=1) - w.low) >= 1.5 * (w.close - w.open).abs().clip(lower=w.close * 0.002)).any()
    dry = df.volume.iloc[-1] < 0.7 * df.volume.iloc[-21:-1].mean()
    kx = any(df.K.iloc[-i] > df.D.iloc[-i] and df.K.iloc[-i - 1] <= df.D.iloc[-i - 1] and df.K.iloc[-i] < 35 for i in (1, 2, 3))
    return bool(shadow or dry or kx)

def stop_level(g, f):
    t = f['t']
    if os.path.exists('pool_out.json'):
        try:
            o = json.load(open('pool_out.json', encoding='utf-8'))
            P = o['params']
            if P.get('exit_mode') == 'supertrend': return f"停損：收盤跌破超級趨勢線（ATR {P['st_period']} 日 × {P['st_mult']:g}，隨股價上移；今日值見第 3 頁）"
        except Exception:
            pass
    if g == '開始轉多':  return f"停損：收盤跌破 20 日線 {t.MA20:,.2f}"
    if g == '強勢發動':  return f"停損：收盤跌破 10 日線 {t.MA10:,.2f}"
    if g == '開始轉空':  return f"轉空失效：收盤站回 20 日線 {t.MA20:,.2f}"
    sup = support(f)
    return f"停損：跌破支撐 {sup:,.2f} 的 3%（約 {sup * 0.97:,.2f}）"

def stop_short(g, f):
    t = f['t']
    if g == '開始轉多': return f"{t.MA20:,.2f}"
    if g == '強勢發動': return f"{t.MA10:,.2f}"
    if g == '開始轉空': return f"站回{t.MA20:,.2f}"
    return f"{support(f) * 0.97:,.2f}"

def support(f):
    # 最近的下方支撐：季線或前波低點中，位於現價（含 1% 誤差）以下的較高者；都在上方時取前波低點
    t = f['t']
    c = [v for v in (t.MA60, f['lo60']) if v <= t.close * 1.01]
    return max(c) if c else f['lo60']

def market():
    # 讀 data/TSE01.csv、data/OTC01.csv（加權、櫃買指數），寫 market.json
    out = {}
    for code, name in (('TSE01', '加權指數'), ('OTC01', '櫃買指數')):
        if not os.path.exists(f'data/{code}.csv'):
            continue
        try:
            df = load(code); t = df.iloc[-1]
        except Exception:
            continue
        s60 = (df.MA60.iloc[-1] / df.MA60.iloc[-6] - 1) * 100
        bull = t.close > t.MA60 and s60 > 0
        bear = t.close < t.MA60 and s60 < 0
        state = '多頭' if bull else '空頭' if bear else '盤整'
        out[code] = dict(name=name, close=round(t.close, 2), chg=round((t.close / df.close.iloc[-2] - 1) * 100, 2),
                         ma20=round(t.MA20, 2), ma60=round(t.MA60, 2), s60=round(s60, 2), K=round(t.K, 1), D=round(t.D, 1), state=state)
    json.dump(out, open('market.json', 'w'), ensure_ascii=False, indent=1)
    print(out)

def track():
    # history.json：歷次入選紀錄；計算入選後 5/10/20 個交易日報酬與 0050 超額報酬，寫 perf.json
    picks = json.load(open('picks.json', encoding='utf-8')); meta = json.load(open('meta.json', encoding='utf-8'))
    hist = json.load(open('history.json', encoding='utf-8')) if os.path.exists('history.json') else []
    dd = meta['data_date'][:10].replace('/', '-')
    hist = [h for h in hist if h['date'] != dd]
    ver = load_strategy()['version'] if os.path.exists('strategy.json') else 0
    for g, lst in picks.items():
        for code, name, grp in lst:
            try:
                hist.append(dict(date=dd, group=g, code=code, name=name, sector=grp, entry=float(load(code).close.iloc[-1]), ver=ver))
            except Exception:
                pass
    json.dump(hist, open('history.json', 'w'), ensure_ascii=False)
    bench = load('0050') if os.path.exists('data/0050.csv') else None
    def fwd(df, date, n):
        idx = df.index.searchsorted(pd.Timestamp(date))
        if idx >= len(df) or df.index[idx] != pd.Timestamp(date) or idx + n >= len(df):
            return None
        return df.close.iloc[idx + n] / df.close.iloc[idx] - 1
    rows = []
    for h in hist:
        if not os.path.exists(f'data/{h["code"]}.csv'):
            continue
        try:
            df = load(h['code'])
        except Exception:
            continue
        r = dict(h)
        for n in (5, 10, 20):
            v = fwd(df, h['date'], n); b = fwd(bench, h['date'], n) if bench is not None else None
            sign = -1 if h['group'] == '開始轉空' else 1   # 轉空組以「下跌」為命中
            r[f'r{n}'] = v
            r[f'x{n}'] = None if v is None or b is None else sign * (v - b)
            r[f'hit{n}'] = None if v is None else (sign * v > 0)
        rows.append(r)
    summ = {}
    for g in ['開始轉多', '開始轉空', '強勢發動', '跌到支撐']:
        s = {'n_total': sum(1 for h in hist if h['group'] == g)}
        for n in (5, 10, 20):
            vals = [r for r in rows if r['group'] == g and r[f'r{n}'] is not None]
            s[f'n{n}'] = len(vals)
            if vals:
                s[f'avg{n}'] = round(float(np.mean([r[f'r{n}'] for r in vals])) * 100, 2)
                s[f'win{n}'] = round(float(np.mean([r[f'hit{n}'] for r in vals])) * 100, 1)
                xs = [r[f'x{n}'] for r in vals if r[f'x{n}'] is not None]
                s[f'ex{n}'] = round(float(np.mean(xs)) * 100, 2) if xs else None
        summ[g] = s
    json.dump(dict(since=min((h['date'] for h in hist), default=dd), days=len({h['date'] for h in hist}), groups=summ),
              open('perf.json', 'w'), ensure_ascii=False, indent=1)
    print(json.dumps(summ, ensure_ascii=False))

# ---------------- 策略參數、回測與滾動式優化 ----------------
G4 = ['開始轉多', '開始轉空', '強勢發動', '跌到支撐']
DEFAULT_STRATEGY = {
    'version': 1, 'updated': '',
    'params': {
        '開始轉多': {'ext20_max': 0.08, 'vr_max': 2.0, 'macd_req': True, 'ma20_up_req': False},
        '開始轉空': {'ext20_min': -0.08, 'k_min': 20, 'macd_req': True, 'bull_max': 2},
        '強勢發動': {'ext20_max': 0.12, 'vr_max': 99, 'lowvol_score': False},
        '跌到支撐': {'k_min': 20, 'k_rising': True, 'red_req': True, 'vr_min': 0.0},
    },
    'grid': {
        '開始轉多': {'ext20_max': [0.06, 0.08, 0.10, 0.12], 'vr_max': [1.5, 2.0, 3.0, 99], 'macd_req': [True, False], 'ma20_up_req': [True, False]},
        '開始轉空': {'ext20_min': [-0.06, -0.08, -0.10, -1.0], 'k_min': [10, 15, 20, 25, 30], 'macd_req': [True, False], 'bull_max': [1, 2, 3, 5]},
        '強勢發動': {'ext20_max': [0.06, 0.08, 0.10, 0.12], 'vr_max': [2, 3, 99], 'lowvol_score': [True, False]},
        '跌到支撐': {'k_min': [10, 15, 20, 25, 30], 'k_rising': [True, False], 'red_req': [True, False], 'vr_min': [0.0, 1.0]},
    },
    'guard': {'min_delta': 0.3, 'min_n': 30, 'cooldown': 5, 'max_hit_drop': 0.05, 'recent': 20, 'top': 5},
    'log': [], 'daily': [],
}
PNAME = {'ext20_max': '離月線上限', 'ext20_min': '離月線下限', 'vr_max': '量比上限', 'vr_min': '量比下限', 'macd_req': 'MACD 柱體方向須符合',
         'ma20_up_req': '月線須上揚', 'k_min': 'K 值下限', 'bull_max': '多頭時最多檔數', 'lowvol_score': '低波動優先排序',
         'k_rising': 'K 值須不再下降', 'red_req': '當天須收紅K'}

def pfmt(k, v):
    if isinstance(v, bool): return f"{PNAME.get(k, k)}：{'是' if v else '否'}"
    if k.startswith('ext20'): return f"{PNAME[k]}：{'不限' if abs(v) >= 1 else f'{v * 100:+.0f}%'}"
    if k.startswith('vr'): return f"{PNAME[k]}：{'不限' if v >= 99 or v == 0 else f'{v:g} 倍'}"
    return f"{PNAME.get(k, k)}：{v:g}"

def load_strategy():
    import copy
    s = json.load(open('strategy.json', encoding='utf-8')) if os.path.exists('strategy.json') else copy.deepcopy(DEFAULT_STRATEGY)
    for k, v in DEFAULT_STRATEGY.items(): s.setdefault(k, v)
    return s

def features():
    # 所有股票、所有日期的特徵表（只用當天以前的資料計算），以及 5 日後報酬
    I = load('TSE01'); bull = (I.close > I.MA60) & ((I.MA60 / I.MA60.shift(5) - 1) > 0)
    rows = []
    for code, name, idx in usable():
        try:
            df = load(code).copy()
        except Exception:
            continue
        df['s0'] = (df.MA60 / df.MA60.shift(5) - 1) * 100; df['s10'] = df.s0.shift(10)
        df['roll'] = df.close / df.close.shift(50).rolling(10).mean()
        df['hi120'] = df.high.shift(1).rolling(120, min_periods=80).max(); df['hi60'] = df.high.rolling(60).max()
        df['lo60'] = df.low.shift(5).rolling(55).min()
        df['vr'] = df.volume / df.volume.shift(1).rolling(20).mean(); df['Kmax8'] = df.K.rolling(8).max(); df['K_prev'] = df.K.shift(1)
        x = (df.K > df.D).astype(int).diff()
        df['cross_up'] = (x == 1).astype(int).rolling(3).max().fillna(0).astype(bool)
        df['cross_dn'] = (x == -1).astype(int).rolling(3).max().fillna(0).astype(bool)
        body = (df.close - df.open).abs().clip(lower=df.close * 0.002)
        sh = ((df[['open', 'close']].min(axis=1) - df.low) >= 1.5 * body).astype(int).rolling(3).max().astype(bool)
        dry = df.volume < 0.7 * df.volume.shift(1).rolling(20).mean()
        kx = ((x == 1) & (df.K < 35)).astype(int).rolling(3).max().astype(bool)
        df['stable'] = sh | dry | kx
        tr = pd.concat([df.high - df.low, (df.high - df.close.shift()).abs(), (df.low - df.close.shift()).abs()], axis=1).max(axis=1)
        df['atr'] = tr.rolling(14).mean() / df.close * 100
        m = df.close.ewm(span=12).mean() - df.close.ewm(span=26).mean(); df['macdh'] = m - m.ewm(span=9).mean()
        df['ext20'] = df.close / df.MA20 - 1; df['near_hi'] = df.close / df.hi120; df['dd60'] = df.close / df.hi60 - 1
        df['ma20_up'] = df.MA20 > df.MA20.shift(5); df['upday'] = df.close > df.open
        df['fwd5'] = (df.close.shift(-5) / df.close - 1) * 100
        df['code'] = code; df['name'] = name; df['idx'] = idx; df['n'] = np.arange(len(df))
        rows.append(df)
    F = pd.concat(rows); F.index.name = 'date'; F = F.reset_index()
    F = F[F.n >= 80].copy()
    F['u5'] = F.groupby('date').fwd5.transform('mean'); F['bull'] = F.date.map(bull).fillna(False)
    return F

def base_cands(r, g):
    # 各組的基本型態（固定，不參與優化）與排序分數
    if g == '強勢發動':
        x = r[(r.near_hi >= 0.95) & (r.MA5 > r.MA10) & (r.MA10 > r.MA20) & (r.MA20 > r.MA60)].copy()
        x['score'] = x.near_hi * 10 + x.vr.clip(upper=4); x['score_lv'] = x.near_hi * 10 - x.atr
    elif g == '跌到支撐':
        x = r[(r.dd60 <= -0.12) & (((r.close / r.MA60 - 1).abs() <= 0.04) | ((r.close / r.lo60 - 1).between(-0.02, 0.07)))].copy()
        x['score'] = -x.dd60 * 100 - x.K / 10 + x.stable * 8
    elif g == '開始轉空':
        x = r[(r.close < r.MA20) & (r.s0 < 0.3) & (r.roll < 1.02) & (r.Kmax8 >= 60)].copy()
        if len(x): x = x[x.atr < x.atr.median() * 1.5]
        x['score'] = (x.Kmax8 - x.K) / 2 + (1.02 - x.roll) * 100 + x.cross_dn * 8 + (x.K < x.D) * 4
    else:
        x = r[(r.s0 > -0.3) & (r.s0 > r.s10) & ((r.close > r.MA20) | (r.vr >= 1.3)) & (r.K < 85)].copy()
        x['score'] = (x.s0 - x.s10) * 2 + (x.close > x.MA20) * 1 + (x.roll < 1) * 1 + (x.K > x.D) * 1 + (x.macdh > 0) * 1
    return x

def apply_params(x, g, P, bull):
    # 可優化的參數條件；回傳依分數排序後的候選
    if not len(x): return x
    if g == '開始轉多':
        x = x[(x.ext20 <= P['ext20_max']) & (x.vr < P['vr_max'])]
        if P['macd_req']: x = x[x.macdh > 0]
        if P['ma20_up_req']: x = x[x.ma20_up]
    elif g == '開始轉空':
        x = x[(x.ext20 >= P['ext20_min']) & (x.K >= P['k_min'])]
        if P['macd_req']: x = x[x.macdh < 0]
        x = x.sort_values('score', ascending=False)
        return x.head(P['bull_max']) if bull else x
    elif g == '強勢發動':
        x = x[(x.ext20 <= P['ext20_max']) & (x.vr < P['vr_max'])]
        if P['lowvol_score']: x = x.assign(score=x.score_lv)
    else:
        x = x[x.K >= P['k_min']]
        if P['k_rising']: x = x[x.K >= x.K_prev]
        if P['red_req']: x = x[x.upday]
        if P['vr_min'] > 0: x = x[x.vr >= P['vr_min']]
    return x.sort_values('score', ascending=False)

def backtest(F, g, P, top=5, base=None):
    # 每天選前 top 檔，回傳 [日期, 超額(依方向), 命中] 明細；超額＝個股 5 日報酬 − 同日全體平均
    out = []; s = -1 if g == '開始轉空' else 1
    for d, x in (base or {}).items():
        y = apply_params(x, g, P, bool(x.bull.iloc[0]) if len(x) else False).head(top)
        for _, z in y.iterrows():
            out.append((d, s * (z.fwd5 - z.u5), s * z.fwd5 > 0))
    return pd.DataFrame(out, columns=['date', 'ex', 'hit'])

def windows(F, recent):
    ds = sorted(F[F.fwd5.notna()].date.unique())
    return ds[:-recent], ds[-recent:]

def wstats(o, ds):
    z = o[o.date.isin(ds)]
    return dict(n=int(len(z)), ex=round(float(z.ex.mean()), 3) if len(z) else None, hit=round(float(z.hit.mean()), 3) if len(z) else None)

def optimize():
    # 每日滾動式優化：每組只試「改一個參數一格」的鄰近版本，兩段期間都改善才採用；每天最多改一項
    S = load_strategy(); Gd = S['guard']; meta = json.load(open('meta.json', encoding='utf-8')) if os.path.exists('meta.json') else {}
    today = meta.get('data_date', '')[:10].replace('/', '-') or str(pd.Timestamp.now(tz='Asia/Taipei').date())
    F = features(); older, recent = windows(F, Gd['recent'])
    tested = []; summary = {}
    for g in G4:
        base = {d: base_cands(x, g) for d, x in F[F.fwd5.notna()].groupby('date')}
        P = S['params'][g]; o = backtest(F, g, P, Gd['top'], base)
        cur = dict(older=wstats(o, older), recent=wstats(o, recent)); summary[g] = cur
        last = [l for l in S['log'] if l['group'] == g]
        cooling = bool(last) and len([d for d in S['daily'] if d['date'] > last[-1]['date']]) < Gd['cooldown']
        for k, vals in S['grid'][g].items():
            if P[k] not in vals: continue
            i = vals.index(P[k])
            for j in (i - 1, i + 1):
                if not 0 <= j < len(vals) or vals[j] == P[k]: continue
                P2 = dict(P, **{k: vals[j]}); o2 = backtest(F, g, P2, Gd['top'], base)
                new = dict(older=wstats(o2, older), recent=wstats(o2, recent))
                ok = all(new[w]['n'] >= Gd['min_n'] and new[w]['ex'] is not None and cur[w]['ex'] is not None for w in ('older', 'recent'))
                d1 = (new['older']['ex'] - cur['older']['ex']) if ok else None
                d2 = (new['recent']['ex'] - cur['recent']['ex']) if ok else None
                hitok = ok and (new['recent']['hit'] >= cur['recent']['hit'] - Gd['max_hit_drop'])
                passed = ok and hitok and d1 >= Gd['min_delta'] and d2 >= Gd['min_delta'] and not cooling
                tested.append(dict(group=g, param=k, frm=P[k], to=vals[j], d_older=d1, d_recent=d2, passed=passed, cooling=cooling, before=cur, after=new))
    S['daily'] = [d for d in S['daily'] if d['date'] != today]
    S['log'] = [l for l in S['log'] if not (l['date'] == today and l.get('auto'))]
    win = sorted([t for t in tested if t['passed']], key=lambda t: min(t['d_older'], t['d_recent']), reverse=True)
    near = sorted([t for t in tested if t['d_older'] is not None], key=lambda t: min(t['d_older'], t['d_recent']), reverse=True)
    if win:
        t = win[0]; S['params'][t['group']][t['param']] = t['to']; S['version'] += 1
        desc = f"{t['group']}：{pfmt(t['param'], t['frm'])} → {pfmt(t['param'], t['to']).split('：')[1]}"
        S['log'].append(dict(date=today, ver=S['version'], group=t['group'], auto=True, desc=desc,
                             d_older=round(t['d_older'], 2), d_recent=round(t['d_recent'], 2), before=t['before'], after=t['after']))
        S['daily'].append(dict(date=today, adopted=True, ver=S['version'], note=desc, tested=len(tested)))
        summary[t['group']] = t['after']
    else:
        best = near[0] if near else None
        cool = [t for t in tested if t['cooling'] and t['d_older'] is not None and t['d_older'] >= Gd['min_delta'] and t['d_recent'] >= Gd['min_delta']]
        note = '沒有任何調整在兩段期間都改善 ≥ {:.1f} 個百分點，維持現行規則'.format(Gd['min_delta'])
        if cool:
            t = max(cool, key=lambda t: min(t['d_older'], t['d_recent']))
            note = (f"有一項調整達標但暫緩：{t['group']}：{pfmt(t['param'], t['frm'])} → {pfmt(t['param'], t['to']).split('：')[1]}"
                    f"（前段 {t['d_older']:+.2f}、近 {Gd['recent']} 日 {t['d_recent']:+.2f}），該組 {Gd['cooldown']} 個交易日內剛調整過，冷卻期後若仍達標才採用")
        elif best:
            note += f"（最接近的是 {best['group']}：{pfmt(best['param'], best['frm'])} → {pfmt(best['param'], best['to']).split('：')[1]}，前段 {best['d_older']:+.2f}、近 {Gd['recent']} 日 {best['d_recent']:+.2f}）"
        S['daily'].append(dict(date=today, adopted=False, ver=S['version'], note=note, tested=len(tested)))
    S['daily'] = S['daily'][-60:]; S['updated'] = today; S['current'] = summary
    S['windows'] = dict(older=[str(older[0].date()), str(older[-1].date())], recent=[str(recent[0].date()), str(recent[-1].date())])
    json.dump(S, open('strategy.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(S['daily'][-1]); print(json.dumps(summary, ensure_ascii=False))

def screen():
    S = load_strategy(); F = features(); d = F.date.max(); r = F[F.date == d].set_index('code')
    bull = bool(r.bull.iloc[0]) if len(r) else False
    out = {g: apply_params(base_cands(r, g), g, S['params'][g], bull) for g in G4}
    used = set(); res = {}
    for g in ['強勢發動', '跌到支撐', '開始轉空', '開始轉多']:
        lst = out[g][~out[g].index.isin(used)].head(15)
        used |= set(lst.index[:5])
        res[g] = [dict(code=c, name=x['name'], idx=x['idx'], close=round(x.close, 2), K=round(x.K, 1), D=round(x.D, 1),
                       s0=round(x.s0, 2), s10=round(x.s10, 2), near_hi=round(x.near_hi, 3), dd60=round(x.dd60, 3),
                       roll=round(x.roll, 3), vr=round(x.vr, 2), stable=bool(x.stable), ext20=round(x.ext20, 3),
                       kd_golden=bool(x.cross_up), kd_dead=bool(x.cross_dn), score=round(x.score, 2)) for c, x in lst.iterrows()]
    res = {g: res[g] for g in G4}
    json.dump(res, open('candidates.json', 'w'), ensure_ascii=False, indent=1)
    print('策略版本', S['version'])
    for g, l in res.items():
        print('==', g, len(l)); [print('  ', x) for x in l]

# ---------------- charts + PDF ----------------
def chart(code, name, out, N=75, vol_label='成交量(張)', vol_div=1):
    import matplotlib; matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager as fm
    fm.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    plt.rcParams['font.family'] = 'Noto Sans CJK JP'; plt.rcParams['axes.unicode_minus'] = False
    UP, DN = '#d62728', '#2a9d4b'
    MAC = {'MA5': '#e6a100', 'MA10': '#1f77b4', 'MA20': '#9467bd', 'MA60': '#8c564b'}
    df = load(code).iloc[-N:]; x = np.arange(len(df))
    fig = plt.figure(figsize=(8.6, 4.6), dpi=170)
    gs = fig.add_gridspec(3, 1, height_ratios=[3.2, 1, 1], hspace=0.06)
    ax = fig.add_subplot(gs[0]); av = fig.add_subplot(gs[1], sharex=ax); ak = fig.add_subplot(gs[2], sharex=ax)
    col = np.where(df.close >= df.open, UP, DN)
    ax.vlines(x, df.low, df.high, color=col, lw=0.8)
    body = np.maximum((df.close - df.open).abs(), df.close * 0.0008)
    ax.bar(x, body, bottom=np.minimum(df.open, df.close), color=col, width=0.65, edgecolor=col, lw=0.5)
    for m, c in MAC.items():
        ax.plot(x, df[m], color=c, lw=1.1, label=f'{m} {df[m].iloc[-1]:,.2f}')
    ax.legend(loc='upper left', fontsize=6.5, ncol=4, frameon=False)
    t = df.iloc[-1]
    ax.set_title(f'{code + " " if code.isdigit() else ""}{name}　收盤 {t.close:,.2f}　（{df.index[-1]:%Y/%m/%d}）', fontsize=9.5, loc='left')
    ax.grid(alpha=0.25, lw=0.5); ax.tick_params(labelsize=7); plt.setp(ax.get_xticklabels(), visible=False)
    av.bar(x, df.volume / vol_div, color=col, width=0.65); av.set_ylabel(vol_label, fontsize=6.5); av.tick_params(labelsize=6.5)
    av.grid(alpha=0.25, lw=0.5); plt.setp(av.get_xticklabels(), visible=False)
    av.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, p: f'{v:,.0f}'))
    ak.plot(x, df.K, color='#1f77b4', lw=1, label=f'K {t.K:.1f}'); ak.plot(x, df.D, color='#e6a100', lw=1, label=f'D {t.D:.1f}')
    ak.axhline(80, color='#d62728', lw=0.6, ls='--'); ak.axhline(20, color='#2a9d4b', lw=0.6, ls='--')
    ak.set_ylim(0, 100); ak.set_ylabel('KD(9)', fontsize=6.5); ak.tick_params(labelsize=6.5); ak.grid(alpha=0.25, lw=0.5)
    ak.legend(loc='upper left', fontsize=6.5, ncol=2, frameon=False)
    ticks = list(range(0, len(df), 10)) + [len(df) - 1]
    ak.set_xticks(ticks); ak.set_xticklabels([df.index[i].strftime('%m/%d') for i in ticks], fontsize=6.5)
    ax.set_xlim(-1, len(df)); fig.savefig(out, bbox_inches='tight'); plt.close(fig)

def facts(code):
    df = load(code); t = df.iloc[-1]
    s60 = (df.MA60.iloc[-1] / df.MA60.iloc[-6] - 1) * 100; s60b = (df.MA60.iloc[-11] / df.MA60.iloc[-16] - 1) * 100
    kx = [i for i in (1, 2, 3) if (df.K.iloc[-i] > df.D.iloc[-i]) != (df.K.iloc[-i - 1] > df.D.iloc[-i - 1])]
    return dict(df=df, t=t, chg=(t.close / df.close.iloc[-2] - 1) * 100, s60=s60, s60b=s60b,
                hi120=df.high.iloc[-121:-1].max(), hi60=df.high.iloc[-60:].max(), lo60=df.low.iloc[-60:-5].min(),
                vr=t.volume / df.volume.iloc[-21:-1].mean(), kx=kx)

def reasons(g, code, f, en):
    t = f['t']; L = []
    kd = f"KD {t.K:.1f}／{t.D:.1f}"
    s60 = f"季線近 5 日 {f['s60']:+.2f}%（前一段 {f['s60b']:+.2f}%）"
    e = en.get(code, {})
    if g == '開始轉多':
        L.append(kd + ('，近 3 日黃金交叉' if f['kx'] and t.K > t.D else '（KD 僅供參考）'))
        L.append(s60 + ('，由下彎轉為上揚' if f['s60'] > 0 and f['s60b'] <= 0 else '，持續上揚' if f['s60'] > 0 else '，季線仍微幅下彎、尚未翻揚（列觀察）'))
    elif g == '開始轉空':
        df = f['df']; drop = df.close.iloc[-60:-50].mean()
        L.append(kd + f"（近 8 日最高 K {df.K.iloc[-8:].max():.1f}）" + ('，近 3 日死亡交叉' if f['kx'] and t.K < t.D else '，K 已跌破 D' if t.K < t.D else '（KD 僅供參考）'))
        st = '季線已下彎' if f['s60'] < -0.3 else '季線走平'
        L.append(s60 + f'，{st}；現價 {t.close:,.2f} 低於或接近接下來 10 日將扣抵的價格均值 {drop:,.2f}，季線續彎／即將下彎')
    elif g == '趨勢翻多':
        try:
            import pool as _pool; P = _pool.params(); s = _pool.st_of(code, P); j = s.index.get_loc(f['df'].index[-1])
            L.append(f"超級趨勢線（ATR {P['st_period']} 日 × {P['st_mult']:g}）近 {P['persist']} 日翻多，趨勢線 {s['st'].iloc[j]:,.2f}（距 {(t.close / s['st'].iloc[j] - 1) * 100:+.1f}%），ADX {s['adx'].iloc[j]:.0f}")
        except Exception:
            L.append('超級趨勢翻多')
        L.append(kd); L.append(s60)
    elif g == '強勢發動':
        L.append(f"收盤創近 120 日新高（前高 {f['hi120']:,.2f}），上方無套牢壓力" if t.close >= f['hi120']
                 else f"收盤距近 120 日最高 {f['hi120']:,.2f} 僅 {(t.close / f['hi120'] - 1) * 100:.1f}%，上方套牢壓力少")
        L.append(f"成交量為 20 日均量 {f['vr']:.1f} 倍；當日 {f['chg']:+.2f}%")
        L.append(f"均線多頭排列 5/10/20/60：{t.MA5:,.2f}／{t.MA10:,.2f}／{t.MA20:,.2f}／{t.MA60:,.2f}")
        L.append(kd + ('（已進入 80 以上高檔，追價留意短線震盪）' if t.K > 80 else ''))
    else:
        L.append(f"自 60 日高點 {f['hi60']:,.2f} 回檔 {(t.close / f['hi60'] - 1) * 100:.1f}%")
        L.append(("股價已略破前波低點，正在測試支撐；" if t.close < f['lo60'] else "") +
                 f"支撐：季線 {t.MA60:,.2f}（距 {(t.close / t.MA60 - 1) * 100:+.1f}%）、前波低點 {f['lo60']:,.2f}（距 {(t.close / f['lo60'] - 1) * 100:+.1f}%）")
        L.append(kd + ('，低檔鈍化' if t.K < 20 else ''))
        L.append('止穩訊號：' + ('已出現（長下影線、量縮或低檔黃金交叉）' if stable(f['df']) else '尚未出現，宜等止穩再考慮'))
    L.append(stop_level(g, f))
    for key in ('pe', 'intl', 'chips', 'holders', 'note'):
        if e.get(key): L.append(e[key])
    return L

def week_rows(ndays=5):
    # 一週選股回顧：history.json 中今天資料日之前最近 ndays 期的名單，入選價對最新收盤
    meta = json.load(open('meta.json', encoding='utf-8'))
    dd = meta['data_date'][:10].replace('/', '-')
    hist = json.load(open('history.json', encoding='utf-8')) if os.path.exists('history.json') else []
    dates = sorted({h['date'] for h in hist if h['date'] < dd})[-ndays:]
    rows = []; cache = {}
    for h in [x for x in hist if x['date'] in dates]:
        r = dict(h, last=None, ret=None, hit=None, stop=None, stopped=None)
        try:
            df = cache.get(h['code']) or cache.setdefault(h['code'], load(h['code']))
            r['last'] = float(df.close.iloc[-1]); r['ret'] = (r['last'] / h['entry'] - 1) * 100
            r['hit'] = r['ret'] < 0 if h['group'] == '開始轉空' else r['ret'] > 0
            sub = df[df.index <= pd.Timestamp(h['date'])]
            if len(sub) >= 60 and sub.index[-1] == pd.Timestamp(h['date']):
                t = sub.iloc[-1]; g = h['group']
                if g in ('開始轉多', '開始轉空'): r['stop'] = t.MA20
                elif g == '強勢發動': r['stop'] = t.MA10
                else:
                    lo60 = sub.low.iloc[-60:-5].min(); c = [v for v in (t.MA60, lo60) if v <= t.close * 1.01]
                    r['stop'] = (max(c) if c else lo60) * 0.97
                post = df[df.index > pd.Timestamp(h['date'])].close   # 入選後任一天收盤觸及即算
                r['stopped'] = bool((post > r['stop']).any()) if g == '開始轉空' else bool((post < r['stop']).any())
        except Exception:
            pass
        rows.append(r)
    bench = {}
    try:
        bdf = load('0050')
        for d in dates: bench[d] = (bdf.close.iloc[-1] / bdf.close.loc[pd.Timestamp(d)] - 1) * 100
    except Exception:
        pass
    return dates, bench, rows

def strategy_page(st, H2, B, Sm, F, colors, Table, TableStyle, Paragraph, Spacer, PageBreak, mm, ACC):
    # 最後一頁：策略優化紀錄與績效追蹤
    if not os.path.exists('strategy.json'): return []
    S = load_strategy(); E = [PageBreak(), Paragraph('策略優化紀錄與績效追蹤', H2)]
    H3 = st('h3s', fontSize=10.5, leading=15, spaceBefore=4)
    tday = S['daily'][-1] if S['daily'] else None
    E.append(Paragraph(f"目前規則：第 {S['version']} 版（{S.get('updated', '')} 更新）", B))
    E.append(Paragraph('今日優化結果', H3))
    if tday:
        E.append(Paragraph(('<font color="#c0392b">已調整</font>：' if tday['adopted'] else '未調整：') + tday['note'], B))
        E.append(Paragraph(f"本日共試了 {tday['tested']} 種「只改一個條件」的版本。", Sm))
    w = S.get('windows', {})
    E.append(Paragraph('調整原則', H3))
    g = S['guard']
    for t in [f"每天用最近的日K重跑回測，分成前段（{'～'.join(w.get('older', ['', '']))}）與近 {g['recent']} 個交易日（{'～'.join(w.get('recent', ['', '']))}）兩段。",
              f"只試「改一個條件、往前或往後一格」的版本；兩段期間的超額報酬都要改善至少 {g['min_delta']} 個百分點，近期命中率下降不超過 {g['max_hit_drop'] * 100:.0f} 個百分點，樣本至少 {g['min_n']} 檔次，才會採用。",
              f"每天最多改一項；同一組調整後 {g['cooldown']} 個交易日內不再調整，避免追逐雜訊。"]:
        E.append(Paragraph('・' + t, Sm))
    E.append(Paragraph('目前規則與回測表現（每天選前 5 檔、持有 5 個交易日，超額＝個股報酬 − 同日全體平均；轉空組以下跌計）', H3))
    rows = [['分組', '目前條件', '前段 超額／命中', f"近{g['recent']}日 超額／命中"]]
    cur = S.get('current', {})
    for gg in G4:
        P = S['params'][gg]; desc = '；'.join(pfmt(k, v) for k, v in P.items())
        c = cur.get(gg, {}); f = lambda z: '—' if not z or z.get('ex') is None else f"{z['ex']:+.2f}%／{z['hit'] * 100:.0f}%"
        rows.append([Paragraph(f'<font color="{ACC[gg]}">{gg}</font>', B), Paragraph(desc, Sm), f(c.get('older')), f(c.get('recent'))])
    t = Table(rows, colWidths=[20 * mm, 100 * mm, 31 * mm, 31 * mm])
    t.setStyle(TableStyle([('FONT', (0, 0), (-1, -1), 'WQY', 8), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#222')), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                           ('ALIGN', (2, 1), (-1, -1), 'RIGHT'), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb'))]))
    E += [t, Spacer(1, 3 * mm), Paragraph('近期調整紀錄', H3)]
    lg = S['log'][-8:][::-1]
    if lg:
        rr = [['日期', '版本', '調整內容', '前段', '近期']]
        for l in lg:
            rr.append([l['date'][5:].replace('-', '/'), f"v{l['ver']}", Paragraph(l['desc'] + ('' if l.get('auto') else '（手動）'), Sm),
                       '—' if l.get('d_older') is None else f"{l['d_older']:+.2f}", '—' if l.get('d_recent') is None else f"{l['d_recent']:+.2f}"])
        t = Table(rr, colWidths=[14 * mm, 12 * mm, 120 * mm, 18 * mm, 18 * mm])
        t.setStyle(TableStyle([('FONT', (0, 0), (-1, -1), 'WQY', 8), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eeeeee')), ('ALIGN', (3, 1), (-1, -1), 'RIGHT'),
                               ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb'))]))
        E.append(t)
    else:
        E.append(Paragraph('・尚無調整紀錄', Sm))
    # 實際績效（依規則版本）
    E += [Spacer(1, 3 * mm), Paragraph('實際績效追蹤（晨報實際入選股，依規則版本分開計算）', H3)]
    hist = json.load(open('history.json', encoding='utf-8')) if os.path.exists('history.json') else []
    try:
        bench = load('0050')
    except Exception:
        bench = None
    agg = {}
    for h in hist:
        try:
            df = load(h['code']); i = df.index.searchsorted(pd.Timestamp(h['date']))
            if i >= len(df) or df.index[i] != pd.Timestamp(h['date']): continue
            n = len(df) - 1 - i; r = df.close.iloc[-1] / df.close.iloc[i] - 1
            bi = bench.index.searchsorted(pd.Timestamp(h['date'])) if bench is not None else None
            b = bench.close.iloc[-1] / bench.close.iloc[bi] - 1 if bench is not None and bi < len(bench) else 0
        except Exception:
            continue
        if n < 1: continue
        s = -1 if h['group'] == '開始轉空' else 1
        k = (h.get('ver', 0), h['group']); a = agg.setdefault(k, [])
        a.append((s * r > 0, s * (r - b) * 100))
    if agg:
        rr = [['規則版本', '分組', '已入選檔次', '命中率', '平均超額（對0050）']]
        for (v, gg), a in sorted(agg.items(), key=lambda z: (-z[0][0], G4.index(z[0][1]))):
            rr.append(['舊規則' if v == 0 else f'v{v}', gg, str(len(a)), f"{np.mean([x[0] for x in a]) * 100:.0f}%", f"{np.mean([x[1] for x in a]):+.2f}%"])
        t = Table(rr, colWidths=[20 * mm, 22 * mm, 24 * mm, 20 * mm, 34 * mm])
        t.setStyle(TableStyle([('FONT', (0, 0), (-1, -1), 'WQY', 8), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eeeeee')), ('ALIGN', (2, 1), (-1, -1), 'RIGHT'),
                               ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb'))]))
        E.append(t)
        E.append(Paragraph('・報酬計算到最新收盤；入選不久的名單樣本少、波動大。新版本要累積約一個月才看得出差異。', Sm))
    else:
        E.append(Paragraph('・累積中', Sm))
    return E

def build():
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle, PageBreak, KeepTogether
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib import colors
    from reportlab.lib.units import mm
    pdfmetrics.registerFont(TTFont('WQY', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', subfontIndex=0))
    F = 'WQY'
    picks = json.load(open('picks.json', encoding='utf-8'))      # {group: [[code,name,族群],...]}
    en = json.load(open('enrich.json', encoding='utf-8')) if os.path.exists('enrich.json') else {}
    meta = json.load(open('meta.json', encoding='utf-8'))       # report_date, data_date, notes(list)
    ACC = {'開始轉多': '#c0392b', '開始轉空': '#1e7d45', '強勢發動': '#b9770e', '跌到支撐': '#2c5d9e', '趨勢翻多': '#6c3fb5'}
    DESC = {'趨勢翻多': '超級趨勢線（ATR 通道）由空翻多，收盤站上趨勢線；出場以收盤跌破趨勢線為準，不設持有天數',
            '開始轉多': '季線由跌轉平或翻揚、站上 20 日線或帶量、本益比位於自身歷史低檔、法人與千張大戶回補；KD 黃金交叉為參考加分',
            '開始轉空': '收盤跌破 20 日線、季線走平或下彎且扣抵值偏高；大盤多頭時不選股，只對池內持股提出風險提示',
            '強勢發動': '收盤貼近或突破近半年高點（上方套牢壓力少）、均線多頭排列、帶量上攻，且距 20 日線不超過 12%（避免追高）',
            '跌到支撐': '自 60 日高點回檔逾 12%、股價回到季線或前波低點附近，優先選已出現止穩訊號者'}
    st = lambda s, **k: ParagraphStyle(s, fontName=F, **k)
    H1 = st('h1', fontSize=20, leading=26); H2 = st('h2', fontSize=14, leading=19, spaceBefore=4)
    B = st('b', fontSize=9, leading=13.5); S = st('s', fontSize=7.5, leading=11, textColor=colors.HexColor('#555555'))
    os.makedirs('charts', exist_ok=True)
    out = f"台股技術面選股晨報_{meta['file_date']}.pdf"
    doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=13 * mm, bottomMargin=13 * mm,
                            title=f"台股技術面選股晨報 {meta['report_date']}", author='Claude')
    E = [Paragraph('台股技術面選股晨報', H1),
         Paragraph(f"{meta['report_date']}　資料日：{meta['data_date']} 收盤", st('x', fontSize=10.5, leading=15, textColor=colors.HexColor('#444'))),
         Spacer(1, 3 * mm)]
    mk = json.load(open('market.json', encoding='utf-8')) if os.path.exists('market.json') else {}
    ma = json.load(open('market_analysis.json', encoding='utf-8')) if os.path.exists('market_analysis.json') else {}
    if os.path.exists('data/TSE01.csv'):
        H3 = st('h3', fontSize=11.5, leading=16, spaceBefore=3)
        E.append(Paragraph('大盤盤勢：加權指數', H2))
        chart('TSE01', '加權指數', 'charts/TSE01.png', N=90, vol_label='成交金額(億)', vol_div=1e8)
        E.append(Image('charts/TSE01.png', width=182 * mm, height=182 * mm * 0.53))
        if 'TSE01' in mk:
            m = mk['TSE01']
            E.append(Paragraph(f"收盤 {m['close']:,.2f}（{m['chg']:+.2f}%）｜20 日線 {m['ma20']:,.0f}｜季線 {m['ma60']:,.0f}｜KD {m['K']}／{m['D']}｜狀態：{m['state']}", B))
        for key, title in (('summary', '盤勢重點'), ('tech', '技術面'), ('chips', '籌碼面'), ('intl', '國際股市與台指期夜盤'), ('plan', '今日操作觀察')):
            v = ma.get(key)
            if not v: continue
            E.append(Paragraph(title, H3))
            for line in (v if isinstance(v, list) else [v]):
                E.append(Paragraph('・' + line, B))
        E.append(PageBreak())
        wdates, wb, wv = week_rows()
        if wv:
            ldd = meta['data_date'][:10]; G4 = ['開始轉多', '開始轉空', '強勢發動', '跌到支撐']
            E.append(Paragraph('一週選股回顧', H2))
            E.append(Paragraph(f"最近 {len(wdates)} 期名單（入選日收盤價）到 {ldd} 收盤的表現。格內為「平均漲跌／命中檔數」；轉空組以下跌為命中，其他三組以上漲為命中。", S))
            E.append(Spacer(1, 2 * mm))
            hdr = ['入選日'] + G4 + ['同期0050']
            mt = [hdr]; sty3 = [('FONT', (0, 0), (-1, -1), F, 8.6), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#222')), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                                ('ALIGN', (1, 0), (-1, -1), 'CENTER'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb')), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]
            def cell(lst):
                v = [r for r in lst if r['ret'] is not None]
                if not v: return '—', None
                m = float(np.mean([r['ret'] for r in v])); return f"{m:+.2f}%／{sum(r['hit'] for r in v)}/{len(v)}", m
            for d in sorted(wdates, reverse=True):
                row = [d.replace('-', '/')[5:]]
                for j, g in enumerate(G4):
                    t, m = cell([r for r in wv if r['date'] == d and r['group'] == g]); row.append(t)
                    if m is not None:
                        good = m < 0 if g == '開始轉空' else m > 0
                        sty3.append(('TEXTCOLOR', (j + 1, len(mt)), (j + 1, len(mt)), colors.HexColor('#c0392b' if good else '#555555')))
                row.append(f"{wb[d]:+.2f}%" if d in wb else '—'); mt.append(row)
            tot = ['合計']
            for g in G4: tot.append(cell([r for r in wv if r['group'] == g])[0])
            tot.append(''); mt.append(tot)
            sty3 += [('BACKGROUND', (0, len(mt) - 1), (-1, len(mt) - 1), colors.HexColor('#eeeeee'))]
            for j, g in enumerate(G4): sty3.append(('TEXTCOLOR', (j + 1, 0), (j + 1, 0), colors.HexColor({'開始轉多': '#ff8a7a', '開始轉空': '#7ddc9c', '強勢發動': '#f0c070', '跌到支撐': '#9cc0f0'}[g])))
            tb3 = Table(mt, colWidths=[18 * mm, 33 * mm, 33 * mm, 33 * mm, 33 * mm, 22 * mm])
            tb3.setStyle(TableStyle(sty3)); E += [tb3, Spacer(1, 4 * mm)]
            # 個股重點：同一檔多次入選以第一次入選計
            first = {}
            for r in sorted(wv, key=lambda r: r['date']):
                first.setdefault((r['code'], r['group']), r)
            ok = [r for r in first.values() if r['ret'] is not None]
            perf = lambda r: -r['ret'] if r['group'] == '開始轉空' else r['ret']
            def mini(title, lst):
                E.append(Paragraph(title, B))
                if not lst:
                    E.append(Paragraph('・無', S)); return
                rr = [['分組', '代號', '名稱', '入選日', '入選價', '最新', '漲跌%', '停損']]
                st = [('FONT', (0, 0), (-1, -1), F, 8), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eeeeee')), ('ALIGN', (4, 1), (-1, -1), 'RIGHT'),
                      ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb'))]
                for r in lst:
                    rr.append([r['group'], r['code'], r['name'], r['date'][5:].replace('-', '/'), f"{r['entry']:,.2f}", f"{r['last']:,.2f}", f"{r['ret']:+.2f}",
                               ('已觸及' if r['stopped'] else '未觸及') if r['stopped'] is not None else '—'])
                    i = len(rr) - 1
                    st.append(('TEXTCOLOR', (0, i), (0, i), colors.HexColor(ACC[r['group']])))
                    st.append(('TEXTCOLOR', (6, i), (6, i), colors.HexColor('#c0392b' if r['ret'] > 0 else '#1e7d45' if r['ret'] < 0 else '#000')))
                    if r['stopped']: st.append(('TEXTCOLOR', (7, i), (7, i), colors.HexColor('#b9770e')))
                t = Table(rr, colWidths=[18 * mm, 13 * mm, 22 * mm, 15 * mm, 22 * mm, 22 * mm, 17 * mm, 17 * mm]); t.setStyle(TableStyle(st)); E.append(t); E.append(Spacer(1, 3 * mm))
            srt = sorted(ok, key=perf, reverse=True)
            mini('本週表現最好（依各組方向計，轉空組以跌幅計）', srt[:5])
            mini('本週表現最差', srt[::-1][:5])
            mini('入選後曾觸及停損', [r for r in srt if r['stopped']][:8])
            E.append(Paragraph('・停損依入選當天的停損價，入選後任一天收盤觸及即算。只看一週的結果波動大，長期勝率見第 3 頁的績效追蹤表。', S))
            E.append(PageBreak())
        E.append(Paragraph('今日觀察池' if os.path.exists('pool_out.json') else '今日選股名單', H2))
    if mk:
        SC = {'多頭': '#c0392b', '空頭': '#1e7d45', '盤整': '#b9770e'}
        txt = '　'.join(f"{m['name']} {m['close']:,.2f}（{m['chg']:+.2f}%）<font color=\"{SC[m['state']]}\">【{m['state']}】</font> 季線 {m['ma60']:,.0f}" for m in mk.values())
        E.append(Paragraph('大盤：' + txt, B))
        if any(m['state'] == '空頭' for m in mk.values()):
            E.append(Paragraph('<font color="#1e7d45">大盤位於季線之下且季線下彎：「開始轉多」「強勢發動」兩組勝率通常較低，請降低部位或嚴守停損。</font>', B))
        E.append(Spacer(1, 3 * mm))
    if os.path.exists('pool_out.json'):
        import pool as _pool; _pool.pdf_tables(E, F, st, B, S, colors, Table, TableStyle, Paragraph, Spacer, mm, ACC); E.append(Spacer(1, 4 * mm))
    else:
        rows = [['分組', '代號', '名稱', '族群', '收盤', '漲跌%', 'K', 'D', '停損／失效']]
        for g, lst in picks.items():
            for code, name, grp in lst:
                f = facts(code); t = f['t']
                rows.append([g, code, name, grp, f'{t.close:,.2f}', f"{f['chg']:+.2f}", f'{t.K:.0f}', f'{t.D:.0f}', stop_short(g, f)])
        tb = Table(rows, colWidths=[17 * mm, 12 * mm, 17 * mm, 42 * mm, 19 * mm, 15 * mm, 9 * mm, 9 * mm, 24 * mm], repeatRows=1)
        sty = [('FONT', (0, 0), (-1, -1), F, 8.3), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#222')), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
               ('ALIGN', (4, 1), (-1, -1), 'RIGHT'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb')), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]
        r0 = 1
        for g, lst in picks.items():
            n = len(lst)
            if n:
                sty += [('SPAN', (0, r0), (0, r0 + n - 1)), ('TEXTCOLOR', (0, r0), (0, r0 + n - 1), colors.HexColor(ACC[g]))]
            for r in range(r0, r0 + n):
                v = float(rows[r][5]); sty.append(('TEXTCOLOR', (5, r), (5, r), colors.HexColor('#c0392b' if v > 0 else '#1e7d45' if v < 0 else '#000')))
            r0 += n
        tb.setStyle(TableStyle(sty)); E += [tb, Spacer(1, 4 * mm)]
    pf = json.load(open('perf.json', encoding='utf-8')) if os.path.exists('perf.json') else None
    if pf:
        E.append(Paragraph(f"績效追蹤（{pf['since']} 起，共 {pf['days']} 個交易日的名單；轉空組以下跌為命中）", B))
        if any(s.get('n5') for s in pf['groups'].values()):
            pr = [['分組', '累計檔次', '5日平均', '5日勝率', '10日平均', '10日勝率', '20日平均', '20日勝率', '5日超額(對0050)']]
            fm = lambda v, u='%': '—' if v is None else f'{v:+.2f}{u}' if u == '%' else f'{v:.0f}%'
            for g, s in pf['groups'].items():
                pr.append([g, str(s['n_total']), fm(s.get('avg5')), fm(s.get('win5'), 'w'), fm(s.get('avg10')), fm(s.get('win10'), 'w'),
                           fm(s.get('avg20')), fm(s.get('win20'), 'w'), fm(s.get('ex5'))])
            pt = Table(pr, colWidths=[17 * mm, 15 * mm, 17 * mm, 16 * mm, 17 * mm, 16 * mm, 17 * mm, 16 * mm, 23 * mm])
            pt.setStyle(TableStyle([('FONT', (0, 0), (-1, -1), F, 7.8), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#eeeeee')),
                                    ('ALIGN', (1, 1), (-1, -1), 'RIGHT'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb'))]))
            E.append(pt)
        else:
            E.append(Paragraph('累積中：入選滿 5 個交易日後開始顯示報酬與勝率。', S))
        E.append(Spacer(1, 4 * mm))
    E.append(Paragraph('分組條件', B))
    for g, d in DESC.items():
        if g == '趨勢翻多' and not picks.get(g): continue
        E.append(Paragraph(f'<font color="{ACC[g]}">■ {g}</font>：{d}', B))
    E += [Spacer(1, 4 * mm), Paragraph('資料範圍與說明', B)] + [Paragraph('・' + x, S) for x in meta.get('notes', [])]
    E.append(Paragraph('・本報告為技術面整理，不構成投資建議。', S)); E.append(PageBreak())
    for g, lst in picks.items():
        if not lst: continue
        E.append(Paragraph(f'<font color="{ACC.get(g, "#6c3fb5")}">■ {g}</font>', H2)); E.append(Paragraph(DESC.get(g, ''), S)); E.append(Spacer(1, 2 * mm))
        for code, name, grp in lst:
            chart(code, name, f'charts/{code}.png'); f = facts(code)
            blk = [Paragraph(f'{code} {name}　<font color="#666666">族群：{grp}</font>', st('t', fontSize=10.5, leading=15)),
                   Image(f'charts/{code}.png', width=182 * mm, height=182 * mm * 0.53)]
            blk += [Paragraph('・' + r, B) for r in reasons(g, code, f, en)] + [Spacer(1, 4 * mm)]
            E.append(KeepTogether(blk))
        E.append(PageBreak())
    E.pop()
    E += strategy_page(st, H2, B, S, F, colors, Table, TableStyle, Paragraph, Spacer, PageBreak, mm, ACC)
    def foot(c, d):
        c.setFont(F, 7); c.setFillColor(colors.HexColor('#888'))
        c.drawString(14 * mm, 7 * mm, '資料：證交所、鉅亨網、HiStock、神秘金字塔（集保大戶）｜ 技術面整理，非投資建議'); c.drawRightString(196 * mm, 7 * mm, f'{d.page}')
    doc.build(E, onFirstPage=foot, onLaterPages=foot)
    print(out)


# ---------------- web page (artifact) ----------------
VIEWER = '<section id="viewer" hidden role="dialog" aria-modal="true" aria-labelledby="vtitle">\n<div class="vbar"><div class="vhead"><b id="vtitle">晨報</b><span id="vstat" class="am"></span></div><button type="button" id="vclose">關閉，回到今日晨報</button></div>\n<p id="vwarn" hidden></p>\n<div id="vpages"></div>\n</section>\n<style>\n#viewer{position:fixed;inset:0;z-index:50;background:var(--bg);overflow-y:auto;display:flex;flex-direction:column;gap:12px;\npadding:calc(env(safe-area-inset-top,0px) + 12px) 16px calc(env(safe-area-inset-bottom,0px) + 24px)}\n#viewer[hidden]{display:none}\n#viewer>*{width:100%;max-width:880px;margin-inline:auto}\n#viewer .vbar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;background:var(--bg);padding-block:6px;border-bottom:1px solid var(--line)}\n#viewer .vhead{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;min-width:0}\n#vwarn{margin:0;padding:8px 12px;border-radius:6px;border:1px solid var(--strong);color:var(--strong);font-weight:500;background:var(--paper)}\nbody.vopen{overflow:hidden}\n#viewer .am{color:var(--muted);font-size:.85rem}\n#vclose{margin-left:auto;padding:6px 14px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;cursor:pointer}\n#vclose:focus-visible{outline:2px solid var(--support);outline-offset:2px}\n#vpages{display:flex;flex-direction:column;gap:10px}\n#vpages canvas{width:100%;height:auto;border:1px solid var(--line);border-radius:4px;background:#fff}\n</style>\n<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"></script>\n<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>\n<script>\n(function(){\n  var V=document.getElementById(\'viewer\'),P=document.getElementById(\'vpages\'),T=document.getElementById(\'vtitle\'),S=document.getElementById(\'vstat\');\n  var job=0,W=document.getElementById(\'vwarn\'),opener=null;\n  function close(){job++;V.hidden=true;P.innerHTML=\'\';document.body.classList.remove(\'vopen\');if(opener)opener.focus();}\n  document.addEventListener(\'keydown\',function(e){if(e.key===\'Escape\'&&!V.hidden)close();});\n  document.getElementById(\'vclose\').addEventListener(\'click\',close);\n  async function show(href,label,hist){\n    var my=++job;V.hidden=false;P.innerHTML=\'\';T.textContent=label;S.textContent=\'載入中…\';\n    document.body.classList.add(\'vopen\');V.scrollTop=0;document.getElementById(\'vclose\').focus();\n    W.hidden=!hist;W.textContent=hist?\'這是過去的晨報，不是今天的名單。今天的名單請按「關閉」回到首頁。\':\'\';\n    try{\n      if(!window.pdfjsLib) throw new Error(\'PDF 元件沒有載入成功\');\n      var r=await fetch(href); if(!r.ok) throw new Error(\'找不到檔案（\'+r.status+\'）\');\n      var buf=await r.arrayBuffer(); if(my!==job) return;\n      var pdf=await pdfjsLib.getDocument({data:buf,isEvalSupported:false}).promise;\n      var w=Math.min(P.clientWidth||800,1000)*Math.min(window.devicePixelRatio||1,2);\n      for(var i=1;i<=pdf.numPages;i++){\n        if(my!==job) return;\n        S.textContent=\'第 \'+i+\'／\'+pdf.numPages+\' 頁\';\n        var pg=await pdf.getPage(i),vp0=pg.getViewport({scale:1}),vp=pg.getViewport({scale:w/vp0.width});\n        var c=document.createElement(\'canvas\');c.width=Math.floor(vp.width);c.height=Math.floor(vp.height);\n        c.setAttribute(\'aria-label\',label+\' 第 \'+i+\' 頁\');P.appendChild(c);\n        await pg.render({canvasContext:c.getContext(\'2d\'),viewport:vp}).promise;\n      }\n      S.textContent=\'共 \'+pdf.numPages+\' 頁\';\n    }catch(e){ if(my===job) S.textContent=\'無法顯示：\'+e.message; }\n  }\n  document.addEventListener(\'click\',function(ev){\n    var a=ev.target.closest&&ev.target.closest(\'a[data-pdf]\'); if(!a) return;\n    ev.preventDefault(); opener=a; show(a.getAttribute(\'href\'),a.getAttribute(\'data-pdf\'),a.hasAttribute(\'data-hist\'));\n  });\n})();\n</script>\n'

def page():
    import subprocess, shutil, html as H
    hist_keep = os.path.exists('history.json')
    picks = json.load(open('picks.json', encoding='utf-8')); meta = json.load(open('meta.json', encoding='utf-8'))
    pdf = f"台股技術面選股晨報_{meta['file_date']}.pdf"
    shutil.rmtree('site', ignore_errors=True); os.makedirs('site')
    shutil.copy(pdf, 'site/report.pdf')
    if hist_keep: shutil.copy('history.json', 'site/history.json')
    # 歷史晨報存檔：每天另存 archive/YYYYMMDD.pdf，清單記在 archive.json，只保留最近 KEEP 份
    KEEP = 60
    os.makedirs('site/archive')
    shutil.copy(pdf, f"site/archive/{meta['file_date']}.pdf")
    arch = json.load(open('archive.json', encoding='utf-8')) if os.path.exists('archive.json') else []
    arch = [a for a in arch if a['file_date'] != meta['file_date']]
    arch.append(dict(file_date=meta['file_date'], report_date=meta['report_date'], data_date=meta['data_date'],
                     n=sum(len(v) for v in picks.values())))
    arch.sort(key=lambda a: a['file_date'], reverse=True)
    pruned = [a['file_date'] for a in arch[KEEP:]]; arch = arch[:KEEP]
    json.dump(arch, open('archive.json', 'w', encoding='utf-8'), ensure_ascii=False)
    shutil.copy('archive.json', 'site/archive.json')
    open('site/archive_prune.txt', 'w').write('\n'.join(pruned))
    subprocess.run(['pdftoppm', '-r', '110', '-jpeg', '-jpegopt', 'quality=82', pdf, 'site/p'], check=True)
    imgs = sorted(f for f in os.listdir('site') if f.startswith('p-'))
    ACC = {'開始轉多': 'up', '開始轉空': 'down', '強勢發動': 'strong', '跌到支撐': 'support'}
    groups = ''
    if os.path.exists('pool_out.json'):
        import pool as _pool; groups = _pool.html_boxes(H)
    for g, lst in ([] if groups else picks.items()):
        rows = ''
        for code, name, grp in lst:
            f = facts(code); t = f['t']; c = f['chg']
            cls = 'pos' if c > 0 else 'neg' if c < 0 else ''
            rows += (f'<tr><td class="code">{code}</td><td>{H.escape(name)}<span class="grp">{H.escape(grp)}</span></td>'
                     f'<td class="num">{t.close:,.2f}</td><td class="num {cls}">{c:+.2f}%</td><td class="num stop">{stop_short(g, f)}</td></tr>')
        groups += f'<section class="grpbox {ACC[g]}"><h2>{g}</h2><table>{rows}</table></section>'
    mk = json.load(open('market.json', encoding='utf-8')) if os.path.exists('market.json') else {}
    mkt = ''.join(f"<span>{m['name']} <b>{m['close']:,.2f}</b>（{m['chg']:+.2f}%）{m['state']}</span>" for m in mk.values())
    archli = ''.join(f'<li id="d{a["file_date"]}"><a href="archive/{a["file_date"]}.pdf" data-pdf="{H.escape(a["report_date"])} 晨報（資料日 {H.escape(a["data_date"])}）"{'' if a['file_date'] == meta['file_date'] else ' data-hist'}>{H.escape(a["report_date"])}</a>'
                     f'<span class="am">資料日 {H.escape(a["data_date"])}・{a["n"]} 檔</span>'
                     + ('<span class="today">今日</span>' if a['file_date'] == meta['file_date'] else '') + '</li>' for a in arch)
    pages = ''.join(f'<img src="{i}" alt="晨報第 {n+1} 頁" loading="lazy">' for n, i in enumerate(imgs))
    doc = f'''<title>台股技術面選股晨報</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&family=IBM+Plex+Mono:wght@500&display=swap">
<style>
/* layout: one reading column — date header, four group tables in a 2x2 grid, then the full report pages */
:root{{--bg:#f6f7f8;--paper:#ffffff;--fg:#1b1f24;--muted:#5d6670;--line:#dde1e5;--up:#c0392b;--down:#1e7d45;--strong:#a8660a;--support:#2c5d9e;
--sans:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;--mono:"IBM Plex Mono",ui-monospace,monospace}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#14171a;--paper:#1c2024;--fg:#e8eaed;--muted:#9aa3ad;--line:#30363d;--up:#ef6b5d;--down:#4cbb78;--strong:#e0a243;--support:#6f9fe0;color-scheme:dark}}}}
:root[data-theme="dark"]{{--bg:#14171a;--paper:#1c2024;--fg:#e8eaed;--muted:#9aa3ad;--line:#30363d;--up:#ef6b5d;--down:#4cbb78;--strong:#e0a243;--support:#6f9fe0;color-scheme:dark}}
body{{background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.6}}
main{{max-width:880px;margin:0 auto;padding:28px 16px 48px;display:flex;flex-direction:column;gap:22px}}
header h1{{font-size:1.7rem;margin:0;text-wrap:balance;letter-spacing:.02em}}
header p{{margin:4px 0 0;color:var(--muted)}}
.actions a{{display:inline-block;padding:9px 16px;border:1px solid var(--line);border-radius:6px;background:var(--paper);color:var(--fg);text-decoration:none;font-weight:500}}
.actions a:focus-visible{{outline:2px solid var(--support);outline-offset:2px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));gap:14px}}
.grpbox{{background:var(--paper);border:1px solid var(--line);border-top:3px solid var(--c);border-radius:6px;padding:12px 14px;min-width:0}}
.up{{--c:var(--up)}}.down{{--c:var(--down)}}.strong{{--c:var(--strong)}}.support{{--c:var(--support)}}
.grpbox h2{{margin:0 0 6px;font-size:1rem;color:var(--c)}}
table{{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}}
td{{padding:5px 4px;border-top:1px solid var(--line);vertical-align:top}}
tr:first-child td{{border-top:0}}
.code{{font-family:var(--mono);color:var(--muted);width:3.6em}}
.grp{{display:block;font-size:.78rem;color:var(--muted)}}
.num{{text-align:right;white-space:nowrap}}.pos{{color:var(--up)}}.neg{{color:var(--down)}}
.pages{{display:flex;flex-direction:column;gap:12px}}
.pages img{{width:100%;max-width:100%;border:1px solid var(--line);border-radius:4px;background:#fff}}
.note{{font-size:.8rem;color:var(--muted)}}
.stop{{color:var(--muted);font-size:.8rem}}
.arch{{list-style:none;margin:0;padding:0;background:var(--paper);border:1px solid var(--line);border-radius:6px;max-height:22rem;overflow-y:auto}}
.arch li{{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;padding:8px 14px;border-top:1px solid var(--line)}}
.arch li:first-child{{border-top:0}}
.arch li:target{{background:color-mix(in srgb,var(--support) 14%,transparent)}}
.arch a{{color:var(--support);font-weight:500;text-decoration:none;font-variant-numeric:tabular-nums}}
.arch a:hover{{text-decoration:underline}}
.arch .am{{color:var(--muted);font-size:.85rem;font-variant-numeric:tabular-nums}}
.arch .today{{font-size:.72rem;padding:1px 7px;border-radius:9px;border:1px solid var(--support);color:var(--support)}}
.mkt{{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted)}}.mkt b{{color:var(--fg)}}
</style>
<main>
<header><h1>台股技術面選股晨報</h1><p>{H.escape(meta['report_date'])}・資料日 {H.escape(meta['data_date'])} 收盤</p></header>
<div class="mkt">{mkt}</div>
<div class="actions" id="pdf"><a href="report.pdf" data-pdf="{H.escape(meta['report_date'])} 晨報">開啟 PDF 原檔</a> <a id="weekly" href="weekly.pdf" data-pdf="最新週報" data-hist>最新週報</a> <a href="#archive">歷史晨報</a></div>
<div class="grid">{groups}</div>
<section aria-labelledby="archive"><h2 id="archive" style="margin:6px 0 8px;font-size:1.05rem">歷史晨報</h2><ul class="arch">{archli}</ul>
<p class="note" style="margin:6px 0 0">保留最近 {KEEP} 份，點日期開啟當天的 PDF。</p></section>
<h2 style="margin:6px 0 0;font-size:1.05rem">完整報告</h2>
<div class="pages">{pages}</div>
<p class="note">技術面整理，不構成投資建議。資料：證交所、鉅亨網、HiStock、神秘金字塔（集保大戶）。</p>
</main>'''
    doc = doc.replace('<div class="grid">', VIEWER + '<div class="grid">', 1)
    open('site/index.html', 'w', encoding='utf-8').write(doc)
    print('site/index.html', len(imgs), 'pages')

if __name__ == '__main__':
    {'validate': validate, 'market': market, 'screen': screen, 'optimize': optimize, 'track': track, 'build': build, 'page': page}[sys.argv[1]]()
