"""台指期日盤收盤摘要（給 app 當夜盤參考價與日盤分時備援）。
GitHub Actions 每個交易日 13:55／14:25 執行（期交所允許 GitHub 的來源，但擋 Cloudflare）。
輸出 docs/data/fut/YYYYMMDD.json：{date, settle, last, ref, open, high, low, vol, oi, ticks:[[HH:MM:00, 價, 累計量], ...]}
與 docs/data/fut/last.json（同內容）。"""
import json, os, sys, datetime, urllib.request

TAIFEX = 'https://mis.taifex.com.tw/futures/api/getQuoteList'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
TPE = datetime.timezone(datetime.timedelta(hours=8))

def post_json(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def get_json(url):
    req = urllib.request.Request(url, headers={'user-agent': UA, 'accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def num(v):
    try:
        f = float(str(v).replace(',', ''))
        return f
    except Exception:
        return None

def main(docs):
    today = datetime.datetime.now(TPE).strftime('%Y%m%d')
    j = post_json(TAIFEX, {"MarketType": "0", "SymbolType": "F", "KindID": "1", "CID": "TXF", "ExpireMonth": "", "RowSize": "全部", "PageNo": "", "SortColumn": "", "AscDesc": "A"},
                  {'content-type': 'application/json', 'accept': 'application/json', 'user-agent': UA, 'referer': 'https://mis.taifex.com.tw/futures/'})
    L = (j.get('RtData') or {}).get('QuoteList') or []
    import re
    near = next((x for x in L if re.match(r'^TXF[A-Z]\d-[FM]$', x.get('SymbolID', ''))), None)
    if not near:
        print('no near-month quote'); return 2
    if near.get('CDate') != today:
        print('quote date', near.get('CDate'), '!= today', today, '→ 休市，略過'); return 3
    out = {'date': today, 'sym': near['SymbolID'], 'name': near.get('DispCName'), 'settle': num(near.get('SettlementPrice')), 'last': num(near.get('CLastPrice')), 'ref': num(near.get('CRefPrice')),
           'open': num(near.get('COpenPrice')), 'high': num(near.get('CHighPrice')), 'low': num(near.get('CLowPrice')), 'vol': num(near.get('CTotalVolume')), 'oi': num(near.get('OpenInterest')),
           'time': near.get('CTime'), 'ticks': []}
    # 日盤分時：鉅亨 1 分 K（15:00 前抓到的是日盤這一節）
    try:
        now = int(datetime.datetime.now().timestamp())
        d = get_json(f'https://ws.api.cnyes.com/ws/api/v1/charting/history?symbol=TWF:TXF:FUT&resolution=1&from={now}&to={now - 36000}').get('data') or {}
        rows = sorted([(t, d['c'][i], d['v'][i] or 0) for i, t in enumerate(d.get('t') or []) if d['c'][i] is not None])
        cum = 0; ticks = []
        for t, c, v in rows:
            te = datetime.datetime.fromtimestamp(t + 60, TPE)
            if te.strftime('%Y%m%d') != today: continue
            m = te.hour * 60 + te.minute
            if not (8 * 60 + 45 <= m <= 13 * 60 + 45): continue
            cum += v; ticks.append([te.strftime('%H:%M:00'), c, cum])
        out['ticks'] = ticks
    except Exception as e:
        print('cnyes ticks failed:', e)
    os.makedirs(os.path.join(docs, 'data', 'fut'), exist_ok=True)
    for name in (today + '.json', 'last.json'):
        with open(os.path.join(docs, 'data', 'fut', name), 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    # 只留最近 15 個檔
    files = sorted(x for x in os.listdir(os.path.join(docs, 'data', 'fut')) if x[:8].isdigit())
    for x in files[:-15]:
        os.remove(os.path.join(docs, 'data', 'fut', x))
    print('ok', today, 'settle', out['settle'], 'last', out['last'], 'ticks', len(out['ticks']))
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'docs'))
