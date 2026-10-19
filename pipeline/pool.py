# 觀察池模式（搭配 pipe.py）
#   python3 pool.py plan      依 meta.json 的 data_date 結算持股（停損／持有期滿），列出今日候選 → pool_plan.json
#   python3 pool.py commit    讀 picks_final.json {"new":[[code,name,族群],...]} 寫入 pool.json、pool_out.json、picks.json
#   python3 pool.py backtest  用現有日K回測觀察池規則（印出並寫 pool_backtest.json）
#   python3 pool.py weekly    週報：本週結算、累積績效、滾動式優化（每週最多改一項）→ weekly.json、strategy.json
import sys, os, json
import pandas as pd, numpy as np
import pipe

LONG = ['開始轉多', '強勢發動', '跌到支撐']
POOL_DEFAULT = {'hold': 20, 'persist': 2, 'max_new': 3, 'bear_new': 1, 'pool_max': 10, 'per_group': 2, 'hard_stop': 0.10, 'reentry_gap': 5,
                'exit_mode': 'hold', 'st_period': 10, 'st_mult': 2.0, 'adx_min': 0, 'entry_mode': 'signals',
                'shadow': 0}   # shadow>0：影子權益濾網（未加濾網的策略淨值跌破自身 shadow 日均線時暫停新增）；0＝關閉
POOL_GRID = {'hold': [10, 15, 20, 30], 'persist': [1, 2, 3], 'max_new': [2, 3, 4], 'pool_max': [8, 10, 12], 'hard_stop': [0.08, 0.10, 0.15],
             'exit_mode': ['hold', 'supertrend'], 'st_period': [10, 14, 20], 'st_mult': [2.0, 2.5, 3.0], 'adx_min': [0, 20, 25], 'entry_mode': ['signals', 'supertrend']}
PNAME = {'hold': '持有上限（交易日）', 'persist': '訊號須連續成立天數', 'max_new': '每日最多新增', 'bear_new': '非多頭時最多新增', 'pool_max': '池內上限',
         'per_group': '同組每日上限', 'hard_stop': '硬停損', 'reentry_gap': '出場後幾天內不再進場', 'exit_mode': '出場方式', 'st_period': '超級趨勢 ATR 週期',
         'st_mult': '超級趨勢倍數', 'adx_min': 'ADX 下限（盤整過濾）', 'entry_mode': '進場訊號', 'shadow': '影子權益濾網（日）'}
STOP_NAME = {'MA20': '收盤跌破 20 日線', 'MA10': '收盤跌破 10 日線', 'fixed': '收盤跌破支撐價 ×0.97', 'ST': '收盤跌破超級趨勢線'}
LONG_ST = '趨勢翻多'

_PX = {}; _ST = {}

def px_of(code):
    if code not in _PX: _PX[code] = pipe.load(code)
    return _PX[code]


def supertrend(df, period=10, mult=3.0):
    """回傳 DataFrame(st=趨勢線, dir=1 多/-1 空, adx=ADX14)"""
    h, l, c = df.high, df.low, df.close
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    atr = tr.ewm(alpha=1 / period, adjust=False).mean()
    hl2 = (h + l) / 2; ub = hl2 + mult * atr; lb = hl2 - mult * atr
    n = len(df); fu = ub.values.copy(); fl = lb.values.copy(); d = np.ones(n); st = np.zeros(n); cv = c.values
    for i in range(1, n):
        fl[i] = lb.iloc[i] if (lb.iloc[i] > fl[i - 1] or cv[i - 1] < fl[i - 1]) else fl[i - 1]
        fu[i] = ub.iloc[i] if (ub.iloc[i] < fu[i - 1] or cv[i - 1] > fu[i - 1]) else fu[i - 1]
        if d[i - 1] == 1: d[i] = -1 if cv[i] < fl[i] else 1
        else: d[i] = 1 if cv[i] > fu[i] else -1
        st[i] = fl[i] if d[i] == 1 else fu[i]
    st[0] = fl[0]
    up = (h - h.shift()).clip(lower=0); dn = (l.shift() - l).clip(lower=0)
    pdm = up.where(up > dn, 0.0); mdm = dn.where(dn > up, 0.0); atr14 = tr.ewm(alpha=1 / 14, adjust=False).mean()
    pdi = 100 * pdm.ewm(alpha=1 / 14, adjust=False).mean() / atr14; mdi = 100 * mdm.ewm(alpha=1 / 14, adjust=False).mean() / atr14
    dx = (100 * (pdi - mdi).abs() / (pdi + mdi)).fillna(0); adx = dx.ewm(alpha=1 / 14, adjust=False).mean()
    return pd.DataFrame({'st': st, 'dir': d, 'adx': adx.values}, index=df.index)


def st_of(code, P):
    k = (code, P['st_period'], P['st_mult'])
    if k not in _ST: _ST[k] = supertrend(px_of(code), P['st_period'], P['st_mult'])
    return _ST[k]


def params(S=None):
    S = S or pipe.load_strategy()
    return {**POOL_DEFAULT, **S.get('pool', {})}


def stop_spec(g, row):
    if g == LONG_ST: return ['MA20', None]
    if g == '開始轉多': return ['MA20', None]
    if g == '強勢發動': return ['MA10', None]
    sup = max([v for v in (row.MA60, row.lo60) if v <= row.close * 1.01] or [row.lo60])
    return ['fixed', round(float(sup * 0.97), 2)]


def stop_level(spec, row, P=None, code=None, d=None):
    if P and P.get('exit_mode') == 'supertrend' and code is not None:
        s = st_of(code, P)
        if d in s.index: return float(s.loc[d, 'st'])
    return float(row.MA20) if spec[0] == 'MA20' else float(row.MA10) if spec[0] == 'MA10' else float(spec[1])


def entry_ok(code, d, P):
    """進場過濾：超級趨勢須為多方（exit_mode=supertrend 時）、ADX 下限"""
    if P.get('exit_mode') == 'supertrend' or P.get('adx_min', 0) > 0 or P.get('entry_mode') == 'supertrend':
        s = st_of(code, P)
        if d not in s.index: return False
        if P.get('exit_mode') == 'supertrend' and s.loc[d, 'dir'] != 1: return False
        if P.get('adx_min', 0) > 0 and s.loc[d, 'adx'] < P['adx_min']: return False
    return True


def cand_sets(F, S):
    out = {g: {} for g in LONG}; out['_day'] = {}
    for d, r in F.groupby('date'):
        r = r.set_index('code'); bull = bool(r.bull.iloc[0]); out['_day'][d] = r
        for g in LONG:
            out[g][d] = pipe.apply_params(pipe.base_cands(r, g), g, S['params'][g], bull)
    return out


def rank_new(cands, dates, i, P, exclude):
    """第 i 個交易日收盤後的候選（依跨組 z 分數排序），已套用連續成立天數；回傳 [(z, code, g, row)]"""
    d = dates[i]; rows = []
    if P.get('entry_mode') == 'supertrend':
        # 純超級趨勢進場：近 persist 日內翻多的股票，依 20 日動能排序
        r = cands.get('_day', {}).get(d)
        if r is None: return rows
        for c in r.index:
            if c in exclude: continue
            s = st_of(c, P)
            if d not in s.index: continue
            j = s.index.get_loc(d)
            if j < P['persist'] or s['dir'].iloc[j] != 1: continue
            flip = any(s['dir'].iloc[j - k] == -1 for k in range(1, P['persist'] + 1)) and all(s['dir'].iloc[j - k] == 1 for k in range(0, P['persist'] - 1))
            if not flip or not entry_ok(c, d, P): continue
            row = r.loc[c]
            if row.close <= s['st'].iloc[j]: continue
            rows.append((float(row.close / row.MA20 - 1) * 10 + float(s['adx'].iloc[j]) / 50, c, LONG_ST, row))
        rows.sort(key=lambda t: -t[0])
        return rows
    for g in LONG:
        x = cands[g].get(d)
        if x is None or not len(x): continue
        ok = list(x.index)
        for k in range(1, P['persist']):
            if i - k < 0: ok = []; break
            prev = cands[g].get(dates[i - k])
            ok = [c for c in ok if prev is not None and c in prev.index]
        x = x.loc[ok]
        if not len(x): continue
        z = (x.score - x.score.mean()) / (x.score.std() if x.score.std() > 0 else 1)
        for c in x.index:
            row = x.loc[c]
            if c in exclude or row.close <= stop_level(stop_spec(g, row), row, P, c, d) or not entry_ok(c, d, P): continue   # 收盤已在停損價之下的不選
            rows.append((float(z[c]), c, g, row))
    rows.sort(key=lambda t: -t[0])
    return rows


def pick(rows, n, pool_room, P):
    picks = []; cnt = {g: 0 for g in LONG + [LONG_ST]}
    for z, c, g, row in rows:
        if len(picks) >= n or len(picks) >= pool_room: break
        if any(c == p[1] for p in picks) or (g != LONG_ST and cnt[g] >= P['per_group']): continue
        picks.append((z, c, g, row)); cnt[g] += 1
    return picks


# ---------------- 回測 ----------------
def simulate(F, S, P=None, cands=None, entry='next_open', full=False):
    P = P or params(S); cands = cands or cand_sets(F, S)
    gate = shadow_gate(F, S, P, cands) if P.get('shadow') else None
    dates = sorted(F.date.unique()); px = {c: px_of(c) for c in F.code.unique()}
    bull = F.groupby('date').bull.first(); hold_lim = P['hold'] if P.get('exit_mode', 'hold') == 'hold' else 10 ** 6
    pool = {}; trades = []; daily = []; npos = []; last_exit = {}
    n0 = max(0, len(dates) - 1 - int(P['bt_days'])) if P.get('bt_days') else 0   # 只回測最近 bt_days 個交易日（指標仍用全部資料計算）
    for i, d in enumerate(dates if full else dates[:-1]):
        if i < n0: continue
        rets = []
        for c, p in list(pool.items()):
            df = px[c]
            if d not in df.index: continue
            row = df.loc[d]
            if p['prev'] is None: p['prev'] = p['entry']
            rets.append(row.close / p['prev'] - 1); p['prev'] = row.close; p['days'] += 1
            r = row.close / p['entry'] - 1
            why = ''
            if row.close < stop_level(p['stop'], row, P, c, d): why = 'stop'
            elif r < -P['hard_stop']: why = 'hard'
            elif p['days'] >= hold_lim: why = 'hold'
            if why:
                trades.append(dict(code=c, g=p['g'], entry_date=str(p['entry_date'].date()), exit_date=str(d.date()), ret=r, days=p['days'], why=why))
                del pool[c]; last_exit[c] = i
        daily.append(np.mean(rets) if rets else 0.0); npos.append(len(pool))
        if i + 1 >= len(dates) or (gate is not None and not bool(gate.get(d, True))): continue
        d1 = dates[i + 1]
        mx = P['max_new'] if bull.get(d, False) else P['bear_new']
        excl = set(pool) | {c for c, j in last_exit.items() if i - j < P['reentry_gap']}
        for z, c, g, row in pick(rank_new(cands, dates, i, P, excl), mx, P['pool_max'] - len(pool), P):
            df = px[c]
            if d1 not in df.index: continue
            e = float(df.loc[d1].open) if entry == 'next_open' else float(row.close)
            pool[c] = dict(entry=e, entry_date=d1, g=g, stop=stop_spec(g, row), days=0, prev=None)
    T = pd.DataFrame(trades); eq = (1 + pd.Series(daily, index=dates[n0:n0 + len(daily)])).cumprod()
    return T, eq, npos


def shadow_gate(F, S, P, cands=None, full=False):
    """影子權益濾網：用未加濾網的同一套規則模擬淨值，淨值 >= 自身 N 日均線才允許新增（均線還算不出來時允許）"""
    n = int(P.get('shadow') or 0)
    if n <= 0: return None
    T, eq, _ = simulate(F, S, dict(P, shadow=0), cands, full=full)
    ma = eq.rolling(n).mean()
    return (eq >= ma) | ma.isna()


def stats(T, eq, npos=None):
    dd = float((eq / eq.cummax() - 1).min()) if len(eq) else 0
    return dict(trades=int(len(T)), avg=round(float(T.ret.mean()) * 100, 2) if len(T) else 0, hit=round(float((T.ret > 0).mean()) * 100) if len(T) else 0,
                total=round(float(eq.iloc[-1] - 1) * 100, 2) if len(eq) else 0, mdd=round(dd * 100, 2), avg_pos=round(float(np.mean(npos)), 1) if npos else None,
                stop_rate=round(float((T.why != 'hold').mean()) * 100) if len(T) else 0)


def backtest():
    S = pipe.load_strategy(); F = pipe.features(); T, eq, npos = simulate(F, S, dict(params(S), bt_days=S.get('guard', {}).get('w_days', 120)))
    b = pipe.load('0050').close.reindex(eq.index).ffill(); b = b / b.iloc[0]
    r = stats(T, eq, npos); r['bench'] = round(float(b.iloc[-1] - 1) * 100, 2); r['start'] = str(eq.index[0].date()); r['end'] = str(eq.index[-1].date())
    r['by_group'] = {g: dict(n=int(len(x)), avg=round(float(x.ret.mean()) * 100, 2)) for g, x in T.groupby('g')} if len(T) else {}
    json.dump(r, open('pool_backtest.json', 'w'), ensure_ascii=False, indent=1); T.to_csv('pool_trades.csv', index=False); eq.to_csv('pool_equity.csv')
    print(json.dumps(r, ensure_ascii=False))


# ---------------- 每日：plan / commit ----------------
def load_pool():
    return json.load(open('pool.json', encoding='utf-8')) if os.path.exists('pool.json') else {'positions': [], 'closed': [], 'start': None, 'equity': []}


def plan():
    S = pipe.load_strategy(); P = params(S)
    meta = json.load(open('meta.json', encoding='utf-8')); D = pd.Timestamp(meta['data_date'][:10].replace('/', '-'))
    F = pipe.features(); dates = sorted(F.date.unique())
    if D not in dates: raise SystemExit(f'資料日 {D.date()} 不在日K裡')
    i = dates.index(D); r = F[F.date == D].set_index('code'); bull = bool(r.bull.iloc[0])
    pool = load_pool(); pool.setdefault('equity', [])
    if pool.get('start') is None: pool['start'] = str(D.date())
    exits = []; holding = []; risk = []; day_rets = []
    for p in list(pool['positions']):
        try: df = pipe.load(p['code'])
        except Exception: continue
        if D not in df.index: holding.append(dict(p, note='今日無報價')); continue
        row = df.loc[D]
        p['days'] = int(((df.index > pd.Timestamp(p['entry_date'])) & (df.index <= D)).sum())
        p['last'] = float(row.close); p['ret'] = round((row.close / p['entry'] - 1) * 100, 2)
        prev = p.get('prev_close') or p['entry']; day_rets.append(row.close / prev - 1); p['prev_close'] = float(row.close)
        lvl = stop_level(p['stop'], row, P, p['code'], D); p['stop_now'] = round(lvl, 2); p['stop_dist'] = round((row.close / lvl - 1) * 100, 2)
        if P.get('exit_mode') == 'supertrend': p['stop'] = ['ST', None]
        why = ''
        if row.close < lvl: why = 'stop'
        elif row.close / p['entry'] - 1 < -P['hard_stop']: why = 'hard'
        elif P.get('exit_mode', 'hold') == 'hold' and p['days'] >= P['hold']: why = 'hold'
        if why:
            exits.append(dict(p, exit_date=str(D.date()), exit=float(row.close), why=why))
        else:
            holding.append(p)
            if p['stop_dist'] < 2.0: risk.append(dict(code=p['code'], name=p['name'], text=f"距停損價 {lvl:,.2f} 只剩 {p['stop_dist']:+.2f}%"))
    pool['positions'] = holding
    pool['closed'] = [c for c in pool['closed'] if c['exit_date'] != str(D.date())]   # 同一資料日重跑時不重複記錄
    for e in exits: pool['closed'].append({k: e[k] for k in ('code', 'name', 'sector', 'group', 'entry_date', 'entry', 'exit_date', 'exit', 'days', 'why', 'ret')})
    pool['equity'] = [x for x in pool['equity'] if x['date'] != str(D.date())]
    last_eq = pool['equity'][-1]['eq'] if pool['equity'] else 1.0
    pool['equity'].append(dict(date=str(D.date()), eq=round(last_eq * (1 + (np.mean(day_rets) if day_rets else 0.0)), 6), n=len(holding)))
    mx = P['max_new'] if bull else P['bear_new']
    if any(p['entry_date'] == str(D.date()) for p in holding): mx = 0   # 同一資料日已經新增過（重跑）就不再新增
    recent_exit = {c['code'] for c in pool['closed'] if (D - pd.Timestamp(c['exit_date'])).days <= P['reentry_gap'] * 1.6}
    excl = {p['code'] for p in holding} | recent_exit
    cs = cand_sets(F, S); paused = False
    if P.get('shadow'):
        g = shadow_gate(F, S, P, cs, full=True)
        paused = not bool(g.get(D, True))
        if paused: mx = 0
    rows = rank_new(cs, dates, i, P, excl)
    room = max(0, P['pool_max'] - len(holding))
    prim = pick(rows, min(mx, room), room, P)
    prim_codes = {c for _, c, _, _ in prim}
    backup = [t for t in rows if t[1] not in prim_codes][:3]
    def cj(z, c, g, row):
        sp = ['ST', None] if P.get('exit_mode') == 'supertrend' else stop_spec(g, row)
        return dict(code=c, name=row['name'], group=g, z=round(z, 2), close=float(row.close), K=round(float(row.K), 1), D=round(float(row.D), 1),
                    stop=sp, stop_now=round(stop_level(sp, row, P, c, D), 2), ext20=round(float(row.ext20) * 100, 1),
                    near_hi=round(float(row.near_hi), 3), dd60=round(float(row.dd60) * 100, 1), vr=round(float(row.vr), 2), stable=bool(row.stable))
    out = dict(date=str(D.date()), bull=bull, max_new=mx, room=room, params=P, paused=paused, exits=exits, holding=holding, risk=risk,
               primary=[cj(*t) for t in prim], backup=[cj(*t) for t in backup], n_candidates=len(rows))
    json.dump(out, open('pool_plan.json', 'w'), ensure_ascii=False, indent=1, default=str)
    json.dump(pool, open('pool_pending.json', 'w'), ensure_ascii=False, indent=1, default=str)
    if paused: print(f'影子權益濾網（{P["shadow"]} 日）：策略轉弱，今日暫停新增')
    print(f"資料日 {D.date()}｜大盤{'多頭' if bull else '非多頭'}，今日最多新增 {mx}（池內空位 {room}）｜出場 {len(exits)}｜續抱 {len(holding)}｜候選 {len(rows)}")
    for p in out['primary']: print('  新增候選', p['code'], p['name'], p['group'], 'z', p['z'], '停損', p['stop_now'])
    for p in out['backup']: print('  備選', p['code'], p['name'], p['group'], 'z', p['z'])
    for e in exits: print('  出場', e['code'], e['name'], e['why'], e['ret'])


def commit():
    plan_ = json.load(open('pool_plan.json', encoding='utf-8')); pool = json.load(open('pool_pending.json', encoding='utf-8'))
    final = json.load(open('picks_final.json', encoding='utf-8')) if os.path.exists('picks_final.json') else {'new': [[p['code'], p['name'], ''] for p in plan_['primary']]}
    cand = {p['code']: p for p in plan_['primary'] + plan_['backup']}
    new = []
    for code, name, sector in final['new'][:plan_['max_new']]:
        if code not in cand: print('略過不在候選內的', code); continue
        if any(p['code'] == code for p in pool['positions']): print('已在池內，略過', code); continue
        p = cand[code]
        pos = dict(code=code, name=name or p['name'], sector=sector, group=p['group'], entry_date=plan_['date'], entry=p['close'], stop=p['stop'],
                   stop_now=p['stop_now'], days=0, last=p['close'], ret=0.0, prev_close=p['close'], stop_dist=round((p['close'] / p['stop_now'] - 1) * 100, 2))
        new.append(pos); pool['positions'].append(pos)
    json.dump(pool, open('pool.json', 'w'), ensure_ascii=False, indent=1, default=str)
    picks = {g: [] for g in pipe.G4}
    for p in new: picks.setdefault(p['group'], []).append([p['code'], p['name'], p['sector']])
    json.dump(picks, open('picks.json', 'w'), ensure_ascii=False, indent=1)
    out = dict(date=plan_['date'], bull=plan_['bull'], max_new=plan_['max_new'], paused=plan_.get('paused', False), new=new, exits=plan_['exits'], holding=plan_['holding'], risk=plan_['risk'],
               params=plan_['params'], summary=pool_summary(pool))
    json.dump(out, open('pool_out.json', 'w'), ensure_ascii=False, indent=1, default=str)
    print(f"新增 {len(new)}｜出場 {len(out['exits'])}｜續抱 {len(out['holding'])}；累計 {out['summary']}")


def pool_summary(pool):
    C = pd.DataFrame(pool['closed']); eq = pool.get('equity', [])
    s = dict(start=pool.get('start'), closed=int(len(C)), open=len(pool['positions']), cum=round((eq[-1]['eq'] - 1) * 100, 2) if eq else 0.0)
    if len(C):
        s.update(avg=round(float(C.ret.mean()), 2), hit=round(float((C.ret > 0).mean()) * 100), stop_rate=round(float((C.why != 'hold').mean()) * 100),
                 win_avg=round(float(C[C.ret > 0].ret.mean()), 2) if (C.ret > 0).any() else None, loss_avg=round(float(C[C.ret <= 0].ret.mean()), 2) if (C.ret <= 0).any() else None)
    try:
        b = pipe.load('0050').close
        if pool.get('start'): s['bench'] = round(float(b.iloc[-1] / b.loc[pd.Timestamp(pool['start']):].iloc[0] - 1) * 100, 2)
    except Exception: pass
    return s


# ---------------- PDF 與網頁片段（由 pipe.build / pipe.page 呼叫） ----------------
def pdf_tables(E, F, st, B, S, colors, Table, TableStyle, Paragraph, Spacer, mm, ACC):
    o = json.load(open('pool_out.json', encoding='utf-8')); P = o['params']; sm = o['summary']
    hdr_sty = lambda n: [('FONT', (0, 0), (-1, -1), F, 8.3), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#222')), ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
                         ('ALIGN', (n, 1), (-1, -1), 'RIGHT'), ('GRID', (0, 0), (-1, -1), 0.25, colors.HexColor('#bbb')), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE')]
    def rc(v): return colors.HexColor('#c0392b' if v > 0 else '#1e7d45' if v < 0 else '#000')
    exit_txt = (f"收盤跌破超級趨勢線（ATR {P['st_period']} 日 × {P['st_mult']:g} 倍，隨股價上移）出場、不設持有天數" if P.get('exit_mode') == 'supertrend'
                else f"持有 {P['hold']} 個交易日期滿出場，或收盤跌破停損價先出場")
    entry_txt = '超級趨勢翻多' if P.get('entry_mode') == 'supertrend' else '三組技術訊號'
    E.append(Paragraph(f"觀察池規則：進場看{entry_txt}，每天最多新增 {P['max_new']} 檔（大盤非多頭時 {P['bear_new']} 檔）、池內最多 {P['pool_max']} 檔、訊號須連續 {P['persist']} 個交易日成立"
                       + (f"、ADX ≥ {P['adx_min']}" if P.get('adx_min', 0) > 0 else '')
                       + (f"；啟用影子權益濾網：策略淨值跌破自身 {P['shadow']} 日均線時暫停新增" if P.get('shadow') else '') + f"；{exit_txt}，虧損超過 {P['hard_stop']*100:.0f}% 強制出場。進場參考價＝入選日收盤。", S))
    E.append(Spacer(1, 2 * mm))
    # 新增
    E.append(Paragraph(f"今日新增（{len(o['new'])} 檔{'' if o['new'] else ('：策略轉弱（影子淨值跌破 ' + str(P.get('shadow')) + ' 日均線），今日暫停新增' if o.get('paused') else '：今日無符合條件的新增')}）", B))
    if o['new']:
        rows = [['分組', '代號', '名稱', '族群', '收盤', '漲跌%', 'K', 'D', '停損價', '停損規則']]; sty = hdr_sty(4)
        for p in o['new']:
            f = pipe.facts(p['code']); t = f['t']
            rows.append([p['group'], p['code'], p['name'], p['sector'], f"{t.close:,.2f}", f"{f['chg']:+.2f}", f"{t.K:.0f}", f"{t.D:.0f}", f"{p['stop_now']:,.2f}", STOP_NAME[p['stop'][0]]])
            i = len(rows) - 1; sty += [('TEXTCOLOR', (0, i), (0, i), colors.HexColor(ACC.get(p['group'], '#6c3fb5'))), ('TEXTCOLOR', (5, i), (5, i), rc(f['chg']))]
        t = Table(rows, colWidths=[17 * mm, 12 * mm, 17 * mm, 30 * mm, 17 * mm, 14 * mm, 8 * mm, 8 * mm, 18 * mm, 36 * mm], repeatRows=1); t.setStyle(TableStyle(sty)); E.append(t)
    E.append(Spacer(1, 3 * mm))
    # 出場
    E.append(Paragraph(f"今日出場（{len(o['exits'])} 檔）", B))
    if o['exits']:
        WHY = {'stop': '觸發停損', 'hard': f"虧損逾 {P['hard_stop']*100:.0f}%", 'hold': '持有期滿'}
        rows = [['分組', '代號', '名稱', '入選日', '進場價', '出場價', '報酬%', '持有天', '原因']]; sty = hdr_sty(4)
        for p in o['exits']:
            rows.append([p['group'], p['code'], p['name'], p['entry_date'][5:].replace('-', '/'), f"{p['entry']:,.2f}", f"{p['exit']:,.2f}", f"{p['ret']:+.2f}", str(p['days']), WHY[p['why']]])
            i = len(rows) - 1; sty += [('TEXTCOLOR', (0, i), (0, i), colors.HexColor(ACC.get(p['group'], '#6c3fb5'))), ('TEXTCOLOR', (6, i), (6, i), rc(p['ret']))]
        t = Table(rows, colWidths=[17 * mm, 12 * mm, 17 * mm, 15 * mm, 19 * mm, 19 * mm, 15 * mm, 13 * mm, 28 * mm]); t.setStyle(TableStyle(sty)); E.append(t)
    else:
        E.append(Paragraph('・無', S))
    E.append(Spacer(1, 3 * mm))
    # 續抱
    E.append(Paragraph(f"續抱（{len(o['holding'])} 檔）", B))
    if o['holding']:
        rows = [['分組', '代號', '名稱', '族群', '入選日', '進場價', '現價', '報酬%', '持有天', '停損價', '距停損']]; sty = hdr_sty(5)
        for p in sorted(o['holding'], key=lambda p: p['entry_date']):
            rows.append([p['group'], p['code'], p['name'], p.get('sector', ''), p['entry_date'][5:].replace('-', '/'), f"{p['entry']:,.2f}", f"{p.get('last', p['entry']):,.2f}",
                         f"{p.get('ret', 0):+.2f}", f"{p.get('days', 0)}" + (f"/{P['hold']}" if P.get('exit_mode', 'hold') == 'hold' else ''), f"{p.get('stop_now', 0):,.2f}", f"{p.get('stop_dist', 0):+.1f}%"])
            i = len(rows) - 1; sty += [('TEXTCOLOR', (0, i), (0, i), colors.HexColor(ACC.get(p['group'], '#6c3fb5'))), ('TEXTCOLOR', (7, i), (7, i), rc(p.get('ret', 0)))]
            if p.get('stop_dist', 9) < 2: sty.append(('TEXTCOLOR', (10, i), (10, i), colors.HexColor('#b9770e')))
        t = Table(rows, colWidths=[17 * mm, 12 * mm, 17 * mm, 26 * mm, 14 * mm, 17 * mm, 17 * mm, 14 * mm, 13 * mm, 17 * mm, 15 * mm], repeatRows=1); t.setStyle(TableStyle(sty)); E.append(t)
    else:
        E.append(Paragraph('・目前池內無持股', S))
    if o['risk']:
        E.append(Spacer(1, 2 * mm)); E.append(Paragraph('風險提示', B))
        for r in o['risk']: E.append(Paragraph(f"・{r['code']} {r['name']}：{r['text']}", B))
    E.append(Spacer(1, 3 * mm))
    txt = f"觀察池績效（{sm.get('start')} 起）：已結算 {sm['closed']} 筆"
    if sm['closed']:
        txt += f"，平均 {sm['avg']:+.2f}%、勝率 {sm['hit']}%、停損出場比例 {sm['stop_rate']}%（獲利筆平均 {(format(sm['win_avg'], '+.2f') + '%') if sm['win_avg'] is not None else '—'}、虧損筆平均 {(format(sm['loss_avg'], '+.2f') + '%') if sm['loss_avg'] is not None else '—'}）"
    txt += f"；持股平均日報酬累積 {sm['cum']:+.2f}%" + (f"，同期 0050 {sm['bench']:+.2f}%" if 'bench' in sm else '') + '。'
    E.append(Paragraph(txt, B))


def html_boxes(H):
    o = json.load(open('pool_out.json', encoding='utf-8')); P = o['params']
    CLS = {'開始轉多': 'up', '開始轉空': 'down', '強勢發動': 'strong', '跌到支撐': 'support', LONG_ST: 'support'}
    def row(p, extra):
        return (f'<tr><td class="code">{p["code"]}</td><td>{H.escape(p["name"])}<span class="grp">{H.escape(p.get("sector") or "")}・<span style="color:var(--{CLS[p["group"]]})">{p["group"]}</span></span></td>{extra}</tr>')
    new = ''.join(row(p, f'<td class="num">{p["entry"]:,.2f}</td><td class="num stop">停損 {p["stop_now"]:,.2f}</td>') for p in o['new']) or ('<tr><td colspan=4 class="note">策略轉弱，今日暫停新增</td></tr>' if o.get('paused') else '<tr><td colspan=4 class="note">今日無新增</td></tr>')
    ex = ''.join(row(p, f'<td class="num">{p["exit"]:,.2f}</td><td class="num {"pos" if p["ret"]>0 else "neg" if p["ret"]<0 else ""}">{p["ret"]:+.2f}%</td>') for p in o['exits']) or '<tr><td colspan=4 class="note">無</td></tr>'
    hold = ''.join(row(p, f'<td class="num">{p.get("last", p["entry"]):,.2f}</td><td class="num {"pos" if p.get("ret",0)>0 else "neg" if p.get("ret",0)<0 else ""}">{p.get("ret",0):+.2f}%</td><td class="num stop">{p.get("days",0)}{"/"+str(P["hold"]) if P.get("exit_mode","hold")=="hold" else ""} 天・停損 {p.get("stop_now",0):,.2f}</td>')
                   for p in sorted(o['holding'], key=lambda p: p['entry_date'])) or '<tr><td colspan=5 class="note">目前池內無持股</td></tr>'
    risk = ''.join(f'<li>{p["code"]} {H.escape(p["name"])}：{H.escape(p["text"])}</li>' for p in o['risk'])
    sm = o['summary']; perf = f"已結算 {sm['closed']} 筆" + (f"，平均 {sm['avg']:+.2f}%、勝率 {sm['hit']}%" if sm['closed'] else '') + f"；累積 {sm['cum']:+.2f}%" + (f"（同期 0050 {sm['bench']:+.2f}%）" if 'bench' in sm else '')
    return (f'<section class="grpbox up"><h2>今日新增（{len(o["new"])}）</h2><table>{new}</table></section>'
            f'<section class="grpbox down"><h2>今日出場（{len(o["exits"])}）</h2><table>{ex}</table></section>'
            f'<section class="grpbox support" style="grid-column:1/-1"><h2>續抱（{len(o["holding"])}／{P["pool_max"]}）</h2><table>{hold}</table>'
            + (f'<p class="note" style="margin:8px 0 0"><b>風險提示</b></p><ul class="note" style="margin:2px 0 0;padding-left:18px">{risk}</ul>' if risk else '')
            + f'<p class="note" style="margin:8px 0 0">觀察池績效（{sm.get("start")} 起）：{perf}</p></section>')


# ---------------- 週報與滾動式優化 ----------------
def windows(eq, recent=40):
    ds = list(eq.index); return ds[:-recent], ds[-recent:]


def wret(eq, ds):
    s = eq.loc[ds]; return float(s.iloc[-1] / s.iloc[0] - 1) * 100 if len(s) > 1 else 0.0


def weekly():
    S = pipe.load_strategy(); Gd = S.setdefault('guard', {}); P = params(S)
    Gd.setdefault('w_min_delta', 1.0); Gd.setdefault('w_cooldown_weeks', 2); Gd.setdefault('w_recent', 40); Gd.setdefault('w_mdd_tol', 2.0); Gd.setdefault('w_days', 120)
    P = dict(P, bt_days=Gd['w_days'])   # 週報回測期間：近 w_days 個交易日（約六個月）
    meta = json.load(open('meta.json', encoding='utf-8')) if os.path.exists('meta.json') else {}
    today = str(pd.Timestamp.now(tz='Asia/Taipei').date())
    F = pipe.features(); cands = cand_sets(F, S)
    T0, eq0, np0 = simulate(F, S, P, cands); older, recent = windows(eq0, Gd['w_recent'])
    cur = dict(stats=stats(T0, eq0, np0), older=round(wret(eq0, older), 2), recent=round(wret(eq0, recent), 2))
    _b = pipe.load('0050').close.loc[eq0.index[0]:eq0.index[-1]]; bench_mdd = round(float((_b / _b.cummax() - 1).min()) * 100, 2); cur['bench_mdd'] = bench_mdd
    tested = []
    S.setdefault('wlog', [])
    cooling = {l['scope']: l['date'] for l in S['wlog'][-6:]}
    def cool(scope):
        d = cooling.get(scope); return bool(d) and (pd.Timestamp(today) - pd.Timestamp(d)).days < Gd['w_cooldown_weeks'] * 7
    trials = []
    for k, vals in POOL_GRID.items():
        if P[k] not in vals: continue
        i = vals.index(P[k])
        for j in (i - 1, i + 1):
            if 0 <= j < len(vals): trials.append(('pool', k, P[k], vals[j], dict(P, **{k: vals[j]}), S['params']))
    PRESETS = {'超級趨勢出場': dict(exit_mode='supertrend'), '純超級趨勢進出': dict(exit_mode='supertrend', entry_mode='supertrend'),
               '純超級趨勢＋ADX20': dict(exit_mode='supertrend', entry_mode='supertrend', adx_min=20), '現行進場＋超級趨勢出場＋ADX20': dict(exit_mode='supertrend', adx_min=20),
               '超級趨勢進場＋現行出場＋ADX20': dict(entry_mode='supertrend', adx_min=20),
               '回到持有天數出場': dict(exit_mode='hold', entry_mode='signals', adx_min=0)}
    for name, kw in PRESETS.items():
        if all(P.get(k) == v for k, v in kw.items()): continue
        trials.append(('pool', name, '現行', '套餐', dict(P, **kw), S['params']))
    for g in LONG:
        for k, vals in S['grid'][g].items():
            v = S['params'][g][k]
            if v not in vals: continue
            i = vals.index(v)
            for j in (i - 1, i + 1):
                if 0 <= j < len(vals):
                    gp = json.loads(json.dumps(S['params'])); gp[g][k] = vals[j]
                    trials.append((g, k, v, vals[j], P, gp))
    for scope, k, frm, to, P2, gp in trials:
        S2 = dict(S, params=gp); c2 = cands if gp is S['params'] else cand_sets(F, S2)
        T, eq, np_ = simulate(F, S2, P2, c2); s = stats(T, eq, np_)
        d1 = round(wret(eq, older) - cur['older'], 2); d2 = round(wret(eq, recent) - cur['recent'], 2)
        ok = s['trades'] >= 30 and d1 >= Gd['w_min_delta'] and d2 >= Gd['w_min_delta'] and (s['mdd'] >= cur['stats']['mdd'] - Gd['w_mdd_tol'] or s['mdd'] >= bench_mdd)   # 回撤不惡化，或不比 0050 自己的回撤差
        tested.append(dict(scope=scope, param=k, frm=frm, to=to, d_older=d1, d_recent=d2, mdd=s['mdd'], trades=s['trades'], total=s['total'], passed=bool(ok), cooling=cool(scope)))
    win = sorted([t for t in tested if t['passed'] and not t['cooling']], key=lambda t: min(t['d_older'], t['d_recent']), reverse=True)
    def desc(t):
        if t['to'] == '套餐': return f"觀察池：改用「{t['param']}」"
        name = PNAME.get(t['param']) if t['scope'] == 'pool' else pipe.PNAME.get(t['param'], t['param'])
        f = lambda v: ('是' if v else '否') if isinstance(v, bool) else (v if isinstance(v, str) else (f"{v*100:.0f}%" if t['param'] in ('hard_stop',) or t['param'].startswith('ext20') else f"{v:g}"))
        return f"{'觀察池' if t['scope']=='pool' else t['scope']}：{name} {f(t['frm'])} → {f(t['to'])}"
    adopted = None
    if win:
        t = win[0]
        if t['scope'] == 'pool':
            if t['to'] == '套餐':
                for k, v in next(kw for n, kw in PRESETS.items() if n == t['param']).items(): S.setdefault('pool', {})[k] = v
            else: S.setdefault('pool', {})[t['param']] = t['to']
        else: S['params'][t['scope']][t['param']] = t['to']
        S['version'] = S.get('version', 1) + 1
        adopted = dict(date=today, ver=S['version'], scope=t['scope'], desc=desc(t), d_older=t['d_older'], d_recent=t['d_recent'])
        S['wlog'].append(adopted)
        S['log'].append(dict(date=today, ver=S['version'], group=t['scope'] if t['scope'] != 'pool' else '觀察池', auto=True, desc=desc(t), d_older=t['d_older'], d_recent=t['d_recent']))
        note = f"採用：{desc(t)}（前段 {t['d_older']:+.2f}、近 {Gd['w_recent']} 日 {t['d_recent']:+.2f} 個百分點）"
    else:
        near = sorted([t for t in tested], key=lambda t: min(t['d_older'], t['d_recent']), reverse=True)
        held = [t for t in tested if t['passed'] and t['cooling']]
        if held:
            t = held[0]; note = f"有一項達標但暫緩（該範圍 {Gd['w_cooldown_weeks']} 週內剛調整過）：{desc(t)}（前段 {t['d_older']:+.2f}、近 {Gd['w_recent']} 日 {t['d_recent']:+.2f}）"
        else:
            note = f"沒有任何調整在兩段期間都改善 ≥ {Gd['w_min_delta']:.1f} 個百分點且回撤不惡化（或不差於 0050 的 {bench_mdd:.1f}%），維持現行規則"
            if near: note += f"（最接近：{desc(near[0])}，前段 {near[0]['d_older']:+.2f}、近 {Gd['w_recent']} 日 {near[0]['d_recent']:+.2f}）"
    S['daily'] = (S.get('daily') or [])[-60:] + [dict(date=today, adopted=bool(adopted), ver=S['version'], note=note, tested=len(tested), weekly=True)]
    S['updated'] = today; S.setdefault('pool', {})
    S['windows'] = dict(older=[str(older[0].date()), str(older[-1].date())], recent=[str(recent[0].date()), str(recent[-1].date())])
    S['current_pool'] = cur
    json.dump(S, open('strategy.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    # 實際觀察池本週結算
    pool = load_pool(); C = pd.DataFrame(pool['closed'])
    wk_start = (pd.Timestamp(today) - pd.Timedelta(days=6)).date()
    wk = C[pd.to_datetime(C.exit_date).dt.date >= wk_start] if len(C) else C
    b = pipe.load('0050').close
    out = dict(date=today, week_start=str(wk_start), backtest=dict(cur=cur, start=str(eq0.index[0].date()), end=str(eq0.index[-1].date()),
               bench=round(float(b.loc[eq0.index[0]:eq0.index[-1]].iloc[-1] / b.loc[eq0.index[0]:eq0.index[-1]].iloc[0] - 1) * 100, 2)),
               tested=sorted(tested, key=lambda t: min(t['d_older'], t['d_recent']), reverse=True)[:12], adopted=adopted, note=note,
               week=dict(closed=wk.to_dict('records') if len(wk) else [], n=int(len(wk)), avg=round(float(wk.ret.mean()), 2) if len(wk) else None,
                         hit=round(float((wk.ret > 0).mean()) * 100) if len(wk) else None), summary=pool_summary(pool), open=pool['positions'], params=params(S))
    json.dump(out, open('weekly.json', 'w'), ensure_ascii=False, indent=1, default=str)
    eq0.to_csv('pool_equity.csv'); T0.to_csv('pool_trades.csv', index=False)
    print(note); print(json.dumps(cur, ensure_ascii=False))


if __name__ == '__main__':
    {'plan': plan, 'commit': commit, 'backtest': backtest, 'weekly': weekly}[sys.argv[1]]()
