/* 晨報 app 即時報價中繼＋分時累積＋推播（Cloudflare Worker，單檔；KV 綁定名稱 TL）
 *
 * 端點（只接受來自晨報 app https://nc-ai-bot.github.io 的請求）：
 *   GET  /q?codes=2330,6669,TSE01,OTC01&otc=3293  證交所即時報價（含五檔），同一組代號 3 秒內共用快取
 *   GET  /tl?date=YYYYMMDD&codes=2330,TSE01       當天每分鐘累積的分時 {code:[[time,last,vol],...]}（不帶 codes＝全部）
 *   GET  /fut                                      台指期近月（期交所：日盤 day／夜盤 night，含現貨），5 秒快取
 *   GET  /vapid                                    推播公鑰
 *   POST /sub   {sub, prefs}                       訂閱推播（prefs: {stop,buy,close,morning} 布林）
 *   POST /unsub {endpoint}                         取消
 *   POST /test  {endpoint}                         送一則測試通知
 *   GET  /                                         狀態（不限來源）
 * Cron：
 *   "* 1-5 * * 1-5"  台北 09:00–13:59 每分鐘：抓全股票池＋指數 → 分時進 KV；依名單判斷警示（跌破／接近出場線、可買、開盤超過上限）→ 推播；13:31 後送一次收盤摘要
 *   "35 23 * * SUN-THU"、"50 23 * * SUN-THU"、"15 0 * * MON-FRI"  台北 07:35／07:50／08:15：晨報出刊就推播一次
 *   休市日（週末、證交所公告休市日含補假）：早上不推晨報出刊、盤中不判斷提醒
 *   "每 2 分鐘 7-21 * * MON-FRI"（寫法：星號/2 7-21 * * MON-FRI）台北 15:00–05:59：台指期夜盤分時 → KV（代號 FUTN，掛在夜盤開始那天的鑰匙下）
 */
const MIS = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp';
const APP_ORIGIN = 'https://nc-ai-bot.github.io';
const APP = APP_ORIGIN + '/tw-stock-brief/data/';
const APP_URL = APP_ORIGIN + '/tw-stock-brief/';
const TTL = 3; // 秒
const VAPID_SUBJECT = 'mailto:noreply@example.com';
const CORS = { 'access-control-allow-origin': APP_ORIGIN, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type', 'vary': 'origin' };
const JSONH = { 'content-type': 'application/json; charset=utf-8', ...CORS };
const json = (o, status, extra) => new Response(JSON.stringify(o), { status: status || 200, headers: { ...JSONH, ...(extra || {}) } });

// ---------- 工具 ----------
const te = new TextEncoder();
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const concat = (...parts) => { const n = parts.reduce((a, p) => a + p.byteLength, 0); const out = new Uint8Array(n); let o = 0; parts.forEach(p => { out.set(new Uint8Array(p), o); o += p.byteLength; }); return out; };
const num = v => { if (v == null || v === '-' || v === '') return null; const n = +v; return isNaN(n) ? null : n; };
const list = v => (v || '').split('_').filter(Boolean).map(Number);
const tpe = () => new Date(Date.now() + 8 * 3600e3);
const tpeDate = () => tpe().toISOString().slice(0, 10).replace(/-/g, '');
const tpeHM = () => { const d = tpe(); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const nightKeyDate = () => { const d = tpe(); if (d.getUTCHours() < 12) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10).replace(/-/g, ''); }; // 夜盤掛在 15:00 開始那天
const fmt = (v, d) => v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d == null ? (v >= 1000 ? 0 : 2) : d, maximumFractionDigits: d == null ? (v >= 1000 ? 0 : 2) : d });
const pct = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const sha = async s => b64u(await crypto.subtle.digest('SHA-256', te.encode(s))).slice(0, 32);

function allowed(req) {
  const o = req.headers.get('origin'), r = req.headers.get('referer') || '';
  return o === APP_ORIGIN || r.startsWith(APP_ORIGIN + '/');
}

// ---------- 證交所報價 ----------
function exch(code, otc) {
  if (code === 'TSE01') return 'tse_t00.tw';
  if (code === 'OTC01') return 'otc_o00.tw';
  return (otc.has(code) ? 'otc_' : 'tse_') + code + '.tw';
}
function parse(x) {
  const code = x.c, name = x.n || '';
  const prev = num(x.y), o = num(x.o), h = num(x.h), l = num(x.l);
  let last = num(x.z);
  const bid = list(x.b), ask = list(x.a), bidv = list(x.g), askv = list(x.f);
  let est = false;
  if (last == null) { if (bid.length && ask.length) { last = (bid[0] + ask[0]) / 2; est = true; } else if (bid.length) { last = bid[0]; est = true; } else if (ask.length) { last = ask[0]; est = true; } }
  const vol = num(x.v), tv = num(x.tv);
  const chg = last != null && prev ? +(last - prev).toFixed(2) : null;
  const pc = last != null && prev ? +((last / prev - 1) * 100).toFixed(2) : null;
  return { code: code === 't00' ? 'TSE01' : code === 'o00' ? 'OTC01' : code, name, last, est, chg, pct: pc, open: o, high: h, low: l, prev, vol, tv, bid, ask, bidv, askv, date: x.d, time: x.t, ts: num(x.tlong) };
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
const appJSON = (name, ttl, dflt) => fetch(APP + name + '?t=' + Math.floor(Date.now() / 60000), { cf: { cacheTtl: ttl } }).then(r => r.ok ? r.json() : dflt).catch(() => dflt);
async function universeCodes() {
  const u = await appJSON('universe.json', 3600, {});
  const codes = ['TSE01', 'OTC01', ...Object.keys(u)];
  return { codes, otc: new Set(codes.filter(c => u[c] && u[c].ex === 'otc')), uni: u };
}

// ---------- 台指期（期交所行情資訊網） ----------
const TAIFEX = 'https://mis.taifex.com.tw/futures/api/getQuoteList';
async function taifex(marketType) {
  const r = await fetch(TAIFEX, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': 'Mozilla/5.0', 'referer': 'https://mis.taifex.com.tw/futures/' }, body: JSON.stringify({ MarketType: marketType, SymbolType: 'F', KindID: '1', CID: 'TXF', ExpireMonth: '', RowSize: '全部', PageNo: '', SortColumn: '', AscDesc: 'A' }), cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('TAIFEX ' + r.status);
  const j = await r.json(); const L = (j.RtData && j.RtData.QuoteList) || [];
  const n = v => { const x = parseFloat(String(v).replace(/,/g, '')); return isNaN(x) ? null : x; };
  const conv = x => ({ sym: x.SymbolID, name: x.DispCName, last: n(x.CLastPrice), ref: n(x.CRefPrice), chg: n(x.CDiff), pct: n(x.CDiffRate), open: n(x.COpenPrice), high: n(x.CHighPrice), low: n(x.CLowPrice), vol: n(x.CTotalVolume), oi: n(x.OpenInterest), bid: n(x.CBidPrice1), ask: n(x.CAskPrice1), bidv: n(x.CBidSize1), askv: n(x.CAskSize1), date: x.CDate, time: x.CTime ? `${x.CTime.slice(0, 2)}:${x.CTime.slice(2, 4)}:${x.CTime.slice(4, 6)}` : null, status: x.Status });
  const spot = L.find(x => /^TXF-[SP]$/.test(x.SymbolID)), near = L.find(x => /^TXF[A-Z]\d-[FM]$/.test(x.SymbolID));
  return { spot: spot ? conv(spot) : null, near: near ? conv(near) : null };
}

// ---------- Web Push（RFC 8291 aes128gcm ＋ RFC 8292 VAPID；加解密已用 http_ece 驗證） ----------
async function ensureVapid(kv) {
  let v = JSON.parse((await kv.get('vapid')) || 'null');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), jwkPublic: await crypto.subtle.exportKey('jwk', kp.publicKey), jwkPrivate: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await kv.put('vapid', JSON.stringify(v));
  }
  return v;
}
async function vapidHeader(endpoint, vapid) {
  const header = b64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', vapid.jwkPrivate, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
async function encrypt(subscription, payload) {
  const uaPub = unb64u(subscription.keys.p256dh), auth = unb64u(subscription.keys.auth);
  const data = te.encode(payload);
  const asKey = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKey.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKey.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function sendPush(subscription, payloadObj, vapid, opts) {
  const o = opts || {};
  const body = await encrypt(subscription, JSON.stringify(payloadObj));
  const r = await fetch(subscription.endpoint, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'aes128gcm', 'ttl': String(o.ttl != null ? o.ttl : 3600), 'urgency': o.urgency || 'normal', 'authorization': await vapidHeader(subscription.endpoint, vapid) }, body });
  return { ok: r.ok, status: r.status, gone: r.status === 404 || r.status === 410 };
}
async function allSubs(kv) {
  const out = []; let cursor;
  do { const l = await kv.list({ prefix: 'sub:', cursor }); for (const k of l.keys) { const v = await kv.get(k.name); if (v) out.push({ key: k.name, ...JSON.parse(v) }); } cursor = l.list_complete ? null : l.cursor; } while (cursor);
  return out;
}
/** 廣播：pref 為 prefs 的鍵（stop／buy／close／morning），只送給有打開該項的人；失效的訂閱順便刪除 */
async function broadcast(kv, pref, payload, opts) {
  const subs = await allSubs(kv); if (!subs.length) return 0;
  const vapid = await ensureVapid(kv); let sent = 0;
  await Promise.all(subs.map(async s => {
    if (s.prefs && s.prefs[pref] === false) return;
    try { const r = await sendPush(s.sub, payload, vapid, opts); if (r.gone) await kv.delete(s.key); else if (r.ok) sent++; } catch (e) {}
  }));
  return sent;
}

// ---------- 盤中警示 ----------
function alertsFor(items, watch, state) {
  const byCode = {}; items.forEach(i => byCode[i.code] = i);
  const out = []; const hm = tpeHM();
  const mark = (id, title, body) => { if (state[id]) return; state[id] = 1; out.push({ id, title, body }); };
  (watch.items || []).forEach(w => {
    const q = byCode[w.code]; if (!q || q.last == null || q.est) return;
    const nm = `${w.name || q.name} ${w.code}`;
    ['new', 'i1new'].forEach(k => {
      if (!w.kinds.includes(k)) return;
      const cap = w[k + '_cap']; if (cap == null) return;
      const tag = k === 'i1new' ? '（I1 測試）' : '';
      if (hm >= 9 * 60 + 1 && q.open != null && q.open > cap) mark(`over:${k}:${w.code}`, `開盤超過上限${tag}`, `${nm} 開盤 ${fmt(q.open)} 高於可買入上限 ${fmt(cap)}，依規則今天不追。`);
      if (hm >= 9 * 60 + 1 && q.last <= cap) mark(`buy:${k}:${w.code}`, `可買${tag}`, `${nm} 現價 ${fmt(q.last)}，已在可買入上限 ${fmt(cap)} 以下。`);
    });
    ['pool', 'i1'].forEach(k => {
      if (!w.kinds.includes(k)) return;
      const stop = w[k + '_stop']; if (stop == null) return;
      const tag = k === 'i1' ? '（I1 測試）' : '';
      const entry = w[k + '_entry'];
      const st = entry ? (stop >= entry ? `鎖利 ${pct((stop / entry - 1) * 100)}` : `停損 ${pct((stop / entry - 1) * 100)}`) : '';
      const d = (q.last / stop - 1) * 100;
      if (q.last < stop) mark(`break:${k}:${w.code}`, `跌破出場線${tag}`, `${nm} 現價 ${fmt(q.last)} 跌破出場線 ${fmt(stop)}${st ? `（${st}）` : ''}，今日 ${pct(q.pct)}。晨報以收盤判定出場。`);
      else if (d < 2) mark(`near:${k}:${w.code}`, `接近出場線${tag}`, `${nm} 現價 ${fmt(q.last)}，距出場線 ${fmt(stop)} 只剩 ${d.toFixed(1)}%${st ? `（${st}）` : ''}。`);
    });
  });
  return out;
}
/** 警示名單：直接從 app 的 pool_out／pool／i1／ext 組出來（與 tools/quotes.py 的 watchlist() 相同規則）。
 *  以前讀 quotes.json，但那個檔靠 GitHub Actions 每 5 分鐘更新，排程常延遲到 09:45 以後才第一次跑，
 *  開盤後那段時間推的就是前一天的名單（10/29 早上推成 10/28 的信昌電）。
 *  回傳 null 代表 app 的資料不是今天這一期（meta.file_date ≠ 今天），這時不推任何警示。 */
async function buildWatch(d) {
  const meta = await appJSON('meta.json', 0, null);
  if (!meta || meta.file_date !== d) return null;
  const [po, pool, i1, ext] = await Promise.all([appJSON('pool_out.json', 0, {}), appJSON('pool.json', 0, {}), appJSON('i1.json', 0, {}), appJSON('ext.json', 0, {})]);
  const items = {};
  const add = (x, kind, kw) => {
    if (!x || !x.code) return;
    const it = items[x.code] = items[x.code] || { code: x.code, name: x.name, kinds: [] };
    if (!it.kinds.includes(kind)) it.kinds.push(kind);
    Object.entries(kw || {}).forEach(([k, v]) => { if (v != null) it[kind + '_' + k] = v; });
  };
  (po.new || []).forEach(x => add(x, 'new', { cap: x.cap, stop: x.stop_now, ref: x.ref ?? x.entry, group: x.group }));
  (pool.positions || []).forEach(x => x.status === 'pending' ? add(x, 'new', { cap: x.cap, stop: x.stop_now, ref: x.ref ?? x.entry, group: x.group }) : add(x, 'pool', { stop: x.stop_now, entry: x.entry, group: x.group, days: x.days }));
  (i1.new || []).forEach(x => add(x, 'i1new', { cap: x.cap, stop: x.stop_now, ref: x.ref }));
  (i1.holding || []).forEach(x => x.status === 'pending' ? add(x, 'i1new', { cap: x.cap, stop: x.stop_now, ref: x.ref }) : add(x, 'i1', { stop: x.stop_now, entry: x.entry, days: x.days }));
  (po.exits || []).forEach(x => add(x, 'exit', { exit: x.exit, ret: x.ret }));
  (ext.list || []).forEach(x => add(x, 'ext', { close: x.close }));
  (ext.opens || []).forEach(x => add(x, 'extopen', { entry: x.entry }));
  return { file_date: meta.file_date, items: Object.values(items) };
}
function closeSummary(items, watch) {
  const byCode = {}; items.forEach(i => byCode[i.code] = i);
  const idx = byCode.TSE01, otc = byCode.OTC01;
  const parts = [];
  if (idx) parts.push(`加權 ${fmt(idx.last, 0)}（${pct(idx.pct)}）`);
  if (otc) parts.push(`櫃買 ${pct(otc.pct)}`);
  const hold = (watch.items || []).filter(w => w.kinds.includes('pool'));
  const broken = hold.filter(w => { const q = byCode[w.code]; return q && q.last != null && w.pool_stop != null && q.last < w.pool_stop; });
  if (hold.length) parts.push(`持股 ${hold.length} 檔${broken.length ? `，${broken.map(w => w.name).join('、')} 收在出場線下方（晚上晨報結算）` : '，皆在出場線上方'}`);
  const nw = (watch.items || []).filter(w => w.kinds.includes('new'));
  if (nw.length) parts.push(`今日新增 ${nw.map(w => { const q = byCode[w.code]; return `${w.name} ${q ? fmt(q.last) : ''}${q && w.new_cap != null ? (q.open > w.new_cap ? '（開盤超過上限未成交）' : '') : ''}`; }).join('、')}`);
  return parts.join('；') + '。';
}


// 休市判斷：週六日，或證交所公告的休市日（含補假）；結果快取在 KV 一天。API 失敗時當作交易日（寧可多跑）
async function isHoliday(env, d) {
  const dt = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`); const dow = dt.getUTCDay();
  if (dow === 0 || dow === 6) return true;
  const k = 'hol-' + d.slice(0, 4);
  let list = null; try { list = JSON.parse((await env.TL.get(k)) || 'null'); } catch (e) {}
  if (!list) {
    try {
      const r = await fetch(`https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?date=${d.slice(0, 4)}&response=json`, { headers: { 'user-agent': 'Mozilla/5.0' } });
      const j = await r.json(); if (j && j.stat === 'ok') { list = (j.data || []).map(x => String(x[0]).replace(/-/g, '')); await env.TL.put(k, JSON.stringify(list), { expirationTtl: 86400 }); }
    } catch (e) {}
  }
  return !!(list && list.includes(d));
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (u.pathname === '/') {
      const st = { ok: true, ver: 10, kv: !!env.TL, time: tpe().toISOString().replace('Z', '+08:00') };
      if (env.TL) { const m = await env.TL.get('tl-meta'); if (m) st.last_cron = JSON.parse(m); const mm = await env.TL.get('morn-meta'); if (mm) st.last_morning = JSON.parse(mm); const nm = await env.TL.get('night-meta'); if (nm) st.last_night = JSON.parse(nm); st.subs = (await env.TL.list({ prefix: 'sub:' })).keys.length; }
      return json(st);
    }
    if (!allowed(req)) return json({ error: '請從晨報 app 使用' }, 403);
    if (!env.TL && u.pathname !== '/q') return json({ error: 'KV binding TL not set' }, 500);

    if (u.pathname === '/q') {
      const codes = [...new Set((u.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 150);
      const otc = new Set((u.searchParams.get('otc') || '').split(',').map(s => s.trim()).filter(Boolean));
      if (!codes.length) return json({ error: 'no codes' }, 400);
      const key = new Request('https://cache.local/q?' + codes.slice().sort().join(',') + '&otc=' + [...otc].sort().join(','));
      const cache = caches.default;
      const hit = await cache.match(key);
      if (hit) { const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v)); h.set('x-cache', 'hit'); return new Response(hit.body, { headers: h }); }
      let items;
      try { items = await quotes(codes, otc); } catch (e) { return json({ error: String(e) }, 502); }
      const res = json({ ts: Date.now(), ttl: TTL, items }, 200, { 'cache-control': `public, max-age=${TTL}`, 'x-cache': 'miss' });
      await cache.put(key, res.clone());
      return res;
    }
    if (u.pathname === '/tl') {
      let d = (u.searchParams.get('date') || tpeDate()).replace(/-/g, '');
      let raw = {};
      if (d === 'last') { // 最近一個有分時資料的交易日（往回最多 10 天）
        for (let i = 0; i < 10 && !Object.keys(raw).length; i++) { const t = new Date(tpe()); t.setUTCDate(t.getUTCDate() - i); d = t.toISOString().slice(0, 10).replace(/-/g, ''); raw = JSON.parse((await env.TL.get('tl-' + d)) || '{}'); }
      } else raw = JSON.parse((await env.TL.get('tl-' + d)) || '{}');
      const want = (u.searchParams.get('codes') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!want.length || want.includes('FUTN')) {
        if (d === tpeDate() && nightKeyDate() !== d) { const nr = JSON.parse((await env.TL.get('tl-' + nightKeyDate())) || '{}'); if (nr.FUTN) raw.FUTN = nr.FUTN; } // 凌晨查今天：夜盤還掛在昨天
        if (!raw.FUTN) { for (let i = 1; i <= 10 && !raw.FUTN; i++) { const t = new Date(Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T00:00:00Z`)); t.setUTCDate(t.getUTCDate() - i); const pr = JSON.parse((await env.TL.get('tl-' + t.toISOString().slice(0, 10).replace(/-/g, ''))) || '{}'); if (pr.FUTN) { raw.FUTN = pr.FUTN; raw._nightDate = t.toISOString().slice(0, 10).replace(/-/g, ''); } } } // 當天夜盤還沒開始：給上一個夜盤
      }
      const out = want.length ? Object.fromEntries(want.filter(c => raw[c]).map(c => [c, raw[c]])) : raw;
      if (Object.keys(raw).some(k => !k.startsWith('_'))) out._date = d; if (raw._nightDate) out._nightDate = raw._nightDate; // 沒資料就不帶日期
      return json(out, 200, { 'cache-control': 'public, max-age=20' });
    }
    if (u.pathname === '/fut') {
      const key = new Request('https://cache.local/fut'); const cache = caches.default;
      const hit = await cache.match(key); if (hit) { const h = new Headers(hit.headers); Object.entries(CORS).forEach(([k, v]) => h.set(k, v)); return new Response(hit.body, { headers: h }); }
      try {
        const [day, night] = await Promise.all([taifex('0'), taifex('1')]);
        const res = json({ ts: Date.now(), day, night }, 200, { 'cache-control': 'public, max-age=5' });
        await cache.put(key, res.clone()); return res;
      } catch (e) { return json({ error: String(e) }, 502); }
    }
    if (u.pathname === '/vapid') return json({ publicKey: (await ensureVapid(env.TL)).publicKey });
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    let body; try { body = await req.json(); } catch (e) { return json({ error: 'bad json' }, 400); }
    if (u.pathname === '/sub') {
      const s = body.sub; if (!s || !s.endpoint || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: 'bad subscription' }, 400);
      const prefs = Object.assign({ stop: true, buy: true, close: true, morning: true }, body.prefs || {});
      await env.TL.put('sub:' + await sha(s.endpoint), JSON.stringify({ sub: s, prefs, ua: (req.headers.get('user-agent') || '').slice(0, 120), at: new Date().toISOString() }));
      return json({ ok: true, prefs });
    }
    if (u.pathname === '/unsub') { if (body.endpoint) await env.TL.delete('sub:' + await sha(body.endpoint)); return json({ ok: true }); }
    if (u.pathname === '/test') {
      const raw = body.endpoint ? await env.TL.get('sub:' + await sha(body.endpoint)) : null;
      if (!raw) return json({ error: '尚未訂閱' }, 404);
      const r = await sendPush(JSON.parse(raw).sub, { title: '晨報通知測試', body: '收到這則表示推播設定成功。開盤後會提醒出場線、可買與收盤摘要。', tag: 'test', url: APP_URL + '#live' }, await ensureVapid(env.TL), { ttl: 60, urgency: 'high' });
      return json(r, r.ok ? 200 : 502);
    }
    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env) {
    if (!env.TL) return;
    const cron = event.cron || '';
    const d = tpeDate();
    if (!cron.startsWith('*/2 7-21') && await isHoliday(env, d)) { await env.TL.put('tl-meta', JSON.stringify({ at: new Date().toISOString(), date: d, holiday: true }), { expirationTtl: 86400 * 10 }); return; } // 休市日：不推晨報出刊、不判斷提醒（10/26 補假曾誤發「可買」）
    // ---- 早上：晨報出刊通知（三個時間點都會檢查，送過一次就不再送） ----
    if (cron.startsWith('35 23') || cron.startsWith('50 23') || cron.startsWith('15 0')) {
      if (await env.TL.get('morn-' + d)) return;
      const meta = await appJSON('meta.json', 0, null); if (!meta || meta.file_date !== d) return;
      const po = await appJSON('pool_out.json', 0, {}) || {};
      const nw = po.new || [], ex = po.exits || [], hold = po.holding || [];
      const bodyTxt = `新增 ${nw.length} 檔${nw.length ? '：' + nw.map(x => `${x.name}（上限 ${fmt(x.cap)}）`).join('、') : ''}；出場 ${ex.length} 檔；續抱 ${hold.length} 檔。`;
      const sent = await broadcast(env.TL, 'morning', { title: `${+d.slice(4, 6)}/${+d.slice(6)} 晨報已出`, body: bodyTxt, tag: 'morning', url: APP_URL + '#today' }, { ttl: 3600, urgency: 'normal' });
      await env.TL.put('morn-' + d, '1', { expirationTtl: 86400 * 3 });
      await env.TL.put('morn-meta', JSON.stringify({ at: new Date().toISOString(), date: d, sent }), { expirationTtl: 86400 * 10 });
      return;
    }
    // ---- 夜盤：每 2 分鐘存台指期夜盤分時 ----
    if (cron.startsWith('*/2 7-21')) {
      let n; try { n = (await taifex('1')).near; } catch (e) { return; }
      if (!n || n.last == null || !n.time) return;
      const key = 'tl-' + nightKeyDate();
      const cur = JSON.parse((await env.TL.get(key)) || '{}');
      const arr = cur.FUTN = cur.FUTN || [];
      if (!arr.length || arr[arr.length - 1][0] !== n.time) { arr.push([n.time, n.last, n.vol]); await env.TL.put(key, JSON.stringify(cur), { expirationTtl: 86400 * 10 }); }
      await env.TL.put('night-meta', JSON.stringify({ at: new Date().toISOString(), key, n: arr.length }), { expirationTtl: 86400 * 10 });
      return;
    }
    // ---- 盤中：每分鐘 ----
    const { codes, otc } = await universeCodes();
    const items = await quotes(codes, otc);
    // 1) 分時進 KV（全股票池）
    const key = 'tl-' + d;
    const cur = JSON.parse((await env.TL.get(key)) || '{}');
    let changed = 0;
    const now = tpe(); const stamp = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:00`; // 這一分鐘的分時時間戳（每分鐘一筆）
    items.forEach(it => {
      if (!it.code || it.last == null || it.date !== d) return;   // 證交所常回 z='-'（est＝用買賣價估），仍要記一筆，否則熱門股的分時會缺一大半（10/28 台積電只有 27 筆）
      const arr = cur[it.code] = cur[it.code] || [];
      const t = it.est ? stamp : (it.time || stamp);
      if (!arr.length || arr[arr.length - 1][0] < t) { arr.push([t, it.last, it.vol]); changed++; }
    });
    try { const fd = (await taifex('0')).near; if (fd && fd.last != null && fd.time && fd.date === d) { const arr = cur.FUT = cur.FUT || []; if (!arr.length || arr[arr.length - 1][0] !== fd.time) { arr.push([fd.time, fd.last, fd.vol]); changed++; } } } catch (e) {} // 台指期日盤分時
    if (changed) await env.TL.put(key, JSON.stringify(cur), { expirationTtl: 86400 * 10 });
    if (!items.some(it => it.date === d)) return; // 證交所回的還是前一個交易日的報價（臨時休市）：不判斷提醒
    // 2) 警示推播（名單直接從 app 的 pool_out／pool／i1／ext 組出；app 資料不是今天這一期就不推）
    const watch = await buildWatch(d);
    if (!watch) { if (new Date().getUTCMinutes() % 5 === 0) await env.TL.put('tl-meta', JSON.stringify({ at: new Date().toISOString(), date: d, codes: codes.length, changed, stale_app: true }), { expirationTtl: 86400 * 10 }); return; }
    const akey = 'al-' + d;
    const state = JSON.parse((await env.TL.get(akey)) || '{}');
    const alerts = alertsFor(items, watch, state);
    let sent = 0;
    for (const a of alerts) {
      const pref = a.id.startsWith('buy:') || a.id.startsWith('over:') ? 'buy' : 'stop';
      sent += await broadcast(env.TL, pref, { title: a.title, body: a.body, tag: a.id, url: APP_URL + '#live' }, { ttl: 1800, urgency: 'high' });
    }
    const hm = tpeHM(); let dirty = alerts.length > 0;
    if (hm >= 13 * 60 + 31 && hm <= 13 * 60 + 45 && !state.close) {
      state.close = 1; dirty = true;
      sent += await broadcast(env.TL, 'close', { title: '收盤摘要', body: closeSummary(items, watch), tag: 'close', url: APP_URL + '#live' }, { ttl: 3600, urgency: 'normal' });
    }
    if (dirty) await env.TL.put(akey, JSON.stringify(state), { expirationTtl: 86400 * 3 });
    if (alerts.length || new Date().getUTCMinutes() % 5 === 0) await env.TL.put('tl-meta', JSON.stringify({ at: new Date().toISOString(), date: d, codes: codes.length, changed, alerts: alerts.length, sent }), { expirationTtl: 86400 * 10 });
  },
};
