/* ============================================================
 * 大竹工務店 共通同期部品 otake-sync.js  v2（2026/10/24）
 *
 *  v1（10/22）：スプレッドシート（GAS）との通信に合言葉を付け、失敗を画面に出す
 *  v2（10/24）：スマホとPCの「差分同期」
 *    - アプリがデータを保存したら（localStorageへの書き込みを検知）、数秒後に自動で同期
 *    - 前回の同期から変わった記録だけを送る。削除した記録は「削除済み」の印として送る
 *    - 1件ごとに変更時刻を付け、新しい方を残す（GAS v14 の type:'sync'）
 *    - ページを開いたときに、もう一方の端末の変更を取り込む（変わっていたら自動で再表示）
 *  各アプリの <head> で最初に読み込む：<script src="otake-sync.js"></script>
 * ============================================================ */
(function () {
  'use strict';
  var TOKEN_KEY = 'otake_gas_token';
  var GAS_MARK = 'script.google.com/macros/s/';
  var GAS_URL = 'https://script.google.com/macros/s/AKfycby-rf-GVCyiv-NyqC_iQ7MOAL9Z6tmW93G-KoZ8yB-rGUe3SnRZZXPoII-B0t_8HacR/exec';
  var DEBOUNCE_MS = 4000;

  // ---- 同期するデータ（アプリ → まとまり → localStorage のキー） ----
  var APPS = {
    nippo: [{ name: 'nippos', key: 'nip_nippos' }, { name: 'jobs', key: 'nip_jobs' }, { name: 'workers', key: 'nip_workers' }],
    zaiko: [{ name: 'locations', key: 'dk_loc' }, { name: 'items', key: 'dk_items' }, { name: 'history', key: 'dk_hist' },
            { name: 'applied', key: 'dk_nippo_applied', map: true }],
    genka: [{ name: 'cases', key: 'otake_cases_v2' }, { name: 'docs', key: 'otake_docs_v2' }],
    tanka: [{ name: 'items', key: 'otake_tanka_v1' }]
  };
  var APP_LABEL = { nippo: '日報', zaiko: '在庫', genka: '原価', tanka: '単価' };
  var KEY2APP = {};
  Object.keys(APPS).forEach(function (a) { APPS[a].forEach(function (c) { KEY2APP[c.key] = a; }); });

  var store = window.localStorage;
  var origSetItem = Storage.prototype.setItem;
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var asked = false;

  // ============================================================
  // 小道具
  // ============================================================
  function lsGet(k) { try { return store.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { origSetItem.call(store, k, v); }   // 同期部品自身の書き込み（検知しない）
  function now() { return new Date().toISOString(); }

  function readToken() { return lsGet(TOKEN_KEY) || ''; }
  function getToken() {
    var t = readToken();
    if (!t && !asked) {
      asked = true;
      t = (window.prompt('スプレッドシート同期の「合言葉」を入力してください。\n（この端末に保存され、次からは聞かれません）') || '').trim();
      if (t) { try { lsSet(TOKEN_KEY, t); } catch (e) {} }
    }
    return t;
  }

  // 記録の指紋（_ts を除いた中身から作る）
  function strip(r) {
    if (!r || typeof r !== 'object') return r;
    var o = {}; Object.keys(r).forEach(function (k) { if (k !== '_ts') o[k] = r[k]; }); return o;
  }
  function hash(r) {
    var s = JSON.stringify(strip(r)), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
    return h.toString(36) + '.' + s.length;
  }
  function idOf(r) { return (r && r.id !== undefined && r.id !== null && r.id !== '') ? String(r.id) : null; }

  function readLocal(col) {
    var raw = lsGet(col.key);
    if (raw === null || raw === undefined || raw === '') return null;   // この端末にまだない
    var v; try { v = JSON.parse(raw); } catch (e) { return null; }
    if (col.map) {
      if (!v || typeof v !== 'object') return [];
      return Object.keys(v).map(function (k) { return { id: k, lines: v[k] }; });
    }
    return Array.isArray(v) ? v : [];
  }
  function writeLocal(col, list) {
    var val;
    if (col.map) { val = {}; list.forEach(function (r) { val[r.id] = r.lines; }); }
    else val = list;
    lsSet(col.key, JSON.stringify(val));
  }
  function baseKey(app) { return 'otake_sync_base_' + app; }
  function loadBase(app) { try { return JSON.parse(lsGet(baseKey(app)) || 'null'); } catch (e) { return null; } }
  function saveBase(app, b) { lsSet(baseKey(app), JSON.stringify(b)); }
  function hashMap(list) { var m = {}; (list || []).forEach(function (r) { var id = idOf(r); if (id) m[id] = hash(r); }); return m; }

  // ---- 画面下のお知らせ ----
  function banner(msg, kind, action) {
    try {
      var el = document.getElementById('_otake_sync_banner');
      if (!el) {
        el = document.createElement('div');
        el.id = '_otake_sync_banner';
        el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:92vw;' +
          'padding:10px 16px;border-radius:10px;font-size:13px;line-height:1.5;z-index:2147483647;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);font-family:inherit;white-space:pre-wrap;cursor:pointer';
        (document.body || document.documentElement).appendChild(el);
      }
      var err = kind === 'error';
      el.style.background = err ? '#4a1a14' : '#1a3a1a';
      el.style.color = err ? '#ffd2c8' : '#c8f0c8';
      el.style.border = '1px solid ' + (err ? '#a04030' : '#3a7a3a');
      el.textContent = msg;
      el.onclick = function () { el.style.display = 'none'; if (action) action(); };
      el.style.display = 'block';
      clearTimeout(el._t);
      if (!action) el._t = setTimeout(function () { el.style.display = 'none'; }, err ? 12000 : 3500);
    } catch (e) {}
  }
  function handleError(message, type) {
    if (/合言葉が違/.test(message)) {
      try { store.removeItem(TOKEN_KEY); } catch (e) {}
      asked = false;
      message += '\n次の同期のときに、もう一度合言葉を聞きます。';
    }
    banner('⚠️ スプレッドシートと同期できませんでした' + (type ? '（' + type + '）' : '') + '\n' + message, 'error');
  }

  // ============================================================
  // 通信：アプリの古いGAS通信にも合言葉を付ける（v1と同じ）
  //       AI（api.anthropic.com）は使わない設定なので、案内を出して止める
  // ============================================================
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (typeof url === 'string' && url.indexOf('api.anthropic.com') >= 0) {
        banner('AIの自動読み取りは使わない設定です。\n読み取りたい書類・レシートは、Claudeのチャットに貼って読み取ってください。', 'error');
        return Promise.reject(new Error('AI読み取りは使わない設定です（Claudeのチャットで読み取ってください）'));
      }
      if (typeof url !== 'string' || url.indexOf(GAS_MARK) < 0) return origFetch(input, init);
      var token = getToken();
      if (!token) { handleError('合言葉が入力されていません。'); return Promise.reject(new Error('合言葉が未入力です')); }
      init = init || {};
      var method = String(init.method || 'GET').toUpperCase();
      if (method === 'GET') {
        var u = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
        return origFetch(u, { method: 'GET', redirect: 'follow' }).then(function (r) {
          r.clone().json().then(function (j) { if (j && j.status === 'error') handleError(j.message || '読み込みエラー'); }).catch(function () {});
          return r;
        });
      }
      var body = {};
      try { body = JSON.parse(init.body || '{}'); } catch (e) { body = {}; }
      body.token = token;
      var type = body.type || '';
      return origFetch(url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' }).then(function (r) {
        return r.clone().json().catch(function () { return null; }).then(function (j) {
          if (!j || j.status !== 'ok') { var m = (j && j.message) || ('通信エラー（' + r.status + '）'); handleError(m, type); throw new Error('同期失敗: ' + m); }
          return r;
        });
      }, function (err) { handleError('通信できませんでした（オフラインの可能性）。データはこの端末に保存されています。', type); throw err; });
    };
  }

  function postSync(payload) {
    var token = getToken();
    if (!token) return Promise.reject(new Error('合言葉が未入力です'));
    payload.token = token;
    return origFetch(GAS_URL, { method: 'POST', body: JSON.stringify(payload), redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.status !== 'ok') throw new Error((j && j.message) || '同期エラー');
        return j;
      });
  }

  // ============================================================
  // 差分同期の本体
  // ============================================================
  var running = {}, queued = {}, timers = {};
  var remoteChangedApps = {};
  var initDone = false;   // 起動時の同期が終わるまで、自動同期は待つ
  var pendingApps = {};
  var startedAt = Date.now();

  // opts.authoritative：この端末の内容を正としてシートを合わせる（初回だけ・メインの端末で）
  function syncApp(app, opts) {
    opts = opts || {};
    if (running[app]) { queued[app] = true; return running[app]; }
    var cols = APPS[app];
    var base = loadBase(app);
    var t = now();
    var snapshot = {}, collections = {}, stats = { sent: 0, deleted: 0 };
    var askDelete = [];

    cols.forEach(function (col) {
      var local = readLocal(col);
      snapshot[col.name] = lsGet(col.key);
      if (local === null) { collections[col.name] = []; return; }
      var b = base && base[col.name];
      var out = [];
      if (opts.authoritative) {
        local.forEach(function (r) { if (idOf(r)) { var x = strip(r); x._ts = t; out.push(x); } });
      } else if (!b) {
        // 初めての同期：時刻を付けずに送る（シートにある記録はシートを優先、ない記録だけ追加される）
        local.forEach(function (r) { if (idOf(r)) out.push(strip(r)); });
      } else {
        var seen = {};
        local.forEach(function (r) {
          var id = idOf(r); if (!id) return;
          seen[id] = true;
          if (b[id] !== hash(r)) { var x = strip(r); x._ts = t; out.push(x); }
        });
        var gone = Object.keys(b).filter(function (id) { return !seen[id]; });
        if (gone.length && local.length === 0) {
          gone = [];   // 全部消えているのは異常（読み込み途中など）なので、削除としては送らない
        }
        if (gone.length > 10 && gone.length > Object.keys(b).length * 0.5) askDelete.push({ col: col, ids: gone });
        else gone.forEach(function (id) { out.push({ id: id, _deleted: true, _ts: t }); });
        stats.deleted += gone.length;
      }
      stats.sent += out.length;
      collections[col.name] = out;
    });

    // 大量の削除は確認する
    askDelete.forEach(function (d) {
      var okDel = window.confirm(APP_LABEL[app] + 'のデータが ' + d.ids.length + '件 削除されています。\n他の端末とスプレッドシートからも削除しますか？\n（「キャンセル」で削除を送らず、シートから取り戻します）');
      if (okDel) d.ids.forEach(function (id) { collections[d.col.name].push({ id: id, _deleted: true, _ts: t }); });
    });

    var p = (opts.authoritative ? postSync({ type: 'sync', app: app, collections: {} }).then(function (cur) {
      // シートにあって、この端末にない記録を削除の印にする
      cols.forEach(function (col) {
        var local = readLocal(col); if (local === null) return;
        var mine = {}; local.forEach(function (r) { var id = idOf(r); if (id) mine[id] = 1; });
        (cur.collections[col.name] || []).forEach(function (r) { var id = idOf(r); if (id && !mine[id]) collections[col.name].push({ id: id, _deleted: true, _ts: t }); });
      });
      return postSync({ type: 'sync', app: app, collections: collections });
    }) : postSync({ type: 'sync', app: app, collections: collections })).then(function (res) {
      var newBase = {}, changedFromRemote = false, midFlight = false;
      cols.forEach(function (col) {
        var server = (res.collections && res.collections[col.name]) || [];
        // 同期中に新しい入力があったら、その入力を消さない（起動時の同期では、アプリが古い内容を書き戻しただけなのでシートを優先）
        if (!opts.initial && lsGet(col.key) !== snapshot[col.name]) { midFlight = true; return; }
        var before = readLocal(col);
        var hb = hashMap(before || []), hs = hashMap(server);
        var same = Object.keys(hb).length === Object.keys(hs).length && Object.keys(hs).every(function (id) { return hb[id] === hs[id]; });
        if (!same) {
          if (before !== null || server.length) { writeLocal(col, server); }
          if (before !== null || server.length) changedFromRemote = true;
        }
        newBase[col.name] = hs;
      });
      if (midFlight) { queued[app] = true; var ob = loadBase(app) || {}; Object.keys(newBase).forEach(function (k) { ob[k] = newBase[k]; }); saveBase(app, ob); }
      else saveBase(app, newBase);
      lsSet('otake_sync_last_' + app, now());
      if (changedFromRemote) remoteChangedApps[app] = true;
      return { app: app, sent: stats.sent, deleted: stats.deleted, remote: changedFromRemote, changed: res.changed };
    }).catch(function (e) {
      handleError(e.message || String(e), APP_LABEL[app]);
      throw e;
    }).then(function (r) {
      running[app] = null;
      if (queued[app]) { queued[app] = false; schedule(app, 500); }
      return r;
    }, function (e) {
      running[app] = null;
      throw e;
    });
    running[app] = p;
    return p;
  }

  function schedule(app, ms) {
    clearTimeout(timers[app]);
    timers[app] = setTimeout(function () {
      syncApp(app).then(function () { maybeReload(); }).catch(function () {});
    }, ms === undefined ? DEBOUNCE_MS : ms);
  }

  // 画面で入力中なら、終わるまで待ってから再表示する
  function isBusy() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return true;
    var open = document.querySelector('.overlay, .modal-overlay, .sheet, [class*="modal"]:not(#modal-container):not(#modal-wrap)');
    return !!(open && open.offsetParent !== null);
  }
  function maybeReload() {
    var apps = Object.keys(remoteChangedApps);
    if (!apps.length) return;
    var last = parseInt(sessionStorage.getItem('otake_sync_reloaded_at') || '0', 10);
    if (Date.now() - last < 15000) {
      banner('🔄 他の端末の変更があります。タップすると表示を更新します。', 'ok', doReload);
      return;
    }
    if (isBusy()) { setTimeout(maybeReload, 3000); return; }
    doReload();
  }
  function doReload() {
    remoteChangedApps = {};
    try { sessionStorage.setItem('otake_sync_reloaded_at', String(Date.now())); } catch (e) {}
    location.reload();
  }

  // ---- アプリの保存を検知して、自動で同期する ----
  Storage.prototype.setItem = function (k, v) {
    origSetItem.call(this, k, v);
    if (this === store && KEY2APP[k] && readToken()) { if (initDone) schedule(KEY2APP[k]); else pendingApps[KEY2APP[k]] = true; }
  };

  // ---- ページを開いたとき：全アプリ分を順に同期して、他の端末の変更を取り込む ----
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });
  // この端末で初めて同期するとき（まだどのアプリも同期していない）だけ、やり方を選んでもらう
  function hasAnyBase() { return Object.keys(APPS).some(function (a) { return !!loadBase(a); }); }
  function hasAnyLocal() { return Object.keys(APPS).some(function (a) { return APPS[a].some(function (c) { var l = readLocal(c); return l && l.length; }); }); }
  function askFirstMode() {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      wrap.id = '_otake_first_sync';
      wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit';
      var btn = 'display:block;width:100%;text-align:left;margin:8px 0;padding:12px;border-radius:10px;font-size:13px;line-height:1.5;cursor:pointer;';
      wrap.innerHTML = '<div style="background:#1e1e1a;color:#e8d5a3;border:1px solid #444;border-radius:14px;padding:16px;max-width:440px;width:100%">' +
        '<div style="font-size:15px;font-weight:700;margin-bottom:6px">この端末の同期をはじめます</div>' +
        '<div style="font-size:12px;color:#aaa;margin-bottom:6px">スマホとPCで同じデータを使えるようにします。この端末で1回だけ選んでください。</div>' +
        '<button data-m="auth" style="' + btn + 'background:#2a1a0a;color:#f0a030;border:1px solid #5a3a10"><b>この端末を基準にする</b><br><span style="font-size:11px">データがいちばんそろっている端末（PC）で選ぶ。この端末にない記録はシートから削除される</span></button>' +
        '<button data-m="pull" style="' + btn + 'background:#1a2a3a;color:#9cc8f0;border:1px solid #2a4a6a"><b>スプレッドシートに合わせる</b><br><span style="font-size:11px">2台目の端末（スマホ）で選ぶ。この端末の、まだ同期していない分は使わない</span></button>' +
        '<button data-m="merge" style="' + btn + 'background:#222;color:#ccc;border:1px solid #444"><b>両方を合わせる</b><br><span style="font-size:11px">どちらの記録も残す。以前に消した記録が戻ることがある</span></button>' +
        '</div>';
      wrap.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('button[data-m]');
        if (!b) return;
        var m = b.getAttribute('data-m');
        if (m === 'auth' && !window.confirm('この端末の日報・在庫・原価・単価を「正」として、スプレッドシートを合わせます。\nこの端末にない記録は、シートと他の端末からも削除されます。よろしいですか？')) return;
        wrap.remove(); resolve(m);
      });
      (document.body || document.documentElement).appendChild(wrap);
    });
  }

  function initialSync() {
    if (!readToken() && !getToken()) { initDone = true; readyResolve({ skipped: true }); return; }
    var apps = Object.keys(APPS), results = [];
    var chain = Promise.resolve();
    if (!hasAnyBase() && hasAnyLocal()) {
      chain = askFirstMode().then(function (mode) {
        try { sessionStorage.removeItem('otake_sync_reloaded_at'); } catch (e) {}
        var c = Promise.resolve();
        apps.forEach(function (a) {
          c = c.then(function () {
            if (mode === 'auth') {
              var hasLocal = APPS[a].some(function (col) { return readLocal(col) !== null; });
              return (hasLocal ? syncApp(a, { authoritative: true }) : syncApp(a)).then(function (r) { results.push(r); }, function () {});
            }
            if (mode === 'pull') {
              APPS[a].forEach(function (col) { try { store.removeItem(col.key); } catch (e) {} });
            }
            return syncApp(a).then(function (r) { results.push(r); }, function () {});
          });
        });
        return c.then(function () {
          banner('✅ この端末の同期の準備ができました。表示を更新します。');
          setTimeout(doReload, 1200);
          return 'reloading';
        });
      });
      chain.then(function () {});
      return;
    }
    apps.forEach(function (a) { chain = chain.then(function () { return syncApp(a, { initial: true }).then(function (r) { results.push(r); }, function () {}); }); });
    chain.then(function () {
      if (Object.keys(remoteChangedApps).length) { maybeReload(); return; }
      initDone = true;
      Object.keys(pendingApps).forEach(function (a) { schedule(a); });
      pendingApps = {};
      readyResolve({ results: results });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(initialSync, 300); });
  else setTimeout(initialSync, 300);

  // ============================================================
  // 他のアプリから使う道具
  // ============================================================
  window.OtakeSync = {
    version: 2,
    ready: ready,
    hasToken: function () { return !!readToken(); },
    resetToken: function () { try { store.removeItem(TOKEN_KEY); } catch (e) {} asked = false; banner('合言葉を消しました。次の同期で入力してください。'); },
    notify: banner,
    // 今すぐ同期（ボタン用）
    syncNow: function (app) {
      banner('⏳ ' + APP_LABEL[app] + 'を同期しています…');
      return syncApp(app).then(function (r) {
        banner('✅ ' + APP_LABEL[app] + 'を同期しました（送った変更 ' + r.sent + '件）' + (r.remote ? '\n他の端末の変更を取り込みます。' : ''));
        maybeReload();
        return r;
      });
    },
    syncAll: function () {
      var apps = Object.keys(APPS), out = [], chain = Promise.resolve();
      apps.forEach(function (a) {
        chain = chain.then(function () {
          return syncApp(a).then(function (r) { out.push('✅ ' + APP_LABEL[a] + (r.sent ? '（送信' + r.sent + '）' : '')); },
                                 function () { out.push('❌ ' + APP_LABEL[a]); });
        });
      });
      return chain.then(function () { maybeReload(); return out; });
    },
    // この端末の内容を正としてシートを合わせる（移行のとき、メインの端末で1回だけ）
    makeAuthoritative: function (app) {
      return syncApp(app, { authoritative: true }).then(function (r) { banner('✅ ' + APP_LABEL[app] + '：この端末の内容でシートを合わせました'); return r; });
    },
    // この端末の分を捨てて、シートから取り直す
    pullFresh: function (app) {
      APPS[app].forEach(function (c) { try { store.removeItem(c.key); } catch (e) {} });
      try { store.removeItem(baseKey(app)); } catch (e) {}
      return syncApp(app).then(function (r) { doReload(); return r; });
    },
    lastSync: function (app) { return lsGet('otake_sync_last_' + app); },
    apps: Object.keys(APPS)
  };
})();
