/* 晨報 app 秒級報價中繼（Cloudflare Worker）
 * GET /q?codes=2330,6669,TSE01,OTC01   → 證交所即時報價（含五檔），同一組代號 3 秒內共用快取
 * GET /                                → 狀態
 * 代號：上市 tse、上櫃 otc 由 ?otc=6669,3293 指定（沒指定的都當上市）；TSE01＝加權、OTC01＝櫃買指數
 */
const MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const TTL = 3; // 秒
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': '*' };

function exch(code, otc) {
  if (code === 'TSE01') return 'tse_t00.tw';
  if (code === 'OTC01') return 'otc_o00.tw';
  return (otc.has(code) ? 'otc_' : 'tse_') + code + '.tw';
}
const num = v => { if (v == null || v === '-' || v === '') return null; const n = +v; return isNaN(n) ? null : n; };
const list = v => (v || '').split('_').filter(Boolean).map(Number);

function parse(x) {
  const code = x.c, name = x.n || '';
  const prev = num(x.y), o = num(x.o), h = num(x.h), l = num(x.l);
  let last = num(x.z);
  const bid = list(x.b), ask = list(x.a), bidv = list(x.g), askv = list(x.f);
  let est = false;
  if (last == null) { // 證交所盤中有時不給 z：用買一／賣一估
    if (bid.length && ask.length) { last = (bid[0] + ask[0]) / 2; est = true; }
    else if (bid.length) { last = bid[0]; est = true; }
    else if (ask.length) { last = ask[0]; est = true; }
  }
  const vol = num(x.v), tv = num(x.tv);
  const chg = last != null && prev ? +(last - prev).toFixed(2) : null;
  const pct = last != null && prev ? +((last / prev - 1) * 100).toFixed(2) : null;
  return { code: code === 't00' ? 'TSE01' : code === 'o00' ? 'OTC01' : code, name, last, est, chg, pct, open: o, high: h, low: l, prev, vol, tv, bid, ask, bidv, askv, date: x.d, time: x.t, ts: num(x.tlong) };
}

async function fetchMIS(chs) {
  const url = `${MIS}?ex_ch=${chs.join('|')}&json=1&delay=0&_=${Date.now()}`;
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', 'accept': 'application/json', 'referer': 'https://mis.twse.com.tw/stock/index.jsp' }, cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('MIS ' + r.status);
  const j = await r.json();
  return (j.msgArray || []).map(parse);
}

export default {
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (u.pathname !== '/q') return new Response(JSON.stringify({ ok: true, usage: '/q?codes=2330,6669,TSE01,OTC01&otc=6669' }), { headers: { 'content-type': 'application/json', ...CORS } });
    const codes = [...new Set((u.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 150);
    const otc = new Set((u.searchParams.get('otc') || '').split(',').map(s => s.trim()).filter(Boolean));
    if (!codes.length) return new Response('{"error":"no codes"}', { status: 400, headers: { 'content-type': 'application/json', ...CORS } });
    // 快取鍵：排序後的代號，3 秒內同一組只打一次證交所
    const key = new Request('https://cache.local/q?' + codes.slice().sort().join(',') + '&otc=' + [...otc].sort().join(','));
    const cache = caches.default;
    let hit = await cache.match(key);
    if (hit) { const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v)); h.set('x-cache', 'hit'); return new Response(hit.body, { headers: h }); }
    const chs = codes.map(c => exch(c, otc));
    let items = [];
    try {
      for (let i = 0; i < chs.length; i += 60) items = items.concat(await fetchMIS(chs.slice(i, i + 60)));
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: { 'content-type': 'application/json', ...CORS } });
    }
    const body = JSON.stringify({ ts: Date.now(), ttl: TTL, items });
    const res = new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${TTL}`, 'x-cache': 'miss', ...CORS } });
    await cache.put(key, res.clone());
    return res;
  }
};
