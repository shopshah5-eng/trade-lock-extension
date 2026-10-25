/* Trade Lock — options and dashboard controller. */
(function () {
  'use strict';

  var R = globalThis.TLRules;
  var M = globalThis.TLMarket;
  var I = globalThis.TLInsights;

  var NUM = ['maxTradesPerDay', 'maxDailyLoss', 'profitTarget', 'maxConsecutiveLosses',
             'maxRiskPerTrade', 'maxDailyRisk', 'minLockMinutes', 'detectIntervalMs', 'riskPerUnit',
             'totalCapital', 'dailyRiskPercent', 'perTradeRiskPercent'];
  var BOOL = ['skipWeekends', 'skipHolidays', 'autoDetect', 'countAutoTrades',
              'countAutoRisk', 'reloadOnTamper', 'fullSiteAcknowledged'];

  var dirty = false;
  var currentState = null;
  var currentSettings = {};
  var currentLicense = null;
  var currentProfile = { name: 'Trader' };
  var revalidateTried = false;
  var currentJournal = [];

  function el(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  function toggleFullSiteAckBox(mode) {
    var box = el('fullSiteAckBox');
    if (!box) return;
    box.style.display = mode === 'full_site' ? 'block' : 'none';
  }

  // ------------------------------------------------------------- tabs ----

  function switchTab(name) {
    if (!name) name = 'overview';
    var clean = name.replace(/^#/, '');
    var btns = document.querySelectorAll('.nav-tab');
    var contents = document.querySelectorAll('.tab-content');
    var targetBtns = document.querySelectorAll('.nav-tab[data-tab="' + clean + '"]');
    var targetContent = el('tab-' + clean);

    if (!targetContent) {
      clean = 'overview';
      targetBtns = document.querySelectorAll('.nav-tab[data-tab="overview"]');
      targetContent = el('tab-overview');
    }

    btns.forEach(function (b) { b.classList.remove('active'); });
    contents.forEach(function (c) { c.classList.remove('active'); });

    targetBtns.forEach(function (b) { b.classList.add('active'); });
    if (targetContent) targetContent.classList.add('active');

    if (clean === 'overview') {
      if (currentState) renderOverview(currentState, currentSettings);
      if (currentState && currentJournal) renderOverviewJournalSummary(currentState, currentJournal);
      renderOverviewChart();
    } else if (clean === 'market') {
      renderMarketAndOiDashboard();
    } else if (clean === 'options') {
      renderOptionsChainView();
    } else if (clean === 'charts') {
      renderDedicatedChartsView();
    } else if (clean === 'journal') {
      renderMonthlyJournal();
    } else if (clean === 'ai') {
      renderAiCoachView();
    } else if (clean === 'rules') {
      renderRiskRulesView();
    } else if (clean === 'license') {
      renderLicense(currentLicense, currentSettings);
    } else if (clean === 'sites') {
      renderSitesView();
    }

    if (window.location.hash !== '#' + clean) {
      history.replaceState(null, '', '#' + clean);
    }
  }

  function renderRiskRulesView() {
    fill(currentSettings);
    renderCalendarStatus(currentSettings);
  }

  function renderAiCoachView() {
    var box = el('chatMessages');
    if (box && !box.children.length) {
      appendChatMessage('assistant', 'Hello! I am your Trade Lock AI Trading Assistant. I can help interpret computed chart levels, analyze options OI structure, and audit your session discipline. What would you like to review?');
    }
  }

  function renderSitesView() {
    if (el('blockedHosts')) {
      el('blockedHosts').value = (currentSettings && currentSettings.blockedHosts)
        ? currentSettings.blockedHosts.join('\n')
        : '';
    }
    if (chrome.tabs && chrome.tabs.query) {
      chrome.tabs.query({}, function (tabs) {
        var openUrls = (tabs || []).map(function (t) { return (t.url || '').toLowerCase(); });
        var cards = document.querySelectorAll('.brokers-grid .broker-card');
        cards.forEach(function (card) {
          var hostEl = card.querySelector('.b-host');
          if (!hostEl) return;
          var host = hostEl.textContent.trim().toLowerCase();
          var isOpen = openUrls.some(function (u) {
            try { return new URL(u).hostname.toLowerCase().indexOf(host) !== -1; } catch (e) { return false; }
          });
          var existingLive = card.querySelector('.broker-live-tag');
          if (isOpen) {
            if (!existingLive) {
              var liveTag = document.createElement('span');
              liveTag.className = 'badge broker-live-tag';
              liveTag.style.cssText = 'background:rgba(16,185,129,0.2);color:#34d399;font-size:10px;margin-left:6px;padding:1px 6px;border:1px solid rgba(16,185,129,0.3)';
              liveTag.textContent = '● Open Tab Monitored';
              var bInfo = card.querySelector('div');
              if (bInfo) bInfo.appendChild(liveTag);
            }
          } else if (existingLive) {
            existingLive.remove();
          }
        });
      });
    }
  }

  function initTabs() {
    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        if (tab) switchTab(tab);
      });
    });

    window.addEventListener('hashchange', function () {
      switchTab(window.location.hash);
    });

    // Listen for tab switch requests from background service worker (e.g. side panel open)
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (msg && msg.type === 'TL_SWITCH_TAB' && msg.tab) {
          switchTab(msg.tab);
          if (typeof sendResponse === 'function') {
            sendResponse({ ok: true, activeTab: msg.tab });
          }
        }
      });
    }

    if (window.location.hash) {
      switchTab(window.location.hash);
    } else {
      chrome.storage.local.get(['tlActiveTab'], function (res) {
        if (res && res.tlActiveTab) {
          switchTab(res.tlActiveTab);
        } else {
          switchTab('overview');
        }
      });
    }
  }

  // ------------------------------------------------------------- plan ----

  function updatePlanSummary() {
    var cap = parseFloat(el('totalCapital').value) || 0;
    var dPct = parseFloat(el('dailyRiskPercent').value) || 0;
    var tPct = parseFloat(el('perTradeRiskPercent').value) || 0;
    var box = el('planSummary');
    if (!box) return;
    if (cap > 0 && (dPct > 0 || tPct > 0)) {
      var day = R.dailyRiskLimit({ totalCapital: cap, dailyRiskPercent: dPct });
      var per = R.plannedRiskPerTrade({ totalCapital: cap, perTradeRiskPercent: tPct });
      box.innerHTML = 'On ' + R.inr(cap) + ' capital: daily risk budget <b>' + (day ? R.inr(day) : '—') +
        '</b> · planned risk per trade <b>' + (per ? R.inr(per) : '—') + '</b>. ' +
        'The screen locks when the day\'s used risk reaches the budget — but only after your open trade closes.';
    } else {
      box.textContent = 'Set capital and percentages to see your derived limits.';
    }
  }

  function markDirty() {
    dirty = true;
    if (el('dirtyNote')) el('dirtyNote').textContent = 'unsaved changes';
  }

  function minutesToHHMM(m) {
    m = Math.max(0, Math.min(1439, Math.round(Number(m) || 0)));
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function hhmmToMinutes(s) {
    var m = String(s || '').trim().match(/^(\d{1,2})[:.]?(\d{2})?$/);
    if (!m) return null;
    var h = parseInt(m[1], 10), mm = parseInt(m[2] || '0', 10);
    if (h > 23 || mm > 59) return null;
    return h * 60 + mm;
  }

  function parseLines(text) {
    return String(text || '').split(/[\n,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // ------------------------------------------------------------- render ----

  function fill(s) {
    NUM.forEach(function (k) {
      if (el(k)) el(k).value = (s[k] === null || s[k] === undefined) ? '' : s[k];
    });
    BOOL.forEach(function (k) {
      if (el(k)) el(k).checked = !!s[k];
    });
    if (el('enforcementMode')) el('enforcementMode').value = s.enforcementMode || 'warning';
    if (el('fullSiteAcknowledged')) el('fullSiteAcknowledged').checked = !!s.fullSiteAcknowledged;
    toggleFullSiteAckBox(s.enforcementMode || 'warning');
    if (el('marketOpen')) el('marketOpen').value = minutesToHHMM(s.marketOpenMin);
    if (el('marketSymbol') && s.marketSymbol) el('marketSymbol').value = s.marketSymbol;
    if (el('marketSource') && s.marketSource) el('marketSource').value = s.marketSource;
    if (el('planTradesMirror')) el('planTradesMirror').value = s.maxTradesPerDay || '';
    updatePlanSummary();
    if (el('holidays')) el('holidays').value = (s.holidays || []).join('\n');
    if (el('blockedHosts')) el('blockedHosts').value = (s.blockedHosts || []).join('\n');
    if (el('openTimeLabel')) el('openTimeLabel').textContent = minutesToHHMM(s.marketOpenMin) + ' IST';
    renderCalendarStatus(s);
  }

  function renderCalendarStatus(settings) {
    var box = el('calendarStatusBox');
    if (!box || !R || !R.calendarStatus) return;
    var status = R.calendarStatus(Date.now(), settings);
    if (status.stale) {
      box.innerHTML = '⚠️ <span style="color:#f59e0b;font-weight:600">Calendar Update Required:</span> ' +
        escapeHtml(status.message);
    } else if (status.source === 'custom') {
      box.innerHTML = '✓ Using <b>' + status.count + ' custom holiday dates</b>.';
    } else {
      box.innerHTML = '✓ Built-in NSE ' + status.year + ' trading calendar (' + status.count + ' holidays active).';
    }
  }

  function read() {
    var s = Object.assign({}, currentSettings || {});
    NUM.forEach(function (k) {
      if (el(k)) {
        var v = parseFloat(el(k).value);
        s[k] = isFinite(v) ? v : 0;
      }
    });
    BOOL.forEach(function (k) {
      if (el(k)) s[k] = !!el(k).checked;
    });
    if (el('enforcementMode')) s.enforcementMode = el('enforcementMode').value;
    if (el('fullSiteAcknowledged')) s.fullSiteAcknowledged = !!el('fullSiteAcknowledged').checked;
    if (s.enforcementMode === 'full_site' && !s.fullSiteAcknowledged) {
      s.enforcementMode = 'warning';
      if (el('enforcementMode')) el('enforcementMode').value = 'warning';
      toggleFullSiteAckBox('warning');
    }
    if (el('planTradesMirror')) {
      var mirror = parseFloat(el('planTradesMirror').value);
      if (isFinite(mirror)) s.maxTradesPerDay = mirror;
    }
    if (el('marketOpen')) {
      var mo = hhmmToMinutes(el('marketOpen').value);
      s.marketOpenMin = (mo === null ? 555 : mo);
      if (el('openTimeLabel')) el('openTimeLabel').textContent = minutesToHHMM(s.marketOpenMin) + ' IST';
    }
    if (el('marketSymbol')) s.marketSymbol = el('marketSymbol').value;
    if (el('marketSource')) s.marketSource = el('marketSource').value;
    if (el('holidays')) s.holidays = parseLines(el('holidays').value).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); });
    if (el('blockedHosts')) s.blockedHosts = parseLines(el('blockedHosts').value);
    return s;
  }

  function row(k, v, off) {
    return '<tr><td class="k">' + k + '</td><td class="v ' + (off ? 'off' : '') + '">' + v + '</td></tr>';
  }

  function setText(id, value) {
    var node = el(id);
    if (node) node.textContent = value;
  }

  function setBar(id, ratio) {
    var node = el(id);
    if (node) node.style.width = Math.max(0, Math.min(100, Math.round((Number(ratio) || 0) * 100))) + '%';
  }

  function renderOverview(state, settings) {
    settings = settings || R.DEFAULT_SETTINGS;
    var now = Date.now();
    var hasSession = !!(state && state.session);
    var s = hasSession ? state.session : {
      date: R.todayIST(), trades: 0, autoTrades: 0, pnl: 0, riskUsed: 0, consecutiveLosses: 0
    };
    var lock = (state && state.lock) || {};
    var log = (state && state.log) || [];
    var summary = R.summarizeLog(log);
    var info = R.marketSessionInfo(now, settings);
    var riskLim = (R.dailyRiskLimit ? R.dailyRiskLimit(settings) : 0) || settings.maxDailyRisk || 0;
    var tradeRatio = settings.maxTradesPerDay ? R.progress(s.trades, settings.maxTradesPerDay) : 0;
    var riskRatio = riskLim ? R.progress(s.riskUsed, riskLim) : 0;
    var pnlLimit = s.pnl > 0 ? settings.profitTarget : settings.maxDailyLoss;
    var winRatio = Math.max(0, Math.min(1, (summary.winRate || 0) / 100));

    var hour = Math.floor(R.istMinutesOfDay(now) / 60);
    var greeting = hour < 12 ? 'Good morning' : (hour < 17 ? 'Good afternoon' : 'Good evening');
    var pName = (currentProfile && currentProfile.name && currentProfile.name.trim()) ? currentProfile.name.trim() : 'Trader';
    setText('overviewGreeting', greeting + ', ' + pName + ' 👋');
    setText('headerDate', new Date(now).toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kolkata'
    }));

    setText('ovPnlVal', (s.pnl > 0 ? '+' : '') + R.inr(s.pnl));
    if (el('ovPnlVal')) el('ovPnlVal').className = 'overview-metric-value stat-val ' + (s.pnl > 0 ? 'pos' : (s.pnl < 0 ? 'neg' : ''));
    setText('ovPnlSub', pnlLimit ? (s.pnl > 0 ? 'Profit target ' : 'Loss limit ') + R.inr(pnlLimit) : 'Net closed fills · no P&L limit');
    setText('ovTradesVal', s.trades + (settings.maxTradesPerDay ? ' / ' + settings.maxTradesPerDay : ''));
    setText('ovTradesSub', hasSession ? ((s.autoTrades || 0) + ' auto · ' + Math.max(0, s.trades - (s.autoTrades || 0)) + ' manual') : 'No broker session yet');
    setText('ovRiskVal', R.inr(s.riskUsed || 0));
    setText('ovRiskSub', riskLim ? 'of ' + R.inr(riskLim) + ' daily budget' : 'No risk budget set');
    setText('ovWinRateVal', (summary.winRate || 0) + '%');
    setText('ovWinRateSub', (summary.wins || 0) + ' wins · ' + (summary.losses || 0) + ' losses');
    setBar('ovPnlBar', pnlLimit ? R.progress(Math.abs(s.pnl), pnlLimit) : 0);
    setBar('ovTradesBar', tradeRatio);
    setBar('ovRiskBar', riskRatio);
    setBar('ovWinRateBar', winRatio);

    setText('overviewSessionDate', (s.date || R.todayIST()) + ' · Asia/Kolkata');
    setText('overviewSessionState', lock.active ? 'Discipline Lock Active' : (info.isMarketOpen ? 'Trading Session Active' : 'Planning Mode'));
    setText('overviewSessionStateSub', lock.active ? 'Trading paused by your discipline rules' : (info.isMarketOpen ? 'Every counted fill updates your limits' : 'Journal and planning tools available'));
    setText('overviewMarketStatus', info.isMarketOpen ? 'Market open' : 'Market closed');
    if (el('overviewMarketStatus')) el('overviewMarketStatus').className = 'overview-market-status' + (info.isMarketOpen ? '' : ' closed');
    setText('overviewTradeProgress', s.trades + ' / ' + (settings.maxTradesPerDay || 'No cap'));
    setText('overviewProgressPct', settings.maxTradesPerDay ? Math.round(tradeRatio * 100) + '%' : '—');
    setBar('overviewTradeProgressBar', tradeRatio);
    if (el('overviewProgressRing')) el('overviewProgressRing').style.setProperty('--progress', Math.round(tradeRatio * 360) + 'deg');
    setText('overviewSessionTime', info.isMarketOpen
      ? 'Market closes at ' + minutesToHHMM(settings.marketCloseMin || 930) + ' IST'
      : 'Next market open · ' + R.istLabel(info.nextSessionOpen));

    if (I) {
      var analysis = I.analyze(log, s, settings);
      setText('ovDisciplineScore', analysis.score + ' / 100');
      setText('ovDisciplineSub', s.trades ? analysis.grade + ' discipline rating' : 'Awaiting trade data');
    }
    setText('ovStreakVal', s.consecutiveLosses || 0);
    setText('ovStreakSub', settings.maxConsecutiveLosses ? 'Max ' + settings.maxConsecutiveLosses + ' allowed' : 'No streak limit');

    if (lock.active) {
      setText('overviewDisciplineTitle', 'Your discipline lock is protecting you');
      setText('overviewDisciplineText', 'Trading is paused while the lock is active. Step away, review your plan, and return with a clear process rather than an emotional reaction.');
    } else if ((s.consecutiveLosses || 0) >= 2) {
      setText('overviewDisciplineTitle', 'Pause. Reset. Follow the plan.');
      setText('overviewDisciplineText', 'Consecutive losses can lead to revenge trading. Take a break and reassess before committing more risk.');
    } else if (!s.trades) {
      setText('overviewDisciplineTitle', 'Your edge is patience');
      setText('overviewDisciplineText', 'No trades logged yet. Protect your capital by waiting for a valid setup instead of forcing the first trade.');
    } else if (s.pnl > 0) {
      setText('overviewDisciplineTitle', 'Protect today’s progress');
      setText('overviewDisciplineText', 'A profitable session is not a reason to loosen your rules. Keep position sizing consistent and avoid giving back gains.');
    } else {
      setText('overviewDisciplineTitle', 'Discipline over impulse');
      setText('overviewDisciplineText', 'Your session is being measured against the limits you chose. Let the plan—not the last trade—drive the next decision.');
    }

    var pill = el('lockPill');
    if (pill) {
      pill.textContent = lock.active ? (lock.manual ? 'Focus Lock Active' : 'Rule Lock Active') : 'Trading Unlocked';
      pill.className = 'lock-pill pill ' + (lock.active ? 'on locked' : 'off');
    }
    setText('sideLockLabel', lock.active ? 'Trading Locked' : 'Lock Trading Now');
    if (el('lockNow')) {
      el('lockNow').disabled = !!lock.active;
      el('lockNow').title = lock.active ? 'An active lock is in effect. Use the popup for eligible manual-lock release.' : 'Lock trading until the next market open';
    }
    if (el('mobileLockNow')) {
      el('mobileLockNow').disabled = !!lock.active;
      el('mobileLockNow').title = lock.active ? 'Trading lock active' : 'Lock trading now';
    }
  }

  function renderToday(state, settings) {
    currentState = state;
    currentSettings = settings || currentSettings;
    renderOverview(state, currentSettings);
    var t = el('todayTable');
    if (!t) return;

    if (!state || !state.session) {
      t.innerHTML = row('Session', 'not started yet — open a broker tab', true);
      return;
    }
    var s = state.session;
    var lock = state.lock || {};

    t.innerHTML =
      row('Session date', s.date || '—') +
      row('Trades', s.trades + (settings.maxTradesPerDay ? ' / ' + settings.maxTradesPerDay : '')) +
      row(' of which auto-detected', s.autoTrades || 0) +
      row('Realised P&amp;L', R.inr(s.pnl)) +
      row('Risk committed', R.inr(s.riskUsed)) +
      row('Largest single-trade risk', R.inr(s.maxTradeRisk || 0)) +
      row('Open exposure (auto)', R.inr(s.openExposure || 0)) +
      row('Consecutive losses', s.consecutiveLosses) +
      row('Lock', lock.active
        ? 'ACTIVE — releases ' + R.istLabel(lock.until)
        : 'not locked', false) +
      row('Tamper events seen', state.tamperCount || 0);

    renderProAnalytics(state, settings, currentLicense);
  }

  function planState(settings, lic) {
    settings = settings || currentSettings || {};
    lic = lic || currentLicense;
    var pro = R.isPro(lic, Date.now());
    var proPlus = R.isProPlus ? R.isProPlus(lic, Date.now()) : pro;
    return { enforced: true, pro: pro, proPlus: proPlus, free: !pro };
  }

  function applyPlanGating(settings, lic) {
    var plan = planState(settings, lic);
    var proIds = ['autoDetect', 'countAutoTrades', 'countAutoRisk',
      'maxDailyLoss', 'profitTarget', 'maxConsecutiveLosses',
      'maxRiskPerTrade', 'maxDailyRisk', 'riskPerUnit'];
    proIds.forEach(function (id) {
      var node = el(id);
      if (!node) return;
      node.disabled = plan.free;
      var field = node.closest ? (node.closest('label') || node) : node;
      if (field && field.style) field.style.opacity = plan.free ? '0.55' : '';
    });
    // Note: Free users have full access to export their own trade logs to CSV & JSON without a paywall
    if (el('reportBtn')) el('reportBtn').disabled = plan.free;
    document.querySelectorAll('[data-tab="market"], [data-tab="options"], [data-tab="ai"]').forEach(function (tab) {
      tab.disabled = !plan.proPlus;
      tab.title = plan.proPlus ? '' : 'Pro+ AI or Founder Lifetime required';
      if (tab.classList.contains('nav-tab')) {
        tab.setAttribute('aria-label', tab.textContent.trim() + (plan.proPlus ? '' : ' (Pro+ required)'));
      }
    });
    ['marketEnabled', 'marketSource', 'chatInput', 'chatSendBtn'].forEach(function (id) {
      if (el(id)) el(id).disabled = !plan.proPlus;
    });
    document.querySelectorAll('.prompt-chip').forEach(function (chip) { chip.disabled = !plan.proPlus; });
    return plan;
  }

  function renderProAnalytics(state, settings, lic) {
    var box = el('proAnalytics');
    if (!box) return;
    var plan = planState(settings, lic);
    if (plan.free) {
      renderCoach(state, settings, lic);
      box.innerHTML = '<div class="callout" style="margin:0">🔒 <b>Pro journal analytics locked.</b> ' +
        'Upgrade to see win-rate, average win/loss, biggest loss, and risk totals for today\'s trades. (Trade log export remains free.)</div>';
      return;
    }
    renderCoach(state, settings, lic);
    var a = R.summarizeLog(state && state.log);
    box.innerHTML = '<h3 style="margin:12px 0 6px;font-size:13px">Today\'s journal analytics <span style="color:var(--ok)">(Pro)</span></h3>' +
      '<table class="limits">' +
      row('Closed trades', a.trades + ' (auto ' + a.autoTrades + ' · manual ' + a.manualTrades + ')') +
      row('Win rate', a.winRate + '% (' + a.wins + 'W / ' + a.losses + 'L)') +
      row('Gross profit / loss', R.inr(a.grossProfit) + ' / ' + R.inr(a.grossLoss)) +
      row('Average win / loss', R.inr(a.avgWin) + ' / ' + R.inr(a.avgLoss)) +
      row('Largest win / loss', R.inr(a.largestWin) + ' / ' + R.inr(a.largestLoss)) +
      row('Total risk logged', R.inr(a.totalRisk)) +
      '</table>';
  }

  // ------------------------------------------------------------ license ----

  function renderLicense(lic, settings) {
    currentLicense = lic;
    currentSettings = settings || currentSettings;
    var plan = planState(settings, lic);
    applyPlanGating(settings, lic);
    setText('sidePlanName', plan.proPlus ? 'Pro+ AI Active' : (plan.pro ? 'Pro Active' : 'Unlock Pro+ AI'));
    setText('sidePlanNote', plan.proPlus
      ? 'Your market intelligence and discipline coaching entitlements are active.'
      : 'Market intelligence, options analytics and discipline coaching.');
    setText('sideUpgradeBtn', plan.proPlus ? 'Manage your plan →' : (plan.pro ? 'Explore Pro+ AI ↗' : 'View upgrade options ↗'));
    setText('sideUserPlan', (plan.proPlus ? 'Pro+ AI' : (plan.pro ? 'Pro' : 'Free plan')) + ' · local & private');
    setText('sideUserPlanLabel', plan.proPlus ? 'Pro+ AI Active' : (plan.pro ? 'Pro Active' : 'Free Tier'));
    var pNameSide = (currentProfile && currentProfile.name && currentProfile.name.trim()) ? currentProfile.name.trim() : 'Trader';
    setText('sideUserName', pNameSide);
    setText('sideUserAvatar', pNameSide.charAt(0).toUpperCase() || 'T');

    var subManageCard = el('subManageCard');
    if (subManageCard) {
      if (plan.pro && lic && lic.expiresAt) {
        subManageCard.style.display = 'block';
        setText('subRenewalDate', R.istLabel(lic.expiresAt));
        var cancelBtn = el('cancelSubBtn');
        if (lic.cancelAtPeriodEnd) {
          setText('subRenewalInfo', 'Subscription renewal is cancelled. Full access remains active until: ' + R.istLabel(lic.expiresAt));
          if (cancelBtn) cancelBtn.style.display = 'none';
        } else {
          setText('subRenewalInfo', 'Next billing renewal: ' + R.istLabel(lic.expiresAt));
          if (cancelBtn) cancelBtn.style.display = 'inline-block';
        }
      } else {
        subManageCard.style.display = 'none';
      }
    }

    var box = el('licStatus');
    if (!box) return;
    var pro = plan.pro;
    var planId = R.canonicalPlanId ? R.canonicalPlanId((lic && lic.plan) || 'free') : ((lic && lic.plan) || 'free');
    if (lic && lic.key && el('licKey')) el('licKey').value = lic.key;

    if (pro) {
      var planNames = {
        pro_monthly: 'Pro 30-day Prepaid (₹199)',
        pro_yearly: 'Pro 365-day Prepaid (₹1,499)',
        pro_plus_ai_monthly: 'Pro+ AI 30-day Prepaid (₹399)',
        pro_plus_ai_yearly: 'Pro+ AI 365-day Prepaid (₹3,999)',
        founder_lifetime: 'Founder Lifetime (₹2,999)'
      };
      var pName = planNames[planId] || ((lic && lic.plan) || 'Pro Active');
      var expStr = (lic && lic.expiresAt) ? ('valid until <b>' + R.istLabel(lic.expiresAt) + '</b>') : '<b>Lifetime Access</b>';
      box.className = 'callout green';
      box.innerHTML = '<b>Active Prepaid Plan:</b> You are on the <b>' + pName + '</b> plan (' + expStr + '). ' +
        'Advanced discipline rules, generic broker-table detection, and plan device entitlements are active.';
    } else {
      box.className = 'callout blue';
      box.innerHTML = '<b>Free Tier Active.</b> Trade-count lock, manual trade logging, and full monthly trade journal are enabled. ' +
        'Upgrade to Pro for table detection and advanced rules, or Pro+ for market features and the discipline coach.' +
        (lic && lic.reason ? ' <span style="color:var(--dim)">(Status note: ' + escapeHtml(lic.reason) + ')</span>' : '');
    }

    if (lic && (lic.plan === 'pro_yearly' || lic.plan === 'pro_plus_ai_yearly') && selectedBillingCycle === 'monthly') {
      selectedBillingCycle = 'yearly';
    }
    applyBillingCycle(selectedBillingCycle, lic);
  }

  var selectedBillingCycle = 'monthly';

  function applyBillingCycle(cycle, lic) {
    selectedBillingCycle = cycle;
    var isYearly = cycle === 'yearly';
    var toggle = el('billingCycleToggle');
    var knob = el('billingCycleKnob');
    var mLabel = el('billingMonthlyLabel');
    var yLabel = el('billingYearlyLabel');

    if (toggle) toggle.setAttribute('aria-checked', isYearly ? 'true' : 'false');
    if (knob) knob.style.left = isYearly ? '21px' : '3px';
    if (mLabel) {
      mLabel.style.color = isYearly ? 'var(--dim)' : '#fff';
      mLabel.style.fontWeight = isYearly ? '500' : '700';
    }
    if (yLabel) {
      yLabel.style.color = isYearly ? '#fff' : 'var(--dim)';
      yLabel.style.fontWeight = isYearly ? '700' : '500';
    }

    // Update Pro Card
    var proName = el('proCardName');
    var proPrice = el('proCardPrice');
    var proSub = el('proCardSub');
    var proBtn = el('proCardBtn');
    if (proName) proName.textContent = isYearly ? 'Pro 365-Day' : 'Pro 30-Day';
    if (proPrice) proPrice.innerHTML = isYearly ? '₹1,499 <span style="font-size:12px;font-weight:400">/ 365 days</span>' : '₹199 <span style="font-size:12px;font-weight:400">/ 30 days</span>';
    if (proSub) proSub.textContent = isYearly ? '365-day prepaid access · equivalent ₹125/month (Save 37%)' : 'Complete risk rules suite · 30-day prepaid access';
    if (proBtn) proBtn.setAttribute('data-plan', isYearly ? 'pro_yearly' : 'pro_monthly');

    // Update Pro+ AI Card
    var proAiName = el('proAiCardName');
    var proAiPrice = el('proAiCardPrice');
    var proAiSub = el('proAiCardSub');
    var proAiBadge = el('proAiBadge');
    var proAiBtn = el('proAiCardBtn');
    if (proAiName) proAiName.textContent = isYearly ? 'Pro+ AI 365-Day' : 'Pro+ AI 30-Day';
    if (proAiPrice) proAiPrice.innerHTML = isYearly ? '₹3,999 <span style="font-size:12px;font-weight:400">/ 365 days</span>' : '₹399 <span style="font-size:12px;font-weight:400">/ 30 days</span>';
    if (proAiSub) proAiSub.textContent = isYearly ? '365-day prepaid access · equivalent ₹333/month (Save 16%)' : 'Discipline + market intelligence · 30-day prepaid access';
    if (proAiBadge) proAiBadge.style.display = isYearly ? 'inline-block' : 'none';
    if (proAiBtn) proAiBtn.setAttribute('data-plan', isYearly ? 'pro_plus_ai_yearly' : 'pro_plus_ai_monthly');

    // Update plan buttons in comparison cards
    var planId = R.canonicalPlanId ? R.canonicalPlanId((lic && lic.plan) || 'free') : ((lic && lic.plan) || 'free');
    var pro = R.isPro(lic, Date.now());
    document.querySelectorAll('.plan-select-btn').forEach(function (btn) {
      var p = btn.getAttribute('data-plan');
      if (p === 'free') {
        btn.disabled = true;
        btn.textContent = pro ? 'Free (included)' : 'Current Plan';
        btn.style.opacity = '0.65';
        return;
      }
      if (p === planId) {
        btn.disabled = true;
        btn.textContent = 'Current Plan';
        btn.style.opacity = '0.65';
      } else {
        btn.disabled = false;
        btn.style.opacity = '1';
        if (p === 'pro_monthly') btn.textContent = pro ? 'Switch to Pro 30-Day' : 'Upgrade to Pro';
        else if (p === 'pro_yearly') btn.textContent = pro ? 'Switch to Pro 365-Day' : 'Get Pro 365-Day (Save 37%)';
        else if (p === 'pro_plus_ai_monthly') btn.textContent = 'Get Pro+ AI';
        else if (p === 'pro_plus_ai_yearly') btn.textContent = 'Get Pro+ AI 365-Day (Save 16%)';
        else if (p === 'founder_lifetime') btn.textContent = 'Get Founder Access';
      }
    });
  }

  if (el('billingCycleToggle')) {
    el('billingCycleToggle').addEventListener('click', function () {
      applyBillingCycle(selectedBillingCycle === 'yearly' ? 'monthly' : 'yearly', currentLicense);
    });
  }
  if (el('billingMonthlyLabel')) {
    el('billingMonthlyLabel').addEventListener('click', function () {
      applyBillingCycle('monthly', currentLicense);
    });
  }
  if (el('billingYearlyLabel')) {
    el('billingYearlyLabel').addEventListener('click', function () {
      applyBillingCycle('yearly', currentLicense);
    });
  }

  // Plan Selection & Checkout Flow
  document.querySelectorAll('.plan-select-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var plan = btn.getAttribute('data-plan');
      if (plan === 'free') return;

      var email = el('checkoutEmail') ? el('checkoutEmail').value.trim() : '';
      var notice = el('checkoutNotice');

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        if (notice) {
          notice.style.display = 'block';
          notice.style.background = 'rgba(239,68,68,0.12)';
          notice.style.border = '1px solid rgba(239,68,68,0.3)';
          notice.style.color = '#fca5a5';
          notice.innerHTML = '⚠️ <b>Email Required:</b> Please enter your email address in the field above before choosing a plan so your cryptographic license key can be delivered and restored.';
        }
        if (el('checkoutEmail')) el('checkoutEmail').focus();
        return;
      }

      // Persist email locally
      chrome.storage.local.set({ tlUserEmail: email });

      var api = (el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase).replace(/\/+$/, '');
      if (notice) {
        notice.style.display = 'block';
        notice.style.background = 'rgba(59,130,246,0.12)';
        notice.style.border = '1px solid rgba(59,130,246,0.3)';
        notice.style.color = '#93c5fd';
        notice.innerHTML = 'Initiating secure order for <b>' + escapeHtml(plan) + '</b> (' + escapeHtml(email) + ')…';
      }

      fetch(api + '/api/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: plan, email: email })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!notice) return;
        if (data.payments_not_configured || data.error === 'payments_not_configured') {
          notice.style.background = 'rgba(245,158,11,0.12)';
          notice.style.border = '1px solid rgba(245,158,11,0.3)';
          notice.style.color = '#fcd34d';
          notice.innerHTML = '⚠️ <b>Payment Gateway Offline / Not Configured:</b> The Trade Lock backend server is running in development mode without live Razorpay credentials. No charges were made. In live production, this connects to Razorpay billing. For development, use an explicitly enabled demo checkout or paste a valid test license key above.';
        } else if (data.orderId) {
          notice.style.background = 'rgba(16,185,129,0.12)';
          notice.style.border = '1px solid rgba(16,185,129,0.3)';
          notice.style.color = '#6ee7b7';
          notice.innerHTML = '✓ Order <b>' + escapeHtml(data.orderId) + '</b> initialized for ' + escapeHtml(email) + '. ' +
            'Redirecting to payment gateway for signature authorization…';
          var checkoutUrl = api + '/?plan=' + encodeURIComponent(plan) + '&email=' + encodeURIComponent(email) + '&orderId=' + encodeURIComponent(data.orderId);
          if (chrome.tabs && chrome.tabs.create) {
            chrome.tabs.create({ url: checkoutUrl });
          } else {
            window.open(checkoutUrl, '_blank');
          }
        } else if (data.error) {
          notice.style.background = 'rgba(239,68,68,0.12)';
          notice.style.border = '1px solid rgba(239,68,68,0.3)';
          notice.style.color = '#fca5a5';
          notice.innerHTML = '⚠️ Checkout Error: ' + escapeHtml(data.error);
        }
      })
      .catch(function (err) {
        if (!notice) return;
        notice.style.background = 'rgba(245,158,11,0.12)';
        notice.style.border = '1px solid rgba(245,158,11,0.3)';
        notice.style.color = '#fcd34d';
        notice.innerHTML = '⚠️ <b>Payments Not Configured / Backend Offline:</b> Could not reach backend server at <code>' + escapeHtml(api) + '</code>. ' +
          'No card details are ever stored locally. In live production, this connects to Razorpay billing. You can test features by activating a license key directly.';
      });
    });
  });

  if (el('saveEmailBtn')) {
    el('saveEmailBtn').addEventListener('click', function () {
      var em = el('checkoutEmail') ? el('checkoutEmail').value.trim() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        alert('Please enter a valid email address.');
        return;
      }
      chrome.storage.local.set({ tlUserEmail: em }, function () {
        toast('Email saved');
      });
    });
  }

  // Restore Subscription Button (via Key or Email)
  if (el('licRestoreBtn')) {
    el('licRestoreBtn').addEventListener('click', function () {
      var key = el('licKey') ? el('licKey').value.trim() : '';
      if (!key && currentLicense && currentLicense.key) key = currentLicense.key;
      var api = (el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase).replace(/\/+$/, '');

      if (key) {
        if (el('licNote')) el('licNote').textContent = 'syncing license…';
        globalThis.TLLicense.activate(api, key).then(function (lic) {
          if (el('licNote')) {
            el('licNote').textContent = lic.active ? 'License synchronized ✓' : ('Sync status: ' + (lic.reason || 'not active'));
          }
          loadAll();
          toast('License synchronized');
        }).catch(function (err) {
          if (el('licNote')) el('licNote').textContent = 'Sync failed: ' + err.message;
        });
        return;
      }

      var email = el('checkoutEmail') ? el('checkoutEmail').value.trim() : '';
      if (!email) {
        alert('Please enter your purchase email for recovery guidance or a license key to validate.');
        if (el('checkoutEmail')) el('checkoutEmail').focus();
        return;
      }

      if (el('licNote')) el('licNote').textContent = 'requesting recovery guidance for ' + email + '…';
      fetch(api + '/api/restore-subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok && data.recovery === 'support_required') {
          if (el('licNote')) el('licNote').textContent = data.note;
          alert('For account safety, email-only recovery does not reveal or replace a license. Contact support from your purchase email for ownership verification and reissue.');
        } else {
          if (el('licNote')) el('licNote').textContent = data.note || 'Recovery could not be completed.';
        }
      })
      .catch(function (err) {
        if (el('licNote')) el('licNote').textContent = 'Lookup failed: ' + err.message;
      });
    });
  }

  if (el('licActivate')) el('licActivate').addEventListener('click', function () {
    var key = el('licKey').value.trim();
    var api = el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase;
    if (!key) { if (el('licNote')) el('licNote').textContent = 'paste a license key first'; return; }
    if (el('licNote')) el('licNote').textContent = 'validating…';
    globalThis.TLLicense.activate(api, key).then(function (lic) {
      if (el('licNote')) {
        el('licNote').textContent = lic.active
          ? 'activated ✓ — remember to Save rules'
          : 'not active: ' + (lic.reason || 'unknown');
      }
      loadAll();
    });
  });

  if (el('licBuy')) el('licBuy').addEventListener('click', function () {
    switchTab('license');
  });

  if (el('saveProfileBtn')) {
    el('saveProfileBtn').addEventListener('click', function () {
      var input = el('userDisplayNameInput');
      var newName = (input ? input.value : '').trim() || 'Trader';
      var prof = { name: newName, updatedAt: Date.now() };
      chrome.storage.local.set({ tlProfile: prof }, function () {
        currentProfile = prof;
        setText('sideUserName', newName);
        setText('sideUserAvatar', newName.charAt(0).toUpperCase() || 'T');
        if (currentState) renderOverview(currentState, currentSettings);
        var st = el('saveProfileStatus');
        if (st) {
          st.style.display = 'block';
          setTimeout(function () { if (st) st.style.display = 'none'; }, 2500);
        }
      });
    });
  }

  if (el('cancelSubBtn')) {
    el('cancelSubBtn').addEventListener('click', function () {
      if (!currentLicense || !currentLicense.key) {
        alert('No active subscription license found to cancel.');
        return;
      }
      if (!confirm('Are you sure you want to cancel automatic subscription renewals?\n\nYour access will remain fully active until the end of the paid billing period, but you will not be charged again.')) {
        return;
      }
      var api = (el('licApi').value.trim() || R.DEFAULT_SETTINGS.licenseApiBase).replace(/\/+$/, '');
      var statusBox = el('subCancelStatus');
      if (statusBox) {
        statusBox.style.display = 'block';
        statusBox.textContent = 'Contacting license server to stop recurring renewals…';
      }
      fetch(api + '/api/subscription/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: currentLicense.key, reason: 'user_requested_cancellation' })
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          currentLicense.cancelAtPeriodEnd = true;
          currentLicense.cancelledAt = Date.now();
          chrome.storage.local.set({ tlLicense: currentLicense }, function () {
            if (statusBox) {
              statusBox.style.display = 'block';
              statusBox.style.background = 'rgba(16,185,129,0.12)';
              statusBox.style.color = '#34d399';
              statusBox.style.borderColor = 'rgba(16,185,129,0.25)';
              statusBox.textContent = '✓ Recurring renewals cancelled. Your plan features remain unlocked until ' + R.istLabel(currentLicense.expiresAt) + '.';
            }
            renderLicense(currentLicense, currentSettings);
          });
        } else {
          if (statusBox) {
            statusBox.style.display = 'block';
            statusBox.textContent = 'Cancellation notice: ' + (data.error || 'Server error. Please contact support.');
          }
        }
      })
      .catch(function (err) {
        if (statusBox) {
          statusBox.style.display = 'block';
          statusBox.textContent = 'Cancellation offline: Unable to reach billing server (' + err.message + ').';
        }
      });
    });
  }

  function maybeRevalidate(lic, settings) {
    if (revalidateTried || !lic || !lic.key || !globalThis.TLLicense) return;
    var stale = !lic.validatedAt || (Date.now() - lic.validatedAt > 24 * 3600 * 1000);
    if (!stale) return;
    revalidateTried = true;
    globalThis.TLLicense.activate(settings.licenseApiBase || R.DEFAULT_SETTINGS.licenseApiBase, lic.key)
      .then(function () { loadAll(); })
      .catch(function () {});
  }

  function renderCoach(state, settings, lic) {
    var box = el('aiCoach');
    if (!box || !globalThis.TLInsights) return;
    var plan = planState(settings, lic);
    if (!plan.proPlus) {
      box.innerHTML = '<div class="callout" style="margin:0">🤖 <b>Discipline Coach locked (Pro+).</b> ' +
        'Pro+ watches how you trade — revenge entries after losses, risk size creeping up, burst overtrading — ' +
        'scores your discipline 0–100 and writes your end-of-day report.</div>';
      return;
    }
    var a = globalThis.TLInsights.analyze(state && state.log, state && state.session, settings);
    var sig = a.signals.map(function (sg) {
      var icon = sg.level === 'danger' ? '🔴' : sg.level === 'warn' ? '🟠' : '🟢';
      return '<div style="padding:3px 0">' + icon + ' ' + sg.text + '</div>';
    }).join('');
    var sug = a.suggestions.map(function (sg) { return '<div style="padding:3px 0">→ ' + sg + '</div>'; }).join('');
    box.innerHTML = '<h3 style="margin:12px 0 6px;font-size:13px">Discipline Coach (local rules) <span style="color:var(--ok)">(Pro+)</span> — ' +
      'discipline score <b>' + a.score + '/100</b> · ' + a.grade + '</h3>' +
      '<div style="font-size:12.5px;color:var(--muted)">' + sig + sug + '</div>';
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // -------------------------------------------------------------- load ----

  function loadAll() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    chrome.storage.local.get(['tlSettings', 'tlState', 'tlLicense', 'tlJournal', 'tlUserEmail', 'tlDailyFocus', 'tlProfile'], function (res) {
      if (res.tlProfile) currentProfile = res.tlProfile;
      var profName = (currentProfile && currentProfile.name && currentProfile.name.trim()) ? currentProfile.name.trim() : 'Trader';
      setText('sideUserName', profName);
      setText('sideUserAvatar', profName.charAt(0).toUpperCase() || 'T');
      if (el('userDisplayNameInput') && !el('userDisplayNameInput').value) {
        el('userDisplayNameInput').value = profName;
      }
      if (res.tlUserEmail && el('checkoutEmail') && !el('checkoutEmail').value) {
        el('checkoutEmail').value = res.tlUserEmail;
      }
      currentLicense = res.tlLicense || null;
      setText('overviewFocusText', res.tlDailyFocus || 'Stick strictly to predefined setups. Never revenge trade.');
      var s = R.effectiveSettings(res.tlSettings, currentLicense, Date.now());
      currentSettings = s;
      if (!dirty) fill(s);
      renderLicense(currentLicense, s);
      maybeRevalidate(currentLicense, s);

      var st = res.tlState;
      if (st) {
        R.syncSession(st, s, Date.now());
        var t = R.tick(st, s, Date.now());
        currentState = t.state;
        renderToday(t.state, s);
      } else {
        currentState = R.defaultState(Date.now());
        renderToday(null, s);
      }

      currentJournal = Array.isArray(res.tlJournal) ? res.tlJournal : [];
      renderMonthlyJournal();
      renderOverviewJournalSummary(currentState, currentJournal);
    });
  }

  function renderOverviewJournalSummary(state, journal) {
    var emptyEl = el('ovJournalEmpty');
    var listEl = el('ovJournalTradesList');
    if (!emptyEl || !listEl) return;

    var trades = (state && state.log) || [];
    if (!trades.length && journal && journal.length) {
      var todayKey = R.todayIST();
      for (var i = 0; i < journal.length; i++) {
        if (journal[i] && journal[i].date === todayKey && Array.isArray(journal[i].trades)) {
          trades = journal[i].trades;
          break;
        }
      }
    }

    if (!trades || !trades.length) {
      emptyEl.style.display = 'block';
      listEl.style.display = 'none';
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'block';

    var recent = trades.slice(-5).reverse();
    var html = '<table class="limits" style="margin:0">';
    html += '<thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>P&amp;L</th><th>Source</th></tr></thead><tbody>';
    recent.forEach(function (t) {
      var pnlVal = (t.netPnl !== undefined && t.netPnl !== null) ? t.netPnl : t.pnl;
      var pnlClass = pnlVal > 0 ? 'color:#10b981;font-weight:700' : (pnlVal < 0 ? 'color:#ef4444;font-weight:700' : 'color:var(--dim)');
      var pnlSign = pnlVal > 0 ? '+' : '';
      var timeStr = t.at ? new Date(t.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
      html += '<tr>' +
        '<td>' + timeStr + '</td>' +
        '<td style="font-weight:700;color:#fff">' + escapeHtml(t.symbol || 'NIFTY') + '</td>' +
        '<td><span class="badge" style="' + (t.side === 'BUY' ? 'color:#34d399' : 'color:#f87171') + '">' + (t.side || 'BUY') + '</span></td>' +
        '<td>' + (t.qty || 1) + '</td>' +
        '<td style="' + pnlClass + '">' + pnlSign + R.inr(pnlVal || 0) + '</td>' +
        '<td><span style="font-size:10.5px;color:var(--dim)">' + escapeHtml(t.provenance || t.source || 'manual') + '</span></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    listEl.innerHTML = html;
  }

  if (el('ovJumpToJournal')) {
    el('ovJumpToJournal').addEventListener('click', function () {
      switchTab('journal');
    });
  }

  document.querySelectorAll('.overview-action[data-tab]').forEach(function (btn) {
    btn.addEventListener('click', function () { switchTab(btn.getAttribute('data-tab')); });
  });
  if (el('sideUpgradeBtn')) el('sideUpgradeBtn').addEventListener('click', function () { switchTab('license'); });
  if (el('overviewLogTrade')) {
    el('overviewLogTrade').addEventListener('click', function () {
      switchTab('journal');
      if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'block';
      setTimeout(function () {
        if (el('jSymbol')) {
          el('jSymbol').scrollIntoView({ behavior: 'smooth', block: 'center' });
          el('jSymbol').focus();
        }
      }, 50);
    });
  }
  if (el('overviewFocusEdit')) {
    el('overviewFocusEdit').addEventListener('click', function () {
      chrome.storage.local.get('tlDailyFocus', function (res) {
        var current = res.tlDailyFocus || 'Stick strictly to predefined setups. Never revenge trade.';
        var updated = prompt('Set your Daily Trading Focus / Rule:', current);
        if (updated === null || !updated.trim()) return;
        var clean = updated.trim();
        chrome.storage.local.set({ tlDailyFocus: clean }, function () {
          setText('overviewFocusText', clean);
          toast('Daily focus saved');
        });
      });
    });
  }
  if (el('mobileLockNow')) {
    el('mobileLockNow').addEventListener('click', function () {
      if (el('lockNow')) el('lockNow').click();
    });
  }
  if (el('sideOpenFullTab')) {
    el('sideOpenFullTab').addEventListener('click', function () {
      chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#overview') });
    });
  }

  function save() {
    var s = read();
    chrome.storage.local.set({ tlSettings: s, tlSavedAt: Date.now() }, function () {
      dirty = false;
      if (el('dirtyNote')) el('dirtyNote').textContent = '';
      currentSettings = s;
      chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
      chrome.tabs.query({}, function (tabs) {
        tabs.forEach(function (t) {
          try {
            chrome.tabs.sendMessage(t.id, { type: 'TL_SETTINGS_UPDATED', settings: s }, function () {
              void chrome.runtime.lastError;
            });
          } catch (e) {}
        });
      });
      loadAll();
      toast('Rules saved');
    });
  }

  function toast(msg) {
    var t = el('savedToast');
    if (!t) return;
    t.textContent = msg || 'Saved';
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, 1600);
  }

  // --------------------------------------------------- technical charts & canvas ----

  var chartState = {
    candles: [],
    analysis: null,
    zoom: 1.0,
    panOffset: 0,
    hoveredIdx: -1,
    symbol: 'NIFTY',
    timeframe: '15m',
    isDragging: false,
    dragStartX: 0,
    dragStartPan: 0
  };

  function getInstrumentConfig(sym) {
    if (M && M.INSTRUMENTS && M.INSTRUMENTS[sym]) return M.INSTRUMENTS[sym];
    var map = {
      NIFTY: { symbol: 'NIFTY', name: 'NIFTY 50', exchange: 'NSE', basePrice: 24520, step: 50, lotSize: 75 },
      BANKNIFTY: { symbol: 'BANKNIFTY', name: 'BANK NIFTY', exchange: 'NSE', basePrice: 51200, step: 100, lotSize: 15 },
      FINNIFTY: { symbol: 'FINNIFTY', name: 'FIN NIFTY', exchange: 'NSE', basePrice: 23850, step: 50, lotSize: 25 },
      MIDCPNIFTY: { symbol: 'MIDCPNIFTY', name: 'MIDCPNIFTY', exchange: 'NSE', basePrice: 12850, step: 25, lotSize: 50 },
      SENSEX: { symbol: 'SENSEX', name: 'BSE SENSEX', exchange: 'BSE', basePrice: 80400, step: 100, lotSize: 10 },
      BANKEX: { symbol: 'BANKEX', name: 'BSE BANKEX', exchange: 'BSE', basePrice: 58600, step: 100, lotSize: 15 }
    };
    return map[sym] || map.NIFTY;
  }

  function generateSampleCandles() {
    // Synthetic math generation purged. Only real candles from live exchange feed are rendered.
    return [];
  }
  function round(n) { return Math.round(n * 100) / 100; }

  // Lightweight overview chart. Uses the same deterministic series as Market & OI.
  function renderOverviewChart() {
    var svg = el('overviewChart');
    if (!svg) return;
    if (!chartState.candles || !chartState.candles.length) {
      svg.innerHTML = '<rect width="100%" height="100%" fill="none"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#64748b" font-size="12" font-family="Inter,sans-serif">Live exchange feed disconnected — awaiting real-time candles</text>';
      setText('overviewChartSymbol', 'Awaiting live feed');
      setText('overviewChartPrice', '—');
      setText('overviewChartChange', '—');
      setText('overviewChartSource', 'Live feed disconnected · Connect Fyers API v3 backend credentials');
      return;
    }
    var candles = chartState.candles.slice(-42).filter(function (c) {
      return c && [c.o, c.h, c.l, c.c].every(function (v) { return Number.isFinite(Number(v)); });
    });
    if (!candles.length) return;

    var cfg = getInstrumentConfig(chartState.symbol);
    var last = candles[candles.length - 1];
    var first = candles[0];
    var change = Number(last.c) - Number(first.o);
    var changePct = first.o ? (change / Number(first.o)) * 100 : 0;
    setText('overviewChartSymbol', cfg.name + ' · ' + cfg.exchange + ' · ' + chartState.timeframe);
    setText('overviewChartPrice', Number(last.c).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    setText('overviewChartChange', (change >= 0 ? '+' : '') + change.toFixed(2) + ' (' + (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%) · simulated');
    if (el('overviewChartChange')) el('overviewChartChange').className = change >= 0 ? 'pos' : 'neg';
    setText('overviewChartSource', 'SIMULATED · ' + candles.length + ' deterministic ' + chartState.timeframe + ' candles · Not a live market feed');
    if (el('overviewSymbol')) el('overviewSymbol').value = chartState.symbol;
    if (el('overviewTimeframe') && Array.from(el('overviewTimeframe').options).some(function (o) { return o.value === chartState.timeframe; })) {
      el('overviewTimeframe').value = chartState.timeframe;
    }

    var width = 720, height = 220;
    var left = 8, right = 56, top = 12, bottom = 25;
    var plotWidth = width - left - right;
    var plotHeight = height - top - bottom;
    var min = Math.min.apply(null, candles.map(function (c) { return Number(c.l); }));
    var max = Math.max.apply(null, candles.map(function (c) { return Number(c.h); }));
    var pad = Math.max(1, (max - min) * 0.12);
    min -= pad;
    max += pad;
    var range = Math.max(1, max - min);
    var points = candles.map(function (c, i) {
      return {
        x: left + (i / Math.max(1, candles.length - 1)) * plotWidth,
        y: top + ((max - Number(c.c)) / range) * plotHeight,
        candle: c
      };
    });
    var linePath = points.map(function (p, i) { return (i ? 'L' : 'M') + p.x.toFixed(2) + ',' + p.y.toFixed(2); }).join(' ');
    var baseY = height - bottom;
    var areaPath = 'M' + points[0].x.toFixed(2) + ',' + baseY + ' ' +
      points.map(function (p) { return 'L' + p.x.toFixed(2) + ',' + p.y.toFixed(2); }).join(' ') +
      ' L' + points[points.length - 1].x.toFixed(2) + ',' + baseY + ' Z';
    var html = '<title>Simulated ' + escapeHtml(cfg.name) + ' overview — not live market data</title>' +
      '<desc>Deterministic demonstration series. Last simulated value ' + Number(last.c).toFixed(2) +
      ', change ' + change.toFixed(2) + ' (' + changePct.toFixed(2) + ' percent).</desc>' +
      '<defs><linearGradient id="overviewAreaGradient" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#6366f1" stop-opacity=".32"/><stop offset="100%" stop-color="#6366f1" stop-opacity="0"/>' +
      '</linearGradient><linearGradient id="overviewLineGradient" x1="0" y1="0" x2="1" y2="0">' +
      '<stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#a78bfa"/></linearGradient></defs>';

    for (var g = 0; g <= 4; g++) {
      var gy = top + (g / 4) * plotHeight;
      var value = max - (g / 4) * range;
      html += '<line x1="' + left + '" y1="' + gy.toFixed(2) + '" x2="' + (width - right) + '" y2="' + gy.toFixed(2) + '" stroke="rgba(148,163,184,.08)" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke"/>' +
        '<text x="' + (width - right + 8) + '" y="' + (gy + 3).toFixed(2) + '" fill="#64748b" font-size="9" font-family="Inter,sans-serif">' + value.toFixed(0) + '</text>';
    }

    // Time Axis Labels (09:15, 10:30, 12:00, 13:30, 15:00)
    var timeMarkers = ['09:15', '10:30', '12:00', '13:30', '15:00'];
    timeMarkers.forEach(function (tm, idx) {
      var tx = left + (idx / (timeMarkers.length - 1)) * plotWidth;
      var anchor = idx === 0 ? 'start' : (idx === timeMarkers.length - 1 ? 'end' : 'middle');
      html += '<text x="' + tx.toFixed(2) + '" y="' + (height - 6) + '" fill="#64748b" font-size="8.5" text-anchor="' + anchor + '" font-family="Inter,sans-serif">' + tm + '</text>';
    });

    // Subtle area and trend line behind candlesticks
    html += '<path d="' + areaPath + '" fill="url(#overviewAreaGradient)"/>' +
      '<path d="' + linePath + '" fill="none" stroke="url(#overviewLineGradient)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" opacity="0.35"/>';

    // Draw Volume Bars
    var maxVol = Math.max.apply(null, candles.map(function (c) { return Number(c.v) || 1; }));
    var volHeight = plotHeight * 0.22;
    var candleSpacing = plotWidth / candles.length;
    var candleW = Math.max(2.5, candleSpacing * 0.65);

    candles.forEach(function (c, i) {
      var cx = left + i * candleSpacing + (candleSpacing / 2);
      var vH = ((Number(c.v) || 1) / maxVol) * volHeight;
      var vy = baseY - vH;
      var isBull = Number(c.c) >= Number(c.o);
      var volColor = isBull ? 'rgba(16, 185, 129, 0.4)' : 'rgba(239, 68, 68, 0.4)';
      html += '<rect x="' + (cx - candleW / 2).toFixed(2) + '" y="' + vy.toFixed(2) + '" width="' + candleW.toFixed(2) + '" height="' + Math.max(1, vH).toFixed(2) + '" fill="' + volColor + '" rx="0.5"/>';
    });

    // Draw Candlesticks in foreground (Wick + Body)
    candles.forEach(function (c, i) {
      var cx = left + i * candleSpacing + (candleSpacing / 2);
      var isBull = Number(c.c) >= Number(c.o);
      var candleColor = isBull ? '#10b981' : '#f43f5e';
      var yOpen = top + ((max - Number(c.o)) / range) * plotHeight;
      var yClose = top + ((max - Number(c.c)) / range) * plotHeight;
      var yHigh = top + ((max - Number(c.h)) / range) * plotHeight;
      var yLow = top + ((max - Number(c.l)) / range) * plotHeight;
      var bodyY = Math.min(yOpen, yClose);
      var bodyH = Math.max(1.8, Math.abs(yClose - yOpen));

      // Wick
      html += '<line x1="' + cx.toFixed(2) + '" y1="' + yHigh.toFixed(2) + '" x2="' + cx.toFixed(2) + '" y2="' + yLow.toFixed(2) + '" stroke="' + candleColor + '" stroke-width="1.2" vector-effect="non-scaling-stroke"/>';
      // Body
      html += '<rect x="' + (cx - candleW / 2).toFixed(2) + '" y="' + bodyY.toFixed(2) + '" width="' + candleW.toFixed(2) + '" height="' + bodyH.toFixed(2) + '" fill="' + candleColor + '" rx="1"/>';
    });

    svg.innerHTML = html;
  }

  function drawDedicatedSvgChart(svg, candles) {
    if (!svg || !candles || !candles.length) {
      if (svg) svg.innerHTML = '<text x="370" y="160" text-anchor="middle" fill="#64748b" font-size="13">No candle data available</text>';
      return;
    }

    var width = 740;
    var height = 320;
    var rightMargin = 68;
    var bottomMargin = 26;
    var topMargin = 24;
    var plotWidth = width - rightMargin;
    var totalPlotHeight = height - bottomMargin - topMargin;
    var priceHeight = totalPlotHeight * 0.74;
    var volHeight = totalPlotHeight * 0.22;
    var volTop = topMargin + priceHeight + (totalPlotHeight * 0.04);

    var count = Math.min(candles.length, 50);
    var visible = candles.slice(-count);

    var minP = Infinity, maxP = -Infinity, maxVol = 1;
    visible.forEach(function (c) {
      var low = Number(c.l), high = Number(c.h), vol = Number(c.v || c.volume || 1);
      if (low < minP) minP = low;
      if (high > maxP) maxP = high;
      if (vol > maxVol) maxVol = vol;
    });

    var pRange = Math.max(1, maxP - minP);
    var pMargin = pRange * 0.06;
    minP -= pMargin;
    maxP += pMargin;
    pRange = maxP - minP;

    function yPrice(p) {
      return topMargin + priceHeight - ((Number(p) - minP) / pRange * priceHeight);
    }
    function yVol(v) {
      return (volTop + volHeight) - ((Number(v) / maxVol) * volHeight);
    }

    var candleSpacing = plotWidth / count;
    var bodyWidth = Math.max(2, Math.min(14, candleSpacing * 0.72));

    var html = '';

    // Subtle background grid
    var gridSteps = 4;
    for (var g = 0; g <= gridSteps; g++) {
      var gy = topMargin + (priceHeight / gridSteps) * g;
      var gPrice = maxP - (pRange / gridSteps) * g;
      html += '<line x1="0" y1="' + gy.toFixed(1) + '" x2="' + plotWidth + '" y2="' + gy.toFixed(1) + '" stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="3,3" />';
      html += '<text x="' + (plotWidth + 6) + '" y="' + (gy + 3.5).toFixed(1) + '" fill="#64748b" font-size="10" font-family="monospace">₹' + gPrice.toFixed(0) + '</text>';
    }

    // Legend
    html += '<text x="10" y="16" fill="#94a3b8" font-size="10.5" font-weight="600">' +
      '<tspan fill="#06b6d4">― EMA 9</tspan>  ' +
      '<tspan fill="#f59e0b">― EMA 20</tspan>  ' +
      '<tspan fill="#a855f7">- - VWAP</tspan>' +
    '</text>';

    // Volume bars and Candlesticks
    var ema9Vals = (M && M.ema) ? M.ema(visible.map(function (c) { return Number(c.c); }), 9) : [];
    var ema20Vals = (M && M.ema) ? M.ema(visible.map(function (c) { return Number(c.c); }), 20) : [];
    var vwapVals = (M && M.vwap) ? M.vwap(visible) : [];

    var ema9Path = '';
    var ema20Path = '';
    var vwapPath = '';

    visible.forEach(function (c, i) {
      var cx = i * candleSpacing + (candleSpacing / 2);
      var isBull = Number(c.c) >= Number(c.o);
      var color = isBull ? '#10b981' : '#ef4444';

      // Volume bar
      var vy = yVol(c.v);
      var vh = Math.max(1, (volTop + volHeight) - vy);
      html += '<rect x="' + (cx - bodyWidth / 2).toFixed(1) + '" y="' + vy.toFixed(1) + '" width="' + bodyWidth.toFixed(1) + '" height="' + vh.toFixed(1) + '" fill="' + (isBull ? 'rgba(16,185,129,0.22)' : 'rgba(239,68,68,0.22)') + '" />';

      // Candle Wick
      var yh = yPrice(c.h);
      var yl = yPrice(c.l);
      html += '<line x1="' + cx.toFixed(1) + '" y1="' + yh.toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + yl.toFixed(1) + '" stroke="' + color + '" stroke-width="1.2" />';

      // Candle Body
      var yo = yPrice(c.o);
      var yc = yPrice(c.c);
      var bTop = Math.min(yo, yc);
      var bHeight = Math.max(1.5, Math.abs(yo - yc));
      html += '<rect x="' + (cx - bodyWidth / 2).toFixed(1) + '" y="' + bTop.toFixed(1) + '" width="' + bodyWidth.toFixed(1) + '" height="' + bHeight.toFixed(1) + '" fill="' + color + '" rx="1" />';

      // Time axis labels (every 8 candles)
      if (i % 8 === 0) {
        var tDate = new Date(c.t);
        var tLabel = tDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
        html += '<text x="' + cx.toFixed(1) + '" y="' + (height - 6) + '" text-anchor="middle" fill="#64748b" font-size="9.5">' + tLabel + '</text>';
      }

      // Indicator paths
      if (ema9Vals[i] !== undefined) {
        var ey9 = yPrice(ema9Vals[i]);
        ema9Path += (i === 0 ? 'M' : 'L') + cx.toFixed(1) + ' ' + ey9.toFixed(1) + ' ';
      }
      if (ema20Vals[i] !== undefined) {
        var ey20 = yPrice(ema20Vals[i]);
        ema20Path += (i === 0 ? 'M' : 'L') + cx.toFixed(1) + ' ' + ey20.toFixed(1) + ' ';
      }
      if (vwapVals[i] !== undefined) {
        var vyw = yPrice(vwapVals[i]);
        vwapPath += (i === 0 ? 'M' : 'L') + cx.toFixed(1) + ' ' + vyw.toFixed(1) + ' ';
      }
    });

    if (vwapPath) html += '<path d="' + vwapPath + '" fill="none" stroke="#a855f7" stroke-width="1.4" stroke-dasharray="4,3" />';
    if (ema20Path) html += '<path d="' + ema20Path + '" fill="none" stroke="#f59e0b" stroke-width="1.4" opacity="0.85" />';
    if (ema9Path) html += '<path d="' + ema9Path + '" fill="none" stroke="#06b6d4" stroke-width="1.5" />';

    svg.innerHTML = html;
  }

  function renderDedicatedChartsView() {
    var svg = el('dedicatedChartsSvg');
    if (!svg) return;
    var symbol = (el('chartsSymbolSelect') && el('chartsSymbolSelect').value) || (el('marketSymbol') && el('marketSymbol').value) || 'NIFTY';
    var activePill = document.querySelector('#chartsTimeframePills .tf-btn.active');
    var tf = (activePill && activePill.getAttribute('data-tf')) || '15m';
    var source = (el('marketSource') && el('marketSource').value) || (currentSettings && currentSettings.marketSource) || 'demo';

    var offlineNotice = el('chartsOfflineNotice');
    var calloutBanner = el('chartsCalloutBanner');
    var modeBadge = el('chartsModeBadge');
    var statusText = el('chartsStatusText');

    if (source === 'live') {
      chrome.storage.local.get('tlMarket', function (res) {
        var snap = res && res.tlMarket;
        var hasLive = snap && snap.source === 'live' && snap.candles > 0;
        if (!hasLive) {
          if (offlineNotice) {
            offlineNotice.style.display = 'block';
            offlineNotice.innerHTML =
              '<div style="font-size:14px;font-weight:600;margin-bottom:6px;color:#fca5a5">Live Exchange Chart Unavailable</div>' +
              '<div style="font-size:12px;color:var(--muted);margin-bottom:14px">Live exchange candles are not connected or server credentials are missing. Trade Lock does not fabricate live candles.</div>' +
              '<button type="button" id="chartsSwitchDemoBtn" class="primary" style="padding:6px 16px;font-size:12px">Switch to Simulated Demo Model</button>';
            var sbtn = el('chartsSwitchDemoBtn');
            if (sbtn) {
              sbtn.addEventListener('click', function () {
                if (el('marketSource')) el('marketSource').value = 'demo';
                renderMarketAndOiDashboard();
                renderDedicatedChartsView();
              });
            }
          }
          if (svg) svg.style.display = 'none';
          if (modeBadge) {
            modeBadge.innerHTML = '<span class="badge-dot-live" style="background:#ef4444"></span> LIVE FEED OFFLINE';
            modeBadge.style.color = '#fca5a5';
          }
          if (statusText) statusText.textContent = 'Live Feed: Offline';
          if (calloutBanner) calloutBanner.style.display = 'none';
          return;
        }

        if (offlineNotice) offlineNotice.style.display = 'none';
        if (svg) svg.style.display = 'block';
        if (calloutBanner) calloutBanner.style.display = 'none';
        if (modeBadge) {
          modeBadge.innerHTML = '<span class="badge-dot-live" style="background:#10b981"></span> VERIFIED LIVE FEED';
          modeBadge.style.color = '#34d399';
        }
        if (statusText) statusText.textContent = 'Provider: Fyers API v3 · ' + new Date(snap.fetchedAt).toLocaleTimeString('en-IN') + ' IST';

        // Render live chart data if candles available
        if (snap.analysis && snap.analysis.candles) {
          // If live candles are stored
          drawDedicatedSvgChart(svg, chartState.candles || []);
        }
      });
      return;
    }

    var cfg = getInstrumentConfig(symbol);
    var candles = chartState.candles || [];
    chartState.candles = candles;
    chartState.symbol = symbol;
    chartState.timeframe = tf;

    if (!candles || !candles.length) {
      if (modeBadge) {
        modeBadge.innerHTML = '<span class="badge-dot-live" style="background:#ef4444"></span> LIVE FEED DISCONNECTED';
        modeBadge.style.color = '#fca5a5';
      }
      if (statusText) statusText.textContent = 'Awaiting verified broker live market feed';
      if (el('chartsSymbolDisplay')) el('chartsSymbolDisplay').textContent = cfg.name + ' (' + cfg.exchange + ')';
      if (el('chartsChangeDisplay')) {
        el('chartsChangeDisplay').textContent = '—';
        el('chartsChangeDisplay').className = 'symbol-change';
        el('chartsChangeDisplay').style.color = 'var(--muted)';
      }
      if (el('chartsOhlcDisplay')) el('chartsOhlcDisplay').textContent = 'O: —  H: —  L: —  C: —';
      if (el('chartsRsiVal')) el('chartsRsiVal').textContent = '—';
      if (el('chartsVwapVal')) el('chartsVwapVal').textContent = '—';
      if (el('chartsAtrVal')) el('chartsAtrVal').textContent = '—';
      if (el('chartsTrendVal')) {
        el('chartsTrendVal').textContent = 'DISCONNECTED';
        el('chartsTrendVal').style.color = 'var(--muted)';
      }
      drawDedicatedSvgChart(svg, []);
      return;
    }

    if (offlineNotice) offlineNotice.style.display = 'none';
    if (svg) svg.style.display = 'block';
    if (calloutBanner) calloutBanner.style.display = 'block';

    // Update OHLC Header
    var latest = candles[candles.length - 1];
    var first = candles[0];
    var diff = latest.c - first.c;
    var diffPct = first.c ? (diff / first.c * 100).toFixed(2) : '0.00';
    var isPos = diff >= 0;

    if (el('chartsSymbolDisplay')) el('chartsSymbolDisplay').textContent = cfg.name + ' (' + cfg.exchange + ')';
    if (el('chartsChangeDisplay')) {
      el('chartsChangeDisplay').textContent = (isPos ? '+' : '') + diff.toFixed(2) + ' (' + (isPos ? '+' : '') + diffPct + '%)';
      el('chartsChangeDisplay').className = 'symbol-change ' + (isPos ? 'pos' : 'neg');
      el('chartsChangeDisplay').style.color = isPos ? 'var(--tl-green)' : 'var(--tl-red)';
    }
    if (el('chartsOhlcDisplay')) {
      el('chartsOhlcDisplay').textContent = 'O: ₹' + latest.o.toFixed(2) + '  H: ₹' + latest.h.toFixed(2) + '  L: ₹' + latest.l.toFixed(2) + '  C: ₹' + latest.c.toFixed(2);
    }

    // Compute Indicators
    if (M && M.analyze) {
      var analysis = M.analyze(candles, { symbol: symbol, timeframe: tf });
      if (el('chartsRsiVal')) el('chartsRsiVal').textContent = analysis.rsi14 || '—';
      if (el('chartsVwapVal')) el('chartsVwapVal').textContent = '₹' + (analysis.vwap ? analysis.vwap.toLocaleString('en-IN') : '—');
      if (el('chartsAtrVal')) el('chartsAtrVal').textContent = '₹' + (analysis.atr14 ? analysis.atr14.toFixed(2) : '—');
      if (el('chartsTrendVal')) {
        el('chartsTrendVal').textContent = (analysis.trend || 'Sideways').toUpperCase();
        el('chartsTrendVal').style.color = analysis.trend === 'uptrend' ? 'var(--tl-green)' : (analysis.trend === 'downtrend' ? 'var(--tl-red)' : 'var(--muted)');
      }
    }

    drawDedicatedSvgChart(svg, candles);
  }

  // Hook up event listeners for dedicated charts controls
  if (el('chartsSymbolSelect')) el('chartsSymbolSelect').addEventListener('change', renderDedicatedChartsView);
  if (el('chartsRefreshBtn')) el('chartsRefreshBtn').addEventListener('click', renderDedicatedChartsView);
  document.querySelectorAll('#chartsTimeframePills .tf-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('#chartsTimeframePills .tf-btn').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      renderDedicatedChartsView();
    });
  });

  // Canvas Candlestick & Volume Chart Renderer
  function drawMarketCandleChart() {
    var canvas = el('marketCandleCanvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    var rect = canvas.getBoundingClientRect();
    var width = rect.width || canvas.parentElement.clientWidth || 600;
    var height = rect.height || 320;
    var dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    var candles = chartState.candles;
    if (!candles || !candles.length) {
      ctx.fillStyle = '#060913';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No market candle data available', width / 2, height / 2);
      return;
    }

    var rightMargin = 55;
    var bottomMargin = 24;
    var plotWidth = width - rightMargin;
    var totalHeight = height - bottomMargin;
    var pricePlotHeight = totalHeight * 0.76;
    var volPlotHeight = totalHeight * 0.20;
    var volPlotTop = pricePlotHeight + (totalHeight * 0.04);

    // Calculate visible candles according to zoom and pan offset.
    var windowed = M.chartWindow(candles, chartState.zoom, chartState.panOffset);
    chartState.panOffset = windowed.panOffset;
    var baseVisible = windowed.visibleCount;
    var candleSpacing = plotWidth / baseVisible;
    var candleWidth = Math.max(2, candleSpacing * 0.72);
    var startIdx = windowed.startIndex;
    var visibleCandles = windowed.candles;

    // Find min and max price & volume
    var minPrice = Infinity;
    var maxPrice = -Infinity;
    var maxVol = 1;

    visibleCandles.forEach(function (c) {
      if (c.l < minPrice) minPrice = c.l;
      if (c.h > maxPrice) maxPrice = c.h;
      if (c.v > maxVol) maxVol = c.v;
    });

    var priceRange = maxPrice - minPrice;
    if (priceRange <= 0) priceRange = 10;
    var padPrice = priceRange * 0.08;
    minPrice -= padPrice;
    maxPrice += padPrice;
    priceRange = maxPrice - minPrice;

    function getY(price) {
      return pricePlotHeight - ((price - minPrice) / priceRange) * pricePlotHeight;
    }

    // 1. Background
    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, width, height);

    // 2. Horizontal Grid Lines & Price Axis
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';

    var priceSteps = 5;
    for (var s = 0; s <= priceSteps; s++) {
      var pVal = minPrice + (priceRange * (s / priceSteps));
      var y = getY(pVal);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(plotWidth, y);
      ctx.stroke();
      ctx.fillText(pVal.toFixed(1), plotWidth + 6, y + 3);
    }

    // 3. Draw Volume Histogram
    visibleCandles.forEach(function (c, idx) {
      var x = idx * candleSpacing + (candleSpacing / 2);
      var vHeight = (c.v / maxVol) * volPlotHeight;
      var yTop = totalHeight - vHeight;
      ctx.fillStyle = c.c >= c.o ? 'rgba(16, 185, 129, 0.28)' : 'rgba(239, 68, 68, 0.28)';
      ctx.fillRect(x - candleWidth / 2, yTop, candleWidth, vHeight);
    });

    // 4. Draw Candlesticks (Wicks and Bodies)
    visibleCandles.forEach(function (c, idx) {
      var x = idx * candleSpacing + (candleSpacing / 2);
      var isBull = c.c >= c.o;
      var color = isBull ? '#10b981' : '#ef4444';

      var yOpen = getY(c.o);
      var yClose = getY(c.c);
      var yHigh = getY(c.h);
      var yLow = getY(c.l);

      // Wick
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x, yHigh);
      ctx.lineTo(x, yLow);
      ctx.stroke();

      // Body
      var bodyTop = Math.min(yOpen, yClose);
      var bodyHeight = Math.max(1.5, Math.abs(yClose - yOpen));
      ctx.fillStyle = color;
      ctx.fillRect(x - candleWidth / 2, bodyTop, candleWidth, bodyHeight);
    });

    // 5. Draw EMA & VWAP Overlays
    var showEma = el('toggleEma') ? el('toggleEma').checked : true;
    var showVwap = el('toggleVwap') ? el('toggleVwap').checked : true;

    if (M) {
      var closes = visibleCandles.map(function (c) { return c.c; });
      if (showEma && closes.length >= 9) {
        var e9 = M.ema(closes, 9);
        var e20 = M.ema(closes, 20);

        // EMA 9 (Cyan)
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        e9.forEach(function (val, idx) {
          var x = idx * candleSpacing + (candleSpacing / 2);
          var y = getY(val);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // EMA 20 (Purple)
        ctx.strokeStyle = '#c084fc';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        e20.forEach(function (val, idx) {
          var x = idx * candleSpacing + (candleSpacing / 2);
          var y = getY(val);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
      }

      if (showVwap && visibleCandles.length >= 2) {
        var vw = M.vwap(visibleCandles);
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        vw.forEach(function (val, idx) {
          var x = idx * candleSpacing + (candleSpacing / 2);
          var y = getY(val);
          if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // 6. Crosshair & Hover Inspector
    if (chartState.hoveredIdx >= 0 && chartState.hoveredIdx < visibleCandles.length) {
      var hCandle = visibleCandles[chartState.hoveredIdx];
      var hX = chartState.hoveredIdx * candleSpacing + (candleSpacing / 2);
      var hY = getY(hCandle.c);

      // Vertical line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hX, 0);
      ctx.lineTo(hX, totalHeight);
      ctx.stroke();

      // Horizontal line
      ctx.beginPath();
      ctx.moveTo(0, hY);
      ctx.lineTo(plotWidth, hY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Price badge on right
      ctx.fillStyle = '#3b82f6';
      ctx.fillRect(plotWidth, hY - 9, rightMargin - 4, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(hCandle.c.toFixed(1), plotWidth + 6, hY + 4);

      // Update Top Hover Bar
      var dateStr = new Date(hCandle.t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      var ohlcEl = el('chartOhlcBar');
      if (ohlcEl) {
        var diff = round(hCandle.c - hCandle.o);
        var diffColor = diff >= 0 ? '#10b981' : '#ef4444';
        ohlcEl.innerHTML =
          '<span><b>Time:</b> ' + dateStr + '</span>' +
          '<span><b>O:</b> ₹' + hCandle.o.toFixed(2) + '</span>' +
          '<span><b>H:</b> ₹' + hCandle.h.toFixed(2) + '</span>' +
          '<span><b>L:</b> ₹' + hCandle.l.toFixed(2) + '</span>' +
          '<span><b>C:</b> ₹' + hCandle.c.toFixed(2) + '</span>' +
          '<span style="color:' + diffColor + '"><b>Change:</b> ' + (diff >= 0 ? '+' : '') + diff.toFixed(2) + '</span>' +
          '<span><b>Vol:</b> ' + hCandle.v.toLocaleString('en-IN') + '</span>';
      }
    }

    // 7. Time Axis Labels (Every ~5 candles)
    ctx.fillStyle = '#64748b';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    var timeStep = Math.max(3, Math.floor(visibleCandles.length / 5));
    for (var tIdx = 0; tIdx < visibleCandles.length; tIdx += timeStep) {
      var tc = visibleCandles[tIdx];
      var tx = tIdx * candleSpacing + (candleSpacing / 2);
      var tStr = new Date(tc.t).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      ctx.fillText(tStr, tx, height - 6);
    }
  }

  function initChartCanvasEvents() {
    var canvas = el('marketCandleCanvas');
    if (!canvas || canvas._inited) return;
    canvas._inited = true;

    canvas.addEventListener('mousedown', function (e) {
      chartState.isDragging = true;
      chartState.dragStartX = e.clientX;
      chartState.dragStartPan = chartState.panOffset || 0;
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mouseup', function () {
      if (!chartState.isDragging) return;
      chartState.isDragging = false;
      canvas.style.cursor = 'grab';
    });
    canvas.addEventListener('keydown', function (e) {
      var key = e.key;
      if (['ArrowLeft', 'ArrowRight', '+', '=', '-', '_', 'Home'].indexOf(key) === -1) return;
      e.preventDefault();
      if (key === 'Home') {
        chartState.zoom = 1;
        chartState.panOffset = 0;
      } else if (key === '+' || key === '=') {
        chartState.zoom = Math.min(3, (chartState.zoom || 1) * 1.25);
      } else if (key === '-' || key === '_') {
        chartState.zoom = Math.max(0.5, (chartState.zoom || 1) / 1.25);
      } else {
        var visible = Math.max(20, Math.min(chartState.candles.length,
          Math.round(chartState.candles.length / (chartState.zoom || 1))));
        var step = Math.max(1, Math.round(visible * 0.1));
        chartState.panOffset = (chartState.panOffset || 0) + (key === 'ArrowLeft' ? step : -step);
      }
      drawMarketCandleChart();
    });
    canvas.addEventListener('mousemove', function (e) {
      if (chartState.isDragging) {
        var dragVisible = Math.max(20, Math.min(chartState.candles.length,
          Math.round(chartState.candles.length / (chartState.zoom || 1))));
        var dragSpacing = (canvas.getBoundingClientRect().width - 55) / Math.max(1, dragVisible);
        chartState.panOffset = Math.max(0, Math.min(chartState.candles.length - dragVisible,
          chartState.dragStartPan + (e.clientX - chartState.dragStartX) / Math.max(1, dragSpacing)));
        drawMarketCandleChart();
        return;
      }
      var rect = canvas.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var plotWidth = rect.width - 55;
      if (x < 0 || x > plotWidth || !chartState.candles.length) {
        chartState.hoveredIdx = -1;
      } else {
        var baseVisible = Math.max(20, Math.min(chartState.candles.length, Math.round(chartState.candles.length / chartState.zoom)));
        var candleSpacing = plotWidth / baseVisible;
        chartState.hoveredIdx = Math.floor(x / candleSpacing);
      }
      drawMarketCandleChart();
    });

    canvas.addEventListener('mouseleave', function () {
      chartState.isDragging = false;
      chartState.hoveredIdx = -1;
      drawMarketCandleChart();
      var ohlcEl = el('chartOhlcBar');
      if (ohlcEl) ohlcEl.innerHTML = '<span>Hover over chart to inspect candle values</span>';
    });

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (e.deltaY < 0) {
        chartState.zoom = Math.min(3.0, chartState.zoom * 1.15);
      } else {
        chartState.zoom = Math.max(0.5, chartState.zoom / 1.15);
      }
      drawMarketCandleChart();
    }, { passive: false });

    // Indicator & Zoom button event listeners
    if (el('toggleEma')) el('toggleEma').addEventListener('change', drawMarketCandleChart);
    if (el('toggleVwap')) el('toggleVwap').addEventListener('change', drawMarketCandleChart);
    if (el('chartZoomInBtn')) el('chartZoomInBtn').addEventListener('click', function () {
      chartState.zoom = Math.min(3.0, chartState.zoom * 1.25);
      drawMarketCandleChart();
    });
    if (el('chartZoomOutBtn')) el('chartZoomOutBtn').addEventListener('click', function () {
      chartState.zoom = Math.max(0.5, chartState.zoom / 1.25);
      drawMarketCandleChart();
    });
    if (el('chartResetBtn')) el('chartResetBtn').addEventListener('click', function () {
      chartState.zoom = 1.0;
      chartState.panOffset = 0;
      drawMarketCandleChart();
    });

    window.addEventListener('resize', function () {
      if (el('tab-market') && el('tab-market').classList.contains('active')) {
        drawMarketCandleChart();
      }
    });
  }

  function renderMarketData(data) {
    var box = el('marketResult');
    if (!box) return;
    var a = data.analysis || {};
    if (!a.ok) {
      box.innerHTML = '<div class="callout" style="margin:0">Analysis unavailable: ' + (a.reason || 'unknown') + '</div>';
      return;
    }

    var zonesHtml = function (list, label) {
      if (!list || !list.length) return '';
      return '<tr><td class="k">' + label + '</td><td class="v">' + list.slice(-3).map(function (z) {
        return z.low + '–' + z.high + (z.mitigated ? ' (mitigated)' : ' (fresh)');
      }).join(' · ') + '</td></tr>';
    };

    var fvgsHtml = (a.fvgs || []).filter(function (g) { return !g.mitigated; }).slice(-3)
      .map(function (g) { return g.type + ' ' + g.low + '–' + g.high; }).join(' · ');

    var nearestRes = (a.nearestResistance || []).map(function (l) { return l.price + (l.source ? ' (' + l.source + ')' : ''); }).join(' · ') || '—';
    var nearestSup = (a.nearestSupport || []).map(function (l) { return l.price + (l.source ? ' (' + l.source + ')' : ''); }).join(' · ') || '—';

    box.innerHTML =
      '<div class="grid4" style="margin-bottom:14px">' +
        '<div class="stat-card"><span class="stat-lbl">Price / Trend</span><span class="stat-val">' + a.price + '</span><span class="stat-sub">' + a.trend + ' structure</span></div>' +
        '<div class="stat-card"><span class="stat-lbl">VWAP / EMA 20</span><span class="stat-val">' + (a.vwap || '—') + '</span><span class="stat-sub">EMA: ' + (a.ema20 || '—') + '</span></div>' +
        '<div class="stat-card"><span class="stat-lbl">RSI (14)</span><span class="stat-val">' + a.rsi14 + '</span><span class="stat-sub">' + (a.rsi14 > 70 ? 'Overbought' : a.rsi14 < 30 ? 'Oversold' : 'Neutral') + '</span></div>' +
        '<div class="stat-card"><span class="stat-lbl">ATR (14)</span><span class="stat-val">' + (a.atr14 || '—') + '</span><span class="stat-sub">Volatility range</span></div>' +
      '</div>' +
      '<table class="limits">' +
        row('Nearest Resistance', nearestRes) +
        row('Nearest Support', nearestSup) +
        zonesHtml(a.supplyZones, 'Supply Zones') +
        zonesHtml(a.demandZones, 'Demand Zones') +
        (fvgsHtml ? '<tr><td class="k">Unfilled FVGs</td><td class="v">' + fvgsHtml + '</td></tr>' : '') +
      '</table>' +
      '<div class="callout blue" style="margin-top:14px">' +
        '<b>AI Market Brief:</b> ' + (data.brief && data.brief.text ? escapeHtml(data.brief.text) : 'Market testing key zones. Watch for price reaction at nearest pivot.') +
      '</div>';
  }

  // ---------------------------------------------------- Market & OI Dashboard ----

  function renderDisconnectedMarketState(symbol, err, hint) {
    var oiContainer = el('oiBarsContainer');
    if (oiContainer) {
      oiContainer.innerHTML =
        '<div style="text-align:center;color:var(--dim);padding:36px;border:1px dashed var(--line);border-radius:12px;background:rgba(0,0,0,0.25)">' +
          '<div style="font-size:14px;font-weight:600;margin-bottom:6px;color:#fca5a5">Live Open Interest Feed Offline</div>' +
          '<div style="font-size:12px;color:var(--muted)">No verified exchange tick feed is available for ' + escapeHtml(symbol) + '. Trade Lock will not display fabricated OI data while Live mode is active.</div>' +
        '</div>';
    }
    var canvas = el('marketCandleCanvas');
    if (canvas) {
      var ctx = canvas.getContext('2d');
      if (ctx) {
        var rect = canvas.getBoundingClientRect();
        var width = rect.width || canvas.parentElement.clientWidth || 600;
        var height = rect.height || 320;
        ctx.fillStyle = '#060913';
        ctx.fillRect(0, 0, width, height);
        ctx.fillStyle = '#f87171';
        ctx.font = '13px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Live Exchange Feed Disconnected (' + escapeHtml(String(err || 'OFFLINE').toUpperCase()) + ')', width / 2, height / 2 - 10);
        ctx.fillStyle = '#94a3b8';
        ctx.font = '11px Inter, sans-serif';
        ctx.fillText('Switch Data Source to Simulated Demo to view layout and indicator test curves', width / 2, height / 2 + 14);
      }
    }
    if (el('marketSpotVal')) el('marketSpotVal').textContent = '—';
    if (el('marketThetaVal')) el('marketThetaVal').textContent = 'Live Feed Disconnected';
    if (el('marketPcrVal')) el('marketPcrVal').textContent = '—';
    if (el('marketMaxPainVal')) el('marketMaxPainVal').textContent = '—';
    if (el('marketResult')) {
      el('marketResult').innerHTML =
        '<div class="callout" style="background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);color:#fca5a5;font-size:12px">' +
          'Live technical structure unavailable: ' + escapeHtml(hint || 'Provider credentials not configured on backend server.') +
        '</div>';
    }
  }

  function renderMarketAndOiDashboard() {
    var symbol = el('marketSymbol') ? el('marketSymbol').value : 'NIFTY';
    var tf = el('marketTimeframe') ? el('marketTimeframe').value : '15m';
    var source = el('marketSource') ? el('marketSource').value : 'live';
    var expiry = el('marketExpiry') ? el('marketExpiry').value : 'current';

    var setupCard = el('liveMarketSetupCard');
    var badgeEl = el('marketTimestampBadge');
    var timeEl = el('marketUpdatedTimestamp');
    var noteEl = el('marketNote');
    if (source === 'broker') {
      if (noteEl) noteEl.textContent = 'Syncing quotes from active broker tab...';
      chrome.runtime.sendMessage({ type: 'TL_CHECK_MARKET_FEED', source: 'broker', symbol: symbol }, function (resp) {
        var tickerStrip = el('brokerTickerStrip');
        if (chrome.runtime.lastError || !resp || !resp.connected || !resp.quotes) {
          var err = (resp && resp.error) || 'no_broker_tab';
          var hint = (resp && resp.hint) || 'Open your broker tab (Zerodha Kite, Fyers, Upstox, Dhan, Angel One) in Chrome to stream live quotes automatically.';
          if (tickerStrip) tickerStrip.style.display = 'none';
          if (setupCard) {
            setupCard.style.display = 'block';
            setupCard.className = 'live-setup-card';
            setupCard.innerHTML =
              '<div class="live-setup-head">' +
                '<span class="live-setup-title">📡 Waiting for Active Broker Tab</span>' +
                '<span class="badge warn" style="font-size:10px">Approach B: Browser Market Tap</span>' +
              '</div>' +
              '<div class="live-setup-body">' +
                'Trade Lock syncs real live market quotes directly from your open broker tab in Google Chrome. ' +
                'Zero developer tokens, zero Fyers API keys, and no 24/7 background servers required.' +
              '</div>' +
              '<div class="live-setup-meta">' +
                '<span><b>Supported Brokers:</b> Zerodha Kite, Upstox, Fyers Web, Dhan, Angel One, Groww</span>' +
                '<span><b>Status:</b> ' + (err === 'no_broker_tab' ? 'NO ACTIVE BROKER TAB DETECTED' : escapeHtml(String(err).toUpperCase())) + '</span>' +
                '<span><b>Last Checked:</b> ' + new Date().toLocaleTimeString('en-IN') + ' IST</span>' +
              '</div>' +
              '<div class="live-setup-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<a href="https://kite.zerodha.com" target="_blank" rel="noopener noreferrer" class="primary" style="text-decoration:none;display:inline-block;padding:7px 14px;font-size:12px;background:#ff5722;color:#fff;border-radius:6px;font-weight:600">Open Zerodha Kite</a>' +
                '<a href="https://trade.fyers.in" target="_blank" rel="noopener noreferrer" class="primary" style="text-decoration:none;display:inline-block;padding:7px 14px;font-size:12px;background:#2563eb;color:#fff;border-radius:6px;font-weight:600">Open Fyers Web</a>' +
                '<a href="https://web.dhan.co" target="_blank" rel="noopener noreferrer" class="primary" style="text-decoration:none;display:inline-block;padding:7px 14px;font-size:12px;background:#10b981;color:#fff;border-radius:6px;font-weight:600">Open Dhan</a>' +
                '<a href="https://upstox.com" target="_blank" rel="noopener noreferrer" class="primary" style="text-decoration:none;display:inline-block;padding:7px 14px;font-size:12px;background:#6366f1;color:#fff;border-radius:6px;font-weight:600">Open Upstox</a>' +
                '<button type="button" id="retryBrokerFeedBtn" class="ghost" style="padding:6px 14px;font-size:12px">Check Again</button>' +
              '</div>';

            var retryBrokerBtn = el('retryBrokerFeedBtn');
            if (retryBrokerBtn) retryBrokerBtn.addEventListener('click', renderMarketAndOiDashboard);
          }

          if (badgeEl) {
            badgeEl.className = 'badge warn';
            badgeEl.style.cssText = 'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;font-size:11px';
            badgeEl.innerHTML = '⏳ Waiting for Broker Tab · Kite / Fyers / Dhan / Upstox';
          }
          if (timeEl) timeEl.textContent = 'Last Probe: ' + new Date().toLocaleTimeString('en-IN') + ' IST';
          if (noteEl) noteEl.textContent = 'Waiting for broker tab in Chrome';

          renderDisconnectedMarketState(symbol, err, hint);
          return;
        }

        // Broker quotes connected!
        if (setupCard) setupCard.style.display = 'none';
        if (tickerStrip) tickerStrip.style.display = 'grid';

        var quotes = resp.quotes;
        var fetchedAt = resp.fetchedAt || Date.now();
        var isStale = (Date.now() - fetchedAt) > 60000;
        var provider = resp.provider || 'Broker Tab';

        if (badgeEl) {
          badgeEl.className = isStale ? 'badge warn' : 'badge pro';
          badgeEl.style.cssText = isStale
            ? 'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;font-size:11px'
            : 'background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#34d399;font-size:11px';
          badgeEl.innerHTML = isStale
            ? '⚠️ STALE QUOTES (>60s) · ' + escapeHtml(provider)
            : '🟢 LIVE BROKER TAP · ' + escapeHtml(provider);
        }
        if (timeEl) timeEl.textContent = 'Tick Time: ' + new Date(fetchedAt).toLocaleTimeString('en-IN') + ' IST';
        if (noteEl) noteEl.textContent = 'Live quotes streaming from ' + provider;

        function updateTickerItem(prefix, q) {
          var priceEl = el(prefix + 'Price');
          var chgEl = el(prefix + 'Chg');
          if (q && q.price) {
            if (priceEl) priceEl.textContent = '₹' + q.price.toLocaleString('en-IN', { minimumFractionDigits: 2 });
            if (chgEl) {
              var isPos = q.change >= 0;
              chgEl.style.color = isPos ? '#34d399' : '#f87171';
              chgEl.textContent = (isPos ? '+' : '') + q.change.toFixed(2) + ' (' + (isPos ? '+' : '') + q.changePercent.toFixed(2) + '%)';
            }
          } else {
            if (priceEl) priceEl.textContent = '—';
            if (chgEl) chgEl.textContent = 'Waiting for tick';
          }
        }
        updateTickerItem('tickerNifty', quotes.NIFTY);
        updateTickerItem('tickerBank', quotes.BANKNIFTY);
        updateTickerItem('tickerFin', quotes.FINNIFTY);
        updateTickerItem('tickerSensex', quotes.SENSEX);

        var activeQuote = quotes[symbol] || quotes.NIFTY || Object.values(quotes)[0];
        if (activeQuote && el('marketSpotVal')) {
          el('marketSpotVal').textContent = '₹' + activeQuote.price.toLocaleString('en-IN', { minimumFractionDigits: 2 });
          if (el('marketExchangeSub')) {
            el('marketExchangeSub').textContent = 'Sync: ' + provider;
          }
        }
        if (el('marketThetaVal')) el('marketThetaVal').textContent = 'Streaming Live';
        if (el('marketPcrVal')) el('marketPcrVal').textContent = '—';
        if (el('marketMaxPainVal')) el('marketMaxPainVal').textContent = '—';

        var canvas = el('marketCandleCanvas');
        if (canvas) {
          var ctx = canvas.getContext('2d');
          if (ctx) {
            var rect = canvas.getBoundingClientRect();
            var width = rect.width || canvas.parentElement.clientWidth || 600;
            var height = rect.height || 320;
            ctx.fillStyle = '#060913';
            ctx.fillRect(0, 0, width, height);

            ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            ctx.lineWidth = 1;
            for (var x = 40; x < width; x += 60) {
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
            }
            for (var y = 30; y < height; y += 40) {
              ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
            }

            ctx.fillStyle = 'rgba(16,185,129,0.08)';
            ctx.strokeStyle = 'rgba(16,185,129,0.25)';
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(width / 2 - 190, height / 2 - 65, 380, 130, 10);
            else ctx.rect(width / 2 - 190, height / 2 - 65, 380, 130);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#34d399';
            ctx.font = 'bold 15px Inter, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('🟢 LIVE BROKER MARKET TAP ACTIVE', width / 2, height / 2 - 32);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 22px Inter, sans-serif';
            var priceText = activeQuote ? (activeQuote.name + ': ₹' + activeQuote.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })) : 'Live Quotes Active';
            ctx.fillText(priceText, width / 2, height / 2 + 2);

            ctx.fillStyle = '#94a3b8';
            ctx.font = '12px Inter, sans-serif';
            ctx.fillText('Source: ' + provider + ' · Zero API keys or tokens required', width / 2, height / 2 + 32);
            ctx.fillText('Updated: ' + new Date(fetchedAt).toLocaleTimeString('en-IN') + ' IST', width / 2, height / 2 + 50);
          }
        }
      });
      return;
    }

    if (source === 'live') {
      if (noteEl) noteEl.textContent = 'Probing live exchange connection...';
      chrome.runtime.sendMessage({ type: 'TL_CHECK_MARKET_FEED', symbol: symbol, resolution: tf.replace(/[^0-9]/g, '') || '15' }, function (resp) {
        if (chrome.runtime.lastError || !resp || !resp.connected) {
          var err = (resp && resp.error) || 'offline';
          var hint = (resp && resp.hint) || 'Backend broker credentials (FYERS_APP_ID, FYERS_ACCESS_TOKEN) or Pro+ subscription required.';
          if (setupCard) {
            setupCard.style.display = 'block';
            var apiBase = (currentSettings && currentSettings.licenseApiBase) || 'http://localhost:8787';
            var fyersLoginUrl = (apiBase && !apiBase.includes('netlify.app')) ? (apiBase + '/api/fyers/login') : 'http://localhost:8787/api/fyers/login';
            setupCard.className = 'live-setup-card';
            setupCard.innerHTML =
              '<div class="live-setup-head">' +
                '<span class="live-setup-title">🔴 Live Exchange Feed: Disconnected / Setup Required</span>' +
                '<span class="badge danger" style="font-size:10px">Provider: Fyers API v3</span>' +
              '</div>' +
              '<div class="live-setup-body">' +
                'Live exchange WebSocket feed is not connected. Live market tick data requires verified broker API access. ' + escapeHtml(hint) +
                ' To protect trading discipline, Trade Lock refuses to fabricate live ticks.' +
              '</div>' +
              '<div class="live-setup-meta">' +
                '<span><b>Provider:</b> Fyers API v3</span>' +
                '<span><b>Endpoint:</b> /api/market/live</span>' +
                '<span><b>Status:</b> ' + escapeHtml(String(err).toUpperCase()) + '</span>' +
                '<span><b>Last Checked:</b> ' + new Date().toLocaleTimeString('en-IN') + ' IST</span>' +
              '</div>' +
              '<div class="live-setup-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
                '<a href="' + escapeHtml(fyersLoginUrl) + '" target="_blank" rel="noopener noreferrer" class="primary" style="text-decoration:none;display:inline-block;padding:7px 16px;font-size:12px;background:#2563eb;color:#fff;border-radius:6px;font-weight:600">Connect Fyers (1-Click Login)</a>' +
                '<button type="button" id="retryLiveFeedBtn" class="ghost" style="padding:6px 14px;font-size:12px">Retry Connection</button>' +
              '</div>';

            var retryBtn = el('retryLiveFeedBtn');
            if (retryBtn) retryBtn.addEventListener('click', renderMarketAndOiDashboard);
          }

          if (badgeEl) {
            badgeEl.className = 'badge danger';
            badgeEl.style.cssText = 'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:11px';
            badgeEl.innerHTML = '● Live Feed Disconnected · Provider Unreachable';
          }
          if (timeEl) timeEl.textContent = 'Last Probe: ' + new Date().toLocaleTimeString('en-IN') + ' IST';
          if (noteEl) noteEl.textContent = 'Live exchange WebSocket feed is not connected (' + err + ')';

          renderDisconnectedMarketState(symbol, err, hint);
          return;
        }

        // Live feed connected!
        if (setupCard) setupCard.style.display = 'none';
        var snap = resp.data;
        var isStale = (Date.now() - snap.fetchedAt) > 60000;
        if (badgeEl) {
          badgeEl.className = isStale ? 'badge warn' : 'badge pro';
          badgeEl.style.cssText = isStale
            ? 'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;font-size:11px'
            : 'background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#34d399;font-size:11px';
          badgeEl.innerHTML = isStale
            ? '⚠️ STALE FEED (>60s) · Fyers API v3'
            : '🟢 LIVE FEED CONNECTED · Fyers API v3';
        }
        if (timeEl) timeEl.textContent = 'Tick Time: ' + new Date(snap.fetchedAt).toLocaleTimeString('en-IN') + ' IST';
        if (noteEl) noteEl.textContent = 'Live feed active';

        if (snap.analysis) renderMarketData(snap);
      });
      return;
    }

    // Demo Mode
    if (setupCard) setupCard.style.display = 'none';
    if (badgeEl) {
      badgeEl.className = 'badge';
      badgeEl.style.cssText = 'background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#fbbf24;font-size:11px';
      badgeEl.innerHTML = 'Source: Deterministic Model · <span id="marketUpdatedTimestamp">Demo Render Time: Just now</span>';
    }
    if (noteEl) noteEl.textContent = '';

    var cfg = getInstrumentConfig(symbol);
    var spot = cfg.basePrice;
    var step = cfg.step;

    var dte = expiry === 'monthly' ? 23 : (expiry === 'next' ? 9 : 2);
    var dteFactor = Math.sqrt(dte / 2);
    var decayRate = expiry === 'monthly' ? '~3.2% / day' : (expiry === 'next' ? '~7.5% / day' : '~18% / day');
    var baseStraddle = Math.round((spot * 0.01) * dteFactor);
    if (el('marketThetaVal')) {
      el('marketThetaVal').textContent = '₹' + baseStraddle + ' · ' + decayRate;
    }

    if (el('marketSpotVal')) el('marketSpotVal').textContent = '₹' + spot.toLocaleString('en-IN') + '.00';
    if (el('marketExchangeSub')) el('marketExchangeSub').textContent = cfg.exchange + ' ' + cfg.name + ' [DEMO]';

    // Option strikes arrive from live exchange feed; synthetic math is purged.
    var rows = Array.isArray(chartState.optionRows) ? chartState.optionRows : [];
    var maxOi = 1;
    rows.forEach(function (r) {
      if (r.callOi > maxOi) maxOi = r.callOi;
      if (r.putOi > maxOi) maxOi = r.putOi;
    });

    var summary = (rows.length && M && M.oiSummary) ? M.oiSummary(rows, spot) : null;
    if (summary) {
      if (el('marketPcrVal')) el('marketPcrVal').textContent = summary.pcr;
      if (el('marketPcrBias')) {
        el('marketPcrBias').innerHTML = summary.pcr > 1.2
          ? '<span class="badge pro" style="font-size:10.5px">Bullish Bias</span>'
          : summary.pcr < 0.8
            ? '<span class="badge danger" style="font-size:10.5px">Bearish Bias</span>'
            : '<span class="badge" style="background:rgba(255,255,255,0.08);color:var(--muted);font-size:10.5px">Neutral Range</span>';
      }
      if (el('marketMaxPainVal')) {
        var dist = summary.maxPain ? (summary.maxPain - spot) : 0;
        el('marketMaxPainVal').textContent = (summary.maxPain ? summary.maxPain.toLocaleString('en-IN') : '—') +
          (dist ? ' (' + (dist > 0 ? '+' : '') + dist + ')' : '');
      }
    } else {
      if (el('marketPcrVal')) el('marketPcrVal').textContent = '—';
      if (el('marketPcrBias')) el('marketPcrBias').innerHTML = '<span class="badge" style="background:rgba(255,255,255,0.08);color:var(--muted);font-size:10.5px">Awaiting Live Feed</span>';
      if (el('marketMaxPainVal')) el('marketMaxPainVal').textContent = '—';
    }

    // Render Dual-Bar Visual Chart
    var container = el('oiBarsContainer');
    if (container) {
      container.innerHTML = '';
      if (!rows.length) {
        container.innerHTML = '<div style="padding:32px 16px;text-align:center;color:#94a3b8;font-size:12px;background:rgba(255,255,255,0.02);border:1px dashed var(--line);border-radius:8px">No live option chain data available. Connect live broker WebSocket feed to stream strikes and OI walls.</div>';
      } else {
      rows.forEach(function (r) {
        var isAtm = Math.abs(r.strike - spot) < step;
        var isCallWall = summary && r.strike === summary.maxCallOiStrike;
        var isPutWall = summary && r.strike === summary.maxPutOiStrike;

        var callPct = Math.max(3, Math.min(100, Math.round((r.callOi / maxOi) * 100)));
        var putPct = Math.max(3, Math.min(100, Math.round((r.putOi / maxOi) * 100)));

        var rowDiv = document.createElement('div');
        rowDiv.className = 'oi-bar-row' + (isAtm ? ' atm-row' : '');
        rowDiv.innerHTML =
          '<div class="oi-call-bar-wrap">' +
            (isCallWall ? '<span class="wall-tag call">Call Wall</span>' : '') +
            '<span style="color:#6ee7b7;font-weight:600">' + r.callOi.toLocaleString('en-IN') + '</span>' +
            '<div class="oi-bar call" style="width:' + callPct + '%"></div>' +
          '</div>' +
          '<div style="text-align:center">' +
            '<span class="oi-strike-badge' + (isAtm ? ' atm' : '') + '">' + r.strike.toLocaleString('en-IN') + (isAtm ? ' ★' : '') + '</span>' +
          '</div>' +
          '<div class="oi-put-bar-wrap">' +
            '<div class="oi-bar put" style="width:' + putPct + '%"></div>' +
            '<span style="color:#fca5a5;font-weight:600">' + r.putOi.toLocaleString('en-IN') + '</span>' +
            (isPutWall ? '<span class="wall-tag put">Put Wall</span>' : '') +
          '</div>';
        container.appendChild(rowDiv);
      });
      }
    }

    // Compute Technical Candles, Indicators, and VIX Analytics
    computeLocalMarket(symbol, tf);

    var timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';
    if (el('marketUpdatedTimestamp')) el('marketUpdatedTimestamp').textContent = 'Demo Render Time: ' + timeStr;
  }

  if (el('marketBtn')) {
    el('marketBtn').addEventListener('click', function () {
      renderMarketAndOiDashboard();
    });
  }
  if (el('marketSymbol')) el('marketSymbol').addEventListener('change', renderMarketAndOiDashboard);
  if (el('marketExpiry')) el('marketExpiry').addEventListener('change', renderMarketAndOiDashboard);
  if (el('marketTimeframe')) el('marketTimeframe').addEventListener('change', renderMarketAndOiDashboard);
  if (el('marketSource')) {
    el('marketSource').addEventListener('change', function () {
      var src = el('marketSource').value;
      if (currentSettings) currentSettings.marketSource = src;
      chrome.storage.local.get('tlSettings', function (res) {
        var s = Object.assign({}, res.tlSettings || {}, { marketSource: src });
        chrome.storage.local.set({ tlSettings: s });
      });
      renderMarketAndOiDashboard();
      if (el('optionsSymbol')) renderOptionsChainView();
      if (el('chartsSymbolSelect')) renderDedicatedChartsView();
    });
  }

  if (el('saveBlockedHostsBtn')) {
    el('saveBlockedHostsBtn').addEventListener('click', function () {
      var lines = parseLines(el('blockedHosts') ? el('blockedHosts').value : '');
      currentSettings.blockedHosts = lines;
      chrome.storage.local.get('tlSettings', function (res) {
        var s = Object.assign({}, res.tlSettings || {}, { blockedHosts: lines });
        chrome.storage.local.set({ tlSettings: s }, function () {
          chrome.runtime.sendMessage({ type: 'TL_SETTINGS_SAVED' }, function () {
            void chrome.runtime.lastError;
          });
          var st = el('saveBlockedHostsStatus');
          if (st) {
            st.style.display = 'inline';
            setTimeout(function () { st.style.display = 'none'; }, 2500);
          }
        });
      });
    });
  }

  if (el('overviewSymbol')) {
    el('overviewSymbol').addEventListener('change', function () {
      if (el('marketSymbol')) el('marketSymbol').value = el('overviewSymbol').value;
      renderMarketAndOiDashboard();
    });
  }
  if (el('overviewTimeframe')) {
    el('overviewTimeframe').addEventListener('change', function () {
      if (el('marketTimeframe')) el('marketTimeframe').value = el('overviewTimeframe').value;
      renderMarketAndOiDashboard();
    });
  }

  function computeLocalMarket(symbol, tf) {
    var cfg = getInstrumentConfig(symbol);
    var candles = generateSampleCandles(cfg.basePrice, 60, tf, symbol);
    chartState.candles = candles;
    chartState.panOffset = 0;
    chartState.symbol = symbol;
    chartState.timeframe = tf;

    if (el('chartHeaderSymbol')) el('chartHeaderSymbol').textContent = cfg.name + ' (' + cfg.exchange + ') [DEMO]';
    if (el('chartIntervalBadge')) el('chartIntervalBadge').textContent = tf + ' · SIMULATED';
    if (el('chartCandleCount')) el('chartCandleCount').textContent = candles.length + ' simulated candles';
    if (el('chartTimestampRange')) el('chartTimestampRange').textContent = 'Source: Deterministic Model (Simulated Demo Data)';

    renderOverviewChart();
    initChartCanvasEvents();

    if (!M) {
      if (el('marketNote')) el('marketNote').textContent = 'Engine not loaded';
      return;
    }

    var analysis = M.analyze(candles, { symbol: symbol, timeframe: tf });
    chartState.analysis = analysis;
    drawMarketCandleChart();

    // VIX Analytics & Regime Computation
    if (M.vixAnalytics) {
      var vix = M.vixAnalytics(13.85, 13.43);
      if (el('vixVal')) el('vixVal').textContent = vix.value;
      if (el('vixChg')) {
        el('vixChg').textContent = (vix.change >= 0 ? '+' : '') + vix.change + ' (' + (vix.changePct >= 0 ? '+' : '') + vix.changePct + '%)';
        el('vixChg').style.color = vix.change >= 0 ? '#10b981' : '#f87171';
      }
      if (el('vixRank')) el('vixRank').textContent = vix.ivRank + '% / ' + vix.ivPercentile + '%';
      if (el('vixRegimeBadge')) {
        el('vixRegimeBadge').textContent = 'Regime: ' + vix.status + ' (' + vix.value + ')';
        el('vixRegimeBadge').style.background = vix.isSpike ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.18)';
        el('vixRegimeBadge').style.color = vix.isSpike ? '#f87171' : '#34d399';
      }
      if (el('vixAlertStatus')) {
        el('vixAlertStatus').textContent = vix.isSpike ? '⚠️ Spike Alert Triggered' : 'Normal';
        el('vixAlertStatus').style.color = vix.isSpike ? '#f87171' : '#34d399';
      }
    }

    if (el('marketNote')) el('marketNote').textContent = 'Deterministic Model (Simulated Demo Data) · ' + tf;
    renderMarketData({
      analysis: analysis,
      brief: {
        text: cfg.name + ' is in a ' + analysis.trend + ' market structure with RSI at ' + analysis.rsi14 +
              '. Primary resistance rests at ' + ((analysis.nearestResistance[0] && analysis.nearestResistance[0].price) || '—') +
              ' and support at ' + ((analysis.nearestSupport[0] && analysis.nearestSupport[0].price) || '—') + '.'
      }
    });
  }

  // -------------------------------------------------- options analytics ----

  function renderOptionsChainView() {
    var symbol = el('optionsSymbol') ? el('optionsSymbol').value : 'NIFTY';
    var expiry = el('optionsExpiry') ? el('optionsExpiry').value : 'current';
    var filter = el('optMoneynessFilter') ? el('optMoneynessFilter').value : 'near';
    var source = (el('marketSource') && el('marketSource').value) || (currentSettings && currentSettings.marketSource) || 'demo';

    var setupCard = el('liveOptionsSetupCard');
    var simCallout = el('optionsSimulatedCallout');
    var modeBadge = el('optionsModeBadge');
    var emptyNotice = el('optionsChainEmptyNotice');
    var tableWrap = el('optionsTableWrap');

    if (source === 'live') {
      chrome.storage.local.get('tlMarket', function (res) {
        var snap = res && res.tlMarket;
        var hasLiveChain = snap && snap.source === 'live' && snap.analysis && snap.analysis.oi;
        if (!hasLiveChain) {
          if (setupCard) {
            setupCard.style.display = 'block';
            setupCard.className = 'live-setup-card warn';
            setupCard.innerHTML =
              '<div class="live-setup-head">' +
                '<span class="live-setup-title">⚠️ Live Options Chain Unavailable</span>' +
                '<span class="badge danger" style="font-size:10px">Exchange Feed Offline</span>' +
              '</div>' +
              '<div class="live-setup-body">' +
                'A live index quote alone does not supply a complete live options chain with individual strikes, IV, and Greeks. ' +
                'Live strike-by-strike options require a configured broker data API with options entitlements. ' +
                'To prevent trading on unreliable data, Trade Lock refuses to fabricate live strikes.' +
              '</div>' +
              '<div class="live-setup-actions">' +
                '<button type="button" id="optSwitchDemoBtn" class="primary" style="padding:6px 14px;font-size:12px">Switch to Simulated Demo Model</button>' +
              '</div>';
            var sbtn = el('optSwitchDemoBtn');
            if (sbtn) {
              sbtn.addEventListener('click', function () {
                if (el('marketSource')) el('marketSource').value = 'demo';
                renderMarketAndOiDashboard();
                renderOptionsChainView();
              });
            }
          }
          if (simCallout) simCallout.style.display = 'none';
          if (modeBadge) {
            modeBadge.textContent = 'Live Feed Offline';
            modeBadge.style.cssText = 'background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5';
          }
          if (emptyNotice) {
            emptyNotice.style.display = 'block';
            emptyNotice.innerHTML =
              '<div style="font-size:14px;font-weight:600;margin-bottom:6px;color:#fca5a5">Live Options Feed Unavailable</div>' +
              '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">No live strike-by-strike options feed received. Trade Lock will not invent synthetic strike data under Live mode.</div>';
          }
          if (tableWrap) tableWrap.style.display = 'none';
          if (el('optSpotPrice')) el('optSpotPrice').textContent = '—';
          if (el('optCallThetaVal')) el('optCallThetaVal').textContent = '—';
          if (el('optPutThetaVal')) el('optPutThetaVal').textContent = '—';
          if (el('optHourlyDecay')) el('optHourlyDecay').textContent = '—';
          return;
        }

        if (setupCard) setupCard.style.display = 'none';
        if (simCallout) simCallout.style.display = 'none';
        if (emptyNotice) emptyNotice.style.display = 'none';
        if (tableWrap) tableWrap.style.display = 'block';
        if (modeBadge) {
          modeBadge.textContent = 'Live Exchange Chain';
          modeBadge.style.cssText = 'background:rgba(16,185,129,0.15);border:1px solid rgba(16,185,129,0.3);color:#34d399';
        }
      });
      return;
    }

    // Demo Mode
    if (setupCard) setupCard.style.display = 'none';
    if (simCallout) simCallout.style.display = 'block';
    if (emptyNotice) emptyNotice.style.display = 'none';
    if (tableWrap) tableWrap.style.display = 'block';
    if (modeBadge) {
      modeBadge.textContent = 'Simulated Model Chain';
      modeBadge.style.cssText = 'background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);color:#fbbf24';
    }

    var cfg = getInstrumentConfig(symbol);
    var spot = cfg.basePrice;
    var step = cfg.step;
    var dte = expiry === 'monthly' ? 23 : (expiry === 'next' ? 9 : 2);

    // Option strikes arrive from live exchange feed; synthetic math is purged.
    var rows = Array.isArray(chartState.fullOptionRows) ? chartState.fullOptionRows : [];

    if (!rows.length) {
      if (el('optCallThetaVal')) el('optCallThetaVal').textContent = '—';
      if (el('optCallThetaSub')) el('optCallThetaSub').textContent = 'Live broker feed required';
      if (el('optPutThetaVal')) el('optPutThetaVal').textContent = '—';
      if (el('optPutThetaSub')) el('optPutThetaSub').textContent = 'Live broker feed required';
      if (el('optHourlyDecay')) el('optHourlyDecay').textContent = '—';
      if (el('optPcrVal')) el('optPcrVal').textContent = '—';
      if (el('optPcrBias')) el('optPcrBias').textContent = 'Awaiting Live Feed';
      if (el('optMaxPain')) el('optMaxPain').textContent = '—';

      var tbody = el('optionsChainTbody');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="13" style="text-align:center;padding:48px 16px;color:#94a3b8;font-size:13px;line-height:1.6">' +
          '<div style="font-size:15px;font-weight:600;margin-bottom:6px;color:#e2e8f0">🔴 Live Option Chain Disconnected</div>' +
          '<div>Real-time option strikes, Greeks, Open Interest, and volume require an authenticated broker feed (Fyers API v3). Trade Lock does not fabricate simulated strikes.</div>' +
          '</td></tr>';
      }
      return;
    }

    var atmCallTheta = 0;
    var atmPutTheta = 0;
    var atmCallPrice = 0;
    var atmPutPrice = 0;

    // Update Telemetry with Distinct Call & Put Theta
    if (el('optCallThetaVal')) el('optCallThetaVal').textContent = '₹' + atmCallTheta.toFixed(2) + ' / d';
    if (el('optCallThetaSub')) {
      var callPct = atmCallPrice > 0 ? Math.round((Math.abs(atmCallTheta) / atmCallPrice) * 100) : 14;
      el('optCallThetaSub').textContent = '~' + callPct + '% decay / day (DTE ' + dte + ')';
    }
    if (el('optPutThetaVal')) el('optPutThetaVal').textContent = '₹' + atmPutTheta.toFixed(2) + ' / d';
    if (el('optPutThetaSub')) {
      var putPct = atmPutPrice > 0 ? Math.round((Math.abs(atmPutTheta) / atmPutPrice) * 100) : 14;
      el('optPutThetaSub').textContent = '~' + putPct + '% decay / day (DTE ' + dte + ')';
    }
    if (el('optHourlyDecay')) {
      var hourlyDecay = Math.abs(atmCallTheta + atmPutTheta) / 2 / 6.25;
      el('optHourlyDecay').textContent = '₹-' + hourlyDecay.toFixed(2) + ' / hr';
    }

    if (M && M.oiSummary) {
      var summary = M.oiSummary(rows, spot);
      if (summary) {
        if (el('optPcrVal')) el('optPcrVal').textContent = summary.pcr;
        if (el('optPcrBias')) {
          el('optPcrBias').textContent = summary.pcr > 1.2 ? 'Bullish Sentiment' : summary.pcr < 0.8 ? 'Bearish Sentiment' : 'Neutral Range';
        }
        if (el('optMaxPain')) el('optMaxPain').textContent = summary.maxPain ? summary.maxPain.toLocaleString('en-IN') : spot.toLocaleString('en-IN');
      }
    }

    var tbody = el('optionsChainTbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    rows.forEach(function (r) {
      var isAtm = Math.abs(r.strike - spot) < step;
      var isCallItm = r.strike < spot;
      var isPutItm = r.strike > spot;

      var tr = document.createElement('tr');
      if (isAtm) tr.className = 'atm';
      tr.innerHTML =
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + r.callOi.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + (r.callOiChange >= 0 ? '+' : '') + r.callOiChange.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + r.callVol.toLocaleString('en-IN') + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '">' + r.callIv + '%</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '" style="color:#f59e0b;font-size:11px">₹' + r.callTheta.toFixed(1) + '</td>' +
        '<td class="call-col ' + (isCallItm ? 'call-itm' : '') + '" style="font-weight:700;border-right:1px solid var(--line)">₹' + r.callPrice.toFixed(2) + '</td>' +
        '<td class="strike">' + r.strike.toLocaleString('en-IN') + (isAtm ? ' <span class="badge" style="background:#fbbf24;color:#000;font-size:9px;padding:1px 4px">ATM</span>' : '') + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '" style="font-weight:700;border-left:1px solid var(--line)">₹' + r.putPrice.toFixed(2) + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '" style="color:#f59e0b;font-size:11px">₹' + r.putTheta.toFixed(1) + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + r.putIv + '%</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + r.putVol.toLocaleString('en-IN') + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + (r.putOiChange >= 0 ? '+' : '') + r.putOiChange.toLocaleString('en-IN') + '</td>' +
        '<td class="put-col ' + (isPutItm ? 'put-itm' : '') + '">' + r.putOi.toLocaleString('en-IN') + '</td>';
      tbody.appendChild(tr);
    });
  }

  if (el('optionsRefreshBtn')) el('optionsRefreshBtn').addEventListener('click', renderOptionsChainView);
  if (el('optionsSymbol')) el('optionsSymbol').addEventListener('change', renderOptionsChainView);
  if (el('optionsExpiry')) el('optionsExpiry').addEventListener('change', renderOptionsChainView);
  if (el('optMoneynessFilter')) el('optMoneynessFilter').addEventListener('change', renderOptionsChainView);

  // ---------------------------------------------------- AI assistant ----

  function appendChatMessage(role, text) {
    var box = el('chatMessages');
    if (!box) return;
    var msg = document.createElement('div');
    msg.className = 'chat-msg ' + (role === 'user' ? 'user' : 'assistant');
    msg.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    box.appendChild(msg);
    box.scrollTop = box.scrollHeight;
  }

  function handleAiSend() {
    var input = el('chatInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    appendChatMessage('user', text);

    // AI response engine: grounded in pure mathematical models, deterministic rules, and audit logs
    setTimeout(function () {
      var query = text.toLowerCase();
      var resp = '';
      var timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST';

      if (query.indexOf('discipline') !== -1 || query.indexOf('session') !== -1 || query.indexOf('rule') !== -1 || query.indexOf('broke') !== -1) {
        if (!currentState || !currentState.session || !currentState.session.trades) {
          resp = 'Discipline Audit · ' + timeStr + ':\n' +
                 'Insufficient trade data for discipline audit (0 trades recorded today).\n' +
                 'Trade execution signals, tilt scoring, and discipline audit activate once your first trade is logged or auto-detected.';
        } else if (I && currentState && currentState.session) {
          var ia = I.analyze(currentState.log, currentState.session, currentSettings);
          resp = 'Session Discipline Audit (' + ia.score + '/100 - ' + ia.grade + ') · ' + timeStr + ':\n' +
                 '• Total Trades: ' + currentState.session.trades + '\n' +
                 '• Realised P&L: ' + R.inr(currentState.session.pnl) + '\n' +
                 '• Consecutive Losses: ' + currentState.session.consecutiveLosses + '\n' +
                 (ia.signals.length ? 'Signals:\n' + ia.signals.map(function (s) { return '  - ' + s.text; }).join('\n') : '  - Clean execution with zero tilt detected.') +
                 '\n\n🛡️ Lock Policy: Authoritative risk-lock decisions are executed exclusively by the rules engine in lib/rules.js and cannot be overridden by AI.';
        } else {
          resp = 'Discipline Audit · ' + timeStr + ':\nInsufficient trade data for discipline audit (0 trades recorded today).';
        }
      } else if (query.indexOf('option') !== -1 || query.indexOf('pcr') !== -1 || query.indexOf('oi') !== -1) {
        var isDemoRequested = query.indexOf('demo') !== -1 || query.indexOf('sample') !== -1;
        var optSymbol = (el('optionsSymbol') && el('optionsSymbol').value) || 'NIFTY';

        resp = '⚠️ LIVE MARKET DATA UNAVAILABLE\n\n' +
               '[SIMULATED DEMO DATA — NOT LIVE MARKET FEED]\n' +
               'Synthetic mathematical generators have been purged. No verified live exchange feed is currently connected (e.g. Fyers API or broker WebSocket).\n\n' +
               'To protect your capital and maintain strict discipline, Trade Lock refuses to fabricate artificial PCR, open interest walls, or max pain levels.\n\n' +
               '• Connect an authenticated broker API (Fyers API v3) to stream real contracts and Greeks.\n\n' +
               '🛡️ Risk Policy: Authoritative trading locks are executed strictly by the rules engine and cannot be altered by AI.';
      } else if (query.indexOf('support') !== -1 || query.indexOf('resistance') !== -1 || query.indexOf('structure') !== -1 || query.indexOf('pivot') !== -1) {
        resp = '⚠️ LIVE MARKET DATA UNAVAILABLE\n\n' +
               'No verified live exchange feed is currently connected.\n\n' +
               'Trade Lock refuses to invent artificial price support or resistance levels. Connect your live broker feed to compute pivot points and technical structures.\n\n' +
               '🛡️ Discipline Policy: Manual and automated discipline locks remain fully active regardless of live feed connection status.';
      } else {
        resp = 'Discipline & Risk Engine Guidance · ' + timeStr + ':\n' +
               'Keep trade count disciplined and adhere strictly to your predefined invalidation levels. ' +
               'Your active rules allow up to ' + (currentSettings.maxTradesPerDay || 'unlimited') + ' trades and max daily loss of ₹' +
               (currentSettings.maxDailyLoss || 'unlimited') + '. Never average down losing positions.\n\n' +
               '🛡️ Notice: The Trade Lock risk engine operates deterministically. AI chat is strictly informational.';
      }

      appendChatMessage('assistant', resp);
    }, 350);
  }

  if (el('chatSendBtn')) el('chatSendBtn').addEventListener('click', handleAiSend);
  if (el('chatInput')) el('chatInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') handleAiSend();
  });

  document.querySelectorAll('.prompt-chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      var promptText = chip.getAttribute('data-prompt');
      if (el('chatInput')) el('chatInput').value = promptText;
      handleAiSend();
    });
  });

  // ---------------------------------------------------- trade journal ----

  var selectedMonthKey = null;
  var allDaysCollapsed = false;

  function monthLabel(mKey) {
    if (!mKey || !/^\d{4}-\d{2}$/.test(mKey)) return mKey || '';
    var parts = mKey.split('-');
    var yr = parts[0];
    var mIdx = parseInt(parts[1], 10) - 1;
    var months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
    return (months[mIdx] || parts[1]) + ' ' + yr;
  }

  function renderMonthlyJournal() {
    var journal = (currentState && currentState.journal) || { version: 2, months: {} };
    if (!journal.months) journal.months = {};

    // Collect available months
    var monthKeys = Object.keys(journal.months);
    var curMonthKey = R.istMonthKey(Date.now());
    if (monthKeys.indexOf(curMonthKey) === -1) {
      monthKeys.push(curMonthKey);
    }
    monthKeys.sort().reverse(); // newest first

    if (!selectedMonthKey || monthKeys.indexOf(selectedMonthKey) === -1) {
      selectedMonthKey = monthKeys[0] || curMonthKey;
    }

    // Populate Month Selector dropdown
    var monthSel = el('jMonthSelector');
    if (monthSel) {
      monthSel.innerHTML = '';
      monthKeys.forEach(function (mk) {
        var opt = document.createElement('option');
        opt.value = mk;
        opt.textContent = monthLabel(mk);
        if (mk === selectedMonthKey) opt.selected = true;
        monthSel.appendChild(opt);
      });
    }

    // Monthly summary stats and active days
    var monthData = journal.months[selectedMonthKey] || { month: selectedMonthKey, days: {}, summary: null };
    var daysObj = Object.assign({}, monthData.days || {});
    var todayKey = (currentState && currentState.session && currentState.session.date) || R.todayIST();
    if (selectedMonthKey === curMonthKey && currentState && Array.isArray(currentState.log) && currentState.log.length > 0) {
      daysObj[todayKey] = {
        date: todayKey,
        trades: currentState.log.slice(),
        summary: R.calculateDaySummary(currentState.log)
      };
    }
    var mSummary = R.calculateMonthSummary(daysObj);

    if (el('jTotalTrades')) el('jTotalTrades').textContent = mSummary.totalTrades;
    if (el('jWinRate')) el('jWinRate').textContent = mSummary.winRate + '% (' + mSummary.wins + 'W · ' + mSummary.losses + 'L)';
    if (el('jNetPnl')) {
      el('jNetPnl').textContent = (mSummary.netPnl >= 0 ? '+' : '') + R.inr(mSummary.netPnl);
      el('jNetPnl').className = 'stat-val ' + (mSummary.netPnl > 0 ? 'pos' : (mSummary.netPnl < 0 ? 'neg' : ''));
    }
    if (el('jBestDay')) {
      el('jBestDay').textContent = mSummary.bestDay
        ? mSummary.bestDay.date + ' (+' + R.inr(mSummary.bestDay.netPnl) + ')'
        : '—';
    }
    if (el('jWorstDay')) {
      el('jWorstDay').textContent = mSummary.worstDay
        ? mSummary.worstDay.date + ' (' + R.inr(mSummary.worstDay.netPnl) + ')'
        : '—';
    }

    // Render Daily Cards
    var container = el('jDaysContainer');
    if (!container) return;
    container.innerHTML = '';

    var dayKeys = Object.keys(daysObj).sort().reverse();

    var outcomeFilter = el('jFilterOutcome') ? el('jFilterOutcome').value : 'ALL';
    var sideFilter = el('jFilterSide') ? el('jFilterSide').value : 'ALL';
    var provFilter = el('jFilterProv') ? el('jFilterProv').value : 'ALL';
    var search = el('jSearch') ? el('jSearch').value.toLowerCase().trim() : '';

    var renderedDaysCount = 0;

    dayKeys.forEach(function (dStr) {
      var day = daysObj[dStr];
      var rawTrades = (day && day.trades) || [];

      // Filter trades
      var filteredTrades = rawTrades.filter(function (t) {
        var net = (t.netPnl !== undefined && t.netPnl !== null) ? t.netPnl : t.pnl;
        if (outcomeFilter === 'WIN' && net <= 0) return false;
        if (outcomeFilter === 'LOSS' && net >= 0) return false;
        if (outcomeFilter === 'BE' && net !== 0) return false;

        if (sideFilter === 'BUY' && t.side !== 'BUY') return false;
        if (sideFilter === 'SELL' && t.side !== 'SELL') return false;

        var prov = t.provenance || 'manual';
        if (provFilter === 'broker' && prov.indexOf('broker') === -1) return false;
        if (provFilter === 'manual' && prov.indexOf('broker') !== -1) return false;

        if (search) {
          var str = ((t.symbol || '') + ' ' + (t.setup || '') + ' ' + (t.notes || '') + ' ' + dStr).toLowerCase();
          if (str.indexOf(search) === -1) return false;
        }
        return true;
      });

      if (search && !filteredTrades.length) return; // Skip days with no matching trades when searching

      renderedDaysCount++;
      var dSummary = R.calculateDaySummary(rawTrades);

      var card = document.createElement('div');
      card.className = 'day-card' + (allDaysCollapsed ? ' collapsed' : '');

      var pnlClass = dSummary.netPnl > 0 ? 'color:#10b981' : (dSummary.netPnl < 0 ? 'color:#ef4444' : 'color:var(--dim)');
      var pnlSign = dSummary.netPnl > 0 ? '+' : '';

      // Day card header
      var headerHtml =
        '<div class="day-card-header">' +
          '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
            '<span style="font-weight:750;font-size:13px;color:var(--text)">📅 ' + escapeHtml(dStr) + '</span>' +
            '<span class="badge" style="font-weight:700;' + pnlClass + '">' + pnlSign + R.inr(dSummary.netPnl) + ' Net</span>' +
            '<span class="badge">' + rawTrades.length + ' trade' + (rawTrades.length === 1 ? '' : 's') + '</span>' +
            '<span class="badge" style="color:#6ee7b7">' + dSummary.wins + 'W</span>' +
            '<span class="badge" style="color:#fca5a5">' + dSummary.losses + 'L</span>' +
            (dSummary.charges ? '<span class="badge" style="color:var(--dim)">Charges: ₹' + dSummary.charges + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="chevron" style="color:var(--dim);font-size:13px">▼</span>' +
          '</div>' +
        '</div>';

      // Day card body (trades table)
      var bodyHtml = '<div class="day-card-body">';
      if (!filteredTrades.length) {
        bodyHtml += '<div style="text-align:center;color:var(--dim);padding:14px;font-size:12px">No trades on this day match current filters.</div>';
      } else {
        bodyHtml +=
          '<div style="overflow-x:auto">' +
            '<table class="limits" style="margin:0;font-size:11.5px">' +
              '<thead>' +
                '<tr style="border-bottom:1px solid var(--line-strong);color:var(--dim)">' +
                  '<th>Time (IST)</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th>' +
                  '<th>Gross P&amp;L</th><th>Charges</th><th>Net P&amp;L</th><th>Setup</th><th>Notes</th><th>Source</th><th></th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>';

        filteredTrades.forEach(function (t) {
          var tTime = t.at ? new Date(t.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—';
          var net = (t.netPnl !== undefined && t.netPnl !== null) ? t.netPnl : t.pnl;
          var tPnlCls = net > 0 ? 'pos' : (net < 0 ? 'neg' : '');
          var isBroker = (t.provenance || '').indexOf('broker') !== -1;
          var provBadge = isBroker
            ? '<span class="badge pro" style="font-size:10px;padding:2px 5px">Broker table</span>'
            : '<span class="badge" style="font-size:10px;padding:2px 5px;background:rgba(255,255,255,0.06);color:var(--dim)">Manual</span>';

          bodyHtml +=
            '<tr>' +
              '<td style="white-space:nowrap;color:var(--dim)">' + tTime + '</td>' +
              '<td style="font-weight:700">' + escapeHtml(t.symbol || 'MANUAL') + '</td>' +
              '<td><span class="badge ' + (t.side === 'BUY' ? 'pro' : 'danger') + '" style="font-size:10px;padding:2px 6px">' + escapeHtml(t.side || 'BUY') + '</span></td>' +
              '<td>' + (t.qty || 1) + '</td>' +
              '<td>₹' + (t.entry || 0) + '</td>' +
              '<td>₹' + (t.exit || 0) + '</td>' +
              '<td style="color:var(--muted)">₹' + (t.pnl || 0).toLocaleString('en-IN') + '</td>' +
              '<td style="color:var(--dim)">₹' + (t.charges || 0) + '</td>' +
              '<td class="' + tPnlCls + '" style="font-weight:750">₹' + (net || 0).toLocaleString('en-IN') + '</td>' +
              '<td style="color:var(--text)">' + escapeHtml(t.setup || '—') + '</td>' +
              '<td style="color:var(--muted);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtml(t.notes || '') + '">' + escapeHtml(t.notes || '—') + '</td>' +
              '<td>' + provBadge + '</td>' +
              '<td><button type="button" class="danger delete-trade-btn" aria-label="Delete ' + escapeHtml(t.symbol || 'manual trade') + ' trade on ' + dStr + '" title="Delete trade" data-month="' + selectedMonthKey + '" data-date="' + dStr + '" data-id="' + escapeHtml(t.id) + '" style="padding:2px 6px;font-size:10px">×</button></td>' +
            '</tr>';
        });

        bodyHtml += '</tbody></table></div>';
      }
      bodyHtml += '</div>';

      card.innerHTML = headerHtml + bodyHtml;

      // Header click toggles collapsed state
      card.querySelector('.day-card-header').addEventListener('click', function () {
        card.classList.toggle('collapsed');
      });

      container.appendChild(card);
    });

    if (renderedDaysCount === 0) {
      var isCur = selectedMonthKey === curMonthKey;
      container.innerHTML =
        '<div style="text-align:center;color:var(--dim);padding:40px 20px;border:1px dashed var(--line-strong);border-radius:14px;background:rgba(0,0,0,0.25);margin-top:14px">' +
          '<div style="font-size:32px;margin-bottom:8px">📓</div>' +
          '<div style="font-size:15px;font-weight:700;margin-bottom:6px;color:var(--text)">No trade records found for ' + monthLabel(selectedMonthKey) + '</div>' +
          '<div style="font-size:12.5px;color:var(--muted);max-width:440px;margin:0 auto 16px;line-height:1.5">' +
            (isCur
              ? 'Trades executed in supported broker terminals (Zerodha, Upstox, Angel One, Dhan, etc.) are monitored automatically, or you can log manual trades below.'
              : 'No historical trades were recorded for this month.') +
          '</div>' +
          '<button type="button" id="jEmptyAddTradeBtn" class="primary" style="padding:7px 18px;font-size:12.5px">+ Add Trade Entry</button>' +
        '</div>';
      var emptyAddBtn = el('jEmptyAddTradeBtn');
      if (emptyAddBtn) {
        emptyAddBtn.addEventListener('click', function () {
          var form = el('jManualForm');
          if (form) form.style.display = 'block';
          if (el('jSymbol')) el('jSymbol').focus();
        });
      }
    }

    // Wire individual trade delete buttons
    container.querySelectorAll('.delete-trade-btn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var tId = btn.getAttribute('data-id');
        var dStr = btn.getAttribute('data-date');
        var mKey = btn.getAttribute('data-month');
        if (!confirm('Delete this trade record?')) return;

        chrome.storage.local.get(['tlState', 'tlJournal'], function (res) {
          var state = res.tlState;
          if (!state) return;
          state.log = (state.log || []).filter(function (x) { return String(x.id) !== String(tId); });
          if (R.rebuildSessionFromLog) R.rebuildSessionFromLog(state);
          if (state && state.journal && state.journal.months && state.journal.months[mKey]) {
            var dayRec = state.journal.months[mKey].days[dStr];
            if (dayRec && Array.isArray(dayRec.trades)) {
              dayRec.trades = dayRec.trades.filter(function (x) { return String(x.id) !== String(tId); });
              state.journal.months[mKey].summary = R.calculateMonthSummary(state.journal.months[mKey].days);
            }
          }
          if (state.journal && state.journal.months) {
            R.archiveDayToJournal(state.journal, state.session.date, state.log, state.session);
            Object.keys(state.journal.months).forEach(function (month) {
              var days = state.journal.months[month].days || {};
              Object.keys(days).forEach(function (day) {
                if (!(days[day].trades || []).length) delete days[day];
              });
              state.journal.months[month].summary = R.calculateMonthSummary(days);
              if (!Object.keys(days).length) delete state.journal.months[month];
            });
          }
          var flatJ = Array.isArray(res.tlJournal) ? res.tlJournal.filter(function (x) { return String(x.id) !== String(tId); }) : [];
          chrome.storage.local.set({ tlState: state, tlJournal: flatJ, tlSavedAt: Date.now() }, function () {
            currentState = state;
            renderMonthlyJournal();
            renderToday(currentState, currentSettings);
            renderOverviewJournalSummary(currentState, flatJ);
            toast('Trade deleted');
          });
        });
      });
    });
  }

  // Month selector change
  if (el('jMonthSelector')) {
    el('jMonthSelector').addEventListener('change', function () {
      selectedMonthKey = el('jMonthSelector').value;
      renderMonthlyJournal();
    });
  }

  // Toggle Collapse / Expand All Days
  if (el('jToggleDays')) {
    el('jToggleDays').addEventListener('click', function () {
      allDaysCollapsed = !allDaysCollapsed;
      el('jToggleDays').textContent = allDaysCollapsed ? 'Expand All Days' : 'Collapse All Days';
      document.querySelectorAll('#jDaysContainer .day-card').forEach(function (card) {
        if (allDaysCollapsed) card.classList.add('collapsed');
        else card.classList.remove('collapsed');
      });
    });
  }

  // Filter & Search listeners
  if (el('jSearch')) el('jSearch').addEventListener('input', renderMonthlyJournal);
  if (el('jFilterOutcome')) el('jFilterOutcome').addEventListener('change', renderMonthlyJournal);
  if (el('jFilterSide')) el('jFilterSide').addEventListener('change', renderMonthlyJournal);
  if (el('jFilterProv')) el('jFilterProv').addEventListener('change', renderMonthlyJournal);

  // Add Trade Drawer Toggle
  if (el('jOpenAddForm')) {
    el('jOpenAddForm').addEventListener('click', function () {
      if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'block';
    });
  }
  if (el('jCancelAddBtn')) {
    el('jCancelAddBtn').addEventListener('click', function () {
      if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'none';
    });
  }

  // Add Manual Trade Record
  if (el('jAddBtn')) {
    el('jAddBtn').addEventListener('click', function () {
      var sym = (el('jSymbol').value || '').trim().toUpperCase();
      var side = el('jSide').value;
      var entry = parseFloat(el('jEntry').value) || 0;
      var exit = parseFloat(el('jExit').value) || 0;
      var qty = parseFloat(el('jQty').value) || 1;
      var charges = parseFloat(el('jCharges').value) || 0;
      var plannedRisk = Math.max(0, parseFloat(el('jPlannedRisk').value) || 0);
      var setup = el('jSetup').value;
      var notes = (el('jNotes').value || '').trim();

      if (!entry || !exit) {
        alert('Please specify both Entry Price and Exit Price.');
        return;
      }

      var grossPnl = round((exit - entry) * qty * (side === 'BUY' ? 1 : -1));
      var netPnl = round(grossPnl - charges);

      var tradeRecord = {
        id: 'tl_tr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        at: Date.now(),
        symbol: sym || 'INDEX',
        side: side,
        entry: entry,
        exit: exit,
        qty: qty,
        pnl: grossPnl,
        charges: charges,
        netPnl: netPnl,
        risk: plannedRisk,
        plannedRisk: plannedRisk,
        setup: setup,
        notes: notes,
        provenance: 'manual'
      };

      chrome.storage.local.get(['tlState', 'tlSettings', 'tlLicense', 'tlJournal'], function (res) {
        var settings = R.effectiveSettings(res.tlSettings, res.tlLicense, Date.now());
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());

        R.logTrade(state, settings, {
          id: tradeRecord.id,
          symbol: tradeRecord.symbol,
          side: tradeRecord.side,
          entry: tradeRecord.entry,
          exit: tradeRecord.exit,
          qty: tradeRecord.qty,
          pnl: grossPnl,
          charges: charges,
          netPnl: netPnl,
          risk: plannedRisk,
          plannedRisk: plannedRisk,
          setup: setup,
          notes: notes,
          provenance: 'manual',
          source: 'manual'
        }, Date.now());

        var flatJournal = Array.isArray(res.tlJournal) ? res.tlJournal : [];
        flatJournal.unshift(tradeRecord);

        var t = R.tick(state, settings, Date.now());
        chrome.storage.local.set({ tlState: t.state, tlJournal: flatJournal, tlSavedAt: Date.now() }, function () {
          chrome.runtime.sendMessage({ type: 'TL_REFRESH' });

          // Reset inputs and close drawer
          el('jSymbol').value = '';
          el('jEntry').value = '';
          el('jExit').value = '';
          el('jCharges').value = '';
          el('jPlannedRisk').value = '';
          el('jNotes').value = '';
          if (el('jAddFormDrawer')) el('jAddFormDrawer').style.display = 'none';

          loadAll();
          toast('Trade logged to journal');
        });
      });
    });
  }

  // Export Scope Selection
  if (el('jExportScope')) {
    el('jExportScope').addEventListener('change', function () {
      var scope = el('jExportScope').value;
      var box = el('jCustomRangeFields') || el('jCustomRangeBox');
      if (box) box.style.display = scope === 'custom' ? 'flex' : 'none';
    });
  }

  // Export CSV (Formula-Safe)
  if (el('jExportCsv')) {
    el('jExportCsv').addEventListener('click', function () {
      var journal = (currentState && currentState.journal) || { version: 2, months: {} };
      var scope = el('jExportScope') ? el('jExportScope').value : 'month';
      var res = R.exportJournalData(journal, {
        scope: scope,
        month: selectedMonthKey,
        date: R.todayIST(),
        startDate: el('jExportStart') ? el('jExportStart').value : null,
        endDate: el('jExportEnd') ? el('jExportEnd').value : null,
        format: 'csv'
      });

      downloadFile(res.text, res.filename, 'text/csv');
      var conf = el('jExportConfirmation');
      if (conf) {
        conf.style.display = 'block';
        conf.innerHTML = '✓ Exported <b>' + res.recordCount + '</b> trade records to CSV (' + escapeHtml(res.filename) + '). All formula characters sanitized.';
        setTimeout(function () { if (conf) conf.style.display = 'none'; }, 6000);
      }
    });
  }

  // Export JSON
  if (el('jExportJson')) {
    el('jExportJson').addEventListener('click', function () {
      var journal = (currentState && currentState.journal) || { version: 2, months: {} };
      var scope = el('jExportScope') ? el('jExportScope').value : 'month';
      var res = R.exportJournalData(journal, {
        scope: scope,
        month: selectedMonthKey,
        date: R.todayIST(),
        startDate: el('jExportStart') ? el('jExportStart').value : null,
        endDate: el('jExportEnd') ? el('jExportEnd').value : null,
        format: 'json'
      });

      downloadFile(res.text, res.filename, 'application/json');
      var conf = el('jExportConfirmation');
      if (conf) {
        conf.style.display = 'block';
        conf.innerHTML = '✓ Exported <b>' + res.recordCount + '</b> trade records to JSON (' + escapeHtml(res.filename) + ').';
        setTimeout(function () { if (conf) conf.style.display = 'none'; }, 6000);
      }
    });
  }

  // Print Monthly / Daily Report
  if (el('jPrintReport')) {
    el('jPrintReport').addEventListener('click', function () {
      window.print();
    });
  }

  function downloadFile(content, filename, type) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ----------------------------------------------------------- actions ----

  if (el('save')) el('save').addEventListener('click', save);
  if (el('headerSaveBtn')) el('headerSaveBtn').addEventListener('click', save);

  NUM.concat(BOOL).forEach(function (k) {
    if (el(k)) {
      el(k).addEventListener('input', markDirty);
      el(k).addEventListener('change', markDirty);
    }
  });
  ['marketOpen', 'holidays', 'blockedHosts'].forEach(function (k) {
    if (el(k)) el(k).addEventListener('input', function () {
      markDirty();
      if (k === 'holidays') renderCalendarStatus(read());
    });
  });
  ['totalCapital', 'dailyRiskPercent', 'perTradeRiskPercent', 'planTradesMirror'].forEach(function (k) {
    if (el(k)) el(k).addEventListener('input', function () { markDirty(); updatePlanSummary(); });
  });

  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });



  if (el('lockNow')) {
    el('lockNow').addEventListener('click', function () {
      var settings = read();
      chrome.storage.local.get('tlState', function (res) {
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
        if (state.lock && state.lock.active && !state.lock.manual) {
          alert('A rule-triggered discipline lock is active and cannot be converted to a manual focus lock.');
          return;
        }
        if (!confirm('Lock the trading screen until the next market open?')) return;
        R.lockNow(state, settings, Date.now());
        chrome.storage.local.set({ tlState: state, tlSavedAt: Date.now() }, function () {
          chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
          chrome.tabs.query({}, function (tabs) {
            tabs.forEach(function (t) {
              try {
                chrome.tabs.sendMessage(t.id, { type: 'TL_LOCK_NOW' }, function () { void chrome.runtime.lastError; });
              } catch (e) {}
            });
          });
          renderToday(state, settings);
          toast('Locked');
        });
      });
    });
  }

  if (el('testLock')) {
    el('testLock').addEventListener('click', function () {
      var settings = read();
      chrome.storage.local.get('tlState', function (res) {
        var state = res.tlState ? R.syncSession(res.tlState, settings, Date.now()) : R.defaultState(Date.now());
        if (state.lock && state.lock.active && state.lock.reason !== 'preview') {
          alert('Cannot preview lock while an authoritative active trading lock is in effect.');
          return;
        }
        state.lock = {
          active: true, reason: 'preview', since: Date.now(),
          until: Date.now() + 10000, manual: false
        };
        chrome.storage.local.set({ tlState: state }, function () {
          chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
          loadAll();
          setTimeout(function () {
            chrome.storage.local.get('tlState', function (r2) {
              var st = r2.tlState || state;
              if (st.lock && st.lock.reason === 'preview') {
                var v = R.evaluate(st, settings);
                if (v) {
                  st.lock.reason = v.rule;
                  st.lock.until = R.nextMarketOpen(Date.now(), settings);
                } else {
                  st.lock = { active: false, reason: null, since: null, until: null, manual: false };
                }
                chrome.storage.local.set({ tlState: st }, function () {
                  chrome.runtime.sendMessage({ type: 'TL_REFRESH' });
                });
              }
              loadAll();
            });
          }, 10000);
          toast('Preview for 10s');
        });
      });
    });
  }

  if (el('exportBtn')) {
    el('exportBtn').addEventListener('click', function () {
      chrome.storage.local.get(['tlSettings'], function (res) {
        downloadFile(JSON.stringify(res.tlSettings || {}, null, 2), 'trade-lock-rules.json', 'application/json');
      });
    });
  }

  if (el('importBtn')) el('importBtn').addEventListener('click', function () { el('importFile').click(); });
  if (el('importFile')) {
    el('importFile').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var parsed = JSON.parse(String(fr.result));
          var merged = Object.assign({}, R.DEFAULT_SETTINGS, parsed);
          fill(merged);
          markDirty();
          toast('Loaded — press Save');
        } catch (err) {
          alert('That file is not valid Trade Lock JSON.');
        }
      };
      fr.readAsText(f);
    });
  }

  if (el('exportLogBtn')) el('exportLogBtn').addEventListener('click', function () {
    var rows = (currentState && currentState.log) || [];
    if (!rows.length) { alert('No trades logged today yet.'); return; }
    var csv = 'time,symbol,side,qty,pnl,risk,source\n' + rows.map(function (e) {
      return [new Date(e.at).toISOString(), e.symbol || '', e.side || '', e.qty || 0, e.pnl || 0, e.risk || 0, e.source || ''].map(csvCell).join(',');
    }).join('\n');
    downloadFile(csv, 'trade-lock-log-' + ((currentState.session && currentState.session.date) || 'today') + '.csv', 'text/csv');
  });

  if (el('reportBtn')) el('reportBtn').addEventListener('click', function () {
    var plan = planState(currentSettings, currentLicense);
    if (plan.free) { alert('AI Coach reports are a Pro feature.'); return; }
    var text = globalThis.TLInsights.dailyReport(
      currentState && currentState.log, currentState && currentState.session, currentSettings);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Report copied'); });
    } else {
      prompt('Copy your day report:', text);
    }
  });

  if (el('enforcementMode')) {
    el('enforcementMode').addEventListener('change', function () {
      toggleFullSiteAckBox(el('enforcementMode').value);
      markDirty();
    });
  }

  if (el('topSettingsBtn')) {
    el('topSettingsBtn').addEventListener('click', function () {
      switchTab('rules');
    });
  }

  if (el('topSymbolSearch')) {
    el('topSymbolSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var query = (e.target.value || '').trim().toUpperCase();
        if (query.includes('BANK')) {
          chartState.symbol = 'BANKNIFTY';
        } else if (query.includes('FIN')) {
          chartState.symbol = 'FINNIFTY';
        } else if (query) {
          chartState.symbol = 'NIFTY';
        }
        renderOverviewChart();
        if (el('tab-market') && el('tab-market').classList.contains('active')) {
          renderMarketAndOiDashboard();
        }
      }
    });
  }

  if (el('ovLossLimitEditBtn')) {
    el('ovLossLimitEditBtn').addEventListener('click', function () {
      switchTab('rules');
      if (el('maxDailyLoss')) el('maxDailyLoss').focus();
    });
  }

  // Checklist item toggle handling with chrome.storage persistence
  var checklist = el('homeFocusChecklist');
  if (checklist && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['tlChecklistState'], function (res) {
      var saved = res && res.tlChecklistState;
      if (saved && Array.isArray(saved)) {
        var inputs = checklist.querySelectorAll('input[type="checkbox"]');
        inputs.forEach(function (inp, idx) {
          if (saved[idx] !== undefined) {
            inp.checked = !!saved[idx];
            var li = inp.closest('.checklist-item');
            if (li) {
              if (inp.checked) li.classList.add('checked');
              else li.classList.remove('checked');
            }
          }
        });
      }
    });

    checklist.addEventListener('change', function (e) {
      if (e.target && e.target.type === 'checkbox') {
        var li = e.target.closest('.checklist-item');
        if (li) {
          if (e.target.checked) li.classList.add('checked');
          else li.classList.remove('checked');
        }
        var inputs = checklist.querySelectorAll('input[type="checkbox"]');
        var state = Array.from(inputs).map(function (inp) { return inp.checked; });
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ tlChecklistState: state });
        }
      }
    });
  }

  // ------------------------------------------------------------- init ----

  initTabs();
  loadAll();
  renderMarketAndOiDashboard();
  renderOptionsChainView();
  setInterval(loadAll, 3000);
})();
