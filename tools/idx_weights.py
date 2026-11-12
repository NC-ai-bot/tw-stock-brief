"""加權指數／櫃買指數成分股權重（給 app 的「指數貢獻排行」）。GitHub Actions 每個交易日開盤前與收盤後各跑一次。
權重＝發行股數 × 最近收盤價 ÷ 全部加總（上市：證交所 openapi 公司基本資料＋STOCK_DAY_ALL；上櫃：櫃買 openapi 收盤行情的發行股數）。
輸出 docs/data/weights.json：{date, tse:{n, cover, items:[[代號, 名稱, 權重%], ...前 150]}, otc:{... 前 100}}
貢獻點數（app 端算）≈ 指數昨收 × 權重 × 個股漲跌幅。"""
import json, os, re, sys, urllib.request
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36'

def get(url):
    req = urllib.request.Request(url, headers={'user-agent': UA, 'accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r: return json.load(r)

def num(v):
    try: return float(str(v).replace(',', '').replace('+', '').strip())
    except Exception: return None

def roc(d):  # 1151111 → 2026-11-11
    d = str(d); return f"{int(d[:-4]) + 1911}-{d[-4:-2]}-{d[-2:]}"

def tse():
    info = get('https://openapi.twse.com.tw/v1/opendata/t187ap03_L'); day = get('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL')
    key = next(k for k in info[0] if '已發行普通股數' in k)
    shares = {r['公司代號'].strip(): (num(r[key]), r['公司簡稱'].strip()) for r in info}
    rows = []
    for r in day:
        c = r['Code'].strip(); px = num(r['ClosingPrice'])
        if not re.fullmatch(r'\d{4}', c) or c not in shares or not px or not shares[c][0]: continue
        rows.append((c, shares[c][1], shares[c][0] * px))
    return roc(day[0]['Date']), rows

def otc():
    day = get('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'); rows = []
    for r in day:
        c = r['SecuritiesCompanyCode'].strip(); px = num(r['Close']); sh = num(r.get('Capitals'))
        if not re.fullmatch(r'\d{4}', c) or not px or not sh: continue
        rows.append((c, r['CompanyName'].strip(), sh * px))
    return roc(day[0]['Date']), rows

def pack(rows, top):
    tot = sum(x[2] for x in rows); rows = sorted(rows, key=lambda x: -x[2])
    items = [[c, n, round(v / tot * 100, 4)] for c, n, v in rows[:top]]
    return dict(n=len(rows), cover=round(sum(i[2] for i in items), 2), items=items)

def main(docs):
    out = {}
    d1, r1 = tse(); out['tse'] = pack(r1, 150); out['tse']['date'] = d1
    try:
        d2, r2 = otc(); out['otc'] = pack(r2, 100); out['otc']['date'] = d2
    except Exception as e:
        print('otc failed', e)
    out['date'] = d1
    p = os.path.join(docs, 'data', 'weights.json'); json.dump(out, open(p, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    for k in ('tse', 'otc'):
        if k in out: print(k, out[k]['date'], 'n', out[k]['n'], 'cover', out[k]['cover'], out[k]['items'][:6], '…', out[k]['items'][-1])

if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'docs')
