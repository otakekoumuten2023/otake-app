/* ============================================================
 * 大竹工務店 共通同期部品 otake-sync.js  v1（2026/10/22）
 *  - スプレッドシート（GAS）との通信に「合言葉」を自動で付ける
 *  - 送信の結果をGASから受け取り、失敗したら画面に表示する
 *    （これまでは失敗しても「完了」と表示されていた）
 *  - 合言葉はこの端末のブラウザにだけ保存する（ページのソースには書かない）
 *  各アプリの <head> で最初に読み込む：<script src="otake-sync.js"></script>
 * ============================================================ */
(function () {
  'use strict';
  var KEY = 'otake_gas_token';
  var GAS_MARK = 'script.google.com/macros/s/';
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  var asked = false;

  function readToken() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function getToken() {
    var t = readToken();
    if (!t && !asked) {
      asked = true;
      t = (window.prompt('スプレッドシート同期の「合言葉」を入力してください。\n（この端末に保存され、次からは聞かれません）') || '').trim();
      if (t) { try { localStorage.setItem(KEY, t); } catch (e) {} }
    }
    return t;
  }
  function isGas(url) { return typeof url === 'string' && url.indexOf(GAS_MARK) >= 0; }

  // ---- 画面下のお知らせ ----
  function banner(msg, kind) {
    try {
      var el = document.getElementById('_otake_sync_banner');
      if (!el) {
        el = document.createElement('div');
        el.id = '_otake_sync_banner';
        el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);max-width:92vw;' +
          'padding:10px 16px;border-radius:10px;font-size:13px;line-height:1.5;z-index:2147483647;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.35);font-family:inherit;white-space:pre-wrap;cursor:pointer';
        el.onclick = function () { el.style.display = 'none'; };
        (document.body || document.documentElement).appendChild(el);
      }
      var err = kind === 'error';
      el.style.background = err ? '#4a1a14' : '#1a3a1a';
      el.style.color = err ? '#ffd2c8' : '#c8f0c8';
      el.style.border = '1px solid ' + (err ? '#a04030' : '#3a7a3a');
      el.textContent = msg;
      el.style.display = 'block';
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.style.display = 'none'; }, err ? 12000 : 3500);
    } catch (e) {}
  }

  function handleError(message, type) {
    if (/合言葉が違/.test(message)) {
      try { localStorage.removeItem(KEY); } catch (e) {}
      asked = false;
      message += '\n次の同期のときに、もう一度合言葉を聞きます。';
    }
    banner('⚠️ スプレッドシートと同期できませんでした' + (type ? '（' + type + '）' : '') + '\n' + message, 'error');
  }

  if (origFetch) {
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url);
      if (!isGas(url)) return origFetch(input, init);

      var token = getToken();
      if (!token) {
        handleError('合言葉が入力されていません。');
        return Promise.reject(new Error('合言葉が未入力です'));
      }
      init = init || {};
      var method = String(init.method || 'GET').toUpperCase();

      if (method === 'GET') {
        var u = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
        return origFetch(u, { method: 'GET', redirect: 'follow' }).then(function (r) {
          r.clone().json().then(function (j) {
            if (j && j.status === 'error') handleError(j.message || '読み込みエラー');
          }).catch(function () {});
          return r;
        });
      }

      // POST：本文に合言葉を足し、結果を読める形（text/plain）で送る
      var body = {};
      try { body = JSON.parse(init.body || '{}'); } catch (e) { body = {}; }
      body.token = token;
      var type = body.type || '';
      return origFetch(url, { method: 'POST', body: JSON.stringify(body), redirect: 'follow' })
        .then(function (r) {
          return r.clone().json().catch(function () { return null; }).then(function (j) {
            if (!j || j.status !== 'ok') {
              var m = (j && j.message) || ('通信エラー（' + r.status + '）');
              handleError(m, type);
              throw new Error('同期失敗: ' + m);
            }
            return r;
          });
        }, function (err) {
          handleError('通信できませんでした（オフラインの可能性）。データはこの端末に保存されています。', type);
          throw err;
        });
    };
  }

  // 他のアプリから使える小道具
  window.OtakeSync = {
    version: 1,
    hasToken: function () { return !!readToken(); },
    resetToken: function () { try { localStorage.removeItem(KEY); } catch (e) {} asked = false; banner('合言葉を消しました。次の同期で入力してください。'); },
    notify: banner
  };
})();
