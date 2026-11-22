"""晨報 PDF 的「J1b 選股」主頁（使用者 2026/11/22 決定：自 11/23 晨報起 J1b 為主要模型）。

    python3 j1b_page.py <app docs 目錄> <晨報 PDF>     # 產生 j1b_page.pdf，插在晨報 PDF 第 1 頁（大盤）之後
讀 docs/data/j1b_live.json（正式帳本）、j1b.json（紙上模型，只取回測與追蹤數字）與工作目錄的 meta.json、pool_out.json（舊 W4 持股）。
"""
import sys, os, json, shutil, subprocess

docs, pdf = sys.argv[1], sys.argv[2]
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.lib.units import mm

pdfmetrics.registerFont(TTFont('WQY', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', subfontIndex=0))
J = json.load(open(os.path.join(docs, 'data', 'j1b_live.json'), encoding='utf-8'))
M = json.load(open(os.path.join(docs, 'data', 'j1b.json'), encoding='utf-8')) if os.path.exists(os.path.join(docs, 'data', 'j1b.json')) else None
meta = json.load(open('meta.json', encoding='utf-8')) if os.path.exists('meta.json') else {}
po = json.load(open('pool_out.json', encoding='utf-8')) if os.path.exists('pool_out.json') else {}
want = (meta.get('data_date') or '')[:10].replace('/', '-')
if want and J['date'] != want: print(f'警告：J1b 帳本資料日 {J["date"]} 與晨報資料日 {want} 不同')

ACC = colors.HexColor('#b03a2e'); GREY = colors.HexColor('#5d6670')
H = ParagraphStyle('h', fontName='WQY', fontSize=15, leading=20, wordWrap='CJK')
H2 = ParagraphStyle('h2', fontName='WQY', fontSize=11, leading=15, textColor=ACC, spaceBefore=4, wordWrap='CJK')
B = ParagraphStyle('b', fontName='WQY', fontSize=9, leading=13.5, wordWrap='CJK')
S = ParagraphStyle('m', fontName='WQY', fontSize=8, leading=12, textColor=GREY, wordWrap='CJK')
WHY = {'line': '跌破出場線', 'hard': '強制停損（虧損逾 10%）'}
TAG = {'I1': 'I1 評分', '反彈': '急跌反彈'}


def tb(rows, widths, size=8.4):
    t = Table(rows, colWidths=[w * mm for w in widths], repeatRows=1)
    t.setStyle(TableStyle([('FONT', (0, 0), (-1, -1), 'WQY', size), ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#f8e9e7')), ('TEXTCOLOR', (0, 0), (-1, 0), ACC),
                           ('ALIGN', (3, 0), (-1, -1), 'RIGHT'), ('LINEBELOW', (0, 0), (-1, -1), 0.4, colors.HexColor('#dde1e5')), ('TOPPADDING', (0, 0), (-1, -1), 3), ('BOTTOMPADDING', (0, 0), (-1, -1), 3)]))
    return t


f2 = lambda v: f'{v:,.2f}'
g = J['gate']
state = (f"加權收盤 {g['close']:,.0f}，{'站上' if g['above60'] else '在'}季線 {g['ma60']:,.0f}{'之上' if g['above60'] else '之下'}；5 日線 {g['ma5']:,.0f}；"
         f"對月線乖離 {g['bias20']:+.1f}%（近 10 日最低 {g['minb']:+.1f}%）。")
el = [Paragraph('J1b 選股（主要模型）', H), Spacer(1, 1.5 * mm),
      Paragraph(f"資料日 {J['date']}　今日模式：<b>{J['mode']}</b>　{state}", B), Spacer(1, 2 * mm)]

el.append(Paragraph('今日新增（今天開盤可買）', H2))
if J['new']:
    rows = [['代號', '名稱', '類型', '參考價', '可買入上限', '初始出場線', '建議占資金', 'ATR%']] + \
           [[n['code'], n['name'], TAG.get(n['tag'], n['tag']), f2(n['ref']), f2(n['cap']), f2(n['stop_now']), f"{n['w'] * 100:.0f}%", f"{n['atr_pct']:.1f}%"] for n in J['new']]
    el.append(tb(rows, [15, 24, 18, 22, 24, 22, 22, 15]))
    el.append(Paragraph('開盤在可買入上限以內就買；開盤高於上限、盤中回到上限以內就以上限價買；整天都在上限之上就不追。建議占資金＝這檔占你操作資金的比例（波動大的買少）。', S))
else:
    why = '大盤在季線下、反彈閘門未開，依規則空手等待' if not g['above60'] and not g['open'] else '池已滿或沒有符合條件的股票'
    el.append(Paragraph(f'今日無新增（{why}）。', B))
if J['filled']: el.append(Paragraph('昨日新增已成交：' + '、'.join(f"{p['code']} {p['name']} {f2(p['entry'])}（{p['how']}）" for p in J['filled']), B))
if J['unfilled']: el.append(Paragraph('昨日新增未成交：' + '、'.join(f"{u['code']} {u['name']}（上限 {f2(u['cap'])}" + (f"、開盤 {f2(u['open'])}" if u.get('open') else '') + f"，{u['why']}）" for u in J['unfilled']), B))

el.append(Paragraph('今日出場（今天開盤賣出）', H2))
if J['exits']:
    rows = [['代號', '名稱', '類型', '進場日', '進場價', '昨收', '報酬', '原因']] + \
           [[p['code'], p['name'], TAG.get(p['tag'], p['tag']), p['entry_date'][5:], f2(p['entry']), f2(p['last']), f"{p['ret']:+.2f}%", WHY.get(p['exit_sig']['why'], p['exit_sig']['why'])] for p in J['exits']]
    el.append(tb(rows, [15, 24, 18, 16, 22, 22, 18, 40]))
else: el.append(Paragraph('無。', B))

el.append(Paragraph(f"持股（{len(J['holding'])}／{J['params']['pool_max']}）", H2))
if J['holding']:
    rows = [['代號', '名稱', '類型', '進場日', '進場價', '現價', '報酬', '天數', '出場線', '鎖利／停損', '占資金']] + \
           [[p['code'], p['name'], TAG.get(p['tag'], p['tag']), p['entry_date'][5:], f2(p['entry']), f2(p['last']), f"{p['ret']:+.2f}%", str(p['days']), f2(p['stop_now']),
             (f"鎖利 +{p['lock']:.1f}%" if p['lock'] >= 0 else f"停損 {p['lock']:.1f}%"), f"{p.get('w_real', p['w']) * 100:.0f}%"] for p in J['holding']]
    el.append(tb(rows, [13, 20, 15, 13, 18, 18, 16, 10, 18, 22, 14], 8))
else: el.append(Paragraph('目前沒有 J1b 持股。', B))

old = po.get('hold') or po.get('holding') or []
if old:
    el.append(Paragraph('舊 W4 持股（11/23 起停止新增，照原本的出場線出場）', H2))
    el.append(Paragraph('、'.join(f"{p['code']} {p['name']} 進場 {f2(p['entry'])} → {f2(p.get('last', p['entry']))}（{p.get('ret', 0):+.2f}%），出場線 {f2(p['stop_now'])}" for p in old) + '。明細見觀察池頁。', B))

s = J['stats']; el.append(Paragraph('績效', H2))
line = f"正式帳本（自 {s['start']} 起，依建議占資金、扣成本）：{s['cum']:+.2f}%，同期 0050 {s['bench']:+.2f}%；已出場 {s['closed']} 筆" + (f"，平均 {s['avg']:+.2f}%、勝率 {s['hit']}%" if s['closed'] else '') + '。'
el.append(Paragraph(line, B))
if M:
    ms = M['stats']
    el.append(Paragraph(f"紙上模型（自 {ms['start']} 起追蹤）：{ms['cum']:+.2f}%，同期 0050 {ms['bench']:+.2f}%。2018 年起回測：年化 {ms['bt_cagr']}%、最大回撤 {ms['bt_mdd']}%（目前這一段就是回測中最深的回撤）。", B))
el += [Spacer(1, 2 * mm), Paragraph('規則：' + J['rules'], S), Spacer(1, 1 * mm),
       Paragraph('回測期間勝率約 46%，獲利靠少數大波段（平均賺 +35%、平均賠 −9%），多數交易會小賠出場；請用固定比例資金、照出場線執行。回測用現在的成分股，有倖存者偏差。技術面整理，不構成投資建議。', S)]

SimpleDocTemplate('j1b_page.pdf', pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=14 * mm).build(el)

# 插到第 1 頁之後
try:
    from pypdf import PdfReader, PdfWriter
    r, p = PdfReader(pdf), PdfReader('j1b_page.pdf'); w = PdfWriter()
    w.add_page(r.pages[0])
    for pg in p.pages: w.add_page(pg)
    for pg in r.pages[1:]: w.add_page(pg)
    with open('_j1b_merged.pdf', 'wb') as fh: w.write(fh)
except ImportError:
    if shutil.which('qpdf'): subprocess.run(['qpdf', '--empty', '--pages', pdf, '1', 'j1b_page.pdf', pdf, '2-z', '--', '_j1b_merged.pdf'], check=True)
    else:
        subprocess.run(['pdfseparate', '-f', '1', '-l', '1', pdf, '_p1.pdf'], check=True); subprocess.run(['pdfseparate', '-f', '2', pdf, '_rest%d.pdf'], check=True)
        rest = sorted([f for f in os.listdir('.') if f.startswith('_rest')], key=lambda x: int(x[5:-4]))
        subprocess.run(['pdfunite', '_p1.pdf', 'j1b_page.pdf', *rest, '_j1b_merged.pdf'], check=True)
        for f in ['_p1.pdf'] + rest: os.remove(f)
os.replace('_j1b_merged.pdf', pdf); print('已插入第 2 頁：', pdf)
