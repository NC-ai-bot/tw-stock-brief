/* 晨報 app 秒級報價中繼（Cloudflare Worker）
 * GET /q?codes=2330,6669,TSE01,OTC01&otc=3293   → 證交所即時報價（含五檔），同一組代號 3 秒內共用快取
 * GET /tl?date=YYYYMMDD                         → 當天（預設今天）每分鐘累積的分時資料 {code:[[time,last,vol],...]}
 * GET /                                         → 狀態
 * Cron（每分鐘，台北 09:00–13:59 週一到五）：抓晨報名單（app 的 data/quotes.json）＋加權／櫃買，寫進 KV（綁定名稱 TL）
 * 代號：上市 tse、上櫃 otc 由 ?otc= 指定（沒指定的都當上市）；TSE01＝加權、OTC01＝櫃買指數
 */
const MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const APP = 'https://nc-ai-bot.github.io/tw-stock-brief/data/';
const TTL = 3; // 秒
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,OPTIONS', 'access-control-allow-headers': '*' };
const JSONH = { 'content-type': 'application/json; charset=utf-8', ...CORS };

function exch(code, otc) {
  if (code === 'TSE01') return 'tse_t00.tw';
  if (code === 'OTC01') return 'otc_o00.tw';
  return (otc.has(code) ? 'otc_' : 'tse_') + code + '.tw';
}
const num = v => { if (v == null || v === '-' || v === '') return null; const n = +v; return isNaN(n) ? null : n; };
const list = v => (v || '').split('_').filter(Boolean).map(Number);
const tpeDate = () => { const d = new Date(Date.now() + 8 * 3600e3); return d.toISOString().slice(0, 10).replace(/-/g, ''); };

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

async function quotes(codes, otc) {
  const chs = codes.map(c => exch(c, otc));
  let items = [];
  for (let i = 0; i < chs.length; i += 60) items = items.concat(await fetchMIS(chs.slice(i, i + 60)));
  return items;
}

// 名單：app 的 quotes.json（今日新增、持股、出場、I1、趨勢延續）＋ 兩個指數；上市／上櫃用 universe.json
async function watchlist() {
  const [q, u] = await Promise.all([
    fetch(APP + 'quotes.json', { cf: { cacheTtl: 60 } }).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] })),
    fetch(APP + 'universe.json', { cf: { cacheTtl: 3600 } }).then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  const codes = ['TSE01', 'OTC01'];
  (q.items || []).forEach(x => { if (x.code && !codes.includes(x.code)) codes.push(x.code); });
  const otc = new Set(codes.filter(c => u[c] && u[c].ex === 'otc'));
  return { codes, otc };
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (u.pathname === '/tl') {
      if (!env.TL) return new Response('{"error":"KV binding TL not set"}', { status: 500, headers: JSONH });
      const d = (u.searchParams.get('date') || tpeDate()).replace(/-/g, '');
      const raw = await env.TL.get('tl-' + d);
      return new Response(raw || '{}', { headers: { ...JSONH, 'cache-control': 'public, max-age=20' } });
    }
    if (u.pathname !== '/q') {
      const st = { ok: true, kv: !!env.TL, usage: ['/q?codes=2330,6669,TSE01,OTC01&otc=3293', '/tl?date=' + tpeDate()] };
      if (env.TL) { const m = await env.TL.get('tl-meta'); if (m) st.last_cron = JSON.parse(m); }
      return new Response(JSON.stringify(st), { headers: JSONH });
    }
    const codes = [...new Set((u.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 150);
    const otc = new Set((u.searchParams.get('otc') || '').split(',').map(s => s.trim()).filter(Boolean));
    if (!codes.length) return new Response('{"error":"no codes"}', { status: 400, headers: JSONH });
    // 快取鍵：排序後的代號，3 秒內同一組只打一次證交所
    const key = new Request('https://cache.local/q?' + codes.slice().sort().join(',') + '&otc=' + [...otc].sort().join(','));
    const cache = caches.default;
    const hit = await cache.match(key);
    if (hit) { const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v)); h.set('x-cache', 'hit'); return new Response(hit.body, { headers: h }); }
    let items;
    try { items = await quotes(codes, otc); }
    catch (e) { return new Response(JSON.stringify({ error: String(e) }), { status: 502, headers: JSONH }); }
    const body = JSON.stringify({ ts: Date.now(), ttl: TTL, items });
    const res = new Response(body, { headers: { ...JSONH, 'cache-control': `public, max-age=${TTL}`, 'x-cache': 'miss' } });
    await cache.put(key, res.clone());
    return res;
  },

  // 每分鐘：把名單的最新成交累積到 KV（一天一把鑰匙 tl-YYYYMMDD；一次寫入，免費額度 1000 次／天夠用）
  async scheduled(event, env, ctx) {
    if (!env.TL) return;
    const { codes, otc } = await watchlist();
    const items = await quotes(codes, otc);
    const d = tpeDate();
    const key = 'tl-' + d;
    const cur = JSON.parse((await env.TL.get(key)) || '{}');
    let changed = 0;
    items.forEach(it => {
      if (!it.code || it.last == null || it.est || !it.time || !it.date || it.date !== d) return; // 只收今天、有成交的
      const arr = cur[it.code] = cur[it.code] || [];
      const lastT = arr.length ? arr[arr.length - 1][0] : null;
      if (lastT !== it.time) { arr.push([it.time, it.last, it.vol]); changed++; }
    });
    if (changed) await env.TL.put(key, JSON.stringify(cur), { expirationTtl: 86400 * 10 });
    if (changed || new Date().getUTCMinutes() % 10 === 0) await env.TL.put('tl-meta', JSON.stringify({ at: new Date().toISOString(), date: d, codes: codes.length, changed }), { expirationTtl: 86400 * 10 }); // KV 免費額度每天 1000 次寫入，盤中約 300＋300 次
  },
};
