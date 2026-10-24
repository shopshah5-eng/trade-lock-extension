/* Trade Lock — script for the lock overlay page (content/lock.html).
 * Kept in an external file rather than an inline <script> block: it is easier
 * to syntax-check, and it keeps lock.html free of inline script entirely.
 */
(function () {
'use strict';
var R = null;

  function money(n) {
    n = Number(n) || 0;
    var neg = n < 0, a = Math.abs(n);
    var s = a.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (neg ? '\u2212\u20B9' : '\u20B9') + s;
  }
  function cd(until) {
    var d = Math.max(0, until - Date.now());
    var h = Math.floor(d / 3600000), m = Math.floor((d % 3600000) / 60000), s = Math.floor((d % 60000) / 1000);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return (h > 0 ? h + ':' : '') + p(m) + ':' + p(s);
  }

  function stat(k, v, cls, pct) {
    return '<div class="stat"><div class="k">' + k + '</div><div class="v ' + (cls || '') + '">' + v + '</div>' +
      (typeof pct === 'number' ? '<div class="bar"><i style="width:' + Math.max(2, Math.round(pct * 100)) + '%"></i></div>' : '') +
      '</div>';
  }

  function render(payload) {
    R = payload || R;
    if (!R) return;
    var s = R.settings || {}, sess = R.session || {}, lock = R.lock || {};

    document.getElementById('eyebrow').textContent =
      lock.manual ? 'Self-imposed lock' : 'Trading screen locked';
    document.getElementById('title').textContent = lock.title || 'You hit your limit';
    document.getElementById('detail').textContent = lock.detail || '';
    document.getElementById('until').textContent =
      'unlocks ' + (R.untilLabel || 'at the next market open');

    var pnlCls = sess.pnl > 0 ? 'pos' : (sess.pnl < 0 ? 'neg' : '');
    document.getElementById('stats').innerHTML =
      stat('Trades today', sess.trades + (s.maxTradesPerDay ? ' / ' + s.maxTradesPerDay : ''), '',
           s.maxTradesPerDay ? sess.trades / s.maxTradesPerDay : null) +
      stat('Realised P&L', money(sess.pnl), pnlCls,
           s.maxDailyLoss ? Math.abs(sess.pnl) / s.maxDailyLoss : null) +
      stat('Risk used', money(sess.riskUsed), '',
           s.maxDailyRisk ? sess.riskUsed / s.maxDailyRisk : null);
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.tl !== 'state') return;
    render(d.payload);
  });

  // Standalone mode: the site itself was hard-blocked by declarativeNetRequest
  // and redirected here, so there is no parent to post state. Read storage.
  var STANDALONE = (function () { try { return window.top === window.self; } catch (e) { return true; } })();

  function fromStorage() {
    if (!STANDALONE || !window.chrome || !chrome.storage) return;
    chrome.storage.local.get(['tlState', 'tlSettings'], function (res) {
      if (chrome.runtime.lastError || !res || !res.tlState || !res.tlState.lock || typeof res.tlState.lock.active !== 'boolean') {
        // Fail-closed recovery: Do not assume lock is released if storage is unreadable or missing.
        // Maintain locked appearance while waiting for authoritative background confirmation.
        document.getElementById('eyebrow').textContent = 'Trade Lock Active';
        document.getElementById('title').textContent = 'Verifying lock state…';
        document.getElementById('detail').textContent =
          'Validating authoritative discipline state with extension background service worker.';
        return;
      }
      var st = res.tlState;
      var lock = st.lock;
      if (!lock.active) {
        document.getElementById('eyebrow').textContent = 'Lock released';
        document.getElementById('title').textContent = 'You are unlocked';
        document.getElementById('detail').textContent =
          'Reload this tab to get back to your broker.';
        document.getElementById('timer').textContent = '00:00';
        return;
      }
      render({
        settings: (res && res.tlSettings) || {},
        session: st.session || {},
        lock: { until: lock.until, manual: !!lock.manual,
                title: lock.manual ? 'Self-imposed lock' : 'Trading screen locked',
                detail: lock.manual
                  ? 'You locked this screen yourself. It reopens at the next market open.'
                  : 'One of your trading rules for today is complete.' },
        untilLabel: 'at the next market open'
      });
    });
  }

  function ask() {
    if (STANDALONE) { fromStorage(); return; }
    try { parent.postMessage({ tl: 'getState' }, '*'); } catch (err) {}
  }
  setInterval(function () {
    if (R && R.lock && R.lock.until) {
      document.getElementById('timer').textContent = cd(R.lock.until);
      if (Date.now() >= R.lock.until) document.getElementById('timer').textContent = 'unlocking\u2026';
    }
  }, 250);
  setInterval(ask, 1000);
  ask();
})();
