/* 寶嚴小幫手（對講機）借用系統 — 前台
   資料全部放在後端試算表，這個網頁本身不含任何名單。 */
(function () {
'use strict';

/* ===================== 基礎 ===================== */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
/** 綁事件：元素不存在就安靜略過。
 *  （HTML 與 JS 版本不同步時，少一個元素不該讓整支程式停掉、連登入都按不動） */
function on(sel, ev, fn) {
  var el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (el) el.addEventListener(ev, fn);
  else if (window.console) console.warn('找不到元素，略過綁定：' + sel);
  return el;
}

var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};

var BUILD = '20261020b';
var BRANCHES = ['善覺', '善學', '圓道'];

/** 密碼比對前先去掉前後空白（含全形空白）：手機鍵盤很容易多打一個 */
function cleanPw(s) { return String(s == null ? '' : s).replace(/^[\s　]+|[\s　]+$/g, ''); }

var state = { settings: {}, groups: [], members: [], devices: [], logs: [] };
var pw = '';
var operator = '';
var loading = false;
var adminOn = false;
var role = 'admin';              // admin＝工作人員（可領取歸還、可進後台）／guest＝訪客，只能看
var dashMode = 'branch';         // 總覽看哪一種：branch＝看分院、device＝看機台
var counterMode = '';            // 領取／歸還頁看哪一類：''＝全部、free＝手上沒機器可領、out＝待歸還、back＝已歸還
var viewEventId = null;          // 正在看哪一場活動（null＝目前這一場）
var adminBy = sessionStorage.getItem('xbs_adminby') || '';   // 誰進的後台，會記進紀錄

/** 這個畫面現在能不能改東西：訪客不行，已關閉的活動也不行 */
function readOnly() {
  if (isGuest()) return true;
  var ev = state.event;
  return !!(ev && ev['狀態'] && ev['狀態'] !== '進行中');
}
function isGuest() { return role === 'guest'; }

function backendUrl() {
  return (localStorage.getItem('xbs_backend') || (window.CONFIG && window.CONFIG.backend) || '').trim();
}

function toast(msg, bad) {
  var t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.className = ''; }, bad ? 4200 : 2300);
}

/* ===================== 後端 ===================== */
/** 對外的入口：密碼失效時先請使用者重新輸入，再把原本的動作重做一次 */
function api(action, payload, tries) {
  return rawApi(action, payload, tries).catch(function (e) {
    // 還沒登入進來的時候（登入畫面still在）不要跳重新輸入，讓登入流程自己處理
    if (!e || e.code !== 'BAD_PASSWORD' || $('#gate')) throw e;
    return reauth().then(function (ok) {
      if (!ok) throw e;
      return rawApi(action, payload, tries);
    });
  });
}

/** 重送會多建一筆的動作，不自動重試 */
var NO_RETRY = { addMember: 1, createEvent: 1 };

function rawApi(action, payload, tries) {
  var url = backendUrl();
  if (!url) return Promise.reject(new Error('還沒設定後端網址'));
  var who = (adminOn && adminBy) ? adminBy : operator;
  var body = Object.assign({ action: action, pw: pw, by: who }, payload || {});
  if (viewEventId && body.eventId == null) body.eventId = viewEventId;
  // 這幾個沒有冪等保護，重送會多出一筆而且畫面顯示成功 → 寧可讓人自己按 ↻ 確認
  tries = tries == null ? (NO_RETRY[action] ? 0 : 4) : tries;

  // 每次請求都有上限，網路卡住時不會無止境地等下去
  var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  // 必須大於後端 LockService.waitLock(25000)，否則排隊中就被自己中斷、重送造成重複寫入
  var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 30000) : null;

  return fetch(url, {
    method: 'POST',
    // 用 text/plain 送，避免瀏覽器先發 OPTIONS（Apps Script 不處理 preflight）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
    signal: ctrl ? ctrl.signal : undefined,
  })
    .then(function (r) { if (timer) clearTimeout(timer); return r.text(); })
    .then(function (txt) {
      var data;
      try { data = JSON.parse(txt); }
      catch (e) {
        // Google 偶爾會回一頁 HTML 中繼頁，不是真的壞掉，重送就好
        var bad = new Error('連線被 Google 暫時擋下');
        bad.retryable = true;
        throw bad;
      }
      if (!data.ok) {
        var err = new Error(data.error || '操作失敗');
        err.code = data.code;
        err.data = data;        // 後端附帶的細節（例如還沒歸還的人名）
        // 別人正在存檔 → 自己等一下重送，不要丟給現場的人處理
        if (data.code === 'BUSY') err.retryable = true;
        // 這幾種都代表「我手上的畫面跟雲端對不上了」→ 自己去把最新的抓回來
        if (data.code === 'DEVICE_BUSY' || data.code === 'ALREADY_OUT' || data.code === 'EVENT_CLOSED') {
          setTimeout(function () { load(true).catch(function () {}); }, 400);
        }
        throw err;
      }
      return data;
    })
    .catch(function (e) {
      if (timer) clearTimeout(timer);
      if (e && e.name === 'AbortError') { e = new Error('連線逾時'); e.retryable = true; }
      var retryable = e.retryable || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
      if (tries > 0 && retryable) {
        var waitMs = 700 * (5 - tries);
        return new Promise(function (res) { setTimeout(res, waitMs); })
          .then(function () { return rawApi(action, payload, tries - 1); });
      }
      if (retryable) e.message = '連不上系統（網路不穩或剛好在更新），等十秒再按一次';
      throw e;
    });
}

/* ===================== 自動更新 ===================== */
/**
 * 現場會有好幾位執事同時在不同手機上登記。沒有自動更新的話，
 * 每支手機的畫面幾分鐘後就各自過期，兩個人會對著不同的真相操作。
 * 但也不能說更新就更新——正在打字、正在看對話框、有沒存的改動時都要讓開。
 */
var AUTO_MS = 75000;          // 每 75 秒看一次。太勤會被 Google 前端節流，反而整批變慢
var autoFails = 0;            // 連續失敗就拉長間隔，不要雪上加霜
var IDLE_MS = 8000;           // 剛碰過畫面的 8 秒內不要動他
var lastTouch = 0;
var autoTimer = null;

function markTouch() { lastTouch = Date.now(); }

function canAutoRefresh() {
  if (document.hidden) return false;                       // 手機收在口袋裡就別打了
  if ($('#gate')) return false;                            // 還沒登入
  if (loading) return false;                               // 已經在載了
  var dlg = $('#dlg');
  if (dlg && dlg.open) return false;                       // 正在對話框裡做事
  if (Object.keys(pending).length || Object.keys(pendingQty).length) return false;  // 有沒存的改動
  if (document.activeElement && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return false;
  if (Date.now() - lastTouch < IDLE_MS) return false;      // 剛剛還在操作
  return true;
}

var autoSkip = 0;
function autoRefresh() {
  if (!canAutoRefresh()) return;
  // 連續失敗就隔幾輪才試一次，別在後端已經喘不過氣時雪上加霜
  if (autoFails > 0) {
    autoSkip++;
    if (autoSkip < Math.min(autoFails + 1, 5)) return;
    autoSkip = 0;
  }
  var y = window.scrollY;                                  // 重畫之後把捲動位置放回去，不要讓人跟丟
  load(true)
    .then(function () { autoFails = 0; window.scrollTo(0, y); })
    .catch(function () { autoFails++; });
}

/** 窄螢幕（手機直放）：頁首要省字，不然「小幫手借用」會被擠成直排 */
function narrow() { return window.innerWidth <= 620; }

/** 把頁首實際高度餵給 CSS，底下那條跟著捲動的搜尋列才貼得準（頁首高度會隨字數變） */
function paintHeaderVar() {
  var hd = $('header.top');
  if (hd) document.documentElement.style.setProperty('--hdr', Math.round(hd.getBoundingClientRect().height) + 'px');
}

function startAuto() {
  if (autoTimer) return;
  autoTimer = setInterval(autoRefresh, AUTO_MS);
  ['click', 'keydown', 'input', 'touchstart', 'scroll'].forEach(function (ev) {
    document.addEventListener(ev, markTouch, { passive: true });
  });
  // 手機從口袋拿出來的那一刻，先把最新的抓回來
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { markTouch(); setTimeout(autoRefresh, IDLE_MS + 200); }
  });
}

/* ===================== 資料正規化 ===================== */
function norm() {
  state.groups = (state.raw.groups || []).map(function (g) {
    return {
      id: g.id, zone: g['分區'], zoneName: g['分區名稱'], seq: g['項次'],
      name: g['組別'], leader: g['組長'], branch: g['借用分院'],
      qty: parseInt(g['數量'], 10) || 0, items: g['借用項目'] || '',
      note: g['備註'] || '', disabled: !!g['停用'],
    };
  }).filter(function (g) { return !g.disabled; });

  state.members = (state.raw.members || []).map(function (m) {
    return {
      id: m.id, groupId: m['組別id'], name: m['姓名'], phone: m['行動電話'],
      no: m['小幫手編號'], outAt: m['領取時間'], outBy: m['領取經手'],
      inAt: m['歸還時間'], inBy: m['歸還經手'], missing: m['配件缺漏'], note: m['備註'],
      days: String(m['領用日期'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean),
    };
  });

  state.devices = (state.raw.devices || []).map(function (d) {
    return { branch: d['分院'], no: d['編號'], status: d['狀態'] || '可用', memberId: d['借用成員id'], note: d['備註'] };
  });

  // 紀錄不再跟著 load 回來（那張表會一路長大）。已經載過的就留著，不要被空陣列洗掉。
  if ((state.raw.logs || []).length || !logsLoaded) {
    state.logs = (state.raw.logs || []).map(function (l) {
      return { at: l['時間'], act: l['動作'], branch: l['分院'], group: l['組別'], name: l['姓名'], no: l['編號'], detail: l['內容'], by: l['經手'] };
    });
  }

  state.gById = {};
  state.groups.forEach(function (g) { state.gById[g.id] = g; });
  state.members.forEach(function (m) { m.group = state.gById[m.groupId] || null; });
  state.members = state.members.filter(function (m) { return m.group; });

  // 同一個名字出現在兩組以上 → 標註出來，現場才知道是不是同一個人要領兩台
  var by = {};
  state.members.forEach(function (m) {
    var k = m.name.replace(/\s/g, '');
    (by[k] = by[k] || []).push(m);
  });
  state.dups = {};
  Object.keys(by).forEach(function (k) {
    if (by[k].length < 2) return;
    state.dups[k] = by[k];
    by[k].forEach(function (m) { m.dup = by[k]; });
  });
}

/* ---------- 領用日期 ---------- */
function allDays() { return (state.settings.days && state.settings.days.length) ? state.settings.days : ['21', '22', '23', '24', '25', '26', '27']; }

/** 日期縮寫：全部→「全程」；連續→「21–24」；其他→「21、23、27」 */
function daysLabel(days) {
  var all = allDays();
  if (!days || !days.length) return '未填';
  if (days.length === all.length) return '全程';
  var nums = days.map(Number).sort(function (a, b) { return a - b; });
  var cont = nums.every(function (n, i) { return i === 0 || n === nums[i - 1] + 1; });
  return cont && nums.length > 2 ? nums[0] + '–' + nums[nums.length - 1] : nums.join('、');
}

function daysPicker(selected) {
  var all = allDays();
  return '<div class="daypick">' + all.map(function (d) {
    var on = selected.indexOf(d) >= 0;
    return '<label class="day' + (on ? ' on' : '') + '"><input type="checkbox" value="' + esc(d) + '"' + (on ? ' checked' : '') + '><span>' + esc(d) + '</span></label>';
  }).join('') +
    '</div><div style="display:flex;gap:6px;margin-top:8px">' +
    '<button type="button" class="btn sm ghost" data-days="all">全選</button>' +
    '<button type="button" class="btn sm ghost" data-days="none">全不選</button></div>';
}

function wireDays(body) {
  body.addEventListener('click', function (e) {
    var b = e.target.closest('[data-days]');
    if (b) {
      e.preventDefault();
      $$('.daypick input', body).forEach(function (c) {
        c.checked = b.dataset.days === 'all';
        c.closest('.day').classList.toggle('on', c.checked);
      });
      return;
    }
    var lab = e.target.closest('.day');
    if (lab) setTimeout(function () { lab.classList.toggle('on', $('input', lab).checked); }, 0);
  });
}

function readDays(body) {
  return $$('.daypick input:checked', body).map(function (c) { return c.value; });
}

/** 這個人重複出現在哪些組（不含自己） */
function dupOthers(m) {
  if (!m.dup) return [];
  return m.dup.filter(function (x) { return x.id !== m.id; })
    .map(function (x) { return x.group.name + '（' + x.group.branch + '）'; });
}

function statusOf(m) { return m.inAt ? 'back' : (m.outAt ? 'out' : 'idle'); }
function statusLabel(s) { return { idle: '尚未領取', out: '領取中', back: '已歸還' }[s]; }

var loadingPromise = null;
var loadToken = 0;
var logsLoaded = false;      // 操作紀錄改成點進分頁才載（那張表會一路長大）
var logsLoading = false;
function load(fresh) {
  // 同時被呼叫時共用同一個請求。千萬不能直接回一個「成功」的空 Promise，
  // 否則呼叫端會以為載好了，畫面就卡在半路。
  // 但 fresh=true（剛寫入過）絕不可以共用——那個請求是寫入「之前」發出的，
  // 拿到的是舊快照，畫面會把剛領走的人顯示成還沒領。
  if (loadingPromise && !fresh) return loadingPromise;
  var myToken = ++loadToken;
  loading = true;
  var rb = $('#btnReload');
  if (rb) rb.disabled = true;
  var p = api('load')
    .then(function (d) {
      if (myToken !== loadToken) return d;   // 已經有更新的一次載入，這份是舊的，不要拿來畫
      state.raw = d;
      state.settings = d.settings || {};
      state.events = d.events || [];
      state.event = d.event || null;
      state.eventId = d.eventId || null;
      state.currentEventId = d.currentEventId || null;
      state.canEdit = d.canEdit !== false;
      role = d.role || 'admin';
      norm();
      renderAll();
      var ha = $('#hdActivity');
      if (ha) ha.textContent = state.settings.activity || (window.CONFIG && window.CONFIG.subtitle) || '';
      paintHeaderVar();   // 活動名稱長短會改變頁首高度
      return d;
    })
    .finally(function () {
      if (myToken !== loadToken) return;
      loading = false;
      loadingPromise = null;
      var b = $('#btnReload');
      if (b) b.disabled = false;
    });
  loadingPromise = p;
  return p;
}

/* ===================== 對話框 ===================== */
function dialog(opts) {
  return new Promise(function (resolve) {
    var dlg = $('#dlg');
    $('#dlgTitle').textContent = opts.title || '';
    $('#dlgBody').innerHTML = opts.body || '';
    var foot = $('#dlgFoot');
    foot.innerHTML = '';
    var done = false;
    function finish(v) { if (done) return; done = true; if (dlg.open) dlg.close(); resolve(v); }

    var primary = null;
    (opts.buttons || [{ label: '關閉', value: null }]).forEach(function (b) {
      var el = document.createElement('button');
      el.type = 'button';
      el.className = 'btn ' + (b.cls || '');
      el.textContent = b.label;
      el.addEventListener('click', function () {
        if (b.collect) {
          var v = b.collect($('#dlgBody'));
          if (v === false) return;   // 驗證沒過就不關
          finish(v);
        } else finish(b.value === undefined ? true : b.value);
      });
      foot.appendChild(el);
      if (b.cls && /primary|ok|danger/.test(b.cls)) primary = el;
    });

    // 在輸入框按 Enter＝按下主要按鈕；用 ✕／Esc 關掉＝取消
    dlg.onclose = function () { finish(null); };
    dlg.oncancel = function () { finish(null); };
    $('#dlg form').onsubmit = function (e) {
      e.preventDefault();
      if (primary) primary.click(); else finish(null);
    };
    dlg.showModal();
    if (opts.wire) opts.wire($('#dlgBody'), finish);
    if (opts.focus) { var f = $(opts.focus, $('#dlgBody')); if (f) setTimeout(function () { f.focus(); f.select && f.select(); }, 60); }
  });
}

function confirmBox(title, msg, okLabel, cls) {
  return dialog({
    title: title,
    body: '<p style="margin:0;white-space:pre-wrap">' + esc(msg) + '</p>',
    buttons: [{ label: '取消', value: false }, { label: okLabel || '確定', cls: cls || 'primary', value: true }],
  });
}

/* ===================== 經手人 ===================== */
function askOperator(force) {
  if (operator && !force) return Promise.resolve(operator);
  return dialog({
    title: '請問是哪一位在發放？',
    body:
      '<p class="hint" style="margin:0 0 10px">會記在每一筆領取／歸還紀錄裡，方便事後對帳。關掉瀏覽器就清除。</p>' +
      '<label class="field"><span>經手人</span><input class="box" id="dOpr" autocomplete="off" value="' + esc(operator) + '"></label>',
    focus: '#dOpr',
    buttons: [
      { label: '取消', value: null },
      {
        label: '確定', cls: 'primary',
        collect: function (b) {
          var v = $('#dOpr', b).value.trim();
          if (!v) { toast('請填經手人', true); return false; }
          return v;
        },
      },
    ],
  }).then(function (v) {
    if (v) { operator = v; sessionStorage.setItem('xbs_opr', v); paintOperator(); }
    return v;
  });
}

function paintOperator() {
  var el = $('#hdWho');
  if (operator) { el.hidden = false; el.textContent = (narrow() ? '' : '經手：') + operator; el.title = '經手：' + operator; }
  else el.hidden = true;
}

/* ===================== 領取／歸還 ===================== */
function availableDevices(branch) {
  var busy = {};
  // 三個分院的編號都從 01 起編，只能算同一個分院的人，否則善覺 01 會讓圓道 01 消失
  state.members.forEach(function (m) {
    if (m.outAt && !m.inAt && m.no && m.group && m.group.branch === branch) busy[m.no] = m.name;
  });
  return state.devices.filter(function (d) { return d.branch === branch; }).map(function (d) {
    return { no: d.no, status: d.status, holder: busy[d.no] || '' };
  });
}

function doCheckout(m) {
  return askOperator().then(function (op) {
    if (!op) return;
    var branch = m.group.branch;
    var devs = availableDevices(branch);
    var free = devs.filter(function (d) { return d.status !== '維修' && d.status !== '遺失' && !d.holder; });
    var again = statusOf(m) === 'back' && m.no && free.some(function (d) { return d.no === m.no; });
    var opts = free.map(function (d) {
      return '<option value="' + esc(d.no) + '"' + (again && d.no === m.no ? ' selected' : '') + '>' +
        esc(branch + ' ' + d.no) + (again && d.no === m.no ? '（上次這台）' : '') + '</option>';
    }).join('');

    return dialog({
      title: (statusOf(m) === 'back' ? '再次領取 · ' : '登記領取 · ') + m.name,
      body:
        '<p class="hint" style="margin:0 0 12px">' + esc(m.group.name) + '　借用分院：' + esc(branch) + '　借用項目：' + esc(m.group.items || '—') + '</p>' +
        (statusOf(m) === 'back'
          ? '<p class="hint" style="margin:0 0 12px">上一次領 ' + esc(m.no || '未填') + '，已於 ' + esc((m.inAt || '').slice(5, 16)) + ' 歸還。這次重新發一台給他。</p>'
          : '') +
        '<label class="field"><span>小幫手編號（' + branch + ' 還有 ' + free.length + ' 台可借）</span>' +
        '<select class="box" id="dSel">' + (opts || '<option value="">（沒有可借的機台）</option>') + '<option value="__other">其他／手動輸入編號…</option></select></label>' +
        '<label class="field" id="dOtherWrap" hidden><span>手動輸入編號</span><input class="box" id="dOther" autocomplete="off" placeholder="例：A12、備用機 3"></label>' +
        '<p class="hint" style="margin:0">經手人：' + esc(operator) + '</p>',
      focus: '#dSel',
      buttons: [
        { label: '取消', value: null },
        {
          label: '確定領取', cls: 'ok',
          collect: function (b) {
            var sel = $('#dSel', b).value;
            var no = sel === '__other' ? $('#dOther', b).value.trim() : sel;
            if (!no) { toast('請選或填小幫手編號', true); return false; }
            return no;
          },
        },
      ],
    }).then(function (no) {
      if (!no) return;
      return api('checkout', { memberId: m.id, deviceNo: no })
        .catch(function (e) {
          if (e.code === 'DEVICE_BUSY') {
            return confirmBox('編號重複', e.message + '\n\n還是要強制借出嗎？', '強制借出', 'danger').then(function (yes) {
              if (!yes) throw new Error('已取消');
              return api('checkout', { memberId: m.id, deviceNo: no, force: true });
            });
          }
          throw e;
        })
        .then(function (d) {
          // 以後端實際寫進去的編號為準；重送造成的重複由後端判定為成功
          var real = (d && d.member && d.member['小幫手編號']) || no;
          toast(m.name + '　領取 ' + real + (d && d.repeat ? '（這筆剛才已經記成功了）' : ''));
          return load(true);
        });
    });
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

function doReturn(m) {
  return askOperator().then(function (op) {
    if (!op) return;
    return dialog({
      title: '登記歸還 · ' + m.name,
      body:
        '<p class="hint" style="margin:0 0 12px">' + esc(m.group.name) + '　編號 <b>' + esc(m.no || '未填') + '</b>　領取於 ' + esc(m.outAt) + '</p>' +
        '<label class="field"><span>配件有沒有缺？（沒缺就留空）</span>' +
        '<select class="box" id="dMiss"><option value="">配件齊全</option><option value="缺耳機">缺耳機</option><option value="缺充電線">缺充電線</option><option value="缺耳機、充電線">缺耳機、充電線</option><option value="__other">其他…</option></select></label>' +
        '<label class="field" id="dMissWrap" hidden><span>說明</span><input class="box" id="dMissOther" autocomplete="off"></label>' +
        '<p class="hint" style="margin:0">經手人：' + esc(operator) + '</p>',
      buttons: [
        { label: '取消', value: null },
        {
          label: '確定歸還', cls: 'ok',
          collect: function (b) {
            var v = $('#dMiss', b).value;
            return { missing: v === '__other' ? $('#dMissOther', b).value.trim() : v };
          },
        },
      ],
    }).then(function (r) {
      if (!r) return;
      return api('return', { memberId: m.id, missing: r.missing })
        .then(function (d) {
          toast(m.name + '　已歸還' + (d && d.repeat ? '（這筆剛才已經記成功了）' : ''));
          return load(true);
        });
    });
  }).catch(function (e) { toast(e.message, true); });
}

function doUndo(m, what) {
  var label = what === 'return' ? '取消歸還' : '取消領取';
  confirmBox(label, label + '：' + m.name + '（編號 ' + (m.no || '未填') + '）\n按錯時用這個救回來。', label, 'danger')
    .then(function (yes) {
      if (!yes) return;
      return askOperator().then(function (op) {
        if (!op) return;
        return api('undo', { memberId: m.id, what: what }).then(function () { toast('已' + label); return load(true); });
      });
    })
    .catch(function (e) { toast(e.message, true); });
}

/* ===================== 名單編輯 ===================== */
function editMember(m) {
  dialog({
    title: '修改 · ' + m.name,
    body:
      '<label class="field"><span>姓名</span><input class="box" id="eName" autocomplete="off" value="' + esc(m.name) + '"></label>' +
      '<label class="field"><span>行動電話（不填也可以）</span><input class="box" id="ePhone" inputmode="tel" autocomplete="off" value="' + esc(m.phone) + '"></label>' +
      '<label class="field"><span>小幫手編號</span><input class="box" id="eNo" autocomplete="off" value="' + esc(m.no) + '"></label>' +
      '<div class="field"><span>領用日期（哪幾天要用）</span>' + daysPicker(m.days) + '</div>' +
      '<label class="field"><span>備註</span><input class="box" id="eNote" autocomplete="off" value="' + esc(m.note) + '"></label>' +
      '<div style="border-top:1px solid var(--line-soft);margin-top:16px;padding-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<button type="button" class="btn sm danger" id="eDel">刪除這個人</button>' +
      '<span class="hint" style="margin:0">從 ' + esc(m.group.name) + ' 的名單移除</span></div>',
    focus: '#eName',
    wire: function (body, finish) {
      $('#eDel', body).addEventListener('click', function () { finish('__del'); });
      wireDays(body);
    },
    buttons: [
      { label: '取消', value: null },
      {
        label: '儲存', cls: 'primary',
        collect: function (b) {
          var name = $('#eName', b).value.trim();
          if (!name) { toast('姓名不能空白', true); return false; }
          return {
            '姓名': name, '行動電話': $('#ePhone', b).value.trim(),
            '小幫手編號': $('#eNo', b).value.trim(), '備註': $('#eNote', b).value.trim(),
            '領用日期': readDays(b).join(','),
          };
        },
      },
    ],
  }).then(function (r) {
    if (!r) return;
    if (r === '__del') {
      return confirmBox('刪除人員', '確定把「' + m.name + '」從 ' + m.group.name + ' 刪掉嗎？', '刪除', 'danger').then(function (yes) {
        if (!yes) return;
        return api('deleteMember', { memberId: m.id }).then(function () { toast('已刪除'); return load(true); });
      });
    }
    return api('saveMember', Object.assign({ memberId: m.id }, r))
      .catch(function (e) {
        if (e.code !== 'DEVICE_BUSY') throw e;
        return confirmBox('編號重複', e.message + '\n\n還是要改嗎？', '強制改', 'danger').then(function (yes) {
          if (!yes) throw new Error('已取消');
          return api('saveMember', Object.assign({ memberId: m.id, force: true }, r));
        });
      })
      .then(function () { toast('已儲存'); return load(true); });
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

function addMember(g) {
  dialog({
    title: '新增人員 · ' + g.name,
    body:
      '<p class="hint" style="margin:0 0 10px">這組預定 ' + g.qty + ' 組，名單目前 ' + membersOf(g.id).length + ' 人。</p>' +
      '<label class="field"><span>姓名</span><input class="box" id="aName" autocomplete="off"></label>' +
      '<label class="field"><span>行動電話（不填也可以）</span><input class="box" id="aPhone" inputmode="tel" autocomplete="off"></label>' +
      '<div class="field"><span>領用日期（哪幾天要用）</span>' + daysPicker(allDays()) + '</div>',
    focus: '#aName',
    wire: function (body) { wireDays(body); },
    buttons: [
      { label: '取消', value: null },
      {
        label: '新增', cls: 'primary',
        collect: function (b) {
          var n = $('#aName', b).value.trim();
          if (!n) { toast('請填姓名', true); return false; }
          return { name: n, phone: $('#aPhone', b).value.trim(), days: readDays(b).join(',') };
        },
      },
    ],
  }).then(function (r) {
    if (!r) return;
    return api('addMember', { groupId: g.id, name: r.name, phone: r.phone, '領用日期': r.days })
      .then(function () { toast('已新增 ' + r.name); return load(true); });
  }).catch(function (e) { toast(e.message, true); });
}

function editGroup(g) {
  var isNew = !g;
  g = g || { zone: '', zoneName: '', seq: '', name: '', leader: '', branch: '圓道', qty: 1, items: '主機、耳機、充電線', note: '' };
  var brOpts = BRANCHES.map(function (b) { return '<option value="' + b + '"' + (g.branch === b ? ' selected' : '') + '>' + b + '</option>'; }).join('');
  dialog({
    title: isNew ? '新增組別' : '修改組別 · ' + g.name,
    body:
      '<label class="field"><span>組別名稱</span><input class="box" id="gName" autocomplete="off" value="' + esc(g.name) + '"></label>' +
      '<label class="field"><span>組長</span><input class="box" id="gLeader" autocomplete="off" value="' + esc(g.leader) + '"></label>' +
      '<div class="row2">' +
      '<label class="field"><span>借用分院</span><select class="box" id="gBranch">' + brOpts + '</select></label>' +
      '<label class="field"><span>數量（幾組）</span><input class="box" id="gQty" type="number" min="0" value="' + esc(g.qty) + '"></label>' +
      '</div>' +
      '<div class="row2">' +
      '<label class="field"><span>分區代號</span><input class="box" id="gZone" autocomplete="off" value="' + esc(g.zone) + '"></label>' +
      '<label class="field"><span>分區名稱</span><input class="box" id="gZoneName" autocomplete="off" value="' + esc(g.zoneName) + '"></label>' +
      '</div>' +
      '<label class="field"><span>借用項目</span><input class="box" id="gItems" autocomplete="off" value="' + esc(g.items) + '"></label>' +
      '<label class="field"><span>備註</span><input class="box" id="gNote" autocomplete="off" value="' + esc(g.note) + '"></label>' +
      (isNew ? '' :
        '<div style="border-top:1px solid var(--line-soft);margin-top:16px;padding-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<button type="button" class="btn sm danger" id="gDel">刪除這組</button>' +
        '<span class="hint" style="margin:0">底下的人員會一起刪掉</span></div>'),
    focus: '#gName',
    wire: function (body, finish) {
      var d = $('#gDel', body);
      if (d) d.addEventListener('click', function () { finish('__del'); });
    },
    buttons: [
      { label: '取消', value: null },
    ].concat([
      {
        label: isNew ? '新增' : '儲存', cls: 'primary',
        collect: function (b) {
          var n = $('#gName', b).value.trim();
          if (!n) { toast('組別名稱不能空白', true); return false; }
          return {
            '組別': n, '組長': $('#gLeader', b).value.trim(), '借用分院': $('#gBranch', b).value,
            '數量': $('#gQty', b).value, '分區': $('#gZone', b).value.trim(), '分區名稱': $('#gZoneName', b).value.trim(),
            '項次': g.seq || '', '借用項目': $('#gItems', b).value.trim(), '備註': $('#gNote', b).value.trim(),
          };
        },
      },
    ]),
  }).then(function (r) {
    if (!r) return;
    if (r === '__del') {
      return confirmBox('刪除組別', '確定刪掉「' + g.name + '」嗎？底下的人員會一起刪掉。', '刪除', 'danger').then(function (yes) {
        if (!yes) return;
        return api('deleteGroup', { groupId: g.id, force: true }).then(function () { toast('已刪除'); return load(true); });
      });
    }
    return api('saveGroup', Object.assign({ groupId: isNew ? '' : g.id }, r)).then(function () { toast('已儲存'); return load(true); });
  }).catch(function (e) { toast(e.message, true); });
}

/* ===================== 畫面 ===================== */
function membersOf(gid) { return state.members.filter(function (m) { return m.groupId === gid; }); }

function memberRow(m, opts) {
  opts = opts || {};
  var s = statusOf(m);
  var acts = '';
  if (s === 'idle') acts = '<button class="btn sm ok" data-act="out" data-id="' + m.id + '">領取</button>';
  else if (s === 'out') acts = '<button class="btn sm primary" data-act="in" data-id="' + m.id + '">歸還</button>' +
    '<button class="btn sm ghost" data-act="undo-out" data-id="' + m.id + '" title="取消領取">↩</button>';
  else acts = '<button class="btn sm ok" data-act="out" data-id="' + m.id + '">再領取</button>' +
    '<button class="btn sm ghost" data-act="undo-in" data-id="' + m.id + '" title="取消歸還">↩</button>';
  if (adminOn) acts += '<button class="btn sm ghost" data-act="edit" data-id="' + m.id + '" title="修改">✎</button>';

  var meta = [];
  if (opts.showGroup) meta.push(m.group.name);
  meta.push(m.group.branch);
  if (m.phone) meta.push(m.phone);
  if (s === 'out') meta.push('領於 ' + (m.outAt || '').slice(5, 16));
  if (s === 'back') meta.push('還於 ' + (m.inAt || '').slice(5, 16));
  if (m.missing) meta.push('⚠ ' + m.missing);

  if (readOnly()) acts = '';    // 唯讀（訪客或已關閉的活動）不給任何操作鈕
  var others = dupOthers(m);
  // 文字包成一塊，按鈕才不會在窄螢幕被擠到下一行（手機上一列就從 95px 降到 ~64px）
  return '<div class="item is-' + s + '">' +
    '<div class="it-main">' +
    '<span class="nm">' + esc(m.name) + '</span>' +
    (m.no ? '<span class="no">' + esc(m.no) + '</span>' : '') +
    (others.length ? '<span class="tag dup" title="同名也在：' + esc(others.join('、')) + '">同名 ' + (others.length + 1) + ' 組</span>' : '') +
    '<span class="tag ' + s + '">' + statusLabel(s) + '</span>' +
    '<span class="tag days' + (m.days.length === allDays().length ? '' : ' part') + '" title="領用日期：' + esc(m.days.join('、') || '未填') + '">' + esc(daysLabel(m.days)) + '</span>' +
    '<span class="meta">' + esc(meta.join('　·　')) + '</span>' +
    '</div>' +
    (acts ? '<span class="acts">' + acts + '</span>' : '') +
    '</div>';
}

/** 名單管理用的列：姓名 + 直接可點的領用日期 */
function rosterRow(m) {
  var s = statusOf(m);
  var others = dupOthers(m);
  return '<div class="item rost is-' + s + '">' +
    '<div class="rost-l">' +
    '<span class="nm">' + esc(m.name) + '</span>' +
    (m.no ? '<span class="no">' + esc(m.no) + '</span>' : '') +
    (others.length ? '<span class="tag dup" title="同名也在：' + esc(others.join('、')) + '">同名 ' + (others.length + 1) + ' 組</span>' : '') +
    (s === 'idle' ? '' : '<span class="tag ' + s + '">' + statusLabel(s) + '</span>') +
    (m.phone ? '<span class="meta">' + esc(m.phone) + '</span>' : '') +
    '</div>' +
    rosterDayStrip(m) +
    (readOnly() ? '' : '<button class="btn sm ghost" data-act="edit" data-id="' + m.id + '" title="改姓名、電話、編號或刪除">✎</button>') +
    '</div>';
}

/** 四顆狀態鈕的數字與選中樣式 */
function paintModes(n) {
  var box = $('#cMode');
  if (!box) return;
  [].forEach.call(box.querySelectorAll('.mode'), function (b) {
    var k = b.getAttribute('data-mode') || '';
    b.classList.toggle('on', k === counterMode);
    var c = b.querySelector('b');
    if (c) c.textContent = n[k];
  });
}

/** 分頁上的待歸還徽章：全場還有幾台在外面沒收回來 */
function paintOutBadge() {
  var el = $('#tabOutBadge');
  if (!el) return;
  var c = state.members.filter(function (m) { return statusOf(m) === 'out'; }).length;
  el.textContent = c;
  el.hidden = !c;
}

/** 查無資料時講清楚為什麼，不要只寫「沒有符合的人員」 */
function counterEmptyMsg(n) {
  if (!n['']) return '沒有符合的人員';
  if (counterMode === 'out') {
    return '目前沒有人在領取中，所以沒有要歸還的。' +
      '<div class="hint" style="margin-top:6px">等有人按下「領取」，他就會出現在這裡，列上會有「歸還」鈕。</div>';
  }
  if (counterMode === 'free') return '這個範圍裡的人機器都還在手上，沒有人可以再發。';
  if (counterMode === 'back') return '這一輪還沒有人完成歸還。';
  return '沒有符合的人員';
}

/**
 * 訪客的主畫面：依組別分組，不要把 142 個人一條條攤開。
 * 預設收合，只看得到組別標題；一搜尋或一篩狀態就自動展開，才找得到人。
 */
function counterGrouped(rows, expand) {
  var byG = {};
  rows.forEach(function (m) { (byG[m.groupId] = byG[m.groupId] || []).push(m); });
  var gs = state.groups.filter(function (g) { return byG[g.id] && byG[g.id].length; })
    .sort(function (x, y) {
      if (x.zone !== y.zone) return (x.zone || '') < (y.zone || '') ? -1 : 1;
      return (parseInt(x.seq, 10) || 0) - (parseInt(y.seq, 10) || 0);
    });
  return gs.map(function (g) {
    var ms = byG[g.id];
    var out = ms.filter(function (m) { return statusOf(m) === 'out'; }).length;
    var back = ms.filter(function (m) { return statusOf(m) === 'back'; }).length;
    return '<details class="grp"' + (expand ? ' open' : '') + '><summary>' +
      '<span class="gn">' + esc(g.name) + '</span>' +
      '<span class="tag branch">' + esc(g.branch) + '</span>' +
      '<span class="gm">' + groupMeta(g) + '</span>' +
      '<span class="gs">' +
      (out ? '<span class="tag out">' + out + ' 台未還</span>' : '') +
      (back ? '<span class="tag back">已還 ' + back + '</span>' : '') +
      '<span class="tag">' + ms.length + ' 人</span>' +
      '</span></summary>' +
      '<div class="grp-body"><div class="list">' +
      ms.map(function (m) { return memberRow(m, {}); }).join('') +
      '</div></div></details>';
  }).join('');
}

function renderCounter() {
  var q = $('#q').value.trim().toLowerCase();
  var fb = $('#fBranch').value;
  var fg = ($('#fGroup') || {}).value || '';
  var base = state.members.filter(function (m) {
    if (fb && m.group.branch !== fb) return false;
    if (fg && m.groupId !== fg) return false;
    if (!q) return true;
    return (m.name + ' ' + m.group.name + ' ' + (m.group.leader || '') + ' ' + (m.no || '') + ' ' + (m.phone || '')).toLowerCase().indexOf(q) >= 0;
  });

  var n = { '': base.length, free: 0, out: 0, back: 0 };
  base.forEach(function (m) {
    var s = statusOf(m);
    if (s === 'out') n.out++; else n.free++;      // 手上沒機器的都算可領（沒領過的＋已還的）
    if (s === 'back') n.back++;
  });
  paintModes(n);
  paintOutBadge();

  var rows = !counterMode ? base : base.filter(function (m) {
    var s = statusOf(m);
    return counterMode === 'free' ? s !== 'out' : s === counterMode;
  });
  $('#qCount').textContent = rows.length + ' 筆';

  if (!rows.length) {
    $('#counterList').innerHTML = '<div class="empty">' + counterEmptyMsg(n) + '</div>';
  } else if (isGuest()) {
    // 訪客看分組名單；有在搜尋或篩狀態時自動展開
    $('#counterList').innerHTML = counterGrouped(rows, !!(q || counterMode));
  } else {
    $('#counterList').innerHTML =
      '<div class="list">' + rows.map(function (m) { return memberRow(m, { showGroup: true }); }).join('') + '</div>';
  }
}

/** 總覽的「看分院／看機台」切換 */
function paintDashMode() {
  var box = $('#dashMode');
  if (box) {
    [].forEach.call(box.querySelectorAll('.mode'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-dash') === dashMode);
    });
  }
  var br = $('#dashBranches'), gp = $('#dashGroups'), dv = $('#dashDevices');
  if (br) br.hidden = dashMode !== 'branch';
  if (gp) gp.hidden = dashMode !== 'group';
  if (dv) dv.hidden = dashMode !== 'device';
}

function renderDash() {
  var all = state.members;
  var cnt = function (arr, s) { return arr.filter(function (m) { return statusOf(m) === s; }).length; };
  var qtySum = state.groups.reduce(function (a, g) { return a + g.qty; }, 0);

  function statsHtml(arr, total) {
    var out = cnt(arr, 'out'), back = cnt(arr, 'back'), idle = cnt(arr, 'idle');
    var done = total ? Math.round(((out + back) / total) * 100) : 0;
    return '<div class="stats">' +
      '<div class="stat"><b>' + total + '</b><span>預定借出（組）</span><div class="bar"><i style="width:' + done + '%"></i></div></div>' +
      '<div class="stat out"><b>' + out + '</b><span>領取中 · 未歸還</span></div>' +
      '<div class="stat back"><b>' + back + '</b><span>已歸還</span></div>' +
      '<div class="stat"><b>' + idle + '</b><span>名單上尚未領取</span></div>' +
      '</div>';
  }

  $('#dashTotal').innerHTML = statsHtml(all, qtySum);

  paintDashMode();

  // 看組別：回收時要能「一組一組去追」，所以未還的人名與編號直接列出來，
  // 而且還有東西沒收回來的組排最前面。
  var gRows = state.groups.map(function (g) {
    var ms = membersOf(g.id);
    var out = ms.filter(function (m) { return statusOf(m) === 'out'; });
    var back = ms.filter(function (m) { return statusOf(m) === 'back'; }).length;
    return { g: g, ms: ms, out: out, back: back };
  }).sort(function (x, y) {
    if (x.out.length !== y.out.length) return y.out.length - x.out.length;   // 還沒收齊的排前面
    if (x.g.zone !== y.g.zone) return (x.g.zone || '') < (y.g.zone || '') ? -1 : 1;
    return (parseInt(x.g.seq, 10) || 0) - (parseInt(y.g.seq, 10) || 0);
  });
  var totalOut = gRows.reduce(function (s, r) { return s + r.out.length; }, 0);

  $('#dashGroups').innerHTML =
    '<p class="hint" style="margin:0 0 10px">' +
      (totalOut
        ? '還有 <b>' + totalOut + '</b> 台沒收回來，分布在 <b>' +
          gRows.filter(function (r) { return r.out.length; }).length + '</b> 組。未收齊的組排在最前面，' +
          '底下就是要找的人跟編號——拿這份去找組長最快。'
        : '所有組別都收齊了 🎉') +
    '</p>' +
    (gRows.length ? '<div class="list">' + gRows.map(function (r) {
      var g = r.g;
      return '<div class="item" style="align-items:flex-start">' +
        '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
        '<span class="nm">' + esc(g.name) + '</span>' +
        '<span class="tag branch">' + esc(g.branch) + '</span>' +
        (r.out.length ? '<span class="tag out">' + r.out.length + ' 台未還</span>' : '<span class="tag back">收齊</span>') +
        '<span class="meta">組長 ' + esc(g.leader || '—') + '　·　申請 ' + g.qty + '　·　名單 ' + r.ms.length +
        '　·　已還 ' + r.back + '</span>' +
        '</div>' +
        (r.out.length
          ? '<div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">' +
            r.out.map(function (m) {
              return '<span class="tag out">' + esc(m.name) + '　' + esc(m.no || '未填編號') + '</span>';
            }).join('') + '</div>'
          : '') +
        '</div></div>';
    }).join('') + '</div>' : '<div class="empty">還沒有組別</div>');

  $('#dashDevices').innerHTML = BRANCHES.map(function (b) {
    var ds = state.devices.filter(function (d) { return d.branch === b; })
      .sort(function (x, y) { return (parseInt(x.no, 10) || 0) - (parseInt(y.no, 10) || 0); });
    var holder = {};
    state.members.forEach(function (m) {
      if (m.outAt && !m.inAt && m.no && m.group && m.group.branch === b) holder[m.no] = m.name;
    });
    var busy = ds.filter(function (d) { return holder[d.no]; }).length;
    var bad = ds.filter(function (d) { return d.status === '維修' || d.status === '遺失'; }).length;
    return '<div class="card">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<b style="font-size:1.05rem">' + b + '</b>' +
      '<span class="tag">清冊 ' + ds.length + ' 台</span>' +
      '<span class="tag out">借出 ' + busy + '</span>' +
      '<span class="tag back">在架上 ' + (ds.length - busy - bad) + '</span>' +
      (bad ? '<span class="tag dup">維修／遺失 ' + bad + '</span>' : '') +
      '</div>' +
      (ds.length
        ? '<div class="devgrid">' + ds.map(function (d) {
            var who = holder[d.no];
            var st = who ? '借出' : d.status;
            return '<span class="dev s-' + esc(st) + '" title="' + esc(d.no + '　' + (who ? who + ' 持用中' : st)) + '">' +
              '<b>' + esc(d.no) + '</b><small>' + esc(who || st) + '</small></span>';
          }).join('') + '</div>'
        : '<div class="empty">還沒建立機台清冊</div>') +
      '</div>';
  }).join('');

  $('#dashBranches').innerHTML = BRANCHES.map(function (b) {
    var arr = all.filter(function (m) { return m.group.branch === b; });
    var total = state.groups.filter(function (g) { return g.branch === b; }).reduce(function (a, g) { return a + g.qty; }, 0);
    return '<div class="card"><div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
      '<b style="font-size:1.05rem">' + b + '</b><span class="tag branch">名單 ' + arr.length + ' 人</span></div>' +
      statsHtml(arr, total) + '</div>';
  }).join('');

  var out = all.filter(function (m) { return statusOf(m) === 'out'; })
    .sort(function (a, b) { return (a.outAt || '') < (b.outAt || '') ? -1 : 1; });
  $('#dashOut').innerHTML = out.length
    ? '<div class="list">' + out.map(function (m) { return memberRow(m, { showGroup: true }); }).join('') + '</div>'
    : '<div class="empty">目前沒有未歸還的小幫手 🎉</div>';

  $('#dashDays').innerHTML = '<div class="card" style="overflow-x:auto"><table class="daytab"><thead><tr><th>日期</th>' +
    BRANCHES.map(function (b) { return '<th>' + b + '</th>'; }).join('') + '<th>合計</th></tr></thead><tbody>' +
    perDayCounts('').map(function (r) {
      return '<tr><td>' + esc(r.day) + ' 日</td>' +
        BRANCHES.map(function (b) { return '<td>' + r[b] + '</td>'; }).join('') +
        '<td><b>' + r.total + '</b></td></tr>';
    }).join('') + '</tbody></table></div>';

  var keys = Object.keys(state.dups);
  $('#dashDup').innerHTML = keys.length
    ? '<div class="list">' + keys.sort().map(function (k) {
      var arr = state.dups[k];
      var taken = arr.filter(function (m) { return m.outAt && !m.inAt; }).length;
      return '<div class="item">' +
        '<span class="nm">' + esc(arr[0].name) + '</span>' +
        '<span class="tag dup">' + arr.length + ' 組</span>' +
        (taken > 1 ? '<span class="tag out">已領 ' + taken + ' 台</span>' : '') +
        '<span class="meta">' + esc(arr.map(function (m) { return m.group.name + '（' + m.group.branch + '）'; }).join('　·　')) + '</span>' +
        '</div>';
    }).join('') + '</div>'
    : '<div class="empty">沒有重複的名字</div>';
}

/* ---------- 名單管理：逐個勾選、最後一次儲存 ---------- */
var pending = {};        // memberId -> 新的日期字串
var pendingQty = {};     // groupId  -> 新的申請數量

function pendingCount() { return Object.keys(pending).length + Object.keys(pendingQty).length; }

function qtyOf(g) { return pendingQty[g.id] != null ? pendingQty[g.id] : g.qty; }

function setQty(gid, val) {
  var g = state.gById[gid];
  if (!g) return;
  var n = parseInt(val, 10);
  if (isNaN(n) || n < 0) n = 0;
  if (n === g.qty) delete pendingQty[gid];
  else pendingQty[gid] = n;
  // 只更新那一組的摘要文字，不整頁重畫（免得把輸入游標弄掉）
  var sum = $('details.grp[data-gid="' + gid + '"] .gm');
  if (sum) sum.innerHTML = groupMeta(g);
  var box = $('.qtybox[data-gid="' + gid + '"]');
  if (box) box.classList.toggle('changed', pendingQty[gid] != null);
  paintSaveBar();
}

/** 待存的變更裡，一天都沒勾的人（＝要從名單移除的） */
function pendingEmpty() {
  return Object.keys(pending)
    .filter(function (id) { return !pending[id]; })
    .map(function (id) { return state.members.filter(function (m) { return m.id === id; })[0]; })
    .filter(Boolean);
}

function paintSaveBar() {
  var nM = Object.keys(pending).length;
  var nG = Object.keys(pendingQty).length;
  var bar = $('#rosterSave');
  if (bar) bar.hidden = readOnly() || (nM + nG) === 0;
  var empties = pendingEmpty();
  var parts = [];
  if (nM) parts.push(nM + ' 位的領用日期');
  if (nG) parts.push(nG + ' 組的申請數量');
  var msg = $('#rosterSaveMsg');
  if (msg) {
    msg.textContent = parts.length
      ? '有 ' + parts.join('、') + '還沒存' + (empties.length ? '　·　其中 ' + empties.length + ' 位一天都沒勾，會從名單移除' : '')
      : '';
  }
}

function daysOf(m) {
  return pending[m.id] != null ? pending[m.id].split(',').filter(Boolean) : m.days;
}

function rosterDayStrip(m) {
  var cur = daysOf(m);
  var changed = pending[m.id] != null;
  return '<div class="daystrip' + (changed ? ' changed' : '') + (cur.length ? '' : ' empty') + '" data-mid="' + m.id + '"' +
    (cur.length ? '' : ' title="一天都沒勾，儲存時會從名單移除"') + '>' +
    (cur.length ? '' : '<span class="willdel">移除</span>') +
    allDays().map(function (d) {
      return '<button type="button" class="dayb' + (cur.indexOf(d) >= 0 ? ' on' : '') + '" data-day="' + esc(d) + '"' +
        (readOnly() ? ' disabled' : '') + '>' + esc(d) + '</button>';
    }).join('') +
    (readOnly() ? '' : '<button type="button" class="dayb all" data-day="__all">全</button>') +
    '</div>';
}

function toggleDay(mid, day) {
  var m = state.members.filter(function (x) { return x.id === mid; })[0];
  if (!m) return;
  var cur = daysOf(m).slice();
  if (day === '__all') {
    cur = cur.length === allDays().length ? [] : allDays().slice();
  } else {
    var i = cur.indexOf(day);
    if (i >= 0) cur.splice(i, 1); else cur.push(day);
  }
  cur.sort(function (a, b) { return Number(a) - Number(b); });
  var next = cur.join(',');
  if (next === m.days.join(',')) delete pending[m.id];
  else pending[m.id] = next;

  // 只重畫那一列，不整頁重繪，才不會把勾到一半的狀態洗掉
  var strip = $('.daystrip[data-mid="' + mid + '"]');
  if (strip) strip.outerHTML = rosterDayStrip(m);
  paintSaveBar();
}

function saveAllDays() {
  var items = Object.keys(pending).map(function (id) { return { memberId: id, '領用日期': pending[id] }; });
  var groupItems = Object.keys(pendingQty).map(function (gid) { return { groupId: gid, '數量': pendingQty[gid] }; });
  if (!items.length && !groupItems.length) return;
  var n = items.length, nG = groupItems.length;
  var empties = pendingEmpty();

  var ask = empties.length
    ? confirmBox(
      '有 ' + empties.length + ' 位要從名單移除',
      '這幾位一天都沒勾，表示不需要小幫手，儲存時會從名單刪掉：\n\n' +
      empties.map(function (m) { return '· ' + m.name + '（' + m.group.name + '／' + m.group.branch + '）'; }).join('\n') +
      '\n\n其餘 ' + (n - empties.length) + ' 位只是改日期。要一起存嗎？',
      '移除並儲存', 'danger')
    : Promise.resolve(true);

  return ask.then(function (yes) {
    if (!yes) return;
    var btn = $('#btnSaveAll'), msg = $('#rosterSaveMsg');
    if (btn) btn.disabled = true;
    if (msg) msg.textContent = '儲存中…';
    return api('saveMembersBulk', { items: items, groups: groupItems })
      .then(function (r) {
        pending = {};
        pendingQty = {};
        var del = (r['已移除'] || []).length;
        var held = r['未歸還未移除'] || [];
        var said = [];
        if (n - del > 0) said.push((n - del) + ' 位名單');
        if (nG) said.push(nG + ' 組數量');
        if (del) said.push('移除 ' + del + ' 位');
        toast('已儲存' + (said.length ? '：' + said.join('、') : ''));
        if (held.length) {
          setTimeout(function () {
            toast(held.join('、') + ' 手上的小幫手還沒歸還，先留在名單上', true);
          }, 2600);
        }
        return load(true);
      })
      .catch(function (e) { toast(e.message, true); paintSaveBar(); })
      .finally(function () { var b = $('#btnSaveAll'); if (b) b.disabled = false; });
  });
}

/** 組別摘要文字：分區、組長、申請數量 vs 名單人數 */
function groupMeta(g) {
  var ms = membersOf(g.id);
  var qty = qtyOf(g);
  var diff = qty - ms.length;
  return esc(g.zone ? g.zone + ' ' + g.zoneName + '　·　' : '') +
    '組長 ' + esc(g.leader || '—') + '　·　' +
    '申請 <b>' + qty + '</b> 組　·　名單 ' + ms.length + ' 人' +
    (diff > 0 ? '　·　<b style="color:var(--warn)">還缺 ' + diff + ' 位</b>'
      : diff < 0 ? '　·　<b style="color:var(--danger)">多 ' + (-diff) + ' 位</b>' : '　·　<b style="color:var(--ok)">剛好</b>');
}

function renderRoster() {
  var fb = $('#rBranch').value, q = $('#rQ').value.trim().toLowerCase();
  var groups = state.groups.filter(function (g) {
    if (fb && g.branch !== fb) return false;
    if (!q) return true;
    if ((g.name + ' ' + (g.leader || '')).toLowerCase().indexOf(q) >= 0) return true;
    return membersOf(g.id).some(function (m) { return m.name.toLowerCase().indexOf(q) >= 0; });
  }).sort(function (a, b) {
    if (a.zone !== b.zone) return (a.zone || '') < (b.zone || '') ? -1 : 1;
    return (parseInt(a.seq, 10) || 0) - (parseInt(b.seq, 10) || 0);
  });

  $('#rosterList').innerHTML = groups.length ? groups.map(function (g) {
    var ms = membersOf(g.id);
    var out = ms.filter(function (m) { return statusOf(m) === 'out'; }).length;
    return '<details class="grp" data-gid="' + g.id + '"><summary>' +
      '<span class="gn">' + esc(g.name) + '</span>' +
      '<span class="tag branch">' + esc(g.branch) + '</span>' +
      '<span class="gm">' + groupMeta(g) + '</span>' +
      '<span class="gs">' +
      '<span class="qtybox' + (pendingQty[g.id] != null ? ' changed' : '') + '" data-gid="' + g.id +
      '" title="這一組申請的總量' + (isGuest() ? '' : '，可以直接改') + '">' +
      '<span>申請</span>' +
      (readOnly()
        ? '<b class="qtyro">' + esc(String(qtyOf(g))) + '</b>'
        : '<input type="number" min="0" max="999" class="qty" data-gid="' + g.id + '" value="' + qtyOf(g) + '">') +
      '<span>組</span></span>' +
      (out ? '<span class="tag out">' + out + ' 台未還</span>' : '') +
      '</span></summary>' +
      '<div class="grp-body">' +
      (ms.length ? ms.map(function (m) { return rosterRow(m); }).join('') : '<div class="empty">名單還沒填</div>') +
      '<div style="padding:10px 14px;display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line-soft)">' +
      (readOnly() ? '' :
        '<button class="btn sm" data-act="add-member" data-gid="' + g.id + '">＋ 新增人員</button>' +
        '<button class="btn sm ghost" data-act="edit-group" data-gid="' + g.id + '">修改組別資料</button>') +
      '<span class="hint" style="margin-left:auto;align-self:center">借用項目：' + esc(g.items || '—') + '</span>' +
      '</div></div></details>';
  }).join('') : '<div class="empty">沒有符合的組別</div>';
}

function renderDevices() {
  var holder = {};
  state.members.forEach(function (m) { if (m.outAt && !m.inAt && m.no) holder[m.group.branch + '/' + m.no] = m.name; });

  $('#deviceList').innerHTML = BRANCHES.map(function (b) {
    var ds = state.devices.filter(function (d) { return d.branch === b; })
      .sort(function (x, y) { return (parseInt(x.no, 10) || 0) - (parseInt(y.no, 10) || 0); });
    var busy = ds.filter(function (d) { return holder[b + '/' + d.no]; }).length;
    // 各組申請數量加總＝這個分院應該要備的台數
    var need = state.groups.filter(function (g) { return g.branch === b; })
      .reduce(function (s, g) { return s + g.qty; }, 0);
    var gap = need - ds.length;
    return '<div class="card">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<b style="font-size:1.05rem">' + b + '</b>' +
      '<span class="tag">清冊 ' + ds.length + ' 台</span>' +
      '<span class="tag' + (gap ? ' dup' : '') + '">各組申請共 ' + need + ' 台</span>' +
      '<span class="tag out">借出 ' + busy + '</span>' +
      (readOnly() ? '' : '<button class="btn sm ghost" data-act="reset-dev" data-branch="' + b + '" style="margin-left:auto">調整台數</button>') +
      '</div>' +
      (gap ? '<div class="note" style="margin:0 0 12px">' +
        '<b>對不上：</b>各組申請共 <b>' + need + '</b> 台，清冊只有 <b>' + ds.length + '</b> 台（' +
        (gap > 0 ? '少 ' + gap : '多 ' + (-gap)) + ' 台）。' +
        (readOnly() ? '' : '<button class="btn sm primary" data-act="sync-dev" data-branch="' + b + '" data-need="' + need + '" style="margin-left:8px">依申請數量調成 ' + need + ' 台</button>') +
        '</div>' : '') +
      (ds.length ? '<div class="devgrid">' + ds.map(function (d) {
        var who = holder[b + '/' + d.no];
        var st = who ? '借出' : d.status;
        return '<button type="button" class="dev s-' + st + '" data-act="dev" data-branch="' + b + '" data-no="' + esc(d.no) + '"' +
          (readOnly() ? ' disabled' : '') + '>' +
          '<b>' + esc(d.no) + '</b><small>' + esc(who || st) + '</small></button>';
      }).join('') + '</div>' : '<div class="empty">還沒建立機台清冊</div>') +
      '</div>';
  }).join('');
}

/** 操作紀錄：點進分頁才去拿，拿過就不再重拿（按 ↻ 更新會重拿） */
function ensureLogs(force) {
  if (logsLoading) return Promise.resolve();
  if (logsLoaded && !force) return Promise.resolve();
  logsLoading = true;
  renderLogs();
  return api('loadLogs', { n: 300 })
    .then(function (d) {
      state.raw.logs = d.logs || [];
      state.logs = (d.logs || []).map(function (l) {
        return { at: l['時間'], act: l['動作'], branch: l['分院'], group: l['組別'],
                 name: l['姓名'], no: l['編號'], detail: l['內容'], by: l['經手'] };
      });
      logsLoaded = true;
    })
    .catch(function (e) { toast('操作紀錄載入失敗：' + e.message, true); })
    .finally(function () { logsLoading = false; renderLogs(); });
}

function renderLogs() {
  if (!logsLoaded) {
    $('#logList').innerHTML = '<div class="empty">' + (logsLoading ? '載入中…' : '切到這一頁就會自動載入') + '</div>';
    return;
  }
  $('#logList').innerHTML = state.logs.length
    ? '<div class="list">' + state.logs.map(function (l) {
      return '<div class="item"><span class="tag">' + esc(l.act) + '</span>' +
        '<span class="nm">' + esc(l.name || '—') + '</span>' +
        (l.no ? '<span class="no">' + esc(l.no) + '</span>' : '') +
        '<span class="meta">' + esc([l.branch, l.group, l.detail].filter(Boolean).join('　·　')) + '</span>' +
        '<span class="meta" style="margin-left:auto">' + esc(l.at) + (l.by ? '　/　' + esc(l.by) : '') + '</span></div>';
    }).join('') + '</div>'
    : '<div class="empty">還沒有紀錄</div>';
}

function fillSelects() {
  ['#fBranch', '#rBranch', '#pBranch'].forEach(function (sel) {
    var el = $(sel), cur = el.value;
    el.innerHTML = '<option value="">全部分院</option>' + BRANCHES.map(function (b) { return '<option value="' + b + '">' + b + '</option>'; }).join('');
    el.value = cur;
  });
  paintGroupFilter();
}

/** 組別下拉：跟著分院收斂，只列那個分院的組別 */
function paintGroupFilter() {
  var el = $('#fGroup');
  if (!el) return;
  var branch = ($('#fBranch') || {}).value || '';
  var cur = el.value;
  var gs = state.groups
    .filter(function (g) { return !branch || g.branch === branch; })
    .sort(function (x, y) {
      if (x.zone !== y.zone) return (x.zone || '') < (y.zone || '') ? -1 : 1;
      return (parseInt(x.seq, 10) || 0) - (parseInt(y.seq, 10) || 0);
    });
  el.innerHTML = '<option value="">全部組別</option>' + gs.map(function (g) {
    return '<option value="' + esc(g.id) + '">' + esc(g.name) + (branch ? '' : '（' + esc(g.branch) + '）') + '</option>';
  }).join('');
  // 換分院之後原本選的組別可能不在清單裡了，就退回「全部組別」
  el.value = gs.some(function (g) { return g.id === cur; }) ? cur : '';
}

/** 會寫入的那幾顆鈕：唯讀時（訪客或已關閉的活動）一律藏起來。每次重畫都要重算。 */
function paintWriteButtons() {
  var ro = readOnly();
  var ag = $('#btnAddGroup');
  if (ag) ag.hidden = ro;
}

/** 換一場活動看的時候，還沒存的改動一定要丟掉——否則會存到別場去 */
function switchViewTo(id) {
  var dirty = Object.keys(pending).length + Object.keys(pendingQty).length;
  var go = function () {
    var prev = viewEventId;
    pending = {}; pendingQty = {};
    viewEventId = id;
    return load(true).catch(function (e) {
      viewEventId = prev;                       // 載不起來就退回原本那一場，不能讓之後的寫入跑到別場
      toast('切換活動失敗，還停在原來那一場：' + e.message, true);
      throw e;
    });
  };
  if (!dirty) return go();
  return confirmBox('還有沒存的改動',
    '有 ' + dirty + ' 筆改動還沒儲存。換去看別場活動會把這些改動丟掉。',
    '丟掉並切換', 'danger').then(function (yes) { return yes ? go() : null; });
}

function renderAll() {
  renderEvents(); paintEventBanner(); paintWriteButtons();
  renderCounter(); renderDash(); renderRoster(); renderDevices(); renderLogs(); paintSaveBar();
  var dh = $('#devHint');
  if (dh) {
    dh.textContent = '編號是依各分院借出總數自動產生的（' +
      BRANCHES.map(function (b) { return b + ' ' + state.devices.filter(function (d) { return d.branch === b; }).length; }).join('、') +
      '），實際機身號碼如果不同，可以在這裡調整，或在領取時直接改填。';
  }
  $('#sysInfo').textContent = '資料更新於 ' + (state.settings.updatedAt || '—') +
    '　·　組別 ' + state.groups.length + '　·　名單 ' + state.members.length + ' 人　·　機台 ' + state.devices.length + ' 台';
}

/* ===================== 活動 ===================== */

function renderEvents() {
  var box = $('#eventList');
  if (!box) return;
  var evs = state.events || [];
  box.innerHTML = evs.length ? '<div class="list">' + evs.map(function (e) {
    var open = e['狀態'] === '進行中';
    var viewing = state.eventId === e.id;
    var isCur = state.currentEventId === e.id;
    var meta = [];
    if (e['領用日期']) meta.push('領用日期 ' + e['領用日期']);
    if (e['建立者']) meta.push('由 ' + e['建立者'] + ' 建立於 ' + String(e['建立時間'] || '').slice(0, 16));
    if (e['關閉者']) meta.push('由 ' + e['關閉者'] + ' 關閉於 ' + String(e['關閉時間'] || '').slice(0, 16));
    var acts = '';
    if (!viewing) acts += '<button class="btn sm" data-act="ev-view" data-ev="' + e.id + '">查看</button>';
    if (!isGuest()) {
      if (!isCur && open) acts += '<button class="btn sm primary" data-act="ev-current" data-ev="' + e.id + '" title="所有人下次開啟時預設看到這一場">設為目前</button>';
      acts += open
        ? '<button class="btn sm danger" data-act="ev-close" data-ev="' + e.id + '">關閉活動</button>'
        : '<button class="btn sm ghost" data-act="ev-reopen" data-ev="' + e.id + '">重新開啟</button>';
      acts += '<button class="btn sm ghost" data-act="ev-edit" data-ev="' + e.id + '" title="改名稱或領用日期">✎</button>';
    }
    return '<div class="item">' +
      '<span class="nm">' + esc(e['名稱']) + '</span>' +
      '<span class="tag ' + (open ? 'out' : 'back') + '">' + esc(e['狀態']) + '</span>' +
      (isCur ? '<span class="tag branch">目前</span>' : '') +
      (viewing ? '<span class="tag days">正在看</span>' : '') +
      (meta.length ? '<span class="meta">' + esc(meta.join('　·　')) + '</span>' : '') +
      '<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">' + acts + '</span>' +
      '</div>';
  }).join('') + '</div>' : '<div class="empty">還沒有活動</div>';

  var nb = $('#btnNewEvent');
  if (nb) nb.hidden = isGuest();
}

/** 看的不是「目前這一場」或那一場已關閉時，頂端給一條明顯的提示 */
function paintEventBanner() {
  var el = $('#eventBanner');
  if (!el) return;
  var ev = state.event;
  if (!ev) { el.hidden = true; return; }
  var closed = ev['狀態'] !== '進行中';
  var other = state.currentEventId && state.eventId && state.currentEventId !== state.eventId;
  if (!closed && !other) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML =
    '<b>' + esc(ev['名稱']) + '</b>　' +
    (closed ? '這一場已經關閉了，只能查看，不能登記領取或歸還。' : '你正在看的不是目前進行中的那一場。') +
    (isGuest() ? '' : '　<button class="btn sm" data-act="ev-back">回到目前的活動</button>');
}

function newEventDialog() {
  var cur = state.event ? state.event['名稱'] : '';
  var out = unreturnedNow();
  dialog({
    title: '開一場新活動',
    body:
      (out.length
        ? '<div class="note" style="margin:0 0 12px">' +
          '<b>提醒：「' + esc(cur) + '」還有 ' + out.length + ' 台沒收回來。</b>' +
          '<div style="margin-top:6px;max-height:30vh;overflow:auto">' +
          out.slice(0, 20).map(function (m) {
            return '<div>' + esc(m.name) + '（' + esc(m.no || '未填') + '）' + esc(m.group ? m.group.name : '') + '</div>';
          }).join('') +
          (out.length > 20 ? '<div>…共 ' + out.length + ' 位</div>' : '') +
          '</div>' +
          '<div style="margin-top:8px">還是可以先開新活動，兩邊的紀錄不會互相影響；' +
          '但<b>舊的這一場要等機器全部收回來才關得掉</b>。</div></div>'
        : '') +
      '<label class="field"><span>活動名稱（之後就靠這個分辨）</span>' +
      '<input class="box" id="evName" autocomplete="off" placeholder="例：115年彌陀佛七"></label>' +
      '<label class="field"><span>領用日期（只填「日」，用逗號隔開）</span>' +
      '<input class="box" id="evDays" autocomplete="off" value="' + esc(allDays().join(',')) + '"></label>' +
      '<label class="field" style="flex-direction:row;align-items:center;gap:8px">' +
      '<input type="checkbox" id="evCopy" checked style="width:auto"><span>把機台清冊從「' + esc(cur) + '」複製過來（狀態全部重設為可用）</span></label>' +
      '<p class="hint" style="margin:0">組別與名單不會複製，要重新提報。建立後會自動切到新活動。</p>',
    focus: '#evName',
    buttons: [
      { label: '取消', value: null },
      {
        label: '建立', cls: 'ok',
        collect: function (b) {
          var name = $('#evName', b).value.trim();
          if (!name) { toast('請先給活動一個名稱', true); return false; }
          return { name: name, days: $('#evDays', b).value.trim(), copyDevices: $('#evCopy', b).checked };
        },
      },
    ],
  }).then(function (r) {
    if (!r) return;
    return api('createEvent', r).then(function (d) {
      pending = {}; pendingQty = {};
      viewEventId = null;
      toast('已建立「' + r.name + '」，機台帶過去 ' + (d.devices || 0) + ' 台' +
        (d.unreturnedBefore ? '　·　「' + (d.fromName || '上一場') + '」還有 ' + d.unreturnedBefore + ' 台沒收回來' : ''),
        !!d.unreturnedBefore);
      return load(true).then(function () { showPage('roster'); });
    });
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

function editEventDialog(ev) {
  dialog({
    title: '修改活動 · ' + ev['名稱'],
    body:
      '<label class="field"><span>活動名稱</span>' +
      '<input class="box" id="evName2" autocomplete="off" value="' + esc(ev['名稱']) + '"></label>' +
      '<label class="field"><span>領用日期（只填「日」，用逗號隔開）</span>' +
      '<input class="box" id="evDays2" autocomplete="off" value="' + esc(ev['領用日期'] || '') + '"></label>',
    focus: '#evName2',
    buttons: [
      { label: '取消', value: null },
      {
        label: '儲存', cls: 'ok',
        collect: function (b) {
          var name = $('#evName2', b).value.trim();
          if (!name) { toast('名稱不能空白', true); return false; }
          return { name: name, days: $('#evDays2', b).value.trim() };
        },
      },
    ],
  }).then(function (r) {
    if (!r) return;
    return api('saveEvent', Object.assign({ eventId: ev.id }, r))
      .then(function () { toast('已儲存'); return load(true); });
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

/** 這一場還有幾台在外面沒收回來 */
function unreturnedNow() {
  return state.members.filter(function (m) { return statusOf(m) === 'out'; });
}

function closeEventFlow(ev) {
  confirmBox('關閉活動', '要關閉「' + ev['名稱'] + '」嗎？\n\n關閉之後這一場就只能查看，不能再登記領取或歸還。\n資料不會刪除，隨時可以切回來看，也可以重新開啟。', '關閉活動', 'danger')
    .then(function (yes) {
      if (!yes) return;
      return api('closeEvent', { eventId: ev.id })
        .then(function () { toast('「' + ev['名稱'] + '」已關閉'); return load(true); })
        .catch(function (e) {
          if (e.code !== 'HAS_UNRETURNED') throw e;
          // 機器沒收齊就不能關帳，列出是誰，讓現場去追
          var names = (e.data && e.data.names) || [];
          return dialog({
            title: '還不能關閉 · 機器沒收齊',
            body:
              '<p class="hint" style="margin:0 0 10px"><b>' + esc(e.message) + '</b></p>' +
              '<div class="note" style="margin:0 0 10px;max-height:46vh;overflow:auto">' +
              names.map(function (n) { return '<div>' + esc(n) + '</div>'; }).join('') +
              '</div>' +
              '<p class="hint" style="margin:0">先去把這些收回來、在「待歸還」裡登記歸還，再回來關閉這場活動。</p>',
            buttons: [{ label: '知道了', value: null }],
          });
        });
    })
    .catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

/* ===================== 匯出 ===================== */
function exportRows(filter) {
  return state.members.filter(filter || function () { return true; }).map(function (m) {
    return {
      '分區': m.group.zone, '分區名稱': m.group.zoneName, '項次': m.group.seq,
      '組別': m.group.name, '組長': m.group.leader, '借用分院': m.group.branch, '數量': m.group.qty,
      '姓名': m.name, '行動電話': m.phone, '小幫手編號': m.no,
      '狀態': statusLabel(statusOf(m)),
      '領取時間': m.outAt, '領取經手': m.outBy,
      '歸還時間': m.inAt, '歸還經手': m.inBy,
      '配件缺漏': m.missing, '借用項目': m.group.items, '備註': m.note,
      '領用日期': m.days.join('、'), '領用天數': m.days.length,
      '同名重複': dupOthers(m).join('；'),
    };
  });
}

function buildWorkbook() {
  var wb = XLSX.utils.book_new();
  var add = function (name, rows) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ '（無資料）': '' }]), name);
  };
  add('總表', exportRows());
  BRANCHES.forEach(function (b) {
    add(b, exportRows(function (m) { return m.group.branch === b; }));
  });
  add('尚未歸還', exportRows(function (m) { return statusOf(m) === 'out'; }));
  add('機台清冊', state.devices.map(function (d) {
    var who = state.members.filter(function (m) { return m.outAt && !m.inAt && m.no === d.no && m.group.branch === d.branch; })[0];
    return { '分院': d.branch, '編號': d.no, '狀態': who ? '借出' : d.status, '目前借用者': who ? who.name : '', '備註': d.note };
  }));
  add('每日需用台數', perDayCounts('').map(function (r) {
    var o = { '日期': r.day + ' 日' };
    BRANCHES.forEach(function (b) { o[b] = r[b]; });
    o['合計'] = r.total;
    return o;
  }));
  add('同名重複', Object.keys(state.dups).sort().reduce(function (acc, k) {
    state.dups[k].forEach(function (m) {
      acc.push({
        '姓名': m.name, '組別': m.group.name, '借用分院': m.group.branch, '組長': m.group.leader,
        '小幫手編號': m.no, '狀態': statusLabel(statusOf(m)), '共出現幾組': state.dups[k].length,
      });
    });
    return acc;
  }, []));
  add('操作紀錄', state.logs.map(function (l) {
    return { '時間': l.at, '動作': l.act, '分院': l.branch, '組別': l.group, '姓名': l.name, '編號': l.no, '內容': l.detail, '經手': l.by };
  }));
  return wb;
}

function stamp() {
  var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

function download(blob, name) {
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}

function exportExcel(kind) {
  try {
    var wb = buildWorkbook();
    var base = '小幫手借用表_' + stamp();
    if (kind === 'xlsx') { XLSX.writeFile(wb, base + '.xlsx'); return; }
    try { XLSX.writeFile(wb, base + '.xls', { bookType: 'biff8' }); }
    catch (e) { XLSX.writeFile(wb, base + '.xls', { bookType: 'xlml' }); }   // 舊 Excel 也打得開的備援
  } catch (e) {
    toast('匯出失敗：' + e.message, true);
  }
}

function exportCsv() {
  var rows = exportRows();
  if (!rows.length) { toast('沒有資料', true); return; }
  var cols = Object.keys(rows[0]);
  var csv = [cols.join(',')].concat(rows.map(function (r) {
    return cols.map(function (c) { return '"' + String(r[c] == null ? '' : r[c]).replace(/"/g, '""') + '"'; }).join(',');
  })).join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), '小幫手借用表_' + stamp() + '.csv');
}

/* ===================== 列印 ===================== */
function sortedGroups(branch) {
  return state.groups.filter(function (g) { return !branch || g.branch === branch; })
    .sort(function (a, b) {
      if (a.branch !== b.branch) return BRANCHES.indexOf(a.branch) - BRANCHES.indexOf(b.branch);
      if (a.zone !== b.zone) return (a.zone || '') < (b.zone || '') ? -1 : 1;
      return (parseInt(a.seq, 10) || 0) - (parseInt(b.seq, 10) || 0);
    });
}

function printHead(title, right) {
  return '<h3>' + esc(state.settings.temple || '寶嚴山寶嚴禪寺') + '　' + esc(title) + '</h3>' +
    '<div class="sh-meta"><span>活動：' + esc(state.settings.activity || '') + '</span>' +
    '<span>' + esc(right || '') + '</span>' +
    '<span>列印時間：' + new Date().toLocaleString('zh-TW', { hour12: false }).replace(/\//g, '-') + '</span></div>';
}

/** 一、簽名表：一組一頁，簽名欄留白 */
function buildSign(branch) {
  return sortedGroups(branch).map(function (g) {
    var ms = membersOf(g.id);
    var slots = Math.max(g.qty, ms.length, 1);
    var rows = '';
    for (var i = 0; i < slots; i++) {
      var m = ms[i];
      rows += '<tr><td>' + (i + 1) + '</td><td class="nm">' + esc(m ? m.name : '') + '</td>' +
        '<td>' + esc(m && m.no ? m.no : '') + '</td><td class="sig"></td><td class="sig"></td></tr>';
    }
    return '<div class="sheet">' +
      printHead('小幫手借用簽名表', '借用分院：' + g.branch) +
      '<div class="sh-meta"><span>組別：<b>' + esc(g.name) + '</b>　組長：' + esc(g.leader || '') + '</span>' +
      '<span>數量：' + g.qty + ' 組</span><span>借用項目：' + esc(g.items || '') + '</span></div>' +
      '<table><thead><tr><th style="width:12mm">項次</th><th>姓名</th><th style="width:26mm">小幫手編號</th>' +
      '<th class="sig">領取簽名</th><th class="sig">歸還簽名</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '</div>';
  }).join('');
}

/** 二、名單清冊：一個分院一頁，印出目前領取狀況 */
function buildRoster(branch) {
  var brs = branch ? [branch] : BRANCHES;
  return brs.map(function (b) {
    var gs = sortedGroups(b);
    if (!gs.length) return '';
    var rows = '', n = 0;
    gs.forEach(function (g) {
      var ms = membersOf(g.id);
      if (!ms.length) {
        rows += '<tr><td class="l">' + esc(g.name) + '</td><td class="l" colspan="6">（名單還沒填）</td></tr>';
        return;
      }
      ms.forEach(function (m, i) {
        var s = statusOf(m);
        n++;
        var od = dupOthers(m);
        rows += '<tr>' +
          '<td class="l">' + (i === 0 ? esc(g.name) : '') + '</td>' +
          '<td class="l">' + esc(m.name) + (od.length ? '<small>※同名' + (od.length + 1) + '組</small>' : '') + '</td>' +
          '<td>' + esc(m.no || '') + '</td>' +
          '<td class="l">' + esc(m.phone || '') + '</td>' +
          '<td>' + esc(daysLabel(m.days)) + '</td>' +
          '<td>' + statusLabel(s) + '</td>' +
          '<td>' + esc((m.outAt || '').slice(5, 16)) + '</td>' +
          '<td>' + esc((m.inAt || '').slice(5, 16)) + (m.missing ? '<br>⚠' + esc(m.missing) : '') + '</td>' +
          '</tr>';
      });
    });
    var all = state.members.filter(function (m) { return m.group.branch === b; });
    var out = all.filter(function (m) { return statusOf(m) === 'out'; }).length;
    var back = all.filter(function (m) { return statusOf(m) === 'back'; }).length;
    return '<div class="sheet compact">' +
      printHead('小幫手借用名單清冊', '借用分院：' + b) +
      '<div class="sh-meta"><span>名單 ' + n + ' 人</span><span>領取中（未歸還）' + out + '</span><span>已歸還 ' + back + '</span></div>' +
      '<table><thead><tr><th style="width:28mm">組別</th><th style="width:24mm">姓名</th><th style="width:16mm">編號</th>' +
      '<th style="width:24mm">行動電話</th><th style="width:18mm">領用日期</th><th style="width:16mm">狀態</th>' +
      '<th style="width:22mm">領取</th><th style="width:22mm">歸還</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }).join('');
}

/** 每一天各分院要準備幾台 */
function perDayCounts(branch) {
  var ms = state.members.filter(function (m) { return !branch || m.group.branch === branch; });
  return allDays().map(function (d) {
    var row = { day: d, total: 0 };
    BRANCHES.forEach(function (b) { row[b] = 0; });
    ms.forEach(function (m) {
      if (m.days.indexOf(d) < 0) return;
      row.total++;
      row[m.group.branch]++;
    });
    return row;
  });
}

/** 三、分組總表：一張紙看全場 */
function buildSummary(branch) {
  var gs = sortedGroups(branch);
  var tQty = 0, tM = 0, tOut = 0, tBack = 0;
  var rows = gs.map(function (g) {
    var ms = membersOf(g.id);
    var out = ms.filter(function (m) { return statusOf(m) === 'out'; }).length;
    var back = ms.filter(function (m) { return statusOf(m) === 'back'; }).length;
    tQty += g.qty; tM += ms.length; tOut += out; tBack += back;
    var short = g.qty - ms.length;
    return '<tr><td>' + esc(g.zone || '') + '</td><td class="l">' + esc(g.name) + '</td>' +
      '<td class="l">' + esc(g.leader || '') + '</td><td>' + esc(g.branch) + '</td>' +
      '<td>' + g.qty + '</td><td>' + ms.length + (short > 0 ? '<small>（缺' + short + '）</small>' : '') + '</td>' +
      '<td>' + (out || '') + '</td><td>' + (back || '') + '</td></tr>';
  }).join('');
  return '<div class="sheet compact">' +
    printHead('小幫手借用分組總表', branch ? '借用分院：' + branch : '全部分院') +
    '<table><thead><tr><th style="width:12mm">分區</th><th>組別</th><th style="width:28mm">組長</th>' +
    '<th style="width:16mm">分院</th><th style="width:16mm">數量</th><th style="width:24mm">名單</th>' +
    '<th style="width:18mm">未歸還</th><th style="width:18mm">已歸還</th></tr></thead><tbody>' + rows +
    '<tr class="tot"><td colspan="4">合計 ' + gs.length + ' 組</td><td>' + tQty + '</td><td>' + tM + '</td>' +
    '<td>' + tOut + '</td><td>' + tBack + '</td></tr>' +
    '</tbody></table>' +
    '<h4 style="margin:6mm 0 2mm;font-size:11pt">每日需用台數（依名單上勾選的領用日期）</h4>' +
    '<table><thead><tr><th style="width:20mm">日期</th>' +
    (branch ? '' : BRANCHES.map(function (b) { return '<th>' + b + '</th>'; }).join('')) +
    '<th>合計</th></tr></thead><tbody>' +
    perDayCounts(branch).map(function (r) {
      return '<tr><td>' + esc(r.day) + ' 日</td>' +
        (branch ? '' : BRANCHES.map(function (b) { return '<td>' + r[b] + '</td>'; }).join('')) +
        '<td><b>' + r.total + '</b></td></tr>';
    }).join('') +
    '</tbody></table></div>';
}

function buildPrint(kind, branch) {
  var html = kind === 'roster' ? buildRoster(branch)
    : kind === 'summary' ? buildSummary(branch)
      : buildSign(branch);
  $('#printArea').innerHTML = html || '<div class="sheet"><h3>沒有資料</h3></div>';
}

var PRINT_HINT = {
  sign: '比照原本紙本的借用簽名表（項次／姓名／編號／領取簽名／歸還簽名），一組一頁，簽名欄留白。法會前先印一份當斷網備援。',
  roster: '印出每一位目前的編號、電話、是否已領、是否已還、領取與歸還時間，一個分院一頁，給負責人核對用。',
  summary: '一頁列完所有組別：分區、組別、組長、借用分院、數量、名單人數（含還缺幾位）、未歸還、已歸還，給總幹事掌握全場。',
};

/* ===================== 機台清冊 ===================== */
function deviceDialog(branch, no) {
  var d = state.devices.filter(function (x) { return x.branch === branch && x.no === no; })[0];
  if (!d) return;
  var holder = state.members.filter(function (m) { return m.outAt && !m.inAt && m.no === no && m.group.branch === branch; })[0];
  var sts = ['可用', '維修', '遺失'];
  dialog({
    title: branch + ' ' + no,
    body:
      (holder
        ? '<p class="hint" style="margin:0 0 12px">目前在 <b>' + esc(holder.name) + '</b>（' + esc(holder.group.name) + '）手上，領於 ' + esc(holder.outAt) + '。要改狀態請先讓他歸還。</p>'
        : '<label class="field"><span>狀態</span><select class="box" id="dvSt">' +
          sts.map(function (s) { return '<option value="' + s + '"' + (d.status === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') +
          '</select></label>') +
      '<label class="field"><span>備註</span><input class="box" id="dvNote" autocomplete="off" value="' + esc(d.note || '') + '"></label>',
    buttons: [
      { label: '取消', value: null },
      {
        label: '儲存', cls: 'primary',
        collect: function (b) {
          var st = $('#dvSt', b);
          return { '狀態': st ? st.value : d.status, '備註': $('#dvNote', b).value.trim() };
        },
      },
    ],
  }).then(function (r) {
    if (!r) return;
    return api('saveDevice', Object.assign({ branch: branch, no: no }, r)).then(function () { toast('已儲存'); return load(true); });
  }).catch(function (e) { toast(e.message, true); });
}

/** 依各組申請數量的加總，把某分院的機台清冊調成一樣多 */
function syncDevices(branch, need) {
  confirmBox(branch + ' · 調整機台清冊',
    '把 ' + branch + ' 的機台清冊調成 ' + need + ' 台（＝該分院各組申請數量的加總）。\n\n' +
    '已經存在的編號與狀態會保留，只是補上或拿掉後面的編號。',
    '調成 ' + need + ' 台', 'primary')
    .then(function (yes) {
      if (!yes) return;
      return api('resetDevices', { branch: branch, count: need })
        .catch(function (e) {
          if (e.code !== 'DEVICE_BUSY') throw e;
          return confirmBox('還有借出中', e.message + '\n\n仍要調整嗎？', '仍要調整', 'danger').then(function (y) {
            if (!y) throw new Error('已取消');
            return api('resetDevices', { branch: branch, count: need, force: true });
          });
        })
        .then(function () { toast(branch + ' 機台清冊已調成 ' + need + ' 台'); return load(true); });
    })
    .catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

function resetDevices(branch) {
  var cur = state.devices.filter(function (d) { return d.branch === branch; }).length;
  dialog({
    title: branch + ' · 調整台數',
    body:
      '<p class="hint" style="margin:0 0 10px">目前清冊有 ' + cur + ' 台。改成 N 台之後，編號是 01 到 N，已經存在的編號狀態會保留。</p>' +
      '<label class="field"><span>台數</span><input class="box" id="rvN" type="number" min="0" max="500" value="' + cur + '"></label>',
    focus: '#rvN',
    buttons: [
      { label: '取消', value: null },
      {
        label: '確定', cls: 'primary',
        collect: function (b) {
          var n = parseInt($('#rvN', b).value, 10);
          if (isNaN(n) || n < 0) { toast('請填數字', true); return false; }
          return n;
        },
      },
    ],
  }).then(function (n) {
    if (n === null) return;
    return api('resetDevices', { branch: branch, count: n })
      .catch(function (e) {
        if (e.code !== 'DEVICE_BUSY') throw e;
        return confirmBox('還有借出中', e.message + '\n\n仍要調整嗎？', '仍要調整', 'danger').then(function (yes) {
          if (!yes) throw new Error('已取消');
          return api('resetDevices', { branch: branch, count: n, force: true });
        });
      })
      .then(function () { toast('已調整'); return load(true); });
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

/* ===================== 事件 ===================== */
function byId(id) { return state.members.filter(function (m) { return m.id === id; })[0]; }

/* 申請數量：在 <summary> 裡面，要擋掉冒泡免得一點就把組別收合 */
document.addEventListener('click', function (e) {
  if (e.target.closest('.qtybox')) { e.preventDefault(); e.stopPropagation(); }
}, true);
document.addEventListener('input', function (e) {
  var box = e.target.closest('input.qty');
  if (box && !readOnly()) setQty(box.dataset.gid, box.value);
});
document.addEventListener('keydown', function (e) {
  if (e.target.closest('input.qty') && e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
});

document.addEventListener('click', function (e) {
  var day = e.target.closest('.daystrip .dayb');
  if (day) {
    if (readOnly()) return;                // 唯讀：領用日期不給點
    toggleDay(day.closest('.daystrip').dataset.mid, day.dataset.day);
    return;
  }
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var act = b.dataset.act;

  // 活動本身的操作：就算正在看已關閉的活動也要能按（否則再也切不回去）
  if (act.indexOf('ev-') === 0) {
    if (isGuest() && act !== 'ev-view' && act !== 'ev-back') { toast('訪客帳號只能查看，不能修改', true); return; }
    var ev = (state.events || []).filter(function (x) { return x.id === b.dataset.ev; })[0];
    if (act === 'ev-back') { switchViewTo(null).then(function (d) { if (d) toast('已回到目前的活動'); }).catch(function () {}); return; }
    if (!ev) { toast('找不到這場活動，重新整理看看', true); return; }
    if (act === 'ev-view') { switchViewTo(ev.id).then(function (d) { if (d) toast('正在看「' + ev['名稱'] + '」'); }).catch(function () {}); return; }
    if (act === 'ev-current') {
      if (viewEventId == null) viewEventId = state.eventId;   // 先釘住，之後就算沒重載也不會寫到別場
      api('switchEvent', { eventId: ev.id }).then(function () {
        return switchViewTo(null).then(function (d) {
          toast(d ? '目前活動已改成「' + ev['名稱'] + '」'
                  : '目前活動已改成「' + ev['名稱'] + '」，你的畫面還停在原來那一場，按 ↻ 更新才會換過去', !d);
        });
      }).catch(function (e) { toast(e.message, true); });
      return;
    }
    if (act === 'ev-close') { closeEventFlow(ev); return; }
    if (act === 'ev-reopen') {
      api('reopenEvent', { eventId: ev.id })
        .then(function () { toast('「' + ev['名稱'] + '」已重新開啟'); return load(true); })
        .catch(function (e) { toast(e.message, true); });
      return;
    }
    if (act === 'ev-edit') { editEventDialog(ev); return; }
    return;
  }

  // 唯讀：訪客，或正在看已關閉的活動（伺服器端還有一道）
  if (readOnly()) {
    toast(isGuest() ? '訪客帳號只能查看，不能修改' : '這場活動已經關閉了，只能查看', true);
    return;
  }
  if (act === 'out') doCheckout(byId(b.dataset.id));
  else if (act === 'in') doReturn(byId(b.dataset.id));
  else if (act === 'undo-out') doUndo(byId(b.dataset.id), 'checkout');
  else if (act === 'undo-in') doUndo(byId(b.dataset.id), 'return');
  else if (act === 'edit') editMember(byId(b.dataset.id));
  else if (act === 'add-member') addMember(state.gById[b.dataset.gid]);
  else if (act === 'edit-group') editGroup(state.gById[b.dataset.gid]);
  else if (act === 'dev') deviceDialog(b.dataset.branch, b.dataset.no);
  else if (act === 'reset-dev') resetDevices(b.dataset.branch);
  else if (act === 'sync-dev') syncDevices(b.dataset.branch, parseInt(b.dataset.need, 10));
});

// 對話框裡「其他…」的連動
document.addEventListener('change', function (e) {
  if (e.target.id === 'dSel') $('#dOtherWrap').hidden = e.target.value !== '__other';
  if (e.target.id === 'dMiss') $('#dMissWrap').hidden = e.target.value !== '__other';
});

function showPage(name) {
  if (name === 'logs') ensureLogs();
  $$('nav.tabs button').forEach(function (x) { x.setAttribute('aria-selected', x.dataset.page === name); });
  $$('section.page').forEach(function (p) { p.classList.toggle('on', p.id === 'page-' + name); });
  window.scrollTo(0, 0);
}

$$('nav.tabs button').forEach(function (b) {
  b.addEventListener('click', function () { showPage(b.dataset.page); });
});

/* ---------- 後台 ---------- */
function setAdmin(on) {
  adminOn = !!on;
  $$('nav.tabs button[data-admin]').forEach(function (b) { b.hidden = !adminOn; });
  var btn = $('#btnAdmin');
  btn.textContent = isGuest()
    ? (adminOn ? (narrow() ? '收起' : '收起完整資料') : (narrow() ? '完整' : '完整資料'))
    : (adminOn ? (narrow() ? '離開' : '離開後台') : (narrow() ? '後台' : '後台管理'));
  btn.className = 'btn sm' + (adminOn ? ' ghost' : '');
  if (adminOn) sessionStorage.setItem('xbs_admin', '1');
  else sessionStorage.removeItem('xbs_admin');
  // 離開後台時，若正停在後台頁面就退回領取／歸還
  var cur = $('section.page.on');
  if (!adminOn && cur && $('nav.tabs button[data-page="' + cur.id.replace('page-', '') + '"][data-admin]')) {
    showPage('counter');
  }
  renderCounter(); renderDash();
}

on('#btnAdmin', 'click', function () {
  if (adminOn) { setAdmin(false); toast(isGuest() ? '已收起' : '已離開後台'); return; }
  if (isGuest()) {
    setAdmin(true);
    showPage('events');
    toast('完整資料：活動、名單、機台、操作紀錄、列印下載都看得到，但不能修改');
    return;
  }
  askAdminName().then(function (who) {
    if (!who) return;
    setAdmin(true);
    showPage('events');
    toast('後台管理 · ' + who + '　（這次進出會記在操作紀錄裡）');
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
});

/** 進後台一定要留名，記進操作紀錄，事後才知道是誰動的 */
function askAdminName() {
  return dialog({
    title: '請問是哪一位要進後台？',
    body:
      '<p class="hint" style="margin:0 0 10px">後台可以改名單、改組別、開關活動。' +
      '留下名字之後，這次進後台以及接下來改的每一筆都會記在操作紀錄裡。關掉瀏覽器就清除。</p>' +
      '<label class="field"><span>名字</span>' +
      '<input class="box" id="dAdmin" autocomplete="off" value="' + esc(adminBy || operator || '') + '"></label>',
    focus: '#dAdmin',
    buttons: [
      { label: '取消', value: null },
      {
        label: '進後台', cls: 'ok',
        collect: function (b) {
          var v = $('#dAdmin', b).value.trim();
          if (!v) { toast('請留下名字', true); return false; }
          return v;
        },
      },
    ],
  }).then(function (who) {
    if (!who) return null;
    adminBy = who;
    sessionStorage.setItem('xbs_adminby', who);
    return api('enterAdmin', { by: who }).then(function () { return who; })
      .catch(function (e) {
        // 記不進去也別擋住人進後台，現場要緊
        if (window.console) console.warn('記錄進後台失敗', e);
        return who;
      });
  });
}

on('#q', 'input', renderCounter);
on('#fBranch', 'change', function () { paintGroupFilter(); renderCounter(); });
on('#fGroup', 'change', renderCounter);
on('#dashMode', 'click', function (e) {
  var b = e.target.closest('.mode');
  if (!b) return;
  dashMode = b.getAttribute('data-dash') || 'branch';
  paintDashMode();
});

on('#cMode', 'click', function (e) {
  var b = e.target.closest('.mode');
  if (!b) return;
  counterMode = b.getAttribute('data-mode') || '';
  renderCounter();
});
on('#rBranch', 'change', renderRoster);
on('#rQ', 'input', renderRoster);
on('#btnSaveAll', 'click', saveAllDays);
on('#btnDiscard', 'click', function () {
  confirmBox('放棄變更', '剛剛改的 ' + pendingCount() + ' 筆（領用日期與申請數量）都不存，確定嗎？', '放棄', 'danger')
    .then(function (yes) {
      if (!yes) return;
      pending = {}; pendingQty = {};
      renderRoster(); paintSaveBar(); toast('已放棄變更');
    });
});
window.addEventListener('beforeunload', function (e) {
  if (pendingCount()) { e.preventDefault(); e.returnValue = ''; }
});
on('#btnReload', 'click', function () {
  var onLogs = $('section.page.on') && $('section.page.on').id === 'page-logs';
  load(true)
    .then(function () { return onLogs ? ensureLogs(true) : null; })
    .then(function () { toast('已更新'); })
    .catch(function (e) { toast(e.message, true); });
});
on('#btnAddGroup', 'click', function () { editGroup(null); });
on('#btnNewEvent', 'click', newEventDialog);
on('#btnXls', 'click', function () { exportExcel('xls'); });
on('#btnXlsx', 'click', function () { exportExcel('xlsx'); });
on('#btnCsv', 'click', exportCsv);
function paintPrintHint() { $('#pHint').textContent = PRINT_HINT[$('#pKind').value] || ''; }
on('#pKind', 'change', paintPrintHint);
on('#btnPrint', 'click', function () {
  buildPrint($('#pKind').value, $('#pBranch').value);
  setTimeout(function () { window.print(); }, 80);
});
on('#hdWho', 'click', function () { askOperator(true); });

function doLogout() {
  var ask = pendingCount()
    ? confirmBox('還有沒存的變更', '有 ' + pendingCount() + ' 位的領用日期還沒儲存，登出就會不見。\n\n確定要登出嗎？', '還是要登出', 'danger')
    : Promise.resolve(true);
  ask.then(function (yes) {
    if (!yes) return;
    sessionStorage.removeItem('xbs_pw');
    sessionStorage.removeItem('xbs_opr');
    sessionStorage.removeItem('xbs_admin');
    sessionStorage.removeItem('xbs_adminby');   // 共用手機：不要把上一個人的名字留給下一個人
    adminBy = '';
    location.reload();
  });
}
on('#btnLogout', 'click', doLogout);
on('#btnLogoutTop', 'click', doLogout);

on('#btnChpw', 'click', function () {
  dialog({
    title: '變更密碼',
    body: '<p class="hint" style="margin:0 0 10px">改了之後所有人都要用新密碼，至少 6 個字。</p>' +
      '<label class="field"><span>新密碼</span><input class="box" id="np" type="text" autocomplete="off"></label>',
    focus: '#np',
    buttons: [{ label: '取消', value: null }, {
      label: '變更', cls: 'danger',
      collect: function (b) {
        var v = $('#np', b).value.trim();
        if (v.length < 6) { toast('至少 6 個字', true); return false; }
        return v;
      },
    }],
  }).then(function (v) {
    if (!v) return;
    return api('changePassword', { newPw: v }).then(function () {
      pw = v; sessionStorage.setItem('xbs_pw', v); toast('密碼已變更');
    });
  }).catch(function (e) { toast(e.message, true); });
});

function backendDialog() {
  return dialog({
    title: '設定後端網址',
    body:
      '<p class="hint" style="margin:0 0 10px">Apps Script 部署完成後，貼上結尾是 /exec 的網頁應用程式網址。只存在這台瀏覽器。</p>' +
      '<label class="field"><span>後端網址</span><input class="box" id="bu" autocomplete="off" placeholder="https://script.google.com/macros/s/.../exec" value="' + esc(localStorage.getItem('xbs_backend') || '') + '"></label>',
    focus: '#bu',
    buttons: [{ label: '取消', value: null }, {
      label: '儲存', cls: 'primary',
      collect: function (b) { return $('#bu', b).value.trim(); },
    }],
  }).then(function (v) {
    if (v == null) return;
    if (v) localStorage.setItem('xbs_backend', v); else localStorage.removeItem('xbs_backend');
    toast('已儲存後端網址');
  });
}
// 設定後端網址只留在後台的「列印／下載」頁。登入畫面不給——一般人用不到，
// 按錯只會把自己那台指到錯的網址；真的進不來有「重置這台」可用。
on('#btnBackend2', 'click', backendDialog);

/** 進不來時的萬用解法：把這台存的東西全清掉，回到出廠設定重載 */
on('#btnResetLocal', 'click', function () {
  confirmBox('重置這台',
    '會清掉這台瀏覽器存的密碼、後端網址、經手人與暫存，然後重新載入最新版網頁。\n\n雲端上的名單與紀錄完全不受影響。',
    '清掉並重新載入', 'danger')
    .then(function (yes) {
      if (!yes) return;
      try { localStorage.clear(); sessionStorage.clear(); } catch (e) { /* 無所謂 */ }
      location.replace(location.pathname + '?v=' + Date.now());
    });
});

/* ===================== 登入 ===================== */
function isAuthError(e) { return e && (e.code === 'BAD_PASSWORD' || /密碼不正確/.test(e.message || '')); }

function gateMsg(text, color) {
  var el = $('#gateMsg');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || '';
}

on('#gateForm', 'submit', function (e) {
  e.preventDefault();
  var raw = $('#pw').value;
  var v = cleanPw(raw);
  if (!v) return;
  $('#gateBtn').disabled = true;
  pw = v;

  // Google 的伺服器有時要十幾二十秒才回。沒有回饋的話現場會以為當掉而一直重按，
  // 反而讓後端更塞。這裡把等了幾秒顯示出來，並明講不要重複點。
  var t0 = Date.now();
  var trimmed = raw !== v ? '（已自動去掉前後空白）' : '';
  var tick = setInterval(function () {
    var sec = Math.round((Date.now() - t0) / 1000);
    gateMsg(sec < 8
      ? '核對中…' + trimmed
      : (sec < 25
          ? '核對中…已等 ' + sec + ' 秒，伺服器比較慢，請不要重複點'
          : '還在重試…已等 ' + sec + ' 秒。連線不穩時會自動多試幾次，請再等一下'));
  }, 1000);
  gateMsg('核對中…' + trimmed);

  load()
    .then(function () {
      // 進畫面的過程就算出錯，也絕不能把密碼清掉（否則會變成「看起來已登入、一存檔說密碼不正確」）
      enterSafe();
    })
    .catch(function (err) {
      if (isAuthError(err)) pw = '';
      gateMsg(err.message, 'var(--danger)');
    })
    .finally(function () {
      clearInterval(tick);
      var btn = $('#gateBtn'), inp = $('#pw');
      if (btn) btn.disabled = false;
      if (inp) inp.value = '';
    });
});

function enter() {
  sessionStorage.setItem('xbs_pw', pw);
  var g = $('#gate');
  if (g) g.remove();
  fillSelects();
  paintPrintHint();
  applyRole();
  setAdmin(sessionStorage.getItem('xbs_admin') === '1');
  renderAll();
  paintOperator();
  paintHeaderVar();
  window.addEventListener('resize', function () { paintOperator(); setAdmin(adminOn); paintHeaderVar(); });
  window.addEventListener('orientationchange', function () { setTimeout(paintHeaderVar, 300); });
  startAuto();
  if (!isGuest() && !operator) setTimeout(function () { askOperator(); }, 400);
}

/** 依身分調整畫面：訪客看不到後台、經手人、也沒有任何操作鈕 */
function applyRole() {
  var guest = isGuest();
  var gt = $('#hdGuest'); if (gt) gt.hidden = !guest;
  var ab = $('#btnAdmin'); if (ab) ab.hidden = false;       // 訪客也能看完整資料，只是不能改
  var cp = $('#btnChpw'); if (cp) cp.hidden = guest;           // 變更密碼只有工作人員能動
  paintWriteButtons();
  var tlab = $('#tabCounterLabel');
  if (tlab) tlab.textContent = guest ? '小幫手分配' : '領取／歸還';
  var oh = $('#dashOutHint'); if (oh) oh.hidden = guest;
  var rh = $('#rosterHint');
  if (rh && guest) {
    rh.textContent = '訪客檢視：名單、申請數量、領用日期、機台狀態、操作紀錄都看得到，' +
      '也可以列印和下載，但不能修改。行動電話不開放訪客查看。';
  }
  var qlab = $('#page-counter .field > span');
  if (qlab) qlab.textContent = guest ? '查小幫手分配：輸入姓名、組別或編號' : '搜尋姓名、組別或小幫手編號';
  var gh = $('#counterGuestHint');
  if (gh) gh.hidden = !guest;
}

/** enter() 包一層：畫面出錯就只是提示，不會動到登入狀態 */
function enterSafe() {
  try {
    enter();
  } catch (err) {
    var g = $('#gate');
    if (g) g.remove();
    sessionStorage.setItem('xbs_pw', pw);
    toast('畫面有一處沒畫出來，但資料是好的：' + err.message, true);
    if (window.console) console.error('enter() 失敗', err);
  }
}

/** 密碼失效時（例如有人改了密碼）重新輸入，輸入完原本的動作會自動再跑一次，勾到一半的不會不見 */
var reauthing = null;
function reauth() {
  if (reauthing) return reauthing;
  reauthing = dialog({
    title: '請重新輸入密碼',
    body:
      '<p class="hint" style="margin:0 0 10px">連線的密碼失效了（可能有人改過密碼）。重新輸入後，剛剛還沒存的資料會接著存，不會不見。</p>' +
      '<label class="field"><span>密碼</span><input class="box" id="raPw" type="password" autocomplete="new-password" name="ra-' + Math.random().toString(36).slice(2) + '"></label>',
    focus: '#raPw',
    buttons: [
      { label: '取消', value: null },
      {
        label: '確定', cls: 'primary',
        collect: function (b) {
          var v = cleanPw($('#raPw', b).value);
          if (!v) { toast('請輸入密碼', true); return false; }
          return v;
        },
      },
    ],
  }).then(function (v) {
    reauthing = null;
    if (!v) return false;
    pw = v;
    sessionStorage.setItem('xbs_pw', v);
    return true;
  });
  return reauthing;
}

/* ===================== 啟動 ===================== */
function boot() {
  if (window.CONFIG) {
    $('#gateSub').textContent = window.CONFIG.subtitle || '';
    document.title = (window.CONFIG.title || '小幫手借用系統') + ' · 寶嚴山寶嚴禪寺';
  }
  fillSelects();
  operator = sessionStorage.getItem('xbs_opr') || '';

  // 診斷用：看得出這台連到哪個後端、跑的是哪一版
  var url = backendUrl();
  var override = localStorage.getItem('xbs_backend') ? '（這台自己設過網址）' : '';
  var diag = $('#gateDiag');
  if (diag) diag.textContent = '版本 ' + BUILD + '　·　後端 …' + (url ? url.slice(-16, -5) : '未設定') + override;

  if (!backendUrl()) {
    $('#gateMsg').textContent = '還沒設定後端網址，請先點下面的按鈕設定。';
    $('#gateMsg').style.color = 'var(--warn)';
    return;
  }
  var saved = sessionStorage.getItem('xbs_pw');
  if (saved) {
    pw = saved;
    load()
      .then(function () { enterSafe(); })
      .catch(function (err) {
        if (isAuthError(err)) { pw = ''; sessionStorage.removeItem('xbs_pw'); }
        else gateMsg(err.message, 'var(--danger)');
        var inp = $('#pw');
        if (inp) inp.focus();
      });
  } else {
    setTimeout(function () { $('#pw').focus(); }, 150);
  }
}

boot();
})();
