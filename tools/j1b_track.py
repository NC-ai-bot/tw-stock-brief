"""J1b 紙上追蹤（I1 為主＋急跌反彈閘門；測試中，只記錄、不納入觀察池、不改實盤）。

    python3 tools/j1b_track.py docs        # 讀 docs/data/kl、divs_all、universe → 寫 docs/data/j1b.json、j1b_log.json

做法：每晚用 docs/data/kl（全部股票要先更新到資料日）從 2018 年整段重跑一次模擬，取最後一天的狀態。
規則（2026/11/12 回測選定，專案文件「J1混合模型_20261112」）：
  主體 I1：加權收盤在季線上才新增；個股超級趨勢(10,3) 多方、收盤在季線上；依評分（趨勢／品質／量能三組 z 分數）每天最多 3 檔、池 10 檔。
  反彈閘門：加權在季線下、近 10 個交易日對月線乖離曾低於 −7%、當天收盤站上 5 日線 → 當天改用「%R(14) 近 5 日曾低於 −80、當天站回 −50」的股票，依 ADX 排序。
  進場：隔天依可買入上限（收盤＋0.5 ATR）；部位 1.2% ÷ (3×ATR%)，夾在 5%～15%。
  出場：收盤跌破「進場後最高收盤 − 3 ATR」或虧損逾 10%，隔天開盤賣。手續費 0.1425%×2、證交稅 0.3%。
只用標準函式庫＋numpy／pandas。不需要 token。
"""
import sys, os, json
import numpy as np, pandas as pd

FEE, TAX = 0.001425, 0.003
C = dict(pool_max=10, day_max=3, cap_atr=0.5, k_atr=3.0, hard=0.10, risk=0.012, w_min=0.05, w_max=0.15, reentry_gap=5, gate_bias=-0.07, gate_look=10, min_w=0.01)
START, TRACK_START = '2018-01-02', '2026-11-11'
BT = '回測（2018–2026/11，還原價、扣成本，現行股票池）：年化 55%、最大回撤 −26%；同期 I1 44%／−27%、W4 34%／−27%、0050 24%／−34%。閘門九年只開 52 天、約 10 次急跌，獲利集中在其中三四次。'


def load(docs):
    root = os.path.join(docs, 'data'); uni = json.load(open(os.path.join(root, 'universe.json'), encoding='utf-8')); divs = json.load(open(os.path.join(root, 'divs_all.json'), encoding='utf-8'))['data']
    codes = sorted(c for c, v in uni.items() if not v.get('etf') and c not in ('0050', 'TSE01', 'OTC01'))
    out = {}
    for code in codes + ['TSE01', '0050']:
        p = os.path.join(root, 'kl', code + '.json')
        if not os.path.exists(p): continue
        bars = json.load(open(p, encoding='utf-8'))['bars']
        df = pd.DataFrame([b[:6] for b in bars], columns=['date', 'open', 'high', 'low', 'close', 'vol']); df['date'] = pd.to_datetime(df['date']); df = df.set_index('date').sort_index()
        df = df[~df.index.duplicated(keep='last')]; df = df[df.close > 0]
        ev = list(divs.get(code, []))
        if code == '0050': ev.append(['2025-06-18', 0.25, 0])   # 一拆四，divs_all 沒收錄
        f = pd.Series(1.0, index=df.index)
        for e in ev:
            if 0 < e[1] < 1.5: f[f.index < pd.Timestamp(e[0])] *= e[1]
        raw_close = df.close.copy()
        for c in ('open', 'high', 'low', 'close'): df[c] = df[c] * f
        df['vol'] = df['vol'] / f; df['raw'] = raw_close; df['factor'] = f
        if len(df) >= 260: out[code] = df
    names = {c: v.get('name', c) for c, v in uni.items()}
    return out, names


def supertrend(df, period=10, mult=3.0):
    h, l, c = df.high, df.low, df.close
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1); atr = tr.ewm(alpha=1 / period, adjust=False).mean()
    hl2 = (h + l) / 2; ub = (hl2 + mult * atr).values; lb = (hl2 - mult * atr).values
    n = len(df); fu = ub.copy(); fl = lb.copy(); d = np.ones(n); cv = c.values
    for i in range(1, n):
        fl[i] = lb[i] if (lb[i] > fl[i - 1] or cv[i - 1] < fl[i - 1]) else fl[i - 1]
        fu[i] = ub[i] if (ub[i] < fu[i - 1] or cv[i - 1] > fu[i - 1]) else fu[i - 1]
        if d[i - 1] == 1: d[i] = -1 if cv[i] < fl[i] else 1
        else: d[i] = 1 if cv[i] > fu[i] else -1
    return d


def indicators(df):
    c, h, l, v = df.close, df.high, df.low, df.vol; o = pd.DataFrame(index=df.index)
    for k in ('open', 'high', 'low', 'close', 'raw', 'factor'): o[k] = df[k]
    for n in (5, 20, 60, 200): o[f'ma{n}'] = c.rolling(n).mean()
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1); o['atr'] = tr.ewm(alpha=1 / 14, adjust=False).mean(); o['atrp'] = o.atr / c * 100
    o['ret120'] = c / c.shift(120) - 1
    d = c.diff(); up = d.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean(); dn = (-d).clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean(); o['rsi'] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    hh = h.rolling(14).max(); ll = l.rolling(14).min(); o['wr'] = (hh - c) / (hh - ll).replace(0, np.nan) * -100
    upm = (h - h.shift()).clip(lower=0); dnm = (l.shift() - l).clip(lower=0); pdm = upm.where(upm > dnm, 0.0); mdm = dnm.where(dnm > upm, 0.0)
    pdi = 100 * pdm.ewm(alpha=1 / 14, adjust=False).mean() / o.atr; mdi = 100 * mdm.ewm(alpha=1 / 14, adjust=False).mean() / o.atr
    o['adx'] = (100 * (pdi - mdi).abs() / (pdi + mdi)).fillna(0).ewm(alpha=1 / 14, adjust=False).mean()
    o['stdir'] = supertrend(df, 10, 3.0)
    obv = (np.sign(c.diff()).fillna(0) * v).cumsum(); o['obv_slope'] = (obv - obv.shift(20)) / v.rolling(20).mean() / 20
    bb = c.rolling(20).std() / c.rolling(20).mean(); o['squeeze'] = bb / bb.rolling(120).mean()
    o['d_ma200'] = c / o.ma200 - 1; o['d_ma60'] = c / o.ma60 - 1; o['ma200_slope'] = o.ma200 / o.ma200.shift(20) - 1; o['bias20'] = c / o.ma20 - 1
    return o


def run(docs):
    raw, names = load(docs); F = {c: indicators(d) for c, d in raw.items()}
    codes = sorted(c for c in F if c not in ('TSE01', '0050')); idx = F['TSE01'].index; idx = idx[idx >= '2017-01-01']
    P = {k: pd.DataFrame({c: F[c][k] for c in codes}).reindex(idx) for k in ('open', 'low', 'close', 'raw', 'factor', 'ma5', 'ma60', 'ma200', 'atr', 'atrp', 'ret120', 'rsi', 'wr', 'adx', 'stdir', 'obv_slope', 'squeeze', 'd_ma200', 'd_ma60', 'ma200_slope')}
    m = F['TSE01'].reindex(idx); b50 = F['0050'].reindex(idx).close
    # I1 評分
    G = {'trend': ['ret120', 'd_ma200', 'ma200_slope'], 'quality': ['adx', 'rsi'], 'flow': ['obv_slope', 'squeeze']}; valid = P['ma200'].notna() & P['ret120'].notna(); Z = {}
    for k in sum(G.values(), []):
        x = P[k].where(valid); Z[k] = x.sub(x.mean(axis=1), axis=0).div(x.std(axis=1).replace(0, np.nan), axis=0).clip(-3, 3)
    score = sum(sum(Z[k] for k in ks) / len(ks) for ks in G.values())
    cand_i1 = score.where(P['ma200'].notna() & (P['stdir'] == 1) & (P['d_ma60'] > 0))
    wr = P['wr']; cand_rb = P['adx'].where((wr.rolling(5).min() < -80) & (wr > -50) & (wr.shift(1) <= -50))
    above = (m.close > m.ma60); minb = m.bias20.rolling(C['gate_look']).min(); gate = (~above) & (minb < C['gate_bias']) & (m.close > m.ma5)
    S = [('I1', cand_i1.values, above.fillna(False).values), ('反彈', cand_rb.values, gate.fillna(False).values)]
    O, L, CL, ATR, ATRP = (P[k].values for k in ('open', 'low', 'close', 'atr', 'atrp')); ci = {c: j for j, c in enumerate(codes)}
    i0 = idx.searchsorted(pd.Timestamp(START)); i1 = len(idx) - 1
    pos = {}; trades = []; eq = []; cash = 1.0; last_exit = {}; pend_exit = []; pend_new = []
    for i in range(i0, i1 + 1):
        d = idx[i]
        for c, why in pend_exit:
            p = pos.pop(c); j = ci[c]; px = O[i, j] if not np.isnan(O[i, j]) else p['last']; proceeds = p['shares'] * px * (1 - FEE - TAX); cash += proceeds
            trades.append(dict(code=c, tag=p['tag'], entry_date=p['entry_date'], exit_date=d, entry=p['entry'], exit=px, ret=proceeds / p['cost'] - 1, days=p['days'], why=why, w=p['w'])); last_exit[c] = i
        pend_exit = []
        val0 = cash + sum(p['shares'] * p['last'] for p in pos.values())
        for j, tag, cap, w in pend_new:
            c = codes[j]; o, lo = O[i, j], L[i, j]
            if np.isnan(o) or c in pos: continue
            e = o if o <= cap else (cap if lo <= cap else None)
            if e is None: continue
            amt = min(val0 * w, cash)
            if amt <= val0 * C['min_w']: continue
            cash -= amt; pos[c] = dict(tag=tag, entry=e, cost=amt, shares=amt / (e * (1 + FEE)), entry_date=d, days=0, hi=e, last=e, w=amt / val0)
        pend_new = []
        for c, p in pos.items():
            j = ci[c]; px = CL[i, j]
            if np.isnan(px): continue
            p['last'] = px; p['hi'] = max(p['hi'], px)
            if p['entry_date'] != d: p['days'] += 1
            p['stop'] = p['hi'] - C['k_atr'] * ATR[i, j]
            why = 'hard' if px / p['entry'] - 1 < -C['hard'] else 'line' if px < p['stop'] else None
            if why: pend_exit.append((c, why))
        eq.append(cash + sum(p['shares'] * p['last'] for p in pos.values()))
        leaving = {c for c, _ in pend_exit}; room = C['pool_max'] - (len(pos) - len(leaving)); left = C['day_max']; chosen = set()
        for tag, cv, ok in S:
            if room <= 0 or left <= 0: break
            if not ok[i]: continue
            row = cv[i]; n = 0
            for j in np.argsort(-np.nan_to_num(row, nan=-1e18)):
                if np.isnan(row[j]) or n >= min(room, left): break
                c = codes[j]
                if c in pos or c in chosen or (c in last_exit and i - last_exit[c] < C['reentry_gap']) or np.isnan(ATRP[i, j]): continue
                w = min(C['w_max'], max(C['w_min'], C['risk'] / (C['k_atr'] * ATRP[i, j] / 100)))
                pend_new.append((j, tag, CL[i, j] * (1 + C['cap_atr'] * ATRP[i, j] / 100), w)); chosen.add(c); n += 1
            room -= n; left -= n
    equity = pd.Series(eq, index=idx[i0:]); D = idx[i1]; fac = P['factor'].iloc[-1]
    px = lambda c, v: round(float(v / fac[c]), 2)   # 還原價 → 目前的實際價位
    leaving = dict(pend_exit)
    hold = [dict(code=c, name=names.get(c, c), tag=p['tag'], entry_date=str(p['entry_date'].date()), entry=px(c, p['entry']), last=px(c, p['last']), ret=round((p['last'] / p['entry'] - 1) * 100, 2), days=p['days'], w=round(p['w'], 4),
                 stop_now=px(c, p['stop']), stop_dist=round((p['last'] / p['stop'] - 1) * 100, 2)) for c, p in pos.items() if c not in leaving]
    exits = [dict(code=c, name=names.get(c, c), tag=pos[c]['tag'], entry_date=str(pos[c]['entry_date'].date()), entry=px(c, pos[c]['entry']), last=px(c, pos[c]['last']), ret=round((pos[c]['last'] / pos[c]['entry'] - 1) * 100, 2), days=pos[c]['days'], why=why) for c, why in pend_exit]
    new = [dict(code=codes[j], name=names.get(codes[j], codes[j]), tag=tag, ref=px(codes[j], CL[i1, j]), entry=px(codes[j], CL[i1, j]), cap=px(codes[j], cap), w=round(w, 4), atr_pct=round(float(ATRP[i1, j]), 2),
                stop_now=px(codes[j], CL[i1, j] - C['k_atr'] * ATR[i1, j])) for j, tag, cap, w in pend_new]
    T = pd.DataFrame(trades); ts = pd.Timestamp(TRACK_START); base = equity.loc[:ts].iloc[-1]; since = T[T.exit_date > ts] if len(T) else T
    closed = [dict(code=r.code, name=names.get(r.code, r.code), tag=r.tag, entry_date=str(r.entry_date.date()), exit_date=str(r.exit_date.date()), ret=round(r.ret * 100, 2), days=int(r.days), why=r.why) for r in T.tail(12).itertuples()][::-1]
    yrs = (equity.index[-1] - equity.index[0]).days / 365.25
    out = dict(date=str(D.date()), start=TRACK_START, params=C, backtest=BT,
               gate=dict(open=bool(gate.iloc[-1]), above60=bool(above.iloc[-1]), close=round(float(m.close.iloc[-1]), 2), ma5=round(float(m.ma5.iloc[-1]), 2), ma60=round(float(m.ma60.iloc[-1]), 2), bias20=round(float(m.bias20.iloc[-1]) * 100, 1), minb=round(float(minb.iloc[-1]) * 100, 1)),
               mode='I1（大盤在季線上）' if above.iloc[-1] else '反彈閘門開啟' if gate.iloc[-1] else '空手等待（季線下、閘門未開）',
               new=new, exits=exits, holding=hold, closed=closed,
               stats=dict(start=TRACK_START, cum=round(float(equity.iloc[-1] / base - 1) * 100, 2), bench=round(float(b50.iloc[-1] / b50.loc[:ts].iloc[-1] - 1) * 100, 2), closed=int(len(since)), hit=round(float((since.ret > 0).mean()) * 100) if len(since) else None,
                          open=len(hold), expo=round(float(sum(p['shares'] * p['last'] for c, p in pos.items()) / equity.iloc[-1]) * 100), bt_cagr=round(float(equity.iloc[-1] ** (1 / yrs) - 1) * 100, 1), bt_mdd=round(float((equity / equity.cummax() - 1).min()) * 100, 1)),
               curve=[[str(d.date()), round(float(v / base), 4)] for d, v in equity.loc[ts - pd.Timedelta(days=45):].items()])
    json.dump(out, open(os.path.join(docs, 'data', 'j1b.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    # 每日紀錄：同一資料日只記第一次（之後資料若回補造成重算不同，紀錄不改）
    lp = os.path.join(docs, 'data', 'j1b_log.json'); log = json.load(open(lp, encoding='utf-8')) if os.path.exists(lp) else []
    if not any(r['date'] == out['date'] for r in log):
        log.append(dict(date=out['date'], mode=out['mode'], new=[[n['code'], n['name'], n['tag'], n['cap'], n['w']] for n in new], exits=[[e['code'], e['name'], e['ret'], e['why']] for e in exits], holding=[h['code'] for h in hold], cum=out['stats']['cum'], bench=out['stats']['bench']))
        json.dump(log, open(lp, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f"J1b（{out['date']}，{out['mode']}）新增：" + ('、'.join(f"{n['code']} {n['name']}[{n['tag']}]（上限 {n['cap']}、占 {n['w'] * 100:.0f}%）" for n in new) or '無') + f"｜出場 {[e['code'] for e in exits]}｜持有 {len(hold)}｜追蹤以來 {out['stats']['cum']:+.2f}%（0050 {out['stats']['bench']:+.2f}%）｜回測年化 {out['stats']['bt_cagr']}% 回撤 {out['stats']['bt_mdd']}%")
    return out


if __name__ == '__main__':
    run(sys.argv[1] if len(sys.argv) > 1 else 'docs')
