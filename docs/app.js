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
  const FILES = ['meta', 'market', 'market_analysis', 'pool_out', 'pool', 'history', 'archive', 'i1', 'ext', 'quotes', 'changelog'];

  async function load(force) {
    const res = await Promise.all(FILES.map(async f => {
      try {
        const r = await fetch(`data/${f}.json?t=${force ? Date.now() : Math.floor(Date.now() / 300000)}`, { cache: force ? 'reload' : 'default' });
        if (!r.ok) throw new Error(r.status);
        return [f, await r.json()];
      } catch (e) { return [f, null]; }
    }));
    res.forEach(([f, v]) => { D[f] = v; });
    render(); clBadge();
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
  // 今天的即時指數（證交所回的日期是今天才算）
  function liveIdx(k) {
    const q = D.quotes; if (!q || !q.index) return null;
    const x = q.index[k === 'TSE01' ? 't00' : 'o00']; if (!x || x.last == null || !x.date) return null;
    const t = tpeNow(); const today = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
    return x.date === today ? x : null;
  }
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
        const lq = liveIdx(k); // 盤中：改顯示即時指數與今日漲跌（約 5 秒延遲），收盤後回到資料日收盤
        const v = lq ? lq.last : x.close, c = lq ? lq.chg_pct : x.chg;
        return `<span data-k="${k}"><small>${esc(x.name.replace('指數', ''))}${x.state ? '・' + esc(x.state) : ''}${lq ? '<i class="lv">盤中</i>' : ''}</small><b>${fmt(v)}</b><em class="${cls(c)}">${pct(c)}</em></span>`;
      }).join('');
    } else box.hidden = true;
    const stale = $('#stale');
    const eve = (m.notes || []).find(n => /晚上版/.test(n));
    if (eve) {
      // 低調顯示：小字一行＋可關閉，關閉後同一則不再出現
      let dismissed = false; try { dismissed = localStorage.getItem('stale-dismissed') === eve; } catch (e) {}
      if (dismissed) stale.hidden = true;
      else { stale.hidden = false; stale.innerHTML = `<span>${esc(eve.replace(/^這是前一晚 /, '晚上版（').replace(/ 產出的晚上版，/, '產出），').replace(/。?$/, ''))}</span><button type="button" class="x" aria-label="關閉" data-dismiss-stale>×</button>`; }
      stale.onclick = e => { if (e.target.closest('[data-dismiss-stale]')) { stale.hidden = true; try { localStorage.setItem('stale-dismissed', eve); } catch (err) {} } };
    } else stale.hidden = true;
  }

  // ---------- 今日 ----------
  // ---------- 更新紀錄（data/changelog.json；看過的版本記在手機） ----------
  function clSeen() { try { return localStorage.getItem('cl-seen') || ''; } catch (e) { return ''; } }
  function clLatest() { const c = D.changelog; return c && c.entries && c.entries.length ? c.entries[0].ver : ''; }
  function clBadge() { const b = $('#clnew'); if (!b) return; const latest = clLatest(); b.hidden = !latest || clSeen() === latest; }
  function changelogSection() {
    const c = D.changelog; if (!c || !c.entries || !c.entries.length) return '';
    const latest = c.entries[0]; const unseen = clSeen() !== latest.ver;
    const entry = (e, open) => `<details class="clv" ${open ? 'open' : ''}><summary><b>v${esc(e.ver)}</b><span>${esc(e.title)}</span><small>${esc(e.date.slice(5).replace('-', '/'))}</small></summary><ul class="lead">${e.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`;
    return `<section class="sec plain changelog" id="changelog"><h2>更新紀錄<span class="cnt">v${esc(latest.ver)}${unseen ? '<i class="newdot"></i>' : ''}</span></h2><div class="body">
      ${entry(latest, true)}
      ${c.entries.length > 1 ? `<details class="clmore"><summary>更早的版本<span class="am">${c.entries.length - 1} 筆</span></summary>${c.entries.slice(1).map(e => entry(e, false)).join('')}</details>` : ''}
      <p class="note">app 會持續加功能；有新版本時左上角會出現綠點。</p></div></section>`;
  }
  document.addEventListener('click', e => {
    if (e.target.closest('#clnew')) { go('today'); const el = $('#changelog'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    if (e.target.closest('#changelog')) { try { localStorage.setItem('cl-seen', clLatest()); } catch (err) {} clBadge(); const dot = document.querySelector('#changelog .newdot'); if (dot) dot.remove(); }
  });
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
        <span class="sub">${grp(x.group)}・${exitStr(x.stop_now, x.entry)}・持有 ${x.days}${x.group === '回檔站回' ? '' : '/20'} 天</span></div>`).join('') : '<p class="empty">目前池內無持股</p>'}
      ${s.start ? `<p class="note">觀察池績效（${md(s.start)} 起）：已結算 ${s.closed} 筆，平均 ${pct(s.avg)}、勝率 ${s.hit == null ? '—' : s.hit + '%'}；累積 ${pct(s.cum)}（同期 0050 ${pct(s.bench)}）</p>` : ''}
      <div class="btnrow" style="margin-top:10px"><button type="button" class="btn" data-go="pool">看持股明細</button></div></div></section>`;

    const sec = [['技術面', ma.tech], ['籌碼', ma.chips], ['國際盤與夜盤', ma.intl], ['今日觀察', ma.plan]].filter(([, a]) => a && a.length);
    if (sec.length) h += `<section class="sec plain"><h2>大盤分析</h2><div class="body">${sec.map(([t, a]) => `<details><summary>${t}</summary><ul class="lead">${a.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>`).join('')}</div></section>`;

    h += `<section class="sec plain"><h2>完整報告</h2><div class="body"><div class="btnrow">
      <a class="btn primary" href="report.pdf" data-pdf="${esc((D.meta || {}).report_date || '')} 晨報">開啟今日 PDF（含 K 線圖）</a>
      <a class="btn" href="guide.pdf" data-pdf="晨報 App 使用說明">使用說明</a>
      <a class="btn" href="${WEB}" target="_blank" rel="noopener">晨報網頁版</a></div>
      ${(D.meta && D.meta.notes || []).length ? `<details style="margin-top:8px"><summary>備註<span class="am">${D.meta.notes.length} 則</span></summary><ul class="lead note">${D.meta.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}</div></section>`;
    h += changelogSection();
    el.innerHTML = h;
  }

  function pick(x) {
    const lotBig = x.lot && x.lot >= 1000000;
    return `<div class="pick" data-k="${esc(x.code)}">
      <div class="hd"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="tag g-${esc(x.group)}">${esc(x.group)}</span><span class="sub">${esc(x.sector || '')}</span></div>
      <div class="kv">
        <div><span class="k">參考價（入選日收盤）</span><span class="v">${fmt(x.ref != null ? x.ref : x.entry)}</span></div>
        ${x.cap != null ? `<div><span class="k">可買入上限</span><span class="v cap">${fmt(x.cap)}</span></div>` : ''}
        <div><span class="k">出場線${x.group === '回檔站回' ? '（趨勢線）' : ''}</span><span class="v stop">${fmt(x.stop_now)}${exitTag(x.stop_now, x.ref != null ? x.ref : x.entry) ? `<small>${exitTag(x.stop_now, x.ref != null ? x.ref : x.entry)}</small>` : ''}</span></div>
      </div>
      <p class="lot">${x.cap != null ? '開盤高於上限就不追；' : ''}${x.lot ? `一張約 ${Math.round(x.lot / 10000)} 萬元${lotBig ? '，可考慮零股' : ''}` : ''}<span class="hint">點一下看 K 線</span></p>
    </div>`;
  }
  // 出場線：超級趨勢線（會隨股價上移）；在進場價之上＝鎖利、之下＝停損
  function exitTag(stop, base) { if (stop == null || !base) return ''; const d = (stop / base - 1) * 100; return d >= 0 ? `鎖利 ${pct(d, 1)}` : `停損 ${pct(d, 1)}`; }
  function exitStr(stop, base, short) { if (stop == null) return ''; const t = exitTag(stop, base); return `出場線 ${fmt(stop)}${t && !short ? `（${t}）` : ''}`; }
  function why(w) { return { stop: '跌破出場線', hard: '強制停損（虧損逾 10%）', hold: '持有期滿', st: '跌破趨勢線', time: '持有期滿' }[w] || w || ''; }

  // ---------- 盤中（報價板） ----------
  function tpeNow() { return new Date(Date.now() + (new Date().getTimezoneOffset() + 480) * 60000); }
  const FORCE_LIVE = new URLSearchParams(location.search).get('live') === '1';
  function marketPhase() {
    if (FORCE_LIVE) return 'open';
    const t = tpeNow(), hm = t.getHours() * 60 + t.getMinutes(), wd = t.getDay();
    if (wd === 0 || wd === 6) return 'closed';
    if (hm < 9 * 60) return 'pre';
    if (hm <= 13 * 60 + 35) return 'open';
    return 'after';
  }
  const OPEN5 = new Set(); // 展開「五檔／分時」的卡片
  // ---------- 台北時鐘與開收盤倒數 ----------
  const HOLIDAYS = ['2026-10-26', '2026-12-25', '2027-01-01']; // 已知休市（補假／元旦）；其餘以週一到五計
  const pad2 = n => String(n).padStart(2, '0');
  function isTradingDay(d) { const wd = d.getDay(); if (wd === 0 || wd === 6) return false; const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; return !HOLIDAYS.includes(k); }
  function nextOpen(t) { const d = new Date(t); d.setHours(9, 0, 0, 0); if (d <= t || !isTradingDay(d)) { do { d.setDate(d.getDate() + 1); } while (!isTradingDay(d)); } return d; }
  function dur(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (d ? d + ' 天 ' : '') + `${pad2(h)}:${pad2(m)}:${pad2(ss)}`; }
  function tickClock() {
    const t = tpeNow(); const clk = $('#clk'), cd = $('#cd'); if (!clk) return;
    clk.innerHTML = `<span class="dt">${t.getFullYear()}/${pad2(t.getMonth() + 1)}/${pad2(t.getDate())}</span>${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())}`;
    const hm = t.getHours() * 60 + t.getMinutes();
    if (isTradingDay(t) && hm >= 9 * 60 && hm < 13 * 60 + 30) { const close = new Date(t); close.setHours(13, 30, 0, 0); cd.textContent = '距收盤 ' + dur(close - t); cd.className = 'on'; }
    else { const o = nextOpen(t); const same = o.toDateString() === t.toDateString(); cd.textContent = (same ? '距開盤 ' : (isTradingDay(t) && hm >= 13 * 60 + 30 ? '已收盤・距開盤 ' : '休市・距開盤 ')) + dur(o - t); cd.className = ''; }
  }
  tickClock(); setInterval(tickClock, 1000);

  // ---------- 台指期（近月；日盤 08:45–13:45、夜盤 15:00–05:00） ----------
  const FUT = { data: null, at: 0, ok: null };
  function futSession() { const t = tpeNow(), hm = t.getHours() * 60 + t.getMinutes(), wd = t.getDay(); const wk = wd >= 1 && wd <= 5; if (wk && hm >= 8 * 60 + 45 && hm <= 13 * 60 + 45) return 'day'; if ((wk && hm >= 15 * 60) || (hm < 5 * 60 && wd >= 2 && wd <= 6)) return 'night'; return null; }
  function futShow() { const s = futSession(); if (s) return s; const hm = tpeNow().getHours() * 60 + tpeNow().getMinutes(); return hm > 13 * 60 + 45 && hm < 15 * 60 ? 'day' : 'night'; }
  async function futPoll() {
    if (document.visibilityState !== 'visible') return;
    const s = futSession(); const every = s === 'day' ? 3000 : s === 'night' ? 10000 : 60000;
    if (Date.now() - FUT.at < every) return; FUT.at = Date.now();
    try { const r = await fetch(`${LIVE.url}/fut`, { cache: 'no-store' }); if (!r.ok) throw new Error(r.status); FUT.data = await r.json(); FUT.ok = true;
      if (s) { const f = FUT.data[s] && FUT.data[s].near; if (f && f.last != null && f.time) { const k = s === 'day' ? 'FUT' : 'FUTN'; const arr = LIVE.ticks[k] = LIVE.ticks[k] || []; if (!arr.length || arr[arr.length - 1][0] !== f.time) { arr.push([f.time, f.last, f.vol]); if (arr.length > 3000) arr.shift(); saveTicks(); } } } }
    catch (e) { FUT.ok = false; }
    if (!$('#tab-live').hidden) { const old = document.querySelector('.qc-fut'); const html = futCard(); const grid = document.querySelector('#tab-live .qgrid.idx'); if (old && html) { const t = document.createElement('div'); t.innerHTML = html; if (t.firstElementChild.outerHTML !== old.outerHTML) { old.replaceWith(t.firstElementChild); drawAllTL(t.firstElementChild); } } else if (!old && html && grid) { grid.insertAdjacentHTML('beforeend', html); drawAllTL(grid); } }
  }
  function futCard() {
    const d = FUT.data; if (!d) return '';
    const which = futShow(); const sess = d[which] || d.day || {}; const f = sess.near; if (!f || f.last == null) return '';
    const live = futSession() === which;
    const spot = (d.day && d.day.spot && d.day.spot.last) || null;
    const basis = spot != null ? f.last - spot : null;
    const c = cls(f.chg);
    const mon = (f.sym || '').match(/^TXF([A-L])(\d)/); const monName = mon ? `${'ABCDEFGHIJKL'.indexOf(mon[1]) + 1} 月` : '近月';
    return `<div class="qc ${c} qc-idx qc-fut" data-k="FUT">
      <div class="qh"><span class="qn">台指期 ${esc(monName)}</span><span class="tagx ${live ? 'on' : ''}">${which === 'day' ? '日盤' : '夜盤'}${live ? '' : '・收盤'}</span><span class="qt">${f.time ? esc(f.time) : ''}</span></div>
      <div class="qp"><b>${fmt(f.last, 0)}</b><span class="qd"><em>${sgn(f.chg, 0)}</em><em>${pct(f.pct)}</em></span></div>
      <div class="qg">
        <span><small>開</small>${fmt(f.open, 0)}</span><span><small>高</small>${fmt(f.high, 0)}</span><span><small>低</small>${fmt(f.low, 0)}</span><span><small>${which === 'day' ? '昨結' : '參考'}</small>${fmt(f.ref, 0)}</span>
        <span><small>買</small>${fmt(f.bid, 0)}</span><span><small>賣</small>${fmt(f.ask, 0)}</span><span><small>量</small>${fmt(f.vol, 0)}</span><span><small>價差</small>${basis == null ? '—' : `<i class="${cls(basis)}">${(basis > 0 ? '+' : '') + fmt(basis, 0)}</i>`}</span>
      </div>
      <div class="qx">${which === 'night' ? '夜盤 15:00–05:00，參考價為日盤結算；' : ''}價差＝期貨 − 加權現貨${spot ? `（${fmt(spot, 0)}）` : ''}，正值為正價差。</div>
      <button type="button" class="qfive" data-five="FUT" aria-expanded="${OPEN5.has('FUT')}">${OPEN5.has('FUT') ? '收合' : '分時走勢'}</button>
      ${OPEN5.has('FUT') ? `<div class="q5"><canvas class="tl" data-tl="${which === 'day' ? 'FUT' : 'FUTN'}" height="120"></canvas><div class="tlcap">${which === 'night' && LIVE.tlNightDate ? fmtD8(LIVE.tlNightDate) + ' ' : tlDayLabel()}${which === 'day' ? '日盤 08:45–13:45' : '夜盤 15:00–05:00'} 分時${(LIVE.ticks[which === 'day' ? 'FUT' : 'FUTN'] || []).length > 1 ? `（${LIVE.ticks[which === 'day' ? 'FUT' : 'FUTN'].length} 筆）` : '：伺服器每 1–2 分鐘自動累積'}</div></div>` : ''}
    </div>`;
  }
  setInterval(futPoll, 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { FUT.at = 0; futPoll(); } });
  function quoteCard(x, opts) {
    const o = opts || {};
    const last = x.last, chg = x.chg != null ? x.chg : (last != null && x.prev ? last - x.prev : null);
    const c = cls(chg);
    const big = o.index;
    const code = o.code || x.code;
    const open5 = OPEN5.has(code);
    const live = LIVE.ok && x.time;
    return `<div class="qc ${c} ${big ? 'qc-idx' : ''} ${open5 ? 'open5' : ''}" data-k="${esc(code)}">
      <div class="qh"><span class="qn">${esc(x.name)}</span><span class="qcode">${big ? '' : esc(x.code)}</span>${o.flag || ''}<span class="qt">${x.time ? esc(live ? x.time : x.time.slice(0, 5)) : ''}</span></div>
      <div class="qp"><b>${last == null ? '—' : fmtP(last)}${x.est ? '<i title="尚無成交，以買賣價估計">*</i>' : ''}</b><span class="qd"><em>${sgn(chg, big ? 2 : 2)}</em><em>${pct(x.chg_pct)}</em></span></div>
      <div class="qg">
        <span><small>開</small>${fmtP(x.open)}</span><span><small>高</small>${fmtP(x.high)}</span><span><small>低</small>${fmtP(x.low)}</span><span><small>昨收</small>${fmtP(x.prev)}</span>
        ${big ? `<span><small>振幅</small>${x.high != null && x.low != null && x.prev ? ((x.high - x.low) / x.prev * 100).toFixed(2) + '%' : '—'}</span>` : `<span><small>買</small>${fmtP(x.bid)}</span><span><small>賣</small>${fmtP(x.ask)}</span><span><small>量</small>${x.vol != null ? fmt(x.vol, 0) : '—'}</span>`}
      </div>
      ${o.ctx ? `<div class="qx">${o.ctx}</div>` : ''}
      <button type="button" class="qfive" data-five="${esc(code)}" aria-expanded="${open5}">${open5 ? '收合' : (big ? '分時走勢' : '五檔・分時')}</button>
      ${open5 ? fivePanel(x, code, big) : ''}
    </div>`;
  }
  function fivePanel(x, code, big) {
    let five = '';
    if (!big) {
      const b = x.bid5 || [], a = x.ask5 || [], bv = x.bidv5 || [], av = x.askv5 || [];
      if (b.length || a.length) {
        const mx = Math.max(1, ...bv, ...av);
        const row = (v, p, side) => `<div class="l5 ${side}"><span class="v" style="--w:${(v / mx * 100).toFixed(0)}%">${v != null ? fmt(v, 0) : ''}</span><span class="p">${p != null ? fmtP(p) : ''}</span></div>`;
        five = `<div class="five"><div class="col"><div class="hd">買進</div>${[0, 1, 2, 3, 4].map(i => row(bv[i], b[i], 'b')).join('')}</div><div class="col"><div class="hd">賣出</div>${[0, 1, 2, 3, 4].map(i => row(av[i], a[i], 'a')).join('')}</div></div>`;
      } else five = `<p class="note" style="margin:4px 0">${LIVE.ok ? '目前沒有五檔掛單資料' : '五檔掛單要連上即時報價才有（連線中…）'}</p>`;
    }
    return `<div class="q5">${five}<canvas class="tl" data-tl="${esc(code)}" height="120"></canvas><div class="tlcap">${LIVE.ticks[code] && LIVE.ticks[code].length > 1 ? `${tlDayLabel()}分時走勢（${LIVE.ticks[code].length} 筆）` : '分時走勢：開盤後每分鐘自動累積，開著 app 時每 3 秒一筆'}</div></div>`;
  }
  // 分時時間軸：股票 09:00–13:30；台指期日盤 08:45–13:45；夜盤 15:00–05:00（跨日，凌晨時間加 24 小時）
  const SESS = {
    stock: { tmin: 9 * 3600, tmax: 13.5 * 3600, grid: [9, 10, 11, 12, 13, 13.5].map(h => h * 3600), labels: [[9 * 3600, '9'], [10 * 3600, '10'], [11 * 3600, '11'], [12 * 3600, '12'], [13 * 3600, '13'], [13.5 * 3600, '13:30']] },
    futday: { tmin: 8.75 * 3600, tmax: 13.75 * 3600, grid: [8.75, 9, 10, 11, 12, 13, 13.75].map(h => h * 3600), labels: [[8.75 * 3600, '8:45'], [10 * 3600, '10'], [11 * 3600, '11'], [12 * 3600, '12'], [13 * 3600, '13'], [13.75 * 3600, '13:45']] },
    futnight: { tmin: 15 * 3600, tmax: 29 * 3600, wrap: true, grid: [15, 17, 19, 21, 23, 25, 27, 29].map(h => h * 3600), labels: [[15 * 3600, '15'], [17 * 3600, '17'], [19 * 3600, '19'], [21 * 3600, '21'], [23 * 3600, '23'], [25 * 3600, '1'], [27 * 3600, '3'], [29 * 3600, '5']] },
  };
  // 分時走勢：y 軸以昨收為基準
  function drawTL(cv) {
    const code = cv.dataset.tl; const wrap = cv.parentElement; const W = wrap.clientWidth - 2, H = 120;
    const dpr = Math.min(window.devicePixelRatio || 1, 3); cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
    const isFut = code === 'FUT' || code === 'FUTN';
    const item = isFut ? (FUT.data && FUT.data[code === 'FUT' ? 'day' : 'night'] && FUT.data[code === 'FUT' ? 'day' : 'night'].near) : code === 'TSE01' ? (D.quotes.index || {}).t00 : code === 'OTC01' ? (D.quotes.index || {}).o00 : (D.quotes.items || []).find(i => i.code === code);
    const ticks = (LIVE.ticks[code] || []).slice();
    if (!ticks.length && item && item.last != null && item.time) ticks.push([item.time, item.last]);
    const prev = item && (isFut ? item.ref : item.prev); if (!prev) return;
    const padL = 4, padR = 44, padT = 8, padB = 16, pw = W - padL - padR, ph = H - padT - padB;
    const S = SESS[code === 'FUT' ? 'futday' : code === 'FUTN' ? 'futnight' : 'stock'];
    const tmin = S.tmin, tmax = S.tmax;
    const sec = t => { const [h, m, s] = t.split(':').map(Number); let v = h * 3600 + m * 60 + (s || 0); if (S.wrap && v < 12 * 3600) v += 86400; return v; };
    let lo = prev, hi = prev; ticks.forEach(t => { lo = Math.min(lo, t[1]); hi = Math.max(hi, t[1]); });
    const span = Math.max(hi - prev, prev - lo, prev * 0.005); lo = prev - span * 1.05; hi = prev + span * 1.05;
    const x = t => padL + (Math.min(tmax, Math.max(tmin, sec(t))) - tmin) / (tmax - tmin) * pw, y = v => padT + (hi - v) / (hi - lo) * ph;
    ctx.clearRect(0, 0, W, H); ctx.font = '10px ' + css.getPropertyValue('--sans'); ctx.textBaseline = 'middle';
    ctx.strokeStyle = col('--line'); ctx.lineWidth = 1; S.grid.forEach(s => { const px = padL + (s - tmin) / (tmax - tmin) * pw; ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + ph); ctx.stroke(); });
    ctx.fillStyle = col('--muted'); ctx.textAlign = 'center'; ctx.textBaseline = 'top'; S.labels.forEach(([sv, t]) => ctx.fillText(t, Math.min(padL + pw - 10, Math.max(padL + 10, padL + (sv - tmin) / (tmax - tmin) * pw)), padT + ph + 3));
    ctx.setLineDash([3, 3]); ctx.strokeStyle = '#d4a017'; ctx.beginPath(); ctx.moveTo(padL, y(prev)); ctx.lineTo(padL + pw, y(prev)); ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#d4a017'; ctx.fillText(fmtP(prev), padL + pw + 3, y(prev));
    ctx.fillStyle = col('--up'); ctx.fillText('+' + (span / prev * 100).toFixed(1) + '%', padL + pw + 3, padT + 4); ctx.fillStyle = col('--down'); ctx.fillText('-' + (span / prev * 100).toFixed(1) + '%', padL + pw + 3, padT + ph - 4);
    if (!ticks.length) return;
    const last = ticks[ticks.length - 1][1]; const color = last >= prev ? col('--up') : col('--down');
    ctx.beginPath(); ticks.forEach((t, i) => { const px = x(t[0]), py = y(t[1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    const lx = x(ticks[ticks.length - 1][0]);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(lx, y(prev)); ctx.lineTo(x(ticks[0][0]), y(prev)); ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1;
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx, y(last), 2.5, 0, Math.PI * 2); ctx.fill();
  }
  function drawAllTL(root) { (root || document).querySelectorAll('canvas.tl').forEach(drawTL); }
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
    h += `<div class="lstat">${statLine(q, phase)}</div>`;
    h += notifyCard();
    const idx = q.index || {};
    const ik = [['t00', 'TSE01'], ['o00', 'OTC01']].filter(([k]) => idx[k]);
    if (ik.length) h += `<div class="qgrid idx">${ik.map(([k, code]) => quoteCard(idx[k], { index: true, code })).join('')}${futCard()}</div>`;
    const groups = LGROUPS;
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
    drawAllTL(el);
  }
  const LGROUPS = [['new', '今日新增', 'w4'], ['pool', '觀察池持股', 'support'], ['exit', '今日出場', 'down'], ['i1new', 'I1 今日新增（測試）', 'i1'], ['i1', 'I1 模擬持股（測試）', 'i1'], ['ext', '趨勢延續觀察（測試）', 'strong']];
  function statLine(q, phase) {
    const live = q.market_open && phase === 'open';
    if (LIVE.ok && phase === 'open') return `<span class="dot on"></span>即時・${esc(LIVE.at || '')}<small>證交所即時，每 ${LIVE.every / 1000} 秒更新</small>`;
    const note = LIVE.ok === false ? (phase === 'open' ? '即時連線失敗，改用 5 分鐘一次的報價' : '即時連線失敗，開盤後改用 5 分鐘報價') : LIVE.ok ? '即時連線正常，開盤後每 3 秒更新' : '證交所報價，延遲約 5–10 分鐘';
    return `<span class="dot ${live ? 'on' : ''}"></span>${live ? `盤中・${esc(q.updated.slice(11))} 更新` : q.market_open ? `${esc(fmtD8(q.data_date))} 收盤` : `最近收盤 ${esc(fmtD8(q.data_date))}`}<small>${note}</small>`;
  }
  // 只換掉有變化的卡片（不整頁重畫，避免搜尋框失焦、畫面跳動）
  function patchLive() {
    const el = $('#tab-live'); const q = D.quotes; if (!q || !q.items) return;
    const st = el.querySelector('.lstat'); if (st) st.innerHTML = statLine(q, marketPhase());
    const nc = el.querySelector('.notify'); if (nc) { const t = document.createElement('div'); t.innerHTML = notifyCard(); if (t.firstElementChild && t.firstElementChild.outerHTML !== nc.outerHTML) nc.replaceWith(t.firstElementChild); }
    const put = (code, html) => { const old = el.querySelector(`.qc[data-k="${code}"]`); if (!old) return; if (old.outerHTML === html) return; const t = document.createElement('div'); t.innerHTML = html; const nu = t.firstElementChild; old.replaceWith(nu); drawAllTL(nu); };
    const idx = q.index || {};
    if (idx.t00) put('TSE01', quoteCard(idx.t00, { index: true, code: 'TSE01' }));
    if (idx.o00) put('OTC01', quoteCard(idx.o00, { index: true, code: 'OTC01' }));
    { const fh = futCard(); const grid = el.querySelector('.qgrid.idx'); if (fh && grid && !grid.querySelector('.qc-fut')) { grid.insertAdjacentHTML('beforeend', fh); drawAllTL(grid); } }
    q.items.forEach(x => { const k = LGROUPS.map(g => g[0]).find(k => x.kinds.includes(k) || (k === 'ext' && x.kinds.includes('extopen'))); if (!k) return; const { ctx, flag } = ctxFor(x, k); put(x.code, quoteCard(x, { ctx, flag })); });
  }
  // 五檔／分時展開
  document.addEventListener('click', e => {
    let b = e.target.closest('[data-five]');
    if (!b) { const fc = e.target.closest('.qc-fut'); if (fc && !e.target.closest('canvas')) b = fc.querySelector('[data-five="FUT"]'); } // 台指期字卡：點整張卡也能開合分時
    if (!b) return;
    e.stopPropagation(); const code = b.dataset.five;
    if (OPEN5.has(code)) OPEN5.delete(code); else OPEN5.add(code);
    if (code === 'FUT') { const old = b.closest('.qc'); const html = futCard(); if (old && html) { const t = document.createElement('div'); t.innerHTML = html; old.replaceWith(t.firstElementChild); drawAllTL(t.firstElementChild); } return; }
    const q = D.quotes || {}; const x = code === 'TSE01' ? (q.index || {}).t00 : code === 'OTC01' ? (q.index || {}).o00 : (q.items || []).find(i => i.code === code);
    if (!x) return;
    const card = b.closest('.qc'); const kind = code === 'TSE01' || code === 'OTC01' ? null : LGROUPS.map(g => g[0]).find(k => x.kinds.includes(k) || (k === 'ext' && x.kinds.includes('extopen')));
    const o = kind ? ctxFor(x, kind) : {}; const html = quoteCard(x, kind ? { ctx: o.ctx, flag: o.flag } : { index: true, code });
    const t = document.createElement('div'); t.innerHTML = html; const nu = t.firstElementChild; card.replaceWith(nu); drawAllTL(nu);
  }, true);

  // ---------- 即時報價（Cloudflare Worker 中繼證交所報價，交易時段每 3 秒） ----------
  const LIVE = { url: 'https://tw-quotes.nickchen358.workers.dev', every: 3000, ok: null, at: '', ticks: {}, busy: false, timer: null, uni: null };
  async function universe() { if (LIVE.uni) return LIVE.uni; try { LIVE.uni = await getJSON('data/universe.json'); } catch (e) { LIVE.uni = {}; } return LIVE.uni; }
  function liveCodes() {
    const q = D.quotes || {}; const set = new Set(['TSE01', 'OTC01']);
    (q.items || []).forEach(x => set.add(x.code));
    if (K.code && !$('#chart').hidden) set.add(K.code);
    return [...set];
  }
  function tlDayLabel() { const today = tlKey().slice(3); return LIVE.tlDate && LIVE.tlDate !== today ? fmtD8(LIVE.tlDate) + ' ' : ''; }
  function tlKey() { const t = tpeNow(); return `tl-${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`; }
  function loadTicks() { try { const raw = localStorage.getItem(tlKey()); if (raw) LIVE.ticks = JSON.parse(raw) || {}; Object.keys(localStorage).forEach(k => { if (k.startsWith('tl-') && k !== tlKey()) localStorage.removeItem(k); }); } catch (e) {} }
  let tlSaved = 0;
  function saveTicks() { if (LIVE.tlDay && LIVE.tlDay !== tlKey().slice(3)) return; const now = Date.now(); if (now - tlSaved < 15000) return; tlSaved = now; try { localStorage.setItem(tlKey(), JSON.stringify(LIVE.ticks)); } catch (e) {} }
  let liveLast = 0;
  async function livePoll(force) {
    if (LIVE.busy || document.visibilityState !== 'visible') return;
    const open = marketPhase() === 'open';
    if (!open && !force && Date.now() - liveLast < 60000) return; // 非交易時段每 60 秒確認一次（看得到收盤五檔、確認連線）
    const q = D.quotes; if (!q) return;
    liveLast = Date.now();
    LIVE.busy = true;
    try {
      const uni = await universe();
      const codes = liveCodes(); const otc = codes.filter(c => uni[c] && uni[c].ex === 'otc');
      const r = await fetch(`${LIVE.url}/q?codes=${codes.join(',')}${otc.length ? '&otc=' + otc.join(',') : ''}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json(); if (!j.items) throw new Error('bad');
      q.index = q.index || {}; q.items = q.items || [];
      j.items.forEach(it => {
        if (!it.code || it.last == null) return;
        const tgt = it.code === 'TSE01' ? (q.index.t00 = q.index.t00 || { code: 't00', name: '加權指數' }) : it.code === 'OTC01' ? (q.index.o00 = q.index.o00 || { code: 'o00', name: '櫃買指數' }) : (q.items.find(x => x.code === it.code) || (q.items.push({ code: it.code, name: it.name, kinds: [] }), q.items[q.items.length - 1]));
        Object.assign(tgt, { last: it.last, est: it.est, chg: it.chg, chg_pct: it.pct, open: it.open, high: it.high, low: it.low, prev: it.prev, vol: it.vol, bid: it.bid[0] != null ? it.bid[0] : null, ask: it.ask[0] != null ? it.ask[0] : null, bid5: it.bid, ask5: it.ask, bidv5: it.bidv, askv5: it.askv, date: it.date, time: it.time });
        if (it.name && !tgt.name) tgt.name = it.name;
        if (open && it.time && !it.est) { const arr = LIVE.ticks[it.code] = LIVE.ticks[it.code] || []; const lastT = arr.length ? arr[arr.length - 1] : null; if (!lastT || lastT[0] !== it.time) { arr.push([it.time, it.last, it.vol]); if (arr.length > 2000) arr.shift(); } }
      });
      const t = tpeNow(); LIVE.at = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
      q.data_date = (j.items.find(i => i.date) || {}).date || q.data_date;
      if (open) { q.market_open = true; q.updated = `${tpeNow().toISOString().slice(0, 10)} ${LIVE.at}`; }
      LIVE.ok = true; if (LIVE.tlDay && LIVE.tlDay !== tlWantDay()) loadServerTicks(); saveTicks();
      if (!$('#tab-live').hidden) patchLive();
      patchPool(); renderHeader();
      if (!$('#chart').hidden) drawChart();
    } catch (e) {
      if (LIVE.ok !== false) { LIVE.ok = false; if (!$('#tab-live').hidden) patchLive(); }
    } finally { LIVE.busy = false; }
  }
  loadTicks();
  // 伺服器端每分鐘累積的整天分時（Worker Cron → KV）：打開 app 就先載回來，之後本機 3 秒一筆接著畫
  let tlServerDay = null;
  // 顯示哪一天的分時：交易時段＝今天（本機 3 秒累積＋伺服器 1 分鐘）；非交易時段＝最近一個交易日（伺服器）
  // 交易日 08:00 起清掉前一天的分時、改顯示今天（開盤前是空的，台指期夜盤仍顯示昨晚到 08:45 換日盤）；其他時間顯示最近一個交易日
  function tlWantDay() { const t = tpeNow(); const hm = t.getHours() * 60 + t.getMinutes(); return (FORCE_LIVE || (isTradingDay(t) && hm >= 8 * 60)) ? tlKey().slice(3) : 'last'; }
  async function loadServerTicks() {
    const want = tlWantDay();
    if (LIVE.tlDay && LIVE.tlDay !== want && !(want === 'last' && LIVE.tlDay === LIVE.tlDate)) { LIVE.ticks = {}; LIVE.tlLoaded = new Set(); tlServerDay = null; } // 換天／換模式：清掉本機的
    if (tlServerDay !== want) LIVE.tlLoaded = new Set();
    if (tlServerDay === want && liveCodes().every(c => LIVE.tlLoaded && LIVE.tlLoaded.has(c))) return;
    try {
      const codes = liveCodes().concat(['FUT', 'FUTN']);
      let j = null;
      try { const r = await fetch(`${LIVE.url}/tl?date=${want}&codes=${codes.join(',')}`, { cache: 'no-store' }); if (r.ok) j = await r.json(); } catch (e) {}
      const hasTicks = o => !!o && Object.keys(o).some(k => !k.startsWith('_') && Array.isArray(o[k]) && o[k].length);
      if (want === 'last' && !hasTicks(j)) { // Worker 還沒累積到資料（或連不上）：改用隨網頁發布的靜態備份
        try { const r = await fetch('data/tl/last.json', { cache: 'no-store' }); if (r.ok) { const s = await r.json(); if (hasTicks(s)) j = s; } } catch (e) {}
      }
      if (!j) return;
      tlServerDay = want; LIVE.tlDay = want; LIVE.tlDate = j._date || null; LIVE.tlNightDate = j._nightDate || null; (LIVE.tlLoaded = LIVE.tlLoaded || new Set()); codes.forEach(c => LIVE.tlLoaded.add(c));
      Object.keys(j).filter(k => !k.startsWith('_')).forEach(code => { const m = new Map(); (LIVE.ticks[code] || []).forEach(t => m.set(t[0], t)); (j[code] || []).forEach(t => { if (!m.has(t[0])) m.set(t[0], t); }); const key = t => (code === 'FUTN' && t < '12') ? '2' + t : '1' + t; LIVE.ticks[code] = [...m.values()].sort((a, b) => key(a[0]) < key(b[0]) ? -1 : 1); }); // 夜盤跨午夜：凌晨排在後面
      tlSaved = 0; saveTicks();
      if (!$('#tab-live').hidden) drawAllTL($('#tab-live'));
      if (!$('#chart').hidden && K.period === 'T') drawChart();
    } catch (e) {}
  }
  setTimeout(loadServerTicks, 800);
  // 台指期分時：伺服器每 1–2 分鐘累積一筆，app 開著時每 60 秒把伺服器的補進來（本機 3／10 秒一筆只在 app 開著時才有，夜盤常是零星幾筆）
  function mergeTicks(code, rows) { const m = new Map(); (LIVE.ticks[code] || []).forEach(t => m.set(t[0], t)); (rows || []).forEach(t => { if (!m.has(t[0])) m.set(t[0], t); }); const key = t => (code === 'FUTN' && t < '12') ? '2' + t : '1' + t; LIVE.ticks[code] = [...m.values()].sort((a, b) => key(a[0]) < key(b[0]) ? -1 : 1); }
  async function refreshFutTicks() {
    if (document.visibilityState !== 'visible' || !futSession()) return;
    try {
      const r = await fetch(`${LIVE.url}/tl?date=${tlWantDay()}&codes=FUT,FUTN`, { cache: 'no-store' }); if (!r.ok) return; const j = await r.json();
      let changed = false; ['FUT', 'FUTN'].forEach(c => { if (Array.isArray(j[c]) && j[c].length) { const n0 = (LIVE.ticks[c] || []).length; mergeTicks(c, j[c]); if ((LIVE.ticks[c] || []).length !== n0) changed = true; } });
      if (j._nightDate) LIVE.tlNightDate = j._nightDate;
      if (changed) { saveTicks(); if (!$('#tab-live').hidden) { const old = document.querySelector('.qc-fut'); if (old) drawAllTL(old); } if (!$('#chart').hidden && K.period === 'T') drawChart(); }
    } catch (e) {}
  }
  setInterval(refreshFutTicks, 60000); setTimeout(refreshFutTicks, 3000);
  setInterval(() => { if (document.visibilityState === 'visible') loadServerTicks(); }, 120000); // 盤中每 2 分鐘補一次（別台裝置開著時也能同步）
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { tlServerDay = null; loadServerTicks(); } });
  setInterval(livePoll, LIVE.every);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') livePoll(true); });
  setTimeout(() => livePoll(true), 1500);
  setTimeout(() => { FUT.at = 0; futPoll(); }, 1200);
  // ---------- 推播通知（Web Push；訂閱資料存在 Worker 的 KV） ----------
  const PUSH = { prefs: { stop: true, buy: true, close: true, morning: true }, state: 'unknown', msg: '' };
  try { const p = JSON.parse(localStorage.getItem('push-prefs') || 'null'); if (p) Object.assign(PUSH.prefs, p); } catch (e) {}
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent);
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  async function swReg(ms) { const reg = await Promise.race([navigator.serviceWorker.ready, new Promise(r => setTimeout(() => r(null), ms || 4000))]); return reg || (await navigator.serviceWorker.getRegistration()); }
  async function pushSub() { try { const reg = await swReg(); return reg ? await reg.pushManager.getSubscription() : null; } catch (e) { return null; } }
  async function pushInit() {
    if (!pushSupported()) { PUSH.state = isIOS() && !standalone() ? 'needinstall' : 'unsupported'; return; }
    if (Notification.permission === 'denied') { PUSH.state = 'denied'; return; }
    const sub = await pushSub();
    PUSH.state = sub ? 'on' : 'off';
    if (sub) { try { const k = 'push-synced'; const today = tlKey().slice(3); if (localStorage.getItem(k) !== today) { await pushSend('/sub', { sub: sub.toJSON(), prefs: PUSH.prefs }); localStorage.setItem(k, today); } } catch (e) {} }
  }
  async function pushSend(path, body) { const r = await fetch(LIVE.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.status); return j; }
  function u8(b64) { const s = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'); const raw = atob(s); return Uint8Array.from(raw, c => c.charCodeAt(0)); }
  async function pushEnable() {
    PUSH.msg = ''; 
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { PUSH.state = perm === 'denied' ? 'denied' : 'off'; PUSH.msg = '沒有取得通知權限。'; return; }
      const reg = await swReg(8000); if (!reg) throw new Error('離線快取尚未就緒，請重新整理後再試');
      const { publicKey } = await (await fetch(LIVE.url + '/vapid')).json();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: u8(publicKey) });
      await pushSend('/sub', { sub: sub.toJSON(), prefs: PUSH.prefs });
      try { localStorage.setItem('push-synced', tlKey().slice(3)); } catch (e) {}
      PUSH.state = 'on'; PUSH.msg = '已開啟。按「測試」確認手機收得到。';
    } catch (e) { PUSH.msg = '開啟失敗：' + (e.message || e); }
  }
  async function pushDisable() {
    try { const sub = await pushSub(); if (sub) { await pushSend('/unsub', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); } } catch (e) {}
    PUSH.state = 'off'; PUSH.msg = '已關閉。';
  }
  async function pushTest() { try { const sub = await pushSub(); if (!sub) throw new Error('尚未開啟'); await pushSend('/test', { endpoint: sub.endpoint }); PUSH.msg = '已送出測試通知，幾秒內應該會跳出來。'; } catch (e) { PUSH.msg = '測試失敗：' + (e.message || e); } }
  async function pushPrefs(k, v) { PUSH.prefs[k] = v; try { localStorage.setItem('push-prefs', JSON.stringify(PUSH.prefs)); } catch (e) {} const sub = await pushSub(); if (sub) pushSend('/sub', { sub: sub.toJSON(), prefs: PUSH.prefs }).catch(() => {}); }
  function notifyCard() {
    const st = PUSH.state;
    const row = (k, label, desc) => `<label class="pref"><input type="checkbox" data-pref="${k}" ${PUSH.prefs[k] ? 'checked' : ''}><span><b>${label}</b><small>${desc}</small></span></label>`;
    let body = '';
    if (st === 'needinstall') body = `<p class="note">iPhone 要先把 app 加到主畫面（Safari 分享鈕 → 加入主畫面），再從主畫面打開才能開啟通知。</p>`;
    else if (st === 'unsupported') body = `<p class="note">這個瀏覽器不支援推播通知。</p>`;
    else if (st === 'denied') body = `<p class="note">通知權限被拒絕了。到手機「設定 → 通知 → 選股晨報」打開後，重新開啟 app。</p>`;
    else if (st === 'unknown') body = `<p class="note">檢查中…</p>`;
    else body = `<div class="prefs">${row('stop', '出場線提醒', '持股跌破或接近出場線（2% 內）；出場線＝超級趨勢線，在進場價上方時是鎖利')}${row('buy', '可買提醒', '今日新增股回到可買入上限以下／開盤超過上限')}${row('close', '收盤摘要', '13:31 加權、持股與新增股的狀態')}${row('morning', '晨報出刊', '早上晨報產出時通知')}</div>
      <div class="btnrow">${st === 'on' ? `<button type="button" class="btn" data-push="test">測試</button><button type="button" class="btn ghost" data-push="off">關閉通知</button>` : `<button type="button" class="btn" data-push="on">開啟通知</button>`}</div>`;
    return `<details class="notify sec plain" ${(st !== 'on' && st !== 'unknown') || PUSH.msg ? 'open' : ''}><summary><h2>盤中提醒 <span class="cnt">${st === 'on' ? '已開啟' : st === 'off' ? '未開啟' : ''}</span></h2></summary><div class="body">${body}${PUSH.msg ? `<p class="note pmsg">${esc(PUSH.msg)}</p>` : ''}<p class="note">通知由伺服器每分鐘依證交所報價判斷，不用開著 app；每檔每天同一種提醒只送一次。技術面提醒，不是買賣指令。</p></div></details>`;
  }
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-push]'); if (!b) return;
    e.preventDefault(); b.disabled = true;
    if (b.dataset.push === 'on') await pushEnable(); else if (b.dataset.push === 'off') await pushDisable(); else await pushTest();
    patchLive();
  });
  document.addEventListener('change', e => { const c = e.target.closest('[data-pref]'); if (c) pushPrefs(c.dataset.pref, c.checked); });
  pushInit().then(() => { if (!$('#tab-live').hidden && D.quotes) patchLive(); });
  function ctxFor(x, kind) {
      const last = x.last; let ctx = '', flag = '';
      if (kind === 'new' || kind === 'i1new') {
        const cap = x[kind + '_cap'], stop = x[kind + '_stop'];
        if (cap != null && last != null) {
          const d = (last / cap - 1) * 100;
          if (last <= cap) { ctx = `上限 ${fmt(cap)}・低 ${pct(-d, 1).replace('+', '')}`; flag = '<span class="lflag ok">可買</span>'; }
          else { ctx = `上限 ${fmt(cap)}・高 ${pct(d, 1)}`; flag = '<span class="lflag over">超過上限</span>'; }
        } else if (cap != null) ctx = `上限 ${fmt(cap)}`;
        if (stop != null) ctx += `<i>出場線 ${fmt(stop)}</i>`;
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
          ctx += `<i>出場線 ${fmt(stop)}（距 ${pct(d, 1)}${entry != null ? '・' + exitTag(stop, entry) : ''}）</i>`;
          if (last < stop) flag = '<span class="lflag over">跌破出場線</span>';
          else if (d < 2) flag = '<span class="lflag warn">接近出場線</span>';
        }
      }
      return { ctx, flag };
  }
  function fmtD8(d) { return d && d.length === 8 ? `${+d.slice(4, 6)}/${+d.slice(6)}` : (d || ''); }
  function searchBox() {
    return `<section class="sec plain"><h2>查任一檔 K 線</h2><div class="body"><div class="search"><input id="ksearch" type="search" inputmode="search" placeholder="輸入代號或名稱，例如 2330、台積電 或 0056" autocomplete="off"><div id="kresult" class="kresult" hidden></div></div><p class="note">涵蓋晨報股票池（台灣50、中型100、櫃買權值）、規模前 50 大 ETF（含債券與主動式，只供查價，不會被晨報選入）與加權、櫃買指數，2016 年起的日／週／月／年 K。</p></div></section>`;
  }
  // 自動更新：交易時段每 60 秒重抓 quotes.json
  setInterval(() => {
    if (document.visibilityState !== 'visible' || marketPhase() !== 'open' || LIVE.ok) return;
    fetch(`data/quotes.json?t=${Date.now()}`, { cache: 'reload' }).then(r => r.ok ? r.json() : null).then(j => { if (j && JSON.stringify(j) !== JSON.stringify(D.quotes)) { D.quotes = j; renderLive(); if (!$('#chart').hidden) drawChart(); } }).catch(() => {});
  }, 60000);

  // 搜尋（股票池清單從 kl/index.json 取）
  let KL = null;
  async function klIndex() {
    if (KL) return KL;
    try { const r = await fetch(`data/kl/index.json?t=${Math.floor(Date.now() / 300000)}`); KL = r.ok ? (await r.json()).items : []; } catch (e) { KL = []; } // 帶 5 分鐘一變的 query，避免瀏覽器 HTTP 快取拿到舊清單（10/29 加 ETF 後搜不到）
    return KL;
  }
  document.addEventListener('input', async e => {
    if (e.target.id !== 'ksearch') return;
    const q = e.target.value.trim().toLowerCase(), box = $('#kresult');
    if (!q) { box.hidden = true; return; }
    const list = (await klIndex()).filter(x => x.code.toLowerCase().includes(q) || (x.name || '').toLowerCase().includes(q)).slice(0, 8);
    box.hidden = false;
    box.innerHTML = list.length ? list.map(x => `<button type="button" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span>${esc(x.name)}${/^0\d{2,4}[A-Z]?$/.test(x.code) ? '<i class="tag-etf">ETF</i>' : ''}</button>`).join('') : '<p class="empty">找不到，這檔不在晨報股票池與前 50 大 ETF 裡。</p>';
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
      <p class="note pool-note">${poolNote()}</p></div></section>`;
    const eq = p.equity || [];
    const last = eq.length ? (eq[eq.length - 1].eq - 1) * 100 : null;
    h += `<section class="sec plain"><h2>觀察池績效<span class="cnt">${md(p.start)} 起</span></h2><div class="body">
      <div class="stats">
        <div><span class="k">累積</span><span class="v ${cls(last)}">${pct(last)}</span></div>
        <div><span class="k">同期 0050</span><span class="v ${cls(s.bench)}">${pct(s.bench)}</span></div>
        <div><span class="k">已結算</span><span class="v">${closed.length} 筆</span></div>
        <div><span class="k">平均每筆</span><span class="v ${cls(s.avg)}">${pct(s.avg)}</span></div>
        <div><span class="k">勝率</span><span class="v">${s.hit == null ? '—' : s.hit + '%'}</span></div>
        <div><span class="k">跌破出場線</span><span class="v">${s.stop_rate == null ? '—' : s.stop_rate + '%'}</span></div>
      </div>${spark(eq)}</div></section>`;
    h += `<section class="sec down"><h2>已結算<span class="cnt">${closed.length} 筆</span></h2><div class="body">${closed.length ? closed.map(x => `
      <div class="stock" data-k="${esc(x.code)}"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span><span class="num ${cls(x.ret)}">${pct(x.ret)}</span>
      <span class="sub">${grp(x.group)}・${md(x.entry_date)} ${fmt(x.entry)} → ${md(x.exit_date)} ${fmt(x.exit)}・${x.days} 天・${esc(why(x.why))}</span></div>`).join('') : '<p class="empty">尚無結算</p>'}</div></section>`;
    el.innerHTML = h;
  }
  // 今天的即時報價（只在交易日、證交所回的是今天的成交時才算；開盤前與休市日回 null，改用資料日收盤）
  function liveQ(code) {
    const q = D.quotes; if (!q || !q.items) return null;
    const x = q.items.find(i => i.code === code); if (!x || x.last == null || !x.date) return null;
    const t = tpeNow(); const today = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`;
    return x.date === today ? x : null;
  }
  function posrow(x) {
    const pending = x.status === 'pending';
    const lq = liveQ(x.code);
    const last = lq ? lq.last : x.last;
    const ret = lq && x.entry ? (last / x.entry - 1) * 100 : x.ret;
    const dist = lq && x.stop_now ? (last / x.stop_now - 1) * 100 : x.stop_dist;
    const day = lq && lq.chg_pct != null ? `<span class="${cls(lq.chg_pct)}">今日 ${pct(lq.chg_pct, 1)}</span>` : '';
    const w = dist == null ? 0 : Math.max(2, Math.min(100, dist * 5));
    const capTag = pending && lq && x.cap != null ? (last <= x.cap ? '<span class="ok">在上限內</span>' : '<span class="warn">超過上限</span>') : '';
    return `<div class="posrow" data-k="${esc(x.code)}">
      <div class="hd"><span class="code">${esc(x.code)}</span><span class="name">${esc(x.name)}</span>${pending ? '<span class="pend">今日可買</span>' : ''}<span class="ret ${cls(ret)}">${pending ? '' : pct(ret)}</span></div>
      <div class="meta"><span>${grp(x.group)}・${esc(x.sector || '')}</span>
        <span>${md(x.entry_date)} 入選</span>
        <span>${pending ? `參考 <b>${fmt(x.ref)}</b>・上限 <b>${fmt(x.cap)}</b>${lq ? `・現價 <b>${fmt(last)}</b> ${capTag}` : ''}` : `進場 <b>${fmt(x.entry)}</b> → 現價 <b>${fmt(last)}</b>${lq ? '<span class="lv">盤中</span>' : ''}`} ${day}</span>
        <span>出場線 <b>${fmt(x.stop_now)}</b>${dist != null ? `（距 ${pct(dist, 1)}${!pending && x.entry ? '・' + exitTag(x.stop_now, x.entry) : ''}）` : ''}</span>
        <span>持有 ${x.days}${x.group === '回檔站回' ? '' : '/20'} 天</span></div>
      <div class="bar ${dist != null && dist < 2 ? 'tight' : ''}" title="距出場線 ${pct(dist, 1)}"><i style="width:${w}%"></i></div>
    </div>`;
  }
  // 盤中每次拿到新報價就把持股列換成最新值（只換列，不重畫整頁，捲動位置不動）
  function patchPool() {
    const el = $('#tab-pool'); if (!el || el.hidden || !D.pool) return;
    (D.pool.positions || []).forEach(x => { const old = el.querySelector(`.posrow[data-k="${x.code}"]`); if (!old) return; const t = document.createElement('div'); t.innerHTML = posrow(x); old.replaceWith(t.firstElementChild); });
    const n = el.querySelector('.pool-note'); if (n) n.textContent = poolNote();
  }
  function poolNote() { return (D.quotes && D.quotes.market_open && marketPhase() === 'open' ? '盤中損益以即時報價計算（約 5 秒延遲），收盤後改為收盤價。' : '損益以資料日收盤計算。') + '「出場線」是超級趨勢線，會隨股價上移、不設持有天數——在進場價之上時是鎖住獲利的移動停利，之下才是停損；另有虧損逾 10% 的強制停損。其他組別維持原停損與 20 天上限。'; }
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
        <span class="sub">${x.entry != null ? `進場 ${fmt(x.entry)}` : ''}${x.cap != null ? `・上限 ${fmt(x.cap)}` : ''}${x.stop_now != null ? `・出場線 ${fmt(x.stop_now)}` : ''}${x.w != null ? `・權重 ${(x.w * 100).toFixed(0)}%` : ''}${x.days != null ? `・${x.days} 天` : ''}</span></div>`;
      h += `<section class="sec i1"><h2>I1 測試名單<span class="cnt">評分選股＋移動出場線</span></h2><div class="body">
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
  const PERIODS = { T: { label: '分時', n: 90, mas: [5, 20, 60] }, D: { label: '日', n: 90, mas: [5, 20, 60] }, A: { label: '還原日', n: 90, mas: [5, 20, 60] }, W: { label: '週', n: 80, mas: [5, 20, 60] }, M: { label: '月', n: 60, mas: [5, 20, 60] }, Y: { label: '年', n: 12, mas: [3, 5, 10] } };
  const K = { cache: {}, cacheL: {}, code: null, period: 'D', n: 90, end: null, cur: null, geo: null, sr: true, river: false };
  function levelsFor(code) {
    const L = [];
    const po = D.pool_out || {}, pool = D.pool || {}, i1 = D.i1 || {};
    const seen = {};
    const put = (v, label, color) => { if (v != null && !seen[label]) { seen[label] = 1; L.push({ v: +v, label, color }); } };
    (po.new || []).concat((pool.positions || []).filter(x => x.status === 'pending')).forEach(x => { if (x.code === code) { put(x.cap, '可買入上限', '--w4'); put(x.stop_now, '出場線', '--down'); } });
    (pool.positions || []).forEach(x => { if (x.code === code && x.status !== 'pending') { put(x.entry, '進場', '--support'); put(x.stop_now, '出場線', '--down'); } });
    (i1.new || []).forEach(x => { if (x.code === code) { put(x.cap, 'I1 上限', '--i1'); put(x.stop_now, 'I1 出場線', '--i1'); } });
    (i1.holding || []).forEach(x => { if (x.code === code) { put(x.entry, 'I1 進場', '--i1'); put(x.stop_now, 'I1 出場線', '--i1'); } });
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
  async function getJSON(url) { const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 300000)); if (!r.ok) throw new Error(r.status); return r.json(); }
  async function series(code) {
    // 日K：優先用 k/（還原價）；週／月／年：用 kl/（未還原、2016 起），尾端接上 k/ 更新的幾天
    const p = K.period;
    if (!K.cache[code] && K.cache[code] !== false) { try { K.cache[code] = await getJSON(`data/k/${code}.json`); } catch (e) { K.cache[code] = false; } }
    if (!K.cacheL[code] && K.cacheL[code] !== false) { try { K.cacheL[code] = await getJSON(`data/kl/${code}.json`); } catch (e) { K.cacheL[code] = false; } }
    const k = K.cache[code], kl = K.cacheL[code];
    let base, adj, name;
    if (p === 'A') {
      // 還原日K：用長期未還原日K ＋ FinMind 除權息參考價係數向後還原（股票池全部都有）；名單內的股票再接上 k/ 更新的幾天
      if (kl) {
        const dv = await divs();
        base = adjustBars(kl.bars, (dv[code] || []), code); adj = true; name = kl.name;
        if (k) { const lastD = base[base.length - 1][0]; k.bars.forEach(b => { if (b[0] > lastD) base.push(b.slice()); }); }
      } else if (k) { base = k.bars.slice(); adj = true; name = k.name; }
      else return { code, name: code, noAdj: true };
    } else if (p === 'D' || p === 'T') {
      if (kl) { base = kl.bars.slice(); adj = false; name = kl.name; if (k) { const lastD = base[base.length - 1][0]; k.bars.forEach(b => { if (b[0] > lastD) base.push(b); }); } }
      else if (k) { base = k.bars.slice(); adj = true; name = k.name; }
      else return null;
    } else {
      if (kl) { base = kl.bars.slice(); adj = false; name = kl.name; if (k) { const lastD = base[base.length - 1][0]; k.bars.forEach(b => { if (b[0] > lastD) base.push(b); }); } }
      else if (k) { base = k.bars.slice(); adj = true; name = k.name; }
      else return null;
    }
    const lb = liveBar(code, base); if (lb) base.push(lb);
    const bars = (p === 'D' || p === 'A' || p === 'T') ? base : aggregate(base, p);
    // 本益比河流：近四季 EPS 階梯（FinMind 每日本益比反推，未還原價基準）；還原日K 時依每日還原倍率同步縮放
    let eps = null;
    if (code !== 'TSE01' && code !== 'OTC01') {
      const steps = (await pers())[code];
      if (steps && steps.length) {
        let ratio = null;
        if (p === 'A' && kl) { ratio = {}; const raw = {}; kl.bars.forEach(b => raw[b[0]] = b[4]); base.forEach(b => { if (raw[b[0]]) ratio[b[0]] = b[4] / raw[b[0]]; }); }
        let j = 0; eps = bars.map(b => { while (j + 1 < steps.length && steps[j + 1][0] <= b[0]) j++; const e = steps[j][0] <= b[0] ? steps[j][1] : 0; return e > 0 ? e * (ratio ? (ratio[b[0]] || 1) : 1) : 0; });
        if (!eps.some(v => v > 0)) eps = null;
      }
    }
    return { code, name, adj, daily: base, bars, eps };
  }
  let PERS = null;
  async function pers() { if (PERS) return PERS; try { PERS = (await getJSON('data/per_all.json')).data || {}; } catch (e) { PERS = {}; } return PERS; }
  let DIVS = null;
  async function divs() { if (DIVS) return DIVS; try { DIVS = (await getJSON('data/divs_all.json')).data || {}; } catch (e) { DIVS = {}; } return DIVS; }
  function adjustBars(bars, events, code) {
    // 向後還原：每個除權息日之前的 o/h/l/c × 係數、量 ÷ 係數（係數＝參考價／前一日收盤，與證交所一致，含減資／分割）
    const out = bars.map(b => b.slice());
    if (code === 'TSE01' || code === 'OTC01') return out;
    const evs = events.slice().sort((x, y) => x[0] < y[0] ? -1 : 1);
    evs.forEach(([d, f]) => {
      let i = out.findIndex(b => b[0] >= d);
      if (i <= 0 || !(f > 0 && f < 1)) return;
      // 資料庫若已含該日跳空（前收與開盤差距與係數相符）才還原；否則可能是資料缺日，仍以係數為準
      for (let j = 0; j < i; j++) { const b = out[j]; b[1] *= f; b[2] *= f; b[3] *= f; b[4] *= f; b[5] /= f; }
    });
    // 分割／面額變更（係數清單沒有的情況）：開盤比前收低於七成且接近整數倍
    for (let j = 1; j < out.length; j++) {
      const prev = out[j - 1][4], o = out[j][1];
      if (o / prev < 0.7) { for (const k of [2, 3, 4, 5, 10, 20]) { if (Math.abs(o / (prev / k) - 1) <= 0.105) { for (let t = 0; t < j; t++) { const b = out[t]; b[1] /= k; b[2] /= k; b[3] /= k; b[4] /= k; b[5] *= k; } break; } } }
    }
    out.forEach(b => { for (let t = 1; t <= 4; t++) b[t] = Math.round(b[t] * 100) / 100; b[5] = Math.round(b[5]); });
    return out;
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
    if (!s || s.noAdj) { $('#ctitle').textContent = s ? `${s.code} ${s.name}` : code; $('#csub').textContent = s && s.noAdj ? '這檔沒有還原日K資料。' : '這檔沒有 K 線資料（不在晨報的股票池裡）。'; K.series = null; $('#clegend').innerHTML = ''; $('#crange').textContent = ''; const cv = $('#ccanvas'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); return; }
    K.series = s;
    drawChart();
    if (LIVE.tlLoaded && !LIVE.tlLoaded.has(code)) loadServerTicks();
  }
  function closeChart() { $('#chart').hidden = true; document.body.classList.remove('vopen'); K.code = null; K.series = null; }
  $('#cclose').addEventListener('click', closeChart);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#chart').hidden) closeChart(); });
  document.addEventListener('click', async e => {
    const pb = e.target.closest('[data-period]');
    if (pb) { K.period = pb.dataset.period; K.n = PERIODS[K.period].n; K.end = null; K.cur = null; document.querySelectorAll('[data-period]').forEach(b => b.classList.toggle('active', b === pb)); if (K.code) { const code = K.code; const s = await series(code); if (!s || s.noAdj) { K.series = null; $('#csub').textContent = s && s.noAdj ? '這檔沒有還原日K資料。' : '沒有資料'; $('#clegend').innerHTML = ''; $('#crange').textContent = ''; const cv = $('#ccanvas'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); } else { K.series = s; drawChart(); } } return; }
    const sb = e.target.closest('[data-sr]');
    if (sb) { K.sr = !K.sr; sb.classList.toggle('active', K.sr); drawChart(); return; }
    const rb = e.target.closest('[data-river]');
    if (rb) { K.river = !K.river; rb.classList.toggle('active', K.river); drawChart(); return; }
    const zb = e.target.closest('[data-zoom]');
    if (zb) { const z = zb.dataset.zoom; if (z === 'in') K.n = Math.max(20, Math.round(K.n / 1.4)); else if (z === 'out') K.n = Math.min(600, Math.round(K.n * 1.4)); else if (z === 'left') K.end = (K.end == null ? total() : K.end) - Math.round(K.n / 2); else if (z === 'right') K.end = (K.end == null ? total() : K.end) + Math.round(K.n / 2); else if (z === 'latest') K.end = null; clampView(); drawChart(); return; }
    if (e.target.closest('a,button:not([data-k]),summary,input')) return;
    const k = e.target.closest('[data-k]'); if (k && k.dataset.k !== 'FUT') openChart(k.dataset.k);
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
    $('#chart').classList.toggle('tmode', K.period === 'T');
    if (K.period === 'T') return drawTimeline(s);
    const cv = $('#ccanvas'), wrap = cv.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = wrap.clientWidth, H = Math.max(440, Math.min(680, Math.round(W * 1.4)));
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const col = v => css.getPropertyValue(v).trim();
    const C = { up: col('--up'), down: col('--down'), muted: col('--muted'), line: col('--line'), fg: col('--fg'), paper: col('--paper'), bg: col('--bg'), ma1: '#e39b2e', ma2: '#3a7bd5', ma3: '#9b59b6', res: '#c0392b', sup: '#1f8a4c', k: '#e39b2e', d: '#3a7bd5', j: '#c04fd0', dif: '#e39b2e', dea: '#3a7bd5' };
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
    $('#csub').innerHTML = `${esc(last[0])}${isLive ? '（' + (D.quotes && D.quotes.market_open && marketPhase() === 'open' ? '盤中' : '收盤') + (LIVE.ok ? '，即時報價' : '，報價延遲約 5–10 分') + '）' : ''} 收 <b>${fmt(last[4])}</b> <span class="${cls(chg)}">${pct(chg)}</span>・${ph.label}K・${s.adj ? '還原價' : '未還原'}`;

    const padL = 6, padR = 56, bottom = 16, gapP = 14;
    const pH = Math.round(H * 0.46), vH = Math.round(H * 0.11), kH = Math.round(H * 0.15), mH = H - pH - vH - kH - bottom - gapP * 3 - 8;
    const P = { top: 8, h: pH }, V = { top: P.top + pH + gapP, h: vH }, KD = { top: 0, h: kH }, M = { top: 0, h: mH };
    KD.top = V.top + vH + gapP; M.top = KD.top + kH + gapP;
    const plotW = W - padL - padR;
    const x = i => padL + (i + 0.5) * plotW / n;
    const bw = Math.max(1.5, plotW / n * 0.62);
    const levels = levelsFor(K.code).filter(l => l.v > 0);
    let sr = K.sr ? srLevels(all, endI, K.period) : [];
    let lo = Infinity, hi = -Infinity;
    bars.forEach(b => { lo = Math.min(lo, b[3]); hi = Math.max(hi, b[2]); });
    bars.forEach((b, i) => ph.mas.forEach(p => { const m = ma(closes, p, off + i); if (m != null) { lo = Math.min(lo, m); hi = Math.max(hi, m); } }));
    if (K.period === 'D' || K.period === 'A') levels.forEach(l => { lo = Math.min(lo, l.v); hi = Math.max(hi, l.v); });
    const river = K.river ? riverBands(s, endI) : null;
    if (river) {
      // 座標只納入離價格最近的上下河道線（最高點之上第一條、最低點之下第一條），其餘超出圖外裁掉，避免把 K 棒壓扁
      let bl = Infinity, bh = -Infinity;
      bars.forEach((b, i) => { const e = s.eps[off + i]; if (!(e > 0)) return; const vals = river.pes.map(p => e * p); const below = vals.filter(v => v <= b[3]), above = vals.filter(v => v >= b[2]); bl = Math.min(bl, below.length ? Math.max(...below) : vals[0]); bh = Math.max(bh, above.length ? Math.min(...above) : vals[vals.length - 1]); });
      if (bl < Infinity) { lo = Math.min(lo, bl); hi = Math.max(hi, bh); }
    }
    { const pad0 = (hi - lo) * 0.06 || 1; sr = sr.filter(l => l.v >= lo - pad0 && l.v <= hi + pad0); }
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
    const tick = (b, pb) => { if (!pb) return null; if (K.period === 'D' || K.period === 'A') return b[0].slice(0, 7) !== pb[0].slice(0, 7) ? b[0].slice(5, 7).replace(/^0/, '') + '月' : null; if (K.period === 'W') return b[0].slice(0, 7) !== pb[0].slice(0, 7) && +b[0].slice(5, 7) % 3 === 1 ? (b[0].slice(5, 7) === '01' ? b[0].slice(0, 4) : b[0].slice(5, 7).replace(/^0/, '') + '月') : null; if (K.period === 'M') return b[0].slice(0, 4) !== pb[0].slice(0, 4) ? b[0].slice(0, 4) : null; return b[0].slice(0, 4); };
    bars.forEach((b, i) => { const t = K.period === 'Y' ? ((n <= 8 || +b[0].slice(0, 4) % 2 === 0) ? b[0].slice(0, 4) : null) : tick(b, bars[i - 1]); if (!t) return; ctx.fillStyle = C.muted; ctx.fillText(t, x(i), H - bottom + 3); if (K.period !== 'Y') { ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x(i), P.top); ctx.lineTo(x(i), M.top + M.h); ctx.stroke(); } });
    const line = (fn, color, w) => { ctx.strokeStyle = color; ctx.lineWidth = w || 1.2; ctx.beginPath(); let st = false; bars.forEach((b, i) => { const v = fn(i); if (v == null) return; if (!st) { ctx.moveTo(x(i), v); st = true; } else ctx.lineTo(x(i), v); }); ctx.stroke(); };
    // 本益比河流：歷史本益比分位 × 當時 EPS，由低到高填色（綠＝便宜、紅＝昂貴），畫在 K 棒底下
    if (river) {
      const RC = ['#1f8a4c', '#8fbf4a', '#e3b22e', '#e07b2a', '#c0392b'];
      const xe = i => padL + (i + 1) * plotW / n, xs = i => padL + i * plotW / n;
      ctx.save(); ctx.beginPath(); ctx.rect(padL, P.top - 2, plotW, P.h + 4); ctx.clip();
      for (let k = 0; k < river.pes.length - 1; k++) {
        ctx.fillStyle = RC[k]; ctx.globalAlpha = 0.13;
        let open = false;
        bars.forEach((b, i) => { const e = s.eps[off + i]; if (!(e > 0)) { if (open) { ctx.closePath(); ctx.fill(); open = false; } return; } const yt = y(e * river.pes[k + 1]), yb = y(e * river.pes[k]); if (!open) { ctx.beginPath(); open = true; } ctx.rect(xs(i), Math.min(yt, yb), xe(i) - xs(i) + 0.5, Math.abs(yb - yt)); });
        if (open) { ctx.closePath(); ctx.fill(); }
        ctx.globalAlpha = 1;
      }
      river.pes.forEach((pe, k) => {
        ctx.strokeStyle = RC[Math.min(k, RC.length - 1)]; ctx.lineWidth = 1; ctx.globalAlpha = 0.8;
        ctx.beginPath(); let st = false; bars.forEach((b, i) => { const e = s.eps[off + i]; if (!(e > 0)) { st = false; return; } const v = y(e * pe); if (!st) { ctx.moveTo(x(i), v); st = true; } else ctx.lineTo(x(i), v); }); ctx.stroke(); ctx.globalAlpha = 1;
        const el = s.eps[off + n - 1]; if (el > 0) { ctx.fillStyle = RC[Math.min(k, RC.length - 1)]; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = '10px ' + FONT; ctx.fillText(`${pe.toFixed(1)}×`, W - padR - 3, y(el * pe)); ctx.font = '11px ' + FONT; }
      });
      ctx.restore();
    }
    [[ph.mas[0], C.ma1], [ph.mas[1], C.ma2], [ph.mas[2], C.ma3]].forEach(([p, color]) => line(i => { const m = ma(closes, p, off + i); return m == null ? null : y(m); }, color));
    bars.forEach((b, i) => {
      const upc = b[4] >= b[1], color = upc ? C.up : C.down;
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x(i), y(b[2])); ctx.lineTo(x(i), y(b[3])); ctx.stroke();
      const o = y(b[1]), c = y(b[4]);
      ctx.fillRect(x(i) - bw / 2, Math.min(o, c), bw, Math.max(1, Math.abs(c - o)));
      ctx.globalAlpha = 0.55; ctx.fillStyle = color; ctx.fillRect(x(i) - bw / 2, vy(b[5]), bw, V.top + V.h - vy(b[5])); ctx.globalAlpha = 1;
    });
    if (isLive && K.end == null) { ctx.fillStyle = C.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'top'; ctx.font = '10px ' + FONT; ctx.fillText(D.quotes && D.quotes.market_open && marketPhase() === 'open' ? '最右一根為今日（盤中累積）' : '最右一根為今日', W - padR - 2, P.top + 2); ctx.font = '11px ' + FONT; }
    const used = [];
    sr.forEach(l => {
      const color = l.kind === 'R' ? C.res : C.sup;
      const ly = y(l.v); const clash = used.some(u => Math.abs(u - ly) < 13); used.push(ly);
      ctx.strokeStyle = color; ctx.setLineDash([2, 3]); ctx.lineWidth = 1; ctx.globalAlpha = 0.9; ctx.beginPath(); ctx.moveTo(padL, y(l.v)); ctx.lineTo(W - padR, y(l.v)); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
      ctx.fillStyle = color; ctx.textAlign = clash ? 'left' : 'right'; ctx.textBaseline = l.kind === 'R' ? 'bottom' : 'top'; ctx.font = '10px ' + FONT;
      ctx.fillText(`${l.kind === 'R' ? '壓力' : '支撐'} ${fmt(l.v)}（${l.n} 次）`, clash ? padL + 3 : W - padR - 3, ly + (l.kind === 'R' ? -1 : 1)); ctx.font = '11px ' + FONT;
    });
    if (K.period === 'D' || K.period === 'A') levels.forEach(l => {
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
    const dl = (K.period === 'D' || K.period === 'A') ? b[0] : K.period === 'Y' ? b[0].slice(0, 4) + ' 年' : K.period === 'M' ? b[0].slice(0, 7) : '週 ' + b[0];
    $('#clegend').innerHTML = `<span class="d">${esc(dl)}${b[6] ? '（含今日）' : ''}</span><span>開 ${fmt(b[1])}</span><span>高 ${fmt(b[2])}</span><span>低 ${fmt(b[3])}</span><span>收 <b class="${cls(bchg)}">${fmt(b[4])}</b> <span class="${cls(bchg)}">${pct(bchg)}</span></span><span>量 ${fmt(b[5], 0)} 張</span>
      <span style="color:${C.ma1}">MA${ph.mas[0]} ${m(ph.mas[0])}</span><span style="color:${C.ma2}">MA${ph.mas[1]} ${m(ph.mas[1])}</span><span style="color:${C.ma3}">MA${ph.mas[2]} ${m(ph.mas[2])}</span>
      <span style="color:${C.k}">K ${f1(ind.K[gi])}</span><span style="color:${C.d}">D ${f1(ind.D[gi])}</span><span style="color:${C.j}">J ${f1(ind.J[gi])}</span>
      <span style="color:${C.dif}">DIF ${f2(gi < 26 ? null : ind.dif[gi])}</span><span style="color:${C.dea}">MACD ${f2(gi < 34 ? null : ind.dea[gi])}</span><span>OSC ${f2(gi < 34 ? null : ind.osc[gi])}</span>` +
      (K.river ? (river && s.eps[gi] > 0 ? `<span>本益比 <b>${(b[4] / s.eps[gi]).toFixed(1)}</b>（EPS ${s.eps[gi].toFixed(2)}，歷史分位 ${river.pes.map(v => v.toFixed(1)).join('／')}×）</span>` : `<span class="muted">${s.eps ? '此時無本益比資料（虧損或未揭露）' : '這檔沒有本益比資料（指數／ETF 或 FinMind 無資料）'}</span>`) : '');
    $('#crange').textContent = `${bars[0][0]} ～ ${bars[n - 1][0]}・${n} 根`;
    K.geo = { n, padL, padR, W, plotW };
  }
  // 支撐壓力：近期波段高低點分群（價位相近視為同一區），依觸碰次數與新舊排序，現價上方取壓力、下方取支撐
  function srLevels(all, endI, period) {
    const look = (period === 'D' || period === 'A') ? 160 : period === 'W' ? 120 : period === 'M' ? 60 : 0;
    if (!look) return [];
    const k = (period === 'D' || period === 'A') ? 3 : 2;
    const from = Math.max(0, endI - look), seg = all.slice(from, endI), n = seg.length;
    if (n < k * 2 + 5) return [];
    const last = seg[n - 1][4];
    const piv = [];
    for (let i = k; i < n - k; i++) {
      let ph = true, pl = true;
      for (let j = i - k; j <= i + k; j++) { if (j === i) continue; if (seg[j][2] >= seg[i][2]) ph = false; if (seg[j][3] <= seg[i][3]) pl = false; }
      if (ph) piv.push({ v: seg[i][2], i, t: 'H' });
      if (pl) piv.push({ v: seg[i][3], i, t: 'L' });
    }
    // 加入區間最高／最低
    let hiI = 0, loI = 0; seg.forEach((b, i) => { if (b[2] > seg[hiI][2]) hiI = i; if (b[3] < seg[loI][3]) loI = i; });
    piv.push({ v: seg[hiI][2], i: hiI, t: 'H' }); piv.push({ v: seg[loI][3], i: loI, t: 'L' });
    piv.sort((a, b) => a.v - b.v);
    const tol = Math.max(last * 0.012, (seg[hiI][2] - seg[loI][3]) / 60);
    const groups = [];
    piv.forEach(p => { const g = groups[groups.length - 1]; if (g && p.v - g.v0 <= tol) { g.items.push(p); } else groups.push({ v0: p.v, items: [p] }); });
    const out = groups.map(g => {
      const ids = new Set(g.items.map(p => p.i));
      const v = g.items.reduce((s, p) => s + p.v, 0) / g.items.length;
      const rec = Math.max(...g.items.map(p => p.i)) / n;
      return { v, n: ids.size, score: ids.size * 1.0 + rec * 1.2 + (g.items.some(p => p.i === hiI || p.i === loI) ? 0.6 : 0) };
    }).filter(g => Math.abs(g.v - last) / last > 0.004);
    const near = out.filter(g => Math.abs(g.v - last) / last <= 0.25);
    const pickSide = (list, kind) => list.sort((a, b) => b.score - a.score).slice(0, 4).sort((a, b) => Math.abs(a.v - last) - Math.abs(b.v - last)).slice(0, 2).map(g => Object.assign({ kind }, g));
    const R = pickSide(near.filter(g => g.v > last), 'R');
    const S = pickSide(near.filter(g => g.v < last), 'S');
    return R.concat(S);
  }
  // 分時走勢（K 線圖的「分時」分頁）：價格線＋每筆成交量，資料來自即時報價累積（LIVE.ticks）
  function drawTimeline(s) {
    const cv = $('#ccanvas'), wrap = cv.parentElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = wrap.clientWidth, H = Math.max(360, Math.min(560, Math.round(W * 1.1)));
    cv.width = W * dpr; cv.height = H * dpr; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim(), FONT = css.getPropertyValue('--sans');
    const C = { up: col('--up'), down: col('--down'), muted: col('--muted'), line: col('--line'), fg: col('--fg'), bg: col('--bg'), ref: '#d4a017' };
    const code = K.code, q = D.quotes || {};
    const item = code === 'TSE01' ? (q.index || {}).t00 : code === 'OTC01' ? (q.index || {}).o00 : (q.items || []).find(i => i.code === code);
    const all = s.bars, last = all[all.length - 1];
    const prev = item && item.prev ? item.prev : (last[6] && all.length > 1 ? all[all.length - 2][4] : last[4]);
    const ticks = (LIVE.ticks[code] || []).slice();
    const open = marketPhase() === 'open';
    const day = (LIVE.tlDate && LIVE.tlDate !== tlKey().slice(3)) ? ymd8(LIVE.tlDate) : (item && item.date ? ymd8(item.date) : last[0]);
    $('#ctitle').textContent = `${s.code} ${s.name}`;
    const lp = ticks.length ? ticks[ticks.length - 1][1] : (item && item.last != null ? item.last : last[4]);
    const chg = prev ? (lp / prev - 1) * 100 : null;
    $('#csub').innerHTML = `${esc(day)}${open ? '（盤中' + (LIVE.ok ? '，即時報價' : '') + '）' : '（收盤）'} <b>${fmt(lp)}</b> <span class="${cls(chg)}">${pct(chg)}</span>・分時・昨收 ${fmt(prev)}`;
    const padL = 6, padR = 74, bottom = 16, gapP = 12;
    const pH = Math.round((H - bottom - gapP - 8) * 0.72), vH = H - bottom - gapP - 8 - pH;
    const P = { top: 8, h: pH }, V = { top: 8 + pH + gapP, h: vH };
    const plotW = W - padL - padR;
    const tmin = 9 * 3600, tmax = 13.5 * 3600;
    const sec = t => { const [h, m, ss] = t.split(':').map(Number); return h * 3600 + m * 60 + (ss || 0); };
    const xs = t => padL + (Math.min(tmax, Math.max(tmin, sec(t))) - tmin) / (tmax - tmin) * plotW;
    let lo = prev, hi = prev; ticks.forEach(t => { lo = Math.min(lo, t[1]); hi = Math.max(hi, t[1]); });
    if (item && item.high != null && item.low != null && item.date && ymd8(item.date) === day) { hi = Math.max(hi, item.high); lo = Math.min(lo, item.low); }
    const span = Math.max(hi - prev, prev - lo, prev * 0.004) * 1.08; lo = prev - span; hi = prev + span;
    const y = v => P.top + (hi - v) / (hi - lo) * P.h;
    const dv = ticks.map((t, i) => Math.max(0, (t[2] || 0) - (i ? (ticks[i - 1][2] || 0) : 0)));
    const vmax = Math.max(1, ...dv);
    const vy = v => V.top + V.h - v / vmax * V.h;
    ctx.clearRect(0, 0, W, H); ctx.font = '11px ' + FONT;
    // 格線與時間
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    [[tmin, '9:00'], [10 * 3600, '10:00'], [11 * 3600, '11:00'], [12 * 3600, '12:00'], [13 * 3600, '13:00'], [tmax, '']].forEach(([sv, t]) => { const px = padL + (sv - tmin) / (tmax - tmin) * plotW; ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, P.top); ctx.lineTo(px, V.top + V.h); ctx.stroke(); ctx.fillStyle = C.muted; ctx.fillText(t, Math.min(W - padR - 14, Math.max(padL + 14, px)), H - bottom + 3); });
    // 價格刻度（以昨收為中心的百分比）
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    [-1, -0.5, 0, 0.5, 1].forEach(k => { const v = prev + span * k / 1.08; ctx.strokeStyle = C.line; ctx.setLineDash(k === 0 ? [4, 3] : []); if (k === 0) ctx.strokeStyle = C.ref; ctx.beginPath(); ctx.moveTo(padL, y(v)); ctx.lineTo(W - padR, y(v)); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = k === 0 ? C.ref : k > 0 ? C.up : C.down; ctx.font = '10px ' + FONT; ctx.fillText(k === 0 ? fmt(prev) : `${fmt(v)} ${(k > 0 ? '+' : '') + ((v / prev - 1) * 100).toFixed(1)}%`, W - padR + 4, y(v)); ctx.font = '11px ' + FONT; });
    ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText('成交量（張）', padL + 2, V.top - 11);
    if (!ticks.length) {
      ctx.fillStyle = C.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '13px ' + FONT;
      const msg = open ? [LIVE.ok === false ? '即時報價連線失敗，無法畫分時' : '等待即時報價…'] : ['還沒有分時資料', '開盤後伺服器每分鐘自動累積，收盤後保留到下一個交易日'];
      msg.forEach((m, i) => ctx.fillText(m, padL + plotW / 2, P.top + P.h / 2 + (i - (msg.length - 1) / 2) * 20));
      if (item && item.last != null && item.time && ymd8(item.date || '') === day) { const px = xs(item.time); ctx.fillStyle = item.last >= prev ? C.up : C.down; ctx.beginPath(); ctx.arc(px, y(item.last), 3, 0, Math.PI * 2); ctx.fill(); ctx.font = '10px ' + FONT; ctx.textAlign = 'right'; ctx.fillText(`${item.time.slice(0, 5)} 收 ${fmt(item.last)}`, px - 6, y(item.last)); }
      $('#clegend').innerHTML = `<span class="d">${esc(day)}</span><span>昨收 ${fmt(prev)}</span>${item && item.high != null ? `<span>高 ${fmt(item.high)}</span><span>低 ${fmt(item.low)}</span><span>量 ${fmt(item.vol || 0, 0)} 張</span>` : ''}`;
      $('#crange').textContent = '09:00 ～ 13:30'; K.geo = { n: 270, padL, padR, W, plotW, T: true };
      return;
    }
    const color = lp >= prev ? C.up : C.down;
    // 成交量
    ticks.forEach((t, i) => { const px = xs(t[0]); const up = i ? t[1] >= ticks[i - 1][1] : t[1] >= prev; ctx.fillStyle = up ? C.up : C.down; ctx.globalAlpha = 0.7; ctx.fillRect(px - 1, vy(dv[i]), 2, V.top + V.h - vy(dv[i])); ctx.globalAlpha = 1; });
    // 價格線＋面積
    ctx.beginPath(); ticks.forEach((t, i) => { const px = xs(t[0]), py = y(t[1]); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.lineTo(xs(ticks[ticks.length - 1][0]), y(prev)); ctx.lineTo(xs(ticks[0][0]), y(prev)); ctx.closePath(); ctx.fillStyle = color; ctx.globalAlpha = 0.1; ctx.fill(); ctx.globalAlpha = 1;
    // 均價線（成交量加權）
    let cv_ = 0, ca = 0; ctx.beginPath(); ticks.forEach((t, i) => { cv_ += dv[i]; ca += dv[i] * t[1]; const av = cv_ ? ca / cv_ : t[1]; const px = xs(t[0]), py = y(av); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.strokeStyle = '#e39b2e'; ctx.lineWidth = 1; ctx.stroke();
    const lx = xs(ticks[ticks.length - 1][0]); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(lx, y(lp), 3, 0, Math.PI * 2); ctx.fill();
    // 十字線（K.cur＝分鐘索引）
    let ti = ticks.length - 1;
    if (K.cur != null) { const target = tmin + Math.max(0, Math.min(270, K.cur)) * 60; let best = 0; for (let i = 0; i < ticks.length; i++) { if (Math.abs(sec(ticks[i][0]) - target) <= Math.abs(sec(ticks[best][0]) - target)) best = i; } ti = best;
      const px = xs(ticks[ti][0]); ctx.strokeStyle = C.muted; ctx.setLineDash([3, 3]); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(px, P.top); ctx.lineTo(px, V.top + V.h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(padL, y(ticks[ti][1])); ctx.lineTo(W - padR, y(ticks[ti][1])); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = C.fg; ctx.fillRect(W - padR + 1, y(ticks[ti][1]) - 8, padR - 2, 16); ctx.fillStyle = C.bg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(fmt(ticks[ti][1]), W - padR + 4, y(ticks[ti][1])); }
    const t = ticks[ti], tchg = prev ? (t[1] / prev - 1) * 100 : null;
    $('#clegend').innerHTML = `<span class="d">${esc(day)} ${esc(t[0])}</span><span>價 <b class="${cls(tchg)}">${fmt(t[1])}</b> <span class="${cls(tchg)}">${pct(tchg)}</span></span><span>單筆量 ${fmt(dv[ti], 0)} 張</span><span>累計量 ${fmt(t[2] || 0, 0)} 張</span><span style="color:#e39b2e">均價 ${cv_ ? fmt(ca / cv_) : '—'}</span><span>昨收 ${fmt(prev)}</span>`;
    $('#crange').textContent = `${ticks[0][0]} ～ ${ticks[ticks.length - 1][0]}・${ticks.length} 筆`;
    K.geo = { n: 270, padL, padR, W, plotW, T: true };
  }
  // 本益比河流：用這檔全部歷史（有獲利的時期）的收盤÷EPS 取 5／27.5／50／72.5／95 分位當五條河道線
  function riverBands(s, endI) {
    if (!s.eps) return null;
    const pe = [];
    for (let i = 0; i < endI; i++) { const e = s.eps[i]; if (e > 0) pe.push(s.bars[i][4] / e); }
    if (pe.length < 60) return null;
    pe.sort((a, b) => a - b);
    const q = p => pe[Math.min(pe.length - 1, Math.max(0, Math.round((pe.length - 1) * p)))];
    return { pes: [q(0.05), q(0.275), q(0.5), q(0.725), q(0.95)] };
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
      if (g.T) { if (pts.size === 1) { moved = true; K.cur = idxAt(e.clientX - cv.getBoundingClientRect().left); drawChart(); } return; } // 分時：拖曳＝移動十字線
      if (pts.size === 2) { const a = [...pts.values()]; const d = Math.abs(a[0] - a[1]); if (pinch0 > 0) { K.n = Math.round(n0 * pinch0 / Math.max(d, 10)); clampView(); moved = true; drawChart(); } return; }
      const dx = e.clientX - dragStartX;
      if (Math.abs(dx) > 6) moved = true;
      if (moved) { K.end = startEnd - Math.round(dx / (g.plotW / g.n)); K.cur = null; clampView(); if (K.end >= total()) K.end = null; drawChart(); }
    });
    const up = e => { if (!pts.has(e.pointerId)) return; pts.delete(e.pointerId); if (!moved && pts.size === 0) { K.cur = idxAt(e.clientX - cv.getBoundingClientRect().left); drawChart(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('mouseleave', () => { if (pts.size === 0) { K.cur = null; drawChart(); } });
    cv.addEventListener('wheel', e => { e.preventDefault(); if (K.geo && K.geo.T) return; K.n = Math.round(K.n * (e.deltaY > 0 ? 1.15 : 0.87)); clampView(); drawChart(); }, { passive: false });
  })();

  // ---------- 分頁 ----------
  function go(name, push) {
    document.querySelectorAll('.tab').forEach(t => { t.hidden = t.dataset.tab !== name; });
    document.querySelectorAll('.tabbtn').forEach(b => b.classList.toggle('active', b.dataset.go === name));
    if (push !== false) history.replaceState(null, '', '#' + name);
    window.scrollTo({ top: 0 });
    if (name === 'live' && typeof patchLive === 'function' && D.quotes) { patchLive(); livePoll(true); }
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
