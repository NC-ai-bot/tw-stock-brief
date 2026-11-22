"""J1b 正式持股帳本（使用者 2026/11/22 決定：自 11/23 晨報起以 J1b 為主要模型）。

    python3 tools/j1b_live.py docs           # 每晚在 j1b_track.py 之後執行：讀 docs/data/kl 等 → 更新 docs/data/j1b_live.json
    python3 tools/j1b_live.py docs --test    # 自我檢查：從 2024-08-01 起逐日模擬，和 j1b_track 的同期回測逐筆比對

跟 j1b_track.py（紙上模型，每晚從 2018 年整段重跑）的差別：
  這裡只記「晨報真的公布過」的事：每個資料日公布的新增（代號、可買入上限、建議占資金）、隔天的成交價、出場訊號與隔天開盤的出場價。
  已公布的不會因為之後資料回補或重算而改變；只有「今天（資料日 D）」的新增是新算的。
  選股排序、成交判定、出場線、部位大小都和 j1b_track.py 完全相同（共用 prep()）；容量（池 10 檔、每天 3 檔）以帳本自己的持股計算。
  帳本從 2026/11/20（11/23 晨報的資料日）空手開始，不承接紙上模型的持股。
價格：對外一律是實際成交價位（未還原）；報酬與出場線判斷用還原價（含息），每晚依最新的除權息係數重算。
"""
import sys, os, json
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import j1b_track as JT

FEE, TAX, C = JT.FEE, JT.TAX, JT.C
START = '2026-11-20'
RULES = ('J1b＝I1 為主＋急跌反彈閘門。大盤（加權）在季線上：每天依綜合評分（趨勢、品質、量能）挑超級趨勢多方且站上季線的股票；'
         '大盤在季線下：平常空手，只有近 10 個交易日對月線乖離曾低於 −7%、且當天收盤站上 5 日線時（反彈閘門），才挑「%R 超賣後站回 −50」的股票，依 ADX 排序。'
         '每天最多新增 3 檔、最多同時持有 10 檔；隔天開盤在「可買入上限」（入選日收盤＋0.5 倍 ATR）以內才買，開盤高於上限但盤中回到上限以內就以上限價買，整天都在上限之上就不追。'
         '每檔資金依波動度配置（建議占資金 5%～15%，波動大的買少）。出場：收盤跌破出場線（進場後最高收盤 − 3 倍 ATR，只升不降）或虧損逾 10%（強制停損），隔天開盤賣出；不設持有天數。')


def _blank(start):
    return dict(start=start, last=None, cash=1.0, positions=[], closed=[], unfilled=[], equity=[], published={})


def step(X, st, D_i, publish=True):
    """把帳本從 st['last'] 的下一個交易日推進到 idx[D_i]；publish=True 時算出 D 當天的新增並記為已公布。回傳當天的事件。"""
    names, codes, idx, P, S = (X[k] for k in ('names', 'codes', 'idx', 'P', 'S'))
    O, L, CL, ATR, ATRP, F = (P[k].values for k in ('open', 'low', 'close', 'atr', 'atrp', 'factor'))
    ci = {c: j for j, c in enumerate(codes)}; di = {d: i for i, d in enumerate(idx)}
    day = lambda s: di[pd.Timestamp(s)]
    first = day(st['start']) if st['last'] is None else day(st['last']) + 1
    ev = dict(filled=[], unfilled=[], sold=[], exits=[], new=[])
    eadj = lambda p: p['entry'] * F[day(p['entry_date']), ci[p['code']]]           # 進場價（實際）→ 目前係數下的還原價
    value = lambda p, i: p['cost'] / (1 + FEE) * (CL[i, ci[p['code']]] if not np.isnan(CL[i, ci[p['code']]]) else p.get('_last', eadj(p))) / eadj(p)
    for i in range(first, D_i + 1):
        t = str(idx[i].date()); ev = dict(filled=[], unfilled=[], sold=[], exits=[], new=[])
        # 1. 前一天收盤觸發的出場：今天開盤賣
        keep = []
        for p in st['positions']:
            if p['status'] == 'open' and p.get('exit_sig') and p['exit_sig']['date'] < t:
                j = ci[p['code']]; o = O[i, j]
                pa = o if not np.isnan(o) else CL[i - 1, j]; praw = pa / F[i, j]
                proceeds = p['cost'] / (1 + FEE) * pa / eadj(p) * (1 - FEE - TAX); st['cash'] += proceeds
                c = dict(code=p['code'], name=p['name'], tag=p['tag'], sig_date=p['sig_date'], entry_date=p['entry_date'], entry=p['entry'], exit_date=t, exit=round(float(praw), 2),
                         ret=round(float(proceeds / p['cost'] - 1) * 100, 2), days=i - day(p['entry_date']), why=p['exit_sig']['why'], w=p['w'])
                st['closed'].append(c); ev['sold'].append(c)
            else: keep.append(p)
        st['positions'] = keep
        # 2. 前一天公布的新增：依可買入上限判定成交
        val0 = st['cash'] + sum(value(p, i - 1) for p in st['positions'] if p['status'] == 'open')
        keep = []
        for p in st['positions']:
            if p['status'] != 'pending' or p['sig_date'] >= t: keep.append(p); continue
            j = ci[p['code']]; o, lo = O[i, j] / F[i, j], L[i, j] / F[i, j]
            e = None if np.isnan(o) else (o if o <= p['cap'] else (p['cap'] if lo <= p['cap'] else None))
            amt = min(val0 * p['w'], st['cash']) if e is not None else 0
            if e is None or amt <= val0 * C['min_w']:
                u = dict(code=p['code'], name=p['name'], tag=p['tag'], sig_date=p['sig_date'], cap=p['cap'], open=None if np.isnan(o) else round(float(o), 2), date=t, why='資金不足' if e is not None else '開盤後整天在上限之上')
                st['unfilled'].append(u); ev['unfilled'].append(u); continue
            st['cash'] -= amt; p.update(status='open', entry=round(float(e), 2), entry_date=t, cost=amt, w_real=round(amt / val0, 4), how='開盤' if e == o else '上限價'); keep.append(p); ev['filled'].append(dict(p))
        st['positions'] = keep
        # 3. 收盤結算：出場線與強制停損
        for p in st['positions']:
            if p['status'] != 'open': continue
            j = ci[p['code']]; cl = CL[i, j]
            if np.isnan(cl): continue
            i0 = day(p['entry_date']); ea = eadj(p); hi = max(ea, np.nanmax(CL[i0:i + 1, j])); stop = hi - C['k_atr'] * ATR[i, j]
            p.update(last=round(float(cl / F[i, j]), 2), ret=round(float(cl / ea - 1) * 100, 2), days=i - i0, stop_now=round(float(stop / F[i, j]), 2), stop_dist=round(float(cl / stop - 1) * 100, 2),
                     lock=round(float(stop / ea - 1) * 100, 1))
            if not p.get('exit_sig'):
                why = 'hard' if cl / ea - 1 < -C['hard'] else 'line' if cl < stop else None
                if why: p['exit_sig'] = dict(date=t, why=why); ev['exits'].append(dict(p))
        eq = st['cash'] + sum(value(p, i) for p in st['positions'] if p['status'] == 'open')
        st['equity'] = [e for e in st['equity'] if e[0] < t] + [[t, round(float(eq), 6)]]
        st['last'] = t
    # 4. 資料日 D 的新增（只有 D 當天才公布；漏跑的日子不補公布）
    if publish:
        i = D_i; t = str(idx[i].date())
        held = {p['code'] for p in st['positions']}; leaving = sum(1 for p in st['positions'] if p.get('exit_sig'))
        recent = {c['code']: day(c['exit_date']) for c in st['closed']}
        room = C['pool_max'] - (len(st['positions']) - leaving); left = C['day_max']; chosen = set(); new = []
        for tag, cv, ok in S:
            if room <= 0 or left <= 0: break
            if not ok[i]: continue
            row = cv[i]; n = 0
            for j in np.argsort(-np.nan_to_num(row, nan=-1e18)):
                if np.isnan(row[j]) or n >= min(room, left): break
                c = codes[j]
                if c in held or c in chosen or (c in recent and i - recent[c] < C['reentry_gap']) or np.isnan(ATRP[i, j]): continue
                w = float(min(C['w_max'], max(C['w_min'], C['risk'] / (C['k_atr'] * ATRP[i, j] / 100))))
                f = F[i, j]; cl = CL[i, j]
                new.append(dict(code=c, name=names.get(c, c), tag=tag, sig_date=t, status='pending', ref=round(float(cl / f), 2), cap=round(float(cl * (1 + C['cap_atr'] * ATRP[i, j] / 100) / f), 2),
                                w=round(w, 4), atr_pct=round(float(ATRP[i, j]), 2), stop_now=round(float((cl - C['k_atr'] * ATR[i, j]) / f), 2)))
                chosen.add(c); n += 1
            room -= n; left -= n
        st['positions'] += new; st['published'][t] = [n['code'] for n in new]; ev['new'] = new
    return ev


def summary(X, st, ev):
    idx, m, b50, above, minb, gate = (X[k] for k in ('idx', 'm', 'b50', 'above', 'minb', 'gate'))
    D = pd.Timestamp(st['last']); s0 = pd.Timestamp(st['start'])
    eq = st['equity']; cum = (eq[-1][1] - 1) * 100 if eq else 0.0
    bench = (b50.loc[D] / b50.loc[s0] - 1) * 100
    Cl = st['closed']; hold = [p for p in st['positions'] if p['status'] == 'open' and not p.get('exit_sig')]
    mode = 'I1（大盤在季線上）' if above.loc[D] else '反彈閘門開啟' if gate.loc[D] else '空手等待（大盤在季線下、反彈閘門未開）'
    clean = lambda p: {k: v for k, v in p.items() if not k.startswith('_')}
    return dict(date=st['last'], start=st['start'], mode=mode, rules=RULES, params=C,
                gate=dict(open=bool(gate.loc[D]), above60=bool(above.loc[D]), close=round(float(m.close.loc[D]), 2), ma5=round(float(m.ma5.loc[D]), 2), ma60=round(float(m.ma60.loc[D]), 2),
                          bias20=round(float(m.bias20.loc[D]) * 100, 1), minb=round(float(minb.loc[D]) * 100, 1)),
                new=[clean(p) for p in ev['new']], exits=[clean(p) for p in ev['exits']], filled=[clean(p) for p in ev['filled']], unfilled=ev['unfilled'], sold=ev['sold'],
                holding=[clean(p) for p in hold], closed=Cl[-20:][::-1],
                stats=dict(start=st['start'], cum=round(cum, 2), bench=round(float(bench), 2), closed=len(Cl), hit=round(sum(c['ret'] > 0 for c in Cl) / len(Cl) * 100) if Cl else None,
                           avg=round(sum(c['ret'] for c in Cl) / len(Cl), 2) if Cl else None, open=len(hold), expo=None),
                curve=eq[-120:])


def run(docs):
    X = JT.prep(docs); idx = X['idx']; path = os.path.join(docs, 'data', 'j1b_live.json')
    old = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else None
    st = old['state'] if old else _blank(START)
    D_i = len(idx) - 1; D = str(idx[D_i].date())
    if D < st['start']: print('資料日早於帳本起始日，不處理'); return
    if st['last'] and D < st['last']: print(f'資料日 {D} 早於帳本最後處理日 {st["last"]}，不處理'); return
    if st['last'] == D: st = old.get('prev') or _blank(START)          # 同一資料日重跑：從前一次的狀態重來（D 的新增重新計算）
    prev = json.loads(json.dumps(st))
    ev = step(X, st, D_i)
    out = summary(X, st, ev); out['state'] = st; out['prev'] = prev
    json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'), default=float)
    print(f"J1b 正式（{D}，{out['mode']}）新增：" + ('、'.join(f"{n['code']} {n['name']}[{n['tag']}]（上限 {n['cap']}、占 {n['w'] * 100:.0f}%）" for n in out['new']) or '無')
          + f"｜成交 {[p['code'] for p in out['filled']]}｜未成交 {[u['code'] for u in out['unfilled']]}｜出場訊號 {[p['code'] for p in out['exits']]}｜持有 {len(out['holding'])}｜自 {st['start']} 起 {out['stats']['cum']:+.2f}%（0050 {out['stats']['bench']:+.2f}%）")
    return out


def selftest(docs, start='2024-08-01'):
    """從 start 起空手，逐日推進（每天都公布），和 j1b_track 從同一天空手起跑的交易逐筆比對"""
    X = JT.prep(docs); idx = X['idx']; st = _blank(start); s_i = list(idx).index(pd.Timestamp(start))
    st['last'] = str(idx[s_i - 1].date())
    for i in range(s_i, len(idx)): step(X, st, i)
    JT.START = start; JT.TRACK_START = start
    import io, contextlib, tempfile, shutil
    tmp = tempfile.mkdtemp(); os.makedirs(os.path.join(tmp, 'data'))
    for f in os.listdir(os.path.join(docs, 'data')):
        if not f.startswith('j1b'): os.symlink(os.path.abspath(os.path.join(docs, 'data', f)), os.path.join(tmp, 'data', f))
    out = JT.run(tmp); shutil.rmtree(tmp)
    mine = sorted((c['code'], c['entry_date'], c['exit_date']) for c in st['closed'])
    eq_m = st['equity'][-1][1]; eq_t = out['curve'][-1][1]
    print(f'帳本 {len(mine)} 筆已出場，最後淨值 {eq_m:.4f}；紙上模型同期最後淨值 {eq_t:.4f}')
    return mine, eq_m, eq_t


if __name__ == '__main__':
    docs = sys.argv[1] if len(sys.argv) > 1 else 'docs'
    selftest(docs) if '--test' in sys.argv else run(docs)
