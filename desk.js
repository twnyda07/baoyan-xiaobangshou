/* 寶嚴小幫手借還台（v2）
 * 以機器為中心：選分院 → 點號碼 → 寫是誰。名單上的人可以直接「領取」預先指派的機器。
 * 按下去畫面立刻變，資料在背景排隊送出（斷線也會留著，連上自動補送）。
 * 後端：Apps Script deskLoad / deskOps（同一個 /exec 網址，跟舊畫面共用資料）。 */
(function () {
  'use strict';
  var BUILD = '20261124b';
  var BR_ORDER = ['善覺', '善學', '圓道'];
  var SITEINFO = '<section class="siteinfo" aria-label="本站資訊"><div class="si-h">本站資訊</div><dl>' +
    '<dt>名稱：</dt><dd>小幫手借還台</dd>' +
    '<dt>網址：</dt><dd><a href="https://twnyda07.github.io/baoyan-xiaobangshou/desk.html">twnyda07.github.io/baoyan-xiaobangshou/desk.html</a></dd>' +
    '<dt>特別功能：</dt><dd>對講機現場借出與歸還：先點機器號碼再寫是誰，名單外的人也能臨時借；斷線時先存在手機，連上自動補送。</dd>' +
    '<dt>創作者／版權所有：</dt><dd>© 2026 寶嚴山寶嚴禪寺　保留一切權利</dd></dl></section>';

  /* ---------- 小工具 ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function now19() { var d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }
  function hm(t) { return String(t || '').slice(11, 16); }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function newCid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 私密模式存不了，照樣能用 */ } },
  };
  var sess = {
    get: function (k) { try { return sessionStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set: function (k, v) { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch (e) { /* 無所謂 */ } },
  };

  /* ---------- 狀態 ---------- */
  var pw = sess.get('xbsd_pw');
  var by = store.get('xbsd_by', '');
  var S = { ver: 0, devices: [], groups: [], members: [], srv: {}, role: '', canEdit: false, event: null, loaded: false, lastSync: 0, lastFull: 0, syncErr: '' };
  var Q = store.get('xbsd_q', []);            // 還沒送到雲端的動作
  var problems = store.get('xbsd_prob', []);  // 雲端拒絕的動作（要人處理）
  var mine = store.get('xbsd_mine', []);      // 這支手機最近做的（可復原）
  var V = { loans: {}, open: {} };            // 畫面看到的＝雲端＋排隊中的
  var sel = {};                               // 號碼格目前選了哪些 n
  var selKey = '';
  var flushing = false, retryTimer = null, failN = 0;
  var lastGroup = sess.get('xbsd_lastgroup');
  var gridFilter = '';
  var getQuery = '';
  var findQuery = '';

  function saveQ() { store.set('xbsd_q', Q); }
  function saveProb() { store.set('xbsd_prob', problems); }
  function saveMine() { store.set('xbsd_mine', mine.slice(0, 40)); }
  function canEdit() { return S.canEdit && S.role !== 'guest'; }

  /* ---------- 連線 ---------- */
  function backendUrl() { var o = ''; try { o = localStorage.getItem('xbs_backend') || ''; } catch (e) { /* */ } return (o || (window.CONFIG && window.CONFIG.backend) || '').trim(); }

  function post(action, payload) {
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 45000) : null;
    var body = Object.assign({ action: action, pw: pw, by: by }, payload || {});
    return fetch(backendUrl(), {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body), redirect: 'follow', signal: ctrl ? ctrl.signal : undefined,
    }).then(function (r) { return r.text(); }).then(function (txt) {
      if (timer) clearTimeout(timer);
      var data;
      try { data = JSON.parse(txt); } catch (e) { var x = new Error('連線被 Google 暫時擋下'); x.retryable = true; throw x; }
      if (!data.ok) { var err = new Error(data.error || '操作失敗'); err.code = data.code; err.retryable = data.code === 'BUSY'; throw err; }
      return data;
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') { e = new Error('連線逾時'); e.retryable = true; }
      if (/Failed to fetch|NetworkError|Load failed|network/i.test((e && e.message) || '')) { e = new Error('網路不通'); e.retryable = true; }
      throw e;
    });
  }

  /* ---------- 畫面資料＝雲端＋排隊中 ---------- */
  function key(b, n) { return b + '|' + n; }
  function rebuild() {
    var L = {}, open = {};
    Object.keys(S.srv).forEach(function (c) {
      var l = Object.assign({}, S.srv[c]); L[c] = l;
      if (l.st === '借出') open[key(l.b, l.n)] = l;
    });
    Q.forEach(function (op) {
      var k = key(op.b, op.n), l;
      if (op.t === 'borrow') {
        if (L[op.cid] || open[k]) return;
        l = { cid: op.cid, st: '借出', b: op.b, n: op.n, mid: op.mid || '', name: op.name, group: op.group, phone: op.phone, src: op.src, outAt: op.at, outBy: by, pending: 1 };
        L[op.cid] = l; open[k] = l;
      } else if (op.t === 'return') {
        l = open[k]; if (!l) return;
        l.st = '已還'; l.inAt = op.at; l.inBy = by; l.missing = op.missing || ''; l.pending = 1; delete open[k];
      } else if (op.t === 'undo') {
        l = L[op.target]; if (!l) return;
        k = key(l.b, l.n);
        if (op.what === 'borrow' && l.st === '借出') { l.st = '取消'; l.pending = 1; delete open[k]; }
        else if (op.what === 'return' && l.st === '已還' && !open[k]) { l.st = '借出'; l.inAt = ''; l.pending = 1; open[k] = l; }
      }
    });
    V.loans = L; V.open = open;
  }

  function branches() {
    var seen = {}, out = [];
    S.devices.forEach(function (d) { if (!seen[d[0]]) { seen[d[0]] = 1; out.push(d[0]); } });
    return out.sort(function (a, b) {
      var ia = BR_ORDER.indexOf(a), ib = BR_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a < b ? -1 : 1);
    });
  }
  function natCmp(a, b) {
    var x = parseInt(digits(a), 10), y = parseInt(digits(b), 10);
    if (isNaN(x) !== isNaN(y)) return isNaN(x) ? 1 : -1;
    return (x - y) || (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  }
  function devicesOf(b) {
    var seen = {};
    return S.devices.filter(function (d) {
      if (d[0] !== b || seen[d[1]]) return false; seen[d[1]] = 1; return true;
    }).sort(function (p, q) { return natCmp(p[1], q[1]); });
  }
  function dispNo(b, n) { n = String(n); return n.indexOf(b) === 0 && n.length > b.length ? n.slice(b.length) : n; }
  function devLabel(b, n) { return b + ' ' + dispNo(b, n); }
  /** 一台機器現在的狀態：free 可借／out 借出中（有借用人）／ghost 清冊說借出但查不到人／off 停用維修 */
  function stateOf(d) {
    var l = V.open[key(d[0], d[1])];
    if (l) return { s: 'out', l: l };
    var st = d[2] || '';
    if (st === '' || st === '可用') return { s: 'free' };
    if (st === '借出') return { s: 'ghost' };
    return { s: 'off', why: st };
  }
  function findDev(b, n) { for (var i = 0; i < S.devices.length; i++) if (S.devices[i][0] === b && S.devices[i][1] === n) return S.devices[i]; return null; }
  function groupById(id) { for (var i = 0; i < S.groups.length; i++) if (S.groups[i].id === id) return S.groups[i]; return null; }
  function memberById(id) { for (var i = 0; i < S.members.length; i++) if (S.members[i].id === id) return S.members[i]; return null; }
  function openLoans() { return Object.keys(V.open).map(function (k) { return V.open[k]; }); }
  function loansOfMember(mid) { return openLoans().filter(function (l) { return l.mid === mid; }); }
  function who(l) { return l.name + (l.group ? '（' + l.group + '）' : ''); }

  /* ---------- 送出佇列 ---------- */
  function enqueue(ops) {
    ops.forEach(function (op) {
      op.cid = op.cid || newCid(); op.at = op.at || now19();
      Q.push(op);
      mine.unshift({ cid: op.cid, t: op.t, b: op.b, n: op.n, name: op.name || '', target: op.target || '', what: op.what || '', at: op.at });
    });
    saveQ(); saveMine(); rebuild(); render(); flush();
    return ops;
  }
  function inQueue(cid) { for (var i = 0; i < Q.length; i++) if (Q[i].cid === cid) return i; return -1; }
  var inflight = {};

  function flush() {
    if (flushing || !Q.length || !pw) { paintSync(); return; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    flushing = true; paintSync();
    var batch = Q.slice(0, 50);
    inflight = {}; batch.forEach(function (op) { inflight[op.cid] = 1; });
    post('deskOps', { ops: batch, since: Math.max(0, S.ver - 20) }).then(function (res) {
      Q = Q.filter(function (op) { return !inflight[op.cid]; });
      var bad = 0;
      (res.results || []).forEach(function (r, i) {
        var op = batch[i];
        if (r.ok) return;
        if (op.t === 'undo' && r.code === 'NO_LOAN') return;   // 要取消的那筆本身就沒成功，不用再報
        bad++;
        problems.push({ op: op, code: r.code || '', error: r.error || '沒有成功', holder: r.holder || '', at: now19() });
      });
      (res.loans || []).forEach(function (l) { S.srv[l.cid] = l; });
      (res.results || []).forEach(function (r) { if (r.ok && r.loan) S.srv[r.loan.cid] = r.loan; });
      S.ver = Math.max(S.ver, res.ver || 0);
      S.lastSync = Date.now(); S.syncErr = ''; failN = 0;
      saveQ(); saveProb(); rebuild(); render();
      if (bad) toast('有 ' + bad + ' 筆沒有成功，請按紅色那條處理', { bad: true, go: '#/prob', label: '處理' });
    }).catch(function (e) {
      if (e.code === 'BAD_PASSWORD') { S.syncErr = '密碼不對了'; logout('密碼已更換，請重新輸入'); return; }
      if (e.code === 'EVENT_CLOSED' || e.code === 'GUEST_READONLY') {
        batch.forEach(function (op) { problems.push({ op: op, code: e.code, error: e.message, at: now19() }); });
        Q = Q.filter(function (op) { return !inflight[op.cid]; });
        saveQ(); saveProb(); rebuild(); render(); syncNow(true);
        return;
      }
      failN++;
      S.syncErr = e.message || '連不上';
      var wait = Math.min(30000, 1500 * Math.pow(2, Math.min(failN, 5))) * (0.6 + Math.random() * 0.8);
      retryTimer = setTimeout(function () { retryTimer = null; flush(); }, wait);
    }).then(function () {
      flushing = false; inflight = {}; paintSync();
      if (Q.length && !retryTimer) flush();
    });
  }

  /* ---------- 從雲端同步 ---------- */
  var syncing = false;
  function syncNow(full) {
    if (syncing || !pw) return Promise.resolve();
    syncing = true;
    var payload = full ? {} : { since: Math.max(0, S.ver - 20) };
    return post('deskLoad', payload).then(function (res) {
      if (res.full) {
        S.srv = {};
        S.members = res.members || []; S.groups = res.groups || [];
        S.lastFull = Date.now();
      }
      (res.loans || []).forEach(function (l) { S.srv[l.cid] = l; });
      S.devices = res.devices || S.devices;
      S.ver = res.full ? res.ver : Math.max(S.ver, res.ver);
      S.role = res.role; S.canEdit = res.canEdit; S.event = res.event;
      S.loaded = true; S.lastSync = Date.now(); S.syncErr = '';
      rebuild(); renderSoft();
    }).catch(function (e) {
      if (e.code === 'BAD_PASSWORD') { logout('密碼不正確或已更換'); throw e; }
      S.syncErr = e.message || '連不上';
      paintSync();
      throw e;
    }).then(function (x) { syncing = false; paintSync(); return x; }, function (e) { syncing = false; paintSync(); throw e; });
  }
  setInterval(function () {
    if (!pw || !S.loaded || document.hidden) return;
    if (Q.length && !flushing && !retryTimer) flush();
    var since = Date.now() - S.lastSync;
    if (!flushing && since > 20000) syncNow(Date.now() - S.lastFull > 180000).catch(function () {});
  }, 4000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && pw && S.loaded) { flush(); syncNow(false).catch(function () {}); }
  });
  window.addEventListener('online', function () { failN = 0; flush(); });

  /* ---------- 頂端：位置＋同步狀態 ---------- */
  function paintSync() {
    var el = $('#sync');
    if (!pw || !S.loaded) { el.hidden = true; return; }
    el.hidden = false;
    var n = Q.length;
    if (S.syncErr && (n || retryTimer)) { el.className = 'pill bad'; el.textContent = '⚠ ' + n + ' 筆待送'; }
    else if (n || flushing) { el.className = 'pill busy'; el.textContent = '⏳ 送出 ' + (n || '') ; }
    else if (S.syncErr) { el.className = 'pill bad'; el.textContent = '⚠ 連線不穩'; }
    else { el.className = 'pill ok'; el.textContent = '✓ 已同步'; }
  }
  $('#sync').addEventListener('click', function () {
    var last = S.lastSync ? new Date(S.lastSync).toTimeString().slice(0, 8) : '還沒有';
    sheet('<h2>連線狀態</h2>' +
      '<div class="sum"><div>最後一次跟雲端對上：<b>' + last + '</b></div>' +
      '<div>還在排隊送出：<b>' + Q.length + '</b> 筆</div>' +
      (S.syncErr ? '<div style="color:var(--danger)">' + esc(S.syncErr) + '（會自己一直補送，不用重按）</div>' : '') +
      '<div class="mute">排隊中的資料存在這支手機裡，關掉網頁再打開也不會不見。</div></div>' +
      '<div class="acts"><button class="btn" data-close type="button">關閉</button><button class="btn pri" id="sNow" type="button">現在同步</button></div>',
    function (p) {
      $('#sNow', p).onclick = function () { failN = 0; flush(); syncNow(true).then(function () { toast('已更新'); }, function (e) { toast(e.message, { bad: true }); }); closeSheet(); };
    });
  });

  function crumbs(list) {
    var html = '<a href="#/">首頁</a>';
    list.forEach(function (c, i) {
      html += '<span class="sep">›</span>' + (i === list.length - 1 || !c[1] ? '<b>' + esc(c[0]) + '</b>' : '<a href="' + c[1] + '">' + esc(c[0]) + '</a>');
    });
    if (!list.length) html = '<b>小幫手借還台</b>' + (S.event ? '<span class="mute" style="margin-left:6px">' + esc(S.event.name) + '</span>' : '');
    $('#crumb').innerHTML = html;
    var parent = list.length >= 2 ? list[list.length - 2][1] : '#/';
    $('#back').hidden = !list.length;
    $('#back').onclick = function () { location.hash = parent || '#/'; };
  }

  /* ---------- 提示／抽屜 ---------- */
  var toastTimer = null;
  function toast(msg, o) {
    o = o || {};
    var el = $('#toast');
    el.className = o.bad ? 'bad' : '';
    el.innerHTML = '<span class="t">' + esc(msg) + '</span>' + (o.label ? '<button type="button">' + esc(o.label) + '</button>' : '');
    el.hidden = false;
    var b = $('button', el);
    if (b) b.onclick = function () { el.hidden = true; if (o.go) location.hash = o.go; if (o.act) o.act(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, o.ms || (o.label ? 8000 : 3500));
  }
  function sheet(html, mount) {
    var s = $('#sheet');
    s.innerHTML = '<div class="panel" role="dialog" aria-modal="true">' + html + '</div>';
    s.hidden = false;
    s.onclick = function (e) { if (e.target === s) closeSheet(); };
    $$('[data-close]', s).forEach(function (b) { b.onclick = closeSheet; });
    if (mount) mount($('.panel', s));
  }
  function closeSheet() { var s = $('#sheet'); s.hidden = true; s.innerHTML = ''; if (needRender) render(); }
  function dock(html, mount) {
    var d = $('#dock');
    if (!html) { d.hidden = true; $('.in', d).innerHTML = ''; return; }
    $('.in', d).innerHTML = html; d.hidden = false;
    if (mount) mount($('.in', d));
  }

  /* ---------- 路由 ---------- */
  function route() {
    var h = decodeURIComponent((location.hash || '#/').slice(1));
    var q = {}, qi = h.indexOf('?');
    if (qi >= 0) { h.slice(qi + 1).split('&').forEach(function (kv) { var p = kv.split('='); q[p[0]] = p[1] || ''; }); h = h.slice(0, qi); }
    var parts = h.split('/').filter(Boolean);
    return { parts: parts, q: q };
  }
  var needRender = false;
  /** 同步回來時：使用者正在打字或開著抽屜就先不要重畫（會把游標弄丟） */
  function renderSoft() {
    var a = document.activeElement;
    if (!$('#sheet').hidden || (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) { needRender = true; paintSync(); return; }
    render();
  }
  function render() {
    needRender = false;
    paintSync();
    if (!pw) return renderGate();
    if (!S.loaded) { crumbs([]); $('#view').innerHTML = '<p class="mute">正在跟雲端對資料…</p>'; return; }
    var r = route(), p = r.parts;
    dock('');
    var y = window.scrollY, same = render._last === location.hash;
    render._last = location.hash;
    if (!p.length) renderHome();
    else if (p[0] === 'get' && p[1]) renderPerson(p[1]);
    else if (p[0] === 'get') renderGet();
    else if ((p[0] === 'lend' || p[0] === 'back') && p[1]) renderGrid(p[0], p[1], r.q);
    else if (p[0] === 'lend' || p[0] === 'back') renderBranches(p[0], r.q);
    else if (p[0] === 'find') renderFind();
    else if (p[0] === 'mine') renderMine();
    else if (p[0] === 'prob') renderProblems();
    else { location.hash = '#/'; return; }
    if (same) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', function () { if (!$('#sheet').hidden) closeSheet(); render(); });

  /* ---------- 登入 ---------- */
  function renderGate(msg) {
    crumbs([]); dock('');
    $('#back').hidden = true;
    $('#view').innerHTML =
      '<div class="gate"><h1>小幫手借還台</h1><p class="sub">對講機借出、歸還都在這裡。</p>' +
      (msg ? '<div class="note">' + esc(msg) + '</div>' : '') +
      '<form id="gf" autocomplete="off">' +
      '<label class="field"><span>系統密碼</span><input class="box" id="gpw" type="password" autocomplete="current-password" required></label>' +
      '<label class="field"><span>你的名字（會記在「經手人」）</span><input class="box" id="gby" value="' + esc(by) + '" placeholder="例：櫃台 王師姐" required></label>' +
      '<div class="err" id="gerr" hidden></div>' +
      '<button class="btn pri wide" id="gok" type="submit">進入</button></form>' +
      '<p class="foot">版本 ' + BUILD + '　·　<a href="index.html">舊版畫面／後台</a></p>' + SITEINFO + '</div>';
    $('#gf').onsubmit = function (e) {
      e.preventDefault();
      var p = $('#gpw').value.replace(/^[\s　]+|[\s　]+$/g, ''), b = $('#gby').value.trim();
      var err = $('#gerr');
      if (!p || !b) { err.textContent = '密碼和名字都要填'; err.hidden = false; return; }
      $('#gok').disabled = true; $('#gok').textContent = '確認中…';
      pw = p; by = b;
      syncNow(true).then(function () {
        sess.set('xbsd_pw', pw); store.set('xbsd_by', by);
        render(); flush();
      }, function (ex) {
        pw = ''; $('#gok').disabled = false; $('#gok').textContent = '進入';
        err.textContent = ex.code === 'BAD_PASSWORD' ? '密碼不對，請再確認一次' : '連不上系統：' + ex.message + '，請再按一次';
        err.hidden = false;
      });
    };
  }
  function logout(msg) {
    pw = ''; sess.set('xbsd_pw', ''); S.loaded = false;
    closeSheet(); renderGate(msg);
  }

  /* ---------- 首頁 ---------- */
  function renderHome() {
    crumbs([]);
    var free = 0, out = 0, off = 0;
    S.devices.forEach(function (d) { var s = stateOf(d).s; if (s === 'out' || s === 'ghost') out++; else if (s === 'off') off++; else free++; });
    var backN = Object.keys(V.loans).filter(function (c) { return V.loans[c].st === '已還'; }).length;
    var ed = canEdit();
    $('#view').innerHTML =
      (problems.length ? '<button class="alert" type="button" onclick="location.hash=\'#/prob\'">⚠ 有 ' + problems.length + ' 筆沒有成功，點這裡處理</button>' : '') +
      (!ed ? '<div class="note">' + (S.role === 'guest' ? '訪客帳號：只能查看，不能借還。' : '「' + esc(S.event && S.event.name) + '」已經關閉，只能查看。') + '</div>' : '') +
      '<div class="stats">' +
      '<div class="stat out"><b>' + out + '</b><span>借出中</span></div>' +
      '<div class="stat"><b>' + free + '</b><span>可借</span></div>' +
      '<div class="stat"><b>' + backN + '</b><span>已歸還（次）</span></div></div>' +
      (ed ? '<div class="big3">' +
        '<button class="bigbtn main" type="button" data-go="#/get"><span class="ico">🙋</span><div><b>領取</b><span>名單上的人，找名字就領走預先排好的機器</span></div></button>' +
        '<button class="bigbtn" type="button" data-go="#/lend"><span class="ico">📻</span><div><b>借出</b><span>臨時來借、不在名單上：先點機器，再寫是誰</span></div></button>' +
        '<button class="bigbtn" type="button" data-go="#/back"><span class="ico">↩︎</span><div><b>歸還</b><span>只要點機器號碼</span></div></button>' +
        '</div>' : '') +
      '<div class="links">' +
      '<button class="linkrow" type="button" data-go="#/find"><span>🔍 查詢、還沒歸還的名單（' + out + ' 台）</span></button>' +
      (ed ? '<button class="linkrow" type="button" data-go="#/mine"><span>🕘 這支手機剛才做的（可復原）</span></button>' : '') +
      '<a class="linkrow" href="index.html"><span>⚙ 後台：名單、機台、列印（舊版畫面）</span></a>' +
      '</div>' +
      '<p class="foot">經手人：' + esc(by) + '　<a href="#" id="chgBy">換人</a>　·　<a href="#" id="lo">登出</a><br>版本 ' + BUILD + (off ? '　·　停用／維修 ' + off + ' 台' : '') + '</p>' + SITEINFO;
    $$('[data-go]').forEach(function (b) { b.onclick = function () { location.hash = b.getAttribute('data-go'); }; });
    $('#lo').onclick = function (e) {
      e.preventDefault();
      if (Q.length) { toast('還有 ' + Q.length + ' 筆還沒送出，等「✓ 已同步」再登出', { bad: true }); return; }
      logout('已登出');
    };
    $('#chgBy').onclick = function (e) {
      e.preventDefault();
      sheet('<h2>換經手人</h2><label class="field"><span>你的名字</span><input class="box" id="nb" value="' + esc(by) + '"></label>' +
        '<div class="acts"><button class="btn" data-close type="button">取消</button><button class="btn pri" id="nbok" type="button">好了</button></div>',
      function (p) {
        $('#nbok', p).onclick = function () { var v = $('#nb', p).value.trim(); if (!v) return; by = v; store.set('xbsd_by', by); closeSheet(); render(); };
      });
    };
  }

  /* ---------- 選分院 ---------- */
  function renderBranches(mode, q) {
    var title = mode === 'lend' ? '借出' : '歸還';
    crumbs([[title, '']]);
    var mq = q.mid ? '?mid=' + encodeURIComponent(q.mid) : '';
    var m = q.mid && memberById(q.mid);
    $('#view').innerHTML =
      '<h1>' + title + '：先選分院</h1>' +
      (m ? '<p class="sub">要借給 <b>' + esc(m.name) + '</b></p>' : '<p class="sub">機器貼的是哪個分院的編號？</p>') +
      '<div class="branches">' + branches().map(function (b) {
        var ds = devicesOf(b), f = 0, o = 0;
        ds.forEach(function (d) { var s = stateOf(d).s; if (s === 'free') f++; else if (s === 'out' || s === 'ghost') o++; });
        return '<button class="brbtn" type="button" data-b="' + esc(b) + '"><b>' + esc(b) + '</b><span>' +
          (mode === 'lend' ? '可借 ' + f + ' 台' : '借出中 ' + o + ' 台') + '</span></button>';
      }).join('') + '</div>' +
      (mode === 'back' ? '<h2>不知道是哪一台？</h2><button class="linkrow" type="button" onclick="location.hash=\'#/find\'"><span>用姓名找他借了哪幾台</span></button>' : '');
    $$('[data-b]').forEach(function (b) { b.onclick = function () { location.hash = '#/' + mode + '/' + encodeURIComponent(b.getAttribute('data-b')) + mq; }; });
  }

  /* ---------- 號碼格 ---------- */
  function renderGrid(mode, b, q) {
    var lend = mode === 'lend';
    crumbs([[lend ? '借出' : '歸還', '#/' + mode + (q.mid ? '?mid=' + encodeURIComponent(q.mid) : '')], [b, '']]);
    var sk = mode + '|' + b;
    if (selKey !== sk) { sel = {}; selKey = sk; gridFilter = ''; }
    var preset = q.mid && memberById(q.mid);
    var ds = devicesOf(b);
    var f = digits(gridFilter);
    $('#view').innerHTML =
      (preset ? '<div class="note">要借給 <b>' + esc(preset.name) + '</b>：點選機器，再按下面的「借出」</div>' : '') +
      '<div class="gridtools"><input class="box" id="gf" inputmode="numeric" placeholder="輸入號碼快速找，例：5" value="' + esc(gridFilter) + '" aria-label="輸入號碼快速找"></div>' +
      '<div class="legend">' + (lend
        ? '<span><i></i>可借（點一下選）</span><span><i style="background:var(--warn-soft)"></i>借出中</span>'
        : '<span><i style="background:var(--warn-soft)"></i>借出中（點一下選）</span><span><i style="opacity:.35"></i>沒借出</span>') + '</div>' +
      '<div class="grid" id="grid">' + ds.map(function (d) {
        var st = stateOf(d), n = d[1];
        if (f && digits(dispNo(b, n)).replace(/^0+/, '').indexOf(f.replace(/^0+/, '')) !== 0) return '';
        var cls = 'cell', small = '';
        if (st.s === 'out') { cls += ' out'; small = st.l.name; if (st.l.pending) cls += ' pending'; }
        else if (st.s === 'ghost') { cls += ' out'; small = '舊紀錄'; }
        else if (st.s === 'off') { cls += ' off'; small = st.why; }
        var selectable = lend ? (st.s === 'free' || st.s === 'off') : (st.s === 'out' || st.s === 'ghost');
        if (!selectable) cls += lend ? '' : ' dim';
        if (sel[n]) cls += ' sel';
        return '<button class="' + cls + '" type="button" data-n="' + esc(n) + '" aria-pressed="' + (!!sel[n]) + '"><b>' + esc(dispNo(b, n)) + '</b>' + (small ? '<small>' + esc(small) + '</small>' : '') + '</button>';
      }).join('') + '</div>' +
      (ds.length ? '' : '<p class="mute">這個分院還沒有機台。請到後台新增。</p>');

    var inp = $('#gf');
    inp.oninput = function () { gridFilter = inp.value; var pos = inp.selectionStart; render(); var i2 = $('#gf'); i2.focus(); try { i2.setSelectionRange(pos, pos); } catch (e) { /* */ } };
    inp.onkeydown = function (e) {
      if (e.key !== 'Enter') return;
      var cells = $$('#grid .cell'); if (cells.length === 1) cells[0].click();
    };
    $$('#grid .cell').forEach(function (c) {
      c.onclick = function () {
        var n = c.getAttribute('data-n'), d = findDev(b, n), st = stateOf(d);
        if (lend && st.s === 'out') return deviceInfo(d, st);
        if (!lend && (st.s === 'free' || st.s === 'off')) { toast(devLabel(b, n) + ' 沒有借出，不用歸還'); return; }
        if (sel[n]) delete sel[n]; else sel[n] = 1;
        if (gridFilter) { gridFilter = ''; }
        render();
      };
    });
    paintGridDock(mode, b, preset);
  }
  function selList() { return Object.keys(sel).sort(natCmp); }
  function paintGridDock(mode, b, preset) {
    var ns = selList();
    if (!ns.length) { dock(''); return; }
    var lend = mode === 'lend';
    dock('<button class="btn small" type="button" id="dclr">清除</button>' +
      '<button class="btn ' + (lend ? 'pri' : 'ok') + '" type="button" id="dgo">' +
      (lend ? '借出 ' + ns.length + ' 台' + (preset ? '給 ' + esc(preset.name) : '：填借用人') : '歸還 ' + ns.length + ' 台') + '</button>',
    function (d) {
      $('#dclr', d).onclick = function () { sel = {}; render(); };
      $('#dgo', d).onclick = function () { if (lend) lendSheet(b, ns, preset); else backSheet(b, ns); };
    });
  }

  function deviceInfo(d, st) {
    var l = st.l;
    sheet('<h2>' + esc(devLabel(d[0], d[1])) + '</h2>' +
      '<div class="sum"><div>在 <b>' + esc(who(l)) + '</b> 手上</div>' +
      (l.phone ? '<div>手機 <a href="tel:' + esc(digits(l.phone)) + '">' + esc(l.phone) + '</a></div>' : '') +
      '<div class="mute">借出 ' + esc(hm(l.outAt)) + (l.outBy ? '　經手 ' + esc(l.outBy) : '') + '</div></div>' +
      '<div class="acts"><button class="btn" data-close type="button">關閉</button>' +
      (canEdit() ? '<button class="btn ok" id="ib" type="button">他已經還了，登記歸還</button>' : '') + '</div>',
    function (p) {
      var bt = $('#ib', p);
      if (bt) bt.onclick = function () { closeSheet(); backSheet(d[0], [d[1]]); };
    });
  }

  /* ---------- 借出：一張表 ---------- */
  function groupNames() {
    var seen = {}, out = [];
    S.groups.forEach(function (g) { if (g.name && !seen[g.name]) { seen[g.name] = 1; out.push(g.name); } });
    Object.keys(V.loans).forEach(function (c) { var g = V.loans[c].group; if (g && !seen[g]) { seen[g] = 1; out.push(g); } });
    return out;
  }
  function searchMembers(t, limit) {
    t = String(t || '').trim(); if (!t) return [];
    var dg = digits(t);
    return S.members.filter(function (m) {
      var g = groupById(m.gid);
      return (m.name && m.name.indexOf(t) >= 0) || (dg.length >= 3 && digits(m.phone).indexOf(dg) >= 0) || (g && g.name && g.name.indexOf(t) >= 0);
    }).slice(0, limit || 50);
  }

  function lendSheet(b, ns, preset) {
    var picked = null;   // 從名單選到的人
    function personCard(m) {
      var g = groupById(m.gid) || {};
      return '<div class="row"><div class="who"><b>' + esc(m.name) + '</b><div>' + esc(g.name || '') + (m.phone ? '　' + esc(m.phone) : '') + '</div></div>' +
        '<button class="btn small" type="button" id="lchg">換人</button></div>';
    }
    sheet('<h2>借出 ' + ns.length + ' 台</h2>' +
      '<div class="picked">' + ns.map(function (n) { return '<span>' + esc(devLabel(b, n)) + '</span>'; }).join('') + '</div>' +
      '<div id="lwho"></div>' +
      '<div class="acts"><button class="btn" data-close type="button">取消</button><button class="btn pri" id="lok" type="button">借出</button></div>',
    function (p) {
      function paintWho() {
        var w = $('#lwho', p);
        if (picked) {
          w.innerHTML = personCard(picked);
          $('#lchg', p).onclick = function () { picked = null; paintWho(); };
        } else {
          w.innerHTML =
            '<label class="field"><span>從名單找（姓名或手機）</span><input class="box" id="lq" autocomplete="off" placeholder="打一兩個字就好"></label>' +
            '<div class="suggest" id="lsug"></div>' +
            '<p class="mute" style="margin:0 0 10px">名單上沒有的人，直接填下面三格：</p>' +
            '<label class="field"><span>姓名 <em>*</em></span><input class="box" id="lname" autocomplete="off"></label>' +
            '<label class="field"><span>組別 <em>*</em></span><input class="box" id="lgroup" list="lglist" autocomplete="off" value="' + esc(lastGroup) + '">' +
            '<datalist id="lglist">' + groupNames().map(function (g) { return '<option value="' + esc(g) + '">'; }).join('') + '</datalist></label>' +
            '<label class="field"><span>手機 <em>*</em>（催還要用）</span><input class="box" id="lphone" type="tel" inputmode="tel" autocomplete="off" placeholder="09xx-xxx-xxx"></label>' +
            '<div class="err" id="lerr" hidden></div>';
          var lq = $('#lq', p);
          lq.oninput = function () {
            var hits = searchMembers(lq.value, 6);
            $('#lsug', p).innerHTML = hits.map(function (m) {
              var g = groupById(m.gid) || {}, has = loansOfMember(m.id).length;
              return '<button class="row" type="button" data-mid="' + esc(m.id) + '"><div class="who"><b>' + esc(m.name) + '</b><div>' + esc(g.name || '') + '</div></div>' +
                (has ? '<span class="tag out">手上 ' + has + ' 台</span>' : '') + '</button>';
            }).join('') || (lq.value.trim() ? '<p class="mute" style="margin:0">名單上找不到，請直接填下面三格</p>' : '');
            $$('[data-mid]', p).forEach(function (r) { r.onclick = function () { picked = memberById(r.getAttribute('data-mid')); paintWho(); }; });
          };
          $('#lname', p).oninput = paintBtn;
        }
        paintBtn();
      }
      function paintBtn() {
        var nm = picked ? picked.name : (($('#lname', p) || {}).value || '').trim();
        var er = $('#lerr', p); if (er) er.hidden = true;
        $('#lok', p).textContent = '借出 ' + ns.length + ' 台' + (nm ? '給 ' + nm : '');
      }
      picked = preset || null;
      paintWho();
      var busy = false;
      $('#lok', p).onclick = function () {
        if (busy) return;
        var ops;
        if (picked) {
          ops = ns.map(function (n) { return { t: 'borrow', b: b, n: n, mid: picked.id, name: picked.name, group: (groupById(picked.gid) || {}).name || '', phone: picked.phone, src: '名單' }; });
        } else {
          var name = $('#lname', p).value.trim(), group = $('#lgroup', p).value.trim(), phone = $('#lphone', p).value.trim();
          var err = $('#lerr', p);
          var miss = [];
          if (!name) miss.push('姓名'); if (!group) miss.push('組別'); if (digits(phone).length < 8) miss.push('手機（至少 8 碼）');
          if (miss.length) { err.textContent = '還沒填：' + miss.join('、'); err.hidden = false; return; }
          lastGroup = group; sess.set('xbsd_lastgroup', group);
          ops = ns.map(function (n) { return { t: 'borrow', b: b, n: n, name: name, group: group, phone: phone, src: '臨時' }; });
        }
        busy = true;
        sel = {};
        closeSheet();
        enqueue(ops);
        undoToast('已借出 ' + ns.map(function (n) { return dispNo(b, n); }).join('、') + ' 給 ' + ops[0].name, ops);
      };
    });
  }

  /* ---------- 歸還：確認 ---------- */
  function backSheet(b, ns) {
    var miss = '';
    sheet('<h2>歸還 ' + ns.length + ' 台</h2>' +
      '<div class="sum">' + ns.map(function (n) {
        var l = V.open[key(b, n)];
        return '<div><b>' + esc(devLabel(b, n)) + '</b>　' + (l ? esc(who(l)) : '<span class="mute">（舊紀錄，查不到人）</span>') + '</div>';
      }).join('') + '</div>' +
      '<div class="field"><span>配件有沒有缺？</span></div>' +
      '<div class="chips" id="bm">' + ['配件齊全', '缺耳機', '缺充電線', '其他…'].map(function (t, i) {
        return '<button class="chip' + (i === 0 ? ' on' : '') + '" type="button" data-m="' + esc(t) + '">' + esc(t) + '</button>';
      }).join('') + '</div>' +
      '<label class="field" id="bow" hidden><span>缺什麼？</span><input class="box" id="bo" autocomplete="off"></label>' +
      '<div class="acts"><button class="btn" data-close type="button">取消</button><button class="btn ok" id="bok" type="button">確定歸還 ' + ns.length + ' 台</button></div>',
    function (p) {
      $$('#bm .chip', p).forEach(function (c) {
        c.onclick = function () {
          var t = c.getAttribute('data-m');
          if (t === '配件齊全') { $$('#bm .chip', p).forEach(function (x) { x.classList.toggle('on', x === c); }); }
          else { $('[data-m="配件齊全"]', p).classList.remove('on'); c.classList.toggle('on'); }
          if (!$$('#bm .chip.on', p).length) $('[data-m="配件齊全"]', p).classList.add('on');
          $('#bow', p).hidden = !$('[data-m="其他…"]', p).classList.contains('on');
        };
      });
      var done = false;
      $('#bok', p).onclick = function () {
        if (done) return; done = true;
        var parts = $$('#bm .chip.on', p).map(function (c) { return c.getAttribute('data-m'); }).filter(function (t) { return t !== '配件齊全' && t !== '其他…'; });
        if ($('[data-m="其他…"]', p).classList.contains('on') && $('#bo', p).value.trim()) parts.push($('#bo', p).value.trim());
        miss = parts.join('、');
        var ops = ns.map(function (n) { return { t: 'return', b: b, n: n, missing: miss }; });
        var targets = ns.map(function (n) { var l = V.open[key(b, n)]; return l ? l.cid : ''; });
        sel = {};
        closeSheet();
        enqueue(ops);
        undoToast('已歸還 ' + ns.map(function (n) { return dispNo(b, n); }).join('、') + (miss ? '（' + miss + '）' : ''), ops, targets);
      };
    });
  }

  /* ---------- 復原 ---------- */
  function undoToast(msg, ops, targets) {
    toast(msg, { label: '復原', ms: 9000, act: function () { undoOps(ops, targets); } });
  }
  /** 還沒送出的直接從排隊拿掉；已經送出的就送一筆「取消」 */
  function undoOps(ops, targets) {
    var send = [];
    ops.forEach(function (op, i) {
      var qi = inQueue(op.cid);
      if (qi >= 0 && !inflight[op.cid]) { Q.splice(qi, 1); markMine(op.cid, 'undone'); return; }
      if (op.t === 'borrow') send.push({ t: 'undo', target: op.cid, what: 'borrow', b: op.b, n: op.n, name: op.name });
      else if (op.t === 'return') {
        var tg = (targets && targets[i]) || '';
        if (!tg) { var l = findReturned(op); tg = l && l.cid; }
        if (tg) send.push({ t: 'undo', target: tg, what: 'return', b: op.b, n: op.n });
      }
    });
    saveQ();
    if (send.length) enqueue(send); else { rebuild(); render(); }
    toast('已復原');
  }
  function findReturned(op) {
    var hit = null;
    Object.keys(V.loans).forEach(function (c) { var l = V.loans[c]; if (l.b === op.b && l.n === op.n && l.st === '已還') { if (!hit || (l.inAt || '') > (hit.inAt || '')) hit = l; } });
    return hit;
  }
  function markMine(cid, st) { mine.forEach(function (m) { if (m.cid === cid) m.st = st; }); saveMine(); }

  /* ---------- 領取（名單上的人） ---------- */
  function renderGet() {
    crumbs([['領取', '']]);
    var hits = searchMembers(getQuery, 60);
    $('#view').innerHTML =
      '<div class="gridtools"><input class="box" id="gq" placeholder="姓名、手機末幾碼或組別" autocomplete="off" value="' + esc(getQuery) + '" aria-label="找人"></div>' +
      (getQuery.trim()
        ? (hits.length ? '<div class="list">' + hits.map(personRow).join('') + '</div>'
          : '<p class="mute">名單上找不到「' + esc(getQuery) + '」。</p><button class="btn pri wide" type="button" onclick="location.hash=\'#/lend\'">他不在名單上 → 改用「借出」</button>')
        : '<p class="sub">打名字找人，點進去就能領取預先排好的機器。</p><p class="mute">名單上沒有的人，回首頁按「借出」。</p>');
    var gq = $('#gq');
    gq.oninput = function () { getQuery = gq.value; var pos = gq.selectionStart; render(); var g2 = $('#gq'); g2.focus(); try { g2.setSelectionRange(pos, pos); } catch (e) { /* */ } };
    if (!getQuery) gq.focus();
    $$('[data-mid]').forEach(function (r) { r.onclick = function () { location.hash = '#/get/' + encodeURIComponent(r.getAttribute('data-mid')); }; });
  }
  function personRow(m) {
    var g = groupById(m.gid) || {}, has = loansOfMember(m.id);
    var tag = has.length ? '<span class="tag out">手上 ' + has.length + ' 台</span>'
      : m.pre.length ? '<span class="tag pre">預先 ' + esc(m.pre.join('、')) + '</span>' : '<span class="tag">未指派</span>';
    return '<button class="row" type="button" data-mid="' + esc(m.id) + '"><div class="who"><b>' + esc(m.name) + '</b><div>' + esc(g.name || '') + (g.b ? '・' + esc(g.b) : '') + '</div></div>' + tag + '</button>';
  }

  /** 名單上預先寫的編號有好幾種寫法（21／善覺001／圓道33），對到清冊上真正那一台 */
  function resolvePre(token, gb) {
    var t = String(token).trim(), b = gb, rest = t;
    branches().concat(BR_ORDER).forEach(function (x) { if (t.indexOf(x) === 0 && t.length > x.length) { b = x; rest = t.slice(x.length); } });
    if (!b) return { b: '', n: t, d: null };
    var d = findDev(b, t) || findDev(b, rest);
    if (!d && digits(rest)) {
      var want = digits(rest).replace(/^0+/, '');
      var hits = devicesOf(b).filter(function (x) { var dn = dispNo(b, x[1]); return /^\d+$/.test(dn) && dn.replace(/^0+/, '') === want; });
      if (hits.length === 1) d = hits[0];
    }
    return { b: b, n: d ? d[1] : rest, d: d };
  }

  function renderPerson(mid) {
    var m = memberById(mid);
    if (!m) { crumbs([['領取', '#/get'], ['找不到', '']]); $('#view').innerHTML = '<p>名單上找不到這位，可能剛被改過。</p>'; return; }
    var g = groupById(m.gid) || {};
    crumbs([['領取', '#/get'], [m.name, '']]);
    var b = g.b || '';
    var mineL = loansOfMember(m.id);
    var shown = {};
    var lines = m.pre.map(function (tok) {
      var r = resolvePre(tok, b), d = r.d, pb = r.b, n = r.n;
      if (!d) return '<div class="devline"><label><b>' + esc(tok) + '</b></label><span class="tag">清冊找不到這台</span></div>';
      shown[key(pb, n)] = 1;
      var st = stateOf(d);
      if (st.s === 'out' && st.l.mid === m.id) return '<div class="devline"><label><b>' + esc(devLabel(pb, n)) + '</b></label><span class="tag out">在他手上</span></div>';
      if (st.s === 'out') return '<div class="devline"><label><b>' + esc(devLabel(pb, n)) + '</b></label><span class="tag out">在 ' + esc(st.l.name) + ' 手上</span></div>';
      return '<div class="devline"><label><input type="checkbox" data-b="' + esc(pb) + '" data-n="' + esc(n) + '" checked><b>' + esc(devLabel(pb, n)) + '</b></label>' +
        (st.s === 'off' ? '<span class="tag">' + esc(st.why) + '</span>' : '<span class="tag back">可領</span>') + '</div>';
    }).join('');
    var extra = mineL.filter(function (l) { return !shown[key(l.b, l.n)]; }).map(function (l) {
      return '<div class="devline"><label><b>' + esc(devLabel(l.b, l.n)) + '</b></label><span class="tag out">在他手上</span></div>';
    }).join('');
    var ed = canEdit();
    $('#view').innerHTML =
      '<div class="card"><h3>' + esc(m.name) + '</h3><div class="mute">' + esc(g.name || '') + (b ? '・借用分院 ' + esc(b) : '') +
      (m.phone ? '　<a href="tel:' + esc(digits(m.phone)) + '">' + esc(m.phone) + '</a>' : '') + '</div></div>' +
      '<h2>預先排好的機器</h2>' +
      '<div class="card">' + (lines || '<p class="mute" style="margin:0">沒有預先指派。按下面「幫他挑機器」。</p>') + '</div>' +
      (extra ? '<h2>另外借的</h2><div class="card">' + extra + '</div>' : '') +
      (ed ? '<div class="links">' +
        (b ? '<button class="linkrow" type="button" id="pick"><span>幫他挑機器（' + esc(b) + '）</span></button>' : '') +
        '<button class="linkrow" type="button" id="pick2"><span>從別的分院挑機器</span></button>' +
        (mineL.length ? '<button class="linkrow" type="button" id="pback"><span>他要歸還（手上 ' + mineL.length + ' 台）</span></button>' : '') +
        '</div>' : '');
    var mq = '?mid=' + encodeURIComponent(m.id);
    if ($('#pick')) $('#pick').onclick = function () { location.hash = '#/lend/' + encodeURIComponent(b) + mq; };
    if ($('#pick2')) $('#pick2').onclick = function () { location.hash = '#/lend' + mq; };
    if ($('#pback')) $('#pback').onclick = function () { returnPerson(mineL); };
    function paint() {
      var ns = $$('#view input[type=checkbox]:checked').map(function (c) { return { b: c.getAttribute('data-b'), n: c.getAttribute('data-n') }; });
      if (!ed || !ns.length) { dock(''); return; }
      var lbl = ns.map(function (x) { return x.b === b ? dispNo(x.b, x.n) : devLabel(x.b, x.n); }).join('、');
      dock('<button class="btn pri" type="button" id="pget">領取 ' + ns.length + ' 台（' + esc(lbl) + '）</button>', function (d) {
        var done = false;
        $('#pget', d).onclick = function () {
          if (done) return; done = true;
          var ops = ns.map(function (x) { return { t: 'borrow', b: x.b, n: x.n, mid: m.id, name: m.name, group: g.name || '', phone: m.phone, src: '預先' }; });
          enqueue(ops);
          undoToast(m.name + ' 已領取 ' + lbl, ops);
          getQuery = ''; location.hash = '#/get';
        };
      });
    }
    $$('#view input[type=checkbox]').forEach(function (c) { c.onchange = paint; });
    paint();
  }
  /** 一個人手上的好幾台（可能跨分院）一起還 */
  function returnPerson(list) {
    var byB = {};
    list.forEach(function (l) { (byB[l.b] = byB[l.b] || []).push(l.n); });
    var bs = Object.keys(byB);
    if (bs.length === 1) return backSheet(bs[0], byB[bs[0]]);
    sheet('<h2>他手上有不同分院的機器</h2><p class="sub">一個分院一個分院還：</p><div class="list">' + bs.map(function (b) {
      return '<button class="row" type="button" data-b="' + esc(b) + '"><div class="who"><b>' + esc(b) + '</b><div>' + esc(byB[b].map(function (n) { return dispNo(b, n); }).join('、')) + '</div></div></button>';
    }).join('') + '</div><div class="acts"><button class="btn" data-close type="button">取消</button></div>', function (p) {
      $$('[data-b]', p).forEach(function (r) { r.onclick = function () { var b = r.getAttribute('data-b'); closeSheet(); backSheet(b, byB[b]); }; });
    });
  }

  /* ---------- 查詢＋還沒歸還 ---------- */
  function renderFind() {
    crumbs([['查詢', '']]);
    var t = findQuery.trim(), dg = digits(t);
    var outs = openLoans();
    var hits = t ? outs.filter(function (l) {
      return (l.name || '').indexOf(t) >= 0 || (l.group || '').indexOf(t) >= 0 || (dg.length >= 3 && digits(l.phone).indexOf(dg) >= 0) ||
        (dg && digits(dispNo(l.b, l.n)).replace(/^0+/, '') === dg.replace(/^0+/, ''));
    }) : outs;
    var groups = {};
    hits.forEach(function (l) { (groups[l.group || '（沒寫組別）'] = groups[l.group || '（沒寫組別）'] || []).push(l); });
    var gnames = Object.keys(groups).sort();
    var ed = canEdit();
    $('#view').innerHTML =
      '<div class="gridtools"><input class="box" id="fq" placeholder="姓名、組別、手機或機器號碼" autocomplete="off" value="' + esc(findQuery) + '" aria-label="查詢"></div>' +
      '<p class="sub">' + (t ? '找到 ' + hits.length + ' 台借出中' : '還沒歸還的，共 <b>' + outs.length + '</b> 台') + '</p>' +
      gnames.map(function (gn) {
        return '<h2>' + esc(gn) + '（' + groups[gn].length + '）</h2><div class="list">' + groups[gn].sort(function (a, b) { return a.name < b.name ? -1 : 1; }).map(function (l) {
          return '<div class="row"><div class="who"><b>' + esc(l.name) + '</b>　' + esc(devLabel(l.b, l.n)) +
            '<div>' + (l.phone ? '<a href="tel:' + esc(digits(l.phone)) + '">' + esc(l.phone) + '</a>　' : '') + '借出 ' + esc(String(l.outAt || '').slice(5, 16)) + '</div></div>' +
            (ed ? '<button class="btn small" type="button" data-b="' + esc(l.b) + '" data-n="' + esc(l.n) + '">歸還</button>' : '') + '</div>';
        }).join('') + '</div>';
      }).join('') +
      (outs.length && !t && S.role !== 'guest' ? '<h2>催還名單</h2><button class="btn wide" type="button" id="cp">複製催還名單（貼到 LINE）</button><textarea class="box copybox" id="cpt" readonly hidden></textarea>' : '') +
      (t && !hits.length ? '<p class="mute">沒有符合的借出中機器。</p>' : '');
    var fq = $('#fq');
    fq.oninput = function () { findQuery = fq.value; var pos = fq.selectionStart; render(); var f2 = $('#fq'); f2.focus(); try { f2.setSelectionRange(pos, pos); } catch (e) { /* */ } };
    $$('[data-n]').forEach(function (bt) { bt.onclick = function () { backSheet(bt.getAttribute('data-b'), [bt.getAttribute('data-n')]); }; });
    var cp = $('#cp');
    if (cp) cp.onclick = function () {
      var txt = '【小幫手未歸還】' + (S.event ? S.event.name : '') + '　' + now19().slice(5, 16) + '\n' + gnames.map(function (gn) {
        return '▍' + gn + '\n' + groups[gn].map(function (l) { return '・' + l.name + '　' + devLabel(l.b, l.n) + (l.phone ? '　' + l.phone : ''); }).join('\n');
      }).join('\n') + '\n請盡快送回借還台，謝謝！';
      var ta = $('#cpt'); ta.value = txt; ta.hidden = false; ta.select();
      var okc = false;
      try { okc = document.execCommand('copy'); } catch (e) { /* */ }
      if (okc) { toast('已複製，貼到 LINE 就可以'); return; }
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast('已複製'); }, function () { toast('請長按下面框框全選複製'); });
      else toast('請長按下面框框全選複製');
    };
  }

  /* ---------- 這支手機剛才做的 ---------- */
  function renderMine() {
    crumbs([['剛才做的', '']]);
    var probC = {}; problems.forEach(function (p) { probC[p.op.cid] = 1; });
    var names = { borrow: '借出', 'return': '歸還', undo: '復原' };
    $('#view').innerHTML = '<p class="sub">只列這支手機做的，最新的在上面。</p><div class="list">' +
      (mine.map(function (x) {
        var st = x.st === 'undone' ? '<span class="tag">已復原</span>' : probC[x.cid] ? '<span class="tag" style="color:var(--danger)">沒成功</span>'
          : inQueue(x.cid) >= 0 ? '<span class="tag pre">⏳ 送出中</span>' : '<span class="tag back">✓ 已存</span>';
        var l = x.t === 'borrow' ? V.loans[x.cid] : null;
        var canUndo = canEdit() && x.st !== 'undone' && !probC[x.cid] && ((x.t === 'borrow' && l && l.st === '借出') || (x.t === 'return' && findReturned(x) && !V.open[key(x.b, x.n)]));
        return '<div class="row"><div class="who"><b>' + names[x.t] + '　' + esc(devLabel(x.b, x.n)) + '</b><div>' + esc(hm(x.at)) + (x.name ? '　' + esc(x.name) : '') + '</div></div>' + st +
          (canUndo ? '<button class="btn small" type="button" data-u="' + esc(x.cid) + '">復原</button>' : '') + '</div>';
      }).join('') || '<p class="mute">還沒有。</p>') + '</div>';
    $$('[data-u]').forEach(function (bt) {
      bt.onclick = function () {
        var x = mine.filter(function (m) { return m.cid === bt.getAttribute('data-u'); })[0];
        if (!x) return;
        sheet('<h2>確定復原？</h2><div class="sum">' + (x.t === 'borrow' ? '取消這筆借出：' : '取消這筆歸還（變回借出中）：') + '<b>' + esc(devLabel(x.b, x.n)) + '</b>' + (x.name ? '　' + esc(x.name) : '') + '</div>' +
          '<div class="acts"><button class="btn" data-close type="button">不要</button><button class="btn pri" id="uok" type="button">確定復原</button></div>', function (p) {
          $('#uok', p).onclick = function () {
            closeSheet();
            var op = { cid: x.cid, t: x.t, b: x.b, n: x.n, name: x.name };
            var tg = x.t === 'return' ? (findReturned(x) || {}).cid : '';
            undoOps([op], [tg]); markMine(x.cid, 'undone');
          };
        });
      };
    });
  }

  /* ---------- 沒成功的 ---------- */
  function renderProblems() {
    crumbs([['沒成功的', '']]);
    $('#view').innerHTML = (problems.length ? '<p class="sub">這些動作雲端沒有收下，請一筆一筆決定：</p>' : '<p class="sub">都處理好了。</p>') +
      '<div class="list">' + problems.map(function (p, i) {
        var op = p.op, title = (op.t === 'borrow' ? '借出 ' : op.t === 'return' ? '歸還 ' : '復原 ') + devLabel(op.b || '', op.n || '') + (op.name ? ' → ' + op.name : '');
        var acts = '<button class="btn small" type="button" data-i="' + i + '" data-a="drop">' + (op.t === 'borrow' ? '不借了' : '知道了') + '</button>';
        if (op.t === 'borrow' && (p.code === 'DEVICE_BUSY' || p.code === 'DEVICE_OFF') && canEdit()) {
          acts += '<button class="btn small" type="button" data-i="' + i + '" data-a="force" style="color:var(--accent)">' +
            (p.code === 'DEVICE_BUSY' ? esc(p.holder || '上一位') + ' 已經還了，照樣借出' : '照樣借出') + '</button>';
        }
        return '<div class="card"><b>' + esc(title) + '</b><div style="color:var(--danger);margin:4px 0 10px">' + esc(p.error) + '</div>' +
          '<div class="mute" style="margin-bottom:8px">' + esc(hm(p.at)) + '</div><div style="display:flex;gap:8px;flex-wrap:wrap">' + acts + '</div></div>';
      }).join('') + '</div>' +
      '<button class="btn wide" type="button" onclick="location.hash=\'#/\'" style="margin-top:14px">回首頁</button>';
    $$('[data-a]').forEach(function (bt) {
      bt.onclick = function () {
        var i = +bt.getAttribute('data-i'), p = problems[i];
        if (!p) return;
        problems.splice(i, 1); saveProb();
        if (bt.getAttribute('data-a') === 'force') {
          var op = Object.assign({}, p.op, { force: true, at: now19() });
          Q.push(op); saveQ(); rebuild(); flush();
          toast('已重新送出');
        }
        render();
      };
    });
  }

  /* ---------- 開機 ---------- */
  rebuild();
  if (pw) {
    render();
    syncNow(true).then(function () { render(); flush(); }, function (e) {
      if (e.code !== 'BAD_PASSWORD') $('#view').innerHTML = '<p>連不上系統：' + esc(e.message) + '</p><button class="btn pri wide" type="button" onclick="location.reload()">再試一次</button>';
    });
  } else render();
})();
