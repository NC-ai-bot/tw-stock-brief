/* 選股晨報 app — 只讀 data/*.json，所有選股邏輯都在排程裡算好 */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('zh-TW', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  const pct = (n, d) => (n == null || isNaN(n)) ? '—' : (n > 0 ? '+' : '') + Number(n).toFixed(d == null ? 2 : d) + '%';
  const cls = n => n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  const md = s => (s || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, (m, y, mo, d) => `${+mo}/${+d}`);
  const grp = g => `<span class="grp g-${esc(g)}">${esc(g)}</span>`;
  const WEB = 'https://claude.ai/artifact/WV3mXs9MbnsLWQxFYjcaHQ';

  const D = {};
  const FILES = ['meta', 'market', 'market_analysis', 'pool_out', 'pool', 'history', 'archive', 'i1', 'ext'];

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
    renderPool();
    renderHistory();
    renderLab();
  }

  // ---------- header ----------
  function renderHeader() {
    const m = D.meta || {};
    $('#dateline').textContent = m.report_date ? `${m.report_date} 晨報・資料日 ${m.data_date || ''} 收盤` : '找不到晨報資料';
    const mk = D.market;
    const box = $('#mkt');
    if (mk && mk.TSE01) {
      box.hidden = false;
      box.innerHTML = ['TSE01', 'OTC01'].filter(k => mk[k]).map(k => {
        const x = mk[k];
        return `<span>${esc(x.name)} <b>${fmt(x.close)}</b> <span class="${cls(x.chg)}">${pct(x.chg)}</span> ${esc(x.state || '')}</span>`;
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

    // 盤勢重點
    const lead = (ma.summary || []).concat();
    if (lead.length) h += `<section class="card plain"><h2>盤勢重點</h2><ul class="lead">${lead.map(s => `<li>${esc(s)}</li>`).join('')}</ul></section>`;

    // 今日新增
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
    h += `<section class="card w4"><h2>今日新增<span class="cnt">${news.length} 檔${po.bull === false ? '・大盤非多頭，最多 ' + po.max_new + ' 檔' : ''}</span></h2>${body}${evh}${unf}</section>`;

    // 今日出場
    const ex = po.exits || [];
    h += `<section class="card down"><h2>今日出場<span class="cnt">${ex.length} 檔</span></h2>${ex.length ? ex.map(x => `
      <div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
      <span class="sub">${esc(x.sector || '')}・${grp(x.group)}・進場 ${fmt(x.entry)} → 出場 ${fmt(x.exit)}・${esc(why(x.why))}</span></div>`).join('') : '<p class="empty">無</p>'}</section>`;

    // 風險提示
    const risk = po.risk || [];
    if (risk.length) h += `<section class="card strong"><h2>風險提示</h2><ul class="lead">${risk.map(r => `<li>${esc(r.code)} ${esc(r.name)}：${esc(r.text)}</li>`).join('')}</ul></section>`;

    // 續抱摘要 → 持股分頁
    const hold = po.holding || [];
    const s = po.summary || {};
    h += `<section class="card support"><h2>續抱<span class="cnt">${hold.length}／${(po.params || {}).pool_max || 10} 檔</span></h2>
      ${hold.length ? hold.map(x => `<div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
        <span class="sub">${grp(x.group)}・停損 ${fmt(x.stop_now)}${x.group === '回檔站回' ? '（趨勢線）' : ''}・持有 ${x.days}${x.group === '回檔站回' ? '' : '/20'} 天</span></div>`).join('') : '<p class="empty">目前池內無持股</p>'}
      ${s.start ? `<p class="note">觀察池績效（${md(s.start)} 起）：已結算 ${s.closed} 筆，平均 ${pct(s.avg)}、勝率 ${s.hit == null ? '—' : s.hit + '%'}；累積 ${pct(s.cum)}（同期 0050 ${pct(s.bench)}）</p>` : ''}
      <div class="btnrow" style="margin-top:10px"><button type="button" class="btn" data-go="pool">看持股明細</button></div></section>`;

    // 技術面／籌碼／國際盤
    const sec = [['技術面', ma.tech], ['籌碼', ma.chips], ['國際盤與夜盤', ma.intl], ['今日觀察', ma.plan]].filter(([, a]) => a && a.length);
    if (sec.length) h += `<section class="card plain"><h2>大盤分析</h2>${sec.map(([t, a]) => `<details><summary>${t}</summary><ul class="lead">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`).join('')}</section>`;

    // 完整報告
    h += `<section class="card plain"><h2>完整報告</h2><div class="btnrow">
      <a class="btn primary" href="report.pdf" data-pdf="${esc((D.meta || {}).report_date || '')} 晨報">開啟今日 PDF（含 K 線圖）</a>
      <a class="btn" href="${WEB}" target="_blank" rel="noopener">晨報網頁版</a></div>
      ${(D.meta && D.meta.notes || []).length ? `<details style="margin-top:8px"><summary>備註<span class="am">${D.meta.notes.length} 則</span></summary><ul class="lead note">${D.meta.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}</section>`;
    el.innerHTML = h;
  }

  function pick(x) {
    const lotBig = x.lot && x.lot >= 1000000;
    return `<div class="pick">
      <div class="hd"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="tag g-${esc(x.group)}">${esc(x.group)}</span><span class="sub" style="color:var(--muted);font-size:.82rem">${esc(x.sector || '')}</span></div>
      <div class="kv">
        <div><span class="k">參考價（入選日收盤）</span><span class="v">${fmt(x.ref != null ? x.ref : x.entry)}</span></div>
        ${x.cap != null ? `<div><span class="k">可買入上限</span><span class="v cap">${fmt(x.cap)}</span></div>` : ''}
        <div><span class="k">停損${x.group === '回檔站回' ? '（趨勢線）' : ''}</span><span class="v stop">${fmt(x.stop_now)}</span></div>
      </div>
      <p class="lot">${x.cap != null ? '開盤高於上限就不追；' : ''}${x.lot ? `一張約 ${Math.round(x.lot / 10000)} 萬元${lotBig ? '，可考慮零股' : ''}` : ''}</p>
    </div>`;
  }
  function why(w) { return { stop: '跌破停損', hard: '虧損逾 10%', hold: '持有期滿', st: '跌破趨勢線', time: '持有期滿' }[w] || w || ''; }

  // ---------- 持股 ----------
  function renderPool() {
    const el = $('#tab-pool');
    const p = D.pool;
    if (!p) { el.innerHTML = '<p class="empty">尚無觀察池資料。</p>'; return; }
    const pos = p.positions || [], closed = (p.closed || []).slice().reverse();
    const s = (D.pool_out || {}).summary || {};
    let h = '';
    h += `<section class="card support"><h2>目前持股<span class="cnt">${pos.length}／${((D.pool_out || {}).params || {}).pool_max || 10} 檔</span></h2>
      ${pos.length ? pos.map(posrow).join('') : '<p class="empty">目前池內無持股</p>'}
      <p class="note">損益以資料日收盤計算。「回檔站回」停損是超級趨勢線，會隨股價上移、不設持有天數；其他組別維持原停損與 20 天上限。</p></section>`;

    const eq = p.equity || [];
    const last = eq.length ? (eq[eq.length - 1].eq - 1) * 100 : null;
    h += `<section class="card plain"><h2>觀察池績效<span class="cnt">${md(p.start)} 起</span></h2>
      <div class="stats">
        <div><span class="k">累積</span><span class="v ${cls(last)}">${pct(last)}</span></div>
        <div><span class="k">同期 0050</span><span class="v ${cls(s.bench)}">${pct(s.bench)}</span></div>
        <div><span class="k">已結算</span><span class="v">${closed.length} 筆</span></div>
        <div><span class="k">平均每筆</span><span class="v ${cls(s.avg)}">${pct(s.avg)}</span></div>
        <div><span class="k">勝率</span><span class="v">${s.hit == null ? '—' : s.hit + '%'}</span></div>
        <div><span class="k">停損出場</span><span class="v">${s.stop_rate == null ? '—' : s.stop_rate + '%'}</span></div>
      </div>${spark(eq)}</section>`;

    h += `<section class="card down"><h2>已結算<span class="cnt">${closed.length} 筆</span></h2>${closed.length ? closed.map(x => `
      <div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
      <span class="sub">${grp(x.group)}・${md(x.entry_date)} ${fmt(x.entry)} → ${md(x.exit_date)} ${fmt(x.exit)}・${x.days} 天・${esc(why(x.why))}</span></div>`).join('') : '<p class="empty">尚無結算</p>'}</section>`;
    el.innerHTML = h;
  }

  function posrow(x) {
    const pending = x.status === 'pending';
    const dist = x.stop_dist;
    const w = dist == null ? 0 : Math.max(2, Math.min(100, dist * 5));
    return `<div class="posrow">
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
    h += `<section class="card plain"><h2>歷史晨報<span class="cnt">保留最近 60 份</span></h2>
      ${arch.length ? `<ul class="arch">${arch.map((a, i) => `<li><a href="archive/${esc(a.file_date)}.pdf" data-pdf="${esc(a.report_date)} 晨報（資料日 ${esc(a.data_date)}）" data-date="${esc(a.file_date)}" ${i ? 'data-hist' : ''}>${esc(a.report_date)}</a>${i ? '' : '<span class="today">今日</span>'}<span class="am">資料日 ${esc(a.data_date)}・${a.n} 檔</span></li>`).join('')}</ul>` : '<p class="empty">尚無歸檔</p>'}
      <p class="note">點日期看當天 PDF。</p></section>`;

    // history.json 依日期分組（新到舊）
    const byDate = {};
    hist.forEach(x => { (byDate[x.date] = byDate[x.date] || []).push(x); });
    const dates = Object.keys(byDate).sort().reverse();
    h += `<section class="card plain"><h2>歷史入選<span class="cnt">${hist.length} 筆</span></h2>
      ${dates.map((d, i) => `<details ${i < 2 ? 'open' : ''}><summary>${md(d)}（資料日）<span class="am">${byDate[d].length} 檔</span></summary>
        ${byDate[d].map(x => `<div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num">${fmt(x.entry)}</span><span class="sub">${esc(x.sector || '')}・${grp(x.group)}${x.ver ? '・第 ' + x.ver + ' 版' : ''}</span></div>`).join('')}
      </details>`).join('')}</section>`;
    el.innerHTML = h;
  }

  // ---------- 測試（I1、趨勢延續） ----------
  function renderLab() {
    const el = $('#tab-lab');
    const i1 = D.i1, ext = D.ext;
    let h = `<p class="note" style="margin:0">這一頁是「只記錄、不納入觀察池」的測試名單，用來跟 W4 比成績，不是建議買的名單。</p>`;
    if (i1) {
      const st = i1.stats || {};
      const row = x => `<div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${x.ret != null ? pct(x.ret) : ''}</span>
        <span class="sub">${x.entry != null ? `進場 ${fmt(x.entry)}` : ''}${x.cap != null ? `・上限 ${fmt(x.cap)}` : ''}${x.stop_now != null ? `・停損 ${fmt(x.stop_now)}` : ''}${x.w != null ? `・權重 ${(x.w * 100).toFixed(0)}%` : ''}${x.days != null ? `・${x.days} 天` : ''}</span></div>`;
      h += `<section class="card i1"><h2>I1 測試名單<span class="cnt">評分選股＋移動停損</span></h2>
        <h3>今日新增${i1.bull === false ? '<span class="cnt">大盤非多頭，不新增</span>' : ''}</h3>${(i1.new || []).length ? i1.new.map(row).join('') : '<p class="empty">無</p>'}
        ${(i1.exits || []).length ? `<h3 style="margin-top:10px">今日出場</h3>${i1.exits.map(row).join('')}` : ''}
        <h3 style="margin-top:10px">模擬持股<span class="cnt">${(i1.holding || []).length} 檔</span></h3>${(i1.holding || []).length ? i1.holding.map(row).join('') : '<p class="empty">無</p>'}
        <div class="stats" style="margin-top:10px">
          <div><span class="k">累積</span><span class="v ${cls(st.cum)}">${pct(st.cum)}</span></div>
          <div><span class="k">同期 0050</span><span class="v ${cls(st.bench)}">${pct(st.bench)}</span></div>
          <div><span class="k">已結算</span><span class="v">${st.closed || 0} 筆</span></div></div>
        ${(i1.top || []).length ? `<details style="margin-top:8px"><summary>今日評分前 ${i1.top.length} 名</summary>${i1.top.map(t => `<div class="stock"><span class="code">${esc(t.code)}</span><span class="name">${esc(t.name)}</span><span class="num">${fmt(t.close)}</span><span class="sub">評分 ${t.score}・ADX ${t.adx}・120 日 ${pct(t.ret120, 1)}</span></div>`).join('')}</details>` : ''}
        ${i1.backtest ? `<p class="note">${esc(i1.backtest)}</p>` : ''}
        <p class="note">${md(st.start)} 起紙上追蹤一個月，之後再決定是否納入。</p></section>`;
    }
    if (ext) {
      const st = ext.stats || {};
      h += `<section class="card strong"><h2>趨勢延續觀察<span class="cnt">測試中</span></h2>
        ${(ext.list || []).length ? ext.list.map(x => `<div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num">${fmt(x.close)}</span><span class="sub">20 日 ${pct(x.mom20, 1)}・離月線 ${pct(x.ext20, 1)}・ADX ${x.adx}</span></div>`).join('') : '<p class="empty">今日無符合條件的股票</p>'}
        ${(ext.opens || []).length ? `<details style="margin-top:8px"><summary>模擬持有<span class="am">${ext.opens.length} 檔・平均 ${pct(st.open_avg)}</span></summary>${ext.opens.map(x => `<div class="stock"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span><span class="sub">${md(x.date)} 進場 ${fmt(x.entry)} → ${fmt(x.last)}・${x.days} 天</span></div>`).join('')}</details>` : ''}
        <p class="note">已結算 ${st.closed || 0} 筆、平均 ${pct(st.avg)}。${esc(ext.backtest || '')}</p></section>`;
    }
    if (!i1 && !ext) h += '<p class="empty">尚無測試資料。</p>';
    el.innerHTML = h;
  }

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
  go(['today', 'pool', 'history', 'lab'].includes(first) ? first : 'today', false);

  $('#refresh').addEventListener('click', () => { $('#refresh').disabled = true; load(true).finally(() => { $('#refresh').disabled = false; }); });

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
    if (standalone || localStorage.getItem('installtip') === 'no') return;
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

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(false); });

  load(false);
})();
