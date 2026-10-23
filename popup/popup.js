/* Trade Lock — popup controller. */
(function () {
  'use strict';

  var R = globalThis.TLRules;
  var els = {};
  ['date', 'planBadge', 'openSettingsTop', 'coachLine', 'banner', 'bannerTitle', 'bannerText', 'bannerCd', 'stats',
   'focusCard', 'focusText', 'focusEditBtn',
   'qaCharts', 'qaOptions', 'qaAddTrade', 'qaAi', 'qaJournal', 'qaRules',
   'logDrawer', 'pnl', 'risk', 'addWin', 'addLoss', 'lockNow', 'undo', 'openOptions',
   'openOptions2', 'resetDay', 'footnote'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var view = { state: null, settings: null, copy: null, untilLabel: '', live: false };

  // Load saved Daily Focus goal
  function loadFocus() {
    try {
      chrome.storage.local.get(['tlDailyFocus'], function (r) {
        if (r && r.tlDailyFocus) {
          els.focusText.innerHTML = '<b>Daily Focus:</b> ' + escapeHtml(r.tlDailyFocus);
        }
      });
    } catch (e) {}
  }
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function send(type, extra) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, 1200);
      try {
        chrome.runtime.sendMessage(Object.assign({ type: type }, extra || {}), function (res) {
          if (chrome.runtime.lastError) { clearTimeout(t); if (!done) { done = true; resolve(null); } return; }
          clearTimeout(t); if (!done) { done = true; resolve(res); }
        });
      } catch (e) { clearTimeout(t); if (!done) { done = true; resolve(null); } }
    });
  }

  function activeTab() {
    return new Promise(function (resolve) {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) { resolve(tabs && tabs[0]); });
    });
  }

  function tabMessage(tabId, type, extra) {
    return new Promise(function (resolve) {
      var t = setTimeout(function () { resolve(null); }, 900);
      try {
        chrome.tabs.sendMessage(tabId, Object.assign({ type: type }, extra || {}), function (res) {
          clearTimeout(t);
          if (chrome.runtime.lastError) resolve(null); else resolve(res);
        });
      } catch (e) { clearTimeout(t); resolve(null); }
    });
  }

  function stat(k, v, lim, pct, cls) {
    return '<div class="stat"><div class="k">' + k + '</div>' +
      '<div class="v ' + (cls || '') + '">' + v + '</div>' +
      '<div class="lim">' + lim + '</div>' +
      '<div class="mini-bar"><i style="width:' + Math.max(0, Math.min(100, Math.round((pct || 0) * 100))) + '%"></i></div></div>';
  }

  function render() {
    var s = view.settings || R.DEFAULT_SETTINGS;
    var state = view.state;

    els.date.textContent = state && state.session ? state.session.date : '\u2014';
    if (els.planBadge) {
      if (s.freeTier) {
        els.planBadge.textContent = 'FREE';
        els.planBadge.className = 'badge free';
      } else {
        els.planBadge.textContent = 'PRO';
        els.planBadge.className = 'badge pro';
      }
    }

    if (!state) {
      els.banner.className = 'banner open';
      els.bannerTitle.textContent = 'No data yet';
      els.bannerText.innerHTML = 'Open a broker tab (Kite, Upstox, Angel One, Dhan, 5paisa\u2026) ' +
        'and Trade Lock starts counting from the order book.';
      els.bannerCd.style.display = 'none';
      els.stats.innerHTML = '';
      els.footnote.textContent = 'no session';
      return;
    }

    var sess = state.session;
    var lock = state.lock || {};
    var locked = !!lock.active;

    var mode = (s && s.enforcementMode) || (lock && lock.mode) || 'warning';
    var isWarningMode = mode === 'warning';

    els.banner.className = 'banner ' + (locked ? (isWarningMode ? 'warn' : 'locked') : (state && state.pendingLock ? 'warn' : 'open'));
    if (locked) {
      if (isWarningMode) {
        els.bannerTitle.textContent = '⚠️ Discipline Warning Active';
        els.bannerText.textContent = (view.copy && view.copy.detail)
          ? view.copy.detail + ' Terminal remains active — this is a discipline reminder.'
          : 'Trading limit hit. Page remains interactive. This is a behavioral reminder, not an enforced lock.';
      } else if (mode === 'order_restrict') {
        els.bannerTitle.textContent = '🛡️ Order Restriction Active';
        els.bannerText.textContent = 'New orders blocked on verified broker page. Emergency exits (Square off / Exit) remain accessible.';
      } else if (mode === 'full_site') {
        els.bannerTitle.textContent = '🔒 Full Site Restriction Active';
        els.bannerText.textContent = 'Broker domain restricted. Notice: Managing open positions may be affected.';
      } else if (mode === 'chart_only') {
        els.bannerTitle.textContent = '📊 Charting Site Restricted';
        els.bannerText.textContent = 'Charts restricted. Broker order entry elsewhere is not blocked.';
      } else {
        els.bannerTitle.textContent = (view.copy && view.copy.title) || 'Trading limit reached';
        els.bannerText.textContent = (view.copy && view.copy.detail) || 'A limit was reached for today.';
      }
      els.bannerCd.style.display = 'block';
    } else if (state && state.pendingLock) {
      els.bannerTitle.textContent = '⚠️ Pending Lock — Locks on Exit';
      els.bannerText.textContent = (state.pendingLock.title || 'Limit reached') +
        ' — terminal remains active so you can square off your open trade. Locks automatically the moment your position closes.';
      els.bannerCd.style.display = 'none';
    } else {
      els.bannerTitle.textContent = 'Screen unlocked';
      var next = view.violationWarning;
      els.bannerText.textContent = next || 'Trading is allowed. Every fill counts toward your limits.';
      els.bannerCd.style.display = 'none';
    }

    if (els.coachLine && globalThis.TLInsights) {
      if (s.freeTier) {
        els.coachLine.style.display = 'block';
        els.coachLine.innerHTML = '🤖 <b>AI Coach (Pro):</b> revenge-trade & tilt detection, discipline score, day report.';
      } else {
        var ia = globalThis.TLInsights.analyze(state.log, sess, s);
        var top = ia.signals.find(function (x) { return x.level !== 'ok'; }) || ia.signals[0];
        els.coachLine.style.display = 'block';
        els.coachLine.innerHTML = '🤖 <b>Coach ' + ia.score + '/100:</b> ' + (top ? top.text : 'Log a trade to start coaching.');
      }
    }

    var pnlCls = sess.pnl > 0 ? 'pos' : (sess.pnl < 0 ? 'neg' : '');
    var capLim = R.dailyRiskLimit ? R.dailyRiskLimit(s) : 0;
    var riskLim = capLim || s.maxDailyRisk;
    els.stats.innerHTML =
      stat('Trades', sess.trades, s.maxTradesPerDay ? 'of ' + s.maxTradesPerDay : 'no cap',
           R.progress(sess.trades, s.maxTradesPerDay)) +
      stat('Realised', R.inr(sess.pnl), s.maxDailyLoss ? '\u2212' + R.inr(s.maxDailyLoss) + ' limit' : 'no cap',
           R.progress(Math.abs(sess.pnl), s.maxDailyLoss), pnlCls) +
      stat('Risk used', R.inr(sess.riskUsed), riskLim ? R.inr(riskLim) + (capLim ? ' capital budget' : ' budget') : 'no cap',
           R.progress(sess.riskUsed, riskLim));

    if (!s.maxTradesPerDay && !s.maxDailyLoss && !s.profitTarget && !s.maxDailyRisk) {
      els.bannerText.innerHTML = '<span class="warn">No limits are switched on.</span> Set them in settings, or the lock will never trigger.';
    }

    var auto = sess.autoTrades || 0;
    els.footnote.textContent = auto
      ? auto + ' auto \u00b7 ' + Math.max(0, sess.trades - auto) + ' manual \u00b7 streak ' + sess.consecutiveLosses
      : 'streak ' + sess.consecutiveLosses + ' \u00b7 all manual';
  }

  function tick() {
    var lock = view.state && view.state.lock;
    if (lock && lock.active) els.bannerCd.textContent = R.countdown(lock.until, Date.now());
  }

  function isBrokerUrl(url) {
    if (!url) return false;
    try {
      var host = new URL(url).hostname.toLowerCase();
      var hosts = (view.settings && view.settings.blockedHosts) || R.DEFAULT_SETTINGS.blockedHosts || [];
      return hosts.some(function (b) {
        return host === b || host.endsWith('.' + b);
      });
    } catch (e) {
      return false;
    }
  }

  function refresh() {
    activeTab().then(function (tab) {
      if (!tab || !tab.id) return fallback(tab);
      return tabMessage(tab.id, 'TL_PING').then(function (ping) {
        if (!ping || !ping.ok) {
          if (tab.url && isBrokerUrl(tab.url)) {
            send('TL_ENSURE_LOCKED', { tabId: tab.id });
          }
          return fallback(tab);
        }
        view.live = true;
        return tabMessage(tab.id, 'TL_GET_STATE').then(function (res) {
          if (!res || !res.ok) return fallback(tab);
          view.state = res.state;
          view.settings = res.settings;
          view.copy = res.copy;
          view.untilLabel = res.untilLabel;
          render(); tick();
        });
      });
    });
  }

  // Fallback if content script not yet active on this tab: show stored counters.
  function fallback(tab) {
    view.live = false;
    return new Promise(function (resolve) {
      chrome.storage.local.get(['tlState', 'tlSettings'], function (res) {
        view.settings = Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings || {});
        var st = res.tlState;
        if (st) {
          R.syncSession(st, view.settings, Date.now());
          var t = R.tick(st, view.settings, Date.now());
          view.state = t.state;
          var v = t.violation;
          view.copy = v ? { title: v.title, detail: v.detail } : null;
        } else {
          view.state = null;
        }
        render(); tick();
        if (!view.state) return resolve();
        if (view.state.lock && view.state.lock.active) {
          var onBroker = tab && tab.url && isBrokerUrl(tab.url);
          if (!onBroker) {
            els.bannerText.textContent += ' (this tab is not a broker tab \u2014 the overlay shows on broker tabs)';
          }
        }
        resolve();
      });
    });
  }

  function logTrade(sign) {
    var raw = String(els.pnl.value || '').trim();
    var amt = Math.abs(parseFloat(raw.replace(/[^0-9.]/g, '')));
    if (!isFinite(amt) || amt <= 0) { els.pnl.focus(); els.pnl.placeholder = 'enter an amount first'; return; }
    var risk = Math.abs(parseFloat(String(els.risk.value || '').replace(/[^0-9.]/g, ''))) || 0;
    if (!risk) risk = R.plannedRiskPerTrade ? R.plannedRiskPerTrade(view.settings || {}) : 0;

    var payload = { type: 'TL_LOG', pnl: sign * amt, risk: risk, symbol: '' };
    activeTab().then(function (tab) {
      var p = (tab && tab.id) ? tabMessage(tab.id, 'TL_LOG', payload) : Promise.resolve(null);
      return p.then(function (res) {
        if (res && res.ok) { view.state = res.state; render(); tick(); }
        else writeDirect(payload.pnl, risk);
      });
    });
    els.pnl.value = '';
  }

  function writeDirect(pnl, risk) {
    chrome.storage.local.get(['tlState', 'tlSettings'], function (res) {
      var settings = Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings || {});
      var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
      R.logTrade(state, settings, { pnl: pnl, risk: risk, source: 'popup' }, Date.now());
      var t = R.tick(state, settings, Date.now());
      chrome.storage.local.set({ tlState: t.state, tlSavedAt: Date.now() }, function () {
        send('TL_REFRESH');
        view.state = t.state; view.settings = settings;
        view.copy = t.violation ? { title: t.violation.title, detail: t.violation.detail } : null;
        render(); tick();
      });
    });
  }

  function act(type) {
    if (type === 'TL_LOCK_NOW') {
      send('TL_LOCK_NOW').then(function (res) {
        if (res && res.state) view.state = res.state;
        activeTab().then(function (tab) {
          if (tab && tab.id) {
            tabMessage(tab.id, 'TL_LOCK_NOW');
            if (tab.url && isBrokerUrl(tab.url)) {
              send('TL_ENSURE_LOCKED', { tabId: tab.id });
            }
          }
          refresh();
        });
      });
      return;
    }
    activeTab().then(function (tab) {
      var p = (tab && tab.id) ? tabMessage(tab.id, type) : Promise.resolve(null);
      p.then(function (res) {
        if (res && res.ok) { view.state = res.state; render(); tick(); }
      });
    });
  }

  els.addWin.addEventListener('click', function () { logTrade(1); });
  els.addLoss.addEventListener('click', function () { logTrade(-1); });
  els.lockNow.addEventListener('click', function () {
    if (confirm('Lock the trading screen until the next market open?')) act('TL_LOCK_NOW');
  });
  els.undo.addEventListener('click', function () {
    chrome.storage.local.get(['tlState', 'tlSettings'], function (res) {
      var settings = Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings || {});
      var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : null;
      if (!state) return;
      var e = R.undoLastTrade(state);
      if (!e) { alert('Nothing to undo.'); return; }
      if (state.lock.active && !state.lock.manual) R.releaseLock(state);
      chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }, function () {
        send('TL_REFRESH'); view.state = state; view.copy = null; render(); tick();
      });
    });
  });
  els.resetDay.addEventListener('click', function () {
    if (!confirm('Reset today\u2019s counters and clear any lock?')) return;
    activeTab().then(function (tab) {
      var p = (tab && tab.id) ? tabMessage(tab.id, 'TL_RESET') : Promise.resolve(null);
      p.then(function (res) {
        if (res && res.ok) { view.state = res.state; render(); tick(); return; }
        chrome.storage.local.get('tlSettings', function (r2) {
          var settings = Object.assign({}, R.DEFAULT_SETTINGS, r2.tlSettings || {});
          var state = R.resetDay(null, settings, Date.now());
          chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }, function () {
            send('TL_REFRESH'); view.state = state; view.copy = null; render(); tick();
          });
        });
      });
    });
  });
  function openTab(tab) {
    send('TL_OPEN_OPTIONS', { tab: tab }).then(function () {
      window.close();
    });
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
  }

  if (els.openSettingsTop) els.openSettingsTop.addEventListener('click', openOptions);
  els.openOptions.addEventListener('click', openOptions);
  els.openOptions2.addEventListener('click', openOptions);

  if (els.qaCharts) els.qaCharts.addEventListener('click', function () { openTab('charts'); });
  if (els.qaOptions) els.qaOptions.addEventListener('click', function () { openTab('options'); });
  if (els.qaAi) els.qaAi.addEventListener('click', function () { openTab('ai'); });
  if (els.qaJournal) els.qaJournal.addEventListener('click', function () { openTab('journal'); });
  if (els.qaRules) els.qaRules.addEventListener('click', function () { openTab('rules'); });
  if (els.qaAddTrade) els.qaAddTrade.addEventListener('click', function () {
    if (els.pnl) {
      els.pnl.focus();
      els.pnl.scrollIntoView({ behavior: 'smooth' });
    }
  });

  if (els.focusEditBtn) {
    els.focusEditBtn.addEventListener('click', function () {
      chrome.storage.local.get(['tlDailyFocus'], function (r) {
        var current = (r && r.tlDailyFocus) || 'Stick strictly to predefined setups. Never revenge trade.';
        var updated = prompt('Set your Daily Trading Focus / Rule:', current);
        if (updated !== null && updated.trim()) {
          var clean = updated.trim();
          chrome.storage.local.set({ tlDailyFocus: clean }, function () {
            els.focusText.innerHTML = '<b>Daily Focus:</b> ' + escapeHtml(clean);
          });
        }
      });
    });
  }

  els.pnl.addEventListener('keydown', function (e) { if (e.key === 'Enter') logTrade(1); });

  loadFocus();
  refresh();
  setInterval(tick, 500);
  setInterval(refresh, 4000);
})();
