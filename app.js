/* 寶嚴小幫手（對講機）借用系統 — 前台
   資料全部放在後端試算表，這個網頁本身不含任何名單。 */
(function () {
'use strict';

/* ===================== 基礎 ===================== */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var esc = function (s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};

var BRANCHES = ['善覺', '善學', '圓道'];

var state = { settings: {}, groups: [], members: [], devices: [], logs: [] };
var pw = '';
var operator = '';
var loading = false;
var adminOn = false;

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

function rawApi(action, payload, tries) {
  var url = backendUrl();
  if (!url) return Promise.reject(new Error('還沒設定後端網址'));
  var body = Object.assign({ action: action, pw: pw, by: operator }, payload || {});
  tries = tries == null ? 4 : tries;

  return fetch(url, {
    method: 'POST',
    // 用 text/plain 送，避免瀏覽器先發 OPTIONS（Apps Script 不處理 preflight）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
  })
    .then(function (r) { return r.text(); })
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
        throw err;
      }
      return data;
    })
    .catch(function (e) {
      var retryable = e.retryable || /Failed to fetch|NetworkError|Load failed/i.test(e.message || '');
      if (tries > 0 && retryable) {
        var waitMs = 700 * (5 - tries);
        return new Promise(function (res) { setTimeout(res, waitMs); })
          .then(function () { return rawApi(action, payload, tries - 1); });
      }
      if (e.retryable) e.message = '網路不穩，試了幾次都連不上後端，請稍後再按一次';
      throw e;
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

  state.logs = (state.raw.logs || []).map(function (l) {
    return { at: l['時間'], act: l['動作'], branch: l['分院'], group: l['組別'], name: l['姓名'], no: l['編號'], detail: l['內容'], by: l['經手'] };
  });

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

function load() {
  if (loading) return Promise.resolve();
  loading = true;
  $('#btnReload').disabled = true;
  return api('load')
    .then(function (d) {
      state.raw = d;
      state.settings = d.settings || {};
      norm();
      renderAll();
      $('#hdActivity').textContent = state.settings.activity || (window.CONFIG && window.CONFIG.subtitle) || '';
      return d;
    })
    .finally(function () { loading = false; $('#btnReload').disabled = false; });
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
  if (operator) { el.hidden = false; el.textContent = '經手：' + operator; }
  else el.hidden = true;
}

/* ===================== 領取／歸還 ===================== */
function availableDevices(branch) {
  var busy = {};
  state.members.forEach(function (m) { if (m.outAt && !m.inAt && m.no) busy[m.no] = m.name; });
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
    var opts = free.map(function (d) { return '<option value="' + esc(d.no) + '">' + esc(branch + ' ' + d.no) + '</option>'; }).join('');

    return dialog({
      title: '登記領取 · ' + m.name,
      body:
        '<p class="hint" style="margin:0 0 12px">' + esc(m.group.name) + '　借用分院：' + esc(branch) + '　借用項目：' + esc(m.group.items || '—') + '</p>' +
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
        .catch(function (e) {
          // 連線重送時第一次其實已經成功 → 當成成功，不要嚇到現場的人
          if (!/已經領取/.test(e.message)) throw e;
        })
        .then(function () { toast(m.name + '　領取 ' + no); return load(); });
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
        .catch(function (e) {
          if (!/已經歸還過了/.test(e.message)) throw e;
        })
        .then(function () { toast(m.name + '　已歸還'); return load(); });
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
        return api('undo', { memberId: m.id, what: what }).then(function () { toast('已' + label); return load(); });
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
        return api('deleteMember', { memberId: m.id }).then(function () { toast('已刪除'); return load(); });
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
      .then(function () { toast('已儲存'); return load(); });
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
      .then(function () { toast('已新增 ' + r.name); return load(); });
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
        return api('deleteGroup', { groupId: g.id, force: true }).then(function () { toast('已刪除'); return load(); });
      });
    }
    return api('saveGroup', Object.assign({ groupId: isNew ? '' : g.id }, r)).then(function () { toast('已儲存'); return load(); });
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
  else acts = '<button class="btn sm ghost" data-act="undo-in" data-id="' + m.id + '" title="取消歸還">↩</button>';
  if (adminOn) acts += '<button class="btn sm ghost" data-act="edit" data-id="' + m.id + '" title="修改">✎</button>';

  var meta = [];
  if (opts.showGroup) meta.push(m.group.name);
  meta.push(m.group.branch);
  if (m.phone) meta.push(m.phone);
  if (s === 'out') meta.push('領於 ' + (m.outAt || '').slice(5, 16));
  if (s === 'back') meta.push('還於 ' + (m.inAt || '').slice(5, 16));
  if (m.missing) meta.push('⚠ ' + m.missing);

  var others = dupOthers(m);
  return '<div class="item is-' + s + '">' +
    '<span class="nm">' + esc(m.name) + '</span>' +
    (m.no ? '<span class="no">' + esc(m.no) + '</span>' : '') +
    (others.length ? '<span class="tag dup" title="同名也在：' + esc(others.join('、')) + '">同名 ' + (others.length + 1) + ' 組</span>' : '') +
    '<span class="tag ' + s + '">' + statusLabel(s) + '</span>' +
    '<span class="tag days' + (m.days.length === allDays().length ? '' : ' part') + '" title="領用日期：' + esc(m.days.join('、') || '未填') + '">' + esc(daysLabel(m.days)) + '</span>' +
    '<span class="meta">' + esc(meta.join('　·　')) + '</span>' +
    '<span class="acts">' + acts + '</span>' +
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
    '<button class="btn sm ghost" data-act="edit" data-id="' + m.id + '" title="改姓名、電話、編號或刪除">✎</button>' +
    '</div>';
}

function renderCounter() {
  var q = $('#q').value.trim().toLowerCase();
  var fb = $('#fBranch').value, fs = $('#fStatus').value;
  var rows = state.members.filter(function (m) {
    if (fb && m.group.branch !== fb) return false;
    if (fs && statusOf(m) !== fs) return false;
    if (!q) return true;
    return (m.name + ' ' + m.group.name + ' ' + (m.group.leader || '') + ' ' + (m.no || '') + ' ' + (m.phone || '')).toLowerCase().indexOf(q) >= 0;
  });
  $('#qCount').textContent = rows.length + ' 筆';
  $('#counterList').innerHTML = rows.length
    ? '<div class="list">' + rows.map(function (m) { return memberRow(m, { showGroup: true }); }).join('') + '</div>'
    : '<div class="empty">沒有符合的人員</div>';
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
var pending = {};   // memberId -> 新的日期字串

function pendingCount() { return Object.keys(pending).length; }

/** 待存的變更裡，一天都沒勾的人（＝要從名單移除的） */
function pendingEmpty() {
  return Object.keys(pending)
    .filter(function (id) { return !pending[id]; })
    .map(function (id) { return state.members.filter(function (m) { return m.id === id; })[0]; })
    .filter(Boolean);
}

function paintSaveBar() {
  var n = pendingCount();
  $('#rosterSave').hidden = n === 0;
  var empties = pendingEmpty();
  $('#rosterSaveMsg').textContent = n
    ? '有 ' + n + ' 位的領用日期還沒存' + (empties.length ? '　·　其中 ' + empties.length + ' 位一天都沒勾，會從名單移除' : '')
    : '';
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
      return '<button type="button" class="dayb' + (cur.indexOf(d) >= 0 ? ' on' : '') + '" data-day="' + esc(d) + '">' + esc(d) + '</button>';
    }).join('') +
    '<button type="button" class="dayb all" data-day="__all">全</button>' +
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
  if (!items.length) return;
  var n = items.length;
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
    $('#btnSaveAll').disabled = true;
    $('#rosterSaveMsg').textContent = '儲存中…（' + n + ' 筆）';
    return api('saveMembersBulk', { items: items })
      .then(function (r) {
        pending = {};
        var del = (r['已移除'] || []).length;
        var held = r['未歸還未移除'] || [];
        toast('已儲存 ' + (n - del) + ' 位' + (del ? '，移除 ' + del + ' 位' : ''));
        if (held.length) {
          setTimeout(function () {
            toast(held.join('、') + ' 手上的小幫手還沒歸還，先留在名單上', true);
          }, 2600);
        }
        return load();
      })
      .catch(function (e) { toast(e.message, true); paintSaveBar(); })
      .finally(function () { $('#btnSaveAll').disabled = false; });
  });
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
    var short = g.qty - ms.length;
    return '<details class="grp"><summary>' +
      '<span class="gn">' + esc(g.name) + '</span>' +
      '<span class="tag branch">' + esc(g.branch) + '</span>' +
      '<span class="gm">' + esc(g.zone ? g.zone + ' ' + g.zoneName + '　·　' : '') + '組長 ' + esc(g.leader || '—') + '　·　' + g.qty + ' 組 / 名單 ' + ms.length + ' 人</span>' +
      '<span class="gs">' +
      (short > 0 ? '<span class="tag">還缺 ' + short + ' 位</span>' : '') +
      (out ? '<span class="tag out">' + out + ' 台未還</span>' : '') +
      '</span></summary>' +
      '<div class="grp-body">' +
      (ms.length ? ms.map(function (m) { return rosterRow(m); }).join('') : '<div class="empty">名單還沒填</div>') +
      '<div style="padding:10px 14px;display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--line-soft)">' +
      '<button class="btn sm" data-act="add-member" data-gid="' + g.id + '">＋ 新增人員</button>' +
      '<button class="btn sm ghost" data-act="edit-group" data-gid="' + g.id + '">修改組別資料</button>' +
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
    return '<div class="card">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
      '<b style="font-size:1.05rem">' + b + '</b>' +
      '<span class="tag">共 ' + ds.length + ' 台</span>' +
      '<span class="tag out">借出 ' + busy + '</span>' +
      '<button class="btn sm ghost" data-act="reset-dev" data-branch="' + b + '" style="margin-left:auto">調整台數</button>' +
      '</div>' +
      (ds.length ? '<div class="devgrid">' + ds.map(function (d) {
        var who = holder[b + '/' + d.no];
        var st = who ? '借出' : d.status;
        return '<button type="button" class="dev s-' + st + '" data-act="dev" data-branch="' + b + '" data-no="' + esc(d.no) + '">' +
          '<b>' + esc(d.no) + '</b><small>' + esc(who || st) + '</small></button>';
      }).join('') + '</div>' : '<div class="empty">還沒建立機台清冊</div>') +
      '</div>';
  }).join('');
}

function renderLogs() {
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
}

function renderAll() {
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
    return api('saveDevice', Object.assign({ branch: branch, no: no }, r)).then(function () { toast('已儲存'); return load(); });
  }).catch(function (e) { toast(e.message, true); });
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
      .then(function () { toast('已調整'); return load(); });
  }).catch(function (e) { if (e && e.message !== '已取消') toast(e.message, true); });
}

/* ===================== 事件 ===================== */
function byId(id) { return state.members.filter(function (m) { return m.id === id; })[0]; }

document.addEventListener('click', function (e) {
  var day = e.target.closest('.daystrip .dayb');
  if (day) {
    toggleDay(day.closest('.daystrip').dataset.mid, day.dataset.day);
    return;
  }
  var b = e.target.closest('[data-act]');
  if (!b) return;
  var act = b.dataset.act;
  if (act === 'out') doCheckout(byId(b.dataset.id));
  else if (act === 'in') doReturn(byId(b.dataset.id));
  else if (act === 'undo-out') doUndo(byId(b.dataset.id), 'checkout');
  else if (act === 'undo-in') doUndo(byId(b.dataset.id), 'return');
  else if (act === 'edit') editMember(byId(b.dataset.id));
  else if (act === 'add-member') addMember(state.gById[b.dataset.gid]);
  else if (act === 'edit-group') editGroup(state.gById[b.dataset.gid]);
  else if (act === 'dev') deviceDialog(b.dataset.branch, b.dataset.no);
  else if (act === 'reset-dev') resetDevices(b.dataset.branch);
});

// 對話框裡「其他…」的連動
document.addEventListener('change', function (e) {
  if (e.target.id === 'dSel') $('#dOtherWrap').hidden = e.target.value !== '__other';
  if (e.target.id === 'dMiss') $('#dMissWrap').hidden = e.target.value !== '__other';
});

function showPage(name) {
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
  btn.textContent = adminOn ? '離開後台' : '後台管理';
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

$('#btnAdmin').addEventListener('click', function () {
  if (adminOn) { setAdmin(false); toast('已離開後台'); return; }
  setAdmin(true);
  showPage('roster');
  toast('後台管理：可以改分組、改名單、列印');
});

$('#q').addEventListener('input', renderCounter);
$('#fBranch').addEventListener('change', renderCounter);
$('#fStatus').addEventListener('change', renderCounter);
$('#rBranch').addEventListener('change', renderRoster);
$('#rQ').addEventListener('input', renderRoster);
$('#btnSaveAll').addEventListener('click', saveAllDays);
$('#btnDiscard').addEventListener('click', function () {
  confirmBox('放棄變更', '剛剛勾的 ' + pendingCount() + ' 位領用日期都不存，確定嗎？', '放棄', 'danger')
    .then(function (yes) { if (!yes) return; pending = {}; renderRoster(); paintSaveBar(); toast('已放棄變更'); });
});
window.addEventListener('beforeunload', function (e) {
  if (pendingCount()) { e.preventDefault(); e.returnValue = ''; }
});
$('#btnReload').addEventListener('click', function () { load().then(function () { toast('已更新'); }).catch(function (e) { toast(e.message, true); }); });
$('#btnAddGroup').addEventListener('click', function () { editGroup(null); });
$('#btnXls').addEventListener('click', function () { exportExcel('xls'); });
$('#btnXlsx').addEventListener('click', function () { exportExcel('xlsx'); });
$('#btnCsv').addEventListener('click', exportCsv);
function paintPrintHint() { $('#pHint').textContent = PRINT_HINT[$('#pKind').value] || ''; }
$('#pKind').addEventListener('change', paintPrintHint);
$('#btnPrint').addEventListener('click', function () {
  buildPrint($('#pKind').value, $('#pBranch').value);
  setTimeout(function () { window.print(); }, 80);
});
$('#hdWho').addEventListener('click', function () { askOperator(true); });

$('#btnLogout').addEventListener('click', function () {
  sessionStorage.removeItem('xbs_pw');
  sessionStorage.removeItem('xbs_opr');
  location.reload();
});

$('#btnChpw').addEventListener('click', function () {
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
$('#btnBackend').addEventListener('click', backendDialog);
$('#btnBackend2').addEventListener('click', backendDialog);

/* ===================== 登入 ===================== */
function isAuthError(e) { return e && (e.code === 'BAD_PASSWORD' || /密碼不正確/.test(e.message || '')); }

function gateMsg(text, color) {
  var el = $('#gateMsg');
  if (!el) return;
  el.textContent = text;
  el.style.color = color || '';
}

$('#gateForm').addEventListener('submit', function (e) {
  e.preventDefault();
  var v = $('#pw').value;
  if (!v) return;
  $('#gateBtn').disabled = true;
  gateMsg('核對中…');
  pw = v;
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
  setAdmin(sessionStorage.getItem('xbs_admin') === '1');
  renderAll();
  paintOperator();
  if (!operator) setTimeout(function () { askOperator(); }, 400);
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
          var v = $('#raPw', b).value.trim();
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
