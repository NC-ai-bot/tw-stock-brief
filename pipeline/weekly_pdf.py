# 週報 PDF：讀 weekly.json、pool.json、pool_equity.csv、strategy.json、weekly_notes.json（選用）→ 晨報週報_YYYYMMDD.pdf
import json, os, io, base64
import pandas as pd, numpy as np, pipe
import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt, matplotlib.font_manager as fm
fm.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'); plt.rcParams['font.family'] = 'Noto Sans CJK TC'

W = json.load(open('weekly.json', encoding='utf-8')); S = pipe.load_strategy(); P = W['params']
N = json.load(open('weekly_notes.json', encoding='utf-8')) if os.path.exists('weekly_notes.json') else {}
pool = json.load(open('pool.json', encoding='utf-8')) if os.path.exists('pool.json') else {'positions': [], 'closed': [], 'equity': []}
COL = {'開始轉多': '#c0392b', '開始轉空': '#1e7d45', '強勢發動': '#a8660a', '跌到支撐': '#2c5d9e', '趨勢翻多': '#6c3fb5'}
WHY = {'stop': '停損', 'hard': '硬停損', 'hold': '期滿'}
today = pd.Timestamp(W['date']); wk0 = pd.Timestamp(W['week_start'])
fmt = lambda v: '—' if v is None else f'{v:+.2f}%'
color = lambda v: '#5d6670' if v is None else '#c0392b' if v > 0 else '#1e7d45' if v < 0 else '#5d6670'
md = lambda d: str(d)[5:10].replace('-', '/')

I = pipe.load('TSE01'); Iw = I.close.loc[:today]; prev_wk = Iw[Iw.index < wk0]
wk_tse = (Iw.iloc[-1] / prev_wk.iloc[-1] - 1) * 100 if len(prev_wk) else 0.0
b50 = pipe.load('0050').close.loc[:today]; pb = b50[b50.index < wk0]; wk_b = (b50.iloc[-1] / pb.iloc[-1] - 1) * 100 if len(pb) else 0.0
sm = W['summary']; wk = W['week']
# 實際觀察池本週：持股平均日報酬（equity）
eqp = pd.DataFrame(pool.get('equity', []))
wk_pool = None
if len(eqp):
    eqp['date'] = pd.to_datetime(eqp.date); e0 = eqp[eqp.date < wk0]; e1 = eqp[(eqp.date >= wk0) & (eqp.date <= today)]
    if len(e1): wk_pool = (e1['eq'].iloc[-1] / (e0['eq'].iloc[-1] if len(e0) else 1.0) - 1) * 100

# ---- 圖：回測權益 vs 0050 ----
pe = pd.read_csv('pool_equity.csv', index_col=0, parse_dates=True).iloc[:, 0]
bb = pipe.load('0050').close.loc[pe.index[0]:pe.index[-1]]; bb = bb / bb.iloc[0]
fig, ax = plt.subplots(figsize=(7.2, 2.7), dpi=160)
for s, c, lab in [(pe, '#2a78d6', '觀察池（回測）'), (bb, '#1baf7a', '0050')]:
    ax.plot(s.index, (s - 1) * 100, color=c, lw=2, label=lab)
    ax.annotate(f'{lab} {(s.iloc[-1]-1)*100:+.1f}%', (s.index[-1], (s.iloc[-1] - 1) * 100), xytext=(4, 0), textcoords='offset points', fontsize=8, va='center')
ax.axvspan(pd.Timestamp(S['windows']['recent'][0]), pe.index[-1], color='#f0f0f0', zorder=0)
ax.set_ylabel('累積報酬 (%)', fontsize=8); ax.tick_params(labelsize=8); ax.grid(axis='y', color='#e5e7ea', lw=0.6)
for sp in ('top', 'right'): ax.spines[sp].set_visible(False)
ax.set_xlim(pe.index[0], pe.index[-1] + pd.Timedelta(days=40)); ax.legend(fontsize=8, frameon=False, loc='upper left'); fig.tight_layout()
buf = io.BytesIO(); fig.savefig(buf, format='png'); chart = base64.b64encode(buf.getvalue()).decode()

def tr_closed(rows):
    if not rows: return '<tr><td colspan=9 class=note>本週沒有結算的交易</td></tr>'
    return ''.join(f'<tr><td class=code>{r["code"]}</td><td>{r["name"]}</td><td><span style="color:{COL.get(r["group"], "#5d6670")}">{r["group"]}</span></td><td class=n>{md(r["entry_date"])}</td><td class=n>{md(r["exit_date"])}</td><td class=n>{r["entry"]:,.2f}</td><td class=n>{r["exit"]:,.2f}</td><td class=n style="color:{color(r["ret"])};font-weight:600">{fmt(r["ret"])}</td><td class=n>{r["days"]} 天・{WHY.get(r["why"], r["why"])}</td></tr>' for r in sorted(rows, key=lambda r: r['exit_date']))
def tr_open(rows):
    if not rows: return '<tr><td colspan=8 class=note>目前池內無持股</td></tr>'
    return ''.join(f'<tr><td class=code>{r["code"]}</td><td>{r["name"]}</td><td><span style="color:{COL.get(r["group"], "#5d6670")}">{r["group"]}</span></td><td class=n>{md(r["entry_date"])}</td><td class=n>{r["entry"]:,.2f}</td><td class=n>{r.get("last", r["entry"]):,.2f}</td><td class=n style="color:{color(r.get("ret", 0))};font-weight:600">{fmt(r.get("ret", 0))}</td><td class=n>{r.get("days", 0)}/{P["hold"]}・停損 {r.get("stop_now", 0):,.2f}（{r.get("stop_dist", 0):+.1f}%）</td></tr>' for r in sorted(rows, key=lambda r: r['entry_date']))

C = pd.DataFrame(pool['closed'])
grp_rows = ''
if len(C):
    g = C.groupby('group').agg(n=('ret', 'size'), avg=('ret', 'mean'), hit=('ret', lambda s: (s > 0).mean()), stop=('why', lambda s: (s != 'hold').mean()))
    grp_rows = ''.join(f'<tr><td><b style="color:{COL.get(k, "#5d6670")}">{k}</b></td><td class=n>{int(r.n)}</td><td class=n style="color:{color(r.avg)}">{fmt(r.avg)}</td><td class=n>{r.hit*100:.0f}%</td><td class=n>{r.stop*100:.0f}%</td></tr>' for k, r in g.iterrows())

page1 = f'''
<h1>晨報週報 <span class=sub>{md(wk0)}～{md(today)}・觀察池 {sm.get("start") or "—"} 起</span></h1>
<div class=kpis>
<div class=kpi><div class=l>加權指數本週</div><div class=v style="color:{color(wk_tse)}">{fmt(wk_tse)}</div><div class=s>收 {Iw.iloc[-1]:,.0f}</div></div>
<div class=kpi><div class=l>觀察池本週</div><div class=v style="color:{color(wk_pool)}">{fmt(wk_pool)}</div><div class=s>持股平均日報酬累積；同期 0050 {fmt(wk_b)}</div></div>
<div class=kpi><div class=l>本週結算</div><div class=v>{wk["n"]} 筆</div><div class=s>{"平均 " + fmt(wk["avg"]) + "、勝率 " + str(wk["hit"]) + "%" if wk["n"] else "本週無結算"}</div></div>
<div class=kpi><div class=l>觀察池累積（{sm.get("start") or "—"} 起）</div><div class=v style="color:{color(sm.get("cum"))}">{fmt(sm.get("cum"))}</div><div class=s>已結算 {sm["closed"]} 筆・同期 0050 {fmt(sm.get("bench"))}</div></div>
</div>
<h2>本週結算交易</h2>
<table><tr><th>代號</th><th>名稱</th><th>組別</th><th class=n>進場</th><th class=n>出場</th><th class=n>進場價</th><th class=n>出場價</th><th class=n>報酬</th><th class=n>持有・原因</th></tr>{tr_closed(wk["closed"])}</table>
<h2>目前持股（{len(W["open"])}／{P["pool_max"]}）</h2>
<table><tr><th>代號</th><th>名稱</th><th>組別</th><th class=n>進場日</th><th class=n>進場價</th><th class=n>現價</th><th class=n>報酬</th><th class=n>持有天數・停損</th></tr>{tr_open(W["open"])}</table>
{"<h2>累積各組表現（實際觀察池）</h2><table><tr><th>組別</th><th class=n>筆數</th><th class=n>平均報酬</th><th class=n>勝率</th><th class=n>停損出場比例</th></tr>" + grp_rows + "</table>" if grp_rows else ""}
<p class=note>報酬以實際進場參考價（入選日收盤）與出場日收盤計算，未含交易成本。觀察池累積報酬＝每日持股平均報酬連乘，空手日為 0。</p>
'''

review = N.get('review') or []
if not review:
    review = ['本週尚無人工檢討；以下為程式統計。']
    if wk['n']: review.append(f"本週結算 {wk['n']} 筆，平均 {fmt(wk['avg'])}、勝率 {wk['hit']}%。")
    if len(C):
        best = C.sort_values('ret').iloc[-1]; worst = C.sort_values('ret').iloc[0]
        review.append(f"累積最好：{best['name']} {fmt(best['ret'])}；最差：{worst['name']} {fmt(worst['ret'])}。停損出場比例 {sm.get('stop_rate')}%。")
page2 = '<h1>本週檢討</h1>' + ''.join(f'<h2>{i+1}. {p.split("：")[0] if "：" in p[:30] else ""}</h2><p>{p.split("：",1)[1] if "：" in p[:30] else p}</p>' for i, p in enumerate(review))
mkt = N.get('market')
if mkt: page2 += '<h2>大盤</h2>' + ''.join(f'<p>{x}</p>' for x in (mkt if isinstance(mkt, list) else [mkt]))

bt = W['backtest']; cur = bt['cur']['stats']
trows = ''.join(f'<tr{" class=hl" if t["passed"] and not t["cooling"] else ""}><td>{("觀察池" if t["scope"]=="pool" else t["scope"])}：{t["param"] if t["to"]=="套餐" else f"{t[chr(112)+chr(97)+chr(114)+chr(97)+chr(109)]} {t[chr(102)+chr(114)+chr(109)]} → {t[chr(116)+chr(111)]}"}</td><td class=n style="color:{color(t["d_older"])}">{t["d_older"]:+.2f}</td><td class=n style="color:{color(t["d_recent"])}">{t["d_recent"]:+.2f}</td><td class=n>{t["mdd"]:.1f}%</td><td class=n>{t["total"]:+.1f}%</td><td>{"採用" if t["passed"] and not t["cooling"] else ("達標但冷卻中" if t["passed"] else "未達標")}</td></tr>' for t in W['tested'][:10])
rules = ''.join(f'<tr><td>{k}</td><td class=n>{v}</td></tr>' for k, v in [('每日最多新增', f"{P['max_new']}（非多頭 {P['bear_new']}）"), ('池內上限', P['pool_max']), ('訊號須連續成立', f"{P['persist']} 天"), ('持有上限', f"{P['hold']} 個交易日"), ('硬停損', f"{P['hard_stop']*100:.0f}%"), ('出場後暫不再進場', f"{P['reentry_gap']} 天")])
page3 = f'''
<h1>滾動式優化</h1>
<div class=two><div>
<h2>目前規則（第 {S.get("version", 1)} 版）</h2><table>{rules}</table>
<p class=note>各組的篩選參數見晨報最後一頁。</p>
</div><div>
<h2>回測（{bt["start"]}～{bt["end"]}）</h2>
<table><tr><td>累積報酬</td><td class=n style="color:{color(cur["total"])}"><b>{fmt(cur["total"])}</b></td></tr><tr><td>同期 0050</td><td class=n>{fmt(bt["bench"])}</td></tr><tr><td>筆數／每筆平均／勝率</td><td class=n>{cur["trades"]}／{fmt(cur["avg"])}／{cur["hit"]}%</td></tr><tr><td>最大回撤</td><td class=n>{cur["mdd"]:.1f}%</td></tr><tr><td>平均持股</td><td class=n>{cur["avg_pos"]} 檔</td></tr><tr><td>前段／近 {S["guard"].get("w_recent", 40)} 日報酬</td><td class=n>{fmt(bt["cur"]["older"])}／{fmt(bt["cur"]["recent"])}</td></tr></table>
</div></div>
<img src="data:image/png;base64,{chart}" style="width:100%;margin:6px 0 2px">
<p class=note>灰底為「近期」視窗。採用條件：改動後前段與近期報酬都改善 ≥ {S["guard"].get("w_min_delta", 1.0):.1f} 個百分點，且最大回撤不惡化超過 {S["guard"].get("w_mdd_tol", 2.0):.0f} 個百分點；每週最多改一項，同一範圍 {S["guard"].get("w_cooldown_weeks", 2)} 週內不重複調整。</p>
<h2>本週結果：{"採用一項調整" if W["adopted"] else "維持現行規則"}</h2>
<p>{W["note"]}</p>
<table><tr><th>測試項目</th><th class=n>前段差異</th><th class=n>近期差異</th><th class=n>回撤</th><th class=n>全期報酬</th><th>判定</th></tr>{trows}</table>
<h2>下週觀察</h2>
{''.join(f"<p>{x}</p>" for x in (N.get("outlook") or ["（本週無人工備註）"]))}
<p class=note>技術面整理，不構成投資建議。</p>
'''
css = '''
@page{size:A4;margin:14mm 13mm}
body{font-family:"Noto Sans CJK TC","Noto Sans TC",sans-serif;color:#1b1f24;font-size:11px;line-height:1.55;margin:0}
h1{font-size:20px;margin:0 0 10px}h1 .sub{font-size:11px;color:#5d6670;font-weight:400;margin-left:10px}
h2{font-size:13px;margin:12px 0 4px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th{background:#f6f7f8;color:#5d6670;font-weight:500;font-size:10px;text-align:left;padding:4px 6px}
td{padding:3.5px 6px;border-top:1px solid #e5e7ea}.n{text-align:right}th.n{text-align:right}.code{font-family:ui-monospace,monospace;color:#5d6670}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:6px 0 10px}
.kpi{border:1px solid #e5e7ea;border-radius:6px;padding:8px 10px}.kpi .l{font-size:10px;color:#5d6670}.kpi .v{font-size:20px;font-weight:600;margin:2px 0}.kpi .s{font-size:9.5px;color:#5d6670}
.two{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.note{font-size:9.5px;color:#5d6670}.page{page-break-after:always}tr.hl td{background:#eef4fc;font-weight:600}p{margin:4px 0 6px}
'''
page4 = ''
if os.path.exists('st_study.json'):
    ST = json.load(open('st_study.json', encoding='utf-8'))
    vrows = ''.join(f'<tr{" class=hl" if v["label"]==ST["best"] else ""}><td>{v["label"]}</td><td class=n>{v["trades"]}</td><td class=n>{fmt(v["avg"])}</td><td class=n>{v["hit"]}%</td><td class=n style="color:{color(v["total"])}"><b>{fmt(v["total"])}</b></td><td class=n>{v["mdd"]:.1f}%</td><td class=n>{fmt(v["older"])}／{fmt(v["recent"])}</td></tr>' for v in ST['variants'])
    grows = ''.join(f'<tr><td>{g["label"]}</td><td class=n style="color:{color(g["total"])}">{fmt(g["total"])}</td><td class=n>{g["mdd"]:.1f}%</td><td class=n>{g["trades"]}</td></tr>' for g in ST['grid'])
    segs = ''
    for label, rows in ST['segments'].items():
        segs += f'<tr><td>{label}</td>' + ''.join(f'<td class=n>{fmt(rows[k]["avg"]) + " / " + fmt(rows[k]["bench"]) + f"（{rows[k][chr(119)+chr(105)+chr(110)]}/{rows[k][chr(110)]} 勝）"}</td>' if k in rows else '<td class=n>—</td>' for k in ('趨勢', '盤整', '回檔')) + '</tr>'
    page4 = f'''
<h1>超級趨勢研究 <span class=sub>{ST["start"]}～{ST["end"]}・0050 {fmt(ST["bench"])}、最大回撤 {ST["bench_mdd"]:.1f}%</span></h1>
<p>{ST["verdict"]}。</p>
<table><tr><th>做法</th><th class=n>筆數</th><th class=n>每筆平均</th><th class=n>勝率</th><th class=n>全期</th><th class=n>最大回撤</th><th class=n>前段／近期</th></tr>{vrows}</table>
<img src="data:image/png;base64,{ST["chart"]}" style="width:100%;margin:6px 0 2px">
<div class=two><div><h2>B 的 ATR 週期 × 倍數</h2><table><tr><th>設定</th><th class=n>全期</th><th class=n>回撤</th><th class=n>筆數</th></tr>{grows}</table></div>
<div><h2>依行情分段（月平均報酬 / 0050）</h2><table><tr><th>做法</th><th class=n>趨勢月</th><th class=n>盤整月</th><th class=n>回檔月</th></tr>{segs}</table>
<p class=note>以 0050 當月漲跌分類：跌逾 3% 為回檔月、±3% 內為盤整月、其餘為趨勢月。</p></div></div>
<p class=note>A＝現行觀察池；B＝現行三組訊號進場、收盤跌破超級趨勢線出場（不設持有天數）；C＝超級趨勢翻多即進場、跌破出場；D／E＝加上 ADX ≥ 20 的盤整過濾；F／G＝超級趨勢翻多進場、沿用現行出場（持 20 天＋均線停損）。是否切換由上一頁的優化規則決定（兩段期間都改善且回撤不惡化才採用）。技術面整理，不構成投資建議。</p>
'''
html = f'<!doctype html><html><head><meta charset="utf-8"><style>{css}</style></head><body><div class=page>{page1}</div><div class=page>{page2}</div><div{" class=page" if page4 else ""}>{page3}</div>{page4}</body></html>'
out = f"晨報週報_{W['date'].replace('-', '')}.pdf"
open('weekly.html', 'w', encoding='utf-8').write(html)
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(); pg.set_content(html); pg.wait_for_timeout(300)
    pg.pdf(path=out, format='A4', print_background=True); br.close()
print(out)
