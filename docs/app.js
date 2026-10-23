/* 選股晨報 app — 只讀 data/*.json，所有選股邏輯都在排程裡算好 */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  const fmtP = n => (n == null || isNaN(n)) ? '—' : fmt(n, n >= 1000 ? (Number.isInteger(n) ? 0 : 2) : 2);
  const pct = (n, d) => (n == null || isNaN(n)) ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(d == null ? 2 : d) + '%';
  const sgn = (n, d) => (n == null || isNaN(n)) ? '—' : (n > 0 ? '+' : '') + fmt(n, d);
  const cls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : 'flat';
  const md = s => (s || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, (m, y, mo, d) => `${+mo}/${+d}`);
  const ymd8 = d => d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
  const grp = g => `<span class="grp g-${esc(g)}">${esc(g)}</span>`;
  const WEB = 'https://claude.ai/artifact/WV3mXs9MbnsLWQxFYjcaHQ';

  const D = {};
  const FILES = ['meta', 'market', 'market_analysis', 'pool_out', 'pool', 'history', 'archive', 'i1', 'ext', 'quotes'];

  async function load(force) {
    const res = await Promise.all(FILES.map(async f => {
      try {
        const r = await fetch(`data/${f}.json?t=${force ? Date.now() : Math.floor(Date.now() / 300000)}`, { cache: force ? 'reload' : 'default' });
        if (!r.ok) throw new Error(r.status);
        return [f, await r.json()];
      } catch (e) { return [f, null]; }
    }));
    res.forEach(([f, v]) => { D[f] = v; });
    render();
  }

  function render() {
    renderHeader();
    renderToday();
    renderLive();
    renderPool();
    renderHistory();
    renderLab();
    if (!$('#chart').hidden) drawChart();
  }

  // ---------- header ----------
  function renderHeader() {
    const m = D.meta || {};
    const dl = $('#dateline');
    if (m.report_date) {
      const r = /(\d{4})\/(\d{2})\/(\d{2})（(.)）/.exec(m.report_date);
      dl.innerHTML = r ? `<b>${+r[2]}/${+r[3]}</b><span class="wd">週${esc(r[4])}</span><small>資料日 ${esc((m.data_date || '').replace(/^\d{4}\//, ''))} 收盤</small>` : esc(m.report_date);
    } else dl.textContent = '找不到晨報資料';
    const mk = D.market;
    const box = $('#mkt');
    if (mk && mk.TSE01) {
      box.hidden = false;
      box.innerHTML = ['TSE01', 'OTC01'].filter(k => mk[k]).map(k => {
        const x = mk[k];
        return `<span data-k="${k}"><small>${esc(x.name.replace('指數', ''))}${x.state ? '・' + esc(x.state) : ''}</small><b>${fmt(x.close)}</b><em class="${cls(x.chg)}">${pct(x.chg)}</em></span>`;
      }).join('');
    } else box.hidden = true;
    const stale = $('#stale');
    const eve = (m.notes || []).find(n => /晚上版/.test(n));
    if (eve) { stale.hidden = false; stale.textContent = eve + '。'; }
    else stale.hidden = true;
  }

  // ---------- 今日 ----------
  function renderToday() {
    const el = $('#tab-today');
    const po = D.pool_out, ma = D.market_analysis || {};
    if (!po) { el.innerHTML = '<p class="empty">今日資料尚未產出。</p>'; return; }
    let h = '';
    const lead = (ma.summary || []).concat();
    if (lead.length) h += `<section class="sec plain"><h2>盤勢重點</h2><div class="body"><ul class="lead">${lead.map(s => `<li>${esc(s)}</li>`).join('')}</ul></div></section>`;

    const news = po.new || [];
    let body;
    if (po.paused) body = '<p class="empty">策略轉弱，今日暫停新增。</p>';
    else if (!news.length) body = `<p class="empty">${po.bull === false && po.max_new === 0 ? '大盤非多頭，依規則今日暫停新增。' : '今日無新增。'}</p>`;
    else body = news.map(pick).join('');
    const ev = po.ev;
    let evh = '';
    if (news.length && ev) evh = `<p class="note">回測期望值（同一套規則 ${ev.n} 筆，${esc(ev.period || '')}，已扣成本）：每筆平均 ${pct(ev.mean, 1)}、中位數 ${pct(ev.median, 1)}，一半落在 ${pct(ev.q25, 1)}～${pct(ev.q75, 1)}；勝率 ${ev.win}%，賺的平均 ${pct(ev.winavg, 1)}、賠的平均 ${pct(ev.lossavg, 1)}。多數會小賠出場，不是這一檔的預測。</p>`;
    let unf = '';
    if ((po.unfilled || []).length) unf = `<p class="note">昨日新增未成交（整天都在可買入上限之上，依規則不追）：${po.unfilled.map(u => `${esc(u.code)} ${esc(u.name)}（上限 ${fmt(u.cap)}、開盤 ${fmt(u.open)}）`).join('、')}</p>`;
    h += `<section class="sec w4"><h2>今日新增<span class="cnt">${news.length} 檔${po.bull === false ? '・大盤非多頭，最多 ' + po.max_new + ' 檔' : ''}</span></h2><div class="body">${body}${evh}${unf}</div></section>`;

    const ex = po.exits || [];
    h += `<section class="sec down"><h2>今日出場<span class="cnt">${ex.length} 檔</span></h2><div class="body">${ex.length ? ex.map(x => `
      <div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
      <span class="sub">${esc(x.sector || '')}・${grp(x.group)}・進場 ${fmt(x.entry)} → 出場 ${fmt(x.exit)}・${esc(why(x.why))}</span></div>`).join('') : '<p class="empty">無</p>'}</div></section>`;

    const risk = po.risk || [];
    if (risk.length) h += `<section class="sec strong"><h2>風險提示</h2><div class="body"><ul class="lead">${risk.map(r => `<li>${esc(r.code)} ${esc(r.name)}：${esc(r.text)}</li>`).join('')}</ul></div></section>`;

    const hold = po.holding || [];
    const s = po.summary || {};
    h += `<section class="sec support"><h2>續抱<span class="cnt">${hold.length}／${(po.params || {}).pool_max || 10} 檔</span></h2><div class="body">
      ${hold.length ? hold.map(x => `<div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
        <span class="sub">${grp(x.group)}・停損 ${fmt(x.stop_now)}${x.group === '回檔站回' ? '（趨勢線）' : ''}・持有 ${x.days}${x.group === '回檔站回' ? '' : '/20'} 天</span></div>`).join('') : '<p class="empty">目前池內無持股</p>'}
      ${s.start ? `<p class="note">觀察池績效（${md(s.start)} 起）：已結算 ${s.closed} 筆，平均 ${pct(s.avg)}、勝率 ${s.hit == null ? '—' : s.hit + '%'}；累積 ${pct(s.cum)}（同期 0050 ${pct(s.bench)}）</p>` : ''}
      <div class="btnrow" style="margin-top:10px"><button type="button" class="btn" data-go="pool">看持股明細</button></div></div></section>`;

    const sec = [['技術面', ma.tech], ['籌碼', ma.chips], ['國際盤與夜盤', ma.intl], ['今日觀察', ma.plan]].filter(([, a]) => a && a.length);
    if (sec.length) h += `<section class="sec plain"><h2>大盤分析</h2><div class="body">${sec.map(([t, a]) => `<details><summary>${t}</summary><ul class="lead">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`).join('')}</div></section>`;

    h += `<section class="sec plain"><h2>完整報告</h2><div class="body"><div class="btnrow">
      <a class="btn primary" href="report.pdf" data-pdf="${esc((D.meta || {}).report_date || '')} 晨報">開啟今日 PDF（含 K 線圖）</a>
      <a class="btn" href="guide.pdf" data-pdf="晨報 App 使用說明">使用說明</a>
      <a class="btn" href="${WEB}" target="_blank" rel="noopener">晨報網頁版</a></div>
      ${(D.meta && D.meta.notes || []).length ? `<details style="margin-top:8px"><summary>備註<span class="am">${D.meta.notes.length} 則</span></summary><ul class="lead note">${D.meta.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}</div></section>`;
    el.innerHTML = h;
  }

  function pick(x) {
    const lotBig = x.lot && x.lot >= 1000000;
    return `<div class="pick" data-k="${esc(x.code)}">
      <div class="hd"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="tag g-${esc(x.group)}">${esc(x.group)}</span><span class="sub">${esc(x.sector || '')}</span></div>
      <div class="kv">
        <div><span class="k">參考價（入選日收盤）</span><span class="v">${fmt(x.ref != null ? x.ref : x.entry)}</span></div>
        ${x.cap != null ? `<div><span class="k">可買入上限</span><span class="v cap">${fmt(x.cap)}</span></div>` : ''}
        <div><span class="k">停損${x.group === '回檔站回' ? '（趨勢線）' : ''}</span><span class="v stop">${fmt(x.stop_now)}</span></div>
      </div>
      <p class="lot">${x.cap != null ? '開盤高於上限就不追；' : ''}${x.lot ? `一張約 ${Math.round(x.lot / 10000)} 萬元${lotBig ? '，可考慮零股' : ''}` : ''}<span class="hint">點一下看 K 線</span></p>
    </div>`;
  }
  function why(w) { return { stop: '跌破停損', hard: '虧損逾 10%', hold: '持有期滿', st: '跌破趨勢線', time: '持有期滿' }[w] || w || ''; }

  // ---------- 盤中（報價板） ----------
  function tpeNow() { return new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000); }
  function marketPhase() {
    const t = tpeNow(), hm = t.getHours() * 60 + t.getMinutes(), wd = t.getDay();
    if (wd === 0 || wd === 6) return 'closed';
    if (hm < 9 * 60) return 'pre';
    if (hm <= 13 * 60 + 35) return 'open';
    return 'after';
  }
  function quoteCard(x, opts) {
    const o = opts || {};
    const last = x.last, chg = x.chg != null ? x.chg : (last != null && x.prev ? last - x.prev : null);
    const c = cls(chg);
    const big = o.index;
    return `<div class="qc ${c} ${big ? 'qc-idx' : ''}" data-k="${esc(o.code || x.code)}">
      <div class="qh"><span class="qn">${esc(x.name)}</span><span class="qcode">${big ? '' : esc(x.code)}</span>${o.flag || ''}<span class="qt">${x.time ? esc(x.time.slice(0, 5)) : ''}</span></div>
      <div class="qp"><b>${last == null ? '—' : fmtP(last)}${x.est ? '<i title="尚無成交，以買賣價估計">*</i>' : ''}</b><span class="qd"><em>${sgn(chg, big ? 2 : 2)}</em><em>${pct(x.chg_pct)}</em></span></div>
      <div class="qg">
        <span><small>開</small>${fmtP(x.open)}</span><span><small>高</small>${fmtP(x.high)}</span><span><small>低</small>${fmtP(x.low)}</span><span><small>昨收</small>${fmtP(x.prev)}</span>
        ${big ? `<span><small>振幅</small>${x.high != null && x.low != null && x.prev ? ((x.high - x.low) / x.prev * 100).toFixed(2) + '%' : '—'}</span>` : `<span><small>買</small>${fmtP(x.bid)}</span><span><small>賣</small>${fmtP(x.ask)}</span><span><small>量</small>${x.vol != null ? fmt(x.vol, 0) : '—'}</span>`}
      </div>
      ${o.ctx ? `<div class="qx">${o.ctx}</div>` : ''}
    </div>`;
  }
  function renderLive() {
    const el = $('#tab-live');
    const q = D.quotes;
    const phase = marketPhase();
    let h = '';
    if (!q || !q.items) {
      el.innerHTML = '<section class="sec plain"><h2>盤中</h2><div class="body"><p class="empty">還沒有盤中資料。開盤時間（09:00–13:30）每 5 分鐘更新一次，加權、櫃買、池內持股、今日新增與測試名單都會在這裡。</p></div></section>' + searchBox();
      return;
    }
    const it = q.items;
    const live = q.market_open && phase === 'open';
    h += `<div class="lstat"><span class="dot ${live ? 'on' : ''}"></span>${live ? `盤中・${esc(q.updated.slice(11))} 更新` : q.market_open ? `${esc(fmtD8(q.data_date))} 收盤` : `最近收盤 ${esc(fmtD8(q.data_date))}`}<small>證交所報價，延遲約 5–10 分鐘</small></div>`;
    const idx = q.index || {};
    const ik = [['t00', 'TSE01'], ['o00', 'OTC01']].filter(([k]) => idx[k]);
    if (ik.length) h += `<div class="qgrid idx">${ik.map(([k, code]) => quoteCard(idx[k], { index: true, code })).join('')}</div>`;

    const ctxFor = (x, kind) => {
      const last = x.last; let ctx = '', flag = '';
      if (kind === 'new' || kind === 'i1new') {
        const cap = x[kind + '_cap'], stop = x[kind + '_stop'];
        if (cap != null && last != null) {
          const d = (last / cap - 1) * 100;
          if (last <= cap) { ctx = `上限 ${fmt(cap)}・低 ${pct(-d, 1).replace('+', '')}`; flag = '<span class="lflag ok">可買</span>'; }
          else { ctx = `上限 ${fmt(cap)}・高 ${pct(d, 1)}`; flag = '<span class="lflag over">超過上限</span>'; }
        } else if (cap != null) ctx = `上限 ${fmt(cap)}`;
        if (stop != null) ctx += `<i>停損 ${fmt(stop)}</i>`;
      } else if (kind === 'ext' || kind === 'extopen') {
        if (x.extopen_entry != null && last != null) ctx = `模擬進場 ${fmt(x.extopen_entry)} → <b class="${cls(last / x.extopen_entry - 1)}">${pct((last / x.extopen_entry - 1) * 100)}</b>`;
        else if (x.ext_close != null) ctx = `昨收 ${fmt(x.ext_close)}`;
      } else if (kind === 'exit') {
        ctx = `晨報出場 ${fmt(x.exit_exit)}（${pct(x.exit_ret)}）`;
      } else {
        const stop = x[kind + '_stop'], entry = x[kind + '_entry'];
        if (entry != null && last != null) ctx = `進場 ${fmt(entry)} → <b class="${cls(last / entry - 1)}">${pct((last / entry - 1) * 100)}</b>`;
        if (stop != null && last != null) {
          const d = (last / stop - 1) * 100;
          ctx += `<i>停損 ${fmt(stop)}（${pct(d, 1)}）</i>`;
          if (last < stop) flag = '<span class="lflag over">跌破停損</span>';
          else if (d < 2) flag = '<span class="lflag warn">接近停損</span>';
        }
      }
      return { ctx, flag };
    };
    const groups = [['new', '今日新增', 'w4'], ['pool', '觀察池持股', 'support'], ['exit', '今日出場', 'down'], ['i1new', 'I1 今日新增（測試）', 'i1'], ['i1', 'I1 模擬持股（測試）', 'i1'], ['ext', '趨勢延續觀察（測試）', 'strong']];
    let any = false;
    groups.forEach(([k, title, c]) => {
      const list = it.filter(x => x.kinds.includes(k) || (k === 'ext' && x.kinds.includes('extopen') && !x.kinds.includes('ext')));
      if (!list.length) return;
      any = true;
      h += `<section class="sec ${c}"><h2>${title}<span class="cnt">${list.length} 檔</span></h2><div class="qgrid">${list.map(x => { const { ctx, flag } = ctxFor(x, k); return quoteCard(x, { ctx, flag }); }).join('')}</div></section>`;
    });
    if (!any) h += '<section class="sec plain"><h2>盤中</h2><div class="body"><p class="empty">目前沒有要盯的股票。</p></div></section>';
    if (it.some(x => x.est)) h += '<p class="note" style="margin:0">* 尚無成交，以買一／賣一估計。</p>';
    h += searchBox();
    el.innerHTML = h;
  }
  function fmtD8(d) { return d && d.length === 8 ? `${+d.slice(4, 6)}/${+d.slice(6)}` : (d || ''); }
  function searchBox() {
    return `<section class="sec plain"><h2>查任一檔 K 線</h2><div class="body"><div class="search"><input id="ksearch" type="search" inputmode="search" placeholder="輸入代號或名稱，例如 2330 或 台積電" autocomplete="off"><div id="kresult" class="kresult" hidden></div></div><p class="note">涵蓋晨報股票池（台灣50、中型100、櫃買權值）與加權、櫃買指數，2016 年起的日／週／月／年 K。</p></div></section>`;
  }
  // 自動更新：交易時段每 60 秒重抓 quotes.json
  setInterval(() => {
    if (document.visibilityState !== 'visible' || marketPhase() !== 'open') return;
    fetch(`data/quotes.json?t=${Date.now()}`, { cache: 'reload' }).then(r => r.ok ? r.json() : null).then(j => { if (j && JSON.stringify(j) !== JSON.stringify(D.quotes)) { D.quotes = j; renderLive(); if (!$('#chart').hidden) drawChart(); } }).catch(() => {});
  }, 60000);

  // 搜尋（股票池清單從 kl/index.json 取）
  let KL = null;
  async function klIndex() {
    if (KL) return KL;
    try { const r = await fetch('data/kl/index.json'); KL = r.ok ? (await r.json()).items : []; } catch (e) { KL = []; }
    return KL;
  }
  document.addEventListener('input', async e => {
    if (e.target.id !== 'ksearch') return;
    const q = e.target.value.trim().toLowerCase(), box = $('#kresult');
    if (!q) { box.hidden = true; return; }
    const list = (await klIndex()).filter(x => x.code.toLowerCase().includes(q) || (x.name || '').toLowerCase().includes(q)).slice(0, 8);
    box.hidden = false;
    box.innerHTML = list.length ? list.map(x => `<button type="button" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span>${esc(x.name)}</button>`).join('') : '<p class="empty">找不到，這檔可能不在晨報的股票池裡。</p>';
  });

  // ---------- 持股 ----------
  function renderPool() {
    const el = $('#tab-pool');
    const p = D.pool;
    if (!p) { el.innerHTML = '<p class="empty">尚無觀察池資料。</p>'; return; }
    const pos = p.positions || [], closed = (p.closed || []).slice().reverse();
    const s = (D.pool_out || {}).summary || {};
    let h = '';
    h += `<section class="sec support"><h2>目前持股<span class="cnt">${pos.length}／${((D.pool_out || {}).params || {}).pool_max || 10} 檔</span></h2><div class="body">
      ${pos.length ? pos.map(posrow).join('') : '<p class="empty">目前池內無持股</p>'}
      <p class="note">損益以資料日收盤計算。「回檔站回」停損是超級趨勢線，會隨股價上移、不設持有天數；其他組別維持原停損與 20 天上限。</p></div></section>`;
    const eq = p.equity || [];
    const last = eq.length ? (eq[eq.length - 1].eq - 1) * 100 : null;
    h += `<section class="sec plain"><h2>觀察池績效<span class="cnt">${md(p.start)} 起</span></h2><div class="body">
      <div class="stats">
        <div><span class="k">累積</span><span class="v ${cls(last)}">${pct(last)}</span></div>
        <div><span class="k">同期 0050</span><span class="v ${cls(s.bench)}">${pct(s.bench)}</span></div>
        <div><span class="k">已結算</span><span class="v">${closed.length} 筆</span></div>
        <div><span class="k">平均每筆</span><span class="v ${cls(s.avg)}">${pct(s.avg)}</span></div>
        <div><span class="k">勝率</span><span class="v">${s.hit == null ? '—' : s.hit + '%'}</span></div>
        <div><span class="k">停損出場</span><span class="v">${s.stop_rate == null ? '—' : s.stop_rate + '%'}</span></div>
      </div>${spark(eq)}</div></section>`;
    h += `<section class="sec down"><h2>已結算<span class="cnt">${closed.length} 筆</span></h2><div class="body">${closed.length ? closed.map(x => `
      <div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
      <span class="sub">${grp(x.group)}・${md(x.entry_date)} ${fmt(x.entry)} → ${md(x.exit_date)} ${fmt(x.exit)}・${x.days} 天・${esc(why(x.why))}</span></div>`).join('') : '<p class="empty">尚無結算</p>'}</div></section>`;
    el.innerHTML = h;
  }
  function posrow(x) {
    const pending = x.status === 'pending';
    const dist = x.stop_dist;
    const w = dist == null ? 0 : Math.max(2, Math.min(100, dist * 5));
    return `<div class="posrow" data-k="${esc(x.code)}">
      <div class="hd"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span>${pending ? '<span class="pend">今日可買</span>' : ''}<span class="ret ${cls(x.ret)}">${pending ? '' : pct(x.ret)}</span></div>
      <div class="meta"><span>${grp(x.group)}・${esc(x.sector || '')}</span>
        <span>${md(x.entry_date)} 入選</span>
        <span>${pending ? `參考 <b>${fmt(x.ref)}</b>・上限 <b>${fmt(x.cap)}</b>` : `進場 <b>${fmt(x.entry)}</b> → 現價 <b>${fmt(x.last)}</b>`}</span>
        <span>停損 <b>${fmt(x.stop_now)}</b>${dist != null ? `（距 ${pct(dist, 1)}）` : ''}</span>
        <span>持有 ${x.days}${x.group === '回檔站回' ? '' : '/20'} 天</span></div>
      <div class="bar ${dist != null && dist < 2 ? 'tight' : ''}" title="距停損 ${pct(dist, 1)}"><i style="width:${w}%"></i></div>
    </div>`;
  }
  function spark(eq) {
    if (!eq || eq.length < 2) return '';
    const v = eq.map(e => e.eq), lo = Math.min(...v, 1), hi = Math.max(...v, 1);
    const W = 600, H = 60, pad = 4;
    const X = i => pad + i * (W - 2 * pad) / (v.length - 1), Y = y => H - pad - (y - lo) / ((hi - lo) || 1) * (H - 2 * pad);
    const d = v.map((y, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(y).toFixed(1)).join(' ');
    const base = Y(1).toFixed(1);
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="觀察池權益曲線">
      <line x1="0" x2="${W}" y1="${base}" y2="${base}" stroke="var(--line)" stroke-dasharray="4 4"/>
      <path d="${d}" stroke="${v[v.length - 1] >= 1 ? 'var(--up)' : 'var(--down)'}"/></svg>
      <p class="note" style="margin-top:2px">${md(eq[0].date)} → ${md(eq[eq.length - 1].date)}，虛線為起點（每檔固定資金、已扣成本）</p>`;
  }

  // ---------- 歷史 ----------
  function renderHistory() {
    const el = $('#tab-history');
    const arch = D.archive || [], hist = D.history || [];
    let h = '';
    h += `<section class="sec plain"><h2>歷史晨報<span class="cnt">保留最近 60 份</span></h2><div class="body">
      ${arch.length ? `<ul class="arch">${arch.map((a, i) => { const short = s => (s || '').replace(/^\d{4}\/0?/, '').replace(/\/0?/, '/'); return `<li><a href="archive/${esc(a.file_date)}.pdf" data-pdf="${esc(a.report_date)} 晨報（資料日 ${esc(a.data_date)}）" data-date="${esc(a.file_date)}" ${i ? 'data-hist' : ''}>${esc(short(a.report_date))}</a>${i ? '' : '<span class="today">今日</span>'}<span class="am">資料日 ${esc(short(a.data_date).replace(/（.）/, ''))}・${a.n} 檔</span></li>`; }).join('')}</ul>` : '<p class="empty">尚無歸檔</p>'}
      <p class="note">點日期看當天 PDF。</p></div></section>`;
    const byDate = {};
    hist.forEach(x => { (byDate[x.date] = byDate[x.date] || []).push(x); });
    const dates = Object.keys(byDate).sort().reverse();
    h += `<section class="sec plain"><h2>歷史入選<span class="cnt">${hist.length} 筆</span></h2><div class="body">
      ${dates.map((d, i) => `<details ${i < 2 ? 'open' : ''}><summary>${md(d)}（資料日）<span class="am">${byDate[d].length} 檔</span></summary>
        ${byDate[d].map(x => `<div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num">${fmt(x.entry)}</span><span class="sub">${esc(x.sector || '')}・${grp(x.group)}${x.ver ? '・第 ' + x.ver + ' 版' : ''}</span></div>`).join('')}
      </details>`).join('')}</div></section>`;
    el.innerHTML = h;
  }

  // ---------- 測試 ----------
  function renderLab() {
    const el = $('#tab-lab');
    const i1 = D.i1, ext = D.ext;
    let h = `<p class="note" style="margin:0">這一頁是「只記錄、不納入觀察池」的測試名單，用來跟 W4 比成績，不是建議買的名單。</p>`;
    if (i1) {
      const st = i1.stats || {};
      const row = x => `<div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${x.ret != null ? pct(x.ret) : ''}</span>
        <span class="sub">${x.entry != null ? `進場 ${fmt(x.entry)}` : ''}${x.cap != null ? `・上限 ${fmt(x.cap)}` : ''}${x.stop_now != null ? `・停損 ${fmt(x.stop_now)}` : ''}${x.w != null ? `・權重 ${(x.w * 100).toFixed(0)}%` : ''}${x.days != null ? `・${x.days} 天` : ''}</span></div>`;
      h += `<section class="sec i1"><h2>I1 測試名單<span class="cnt">評分選股＋移動停損</span></h2><div class="body">
        <h3>今日新增${i1.bull === false ? '<span class="cnt">大盤非多頭，不新增</span>' : ''}</h3>${(i1.new || []).length ? i1.new.map(row).join('') : '<p class="empty">無</p>'}
        ${(i1.exits || []).length ? `<h3 style="margin-top:10px">今日出場</h3>${i1.exits.map(row).join('')}` : ''}
        <h3 style="margin-top:10px">模擬持股<span class="cnt">${(i1.holding || []).length} 檔</span></h3>${(i1.holding || []).length ? i1.holding.map(row).join('') : '<p class="empty">無</p>'}
        <div class="stats" style="margin-top:10px">
          <div><span class="k">累積</span><span class="v ${cls(st.cum)}">${pct(st.cum)}</span></div>
          <div><span class="k">同期 0050</span><span class="v ${cls(st.bench)}">${pct(st.bench)}</span></div>
          <div><span class="k">已結算</span><span class="v">${st.closed || 0} 筆</span></div></div>
        ${(i1.top || []).length ? `<details style="margin-top:8px"><summary>今日評分前 ${i1.top.length} 名</summary>${i1.top.map(t => `<div class="stock" data-k="${esc(t.code)}"><span class="code">${esc(t.code)}</span><span class="name">${esc(t.name)}</span><span class="num">${fmt(t.close)}</span><span class="sub">評分 ${t.score}・ADX ${t.adx}・120 日 ${pct(t.ret120, 1)}</span></div>`).join('')}</details>` : ''}
        ${i1.backtest ? `<p class="note">${esc(i1.backtest)}</p>` : ''}
        <p class="note">${md(st.start)} 起紙上追蹤一個月，之後再決定是否納入。</p></div></section>`;
    }
    if (ext) {
      const st = ext.stats || {};
      h += `<section class="sec strong"><h2>趨勢延續觀察<span class="cnt">測試中</span></h2><div class="body">
        ${(ext.list || []).length ? ext.list.map(x => `<div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num">${fmt(x.close)}</span><span class="sub">20 日 ${pct(x.mom20, 1)}・離月線 ${pct(x.ext20, 1)}・ADX ${x.adx}</span></div>`).join('') : '<p class="empty">今日無符合條件的股票</p>'}
        ${(ext.opens || []).length ? `<details style="margin-top:8px"><summary>模擬持有<span class="am">${ext.opens.length} 檔・平均 ${pct(st.open_avg)}</span></summary>${ext.opens.map(x => `<div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span><span class="sub">${md(x.date)} 進場 ${fmt(x.entry)} → ${fmt(x.last)}・${x.days} 天</span></div>`).join('')}</details>` : ''}
        <p class="note">已結算 ${st.closed || 0} 筆、平均 ${pct(st.avg)}。${esc(ext.backtest || '')}</p></div></section>`;
    }
    if (!i1 && !ext) h += '<p class="empty">尚無測試資料。</p>';
    el.innerHTML = h;
  }

  // ---------- K 線圖 ----------
  const PERIODS = { D: { label: '日', n: 90, mas: [5, 20, 60] }, W: { label: '週', n: 80, mas: [5, 20, 60] }, M: { label: '月', n: 60, mas: [5, 20, 60] }, Y: { label: '年', n: 12, mas: [3, 5, 10] } };
  const K = { cache: {}, cacheL: {}, code: null, period: 'D', n: 90, end: null, cur: null, geo: null };
  function levelsFor(code) {
    const L = [];
    const po = D.pool_out || {}, pool = D.pool || {}, i1 = D.i1 || {};
    const seen = {};
    const put = (v, label, color) => { if (v != null && !seen[label]) { seen[label] = 1; L.push({ v: +v, label, color }); } };
    (po.new || []).concat((pool.positions || []).filter(x => x.status === 'pending')).forEach(x => { if (x.code === code) { put(x.cap, '可買入上限', '--w4'); put(x.stop_now, '停損', '--down'); } });
    (pool.positions || []).forEach(x => { if (x.code === code && x.status !== 'pending') { put(x.entry, '進場', '--support'); put(x.stop_now, '停損', '--down'); } });
    (i1.new || []).forEach(x => { if (x.code === code) { put(x.cap, 'I1 上限', '--i1'); put(x.stop_now, 'I1 停損', '--i1'); } });
    (i1.holding || []).forEach(x => { if (x.code === code) { put(x.entry, 'I1 進場', '--i1'); put(x.stop_now, 'I1 停損', '--i1'); } });
    return L;
  }
  function liveBar(code, bars) {
    const q = D.quotes; if (!q) return null;
    const src = code === 'TSE01' ? (q.index || {}).t00 : code === 'OTC01' ? (q.index || {}).o00 : (q.items || []).find(x => x.code === code);
    if (!src || !src.date || src.last == null) return null;
    const d = ymd8(src.date);
    if (bars.length && d <= bars[bars.length - 1][0]) return null;
    const o = src.open != null ? src.open : src.last, h = Math.max(src.high != null ? src.high : src.last, src.last), l = Math.min(src.low != null ? src.low : src.last, src.last);
    const vol = code === 'TSE01' || code === 'OTC01' ? (src.vol || 0) : (src.vol || 0);
    return [d, o, h, l, src.last, vol, true];
  }
  async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function series(code) {
    // 日K：優先用 k/（還原價）；週／月／年：用 kl/（未還原、2016 起），尾端接上 k/ 更新的幾天
    const p = K.period;
    if (!K.cache[code] && K.cache[code] !== false) { try { K.cache[code] = await getJSON(`data/k/${code}.json`); } catch (e) { K.cache[code] = false; } }
    if (p !== 'D' || !K.cache[code]) {
      if (!K.cacheL[code] && K.cacheL[code] !== false) { try { K.cacheL[code] = await getJSON(`data/kl/${code}.json`); } catch (e) { K.cacheL[code] = false; } }
    }
    const k = K.cache[code], kl = K.cacheL[code];
    let base, adj, name;
    if (p === 'D') {
      if (k) { base = k.bars.slice(); adj = true; name = k.name; }
      else if (kl) { base = kl.bars.slice(); adj = false; name = kl.name; }
      else return null;
    } else {
      if (kl) { base = kl.bars.slice(); adj = false; name = kl.name; if (k) { const lastD = base[base.length - 1][0]; k.bars.forEach(b => { if (b[0] > lastD) base.push(b); }); } }
      else if (k) { base = k.bars.slice(); adj = true; name = k.name; }
      else return null;
    }
    const lb = liveBar(code, base); if (lb) base.push(lb);
    return { code, name, adj, daily: base, bars: p === 'D' ? base : aggregate(base, p) };
  }
  function aggregate(daily, p) {
    const key = d => { const dt = new Date(d + 'T00:00:00'); if (p === 'Y') return d.slice(0, 4); if (p === 'M') return d.slice(0, 7); const t = new Date(dt); t.setDate(dt.getDate() - ((dt.getDay() + 6) % 7)); return t.toISOString().slice(0, 10); };
    const out = []; let cur = null, ck = null;
    daily.forEach(b => {
      const k = key(b[0]);
      if (k !== ck) { cur = [b[0], b[1], b[2], b[3], b[4], b[5], !!b[6]]; ck = k; out.push(cur); }
      else { cur[0] = b[0]; cur[2] = Math.max(cur[2], b[2]); cur[3] = Math.min(cur[3], b[3]); cur[4] = b[4]; cur[5] += b[5]; cur[6] = cur[6] || !!b[6]; }
    });
    return out;
  }
  async function openChart(code) {
    const box = $('#chart'); box.hidden = false; document.body.classList.add('vopen');
    const changed = K.code !== code;
    K.code = code; K.cur = null; if (changed) K.end = null;
    $('#ctitle').textContent = code; $('#csub').textContent = '載入中…'; $('#clegend').innerHTML = '';
    const s = await series(code);
    if (K.code !== code) return;
    if (!s) { $('#csub').textContent = '這檔沒有 K 線資料（不在晨報的股票池裡）。'; K.series = null; const cv = $('#ccanvas'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
    K.series = s;
    drawChart();
  }
  function closeChart() { $('#chart').hidden = true; document.body.classList.remove('vopen'); K.code = null; K.series = null; }
  $('#cclose').addEventListener('click', closeChart);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#chart').hidden) closeChart(); });
  document.addEventListener('click', async e => {
    const pb = e.target.closest('[data-period]');
    if (pb) { K.period = pb.dataset.period; K.n = PERIODS[K.period].n; K.end = null; K.cur = null; document.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('active', b === pb)); if (K.code) { K.series = await series(K.code); drawChart(); } return; }
    const zb = e.target.closest('[data-zoom]');
    if (zb) { const z = zb.dataset.zoom; if (z === 'in') K.n = Math.max(20, Math.round(K.n / 1.4)); else if (z === 'out') K.n = Math.min(600, Math.round(K.n * 1.4)); else if (z === 'left') K.end = (K.end == null ? total() : K.end) - Math.round(K.n / 2); else if (z === 'right') K.end = (K.end == null ? total() : K.end) + Math.round(K.n / 2); else if (z === 'latest') K.end = null; clampView(); drawChart(); return; }
    if (e.target.closest('a,button:not([data-k]),summary,input')) return;
    const k = e.target.closest('[data-k]'); if (k) openChart(k.dataset.k);
  });
  window.addEventListener('resize', () => { if (!$('#chart').hidden) drawChart(); });
  function total() { return K.series ? K.series.bars.length : 0; }
  function clampView() { const t = total(); if (!t) return; K.n = Math.max(10, Math.min(K.n, t)); if (K.end == null || K.end >= t) K.end = null; else K.end = Math.max(K.n, K.end); }

  function ma(c, n, i) { if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j]; return s / n; }
  function indicators(all) {
    const n = all.length, C = all.map(b => b[4]);
    const Kv = new Array(n).fill(null), Dv = new Array(n).fill(null), Jv = new Array(n).fill(null);
    let k = 50, dd = 50;
    for (let i = 0; i < n; i++) {
      if (i < 8) continue;
      let hi = -Infinity, lo = Infinity;
      for (let j = i - 8; j <= i; j++) { hi = Math.max(hi, all[j][2]); lo = Math.min(lo, all[j][3]); }
      const rsv = hi === lo ? 50 : (C[i] - lo) / (hi - lo) * 100;
      k = k * 2 / 3 + rsv / 3; dd = dd * 2 / 3 + k / 3;
      Kv[i] = k; Dv[i] = dd; Jv[i] = 3 * k - 2 * dd;
    }
    const ema = (p) => { const out = []; const a = 2 / (p + 1); let e = null; for (let i = 0; i < n; i++) { e = e == null ? C[i] : C[i] * a + e * (1 - a); out.push(e); } return out; };
    const e12 = ema(12), e26 = ema(26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = []; { const a = 2 / 10; let e = null; dif.forEach(v => { e = e == null ? v : v * a + e * (1 - a); dea.push(e); }); }
    const osc = dif.map((v, i) => v - dea[i]);
    return { K: Kv, D: Dv, J: Jv, dif, dea, osc };
  }
  function drawChart() {
    const s = K.series; if (!s) return;
    const cv = $('#ccanvas'), wrap = cv.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = wrap.clientWidth, H = Math.max(440, Math.min(680, Math.round(W * 1.4)));
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = v => css.getPropertyValue(v).trim();
    const C = { up: col('--up'), down: col('--down'), muted: col('--muted'), line: col('--line'), fg: col('--fg'), paper: col('--paper'), bg: col('--bg'), ma1: '#e39b2e', ma2: '#3a7bd5', ma3: '#9b59b6', k: '#e39b2e', d: '#3a7bd5', j: '#c04fd0', dif: '#e39b2e', dea: '#3a7bd5' };
    const FONT = css.getPropertyValue('--sans');
    const all = s.bars, ind = indicators(all);
    clampView();
    const endI = K.end == null ? all.length : K.end;
    const bars = all.slice(Math.max(0, endI - K.n), endI), n = bars.length, off = endI - n;
    const closes = all.map(b => b[4]);
    const last = all[all.length - 1], prevC = all.length > 1 ? all[all.length - 2][4] : null;
    const chg = prevC ? (last[4] / prevC - 1) * 100 : null;
    const isLive = !!last[6];
    const ph = PERIODS[K.period];
    $('#ctitle').textContent = `${s.code} ${s.name}`;
    $('#csub').innerHTML = `${esc(last[0])}${isLive ? '（' + (D.quotes && D.quotes.market_open && marketPhase() === 'open' ? '盤中' : '收盤') + '，報價延遲約 5–10 分）' : ''} 收 <b>${fmt(last[4])}</b> <span class="${cls(chg)}">${pct(chg)}</span>・${ph.label}K・${s.adj ? '還原價' : '未還原'}`;

    const padL = 6, padR = 56, bottom = 16, gapP = 14;
    const pH = Math.round(H * 0.46), vH = Math.round(H * 0.11), kH = Math.round(H * 0.15), mH = H - pH - vH - kH - bottom - gapP * 3 - 8;
    const P = { top: 8, h: pH }, V = { top: P.top + pH + gapP, h: vH }, KD = { top: 0, h: kH }, M = { top: 0, h: mH };
    KD.top = V.top + vH + gapP; M.top = KD.top + kH + gapP;
    const plotW = W - padL - padR;
    const x = i => padL + (i + 0.5) * plotW / n;
    const bw = Math.max(1.5, plotW / n * 0.62);
    const levels = levelsFor(K.code).filter(l => l.v > 0);
    let lo = Infinity, hi = -Infinity;
    bars.forEach(b => { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); });
    bars.forEach((b, i) => ph.mas.forEach(p => { const m = ma(closes, p, off + i); if (m != null) { lo = Math.min(lo, m); hi = Math.max(hi, m); } }));
    if (K.period === 'D') levels.forEach(l => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    const padP = (hi - lo) * 0.06 || 1; lo -= padP; hi += padP;
    const y = v => P.top + (hi - v) / (hi - lo) * P.h;
    const vmax = Math.max(...bars.map(b => b[5]), 1);
    const vy = v => V.top + V.h - v / vmax * V.h;
    const kyr = v => KD.top + (120 - Math.max(-20, Math.min(120, v))) / 140 * KD.h;
    const mvals = bars.map((b, i) => off + i).flatMap(i => [ind.dif[i], ind.dea[i], ind.osc[i]]).filter(v => v != null);
    const mmax = Math.max(...mvals.map(Math.abs), 1e-6);
    const my = v => M.top + (mmax - v) / (2 * mmax) * M.h;

    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px ' + FONT;
    const label = (t, top) => { ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(t, padL + 2, top - 12); };
    const step = niceStep((hi - lo) / 5);
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(v, step < 1 ? 2 : 0), W - padR + 4, y(v));
    }
    // 時間標籤
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tick = (b, pb) => { if (!pb) return null; if (K.period === 'D') return b[0].slice(0, 7) !== pb[0].slice(0, 7) ? b[0].slice(5, 7).replace(/^0/, '') + '月' : null; if (K.period === 'W') return b[0].slice(0, 7) !== pb[0].slice(0, 7) && +b[0].slice(5, 7) % 3 === 1 ? (b[0].slice(5, 7) === '01' ? b[0].slice(0, 4) : b[0].slice(5, 7).replace(/^0/, '') + '月') : null; if (K.period === 'M') return b[0].slice(0, 4) !== pb[0].slice(0, 4) ? b[0].slice(0, 4) : null; return b[0].slice(0, 4); };
    bars.forEach((b, i) => { const t = K.period === 'Y' ? ((n <= 8 || +b[0].slice(0, 4) % 2 === 0) ? b[0].slice(0, 4) : null) : tick(b, bars[i - 1]); if (!t) return; ctx.fillStyle = C.muted; ctx.fillText(t, x(i), H - bottom + 3); if (K.period !== 'Y') { ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x(i), P.top); ctx.lineTo(x(i), M.top + M.h); ctx.stroke(); } });
    const line = (fn, color, w) => { ctx.strokeStyle = color; ctx.lineWidth = w || 1.2; ctx.beginPath(); let st = false; bars.forEach((b, i) => { const v = fn(i); if (v == null) return; if (!st) { ctx.moveTo(x(i), v); st = true; } else ctx.lineTo(x(i), v); }); ctx.stroke(); };
    [[ph.mas[0], C.ma1], [ph.mas[1], C.ma2], [ph.mas[2], C.ma3]].forEach(([p, color]) => line(i => { const m = ma(closes, p, off + i); return m == null ? null : y(m); }, color));
    bars.forEach((b, i) => {
      const upc = b[4] >= b[1], color = upc ? C.up : C.down;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(i), y(b[2])); ctx.lineTo(x(i), y(b[3])); ctx.stroke();
      const o = y(b[1]), c = y(b[4]);
      if (upc) { ctx.fillStyle = C.paper; ctx.fillRect(x(i) - bw / 2, Math.min(o, c), bw, Math.max(1, Math.abs(c - o))); ctx.strokeRect(x(i) - bw / 2, Math.min(o, c), bw, Math.max(1, Math.abs(c - o))); }
      else ctx.fillRect(x(i) - bw / 2, Math.min(o, c), bw, Math.max(1, Math.abs(c - o)));
      ctx.globalAlpha = 0.55; ctx.fillStyle = color; ctx.fillRect(x(i) - bw / 2, vy(b[5]), bw, V.top + V.h - vy(b[5])); ctx.globalAlpha = 1;
    });
    if (isLive && K.end == null) { ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.font = '10px ' + FONT; ctx.fillText(D.quotes && D.quotes.market_open && marketPhase() === 'open' ? '最右一根為今日（盤中累積）' : '最右一根為今日', W - padR - 2, P.top + 2); ctx.font = '11px ' + FONT; }
    if (K.period === 'D') levels.forEach(l => {
      const color = col(l.color);
      ctx.strokeStyle = color; ctx.setLineDash([5, 4]); ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(padL, y(l.v)); ctx.lineTo(W - padR, y(l.v)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = 'bold 11px ' + FONT; ctx.fillText(`${l.label} ${fmt(l.v)}`, padL + 4, y(l.v) - 2); ctx.font = '11px ' + FONT;
    });
    label('KD(9,3,3)', KD.top);
    [[80, '80'], [50, '50'], [20, '20']].forEach(([v, t]) => { ctx.strokeStyle = C.line; ctx.setLineDash(v === 50 ? [] : [3, 3]); ctx.beginPath(); ctx.moveTo(padL, kyr(v)); ctx.lineTo(W - padR, kyr(v)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, W - padR + 4, kyr(v)); });
    line(i => ind.K[off + i] == null ? null : kyr(ind.K[off + i]), C.k); line(i => ind.D[off + i] == null ? null : kyr(ind.D[off + i]), C.d); line(i => ind.J[off + i] == null ? null : kyr(ind.J[off + i]), C.j, 1);
    label('MACD(12,26,9)', M.top);
    ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(padL, my(0)); ctx.lineTo(W - padR, my(0)); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('0', W - padR + 4, my(0));
    bars.forEach((b, i) => { const v = ind.osc[off + i]; if (v == null || off + i < 34) return; ctx.fillStyle = v >= 0 ? C.up : C.down; ctx.globalAlpha = 0.7; ctx.fillRect(x(i) - bw / 2, Math.min(my(0), my(v)), bw, Math.abs(my(v) - my(0)) || 1); ctx.globalAlpha = 1; });
    line(i => off + i < 26 ? null : my(ind.dif[off + i]), C.dif); line(i => off + i < 34 ? null : my(ind.dea[off + i]), C.dea);
    const i = K.cur == null ? n - 1 : Math.max(0, Math.min(n - 1, K.cur));
    if (K.cur != null) {
      ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(i), P.top); ctx.lineTo(x(i), M.top + M.h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, y(bars[i][4])); ctx.lineTo(W - padR, y(bars[i][4])); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.fg; ctx.fillRect(W - padR + 1, y(bars[i][4]) - 8, padR - 2, 16); ctx.fillStyle = C.bg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(bars[i][4]), W - padR + 4, y(bars[i][4]));
    }
    const b = bars[i], gi = off + i, pv = gi > 0 ? closes[gi - 1] : null;
    const bchg = pv ? (b[4] / pv - 1) * 100 : null;
    const m = p => { const v = ma(closes, p, gi); return v == null ? '—' : fmt(v); };
    const f1 = v => v == null ? '—' : v.toFixed(1), f2 = v => v == null ? '—' : v.toFixed(2);
    const dl = K.period === 'D' ? b[0] : K.period === 'Y' ? b[0].slice(0, 4) + ' 年' : K.period === 'M' ? b[0].slice(0, 7) : '週 ' + b[0];
    $('#clegend').innerHTML = `<span class="d">${esc(dl)}${b[6] ? '（含今日）' : ''}</span><span>開 ${fmt(b[1])}</span><span>高 ${fmt(b[2])}</span><span>低 ${fmt(b[3])}</span><span>收 <b class="${cls(bchg)}">${fmt(b[4])}</b> <span class="${cls(bchg)}">${pct(bchg)}</span></span><span>量 ${fmt(b[5], 0)} 張</span>
      <span style="color:${C.ma1}">MA${ph.mas[0]} ${m(ph.mas[0])}</span><span style="color:${C.ma2}">MA${ph.mas[1]} ${m(ph.mas[1])}</span><span style="color:${C.ma3}">MA${ph.mas[2]} ${m(ph.mas[2])}</span>
      <span style="color:${C.k}">K ${f1(ind.K[gi])}</span><span style="color:${C.d}">D ${f1(ind.D[gi])}</span><span style="color:${C.j}">J ${f1(ind.J[gi])}</span>
      <span style="color:${C.dif}">DIF ${f2(gi < 26 ? null : ind.dif[gi])}</span><span style="color:${C.dea}">MACD ${f2(gi < 34 ? null : ind.dea[gi])}</span><span>OSC ${f2(gi < 34 ? null : ind.osc[gi])}</span>`;
    $('#crange').textContent = `${bars[0][0]} ～ ${bars[n - 1][0]}・${n} 根`;
    K.geo = { n, padL, padR, W, plotW };
  }
  function niceStep(r) { const p = Math.pow(10, Math.floor(Math.log10(r || 1))); const f = r / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
  // 手勢：點＝十字線；拖曳＝平移；雙指＝縮放
  (function () {
    const cv = $('#ccanvas');
    let pts = new Map(), dragStartX = 0, startEnd = 0, moved = false, pinch0 = 0, n0 = 0;
    const idxAt = px => { const g = K.geo; if (!g) return null; return Math.floor((px - g.padL) / (g.plotW / g.n)); };
    cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); pts.set(e.pointerId, e.clientX); moved = false; if (pts.size === 1) { dragStartX = e.clientX; startEnd = K.end == null ? total() : K.end; } else if (pts.size === 2) { const a = [...pts.values()]; pinch0 = Math.abs(a[0] - a[1]); n0 = K.n; } });
    cv.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) { if (e.pointerType === 'mouse') { K.cur = idxAt(e.clientX - cv.getBoundingClientRect().left); drawChart(); } return; }
      pts.set(e.pointerId, e.clientX);
      const g = K.geo; if (!g) return;
      if (pts.size === 2) { const a = [...pts.values()]; const d = Math.abs(a[0] - a[1]); if (pinch0 > 0) { K.n = Math.round(n0 * pinch0 / Math.max(d, 10)); clampView(); moved = true; drawChart(); } return; }
      const dx = e.clientX - dragStartX;
      if (Math.abs(dx) > 6) moved = true;
      if (moved) { K.end = startEnd - Math.round(dx / (g.plotW / g.n)); K.cur = null; clampView(); if (K.end >= total()) K.end = null; drawChart(); }
    });
    const up = e => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); if (!moved && pts.size === 0) { K.cur = idxAt(e.clientX - cv.getBoundingClientRect().left); drawChart(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('mouseleave', () => { if (pts.size === 0) { K.cur = null; drawChart(); } });
    cv.addEventListener('wheel', e => { e.preventDefault(); K.n = Math.round(K.n * (e.deltaY > 0 ? 1.15 : 0.87)); clampView(); drawChart(); }, { passive: false });
  })();

  // ---------- 分頁 ----------
  function go(name, push) {
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.dataset.tab !== name; });
    document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.go === name));
    if (push !== false) history.replaceState(null, '', '#' + name);
    window.scrollTo({ top: 0 });
  }
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-go]'); if (b) { go(b.dataset.go); }
  });
  const first = (location.hash || '#today').slice(1);
  go(['today', 'live', 'pool', 'history', 'lab'].includes(first) ? first : 'today', false);

  $('#refresh').addEventListener('click', () => { $('#refresh').classList.add('spin'); load(true).finally(() => { setTimeout(() => $('#refresh').classList.remove('spin'), 400); }); });

  // ---------- PDF 檢視 ----------
  (function () {
    const V = $('#viewer'), P = $('#vpages'), T = $('#vtitle'), S = $('#vstat'), W = $('#vwarn');
    let job = 0, opener = null;
    function close() { job++; V.hidden = true; P.innerHTML = ''; document.body.classList.remove('vopen'); if (opener) opener.focus(); }
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !V.hidden) close(); });
    $('#vclose').addEventListener('click', close);
    async function show(href, label, hist) {
      const my = ++job; V.hidden = false; P.innerHTML = ''; T.textContent = label; S.textContent = '載入中…';
      document.body.classList.add('vopen'); V.scrollTop = 0; $('#vclose').focus();
      W.hidden = !hist; W.textContent = hist ? '這是過去的晨報，不是今天的名單。' : '';
      try {
        if (!window.pdfjsLib) throw new Error('PDF 元件沒有載入成功，請檢查網路');
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const r = await fetch(href);
        if (!r.ok) throw new Error(r.status === 404 ? `這份 PDF 還沒同步到 app，請先到<a href="${WEB}" target="_blank" rel="noopener">晨報網頁</a>的「歷史晨報」查看` : `找不到檔案（${r.status}）`);
        const buf = await r.arrayBuffer(); if (my !== job) return;
        const pdf = await pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
        const w = Math.min(P.clientWidth || 800, 1000) * Math.min(window.devicePixelRatio || 1, 2);
        for (let i = 1; i <= pdf.numPages; i++) {
          if (my !== job) return;
          S.textContent = `第 ${i}／${pdf.numPages} 頁`;
          const pg = await pdf.getPage(i), vp0 = pg.getViewport({ scale: 1 }), vp = pg.getViewport({ scale: w / vp0.width });
          const c = document.createElement('canvas'); c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
          c.setAttribute('aria-label', `${label} 第 ${i} 頁`); P.appendChild(c);
          await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }
        S.textContent = `共 ${pdf.numPages} 頁`;
      } catch (e) { if (my === job) S.innerHTML = '無法顯示：' + e.message; }
    }
    document.addEventListener('click', ev => {
      const a = ev.target.closest && ev.target.closest('a[data-pdf]'); if (!a) return;
      ev.preventDefault(); opener = a; show(a.getAttribute('href'), a.getAttribute('data-pdf'), a.hasAttribute('data-hist'));
    });
  })();

  // ---------- 安裝提示 ----------
  (function () {
    const tip = $('#install'), how = $('#installhow'), btn = $('#installbtn');
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    let hidden = false; try { hidden = localStorage.getItem('installtip') === 'no'; } catch (e) {}
    if (standalone || hidden) return;
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) && !window.MSStream;
    let deferred = null;
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; btn.hidden = false; how.textContent = '按「安裝」即可。'; tip.hidden = false; });
    if (ios) {
      const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
      how.textContent = safari ? 'Safari 下方「分享」→「加入主畫面」。' : '請用 Safari 開啟這個網址，再「分享」→「加入主畫面」。';
      tip.hidden = false;
    } else {
      setTimeout(() => { if (!deferred) { how.textContent = '瀏覽器選單 →「加到主畫面」或「安裝應用程式」。'; tip.hidden = false; } }, 1500);
    }
    btn.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; tip.hidden = true; });
    $('#installclose').addEventListener('click', () => { tip.hidden = true; try { localStorage.setItem('installtip', 'no'); } catch (e) {} });
  })();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(false); });
  load(false);
})();
