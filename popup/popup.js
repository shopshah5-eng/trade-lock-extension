/* Trade Lock — popup controller. */
(function () {
  'use strict';

  var R = globalThis.TLRules;
  var els = {};
  ['date', 'planBadge', 'openSettingsTop', 'coachLine', 'banner', 'bannerIcon', 'bannerTitle', 'bannerText', 'bannerCd', 'stats',
   'sessionCard', 'sessionStatusTag', 'sessionHours', 'sessionSchedule', 'sessionTimeLabel', 'sessionCountdown',
   'focusCard', 'focusText', 'focusEditBtn',
   'qaCharts', 'qaOptions', 'qaTechnicals', 'qaAddTrade', 'qaAi', 'qaJournal', 'qaRules',
   'proUpgradeCard', 'proUpgradeBtn',
   'logDrawer', 'logDrawerBody', 'pnl', 'risk', 'addWin', 'addLoss', 'lockNow', 'lockLabel', 'undo', 'openOptions',
   'openOptions2', 'upgradeHeaderBtn', 'viewPlansBtn', 'openSidePanelBtn', 'openDashboardHero', 'footnote'].forEach(function (id) {
    els[id] = document.getElementById(id);
  });

  var view = { state: null, settings: null, license: null, copy: null, untilLabel: '', live: false,
    tabUrl: '', hostname: '' };

  // Load saved Daily Focus goal
  function renderFocus(text) {
    if (els.focusText) els.focusText.textContent = text || 'Stick strictly to predefined setups. Never revenge trade.';
  }
  function loadFocus() {
    try {
      chrome.storage.local.get(['tlDailyFocus'], function (r) {
        if (r && r.tlDailyFocus) renderFocus(r.tlDailyFocus);
      });
    } catch (e) {}
  }
  function icon(name) {
    return '<svg class="tl-icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
  }
  function setBannerIcon(name) {
    if (els.bannerIcon) els.bannerIcon.innerHTML = icon(name);
  }
  function setLockLabel(text) {
    if (els.lockLabel) els.lockLabel.textContent = text;
    else if (els.lockNow) els.lockNow.textContent = text;
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

  function stat(k, v, lim, pct, cls, iconName, tone) {
    return '<div class="stat popup-stat">' +
      '<span class="metric-icon ' + (tone || 'blue') + '">' + icon(iconName || 'trades') + '</span>' +
      '<span class="stat-lbl">' + k + '</span>' +
      '<strong class="stat-val ' + (cls || '') + '" title="' + v + '">' + v + '</strong>' +
      '<span class="stat-sub" title="' + lim + '">' + lim + '</span></div>';
  }

  function hhmm(mins) {
    var m = Math.max(0, Math.min(1439, Number(mins) || 0));
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  function shortCountdown(until, now) {
    var diff = Math.max(0, (until || 0) - (now || Date.now()));
    if (!diff) return 'now';
    var hours = Math.floor(diff / 3600000);
    var minutes = Math.floor((diff % 3600000) / 60000);
    return (hours ? hours + 'h ' : '') + String(minutes).padStart(2, '0') + 'm';
  }

  function renderMarketSession(settings) {
    var s = settings || R.DEFAULT_SETTINGS;
    var now = Date.now();
    var info = R.marketSessionInfo ? R.marketSessionInfo(now, s) :
      { isMarketOpen: !(R.isClosedDay && R.isClosedDay(now, s)), nextSessionOpen: R.nextMarketOpen(now, s) };
    if (els.sessionStatusTag) {
      els.sessionStatusTag.title = info.message || '';
      els.sessionStatusTag.className = 'session-pill ' + (info.isMarketOpen ? 'live' : 'closed');
      els.sessionStatusTag.textContent = info.isMarketOpen ? 'Market Open' : 'Planning Mode';
    }
    if (els.sessionSchedule) {
      els.sessionSchedule.textContent = 'Mon–Fri · ' + hhmm(s.marketOpenMin) + '–' + hhmm(s.marketCloseMin || 930) + ' IST';
    }
    var until = info.nextSessionOpen;
    if (info.isMarketOpen && R.istAtMinutes) until = R.istAtMinutes(now, s.marketCloseMin || 930);
    if (els.sessionTimeLabel) els.sessionTimeLabel.textContent = info.isMarketOpen ? 'Market closes in' : 'Market opens in';
    if (els.sessionCountdown) els.sessionCountdown.textContent = shortCountdown(until, now);
    return info;
  }

  function render() {
    var s = view.settings || R.DEFAULT_SETTINGS;
    var state = view.state;
    var pro = R.isPro(view.license, Date.now());
    var proPlus = R.isProPlus ? R.isProPlus(view.license, Date.now()) : pro;

    var istDate = (state && state.session && state.session.date) ? state.session.date : (R.todayIST ? R.todayIST() : '\u2014');
    if (els.date) els.date.textContent = istDate;
    if (els.planBadge) {
      if (!pro) {
        els.planBadge.textContent = 'FREE';
        els.planBadge.className = 'badge free';
      } else {
        els.planBadge.textContent = proPlus ? 'PRO+' : 'PRO';
        els.planBadge.className = 'badge pro';
      }
    }
    ['qaCharts', 'qaOptions', 'qaTechnicals', 'qaAi'].forEach(function (id) {
      if (!els[id]) return;
      els[id].disabled = !proPlus;
      els[id].title = proPlus ? '' : 'Pro+ AI or Founder Lifetime required';
    });
    if (els.proUpgradeCard) els.proUpgradeCard.style.display = proPlus ? 'none' : 'flex';
    if (els.upgradeHeaderBtn) els.upgradeHeaderBtn.style.display = proPlus ? 'none' : 'inline-block';

    var sessionInfo = renderMarketSession(s);
    var isClosed = !sessionInfo.isMarketOpen;

    if (!state) {
      els.banner.className = 'banner open';
      setBannerIcon(isClosed ? 'clock' : 'shield');
      els.bannerTitle.textContent = isClosed ? 'Planning Mode' : 'Trading Unlocked';
      els.bannerText.textContent = 'Open a broker tab to start your session. Journal and planning tools remain available.';
      els.bannerCd.style.display = 'none';
      els.stats.innerHTML =
        stat('Trades', '0', 'no session', 0, '', 'trades', 'blue') +
        stat('P&L', R.inr(0), 'today', 0, '', 'wallet', 'green') +
        stat('Risk Used', R.inr(0), 'no session', 0, '', 'risk', 'violet') +
        stat('Win Rate', '0%', '0W · 0L', 0, '', 'target', 'amber');
      els.footnote.textContent = 'No active broker session · planning tools available';
      setLockLabel('Lock Trading Now');
      return;
    }

    var sess = state.session;
    var lock = state.lock || {};
    var locked = !!lock.active;

    var mode = (s && s.enforcementMode) || (lock && lock.mode) || 'warning';
    var isWarningMode = mode === 'warning';

    els.banner.className = 'banner ' + (locked ? 'locked' : (state && state.pendingLock ? 'warn' : 'open'));
    if (locked) {
      setBannerIcon('lock');
      if (isWarningMode) {
        els.bannerTitle.textContent = 'Full-Screen Discipline Lock Active';
        els.bannerText.textContent = (view.copy && view.copy.detail)
          ? view.copy.detail + ' Terminal covered by full-screen discipline overlay until next market open.'
          : 'Trading limit reached. Opaque lock overlay covers broker terminal until next market open.';
      } else if (mode === 'order_restrict') {
        var detector = globalThis.TLDetect;
        var onBrokerTab = view.tabUrl && isBrokerUrl(view.tabUrl);
        var verifiedRestriction = !!(onBrokerTab && detector && detector.isVerifiedOrderRestrictionBroker &&
          detector.isVerifiedOrderRestrictionBroker(view.hostname));
        var enforcement = detector && detector.getEnforcementLabel
          ? detector.getEnforcementLabel(view.hostname, mode) : null;
        if (!onBrokerTab) {
          els.bannerTitle.textContent = 'Broker Lock Active';
          els.bannerText.textContent = 'Mode B intercepts new orders only on a verified broker adapter. Open a supported broker tab to see its actual enforcement mode.';
        } else {
          els.bannerTitle.textContent = verifiedRestriction
            ? 'Verified Order Restriction Active' : 'Full-Screen Lock Fallback Active';
          els.bannerText.textContent = enforcement ? enforcement.desc :
            (verifiedRestriction
              ? 'New orders are intercepted on this verified broker adapter. Position exits remain accessible.'
              : 'Order interception is not verified on this broker. The opaque full-screen lock is used instead.');
        }
      } else if (mode === 'full_site') {
        els.bannerTitle.textContent = 'Full Site Restriction Active';
        els.bannerText.textContent = 'Broker domain restricted. Notice: Managing open positions may be affected.';
      } else if (mode === 'chart_only') {
        els.bannerTitle.textContent = 'Charting Site Restricted';
        els.bannerText.textContent = 'Charts restricted. Broker order entry elsewhere is not blocked.';
      } else {
        els.bannerTitle.textContent = (view.copy && view.copy.title) || 'Trading limit reached';
        els.bannerText.textContent = (view.copy && view.copy.detail) || 'A limit was reached for today.';
      }
      els.bannerCd.style.display = 'block';
    } else if (state && state.pendingLock) {
      setBannerIcon('risk');
      els.bannerTitle.textContent = 'Pending Lock — Locks on Exit';
      els.bannerText.textContent = (state.pendingLock.title || 'Limit reached') +
        ' — terminal remains active so you can square off your open trade. Locks automatically the moment your position closes.';
      els.bannerCd.style.display = 'none';
    } else {
      setBannerIcon(isClosed ? 'clock' : 'shield');
      if (isClosed) {
        els.bannerTitle.textContent = 'Planning Mode (' + ({ WEEKEND: 'Weekend', EXCHANGE_HOLIDAY: 'Holiday',
          PRE_MARKET: 'Before open', POST_MARKET: 'After close' }[sessionInfo.sessionType] || 'Market closed') + ')';
        var nextSession = R.nextMarketOpen ? R.istLabel(R.nextMarketOpen(Date.now(), s)) : 'next market session';
        els.bannerText.textContent = 'Markets closed until ' + nextSession + '. Journal and entitled planning tools remain available.';
      } else {
        els.bannerTitle.textContent = 'Trading Unlocked';
        var next = view.violationWarning;
        els.bannerText.textContent = next || 'Trading is allowed. Every fill counts toward your limits.';
      }
      els.bannerCd.style.display = 'none';
    }

    if (els.coachLine && globalThis.TLInsights) {
      if (!proPlus) {
        els.coachLine.style.display = 'none';
      } else {
        var ia = globalThis.TLInsights.analyze(state.log, sess, s);
        var top = ia.signals.find(function (x) { return x.level !== 'ok'; }) || ia.signals[0];
        els.coachLine.style.display = 'block';
        els.coachLine.textContent = 'AI Coach ' + ia.score + '/100 · ' + (top ? top.text : 'Log a trade to start coaching.');
      }
    }

    var pnlCls = sess.pnl > 0 ? 'pos' : (sess.pnl < 0 ? 'neg' : '');
    var capLim = R.dailyRiskLimit ? R.dailyRiskLimit(s) : 0;
    var riskLim = capLim || s.maxDailyRisk;
    var summary = R.summarizeLog ? R.summarizeLog(state.log) : { winRate: 0, wins: 0, losses: 0 };
    els.stats.innerHTML =
      stat('Trades', sess.trades, s.maxTradesPerDay ? 'of ' + s.maxTradesPerDay : 'no cap',
           R.progress(sess.trades, s.maxTradesPerDay), '', 'trades', 'blue') +
      stat('P&L', (sess.pnl > 0 ? '+' : '') + R.inr(sess.pnl), 'realised today',
           R.progress(Math.abs(sess.pnl), s.maxDailyLoss), pnlCls, 'wallet', 'green') +
      stat('Risk Used', R.inr(sess.riskUsed), riskLim ? 'of ' + R.inr(riskLim) : 'no cap',
           R.progress(sess.riskUsed, riskLim), '', 'risk', 'violet') +
      stat('Win Rate', (summary.winRate || 0) + '%', (summary.wins || 0) + 'W · ' + (summary.losses || 0) + 'L',
           0, '', 'target', 'amber');

    if (!isClosed && !s.maxTradesPerDay && !s.maxDailyLoss && !s.profitTarget && !s.maxDailyRisk) {
      els.bannerText.innerHTML = '<span class="warn">No limits are switched on.</span> Set them in settings, or the lock will never trigger.';
    }

    var auto = sess.autoTrades || 0;
    els.footnote.textContent = auto
      ? auto + ' auto \u00b7 ' + Math.max(0, sess.trades - auto) + ' manual \u00b7 streak ' + sess.consecutiveLosses
      : 'streak ' + sess.consecutiveLosses + ' \u00b7 all manual';

    if (els.lockNow) {
      if (locked) {
        if (lock.manual) {
          setLockLabel('Release focus lock');
          els.lockNow.disabled = false;
          els.lockNow.title = 'Release your self-imposed focus lock with confirmation';
        } else {
          setLockLabel('Rule lock active');
          els.lockNow.disabled = true;
          els.lockNow.title = 'Rule-triggered locks cannot be released early';
        }
      } else {
        setLockLabel('Lock Trading Now');
        els.lockNow.disabled = false;
        els.lockNow.title = 'Lock trading terminal immediately';
      }
    }
  }

  function tick() {
    renderMarketSession(view.settings || R.DEFAULT_SETTINGS);
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
    chrome.storage.local.get('tlLicense', function (res) {
      view.license = res.tlLicense || null;
      render();
    });
    activeTab().then(function (tab) {
      view.tabUrl = tab && tab.url ? tab.url : '';
      try { view.hostname = view.tabUrl ? new URL(view.tabUrl).hostname.toLowerCase() : ''; }
      catch (e) { view.hostname = ''; }
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
          view.license = res.license || view.license;
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
      chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense'], function (res) {
        view.license = res.tlLicense || null;
        view.settings = R.effectiveSettings(res.tlSettings, view.license, Date.now());
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
    chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense'], function (res) {
      var settings = R.effectiveSettings(res.tlSettings, res.tlLicense, Date.now());
      view.license = res.tlLicense || null;
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
        if (!res || !res.ok) {
          alert((res && (res.message || res.error)) || 'Could not create the lock. Please try again.');
          return;
        }
        // The background transition already notifies and recovers broker tabs.
        // Do not issue a second, independent content-script lock transition.
        refresh();
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
    var lock = view.state && view.state.lock;
    if (lock && lock.active) {
      if (lock.manual) {
        if (confirm('Are you sure you want to release your self-imposed focus lock early? Automatic risk limit locks cannot be released.')) {
          send('TL_RELEASE_MANUAL', { confirmed: true }).then(function (res) {
            if (res && res.success) {
              refresh();
            } else {
              alert((res && (res.message || res.error)) || 'Could not release lock.');
            }
          });
        }
      } else {
        alert('Discipline lock is active. Rule-triggered locks cannot be released early.');
      }
      return;
    }
    var s = view.settings || R.DEFAULT_SETTINGS;
    var sessionInfo = R.marketSessionInfo ? R.marketSessionInfo(Date.now(), s) : null;
    var isClosed = sessionInfo ? !sessionInfo.isMarketOpen : (R.isClosedDay && R.isClosedDay(Date.now(), s));
    var closedLabel = sessionInfo ? ({ WEEKEND: 'Weekend', EXCHANGE_HOLIDAY: 'Exchange holiday',
      PRE_MARKET: 'Before market open', POST_MARKET: 'After market close' }[sessionInfo.sessionType] || 'Market closed') : 'Market closed';
    var nextSession = R.nextMarketOpen ? R.istLabel(R.nextMarketOpen(Date.now(), s)) : 'next market session';
    var msg = isClosed
      ? 'Market is currently closed (' + closedLabel + ').\n\nNext session: ' + nextSession + '.\n\nLock trading terminal now?'
      : 'Lock the trading terminal screen until ' + nextSession + '?';
    if (confirm(msg)) act('TL_LOCK_NOW');
  });
  els.undo.addEventListener('click', function () {
    chrome.storage.local.get(['tlState', 'tlSettings'], function (res) {
      var settings = Object.assign({}, R.DEFAULT_SETTINGS, res.tlSettings || {});
      var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : null;
      if (!state) return;
      if (state.lock && state.lock.active && !state.lock.manual) {
        alert('Discipline lock is active. Trade counts and losses cannot be reversed while locked.');
        return;
      }
      var e = R.undoLastTrade(state);
      if (!e) { alert('Nothing to undo.'); return; }
      if (e.rejected) {
        alert(e.message || 'Broker-imported fills cannot be erased with manual Undo.');
        return;
      }
      chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }, function () {
        send('TL_REFRESH'); view.state = state; view.copy = null; render(); tick();
      });
    });
  });
  if (els.upgradeHeaderBtn) {
    els.upgradeHeaderBtn.addEventListener('click', function () { openWorkspace('license'); });
  }
  if (els.viewPlansBtn) {
    els.viewPlansBtn.addEventListener('click', function () { openWorkspace('license'); });
  }
  if (els.planBadge) {
    els.planBadge.style.cursor = 'pointer';
    els.planBadge.title = 'Click to view Pro prepaid plans';
    els.planBadge.addEventListener('click', function () { openWorkspace('license'); });
    els.planBadge.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openWorkspace('license'); }
    });
  }

  function openWorkspace(targetTab) {
    var tabKey = targetTab || 'overview';
    try {
      chrome.storage.local.set({ tlActiveTab: tabKey });
    } catch (e) {}

    // In Chrome MV3, chrome.sidePanel.open MUST execute directly within the active user click gesture
    if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function') {
      chrome.windows.getCurrent(function (win) {
        if (win && win.id) {
          if (chrome.sidePanel.setOptions) {
            chrome.sidePanel.setOptions({
              windowId: win.id,
              path: 'options/options.html#' + tabKey,
              enabled: true
            }, function () {
              void chrome.runtime.lastError;
              chrome.sidePanel.open({ windowId: win.id }, function () {
                if (chrome.runtime.lastError) {
                  openTab(tabKey);
                } else {
                  try {
                    chrome.runtime.sendMessage({ type: 'TL_SWITCH_TAB', tab: tabKey }, function () {
                      void chrome.runtime.lastError;
                    });
                  } catch (err) {}
                  window.close();
                }
              });
            });
            return;
          }
          chrome.sidePanel.open({ windowId: win.id }, function () {
            if (chrome.runtime.lastError) {
              openTab(tabKey);
            } else {
              try {
                chrome.runtime.sendMessage({ type: 'TL_SWITCH_TAB', tab: tabKey }, function () {
                  void chrome.runtime.lastError;
                });
              } catch (err) {}
              window.close();
            }
          });
          return;
        }
        openTab(tabKey);
      });
      return;
    }
    openTab(tabKey);
  }

  function openTab(targetTab) {
    var tabKey = targetTab || 'overview';
    var targetUrl = chrome.runtime.getURL('options/options.html#' + tabKey);
    // Reuse existing options tab if already open, avoiding duplicate tabs
    chrome.tabs.query({}, function (tabs) {
      var existing = (tabs || []).find(function (t) {
        return t.url && t.url.indexOf(chrome.runtime.getURL('options/options.html')) !== -1;
      });
      if (existing && existing.id) {
        chrome.tabs.update(existing.id, { active: true, url: targetUrl }, function () {
          if (existing.windowId) chrome.windows.update(existing.windowId, { focused: true });
          window.close();
        });
      } else {
        chrome.tabs.create({ url: targetUrl }, function () {
          window.close();
        });
      }
    });
  }

  if (els.openSettingsTop) els.openSettingsTop.addEventListener('click', function () { openWorkspace('rules'); });
  els.openOptions.addEventListener('click', function () { openWorkspace('overview'); });
  els.openOptions2.addEventListener('click', function () { openWorkspace('rules'); });
  if (els.openSidePanelBtn) {
    els.openSidePanelBtn.addEventListener('click', function () { openWorkspace('overview'); });
  }
  if (els.openDashboardHero) {
    els.openDashboardHero.addEventListener('click', function () { openTab('overview'); });
  }

  if (els.qaCharts) els.qaCharts.addEventListener('click', function () { openWorkspace('market'); });
  if (els.qaOptions) els.qaOptions.addEventListener('click', function () { openWorkspace('options'); });
  if (els.qaTechnicals) els.qaTechnicals.addEventListener('click', function () { openWorkspace('market'); });
  if (els.qaAi) els.qaAi.addEventListener('click', function () { openWorkspace('ai'); });
  if (els.qaJournal) els.qaJournal.addEventListener('click', function () { openWorkspace('journal'); });
  if (els.qaRules) els.qaRules.addEventListener('click', function () { openWorkspace('rules'); });
  if (els.proUpgradeCard) els.proUpgradeCard.addEventListener('click', function () { openWorkspace('license'); });

  function setLogDrawer(open) {
    if (!els.logDrawerBody || !els.logDrawer) return;
    els.logDrawerBody.hidden = !open;
    els.logDrawer.setAttribute('aria-expanded', open ? 'true' : 'false');
    var plus = els.logDrawer.querySelector('.log-plus');
    if (plus) plus.textContent = open ? '−' : '+';
  }
  if (els.logDrawer) els.logDrawer.addEventListener('click', function () {
    setLogDrawer(!els.logDrawerBody || els.logDrawerBody.hidden);
  });
  if (els.qaAddTrade) els.qaAddTrade.addEventListener('click', function () {
    setLogDrawer(true);
    if (els.pnl) {
      els.pnl.focus();
      els.pnl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  if (els.focusEditBtn) {
    els.focusEditBtn.addEventListener('click', function () {
      chrome.storage.local.get(['tlDailyFocus'], function (r) {
        var current = (r && r.tlDailyFocus) || 'Stick strictly to predefined setups. Never revenge trade.';
        var updated = prompt('Set your Daily Trading Focus / Rule:', current);
        if (updated !== null && updated.trim()) {
          var clean = updated.trim();
          chrome.storage.local.set({ tlDailyFocus: clean }, function () { renderFocus(clean); });
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
