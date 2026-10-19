# 超級趨勢研究：python3 supertrend.py study  → st_study.json、st_study.png（週報第 4 頁用）
# 比較：A 現行觀察池｜B 現行進場＋超級趨勢出場（不設天數）｜C 純超級趨勢進出｜D B＋ADX 過濾，以及 ATR 週期/倍數的小網格；
# 另外依 0050 月報酬把期間分成「趨勢月／盤整月／回檔月」分別和 0050 比。
import json, io, base64, sys
import pandas as pd, numpy as np, pipe, pool
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt, matplotlib.font_manager as fm
fm.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'); plt.rcParams['font.family'] = 'Noto Sans CJK TC'


def run(F, S, cands, label, **kw):
    P = dict(pool.params(S), bt_days=S.get('guard', {}).get('w_days', 120), **kw)   # 與週報同一回測期間（近約六個月）
    T, eq, npos = pool.simulate(F, S, P, cands)
    st = pool.stats(T, eq, npos)
    return dict(label=label, params={k: v for k, v in kw.items()}, **st), eq, T


def regime(b):
    m = b.resample('ME').last().pct_change().dropna() * 100
    return {d: ('回檔' if v < -3 else '盤整' if abs(v) <= 3 else '趨勢') for d, v in m.items()}


def monthly(eq):
    return eq.resample('ME').last().pct_change().dropna() * 100


def study():
    S = pipe.load_strategy(); F = pipe.features(); cands = pool.cand_sets(F, S)
    b = pipe.load('0050').close
    base = dict(exit_mode='hold', entry_mode='signals', adx_min=0)
    variants = [('A 現行觀察池（持 20 天＋停損）', dict(base)),
                ('B 現行進場＋超級趨勢出場', dict(base, exit_mode='supertrend')),
                ('C 純超級趨勢進出', dict(base, exit_mode='supertrend', entry_mode='supertrend')),
                ('D B＋ADX≥20 過濾', dict(base, exit_mode='supertrend', adx_min=20)),
                ('E C＋ADX≥20 過濾', dict(base, exit_mode='supertrend', entry_mode='supertrend', adx_min=20)),
                ('F 超級趨勢進場＋現行出場（持 20 天＋停損）', dict(base, entry_mode='supertrend')),
                ('G F＋ADX≥20 過濾', dict(base, entry_mode='supertrend', adx_min=20))]
    res = []; eqs = {}
    for label, kw in variants:
        r, eq, T = run(F, S, cands, label, **kw); res.append(r); eqs[label] = eq
    # 小網格：B 的 ATR 週期 × 倍數
    grid = []
    for per in (10, 14, 20):
        for mult in (2.0, 2.5, 3.0):
            r, eq, T = run(F, S, cands, f'B 週期{per}×{mult:g}', exit_mode='supertrend', st_period=per, st_mult=mult)
            grid.append(r)
    bb = b.loc[eqs[variants[0][0]].index[0]:eqs[variants[0][0]].index[-1]]; bb = bb / bb.iloc[0]
    bench = round(float(bb.iloc[-1] - 1) * 100, 2); bdd = round(float((bb / bb.cummax() - 1).min()) * 100, 2)
    # 分段：趨勢／盤整／回檔月
    reg = regime(bb); mb = monthly(bb)
    seg = {}
    for label, eq in eqs.items():
        me = monthly(eq); rows = {}
        for k in ('趨勢', '盤整', '回檔'):
            ds = [d for d, v in reg.items() if v == k and d in me.index]
            if ds: rows[k] = dict(n=len(ds), avg=round(float(me.loc[ds].mean()), 2), bench=round(float(mb.loc[ds].mean()), 2), win=int((me.loc[ds] > mb.loc[ds]).sum()))
        seg[label] = rows
    # 前後兩段
    older, recent = pool.windows(eqs[variants[0][0]], S['guard'].get('w_recent', 30))
    for r in res:
        eq = eqs[r['label']]; r['older'] = round(pool.wret(eq, older), 2); r['recent'] = round(pool.wret(eq, recent), 2)
    # 圖
    fig, ax = plt.subplots(figsize=(7.4, 3.0), dpi=160)
    cols = ['#eb6834', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6c3fb5']
    for (label, eq), c in zip(eqs.items(), cols):
        ax.plot(eq.index, (eq - 1) * 100, color=c, lw=1.8, label=label.split('（')[0])
    ax.plot(bb.index, (bb - 1) * 100, color='#5d6670', lw=1.5, ls='--', label='0050')
    ax.set_ylabel('累積報酬 (%)', fontsize=8); ax.tick_params(labelsize=8); ax.grid(axis='y', color='#e5e7ea', lw=0.6)
    for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
    ax.legend(fontsize=7, frameon=False, loc='upper left', ncol=2); fig.tight_layout()
    buf = io.BytesIO(); fig.savefig(buf, format='png'); open('st_study.png', 'wb').write(buf.getvalue())
    best = max(res, key=lambda r: min(r['older'], r['recent']))
    cur = res[0]
    verdict = (f"最佳為「{best['label']}」：全期 {best['total']:+.1f}%（現行 {cur['total']:+.1f}%、0050 {bench:+.1f}%），前段 {best['older']:+.1f}%／近期 {best['recent']:+.1f}%"
               f"（現行 {cur['older']:+.1f}%／{cur['recent']:+.1f}%），最大回撤 {best['mdd']:.1f}%（現行 {cur['mdd']:.1f}%、0050 {bdd:.1f}%）")
    out = dict(date=str(pd.Timestamp.now(tz='Asia/Taipei').date()), start=str(bb.index[0].date()), end=str(bb.index[-1].date()), bench=bench, bench_mdd=bdd,
               variants=res, grid=grid, segments=seg, regime_months={str(d.date()): v for d, v in reg.items()}, best=best['label'], verdict=verdict,
               chart=base64.b64encode(buf.getvalue()).decode())
    json.dump(out, open('st_study.json', 'w'), ensure_ascii=False, indent=1, default=float)
    print(verdict)
    for r in res: print(r['label'], {k: r[k] for k in ('trades', 'avg', 'hit', 'total', 'mdd', 'older', 'recent')})
    for r in grid: print(r['label'], r['total'], r['mdd'])
    for label, rows in seg.items(): print(label, rows)


if __name__ == '__main__':
    study()
